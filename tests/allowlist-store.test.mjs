// allowlist-store.test.mjs — the ALLOWLIST WRITER (tools/allowlist-store.mjs).
//
// The allowlist is the only thing that makes a session visible, so this suite is
// less about "does the function work" and more about the four properties that
// make handing a write verb to a local HTTP surface defensible:
//
//   · PRESERVATION  — a hand-curated, heavily commented file survives an edit
//                     byte-for-byte apart from the one entry asked for
//                     (allow → deny is a byte-exact round trip);
//   · ATOMICITY     — an interrupted write cannot truncate the curation, and
//                     leaves no temp file behind;
//   · NO CLOBBER    — a file that changed underneath the writer, or that no
//                     longer parses, is refused rather than overwritten;
//   · DEFAULT DENY  — creating the file from nothing exposes nothing, and
//                     denying the last project leaves [] (configured, exposing
//                     nothing) rather than deleting the key.
//
// HERMETIC: every test points CSPACE_ALLOWLIST at a throwaway file under the OS
// temp dir. The repo's real cspace.allowlist.json is snapshotted at load and
// asserted untouched at the end — a test run must never curate the developer's
// own machine. Nothing here reads ~/.claude or any other harness store.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  KNOWN_SOURCES, ALLOWLIST_FILENAME, DEFAULT_CONFIG_TEXT, AllowlistError,
  resolveAllowlistPath, readAllowlist, applyAllowlistOps, allow, deny,
  normalizeConfig, isExposed, wildcardInEffect, _internal,
} from '../tools/allowlist-store.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CONFIG = join(REPO, ALLOWLIST_FILENAME);
const REAL_BEFORE = existsSync(REAL_CONFIG)
  ? { text: readFileSync(REAL_CONFIG, 'utf8'), mtime: statSync(REAL_CONFIG).mtimeMs }
  : null;

const EXAMPLE = readFileSync(join(REPO, 'cspace.allowlist.example.json'), 'utf8');

const tmpRoot = mkdtempSync(join(tmpdir(), 'cspace-allowlist-'));
let n = 0;

/** Point the writer at a fresh throwaway file; `seed` is its initial text (or
 *  null for "no config yet"). Returns { path, read(), dir }. */
