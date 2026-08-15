// allowlist-store.mjs — the ONLY writer for cspace.allowlist.json.
//
// Until this round the server was read-only with respect to its own
// configuration: the page could ask for data, it could not change what data
// exists. The allowlist is the single thing that makes a session visible, and
// session transcripts are sensitive, so the write verb this module provides is
// deliberately small and deliberately dumb:
//
//   allow(source, project)   add ONE (source, project) pair to the curation
//   deny (source, project)   remove ONE (source, project) pair from it
//
// That is the whole vocabulary. There is NO path argument anywhere in this
// module's public surface, no "set this key", no "replace the config", no
// "allow everything". The file that gets written is resolved from the process
// environment (CSPACE_ALLOWLIST) or the repo root — never from an argument —
// so a caller (including an HTTP handler forwarding operator input) cannot
// steer the write at another file. Traversal is not validated against here; it
// is unrepresentable.
//
// FIVE PROPERTIES THIS MODULE OWES ITS CALLERS
//
//  1. RESOLUTION MATCHES loadAllowlist() EXACTLY. CSPACE_ALLOWLIST, when set,
//     is AUTHORITATIVE — not a first candidate. Writing to the repo file while
//     the server reads the env path (or vice versa) would silently expose the
//     wrong set of projects, which is a privacy bug, not a papercut.
//
//  2. THE OPERATOR'S FILE IS PRESERVED, NOT REGENERATED. The shipped example is
//     heavily commented ("_comment*" keys, blank-line grouping, deliberate
//     ordering). A JSON.parse → JSON.stringify round-trip would flatten all of
//     that. So edits are SURGICAL TEXT SPLICES: the file is scanned for the
//     span of the one array being touched, and exactly one element is inserted
//     or removed. Every other byte of the file survives verbatim.
//
//  3. ATOMIC. Temp file in the same directory, fsync, rename over the target.
//     An interrupted write can never leave a truncated allowlist — which would
//     read as "expose nothing" at best and as a destroyed curation at worst.
//
//  4. NO BLIND CLOBBER. The file is re-read immediately before the rename and
//     the write is refused if it changed since this call read it (a hand edit
//     mid-session is not silently overwritten). Callers holding an older read
//     can pass `expect` to extend that check across their own read-modify-write.
//     A file that exists but does not parse is never overwritten at all.
//
//  5. DEFAULT DENY ON CREATE. Creating the file from nothing produces a valid,
//     commented config with an empty "allow" and an empty "sources" — the same
//     safe posture as having no file, but now editable from the panel.
//
// F6 (never print project names): this module logs NOTHING, ever, and the
// result object it returns carries counts only — no labels, no slugs, no paths
// beyond the resolved config path the caller already knows.

import {
  existsSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync,
  renameSync, unlinkSync, chmodSync,
} from 'node:fs';
import { join, dirname, basename, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';

// Mirror of live-server.mjs's KNOWN_SOURCES. Duplicated rather than imported on
// purpose: importing live-server.mjs runs its module-scope loadAllowlist() (and
// its console output) as a side effect of loading a *writer*. tests/allowlist-
// store.test.mjs asserts the two lists have not drifted apart.
export const KNOWN_SOURCES = ['claude', 'codex', 'hermes', 'openclaw'];
const SOURCE_PREFIX = new RegExp(`^(${KNOWN_SOURCES.join('|')}):(.+)$`);

export const ALLOWLIST_FILENAME = 'cspace.allowlist.json';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Errors carry a stable `.code` so an HTTP layer can map them without parsing
 *  message text — and so no message ever has to contain a project label. */
export class AllowlistError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AllowlistError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new AllowlistError(code, message); };

// ---------------------------------------------------------------------------
// path resolution — identical rule to live-server.mjs loadAllowlist()
// ---------------------------------------------------------------------------

