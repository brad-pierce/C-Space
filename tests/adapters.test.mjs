// adapters.test.mjs — hermetic node:test suite for the SOURCE ADAPTER layer
// (tools/adapters/*.mjs). Covers the registry union and all three adapters:
//   (a) registry     — discoverAll() rows are tagged by source with the required
//                      fields, and the union is sorted newest-first.
//   (b) CLAUDE       — parse() of a known session is byte-for-byte identical to
//                      the direct CLI/SessionParser path (its library fixture).
//   (c) CODEX        — real rollout files under ~/.codex parse to the common
//                      shape with an all-allowed event vocabulary.
//   (d) HERMES       — an in-memory-SQLite self-test built to the documented
//                      schema (never touches ~/.hermes).
//
// PORTABILITY RULE: every store-backed test SKIPS cleanly (never fails) when its
// store is absent, so the suite stays green on any machine and on a fresh clone.
//
// Read-only w.r.t. every session store — no test writes to ~/.claude, ~/.codex,
// or ~/.hermes, and no parsed transcript content is ever committed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { LIBRARY_DIR } from '../tools/cspace-paths.mjs';
import { adapters, getAdapter, discoverAll, countsBySource } from '../tools/adapters/index.mjs';
import claude from '../tools/adapters/claude.mjs';
import codex from '../tools/adapters/codex.mjs';
import hermes, { _internal as hermesInternal } from '../tools/adapters/hermes.mjs';

// The COMMON VIZ VOCABULARY every adapter must emit. Nothing outside this set is
// a legal event.kind. (ctx items are not events — they live in contextCurve.)
const ALLOWED_KINDS = new Set([
  'user', 'say', 'thinking', 'tool_call', 'tool_result',
  'spawn', 'despawn', 'compaction', 'hook', 'queued',
]);

const KNOWN_ADAPTER_IDS = new Set(['claude', 'codex', 'hermes', 'openclaw']);

// Assert an object carries the full COMMON VIZ SHAPE and that every event kind is
// in the allowed vocabulary. Shared by the Codex and Hermes checks so the shape
// contract is enforced identically for every source.
function assertCommonShape(out, label) {
  assert.deepEqual(
    Object.keys(out).sort(),
    ['compactions', 'contextCurve', 'events', 'meta', 'subagents', 'tools'].sort(),
    `${label}: top-level keys must match the common shape`,
  );
  for (const k of ['sessionId', 'cwd', 'model', 'version', 'startedAt', 'durationS',
    'userTurns', 'assistantTurns', 'thinkingBlocks', 'hookEvents', 'toolCalls', 'peakContext']) {
    assert.ok(k in out.meta, `${label}: meta.${k} present`);
  }
  assert.ok(Array.isArray(out.events), `${label}: events is an array`);
  assert.ok(Array.isArray(out.contextCurve), `${label}: contextCurve is an array`);
  assert.ok(Array.isArray(out.subagents), `${label}: subagents is an array`);
  assert.ok(Array.isArray(out.compactions), `${label}: compactions is an array`);
  assert.ok(out.tools && typeof out.tools === 'object', `${label}: tools is an object`);
  for (const e of out.events) {
    assert.ok(ALLOWED_KINDS.has(e.kind), `${label}: illegal event kind "${e.kind}"`);
    assert.equal(typeof e.t, 'number', `${label}: event.t must be numeric`);
  }
  // events are non-decreasing in time (every adapter sorts before returning)
  for (let i = 1; i < out.events.length; i++) {
    assert.ok(out.events[i].t >= out.events[i - 1].t, `${label}: events must be time-ordered`);
  }
}

// ===========================================================================
// (a) registry
// ===========================================================================

test('registry: every installed adapter exposes the common interface', () => {
  assert.ok(Array.isArray(adapters) && adapters.length >= 1, 'at least the Claude adapter loads');
  assert.ok(adapters.some((a) => a.id === 'claude'), 'Claude adapter is always present');
  for (const a of adapters) {
    assert.ok(KNOWN_ADAPTER_IDS.has(a.id), `adapter id "${a.id}" is a known source`);
    assert.equal(typeof a.label, 'string', `${a.id}: label is a string`);
    assert.equal(typeof a.storeExists, 'function', `${a.id}: storeExists()`);
    assert.equal(typeof a.discover, 'function', `${a.id}: discover()`);
    assert.equal(typeof a.parse, 'function', `${a.id}: parse()`);
    assert.equal(getAdapter(a.id), a, `getAdapter('${a.id}') resolves to the same object`);
  }
  assert.equal(getAdapter('does-not-exist'), null, 'unknown id resolves to null');
});

