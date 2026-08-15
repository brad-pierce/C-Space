// parser.test.mjs — hermetic node:test suite for SessionParser (tools/session-parser.mjs).
// No network, no servers, no browser. Pure imports + local fixture files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { LIBRARY_DIR } from '../tools/cspace-paths.mjs';
import { SessionParser, cleanPreview } from '../tools/session-parser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Pair a raw transcript with its CLI-parsed fixture WITHOUT naming a session.
// This used to hardcode a real local session id — a genuine identifier from the
// author's machine, committed to a public repo, and usable nowhere else. Now it
// discovers the first id present in BOTH the library and ~/.claude/projects.
// The parity test is fixture-backed (both files are local and gitignored), so it
// still skips cleanly on a fresh clone that has neither.
function findFixturePair() {
  const base = join(homedir(), '.claude', 'projects');
  let built, dirs;
  try {
    built = readdirSync(LIBRARY_DIR)
      .filter((f) => f.endsWith('.json') && f !== 'index.json')
      .map((f) => f.slice(0, -'.json'.length));
    dirs = readdirSync(base);
  } catch { return { id: null, raw: null }; }
  for (const id of built) {
    for (const d of dirs) {
      const p = join(base, d, `${id}.jsonl`);
      if (existsSync(p)) return { id, raw: p };
    }
  }
  return { id: null, raw: null };
}
const { id: SESSION_ID, raw: RAW_JSONL } = findFixturePair();
const FIXTURE_JSON = SESSION_ID ? join(LIBRARY_DIR, `${SESSION_ID}.json`) : null;
const haveFixtures = !!RAW_JSONL && !!FIXTURE_JSON && existsSync(FIXTURE_JSON);

const T0 = '2026-08-11T15:36:19.579Z';
const tPlus = (s) => new Date(Date.parse(T0) + s * 1000).toISOString();

function feedAll(parser, lines) {
  const items = [];
  for (const raw of lines) items.push(...parser.feed(raw));
  return items;
}

test('parity: streaming the raw JSONL matches the CLI fixture output', { skip: haveFixtures ? false : 'local session fixture not present' }, () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_JSON, 'utf8'));
  const rawLines = readFileSync(RAW_JSONL, 'utf8').split(/\r?\n/);

  const parser = new SessionParser(SESSION_ID);
  const items = feedAll(parser, rawLines);

  const ctxItems = items.filter((i) => i.kind === 'ctx');
  const eventItems = items.filter((i) => i.kind !== 'ctx');

  // event count parity (fixture.events excludes ctx entries; those live in contextCurve)
  assert.equal(eventItems.length, fixture.events.length, 'event count differs from CLI fixture');
  assert.equal(ctxItems.length, fixture.contextCurve.length, 'ctx item count differs from fixture contextCurve length');

  // tool totals parity (deepEqual ignores key order)
  assert.deepEqual(parser.toolsObject(), fixture.tools, 'per-tool stats differ from CLI fixture');

  // subagent count parity
  assert.equal(parser.subagents.length, fixture.subagents.length, 'subagent count differs from CLI fixture');

  // meta counter parity
  const meta = parser.snapshotMeta();
  assert.equal(meta.sessionId, fixture.meta.sessionId);
  assert.equal(meta.cwd, fixture.meta.cwd);
  assert.equal(meta.model, fixture.meta.model);
  assert.equal(meta.version, fixture.meta.version);
  assert.equal(meta.startedAt, fixture.meta.startedAt);
  assert.equal(meta.durationS, fixture.meta.durationS);
  assert.equal(meta.userTurns, fixture.meta.userTurns);
  assert.equal(meta.assistantTurns, fixture.meta.assistantTurns);
  assert.equal(meta.thinkingBlocks, fixture.meta.thinkingBlocks);
  assert.equal(meta.hookEvents, fixture.meta.hookEvents);
  assert.equal(meta.toolCalls, fixture.meta.toolCalls);

  // peak context is derivable from the ctx stream and must match the fixture
  const peak = ctxItems.reduce((a, c) => Math.max(a, c.ctx), 0);
  assert.equal(peak, fixture.meta.peakContext);

  // per-event-kind parity as a stronger check than raw count alone
  const countByKind = (arr) => arr.reduce((m, e) => (m[e.kind] = (m[e.kind] ?? 0) + 1, m), {});
  assert.deepEqual(countByKind(eventItems), countByKind(fixture.events));
});

test('malformed lines are skipped without throwing and produce no items', () => {
  const parser = new SessionParser('malformed-test');
  const bad = [
    '',                                   // empty
    '   ',                                // whitespace only
    'this is not json at all',            // garbage
    '{"type":"assistant","message":{',    // truncated JSON
    '{"type":"user",',                    // truncated JSON
    '{]',                                 // invalid syntax
    'null\u0000garbage',                  // binary-ish garbage
    '{"unterminated": "string',           // truncated string
  ];
  for (const raw of bad) {
    let items;
    assert.doesNotThrow(() => { items = parser.feed(raw); }, `feed threw on: ${JSON.stringify(raw)}`);
    assert.deepEqual(items, [], `expected no items for: ${JSON.stringify(raw)}`);
  }
  // parser state untouched
  assert.equal(parser.t0, null);
  assert.equal(parser.toolStats.size, 0);
  assert.equal(parser.subagents.length, 0);
  const meta = parser.snapshotMeta();
  assert.equal(meta.userTurns, 0);
  assert.equal(meta.assistantTurns, 0);
  assert.equal(meta.toolCalls, 0);
});