/**
 * The one file this module will ever write.
 * CSPACE_ALLOWLIST when set (and non-blank) is authoritative; otherwise the
 * repo-root config. No argument, no override, no second candidate: a divergence
 * from loadAllowlist()'s rule would mean writing curation the reader never
 * consults, or worse, exposing the repo file's projects on a box whose operator
 * had redirected the allowlist away.
 *
 * NORMALIZED, and that is a privacy fix rather than tidiness. The env value is
 * whatever the operator typed, and on Windows a forward-slash spelling
 * ("C:/Users/<name>/cspace.allowlist.json") is perfectly valid — but it does not
 * match `homedir() + sep`, so the setup state's collapseHome() would fail to
 * fold it and the panel footer would render the FULL ABSOLUTE PATH, OS username
 * included, into every screenshot. normalize() is purely lexical (same file, same
 * resolution semantics as loadAllowlist()'s verbatim use of the same string), so
 * it costs nothing and makes the home-collapse work on the platform where the
 * mismatch actually happens.
 */
export function resolveAllowlistPath() {
  const envPath = process.env.CSPACE_ALLOWLIST?.trim();
  return envPath ? normalize(envPath) : join(REPO_ROOT, ALLOWLIST_FILENAME);
}

// ---------------------------------------------------------------------------
// the BOM wedge
// ---------------------------------------------------------------------------
// PowerShell 5.1's Out-File and Notepad both write a UTF-8 BOM BY DEFAULT, and
// this project's primary platform is Windows — so "edit the allowlist by hand"
// routinely produces a file whose first three bytes are EF BB BF. JSON.parse
// rejects that, which means the reader exposes nothing (correct, fail-closed)
// AND the writer refuses with `invalid-config` (fail-closed, but it leaves the
// operator in a state where the panel cannot repair its own config, from inside
// the panel, on the one platform where the mistake is the default).
//
// So: strip a single leading BOM on every read. It is not data — U+FEFF is a
// byte-order mark, and JSON has no use for one — and dropping it changes no
// entry, no ordering and no comment. The write path deliberately treats a
// BOM-carrying file as "differs from what we would write", so the first
// successful mutation HEALS the file for every other reader too, including
// live-server.mjs's loadAllowlist(), which parses the bytes directly.
const stripBom = (text) => (typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

// ---------------------------------------------------------------------------
// normalization — behavioural mirror of live-server.mjs normalizeAllowlist()
// ---------------------------------------------------------------------------

/**
 * Reduce a parsed config to { claude: string[], sources: { id: string[] } }.
 * Kept byte-for-byte equivalent in behaviour to live-server.mjs's private
 * normalizeAllowlist(), minus its console.warn: this module only ever uses the
 * result to answer "is this pair already exposed?", and answering that
 * differently from the reader is exactly the privacy bug to avoid.
 * Returns a config even when the file opted nothing in (the reader's `null`
 * "saw nothing" case is not interesting to a writer).
 */
export function normalizeConfig(j) {
  const cfg = { claude: [], sources: Object.create(null) };

  const arr = Array.isArray(j) ? j : j?.allow;
  if (Array.isArray(arr)) {
    for (const raw of arr) {
      if (typeof raw !== 'string' || !raw) continue;
      const m = SOURCE_PREFIX.exec(raw);
      if (!m) { cfg.claude.push(raw); continue; }
      const [, id, project] = m;
      if (id === 'claude') cfg.claude.push(project);
      else (cfg.sources[id] ??= []).push(project);
    }
  }

  const map = !Array.isArray(j) && j && typeof j.sources === 'object' && j.sources ? j.sources : null;
  if (map) {
    for (const [id, val] of Object.entries(map)) {
      if (id.startsWith('_')) continue;
      if (!KNOWN_SOURCES.includes(id)) continue;
      const list = val === true || val === '*'
        ? ['*']
        : Array.isArray(val) ? val.filter((s) => typeof s === 'string' && s) : [];
      if (id === 'claude') { cfg.claude.push(...list); continue; }
      cfg.sources[id] = [...(cfg.sources[id] ?? []), ...list];
    }
  }
  return cfg;
}

const listFor = (cfg, source) => (source === 'claude' ? cfg.claude : cfg.sources[source] ?? []);

/**
 * Would the reader expose this pair with this config? Mirrors
 * live-server.mjs sessionAllowed() — including the fact that Claude matching is
 * exact-or-worktree-prefix and has NO "*" semantics, while the other sources
 * match exactly or via "*".
 */
export function isExposed(cfg, source, project) {
  if (source === 'claude') {
    return cfg.claude.some((a) => project === a || project.startsWith(a + '--claude-worktrees'));
  }
  const list = listFor(cfg, source);
  if (!list.length) return false;
  if (list.includes('*')) return true;
  return list.includes(project);
}

/** Is this source exposed wholesale by a "*" entry? Claude has no wildcard
 *  semantics in the reader, so a literal "*" there matches no project and is
 *  reported as no wildcard — matching what the reader actually does. */
export function wildcardInEffect(cfg, source) {
  return source !== 'claude' && listFor(cfg, source).includes('*');
}

/**
 * Would a `deny` of this pair leave it exposed anyway?
 *
 * `deny` removes EXACT entries — its own list, plus the "source:project"
 * shorthand. The reader, however, matches more broadly than that: a Claude entry
 * also covers `"<slug>--claude-worktrees…"`, and a non-Claude `"*"` covers
 * everything. So a project can be exposed by an entry that is not its own name,
 * and removing its own name (which may not even be there) changes nothing.
 *
 * That is the one failure mode this control must never be silent about: `deny`
 * is the verb that WITHDRAWS exposure, and a 200 with `changed: 0` reads to the
 * operator as "the untick took effect". It did not. The caller turns a `true`
 * here into an explicit refusal, so the panel can say which entry is holding the
 * project open.
 *
 * Deliberately expressed as "simulate the removal, then re-ask the reader"
 * rather than as a hard-coded list of broadening rules: if isExposed() ever
 * learns a new one, this stays correct for free.
 */
export function coveredByBroaderEntry(cfg, source, project) {
  if (typeof project !== 'string' || !project) return false;
  if (!isExposed(cfg, source, project)) return false;      // not exposed ⇒ nothing to withdraw
  const without = (list) => list.filter((a) => a !== project);
  const next = source === 'claude'
    ? { claude: without(cfg.claude), sources: cfg.sources }
    : { claude: cfg.claude, sources: { ...cfg.sources, [source]: without(listFor(cfg, source)) } };
  return isExposed(next, source, project);
}

const countsOf = (cfg) => ({
  claude: cfg.claude.length,
  sources: Object.fromEntries(KNOWN_SOURCES.filter((s) => s !== 'claude')
    .map((s) => [s, (cfg.sources[s] ?? []).length])),
});

const wildcardsOf = (cfg) =>
  Object.fromEntries(KNOWN_SOURCES.map((s) => [s, wildcardInEffect(cfg, s)]));

// ---------------------------------------------------------------------------
// a position-tracking JSON scanner
// ---------------------------------------------------------------------------
// Only used AFTER JSON.parse() has proven the text well-formed, so it can be a
// straight-line reader rather than a validating parser. It exists for one
// reason: to hand back the exact [start, end) byte span of every array, object
// member and element, so an edit can be a splice instead of a re-serialization.

function scan(text) {
  let i = 0;
  const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  const ws = () => { while (i < text.length && isWs(text[i])) i++; };

  function str() {
    const start = i;
    i++;                                              // opening quote
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') { i += 2; continue; }
      i++;
      if (c === '"') break;
    }
    return { kind: 'string', start, end: i, value: JSON.parse(text.slice(start, i)) };
  }
  function primitive() {
    const start = i;
    while (i < text.length && !isWs(text[i]) && text[i] !== ',' && text[i] !== '}' && text[i] !== ']') i++;
    return { kind: 'primitive', start, end: i, value: JSON.parse(text.slice(start, i)) };
  }
  function array() {
    const start = i;
    i++;                                              // [
    const items = [];
    ws();
    if (text[i] === ']') { i++; return { kind: 'array', start, end: i, items }; }
    for (;;) {
      items.push(value());
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; break; }
      fail('invalid-config', 'unexpected token in array');
    }
    return { kind: 'array', start, end: i, items };
  }
  function object() {
    const start = i;
    i++;                                              // {
    const members = [];
    // DUPLICATE KEYS ARE REFUSED, and this is a privacy control, not pedantry.
    // JSON.parse keeps the LAST duplicate; this scanner (and memberOf) find the
    // FIRST. On a file like {"allow":["decoy"],"allow":["real-project"]} the two
    // views disagree, and the direction of the disagreement is unsafe: a deny
    // edits the array the reader ignores, reports success, and leaves the
    // project exposed. Refusing to write such a file keeps "what the writer
    // edits" and "what the reader obeys" provably the same document.
    const seen = new Set();
    ws();
    if (text[i] === '}') { i++; return { kind: 'object', start, end: i, members }; }
    for (;;) {
      ws();
      if (text[i] !== '"') fail('invalid-config', 'expected key');
      const k = str();
      if (seen.has(k.value)) fail('invalid-config', 'duplicate key in the config');
      seen.add(k.value);
      ws();
      if (text[i] !== ':') fail('invalid-config', 'expected colon');
      i++;
      const v = value();
      members.push({ key: k.value, keyStart: k.start, start: k.start, end: v.end, value: v });
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; break; }
      fail('invalid-config', 'unexpected token in object');
    }
    return { kind: 'object', start, end: i, members };
  }
  function value() {
    ws();
    const c = text[i];
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"') return str();
    return primitive();
  }

  const root = value();
  return root;
}