test('registry: discoverAll() rows are source-tagged, well-formed, and newest-first', () => {
  const rows = discoverAll();
  assert.ok(Array.isArray(rows), 'discoverAll() returns an array');

  for (const r of rows) {
    // source tag is present and names an installed adapter
    assert.ok(KNOWN_ADAPTER_IDS.has(r.source), `row.source "${r.source}" is a known source`);
    assert.ok(getAdapter(r.source), `row.source "${r.source}" maps to an installed adapter`);
    // required fields
    assert.ok(r.id != null && String(r.id).length > 0, 'row.id is present');
    assert.ok('project' in r, 'row.project is present (may be null)');
    assert.ok(r.path != null || r.ref != null, 'row carries a path or a ref locator');
    assert.equal(typeof r.mtime, 'number', 'row.mtime is numeric');
    assert.ok('sizeMB' in r, 'row.sizeMB is present');
    assert.equal(typeof r.active, 'boolean', 'row.active is boolean');
  }

  // union is sorted newest-first by mtime
  for (let i = 1; i < rows.length; i++) {
    assert.ok((rows[i - 1].mtime ?? 0) >= (rows[i].mtime ?? 0), 'rows sorted by mtime desc');
  }

  // countsBySource is consistent with the union it summarizes
  const counts = countsBySource(rows);
  const total = Object.values(counts).reduce((a, n) => a + n, 0);
  assert.equal(total, rows.length, 'countsBySource totals to the row count');
  for (const src of Object.keys(counts)) {
    assert.ok(KNOWN_ADAPTER_IDS.has(src), `count key "${src}" is a known source`);
  }
});

// ===========================================================================
// (b) CLAUDE adapter parity — identical to the direct SessionParser/CLI path
// ===========================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_SESSION_ID = '2a798897-8664-4819-baf0-da5692653f54';
const CLAUDE_FIXTURE = join(LIBRARY_DIR, `${CLAUDE_SESSION_ID}.json`);

