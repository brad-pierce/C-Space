// setup-discovery.test.mjs — the candidate enumerator (tools/setup-discovery.mjs).
//
// This module is the one that turns filesystem contents into the setup surface's
// id space, so the suite is weighted towards the properties the traversal fence
// rests on rather than towards output cosmetics:
//
//   (a) NO REVERSE MAP. The public API takes no arguments at all, mints no ids,
//       and holds no id→path table. An id the current scan did not just produce
//       resolves to nothing — including one built with another process's salt
//       and one whose "project" is a traversal string.
//   (b) WORKTREE FOLDING. The panel offers exactly the slugs `npm run allowlist`
//       offers, with worktree sessions folded into their parent slug.
//   (c) STALE ENTRIES. A configured project that is not on this machine is still
//       emitted, so it can be DENIED.
//   (d) A STORE THAT EXISTS BUT CANNOT BE READ degrades to "absent" and never
//       throws — on the Claude store, on a project directory, and on the config.
//
// HERMETIC AND READ-ONLY. Every filesystem fixture lives under a mkdtemp dir;
// CSPACE_ALLOWLIST and CSPACE_DATA are redirected there before anything is
// enumerated, so the real cspace.allowlist.json and ~/.cspace are never touched.
// Nothing here writes to ~/.claude, ~/.codex, ~/.hermes or ~/.openclaw — the
// Claude scan is exercised against a fixture through the tests-only `_internal`
// seam, which is why that seam exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, utimesSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomBytes } from 'node:crypto';

// ---- redirect every writable path at a temp dir BEFORE anything is enumerated.
// The lazy dynamic import of the adapter registry (and, through it, live-server)
// happens inside enumerateCandidates(), i.e. after this block runs, so these
// take effect for the whole suite.
const TMP = mkdtempSync(join(tmpdir(), 'cspace-discovery-'));
const CONFIG = join(TMP, 'cspace.allowlist.json');
writeFileSync(CONFIG, JSON.stringify({ allow: [], sources: {} }, null, 2));
process.env.CSPACE_ALLOWLIST = CONFIG;
process.env.CSPACE_DATA = join(TMP, 'data');
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const { enumerateCandidates, invalidateCandidates, _internal } =
  await import('../tools/setup-discovery.mjs');
const { projectId, ID_RE } = await import('../tools/setup-token.mjs');

// Warm the lazy adapter (and, through it, live-server) import while the config
// points at the VALID temp file. A later test aims the config at a malformed
// file on purpose, and live-server's module-load warning — which carries the
// config path — has no business in a test run.
await enumerateCandidates();
invalidateCandidates();

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CONFIG = join(REPO_ROOT, 'cspace.allowlist.json');
const hashOf = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null);
const REAL_CONFIG_BEFORE = hashOf(REAL_CONFIG);

/** Point the resolved allowlist at a fresh temp config for one test. */
function withConfig(json) {
  const p = join(TMP, `cfg-${randomBytes(4).toString('hex')}.json`);
  writeFileSync(p, typeof json === 'string' ? json : JSON.stringify(json, null, 2));
  process.env.CSPACE_ALLOWLIST = p;
  invalidateCandidates();
  return () => { process.env.CSPACE_ALLOWLIST = CONFIG; invalidateCandidates(); };
}

/** Build a fake ~/.claude/projects tree. `spec` is { dirName: sessionCount }. */
function claudeFixture(spec, { touch = {} } = {}) {
  const root = join(TMP, `store-${randomBytes(4).toString('hex')}`);
  mkdirSync(root, { recursive: true });
  for (const [name, n] of Object.entries(spec)) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i++) {
      const f = join(dir, `sess-${i}.jsonl`);
      writeFileSync(f, '{"type":"summary"}\n');
      const when = touch[name];
      if (when) utimesSync(f, new Date(when), new Date(when));
    }
  }
  return root;
}

const bySlug = (scan, slug) => scan.projects.find((p) => p.project === slug);

// ---------------------------------------------------------------------------
// (b) the Claude scan: worktree folding, and CLI parity on what is offered
// ---------------------------------------------------------------------------

test('claude scan folds worktree sessions into the parent slug', () => {
  const root = claudeFixture(
    { 'C--work-alpha': 3, 'C--work-alpha--claude-worktrees-feature': 2 },
    { touch: { 'C--work-alpha': '2024-01-01T00:00:00Z', 'C--work-alpha--claude-worktrees-feature': '2025-06-01T00:00:00Z' } },
  );
  const scan = _internal.scanClaudeStore(root);

  assert.equal(scan.storePresent, true);
  // One candidate, not two: the worktree is never offered as its own project.
  assert.deepEqual(scan.projects.map((p) => p.project), ['C--work-alpha']);
  assert.equal(bySlug(scan, 'C--work-alpha').sessions, 5, 'worktree sessions fold into the parent count');
  assert.equal(scan.sessionsTotal, 5);
  // The newest mtime anywhere under the slug wins, including from the worktree.
  assert.equal(bySlug(scan, 'C--work-alpha').lastActiveAt, Date.parse('2025-06-01T00:00:00Z'));
  assert.equal(bySlug(scan, 'C--work-alpha').onThisMachine, true);
});

