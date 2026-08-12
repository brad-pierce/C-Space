// openclaw.test.mjs — hermetic node:test suite for the OpenClaw source adapter
// (tools/adapters/openclaw.mjs).
//
// NO ~/.openclaw ACCESS. Every SQLite case is built against a throwaway
// in-memory DatabaseSync using the DOCUMENTED schema, and the legacy case uses a
// temp directory this suite creates and deletes. Nothing here reads or writes a
// real session store, and no transcript content is committed.
//
// SCHEMA CAVEAT (same posture as tests/hermes.test.mjs): OpenClaw is not
// installed on the authoring machine, so these tests pin the adapter to the
// *documented* persistence model, not an observed one. The docs describe the
// entry types and the tree but NOT the physical table/column names, so the
// adapter reads through a coalescing view — this suite exercises BOTH shapes it
// promises to accept:
//   · a JSON body column (`data`) beside camelCase id/parentId/type columns, and
//   · a fully exploded snake_case table with no JSON at all.
// When a real store appears, these fixtures are the first thing to re-validate.
//
// Coverage map (the contract this file is here to hold):
//   1. common shape ......... assertCommonShape(), replicated from adapters.test.mjs
//   2. event mapping ........ user / say / tool_call / tool_result, paired by id
//   3. compaction fidelity .. tokensBefore becomes a real ctx point (the headline)
//   4. tree linearization ... active branch only, plus the documented tie-breaks
//   5. malformed data ....... orphan parentId + parentId cycle: no throw, no hang
//   6. custom vs custom_message
//   7. legacy path .......... sessions.json + .jsonl in a temp dir

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import openclaw, { _internal } from '../tools/adapters/openclaw.mjs';
import { adapters, getAdapter } from '../tools/adapters/index.mjs';

const { DatabaseSync, linearize, normalizeEntry, parseLegacyIndex, discoverFromDb, legacyRows } = _internal;
const HAVE_SQLITE = !!DatabaseSync;
const NO_SQLITE = HAVE_SQLITE ? false : 'node:sqlite unavailable';

// ---------------------------------------------------------------------------
// the COMMON VIZ VOCABULARY + shape assertion.
// Replicated verbatim from tests/adapters.test.mjs (that file does not export
// it, and importing a test module would re-run its whole suite). Keep the two
// copies identical — this is the shape contract every adapter is held to.
// ---------------------------------------------------------------------------
const ALLOWED_KINDS = new Set([
  'user', 'say', 'thinking', 'tool_call', 'tool_result',
  'spawn', 'despawn', 'compaction', 'hook', 'queued',
]);

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
  for (let i = 1; i < out.events.length; i++) {
    assert.ok(out.events[i].t >= out.events[i - 1].t, `${label}: events must be time-ordered`);
  }
  // contextCurve items carry the full ctx tuple and are time-ordered too
  for (const c of out.contextCurve) {
    for (const k of ['t', 'ctx', 'cacheRead', 'cacheWrite', 'fresh', 'out']) {
      assert.ok(k in c, `${label}: contextCurve item has ${k}`);
    }
  }
  for (let i = 1; i < out.contextCurve.length; i++) {
    assert.ok(out.contextCurve[i].t >= out.contextCurve[i - 1].t, `${label}: contextCurve time-ordered`);
  }
}

// ---------------------------------------------------------------------------
// fixtures — the documented store, built in memory
// ---------------------------------------------------------------------------

const BASE_MS = Date.parse('2026-08-12T10:00:00.000Z');
/** ISO timestamp `s` seconds after the session start. */
const T = (s) => new Date(BASE_MS + s * 1000).toISOString();

// Layer (1): SESSION ROWS — sessionKey -> SessionEntry, camelCase per the docs.
// Layer (2): TRANSCRIPT EVENTS — append-only tree; the entry body lives in a
// JSON `data` column (the realistic shape for an append-only event log).
const SCHEMA_CAMEL = `
  CREATE TABLE sessions (
    sessionKey TEXT PRIMARY KEY,
    sessionId TEXT,
    sessionStartedAt TEXT,
    lastInteractionAt TEXT,
    updatedAt TEXT,
    archivedAt TEXT,
    pinnedAt TEXT,
    inputTokens INTEGER,
    outputTokens INTEGER,
    totalTokens INTEGER,
    contextTokens INTEGER,
    compactionCount INTEGER,
    memoryFlushAt TEXT,
    memoryFlushCompactionCount INTEGER
  );
  CREATE TABLE transcript_entries (
    id TEXT PRIMARY KEY,
    parentId TEXT,
    sessionId TEXT,
    type TEXT,
    timestamp TEXT,
    data TEXT
  );
`;

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_CAMEL);
  return db;
}