const memberOf = (obj, key) => obj.members.find((m) => m.key === key) ?? null;

// ---- splice helpers --------------------------------------------------------

function lineIndent(text, pos) {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  let i = lineStart;
  while (i < pos && (text[i] === ' ' || text[i] === '\t')) i++;
  return text.slice(lineStart, i);
}
function startsItsOwnLine(text, pos) {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*$/.test(text.slice(lineStart, pos));
}
/** The file's own indent unit, so an inserted block matches hand-written lines. */
function indentUnit(text) {
  const m = /\n([ \t]+)"/.exec(text);
  return m ? m[1] : '  ';
}

/**
 * Match the line endings the operator's file already uses.
 *
 * Every splice above emits '\n', which on a CRLF file (Notepad and PowerShell
 * both write one by default on Windows — the same reason a BOM is handled on
 * read) left the result MIXED: one lone LF line among CRLFs. It still parsed,
 * so nothing broke, but it dirties their file and shows up as a whole-file diff
 * in an editor that then "fixes" the endings. Decide from the ORIGINAL text and
 * normalise the whole result, so the file stays in whatever style it arrived.
 */
function matchEol(original, next) {
  // `original` is null when the config does not exist yet (create-from-nothing),
  // in which case there is no style to match and LF is the repo default.
  if (!original) return next.replace(/\r\n/g, '\n');
  const crlf = (original.match(/\r\n/g) ?? []).length;
  const lf = (original.match(/(^|[^\r])\n/g) ?? []).length;
  if (crlf === 0 || lf > crlf) return next.replace(/\r\n/g, '\n');
  return next.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

/** Append one string literal to an array, matching its existing layout. */
function insertIntoArray(text, arr, entry) {
  const lit = JSON.stringify(entry);
  if (arr.items.length) {
    const last = arr.items[arr.items.length - 1];
    const ins = startsItsOwnLine(text, last.start)
      ? `,\n${lineIndent(text, last.start)}${lit}`
      : `, ${lit}`;
    return text.slice(0, last.end) + ins + text.slice(last.end);
  }
  const base = lineIndent(text, arr.start);
  return text.slice(0, arr.start) + `[\n${base}${indentUnit(text)}${lit}\n${base}]` + text.slice(arr.end);
}

/**
 * Remove element `index`, taking the adjacent separator with it so the
 * surrounding formatting stays valid. Removing the LAST element leaves `[]` —
 * "configured, exposing nothing" — never a deleted key: an absent key means
 * something different from an empty list for non-Claude sources (the store is
 * not even opened), and silently changing one into the other would change what
 * happens to future sessions.
 */
function removeFromArray(text, arr, index) {
  const items = arr.items;
  if (items.length === 1) return text.slice(0, arr.start) + '[]' + text.slice(arr.end);
  if (index === 0) return text.slice(0, items[0].start) + text.slice(items[1].start);
  return text.slice(0, items[index - 1].end) + text.slice(items[index].end);
}

/** Insert `"key": <literal>` into an object, after `afterKey` when present. */
function insertMember(text, obj, key, literal, afterKey) {
  const lit = `${JSON.stringify(key)}: ${literal}`;
  if (!obj.members.length) {
    const base = lineIndent(text, obj.start);
    return text.slice(0, obj.start) + `{\n${base}${indentUnit(text)}${lit}\n${base}}` + text.slice(obj.end);
  }
  const anchor = (afterKey && memberOf(obj, afterKey)) || obj.members[obj.members.length - 1];
  const ins = startsItsOwnLine(text, anchor.start)
    ? `,\n${lineIndent(text, anchor.start)}${lit}`
    : `, ${lit}`;
  return text.slice(0, anchor.end) + ins + text.slice(anchor.end);
}

/** Replace one member's value with freshly serialized JSON, re-indented to sit
 *  at that member's depth. Used only for the CLI-owned "discovered" key. */
function replaceMemberValue(text, member, value) {
  const ind = lineIndent(text, member.start);
  const body = JSON.stringify(value, null, 2).split('\n').join('\n' + ind);
  return text.slice(0, member.value.start) + body + text.slice(member.value.end);
}

// ---------------------------------------------------------------------------
// the default file
// ---------------------------------------------------------------------------
// Created only when no config exists at the resolved path. DEFAULT DENY: an
// empty "allow" and an empty "sources" expose exactly nothing — the same
// posture as having no file at all — and the comments explain the format so the
// operator can hand-edit from here (including the "*" form the UI will never
// write for them).

export const DEFAULT_CONFIG_TEXT = `{
  "_comment": "C-Space project allowlist (local, gitignored) — created by the C-Space setup panel. This is a CURATED allowlist and it is the ONLY thing that makes a session visible: session transcripts are sensitive, so nothing is exposed until you opt it in, and with no cspace.allowlist.json present NO sessions are shown at all. Override the config path with the CSPACE_ALLOWLIST env var (when set it is authoritative — a missing or malformed file there means 'expose nothing', never a silent fall back). You can edit this file by hand at any time; the panel preserves your comments and ordering.",

  "_comment_allow": "\\"allow\\" lists Claude Code project-directory slugs from ~/.claude/projects — the munged directory names, where path separators became '-'. An entry also matches that project's git worktrees ('<slug>--claude-worktrees...').",
  "allow": [],

  "_comment_sources": "\\"sources\\" is OPTIONAL and covers the OTHER harnesses C-Space can read — 'codex' (~/.codex), 'hermes' (~/.hermes), 'openclaw' (~/.openclaw). SAFE DEFAULT: a source with no key here exposes NOTHING and its store is never even opened — having ~/.codex on the machine is not consent. Each value is a list of that source's project labels, matched exactly; [\\"*\\"] would expose every project of that source (hand-edit only — the setup panel never writes one), and an empty list means 'configured, exposing nothing'.",
  "sources": {},

  "_comment_after_editing": "After editing:  npm run build-library && npm run build && npm run start"
}
`;

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

const fingerprintOf = (text) => (text === null ? null : createHash('sha256').update(text, 'utf8').digest('hex'));

/**
 * Read the resolved config. Never throws on a missing or malformed file —
 * `valid` says which. `fingerprint` is a content digest a caller can hand back
 * as `expect` to make its own read-modify-write refuse a clobber.
 * Returns raw entries (labels) because the local CLI legitimately prints them;
 * the mutation result object deliberately does not.
 *
 * CALLER BEWARE: `text`, `json`, `entries` and `parseError` all carry operator
 * content — `parseError` is JSON.parse's message, which quotes the offending
 * part of the file. They are for the CLI and for building the panel's state
 * payload; none of them belongs in a console line (F6) or in an HTTP error
 * body (§4.2: error bodies never contain a label or a path).
 */
export function readAllowlist() {
  const path = resolveAllowlistPath();
  let text = null;
  try {
    // stripBom: a Windows hand-edit routinely arrives BOM-first (see above).
    // Everything downstream of here — parse, fingerprint, the `text` handed to
    // callers — works on the stripped form, so the BOM can never be the reason
    // the panel reports "invalid config".
    if (existsSync(path)) text = stripBom(readFileSync(path, 'utf8'));
  } catch { /* unreadable — treat as absent for reporting, writes will throw */ }
  if (text === null) {
    return { path, exists: false, valid: true, parseError: null, text: null, fingerprint: null,
      json: null, entries: { allow: [], sources: {} }, config: normalizeConfig(null) };
  }
  let json = null;
  let valid = true;
  let parseError = null;
  try { json = JSON.parse(text); } catch (e) { valid = false; parseError = e.message; }
  const rawAllow = Array.isArray(json) ? json : Array.isArray(json?.allow) ? json.allow : [];
  const rawSources = (!Array.isArray(json) && json && typeof json.sources === 'object' && json.sources) || {};
  return {
    path,
    exists: true,
    valid,
    parseError,
    text,
    fingerprint: fingerprintOf(text),
    json,
    entries: { allow: rawAllow.filter((s) => typeof s === 'string'), sources: rawSources },
    config: valid ? normalizeConfig(json) : normalizeConfig(null),
  };
}

// ---------------------------------------------------------------------------
// the bounded verbs
// ---------------------------------------------------------------------------

function checkOp(op) {
  if (!op || typeof op !== 'object') fail('bad-argument', 'op must be an object');
  if (op.verb !== 'allow' && op.verb !== 'deny') fail('bad-verb', 'verb must be allow or deny');
  if (!KNOWN_SOURCES.includes(op.source)) fail('bad-argument', 'unknown source');
  const p = op.project;
  if (typeof p !== 'string' || !p) fail('bad-argument', 'project must be a non-empty string');
  if (p.length > 512) fail('bad-argument', 'project is too long');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(p)) fail('bad-argument', 'project contains control characters');
  // F4: the file format still honours ["*"], the writer never produces one. A
  // single click must never be able to expose a whole store.
  if (p === '*') fail('wildcard-not-writable', 'the wildcard entry is hand-edit only');
  // A Claude slug that looks like the "source:project" shorthand would be read
  // back as a different source entirely. Refuse rather than write an entry that
  // means something other than what was asked for.
  if (op.source === 'claude' && SOURCE_PREFIX.test(p)) fail('bad-argument', 'ambiguous project name');
  return { verb: op.verb, source: op.source, project: p };
}

/** Ensure root.allow / root.sources[src] exists as an array; returns new text. */
function ensureTargetArray(text, source) {
  let out = text;
  if (source === 'claude') {
    const root = scan(out);
    const m = memberOf(root, 'allow');
    if (!m) return insertMember(out, root, 'allow', '[]', '_comment_allow');
    if (m.value.kind !== 'array') fail('invalid-config', '"allow" is not an array');
    return out;
  }
  let root = scan(out);
  let sm = memberOf(root, 'sources');
  if (!sm) {
    out = insertMember(out, root, 'sources', '{}', 'allow');
    root = scan(out);
    sm = memberOf(root, 'sources');
  }
  if (sm.value.kind !== 'object') fail('invalid-config', '"sources" is not an object');
  const em = memberOf(sm.value, source);
  if (!em) return insertMember(out, sm.value, source, '[]');
  if (em.value.kind !== 'array') {
    // `true` / "*" are legal wildcard spellings in the file; anything else is a
    // shape this writer will not guess at.
    if (em.value.kind === 'primitive' && em.value.value === true) fail('wildcard-in-effect', 'source is wildcarded');
    if (em.value.kind === 'string' && em.value.value === '*') fail('wildcard-in-effect', 'source is wildcarded');
    fail('invalid-config', 'source entry is not an array');
  }
  return out;
}