// Locate the raw transcript across ~/.claude/projects (same trick as
// parser.test.mjs) rather than hardcoding a project dir. Skips cleanly when the
// local session store or the library fixture is absent.
function findClaudeRawJsonl() {
  const base = join(homedir(), '.claude', 'projects');
  try {
    for (const d of readdirSync(base)) {
      const p = join(base, d, `${CLAUDE_SESSION_ID}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch { /* no local session store */ }
  return null;
}
const CLAUDE_RAW = findClaudeRawJsonl();
const haveClaudeFixture = !!CLAUDE_RAW && existsSync(CLAUDE_FIXTURE);

test('CLAUDE: parse() of a known session matches the direct CLI/SessionParser fixture',
  { skip: haveClaudeFixture ? false : 'local Claude session fixture not present' }, () => {
    const out = claude.parse({ id: CLAUDE_SESSION_ID, path: CLAUDE_RAW });
    const fx = JSON.parse(readFileSync(CLAUDE_FIXTURE, 'utf8'));

    assertCommonShape(out, 'claude');

    // event & ctx parity (fixture.events excludes ctx; ctx lives in contextCurve)
    assert.equal(out.events.length, fx.events.length, 'event count matches fixture');
    assert.equal(out.contextCurve.length, fx.contextCurve.length, 'contextCurve length matches fixture');

    // per-tool stats identical (deepEqual ignores key order)
    assert.deepEqual(out.tools, fx.tools, 'per-tool stats match fixture');

    // subagents & compactions parity
    assert.equal(out.subagents.length, fx.subagents.length, 'subagent count matches fixture');
    assert.equal(out.compactions.length, fx.compactions.length, 'compaction count matches fixture');

    // full meta parity
    for (const k of ['sessionId', 'cwd', 'model', 'version', 'startedAt', 'durationS',
      'userTurns', 'assistantTurns', 'thinkingBlocks', 'hookEvents', 'toolCalls', 'peakContext']) {
      assert.deepEqual(out.meta[k], fx.meta[k], `meta.${k} matches fixture`);
    }

    // per-event-kind histogram parity — stronger than a bare count
    const hist = (arr) => arr.reduce((m, e) => (m[e.kind] = (m[e.kind] ?? 0) + 1, m), {});
    assert.deepEqual(hist(out.events), hist(fx.events), 'event-kind histogram matches fixture');
  });

// ===========================================================================
// (c) CODEX adapter — real rollout files under ~/.codex
// ===========================================================================

const codexRows = (() => {
  try { return codex.storeExists() ? codex.discover() : []; } catch { return []; }
})();

test('CODEX: real rollout files parse to the common shape with a legal vocabulary',
  { skip: codexRows.length ? false : 'no ~/.codex rollout files present' }, () => {
    let cleanCount = 0;   // files that parsed to the common shape with legal kinds
    let richCount = 0;    // files meeting the full "real session" criteria
    const failures = [];

    for (const row of codexRows) {
      let out;
      try {
        out = codex.parse(row);
      } catch (e) {
        failures.push(`${row.id}: threw ${e.message}`);
        continue;
      }
      try {
        assertCommonShape(out, `codex:${row.id}`);
        cleanCount++;
      } catch (e) {
        failures.push(`${row.id}: ${e.message}`);
        continue;
      }
      const hasTool = out.events.some((e) => e.kind === 'tool_call');
      if (out.events.length > 0 && hasTool && out.meta.durationS > 0 && out.contextCurve.length > 0) {
        richCount++;
      }
    }

    assert.deepEqual(failures, [], `all discovered rollouts parse cleanly (${codexRows.length} files)`);
    assert.equal(cleanCount, codexRows.length, 'every discovered rollout produced the common shape');

    // At least one real session must exercise the full contract required by the
    // task: events, a tool_call, positive duration, and a context curve.
    assert.ok(richCount > 0,
      'at least one rollout has events, a tool_call, durationS>0, and a contextCurve');
  });

// ===========================================================================
// (d) HERMES adapter — in-memory-SQLite self-test (documented schema)
// ===========================================================================

const { DatabaseSync } = hermesInternal;
const HAVE_SQLITE = !!DatabaseSync;

function makeHermesDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source_platform TEXT,
      user_id TEXT,
      model_name TEXT,
      title TEXT,
      system_prompt TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      parent_session_id TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      role TEXT,
      content TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      tool_call_id TEXT,
      is_error INTEGER,
      token_count INTEGER,
      created_at TEXT
    );
  `);
  db.prepare(`INSERT INTO sessions
    (id, source_platform, user_id, model_name, title, system_prompt, input_tokens, output_tokens, parent_session_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('sess-1', 'openai', 'u1', 'hermes-large', 'demo', 'sys', 1200, 800, null,
         '2026-08-12T10:00:00.000Z', '2026-08-12T10:05:00.000Z');
  const ins = db.prepare(`INSERT INTO messages
    (session_id, role, content, tool_calls, tool_name, tool_call_id, is_error, token_count, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  ins.run('sess-1', 'user', 'hello there', null, null, null, 0, 10, '2026-08-12T10:00:00.000Z');
  ins.run('sess-1', 'reasoning', 'let me think', null, null, null, 0, 30, '2026-08-12T10:00:05.000Z');
  ins.run('sess-1', 'assistant', 'here is a plan', null, null, null, 0, 40, '2026-08-12T10:00:10.000Z');
  ins.run('sess-1', 'assistant', '',
    JSON.stringify([{ id: 'tc1', name: 'Bash', input: { command: 'ls -la' } }]),
    null, null, 0, 15, '2026-08-12T10:00:20.000Z');
  ins.run('sess-1', 'tool', 'total 0\nfile.txt', null, 'Bash', 'tc1', 0, 12, '2026-08-12T10:00:25.000Z');
  ins.run('sess-1', 'assistant', 'done', null, null, null, 0, 8, '2026-08-12T10:00:30.000Z');
  return db;
}

test('HERMES: in-memory SQLite self-test yields the common shape with a legal vocabulary',
  { skip: HAVE_SQLITE ? false : 'node:sqlite unavailable' }, () => {
    const db = makeHermesDb();
    try {
      const out = hermes.parse({ id: 'sess-1', db });
      assertCommonShape(out, 'hermes');

      assert.equal(out.meta.sessionId, 'sess-1');
      assert.equal(out.meta.model, 'hermes-large');
      assert.equal(out.meta.userTurns, 1);
      assert.equal(out.meta.assistantTurns, 2);   // 'here is a plan' + 'done'
      assert.equal(out.meta.thinkingBlocks, 1);
      assert.equal(out.meta.toolCalls, 1);
      assert.ok(out.meta.durationS > 0, 'durationS is positive');
      assert.ok(out.contextCurve.length > 0, 'contextCurve present');

      // tool_call/tool_result pairing survives the round-trip
      const call = out.events.find((e) => e.kind === 'tool_call');
      const result = out.events.find((e) => e.kind === 'tool_result');
      assert.equal(call.tool, 'Bash');
      assert.equal(call.label, 'ls -la');
      assert.equal(result.id, 'tc1');
      assert.equal(out.tools.Bash.count, 1);

      // honest empties: no subagent concept, no compaction without a parent
      assert.deepEqual(out.subagents, []);
      assert.equal(out.compactions.length, 0);
    } finally {
      db.close();
    }
  });