test('tool_use then tool_result pair by id with dur >= 0; is_error increments stats', () => {
  const parser = new SessionParser('pairing-test');

  const callItems = parser.feed(JSON.stringify({
    type: 'assistant', timestamp: T0,
    message: { content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls -la' } }] },
  }));
  assert.equal(callItems.length, 1);
  const call = callItems[0];
  assert.equal(call.kind, 'tool_call');
  assert.equal(call.tool, 'Bash');
  assert.equal(call.id, 'toolu_01');

  const resultItems = parser.feed(JSON.stringify({
    type: 'user', timestamp: tPlus(2),
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'file1\nfile2', is_error: false }] },
  }));
  assert.equal(resultItems.length, 1);
  const res = resultItems[0];
  assert.equal(res.kind, 'tool_result');
  assert.equal(res.tool, 'Bash');
  assert.equal(res.id, call.id, 'result id must match the tool_use id');
  assert.ok(res.dur >= 0, `dur must be >= 0, got ${res.dur}`);
  assert.equal(res.dur, 2);
  assert.equal(res.chars, 'file1\nfile2'.length);
  assert.equal(res.err, false);

  const afterOk = parser.toolsObject().Bash;
  assert.deepEqual(afterOk, { count: 1, errors: 0, chars: 'file1\nfile2'.length });

  // second call whose result is an error → errors increments
  parser.feed(JSON.stringify({
    type: 'assistant', timestamp: tPlus(3),
    message: { content: [{ type: 'tool_use', id: 'toolu_02', name: 'Bash', input: { command: 'false' } }] },
  }));
  const errItems = parser.feed(JSON.stringify({
    type: 'user', timestamp: tPlus(4),
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: [{ type: 'text', text: 'boom' }], is_error: true }] },
  }));
  assert.equal(errItems.length, 1);
  assert.equal(errItems[0].err, true);
  assert.equal(errItems[0].chars, 4); // array-content chars summed from text blocks
  const afterErr = parser.toolsObject().Bash;
  assert.equal(afterErr.count, 2);
  assert.equal(afterErr.errors, 1);
  assert.equal(parser.snapshotMeta().toolCalls, 2);

  // an orphan tool_result (unknown id) produces nothing
  const orphan = parser.feed(JSON.stringify({
    type: 'user', timestamp: tPlus(5),
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_ghost', content: 'x' }] },
  }));
  assert.deepEqual(orphan, []);
});

test('Task/Agent tool_use emits spawn; its tool_result emits despawn', () => {
  const parser = new SessionParser('spawn-test');

  const spawnItems = parser.feed(JSON.stringify({
    type: 'assistant', timestamp: T0,
    message: { content: [{ type: 'tool_use', id: 'toolu_task', name: 'Task', input: { description: 'explore repo', subagent_type: 'general-purpose' } }] },
  }));
  assert.deepEqual(spawnItems.map((i) => i.kind), ['tool_call', 'spawn']);
  const spawn = spawnItems[1];
  assert.equal(spawn.id, 'toolu_task');
  assert.equal(spawn.label, 'explore repo');
  assert.equal(spawn.type, 'general-purpose');
  assert.equal(parser.subagents.length, 1);
  assert.equal(parser.subagents[0].endT, null);

  const resultItems = parser.feed(JSON.stringify({
    type: 'user', timestamp: tPlus(10),
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_task', content: 'subagent done' }] },
  }));
  assert.deepEqual(resultItems.map((i) => i.kind), ['tool_result', 'despawn']);
  assert.equal(resultItems[1].id, 'toolu_task');
  assert.equal(parser.subagents[0].endT, 10);

  // Agent tool name also spawns
  const agentItems = parser.feed(JSON.stringify({
    type: 'assistant', timestamp: tPlus(11),
    message: { content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { prompt: 'run the tests' } }] },
  }));
  assert.deepEqual(agentItems.map((i) => i.kind), ['tool_call', 'spawn']);
  assert.equal(agentItems[1].id, 'toolu_agent');
  assert.equal(parser.subagents.length, 2);

  // a non-spawn tool does NOT emit spawn
  const plain = parser.feed(JSON.stringify({
    type: 'assistant', timestamp: tPlus(12),
    message: { content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'C:/x.txt' } }] },
  }));
  assert.deepEqual(plain.map((i) => i.kind), ['tool_call']);
});

test('compaction lines (type summary / isCompactSummary / system compact) emit compaction events', () => {
  const parser = new SessionParser('compaction-test');

  // type: summary
  const a = parser.feed(JSON.stringify({ type: 'summary', timestamp: T0, summary: 'earlier work' }));
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'compaction');

  // isCompactSummary flag on an otherwise ordinary line
  const b = parser.feed(JSON.stringify({ type: 'user', isCompactSummary: true, timestamp: tPlus(1), message: { content: 'compacted context' } }));
  assert.equal(b.length, 1);
  assert.equal(b[0].kind, 'compaction');

  // system line with compact subtype
  const c = parser.feed(JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: tPlus(2) }));
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'compaction');

  // compaction lines must not bleed into turn counters
  const meta = parser.snapshotMeta();
  assert.equal(meta.userTurns, 0);
  assert.equal(meta.assistantTurns, 0);
});

test('cleanPreview collapses whitespace and truncates with ellipsis', () => {
  assert.equal(cleanPreview('  hello\n\tworld  '), 'hello world');
  assert.equal(cleanPreview(42), '');
  const long = 'x'.repeat(200);
  const out = cleanPreview(long, 96);
  assert.equal(out.length, 96);
  assert.ok(out.endsWith('…'));
});