/** The array node this (source) writes into, after ensureTargetArray. */
function targetArray(text, source) {
  const root = scan(text);
  if (source === 'claude') return memberOf(root, 'allow').value;
  return memberOf(memberOf(root, 'sources').value, source).value;
}

function applyOne(text, op) {
  const cfg = normalizeConfig(JSON.parse(text));

  if (op.verb === 'allow') {
    if (isExposed(cfg, op.source, op.project)) return { text, changed: 0 };
    const withArray = ensureTargetArray(text, op.source);
    const arr = targetArray(withArray, op.source);
    if (arr.items.some((n) => n.kind === 'string' && n.value === op.project)) return { text, changed: 0 };
    return { text: insertIntoArray(withArray, arr, op.project), changed: 1 };
  }

  // deny — never rewrites a "*" into an enumerated list: that would silently
  // change what happens to FUTURE projects of that source. Hand-edit only.
  if (wildcardInEffect(cfg, op.source)) fail('wildcard-in-effect', 'source is exposed by a wildcard');

  // Remove the entry wherever it can legally live: its own list, and the
  // "source:project" shorthand in "allow".
  const shorthand = `${op.source}:${op.project}`;
  const targets = op.source === 'claude'
    ? [{ src: 'claude', entry: op.project }, { src: 'claude', entry: shorthand }, { src: '_sources_claude', entry: op.project }]
    : [{ src: op.source, entry: op.project }, { src: 'claude', entry: shorthand }];

  let out = text;
  let changed = 0;
  for (const t of targets) {
    for (;;) {
      const root = scan(out);
      let arr = null;
      if (t.src === 'claude') {
        const m = memberOf(root, 'allow');
        arr = m && m.value.kind === 'array' ? m.value : null;
      } else {
        const id = t.src === '_sources_claude' ? 'claude' : t.src;
        const sm = memberOf(root, 'sources');
        if (sm && sm.value.kind === 'object') {
          const em = memberOf(sm.value, id);
          arr = em && em.value.kind === 'array' ? em.value : null;
        }
      }
      if (!arr) break;
      const idx = arr.items.findIndex((n) => n.kind === 'string' && n.value === t.entry);
      if (idx < 0) break;
      out = removeFromArray(out, arr, idx);
      changed++;
    }
  }
  return { text: out, changed };
}