function sandbox(seed = null) {
  const dir = join(tmpRoot, `case-${++n}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ALLOWLIST_FILENAME);
  if (seed !== null) writeFileSync(path, seed, 'utf8');
  process.env.CSPACE_ALLOWLIST = path;
  return { dir, path, read: () => readFileSync(path, 'utf8') };
}
const tmpFiles = (dir) => readdirSync(dir).filter((f) => f.includes('.tmp-'));
const codeOf = (fn) => fn.then(() => null, (e) => e.code);

// ---- resolution ------------------------------------------------------------

test('CSPACE_ALLOWLIST is authoritative when set, exactly as loadAllowlist() treats it', () => {
  delete process.env.CSPACE_ALLOWLIST;
  assert.equal(resolveAllowlistPath(), REAL_CONFIG);

  process.env.CSPACE_ALLOWLIST = join(tmpRoot, 'elsewhere.json');
  assert.equal(resolveAllowlistPath(), join(tmpRoot, 'elsewhere.json'));

  // blank/whitespace is "not set" — the same trim() rule the reader uses
  process.env.CSPACE_ALLOWLIST = '   ';
  assert.equal(resolveAllowlistPath(), REAL_CONFIG);
  delete process.env.CSPACE_ALLOWLIST;
});

test('KNOWN_SOURCES has not drifted from live-server.mjs', () => {
  const src = readFileSync(join(REPO, 'tools', 'live-server.mjs'), 'utf8');
  const line = /export const KNOWN_SOURCES\s*=\s*\[([^\]]*)\]/.exec(src);
  assert.ok(line, 'live-server.mjs still exports KNOWN_SOURCES as a literal array');
  const theirs = [...line[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(KNOWN_SOURCES, theirs);
});

// ---- creation is default-deny ---------------------------------------------

test('creating the file from nothing yields a valid, commented, default-deny config', async () => {
  const s = sandbox(null);
  const r = await applyAllowlistOps([]);

  assert.equal(r.created, true);
  assert.equal(r.changed, 0);
  const text = s.read();
  const json = JSON.parse(text);                       // valid JSON
  assert.ok(Object.keys(json).some((k) => k.startsWith('_comment')), 'ships its documentation');
  assert.deepEqual(json.allow, []);
  assert.deepEqual(json.sources, {});

  // and it exposes nothing, for every source, including unlabelled sessions
  const cfg = normalizeConfig(json);
  for (const src of KNOWN_SOURCES) {
    assert.equal(isExposed(cfg, src, 'anything'), false, `${src} exposes nothing`);
    assert.equal(wildcardInEffect(cfg, src), false, `${src} has no wildcard`);
  }
  assert.equal(r.counts.claude, 0);
});

test('the shipped default template is itself default-deny', () => {
  const cfg = normalizeConfig(JSON.parse(DEFAULT_CONFIG_TEXT));
  assert.deepEqual(cfg.claude, []);
  assert.deepEqual(Object.keys(cfg.sources), []);
});

// ---- preservation ----------------------------------------------------------

test('allowing a project preserves comments, key order and every other entry', async () => {
  const s = sandbox(EXAMPLE);
  const before = JSON.parse(EXAMPLE);

  const r = await allow('claude', 'C--Users-YOU-brand-new');
  assert.equal(r.changed, 1);

  const text = s.read();
  const after = JSON.parse(text);

  // every documentation key survives, verbatim and in place
  assert.deepEqual(Object.keys(after), Object.keys(before), 'key order unchanged');
  for (const k of Object.keys(before).filter((x) => x.startsWith('_comment'))) {
    assert.equal(after[k], before[k], `${k} preserved verbatim`);
  }
  // existing curation untouched, new entry appended
  assert.deepEqual(after.allow.slice(0, before.allow.length), before.allow);
  assert.deepEqual(after.allow.slice(-1), ['C--Users-YOU-brand-new']);
  assert.deepEqual(after.sources, before.sources, 'unrelated sources untouched');

  // The blank-line grouping of the hand-written file is still there. Compared
  // on NORMALISED text: git's core.autocrlf hands every Windows clone a CRLF
  // working tree, so asserting on a literal '\n' here fails for a reason that
  // has nothing to do with the writer. Endings have their own test below.
  const norm = (t) => t.replace(/\r\n/g, '\n');
  assert.ok(norm(text).includes('\n\n  "_comment_sources"'), 'blank-line layout preserved');
  assert.equal(norm(text).split('\n').length, norm(EXAMPLE).split('\n').length + 1,
    'exactly one line added');
});

test('the file keeps the line endings it arrived with (Windows writes CRLF)', async () => {
  // Notepad and PowerShell both write CRLF by default on the primary platform —
  // the same reason a BOM is stripped on read. Every splice in the writer emits
  // a bare LF, so without normalisation a CRLF config came back MIXED: one lone
  // LF line among CRLFs. It still parsed, which is why this went unnoticed for a
  // while — but it dirties the operator's hand-curated file and shows up as a
  // whole-file diff in any editor that then "helpfully" fixes the endings.
  const LF = EXAMPLE.replace(/\r\n/g, '\n');
  for (const [name, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    const s = sandbox(LF.replace(/\n/g, eol));

    const r = await allow('claude', 'C--Users-YOU-eol-probe');
    assert.equal(r.changed, 1, `${name}: the entry was written`);

    const out = s.read();
    assert.ok(JSON.parse(out), `${name}: still parses`);
    assert.ok(out.includes('C--Users-YOU-eol-probe'), `${name}: entry present`);

    const hasCrlf = /\r\n/.test(out);
    const hasBareLf = /(^|[^\r])\n/.test(out);
    assert.equal(hasCrlf && hasBareLf, false, `${name}: file came back with mixed endings`);
    assert.equal(hasCrlf, eol === '\r\n', `${name}: ending style preserved`);
  }
});

test('allow then deny is a byte-exact round trip', async () => {
  const s = sandbox(EXAMPLE);
  await allow('claude', 'C--Users-YOU-temporary');
  assert.notEqual(s.read(), EXAMPLE);
  await deny('claude', 'C--Users-YOU-temporary');
  assert.equal(s.read(), EXAMPLE, 'the file is byte-identical to how the operator wrote it');
});

test('a non-Claude source is created under "sources" without disturbing the file', async () => {
  const s = sandbox(EXAMPLE);
  const r = await allow('codex', 'the-dreaming');
  assert.equal(r.changed, 1);

  const after = JSON.parse(s.read());
  assert.deepEqual(after.sources.codex, ['the-dreaming']);
  assert.deepEqual(after.sources.hermes, []);
  assert.deepEqual(after.sources.openclaw, []);
  assert.deepEqual(after.allow, JSON.parse(EXAMPLE).allow, '"allow" untouched');
  assert.equal(after._comment_sources, JSON.parse(EXAMPLE)._comment_sources);

  await deny('codex', 'the-dreaming');
  assert.equal(s.read(), EXAMPLE);
});

test('"sources" is created when absent, after "allow", and the source key with it', async () => {
  const s = sandbox('{\n  "_comment": "mine",\n  "allow": ["a"]\n}\n');
  await allow('hermes', 'a session title');
  const after = JSON.parse(s.read());
  assert.deepEqual(Object.keys(after), ['_comment', 'allow', 'sources']);
  assert.deepEqual(after.sources, { hermes: ['a session title'] });
  assert.deepEqual(after.allow, ['a']);
});

test('inline array formatting is respected rather than reflowed', async () => {
  const s = sandbox('{ "allow": ["a", "b"] }');
  await allow('claude', 'c');
  assert.equal(s.read(), '{ "allow": ["a", "b", "c"] }');
});

test('a legacy bare-array config migrates to { allow } once, keeping its entries', async () => {
  const s = sandbox('["slug-a", "slug-b"]\n');
  const r = await allow('claude', 'slug-c');
  assert.equal(r.migrated, true);
  const after = JSON.parse(s.read());
  assert.deepEqual(after.allow, ['slug-a', 'slug-b', 'slug-c']);
  assert.deepEqual(after.sources, {});
  assert.ok(typeof after._comment === 'string');

  const r2 = await allow('claude', 'slug-d');
  assert.equal(r2.migrated, false, 'migration happens once');
});

// ---- idempotence and the shape of "off" ------------------------------------

test('allow is idempotent and does not rewrite the file', async () => {
  const s = sandbox(EXAMPLE);
  await allow('claude', 'C--Users-YOU-dup');
  const once = s.read();
  const r = await allow('claude', 'C--Users-YOU-dup');
  assert.equal(r.changed, 0);
  assert.equal(s.read(), once, 'no second entry, no rewrite');
});

test('a worktree child is already covered by its parent entry (reader semantics)', async () => {
  const s = sandbox('{ "allow": ["proj"] }');
  const r = await allow('claude', 'proj--claude-worktrees-feature');
  assert.equal(r.changed, 0, 'the reader already exposes it; do not add a redundant entry');
  assert.equal(s.read(), '{ "allow": ["proj"] }');
});

test('denying the last project leaves [] — configured, exposing nothing — not a deleted key', async () => {
  const s = sandbox('{\n  "_comment": "c",\n  "allow": [\n    "only-one"\n  ],\n  "sources": {\n    "codex": [\n      "solo"\n    ]\n  }\n}\n');

  await deny('claude', 'only-one');
  let after = JSON.parse(s.read());
  assert.ok('allow' in after, '"allow" key still present');
  assert.deepEqual(after.allow, []);

  await deny('codex', 'solo');
  after = JSON.parse(s.read());
  assert.ok('codex' in after.sources, 'the source key stays — absent means "never opened"');
  assert.deepEqual(after.sources.codex, []);
  assert.equal(after._comment, 'c');
});

test('deny also removes the "source:project" shorthand from "allow"', async () => {
  const s = sandbox('{ "allow": ["codex:the-dreaming", "keep-me"], "sources": { "codex": ["the-dreaming"] } }');
  const r = await deny('codex', 'the-dreaming');
  assert.ok(r.changed >= 2);
  const after = JSON.parse(s.read());
  assert.deepEqual(after.allow, ['keep-me']);
  assert.deepEqual(after.sources.codex, []);
  assert.equal(isExposed(normalizeConfig(after), 'codex', 'the-dreaming'), false);
});

test('deny of a wildcarded source is refused, never rewritten into a list', async () => {
  const seed = '{ "sources": { "codex": ["*"] } }';
  const s = sandbox(seed);
  assert.equal(await codeOf(deny('codex', 'anything')), 'wildcard-in-effect');
  assert.equal(s.read(), seed, 'the operator\'s wildcard is untouched');

  // allowing under a wildcard is a no-op: it is already exposed
  const r = await allow('codex', 'anything');
  assert.equal(r.changed, 0);
  assert.equal(s.read(), seed);
  assert.equal(r.wildcards.codex, true);
});

test('the "true" spelling of a wildcard is also refused', async () => {
  const seed = '{ "sources": { "hermes": true } }';
  const s = sandbox(seed);
  assert.equal(await codeOf(deny('hermes', 'x')), 'wildcard-in-effect');
  assert.equal(s.read(), seed);
});

// ---- bounded verbs ---------------------------------------------------------

test('the writer refuses to produce a "*" entry (F4 — no allow-all)', async () => {
  const s = sandbox('{ "allow": [] }');
  assert.equal(await codeOf(allow('claude', '*')), 'wildcard-not-writable');
  assert.equal(await codeOf(allow('codex', '*')), 'wildcard-not-writable');
  assert.equal(s.read(), '{ "allow": [] }');
});

test('only allow/deny, only known sources, only sane project strings', async () => {
  sandbox('{ "allow": [] }');
  assert.equal(await codeOf(applyAllowlistOps([{ verb: 'build', source: 'claude', project: 'x' }])), 'bad-verb');
  assert.equal(await codeOf(applyAllowlistOps([{ verb: 'allow', source: 'sources', project: 'x' }])), 'bad-argument');
  assert.equal(await codeOf(applyAllowlistOps([{ verb: 'allow', source: 'claude', project: '' }])), 'bad-argument');
  assert.equal(await codeOf(applyAllowlistOps([{ verb: 'allow', source: 'claude', project: 42 }])), 'bad-argument');
  assert.equal(await codeOf(applyAllowlistOps([{ verb: 'allow', source: 'claude', project: 'a'.repeat(513) }])), 'bad-argument');
  assert.equal(await codeOf(applyAllowlistOps([{ verb: 'allow', source: 'claude', project: 'a\u0000b' }])), 'bad-argument');
  // …but a label with spaces is legitimate — Hermes/OpenClaw labels are titles
  assert.equal(await codeOf(applyAllowlistOps([{ verb: 'allow', source: 'hermes', project: 'a real title' }])), null);
  // a Claude slug that reads back as another source's shorthand is refused
  assert.equal(await codeOf(applyAllowlistOps([{ verb: 'allow', source: 'claude', project: 'codex:x' }])), 'bad-argument');
  assert.equal(await codeOf(applyAllowlistOps('nope')), 'bad-argument');
});

test('a rejected op writes nothing at all — the batch is all or nothing', async () => {
  const seed = '{ "allow": ["kept"] }';
  const s = sandbox(seed);
  assert.equal(await codeOf(applyAllowlistOps([
    { verb: 'allow', source: 'claude', project: 'fine' },
    { verb: 'allow', source: 'claude', project: '*' },
  ])), 'wildcard-not-writable');
  assert.equal(s.read(), seed);
});

test('the result carries counts only — never a project label (F6)', async () => {
  sandbox('{ "allow": [] }');
  const r = await allow('claude', 'C--Users-secret-client-engagement');
  assert.ok(!JSON.stringify({ ...r, path: '' }).includes('secret-client'), 'no label in the result');
  assert.deepEqual(r.counts, { claude: 1, sources: { codex: 0, hermes: 0, openclaw: 0 } });
});

// ---- no clobber ------------------------------------------------------------

test('a config that exists but does not parse is never overwritten', async () => {
  const broken = '{ "allow": [ oops';
  const s = sandbox(broken);
  assert.equal(await codeOf(allow('claude', 'x')), 'invalid-config');
  assert.equal(s.read(), broken);
  const r = readAllowlist();
  assert.equal(r.valid, false);
  assert.ok(typeof r.parseError === 'string');
});

test('a stale `expect` fingerprint refuses the write', async () => {
  const s = sandbox('{ "allow": ["a"] }');
  const { fingerprint } = readAllowlist();

  writeFileSync(s.path, '{ "allow": ["a", "hand-edited"] }', 'utf8');   // operator edits mid-session
  const edited = s.read();

  assert.equal(await codeOf(applyAllowlistOps([{ verb: 'allow', source: 'claude', project: 'b' }],
    { expect: fingerprint })), 'changed-underneath');
  assert.equal(s.read(), edited, 'the hand edit survived');

  // a current fingerprint goes through
  const r = await applyAllowlistOps([{ verb: 'allow', source: 'claude', project: 'b' }],
    { expect: readAllowlist().fingerprint });
  assert.equal(r.changed, 1);
  assert.deepEqual(JSON.parse(s.read()).allow, ['a', 'hand-edited', 'b']);
});

test('a change landing DURING the write is caught before the rename', async () => {
  const s = sandbox('{ "allow": ["a"] }');
  const raced = '{ "allow": ["a", "landed-while-we-were-writing"] }';
  _internal.setFaultHook(() => { writeFileSync(s.path, raced, 'utf8'); });
  try {
    assert.equal(await codeOf(allow('claude', 'b')), 'changed-underneath');
  } finally { _internal.setFaultHook(null); }
  assert.equal(s.read(), raced, 'the racing write was not clobbered');
  assert.deepEqual(tmpFiles(s.dir), [], 'no temp file left behind');
});

// ---- atomicity -------------------------------------------------------------

test('an interrupted write leaves the original intact and no temp file behind', async () => {
  const seed = '{\n  "_comment": "hand curated",\n  "allow": [\n    "a",\n    "b"\n  ]\n}\n';
  const s = sandbox(seed);
  _internal.setFaultHook(() => { throw new Error('power cut'); });
  try {
    await assert.rejects(allow('claude', 'c'), /power cut/);
  } finally { _internal.setFaultHook(null); }

  assert.equal(s.read(), seed, 'the curation is neither truncated nor partially written');
  assert.deepEqual(tmpFiles(s.dir), [], 'no temp file left behind');

  // and the writer still works afterwards
  const r = await allow('claude', 'c');
  assert.equal(r.changed, 1);
  assert.deepEqual(JSON.parse(s.read()).allow, ['a', 'b', 'c']);
  assert.deepEqual(tmpFiles(s.dir), []);
});

test('the target is only ever replaced by a complete, parseable file', async () => {
  const s = sandbox(EXAMPLE);
  // 40 queued mutations; every intermediate state on disk must parse
  const ops = [];
  for (let i = 0; i < 20; i++) ops.push(allow('claude', `p-${i}`).then(() => JSON.parse(s.read())));
  await Promise.all(ops);
  const after = JSON.parse(s.read());
  assert.equal(after.allow.length, JSON.parse(EXAMPLE).allow.length + 20, 'every queued op landed exactly once');
  assert.deepEqual(tmpFiles(s.dir), []);
});

// ---- reading ---------------------------------------------------------------

test('readAllowlist reports an absent file as absent, never as a fallback to the repo config', () => {
  const dir = join(tmpRoot, 'absent');
  mkdirSync(dir, { recursive: true });
  process.env.CSPACE_ALLOWLIST = join(dir, ALLOWLIST_FILENAME);
  const r = readAllowlist();
  assert.equal(r.exists, false);
  assert.equal(r.fingerprint, null);
  assert.deepEqual(r.entries.allow, []);
  assert.deepEqual(r.config.claude, [], 'no silent fall back to the repo file');
});

test('AllowlistError is thrown with a stable code and a name-free message', async () => {
  sandbox('{ "allow": [] }');
  await allow('claude', 'x').catch(() => {});
  await assert.rejects(allow('claude', '*'), (e) => {
    assert.ok(e instanceof AllowlistError);
    assert.equal(e.code, 'wildcard-not-writable');
    assert.ok(!/[/\\]/.test(e.message), 'no path in the message');
    return true;
  });
});

// ---- the standing guarantee ------------------------------------------------

test('the developer\'s own cspace.allowlist.json was never touched', () => {
  delete process.env.CSPACE_ALLOWLIST;
  if (!REAL_BEFORE) {
    assert.equal(existsSync(REAL_CONFIG), false, 'no config was created in the repo');
    return;
  }
  assert.equal(readFileSync(REAL_CONFIG, 'utf8'), REAL_BEFORE.text);
  assert.equal(statSync(REAL_CONFIG).mtimeMs, REAL_BEFORE.mtime);
});

after(() => { try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });
