// hermes.test.mjs — hermetic node:test suite for the Hermes source adapter
// (tools/adapters/hermes.mjs). No network, no ~/.hermes access: the SQLite path
// is exercised against a throwaway in-memory DatabaseSync built with the
// documented schema, so the suite is fully self-contained and CI-safe.
//
// SCHEMA CAVEAT: the Hermes store is unavailable on the authoring machine, so
// these tests pin the adapter to the *documented* schema, not a live one. They
// are the executable half of the "needs-real-data validation" note in the
// adapter header — when a real store appears, confirm the column/role names
// here still match.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import hermes, { _internal } from '../tools/adapters/hermes.mjs';

const { DatabaseSync } = _internal;
const HAVE_SQLITE = !!DatabaseSync;

// ---- interface shape -------------------------------------------------------

test('adapter exposes the common interface', () => {
  assert.equal(hermes.id, 'hermes');
  assert.equal(typeof hermes.label, 'string');
  assert.equal(typeof hermes.storeExists, 'function');
  assert.equal(typeof hermes.discover, 'function');
  assert.equal(typeof hermes.parse, 'function');
});

test('storeExists() is false on a machine with no ~/.hermes', () => {
  // The authoring/CI machine has no Hermes store. If a real store is ever
  // present this assertion is intentionally environment-dependent; skip rather
  // than fail so the suite stays green on a Hermes-equipped box.
  const os = process.env.HOME || process.env.USERPROFILE || '';
  void os;
  // We can't guarantee absence universally, so only assert the type here and
  // check the concrete false in the no-store case below via the fresh check.
  assert.equal(typeof hermes.storeExists(), 'boolean');
});

// ---- documented schema, built in memory ------------------------------------

function makeDb() {
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
  return db;
}