// ---------------------------------------------------------------------------
// atomic write
// ---------------------------------------------------------------------------

// Test seam only: a fault injected between "temp file written" and "rename",
// so the atomicity and clobber-refusal properties can be exercised for real
// rather than asserted by inspection. Never set outside tests.
let faultHook = null;

function atomicWrite(path, text, expectOnDisk) {
  const tmp = join(dirname(path), `${basename(path)}.tmp-${randomBytes(6).toString('hex')}`);
  let wrote = false;
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeFileSync(fd, text, 'utf8');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    wrote = true;
    try { chmodSync(tmp, 0o600); } catch { /* no-op on Windows */ }

    if (faultHook) faultHook(path, tmp);

    // Last look before committing: if the target changed since this call read
    // it, the operator (or another process) edited the curation underneath us.
    // Refuse rather than clobber — losing a hand edit here loses privacy intent.
    const now = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (now !== expectOnDisk) fail('changed-underneath', 'the allowlist changed during the write');

    renameSync(tmp, path);
    wrote = false;                                   // renamed away; nothing to clean
  } finally {
    if (wrote) { try { unlinkSync(tmp); } catch { /* best effort */ } }
  }
}

// ---------------------------------------------------------------------------
// the public write entry point
// ---------------------------------------------------------------------------