function seedSession(db, s = {}) {
  const row = {
    sessionKey: 'agent-main',
    sessionId: 'transcript-1',
    sessionStartedAt: T(0),
    lastInteractionAt: T(60),
    updatedAt: T(60),
    archivedAt: null,
    pinnedAt: null,
    inputTokens: 1200,
    outputTokens: 800,
    totalTokens: 2000,
    contextTokens: 9000,
    compactionCount: 0,
    memoryFlushAt: null,
    memoryFlushCompactionCount: 0,
    ...s,
  };
  db.prepare(`INSERT INTO sessions
    (sessionKey, sessionId, sessionStartedAt, lastInteractionAt, updatedAt, archivedAt, pinnedAt,
     inputTokens, outputTokens, totalTokens, contextTokens, compactionCount, memoryFlushAt, memoryFlushCompactionCount)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.sessionKey, row.sessionId, row.sessionStartedAt, row.lastInteractionAt, row.updatedAt,
      row.archivedAt, row.pinnedAt, row.inputTokens, row.outputTokens, row.totalTokens,
      row.contextTokens, row.compactionCount, row.memoryFlushAt, row.memoryFlushCompactionCount);
  return row;
}

/** Split a flat fixture entry into (tree columns) + (JSON body). */
function splitEntry(e) {
  const { id, parentId = null, type, timestamp = null, ...body } = e;
  return { id, parentId, type, timestamp, body };
}

function seedEntries(db, sessionId, entries) {
  const ins = db.prepare(
    'INSERT INTO transcript_entries (id, parentId, sessionId, type, timestamp, data) VALUES (?,?,?,?,?,?)',
  );
  for (const e of entries) {
    const { id, parentId, type, timestamp, body } = splitEntry(e);
    ins.run(id, parentId, sessionId, type, timestamp, JSON.stringify(body));
  }
}

/** The same fixture entries as legacy JSONL — flat, no body column at all. */
const toJsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

// A minimal, complete session: header + user + assistant text + tool call + result.
const S_ID = 'transcript-1';
const MAIN_ENTRIES = [
  { id: 'e1', parentId: null, type: 'session', timestamp: T(0), cwd: '/home/dev/proj', version: '2.4.0', model: 'openclaw-large' },
  { id: 'e2', parentId: 'e1', type: 'message', timestamp: T(5), role: 'user', content: 'add a healthcheck endpoint' },
  { id: 'e3', parentId: 'e2', type: 'message', timestamp: T(10), role: 'assistant', content: 'I will start by listing the routes.' },
  {
    id: 'e4', parentId: 'e3', type: 'message', timestamp: T(15), role: 'assistant',
    content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls -la src' } }],
  },
  {
    id: 'e5', parentId: 'e4', type: 'message', timestamp: T(20), role: 'toolResult',
    toolCallId: 'call-1', content: 'total 8\nroutes.js', isError: false,
  },
];
const RESULT_TEXT = 'total 8\nroutes.js';

function mainDb() {
  const db = makeDb();
  seedSession(db);
  seedEntries(db, S_ID, MAIN_ENTRIES);
  return db;
}

// ===========================================================================
// (0) interface + registry
// ===========================================================================

test('adapter exposes the common interface', () => {
  assert.equal(openclaw.id, 'openclaw');
  assert.equal(typeof openclaw.label, 'string');
  assert.equal(typeof openclaw.storeExists, 'function');
  assert.equal(typeof openclaw.discover, 'function');
  assert.equal(typeof openclaw.parse, 'function');
  assert.equal(typeof openclaw.storeExists(), 'boolean', 'storeExists() answers without throwing');
});

test('registry: openclaw is registered and resolvable by id', () => {
  assert.ok(adapters.some((a) => a.id === 'openclaw'), 'openclaw is in the adapter registry');
  assert.equal(getAdapter('openclaw'), openclaw, "getAdapter('openclaw') resolves to this module's default export");
});

test('parse() refuses an empty/unresolvable entry instead of inventing data', () => {
  assert.throws(() => openclaw.parse(null), /entry is required/);
  // No db, no dbPath, no agentId -> nothing readable. Must be an explicit error.
  assert.throws(() => openclaw.parse({ id: 'nope' }), /openclaw\.parse:/);
});

test('discover() rows built from an in-memory DB carry the required fields',
  { skip: NO_SQLITE }, () => {
    const db = mainDb();
    try {
      const rows = discoverFromDb(db, 'agent-a', '/nonexistent/agent/openclaw-agent.sqlite');
      assert.equal(rows.length, 1);
      const r = rows[0];
      assert.equal(r.source, 'openclaw');
      assert.equal(r.id, S_ID);
      assert.equal(r.agentId, 'agent-a');
      assert.equal(r.sessionKey, 'agent-main');
      assert.ok(r.project.includes('openclaw'), 'project label names the source and agent');
      assert.ok(r.ref != null || r.dbPath != null, 'row carries a locator');
      assert.equal(typeof r.mtime, 'number');
      assert.ok('sizeMB' in r);
      assert.equal(typeof r.active, 'boolean');
      assert.equal(r.archived, false);
      assert.equal(r.pinned, false);
    } finally {
      db.close();
    }
  });

// ===========================================================================
// (1) common shape
// ===========================================================================

test('1. parse() over the documented SQLite schema yields the COMMON VIZ SHAPE',
  { skip: NO_SQLITE }, () => {
    const db = mainDb();
    try {
      const out = openclaw.parse({ id: S_ID, db, agentId: 'agent-a' });
      assertCommonShape(out, 'openclaw');

      assert.equal(out.meta.sessionId, S_ID);
      assert.equal(out.meta.cwd, '/home/dev/proj');
      assert.equal(out.meta.model, 'openclaw-large');
      assert.equal(out.meta.version, '2.4.0');
      assert.equal(out.meta.startedAt, T(0));
      assert.equal(out.meta.durationS, 20);
      assert.equal(out.meta.userTurns, 1);
      assert.equal(out.meta.assistantTurns, 1);
      assert.equal(out.meta.thinkingBlocks, 0);
      assert.equal(out.meta.toolCalls, 1);

      // honest empties: OpenClaw documents no hook and no subagent concept
      assert.equal(out.meta.hookEvents, 0);
      assert.deepEqual(out.subagents, []);
      assert.deepEqual(out.compactions, []);

      // session-level contextTokens lands at the tail of the curve
      assert.ok(out.contextCurve.length >= 1);
      assert.equal(out.contextCurve.at(-1).ctx, 9000);
      assert.ok(out.meta.peakContext >= 9000);

      // additive extras do not displace any canonical key
      assert.equal(out.meta.agentId, 'agent-a');
      assert.equal(out.meta.parentSession, null);
    } finally {
      db.close();
    }
  });

test('1b. a header parentSession is recorded as lineage, NOT as a phantom compaction',
  { skip: NO_SQLITE }, () => {
    const db = makeDb();
    seedSession(db, { sessionId: 'child-1', contextTokens: 0, compactionCount: 0 });
    seedEntries(db, 'child-1', [
      { id: 'h1', parentId: null, type: 'session', timestamp: T(0), cwd: '/w', parentSession: 'transcript-0' },
      { id: 'h2', parentId: 'h1', type: 'message', timestamp: T(2), role: 'user', content: 'continue' },
    ]);
    try {
      const out = openclaw.parse({ id: 'child-1', db });
      assertCommonShape(out, 'openclaw/lineage');
      assert.equal(out.meta.parentSession, 'transcript-0', 'lineage is carried on meta');
      // real compactions are their own entries; inventing one here would double-count
      assert.deepEqual(out.compactions, [], 'lineage alone does not fabricate a compaction');
      assert.equal(out.events.filter((e) => e.kind === 'compaction').length, 0);
    } finally {
      db.close();
    }
  });

// ===========================================================================
// (2) event mapping
// ===========================================================================

test('2. header + user + assistant text + tool call + toolResult map to exactly user/say/tool_call/tool_result',
  { skip: NO_SQLITE }, () => {
    const db = mainDb();
    try {
      const out = openclaw.parse({ id: S_ID, db });

      // the session header itself is metadata, not a turn — it emits no event
      assert.deepEqual(out.events.map((e) => e.kind), ['user', 'say', 'tool_call', 'tool_result']);

      const [user, say, call, result] = out.events;
      assert.equal(user.preview, 'add a healthcheck endpoint');
      assert.equal(user.chars, 'add a healthcheck endpoint'.length);
      assert.equal(say.preview, 'I will start by listing the routes.');

      // call/result paired by id
      assert.equal(call.tool, 'Bash');
      assert.equal(call.id, 'call-1');
      assert.equal(call.label, 'ls -la src', 'tool args are summarized to a one-line label');
      assert.equal(result.id, call.id, 'result is paired to the call by id');
      assert.equal(result.tool, 'Bash', 'result inherits the tool name from its open call');
      assert.equal(result.chars, RESULT_TEXT.length);
      assert.equal(result.err, false);
      assert.equal(result.dur, 5, 'result duration is measured from its call');

      assert.deepEqual(out.tools, { Bash: { count: 1, errors: 0, chars: RESULT_TEXT.length } });
    } finally {
      db.close();
    }
  });

test('2b. the error flag is honored, and the coalescing view reads an exploded snake_case table',
  { skip: NO_SQLITE }, () => {
    // No JSON body column anywhere: every documented field is its own snake_case
    // column. Same adapter, same expected output — this is the second physical
    // shape the header promises to accept.
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        session_key TEXT PRIMARY KEY,
        session_id TEXT,
        session_started_at TEXT,
        last_interaction_at TEXT,
        context_tokens INTEGER,
        compaction_count INTEGER
      );
      CREATE TABLE transcript_events (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        session_id TEXT,
        type TEXT,
        timestamp TEXT,
        role TEXT,
        content TEXT,
        tool_name TEXT,
        tool_call_id TEXT,
        is_error INTEGER,
        tokens_before INTEGER
      );
    `);
    try {
      db.prepare(`INSERT INTO sessions
        (session_key, session_id, session_started_at, last_interaction_at, context_tokens, compaction_count)
        VALUES (?,?,?,?,?,?)`).run('agent-main', 'snake-1', T(0), T(10), 4000, 0);
      const ins = db.prepare(`INSERT INTO transcript_events
        (id, parent_id, session_id, type, timestamp, role, content, tool_name, tool_call_id, is_error, tokens_before)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      ins.run('s1', null, 'snake-1', 'session', T(0), null, null, null, null, null, null);
      ins.run('m1', 's1', 'snake-1', 'message', T(1), 'user', 'read the config', null, null, null, null);
      ins.run('m2', 'm1', 'snake-1', 'message', T(2), 'assistant',
        JSON.stringify([{ type: 'tool_call', id: 'tc-9', name: 'Read', input: { file_path: '/etc/nope.conf' } }]),
        null, null, null, null);
      ins.run('m3', 'm2', 'snake-1', 'message', T(3), 'toolResult', 'ENOENT: no such file', 'Read', 'tc-9', 1, null);

      const out = openclaw.parse({ id: 'snake-1', db });
      assertCommonShape(out, 'openclaw/snake');

      assert.deepEqual(out.events.map((e) => e.kind), ['user', 'tool_call', 'tool_result']);
      const call = out.events.find((e) => e.kind === 'tool_call');
      const result = out.events.find((e) => e.kind === 'tool_result');
      assert.equal(call.tool, 'Read');
      assert.equal(call.label, '/etc/nope.conf');
      assert.equal(result.id, 'tc-9', 'snake_case tool_call_id still pairs the result to the call');
      assert.equal(result.err, true, 'is_error = 1 sets the error flag');
      assert.equal(out.tools.Read.count, 1);
      assert.equal(out.tools.Read.errors, 1, 'the error is counted against the tool');
    } finally {
      db.close();
    }
  });

// ===========================================================================
// (3) COMPACTION FIDELITY — the adapter's headline advantage
// ===========================================================================

test('3. a compaction entry emits a compaction event AND a ctx point at tokensBefore immediately preceding it',
  { skip: NO_SQLITE }, () => {
    const TOKENS_BEFORE = 152340;
    const db = makeDb();
    // contextTokens is the CURRENT (post-compaction) size, so the curve should
    // read: pre-compaction sample -> tokensBefore spike -> collapsed tail.
    seedSession(db, { sessionId: 'compact-1', contextTokens: 9000, compactionCount: 1 });
    seedEntries(db, 'compact-1', [
      { id: 'c1', parentId: null, type: 'session', timestamp: T(0), cwd: '/w' },
      { id: 'c2', parentId: 'c1', type: 'message', timestamp: T(5), role: 'user', content: 'keep going' },
      {
        id: 'c3', parentId: 'c2', type: 'message', timestamp: T(10), role: 'assistant',
        content: 'working on it', usage: { input_tokens: 40000, output_tokens: 120 },
      },
      {
        id: 'c4', parentId: 'c3', type: 'compaction', timestamp: T(15),
        tokensBefore: TOKENS_BEFORE, firstKeptEntryId: 'c3',
      },
      { id: 'c5', parentId: 'c4', type: 'message', timestamp: T(20), role: 'user', content: 'continue' },
    ]);
    try {
      const out = openclaw.parse({ id: 'compact-1', db });
      assertCommonShape(out, 'openclaw/compaction');

      // the compaction event
      const comp = out.events.filter((e) => e.kind === 'compaction');
      assert.equal(comp.length, 1, 'exactly one compaction event');
      assert.equal(out.compactions.length, 1);
      assert.equal(out.compactions[0].tokensBefore, TOKENS_BEFORE, 'the measured pre-collapse size is recorded');
      assert.equal(out.compactions[0].firstKeptEntryId, 'c3');
      assert.equal(out.compactions[0].t, comp[0].t, 'compaction record and event agree on time');

      // THE HEADLINE: a real ctx point at tokensBefore, immediately preceding the
      // compaction — so the tower collapses by the TRUE measured amount.
      const before = out.contextCurve.filter((c) => c.t <= comp[0].t);
      assert.ok(before.length >= 2, 'there is a pre-compaction sample and the tokensBefore point');
      assert.equal(before.at(-1).ctx, TOKENS_BEFORE,
        'the ctx point immediately preceding the compaction equals tokensBefore');
      assert.equal(before.at(-1).t, comp[0].t, 'that point sits at the compaction timestamp');
      assert.equal(before.at(-2).ctx, 40000, 'the earlier usage sample is still there, and is smaller');

      // and the curve actually collapses afterwards
      const after = out.contextCurve.filter((c) => c.t > comp[0].t);
      assert.ok(after.length >= 1, 'the curve continues past the compaction');
      assert.ok(after.at(-1).ctx < TOKENS_BEFORE, 'context is lower after the collapse');
      assert.equal(out.meta.peakContext, TOKENS_BEFORE, 'peakContext is the measured pre-collapse peak');
    } finally {
      db.close();
    }
  });

test('3b. a compactionCount the active path cannot account for is reported, not silently absorbed',
  { skip: NO_SQLITE }, () => {
    const db = makeDb();
    // The row claims two compactions; only one is on the active path (the other
    // lived on a branch that was abandoned). Expected after a rewind — but it must
    // be surfaced, because the alternative explanation is a mapping error.
    seedSession(db, { sessionId: 'mismatch-1', contextTokens: 0, compactionCount: 2 });
    seedEntries(db, 'mismatch-1', [
      { id: 'p1', parentId: null, type: 'session', timestamp: T(0), cwd: '/w' },
      { id: 'p2', parentId: 'p1', type: 'compaction', timestamp: T(5), tokensBefore: 80000 },
      { id: 'p3', parentId: 'p2', type: 'message', timestamp: T(10), role: 'user', content: 'after' },
    ]);
    try {
      const warnings = [];
      const out = openclaw.parse({ id: 'mismatch-1', db, warnings });
      assert.equal(out.compactions.length, 1);
      assert.ok(warnings.some((w) => /compactionCount mismatch/i.test(w)), 'the discrepancy is reported');
    } finally {
      db.close();
    }
  });

// ===========================================================================
// (4) TREE LINEARIZATION
// ===========================================================================

test('4. a forked transcript linearizes to the ACTIVE branch only',
  { skip: NO_SQLITE }, () => {
    const db = makeDb();
    seedSession(db, { sessionId: 'fork-1', contextTokens: 0, compactionCount: 0 });
    // Shared trunk: f1 (header) -> f2 (user) -> f3 (assistant)  <-- shared parent
    //   abandoned branch off f3: a1 -> a2      (SHALLOWER, but NEWER timestamps)
    //   active branch off f3:    b1 -> b2 -> b3 (DEEPER)
    // Depth decides first per the documented rule, so the deeper branch wins even
    // though the abandoned one was written later — a rewind that then went further.
    seedEntries(db, 'fork-1', [
      { id: 'f1', parentId: null, type: 'session', timestamp: T(0), cwd: '/w' },
      { id: 'f2', parentId: 'f1', type: 'message', timestamp: T(5), role: 'user', content: 'shared question' },
      { id: 'f3', parentId: 'f2', type: 'message', timestamp: T(10), role: 'assistant', content: 'shared answer' },

      { id: 'a1', parentId: 'f3', type: 'message', timestamp: T(100), role: 'user', content: 'abandoned question' },
      { id: 'a2', parentId: 'a1', type: 'message', timestamp: T(105), role: 'assistant', content: 'abandoned answer' },

      { id: 'b1', parentId: 'f3', type: 'message', timestamp: T(20), role: 'user', content: 'active question' },
      { id: 'b2', parentId: 'b1', type: 'message', timestamp: T(25), role: 'assistant', content: 'active answer' },
      { id: 'b3', parentId: 'b2', type: 'message', timestamp: T(30), role: 'user', content: 'active follow-up' },
    ]);
    try {
      const warnings = [];
      const out = openclaw.parse({ id: 'fork-1', db, warnings });
      assertCommonShape(out, 'openclaw/fork');

      const previews = out.events.map((e) => e.preview);
      assert.deepEqual(previews, [
        'shared question', 'shared answer',
        'active question', 'active answer', 'active follow-up',
      ], 'only the active branch appears, in order');

      // nothing from the abandoned branch survives, in any form
      assert.ok(!previews.some((p) => String(p).includes('abandoned')), 'no abandoned-branch content');
      assert.equal(out.meta.userTurns, 3, 'turn counts reflect the active path only');
      assert.equal(out.meta.assistantTurns, 2);
      assert.ok(warnings.some((w) => /abandoned branch/i.test(w)), 'the drop is reported, not silent');
    } finally {
      db.close();
    }
  });

test('4b. the documented tie-break order is depth, then timestamp, then storage sequence, then id', () => {
  // Exercised directly against linearize() so each tie-break can be isolated;
  // normalizeEntry() is the same normalizer both storage paths feed it.
  const norm = (o, seq) => normalizeEntry(o, seq);
  const trunk = { id: 'p', parentId: null, type: 'message', role: 'user', content: 'root' };

  // (a) equal depth -> the LATEST timestamp wins
  {
    const older = { id: 'x', parentId: 'p', type: 'message', timestamp: T(10), role: 'assistant', content: 'older' };
    const newer = { id: 'y', parentId: 'p', type: 'message', timestamp: T(20), role: 'assistant', content: 'newer' };
    const path = linearize([norm(trunk, 0), norm(newer, 1), norm(older, 2)], { warnings: [] });
    assert.deepEqual(path.map((e) => e.id), ['p', 'y'], 'later timestamp wins at equal depth');
  }

  // (b) equal depth, no usable timestamps -> the HIGHEST storage sequence wins
  {
    const first = { id: 'x', parentId: 'p', type: 'message', role: 'assistant', content: 'first' };
    const later = { id: 'y', parentId: 'p', type: 'message', role: 'assistant', content: 'later' };
    const path = linearize([norm(trunk, 0), norm(first, 1), norm(later, 2)], { warnings: [] });
    assert.deepEqual(path.map((e) => e.id), ['p', 'y'], 'highest storage sequence wins when no timestamps exist');
  }

  // (b2) equal depth, IDENTICAL timestamps -> falls through to storage sequence
  {
    const a = { id: 'x', parentId: 'p', type: 'message', timestamp: T(9), role: 'assistant', content: 'a' };
    const b = { id: 'y', parentId: 'p', type: 'message', timestamp: T(9), role: 'assistant', content: 'b' };
    const path = linearize([norm(trunk, 0), norm(a, 1), norm(b, 2)], { warnings: [] });
    assert.deepEqual(path.map((e) => e.id), ['p', 'y'], 'equal timestamps fall through to sequence');
  }

  // (c) equal depth, equal sequence, no timestamps -> the greatest id wins,
  //     so the choice is deterministic even on a store with nothing to order by.
  {
    const aa = { id: 'aa', parentId: 'p', type: 'message', role: 'assistant', content: 'aa' };
    const zz = { id: 'zz', parentId: 'p', type: 'message', role: 'assistant', content: 'zz' };
    const path1 = linearize([norm(trunk, 7), norm(aa, 7), norm(zz, 7)], { warnings: [] });
    const path2 = linearize([norm(trunk, 7), norm(zz, 7), norm(aa, 7)], { warnings: [] });
    assert.deepEqual(path1.map((e) => e.id), ['p', 'zz'], 'lexicographically greatest id wins');
    assert.deepEqual(path2.map((e) => e.id), path1.map((e) => e.id), 'and the result is input-order independent');
  }
});

test('4c. a flat log (ids but no resolvable parent links) keeps storage order', () => {
  const rows = [
    { id: 'l1', type: 'message', role: 'user', content: 'one' },
    { id: 'l2', type: 'message', role: 'assistant', content: 'two' },
    { id: 'l3', type: 'message', role: 'user', content: 'three' },
  ].map((o, i) => normalizeEntry(o, i));
  const path = linearize(rows, { warnings: [] });
  assert.deepEqual(path.map((e) => e.id), ['l1', 'l2', 'l3'],
    'an unlinked log is a timeline already — it must not collapse to its last entry');
});

// ===========================================================================
// (5) MALFORMED DATA — must neither throw nor hang
// ===========================================================================

test('5. an orphaned parentId and a parentId cycle neither throw nor hang',
  { skip: NO_SQLITE, timeout: 5000 }, () => {
    const db = makeDb();
    seedSession(db, { sessionId: 'bad-1', contextTokens: 0, compactionCount: 0 });
    seedEntries(db, 'bad-1', [
      { id: 'g1', parentId: null, type: 'session', timestamp: T(0), cwd: '/w' },
      { id: 'g2', parentId: 'g1', type: 'message', timestamp: T(5), role: 'user', content: 'hello' },
      // orphan: parent was never written (truncated store / partial import)
      { id: 'g3', parentId: 'MISSING', type: 'message', timestamp: T(10), role: 'assistant', content: 'orphaned reply' },
      // cycle: two entries claiming each other as parent
      { id: 'g4', parentId: 'g5', type: 'message', timestamp: T(15), role: 'user', content: 'cycle a' },
      { id: 'g5', parentId: 'g4', type: 'message', timestamp: T(20), role: 'assistant', content: 'cycle b' },
    ]);
    try {
      const warnings = [];
      let out;
      assert.doesNotThrow(() => { out = openclaw.parse({ id: 'bad-1', db, warnings }); },
        'a malformed store is reported, not fatal');
      assertCommonShape(out, 'openclaw/malformed');
      assert.ok(warnings.some((w) => /missing parent/i.test(w)), 'the orphan is reported');
      // the reachable trunk still renders; the cycle contributes no phantom turns
      assert.ok(out.events.length >= 1, 'the healthy part of the transcript still parses');
    } finally {
      db.close();
    }
  });

test('5a2. duplicate entry ids (a merged/appended store) keep the first and are reported',
  { timeout: 5000 }, () => {
    // The canonical DB has id as a PRIMARY KEY, so this only arises on the
    // JSONL/import path — where two transcripts get concatenated.
    const rows = [
      { id: 'd1', parentId: null, type: 'message', timestamp: T(0), role: 'user', content: 'first wins' },
      { id: 'd2', parentId: 'd1', type: 'message', timestamp: T(1), role: 'assistant', content: 'kept' },
      { id: 'd2', parentId: 'd1', type: 'message', timestamp: T(2), role: 'assistant', content: 'dropped duplicate' },
    ].map((o, i) => normalizeEntry(o, i));
    const warnings = [];
    const path = linearize(rows, { warnings });
    assert.deepEqual(path.map((e) => e.id), ['d1', 'd2']);
    assert.ok(warnings.some((w) => /duplicate transcript entry id/i.test(w)), 'the duplicate is reported');
    const out = _internal.buildShape({ sessionId: 'dup', entries: rows, session: {}, warnings: [] });
    assert.ok(!out.events.some((e) => String(e.preview ?? '').includes('dropped duplicate')),
      'the dropped duplicate never reaches the timeline');
  });

test('5b. a fully cyclic transcript falls back to storage order instead of spinning',
  { timeout: 5000 }, () => {
    const rows = [
      { id: 'z1', parentId: 'z2', type: 'message', role: 'user', content: 'a' },
      { id: 'z2', parentId: 'z1', type: 'message', role: 'assistant', content: 'b' },
    ].map((o, i) => normalizeEntry(o, i));
    const warnings = [];
    const path = linearize(rows, { warnings });
    assert.equal(path.length, 2, 'both entries are still returned');
    assert.deepEqual(path.map((e) => e.id), ['z1', 'z2'], 'in storage order');
    assert.ok(warnings.some((w) => /cyclic|cycle/i.test(w)), 'the cycle is reported');
  });

test('5c. malformed JSONL lines are skipped without sinking the transcript', () => {
  const text = [
    JSON.stringify({ id: 'j1', type: 'message', timestamp: T(0), role: 'user', content: 'good' }),
    '{ not json at all',
    '',
    JSON.stringify({ id: 'j2', parentId: 'j1', type: 'message', timestamp: T(1), role: 'assistant', content: 'also good' }),
  ].join('\n');
  const entries = _internal.parseLegacyTranscript(text, { isText: true });
  assert.equal(entries.length, 2, 'the two valid lines survive');
  const out = _internal.buildShape({ sessionId: 'j', entries, session: {}, warnings: [] });
  assertCommonShape(out, 'openclaw/badjsonl');
  assert.deepEqual(out.events.map((e) => e.kind), ['user', 'say']);
});

// ===========================================================================
// (6) custom vs custom_message
// ===========================================================================

test("6. 'custom' is skipped; 'custom_message' becomes a say only when it carries text",
  { skip: NO_SQLITE }, () => {
    const db = makeDb();
    seedSession(db, { sessionId: 'custom-1', contextTokens: 0, compactionCount: 0 });
    seedEntries(db, 'custom-1', [
      { id: 'k1', parentId: null, type: 'session', timestamp: T(0), cwd: '/w' },
      { id: 'k2', parentId: 'k1', type: 'message', timestamp: T(5), role: 'user', content: 'go' },
      // docs: persists WITHOUT model visibility -> never a turn, never context
      { id: 'k3', parentId: 'k2', type: 'custom', timestamp: T(10), content: 'extension state the model never saw' },
      // docs: extension-injected content that DOES enter model context
      { id: 'k4', parentId: 'k3', type: 'custom_message', timestamp: T(15), content: 'injected context note' },
      // payload-only custom_message: no prose, so no empty assistant turn
      { id: 'k5', parentId: 'k4', type: 'custom_message', timestamp: T(20), content: null, payload: { flag: true } },
      // branch-navigation metadata, not turn content
      { id: 'k6', parentId: 'k5', type: 'branch_summary', timestamp: T(25), content: 'summary of a branch' },
    ]);
    try {
      const out = openclaw.parse({ id: 'custom-1', db });
      assertCommonShape(out, 'openclaw/custom');

      assert.deepEqual(out.events.map((e) => e.kind), ['user', 'say'],
        "'custom' and 'branch_summary' contribute nothing; only the text-bearing custom_message does");
      const say = out.events.find((e) => e.kind === 'say');
      assert.equal(say.preview, 'injected context note');
      assert.equal(out.meta.assistantTurns, 1, 'the payload-only custom_message is not counted as a turn');
      assert.ok(!out.events.some((e) => String(e.preview ?? '').includes('never saw')),
        "custom-entry content never reaches the timeline");
    } finally {
      db.close();
    }
  });

// ===========================================================================
// (7) LEGACY path — sessions.json + .jsonl in a temp dir we create and delete
// ===========================================================================

// The legacy pair, written into a fresh temp dir. `fn` gets the paths; the dir is
// always removed afterwards. NOTHING here goes near a real ~/.openclaw.
function withLegacyStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cspace-openclaw-'));
  try {
    // the legacy index, in the sessionKey -> SessionEntry map form
    const indexPath = join(dir, 'sessions.json');
    writeFileSync(indexPath, JSON.stringify({
      sessions: {
        'agent-main': {
          sessionId: S_ID,
          sessionStartedAt: T(0),
          lastInteractionAt: T(60),
          updatedAt: T(60),
          inputTokens: 1200,
          outputTokens: 800,
          totalTokens: 2000,
          contextTokens: 9000,
          compactionCount: 0,
        },
      },
    }, null, 2));
    const jsonlPath = join(dir, `${S_ID}.jsonl`);
    writeFileSync(jsonlPath, toJsonl(MAIN_ENTRIES));
    return fn({ dir, indexPath, jsonlPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// NOT gated on node:sqlite: when the built-in module is missing this is the only
// path the adapter has left, so it is exactly the case that must still work.
test('7. a legacy sessions.json + .jsonl pair in a temp dir parses to the common shape', () => {
  withLegacyStore(({ dir, indexPath, jsonlPath }) => {
    const index = parseLegacyIndex(readFileSync(indexPath, 'utf8'));
    assert.equal(index.length, 1, 'the index yields one session row');
    assert.equal(index[0].sessionKey, 'agent-main');
    assert.equal(index[0].sessionId, S_ID);

    // the discover() -> parse() round trip: the row the adapter builds off the
    // index must carry enough SessionEntry metadata that parse() is as faithful
    // as the SQLite path. (Regression guard: dropping it silently produced
    // peakContext 0 and no curve tail for every legacy session.)
    const rows = legacyRows({
      agentId: 'agent-x',
      dir,
      dbPath: join(dir, 'agent', 'openclaw-agent.sqlite'),
      sessionsDir: dir,
      indexPath,
    });
    assert.equal(rows.length, 1, 'the index yields exactly one discover row (no duplicate from the dir scan)');
    assert.equal(rows[0].id, S_ID);
    assert.equal(rows[0].path, jsonlPath, 'the row points at the transcript on disk');
    assert.equal(rows[0].source, 'openclaw');
    assert.equal(rows[0].legacy, true);
    assert.ok(rows[0].sizeMB > 0, 'size comes from the real file');
    assert.equal(rows[0].mtime, Date.parse(T(60)), 'mtime prefers lastInteractionAt over the file stat');

    const out = openclaw.parse(rows[0]);
    assertCommonShape(out, 'openclaw/legacy');

    // same transcript as the SQLite fixture, so the same timeline
    assert.deepEqual(out.events.map((e) => e.kind), ['user', 'say', 'tool_call', 'tool_result']);
    assert.equal(out.meta.cwd, '/home/dev/proj');
    assert.equal(out.meta.version, '2.4.0');
    assert.equal(out.meta.model, 'openclaw-large');
    assert.equal(out.meta.durationS, 20);
    assert.equal(out.meta.userTurns, 1);
    assert.equal(out.meta.assistantTurns, 1);
    assert.equal(out.meta.toolCalls, 1);
    assert.deepEqual(out.tools, { Bash: { count: 1, errors: 0, chars: RESULT_TEXT.length } });
    assert.equal(out.events.at(-1).id, 'call-1', 'the result is still paired to its call by id');
    assert.equal(out.meta.peakContext, 9000, 'the index token counters survive discover() -> parse()');
    assert.equal(out.contextCurve.at(-1).ctx, 9000);
  });
});

test('7b. the legacy path and the SQLite path produce IDENTICAL output for the same transcript',
  { skip: NO_SQLITE }, () => {
    const db = mainDb();
    try {
      const legacy = withLegacyStore(({ indexPath, jsonlPath }) => {
        const index = parseLegacyIndex(readFileSync(indexPath, 'utf8'));
        return openclaw.parse({ id: S_ID, path: jsonlPath, session: index[0] });
      });
      const sql = openclaw.parse({ id: S_ID, db });
      // identical transcript + identical session counters => identical output,
      // whichever storage layer it came out of.
      assert.deepEqual(legacy.events, sql.events, 'legacy events match the SQLite path exactly');
      assert.deepEqual(legacy.tools, sql.tools, 'legacy tool stats match');
      assert.deepEqual(legacy.contextCurve, sql.contextCurve, 'legacy context curve matches');
      assert.deepEqual(legacy.meta, sql.meta, 'legacy meta matches');
      assert.deepEqual(legacy.compactions, sql.compactions);
      assert.deepEqual(legacy.subagents, sql.subagents);
    } finally {
      db.close();
    }
  });