test('claude scan omits empty dirs, non-dirs, and parentless worktrees', () => {
  const root = claudeFixture({
    'C--work-alpha': 2,
    'C--work-empty': 0,                              // no transcripts -> omitted
    'C--work-orphan--claude-worktrees-x': 4,         // no parent dir -> offered by neither CLI nor panel
  });
  writeFileSync(join(root, 'stray.txt'), 'not a project');

  const scan = _internal.scanClaudeStore(root);
  assert.deepEqual(scan.projects.map((p) => p.project), ['C--work-alpha']);
  assert.equal(scan.sessionsTotal, 2, 'a parentless worktree contributes nothing');
});

test('claude scan sorts busiest first and counts only top-level .jsonl', () => {
  const root = claudeFixture({ 'C--a': 1, 'C--b': 5, 'C--c': 3 });
  // A nested subagent tree must not inflate the project's session count.
  mkdirSync(join(root, 'C--a', 'sess-0', 'subagents'), { recursive: true });
  writeFileSync(join(root, 'C--a', 'sess-0', 'subagents', 'agent-1.jsonl'), '{}\n');

  const scan = _internal.scanClaudeStore(root);
  assert.deepEqual(scan.projects.map((p) => p.project), ['C--b', 'C--c', 'C--a']);
  assert.equal(bySlug(scan, 'C--a').sessions, 1);
});

test('claude scan emits labels and counts only — no path ever leaves it', () => {
  const root = claudeFixture({ 'C--work-alpha': 1 });
  const json = JSON.stringify(_internal.scanClaudeStore(root));
  assert.equal(json.includes(root.split('\\').join('\\\\')), false);
  assert.equal(json.includes('.jsonl'), false, 'no file name is ever emitted');
  const keys = Object.keys(_internal.scanClaudeStore(root).projects[0]).sort();
  assert.deepEqual(keys, ['lastActiveAt', 'onThisMachine', 'project', 'sessions']);
});

// ---------------------------------------------------------------------------
// (d) stores that are missing, or exist but cannot be read
// ---------------------------------------------------------------------------

test('a missing claude store degrades to absent, never throws', () => {
  const scan = _internal.scanClaudeStore(join(TMP, 'definitely-not-here'));
  assert.deepEqual(scan, { storePresent: false, sessionsTotal: 0, projects: [] });
});

test('a claude store that exists but cannot be read degrades to absent', () => {
  // A file where a directory is expected: exists on disk, readdir fails (ENOTDIR).
  const notADir = join(TMP, 'store-is-a-file');
  writeFileSync(notADir, 'x');
  assert.equal(existsSync(notADir), true, 'the store path exists');
  const scan = _internal.scanClaudeStore(notADir);
  assert.deepEqual(scan, { storePresent: false, sessionsTotal: 0, projects: [] },
    'unreadable is treated as absent, exactly as adapters/index.mjs storesPresent() does');
});

test('an unreadable project directory is skipped, not fatal', () => {
  assert.deepEqual(_internal.countTranscripts(join(TMP, 'no-such-project-dir')),
    { sessions: 0, lastActiveAt: null });
});

test('a config that exists but cannot be parsed yields no stale rows and no throw', async () => {
  const restore = withConfig('{ this is not json ');
  try {
    const out = await enumerateCandidates();
    assert.ok(Array.isArray(out.sources));
    for (const s of out.sources) {
      assert.equal(s.projects.some((p) => p.onThisMachine === false), false,
        'an unreadable config configures nothing');
    }
  } finally { restore(); }
});

test('a config path that cannot be opened at all yields no throw', async () => {
  const asDir = join(TMP, 'config-as-a-directory');
  mkdirSync(asDir, { recursive: true });
  const prev = process.env.CSPACE_ALLOWLIST;
  process.env.CSPACE_ALLOWLIST = asDir;
  invalidateCandidates();
  try {
    const out = await enumerateCandidates();
    assert.ok(Array.isArray(out.sources));
  } finally {
    process.env.CSPACE_ALLOWLIST = prev;
    invalidateCandidates();
  }
});

// ---------------------------------------------------------------------------
// (c) stale entries — configured, not on this machine, still deniable
// ---------------------------------------------------------------------------