// One in-process mutex for every write. The read happens INSIDE the lock,
// immediately before the write, so two mutations queued back to back cannot
// build on a stale snapshot of each other.
let queue = Promise.resolve();
function withLock(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

/**
 * Apply a list of bounded ops as ONE atomic write.
 *
 * @param ops  [{ verb:'allow'|'deny', source, project }]
 * @param opts.expect      fingerprint from an earlier readAllowlist(); the write
 *                         is refused with `changed-underneath` if the file no
 *                         longer matches it.
 * @param opts.discovered  CLI ONLY (tools/allowlist-init.mjs). Refreshes the
 *                         purely documentary "discovered" key. The setup
 *                         endpoint never passes this; it has no effect on what
 *                         is exposed.
 * @returns { path, changed, created, migrated, counts, wildcards } — counts
 *          only. No labels, ever (F6).
 */
export async function applyAllowlistOps(ops, opts = {}) {
  // `async` so that argument rejections surface the same way write failures do —
  // one error channel for the caller, never a sync throw from an async API.
  if (!Array.isArray(ops)) fail('bad-argument', 'ops must be an array');
  const checked = ops.map(checkOp);
  const hasExpect = Object.prototype.hasOwnProperty.call(opts, 'expect');
  const discovered = opts.discovered;
  if (discovered !== undefined
      && (!Array.isArray(discovered) || discovered.some((s) => typeof s !== 'string'))) {
    fail('bad-argument', 'discovered must be a string array');
  }

  return withLock(() => {
    const path = resolveAllowlistPath();
    // TWO views of the file, on purpose:
    //   `raw`    the exact bytes on disk — the clobber baseline handed to
    //            atomicWrite, so a concurrent hand edit is still detected
    //            byte-for-byte;
    //   `onDisk` the same text with a leading BOM stripped — what is parsed,
    //            spliced and fingerprinted.
    // Because the comparison at the end is `text !== raw`, a BOM-carrying file
    // is by construction "not what we would write" and gets rewritten without
    // the BOM on the first mutation. That is the repair: after it, every other
    // reader (live-server.mjs's loadAllowlist(), which parses the bytes
    // directly) can parse the operator's config again.
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const onDisk = stripBom(raw);
    if (hasExpect && fingerprintOf(onDisk) !== opts.expect) {
      fail('changed-underneath', 'the allowlist changed since it was read');
    }

    let created = false;
    let migrated = false;
    let text;

    if (onDisk === null) {
      created = true;
      text = DEFAULT_CONFIG_TEXT;
    } else {
      let parsed;
      try { parsed = JSON.parse(onDisk); } catch {
        // A file that exists but does not parse is the operator's, damaged or
        // mid-edit. Overwriting it would destroy curation we cannot read.
        fail('invalid-config', 'the existing allowlist is not valid JSON');
      }
      if (Array.isArray(parsed)) {
        // Legacy bare-array form. There are no comments to preserve in it, so a
        // clean re-serialization loses nothing; entries carry over verbatim.
        migrated = true;
        text = JSON.stringify({
          _comment: 'C-Space project allowlist (local, gitignored). Migrated from the legacy bare-array form by the C-Space setup panel. Only projects listed here are exposed.',
          allow: parsed.filter((s) => typeof s === 'string'),
          sources: {},
        }, null, 2) + '\n';
      } else if (parsed === null || typeof parsed !== 'object') {
        fail('invalid-config', 'the allowlist is not an object');
      } else {
        text = onDisk;
      }
    }

    let changed = 0;
    for (const op of checked) {
      const r = applyOne(text, op);
      text = r.text;
      changed += r.changed;
    }

    if (discovered !== undefined) {
      const root = scan(text);
      const m = memberOf(root, 'discovered');
      text = m
        ? replaceMemberValue(text, m, discovered)
        : insertMember(text, root, 'discovered', JSON.stringify(discovered, null, 2)
            .split('\n').join('\n' + indentUnit(text)));
    }

    // Leave the file in the line-ending style it arrived in — the splices above
    // all emit '\n', which would otherwise leave a CRLF file mixed.
    text = matchEol(raw, text);

    // Cheap self-check: never hand a file to disk that the reader cannot parse.
    try { JSON.parse(text); } catch { fail('internal', 'refusing to write malformed JSON'); }

    // Compared against `raw`, not `onDisk`: an unchanged-but-BOM-carrying file
    // still differs from what we would write, so it is healed rather than left
    // wedged. `raw` is also the expectation atomicWrite re-checks, so the
    // no-blind-clobber property is unaffected.
    if (text !== raw) atomicWrite(path, text, raw);

    const cfg = normalizeConfig(JSON.parse(text));
    return {
      path,
      changed,
      created,
      migrated,
      counts: countsOf(cfg),
      wildcards: wildcardsOf(cfg),
    };
  });
}

/** Expose one (source, project) pair. Idempotent; `changed: 0` when already exposed. */
export function allow(source, project, opts = {}) {
  return applyAllowlistOps([{ verb: 'allow', source, project }], opts);
}

/** Withdraw one (source, project) pair. Idempotent; throws `wildcard-in-effect`
 *  when the source is exposed by "*" (hand-edit only — see §4.5 of the contract). */
export function deny(source, project, opts = {}) {
  return applyAllowlistOps([{ verb: 'deny', source, project }], opts);
}

export const _internal = {
  scan, memberOf, insertIntoArray, removeFromArray, insertMember,
  atomicWrite, fingerprintOf, stripBom,
  /** tests only — inject a fault between temp-write and rename */
  setFaultHook(fn) { faultHook = fn; },
};