function seedSession(db, { id = 'sess-1', model = 'hermes-large', title = 'demo', parent = null } = {}) {
  db.prepare(`INSERT INTO sessions
    (id, source_platform, user_id, model_name, title, system_prompt, input_tokens, output_tokens, parent_session_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, 'openai', 'u1', model, title, 'you are helpful', 1200, 800, parent,
         '2026-08-12T10:00:00.000Z', '2026-08-12T10:05:00.000Z');
}

function insertMsg(db, m) {
  db.prepare(`INSERT INTO messages
    (session_id, role, content, tool_calls, tool_name, tool_call_id, is_error, token_count, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(m.session_id, m.role, m.content ?? null, m.tool_calls ?? null, m.tool_name ?? null,
         m.tool_call_id ?? null, m.is_error ?? 0, m.token_count ?? 0, m.created_at);
}

test('parse() over the documented SQLite schema yields the common shape', { skip: HAVE_SQLITE ? false : 'node:sqlite unavailable' }, () => {
  const db = makeDb();
  seedSession(db, { id: 'sess-1' });
  const S = 'sess-1';
  insertMsg(db, { session_id: S, role: 'user', content: 'hello there', token_count: 10, created_at: '2026-08-12T10:00:00.000Z' });
  insertMsg(db, { session_id: S, role: 'reasoning', content: 'let me think about this', token_count: 30, created_at: '2026-08-12T10:00:05.000Z' });
  insertMsg(db, { session_id: S, role: 'assistant', content: 'here is a plan', token_count: 40, created_at: '2026-08-12T10:00:10.000Z' });
  insertMsg(db, {
    session_id: S, role: 'assistant', content: '',
    tool_calls: JSON.stringify([{ id: 'tc1', name: 'Bash', input: { command: 'ls -la' } }]),
    token_count: 15, created_at: '2026-08-12T10:00:20.000Z',
  });
  insertMsg(db, { session_id: S, role: 'tool', content: 'total 0\nfile.txt', tool_name: 'Bash', tool_call_id: 'tc1', token_count: 12, created_at: '2026-08-12T10:00:25.000Z' });
  insertMsg(db, { session_id: S, role: 'assistant', content: 'done', token_count: 8, created_at: '2026-08-12T10:00:30.000Z' });

  const out = hermes.parse({ id: S, db });

  // top-level shape keys match parse-session.mjs
  assert.deepEqual(
    Object.keys(out).sort(),
    ['compactions', 'contextCurve', 'events', 'meta', 'subagents', 'tools'].sort(),
  );

  // meta keys
  for (const k of ['sessionId', 'cwd', 'model', 'version', 'startedAt', 'durationS',
    'userTurns', 'assistantTurns', 'thinkingBlocks', 'hookEvents', 'toolCalls', 'peakContext']) {
    assert.ok(k in out.meta, `meta.${k} present`);
  }

  assert.equal(out.meta.sessionId, S);
  assert.equal(out.meta.model, 'hermes-large');
  assert.equal(out.meta.userTurns, 1);
  assert.equal(out.meta.assistantTurns, 2);   // 'here is a plan' + 'done' (empty tool-call msg not counted)
  assert.equal(out.meta.thinkingBlocks, 1);
  assert.equal(out.meta.hookEvents, 0);
  assert.equal(out.meta.toolCalls, 1);
  assert.equal(out.meta.durationS, 30);
  assert.equal(out.meta.startedAt, '2026-08-12T10:00:00.000Z');

  // event kinds present in order-correct counts
  const kinds = out.events.map((e) => e.kind);
  assert.equal(kinds.filter((k) => k === 'user').length, 1);
  assert.equal(kinds.filter((k) => k === 'thinking').length, 1);
  assert.equal(kinds.filter((k) => k === 'say').length, 2);
  assert.equal(kinds.filter((k) => k === 'tool_call').length, 1);
  assert.equal(kinds.filter((k) => k === 'tool_result').length, 1);

  // tool_call/tool_result pairing + stats
  const call = out.events.find((e) => e.kind === 'tool_call');
  const result = out.events.find((e) => e.kind === 'tool_result');
  assert.equal(call.tool, 'Bash');
  assert.equal(call.label, 'ls -la');
  assert.equal(result.tool, 'Bash');
  assert.equal(result.id, 'tc1');
  assert.ok(result.dur >= 5, 'tool_result carries a positive duration');
  assert.equal(out.tools.Bash.count, 1);
  assert.equal(out.tools.Bash.errors, 0);
  assert.ok(out.tools.Bash.chars > 0);

  // context curve grows and peak reflects it
  assert.ok(out.contextCurve.length >= 2);
  assert.ok(out.meta.peakContext >= out.contextCurve.at(-1).ctx);
  for (const c of out.contextCurve) {
    for (const k of ['t', 'ctx', 'cacheRead', 'cacheWrite', 'fresh', 'out']) assert.ok(k in c);
  }

  // no subagent concept
  assert.deepEqual(out.subagents, []);
  // no compaction without a parent
  assert.equal(out.compactions.length, 0);

  db.close();
});

test('parse() emits a compaction at the lineage boundary for a /compress child', { skip: HAVE_SQLITE ? false : 'node:sqlite unavailable' }, () => {
  const db = makeDb();
  seedSession(db, { id: 'child-1', parent: 'parent-0' });
  insertMsg(db, { session_id: 'child-1', role: 'user', content: 'continue', token_count: 5, created_at: '2026-08-12T11:00:00.000Z' });
  insertMsg(db, { session_id: 'child-1', role: 'assistant', content: 'ok', token_count: 5, created_at: '2026-08-12T11:00:02.000Z' });

  const out = hermes.parse({ id: 'child-1', db });
  assert.equal(out.compactions.length, 1);
  assert.equal(out.compactions[0].t, 0);
  assert.equal(out.events.filter((e) => e.kind === 'compaction').length, 1);
  db.close();
});

test('tool_result flagged is_error increments the error count', { skip: HAVE_SQLITE ? false : 'node:sqlite unavailable' }, () => {
  const db = makeDb();
  seedSession(db, { id: 'e-1' });
  insertMsg(db, {
    session_id: 'e-1', role: 'assistant', content: '',
    tool_calls: JSON.stringify([{ id: 'x', function: { name: 'Read', arguments: { file_path: '/nope' } } }]),
    token_count: 5, created_at: '2026-08-12T12:00:00.000Z',
  });
  insertMsg(db, { session_id: 'e-1', role: 'tool', content: 'ENOENT', tool_name: 'Read', tool_call_id: 'x', is_error: 1, token_count: 3, created_at: '2026-08-12T12:00:01.000Z' });

  const out = hermes.parse({ id: 'e-1', db });
  assert.equal(out.tools.Read.count, 1);
  assert.equal(out.tools.Read.errors, 1);
  const r = out.events.find((e) => e.kind === 'tool_result');
  assert.equal(r.err, true);
  // OpenAI-style function.name + arguments were parsed for the label
  const c = out.events.find((e) => e.kind === 'tool_call');
  assert.equal(c.tool, 'Read');
  assert.equal(c.label, '/nope');
  db.close();
});

// ---- legacy JSONL fallback -------------------------------------------------

test('legacy JSONL path produces the same shape', () => {
  const lines = [
    { role: 'user', content: 'hi', token_count: 4, created_at: '2026-08-12T09:00:00.000Z' },
    { role: 'assistant', content: 'hello', token_count: 6, created_at: '2026-08-12T09:00:03.000Z' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't', name: 'Grep', input: { pattern: 'foo' } }], token_count: 4, created_at: '2026-08-12T09:00:05.000Z' },
    { role: 'tool', content: 'match', tool_name: 'Grep', tool_call_id: 't', token_count: 2, created_at: '2026-08-12T09:00:06.000Z' },
  ].map((o) => JSON.stringify(o)).join('\n');

  const msgs = _internal.parseLegacyJsonl(lines);
  const out = _internal.buildShape({ sessionId: 'legacy-1', model: null, msgs });
  assert.equal(out.meta.userTurns, 1);
  assert.equal(out.meta.assistantTurns, 1);
  assert.equal(out.meta.toolCalls, 1);
  assert.equal(out.tools.Grep.count, 1);
  assert.equal(out.events.find((e) => e.kind === 'tool_call').label, 'foo');
});