test('staleEntries: unknown entries only, deduped, "*" skipped', () => {
  const cfg = {
    claude: ['on-disk', 'gone-a', 'gone-a', '*', '', 'gone-b'],
    sources: { codex: ['here', 'vanished', '*'] },
  };
  const claudeStale = _internal.staleEntries(cfg, 'claude', new Set(['on-disk']));
  assert.deepEqual(claudeStale.map((p) => p.project), ['gone-a', 'gone-b']);
  for (const row of claudeStale) {
    assert.equal(row.sessions, 0);
    assert.equal(row.onThisMachine, false);
    assert.equal(row.lastActiveAt, null);
  }
  assert.deepEqual(
    _internal.staleEntries(cfg, 'codex', new Set(['here'])).map((p) => p.project),
    ['vanished'],
    'a "*" is not a project and is never offered as a row',
  );
  assert.deepEqual(_internal.staleEntries(cfg, 'hermes', new Set()), []);
});

test('enumerateCandidates surfaces configured-but-absent projects so they can be denied', async () => {
  const ghostClaude = `zz-not-a-real-project-${randomBytes(4).toString('hex')}`;
  const ghostCodex = `zz-not-a-real-codex-${randomBytes(4).toString('hex')}`;
  const restore = withConfig({ allow: [ghostClaude], sources: { codex: [ghostCodex] } });
  try {
    const out = await enumerateCandidates();
    const claude = out.sources.find((s) => s.id === 'claude');
    assert.ok(claude, 'the claude source is always reported, present or not');
    const row = claude.projects.find((p) => p.project === ghostClaude);
    assert.ok(row, 'a configured project that is not on disk is still emitted');
    assert.equal(row.sessions, 0);
    assert.equal(row.onThisMachine, false);
    // It gets an id from the same digest space, which is what makes deny work.
    assert.match(projectId('claude', row.project), ID_RE);

    const codex = out.sources.find((s) => s.id === 'codex');
    assert.ok(codex, 'a source named by the config is reported even with no store');
    assert.ok(codex.projects.some((p) => p.project === ghostCodex && p.onThisMachine === false));
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// grouping for the non-Claude sources
// ---------------------------------------------------------------------------

test('groupRows groups by project, preserves the null bucket, keeps the newest mtime', () => {
  const rows = [
    { project: 'alpha', mtime: 10 }, { project: 'alpha', mtime: 90 },
    { project: null, mtime: 50 }, { project: '', mtime: 70 }, { project: undefined, mtime: 5 },
    { project: 'beta', mtime: 'nonsense' },
  ];
  const grouped = _internal.groupRows(rows);
  const alpha = grouped.find((p) => p.project === 'alpha');
  const unlabelled = grouped.find((p) => p.project === null);

  assert.equal(alpha.sessions, 2);
  assert.equal(alpha.lastActiveAt, 90);
  assert.equal(unlabelled.sessions, 3, 'null, "" and undefined all fall into the one unlabelled bucket');
  assert.equal(unlabelled.lastActiveAt, 70);
  assert.equal(grouped.find((p) => p.project === 'beta').lastActiveAt, null, 'a bad mtime is dropped, not NaN');
  assert.deepEqual(_internal.groupRows(undefined), []);
});

// ---------------------------------------------------------------------------
// (a) the id space: no reverse map, no path from request bytes to the disk
// ---------------------------------------------------------------------------

test('the public API takes no arguments and exposes no id or path verb', () => {
  const mod = { enumerateCandidates, invalidateCandidates };
  for (const [name, fn] of Object.entries(mod)) {
    assert.equal(fn.length, 0, `${name}() must take no arguments — nothing to thread a request field into`);
  }
  // Anything that could accept a caller-supplied location lives behind the
  // tests-only seam, and the public entry points do not route to it.
  assert.equal(typeof _internal.scanClaudeStore, 'function');
  assert.equal(enumerateCandidates.toString().includes('_internal'), false);
});

test('an id the current scan did not produce resolves to nothing', async () => {
  invalidateCandidates();
  const out = await enumerateCandidates();

  // Rebuild the map exactly as setup-server.mjs does: digest each (source,
  // project) pair the server itself just found. Resolution is Map.get; there is
  // no decode, so nothing a client sends can name a file.
  const byId = new Map();
  for (const s of out.sources) {
    for (const p of s.projects) {
      const id = projectId(s.id, p.project);
      assert.match(id, ID_RE);
      assert.equal(byId.has(id), false, 'two enumerated pairs must never digest to one id');
      byId.set(id, { source: s.id, project: p.project });
    }
  }

  // 1. traversal strings are just strings — they name no project, so no id.
  for (const attempt of ['../../etc/passwd', '..\\..\\Windows\\System32', '/etc/shadow',
    join(homedir(), '.claude', 'projects'), 'C:\\Users', '*']) {
    assert.equal(byId.has(projectId('claude', attempt)), false, `traversal candidate resolved: ${attempt}`);
    assert.equal(byId.has(projectId('codex', attempt)), false);
  }

  // 2. an id minted by a DIFFERENT process (a different salt) is unknown here.
  const otherSalt = randomBytes(32);
  const foreign = 'p_' + createHmac('sha256', otherSalt)
    .update('claude\u001fanything', 'utf8').digest('base64url').slice(0, 22);
  assert.match(foreign, ID_RE);
  assert.equal(byId.has(foreign), false, 'an id from a previous process must resolve to nothing');

  // 3. a well-formed but invented id is unknown.
  const invented = 'p_' + randomBytes(24).toString('base64url').slice(0, 22);
  assert.equal(byId.has(invented), false);
});

test('the emitted shape is exactly the contract §3.3 shape', async () => {
  invalidateCandidates();
  const out = await enumerateCandidates();
  assert.deepEqual(Object.keys(out), ['sources']);

  const KNOWN = new Set(['claude', 'codex', 'hermes', 'openclaw']);
  assert.ok(out.sources.some((s) => s.id === 'claude'));
  for (const s of out.sources) {
    assert.deepEqual(Object.keys(s).sort(),
      ['id', 'label', 'projects', 'sessionsTotal', 'storePresent'].sort());
    assert.ok(KNOWN.has(s.id));
    assert.equal(typeof s.label, 'string');
    assert.equal(typeof s.storePresent, 'boolean');
    assert.equal(Number.isInteger(s.sessionsTotal), true);
    assert.equal(s.sessionsTotal >= 0, true);
    if (!s.storePresent) {
      assert.equal(s.projects.every((p) => p.onThisMachine === false), true,
        'an absent store can only contribute stale rows');
    }
    for (const p of s.projects) {
      assert.deepEqual(Object.keys(p).sort(), ['lastActiveAt', 'onThisMachine', 'project', 'sessions']);
      assert.ok(p.project === null || (typeof p.project === 'string' && p.project.length > 0));
      assert.equal(Number.isInteger(p.sessions), true);
      assert.ok(p.lastActiveAt === null || typeof p.lastActiveAt === 'number');
      assert.equal(typeof p.onThisMachine, 'boolean');
    }
  }
});

// ---------------------------------------------------------------------------
// caching, invalidation, and the standing fences
// ---------------------------------------------------------------------------

test('the result is cached in-process and dropped by invalidateCandidates()', async () => {
  invalidateCandidates();
  const a = await enumerateCandidates();
  const b = await enumerateCandidates();
  assert.equal(a, b, 'a poll inside the 5s window must not re-walk the stores');
  assert.equal(Object.isFrozen(a), true, 'the shared value is frozen — a consumer cannot corrupt the next read');
  assert.equal(Object.isFrozen(a.sources), true);

  invalidateCandidates();
  const c = await enumerateCandidates();
  assert.notEqual(a, c, 'a mutation must be able to force a fresh scan');
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(c)));
  assert.equal(_internal.CACHE_MS, 5_000);
});

test('concurrent callers share one scan', async () => {
  invalidateCandidates();
  const [a, b, c] = await Promise.all([
    enumerateCandidates(), enumerateCandidates(), enumerateCandidates(),
  ]);
  assert.equal(a, b);
  assert.equal(b, c);
});

test('enumeration prints nothing at all (F6: not even counts)', async () => {
  await enumerateCandidates();          // warm the lazy adapter/live-server import first
  const lines = [];
  const real = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(real)) console[k] = (...a) => lines.push(a.join(' '));
  try {
    invalidateCandidates();
    await enumerateCandidates();
  } finally {
    for (const k of Object.keys(real)) console[k] = real[k];
  }
  assert.deepEqual(lines, [], 'a project label in a log line is exactly what the allowlist exists to prevent');
});

test('enumeration is read-only: neither the redirected nor the real config is touched', async () => {
  const before = hashOf(process.env.CSPACE_ALLOWLIST);
  invalidateCandidates();
  await enumerateCandidates();
  assert.equal(hashOf(process.env.CSPACE_ALLOWLIST), before);
  assert.equal(hashOf(REAL_CONFIG), REAL_CONFIG_BEFORE, 'the real cspace.allowlist.json must be untouched');
});

test('the real Claude store, when present, enumerates without naming anything', { skip: !existsSync(join(homedir(), '.claude', 'projects')) && 'no ~/.claude/projects on this machine' }, async () => {
  invalidateCandidates();
  const out = await enumerateCandidates();
  const claude = out.sources.find((s) => s.id === 'claude');
  assert.equal(claude.storePresent, true);
  // Counts only in the assertion message — never a label (F6).
  assert.equal(claude.sessionsTotal, claude.projects.reduce((n, p) => n + p.sessions, 0),
    `sessionsTotal must equal the sum over ${claude.projects.length} project(s)`);
  assert.equal(claude.projects.every((p) => p.sessions >= 0), true);
});
