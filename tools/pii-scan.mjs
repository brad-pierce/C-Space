#!/usr/bin/env node
// pii-scan.mjs — the PRE-PUSH PII GATE.
//
// C-Space is a session visualizer, so its risk profile is unusual: the things
// that must never reach the public repo are not just credentials but the local
// harness's own vocabulary — the OS username, home paths, Claude project slugs
// (which are munged cwd paths: client names, internal codenames), the project
// labels Codex/Hermes/OpenClaw expose (which are cwd basenames and session
// TITLES), real session ids, and transcript content of any kind.
//
// THE CENTRAL CONSTRAINT: THIS FILE MUST NOT BECOME THE LEAK.
// A scanner that shipped with a hard-coded list of the operator's project names
// would put that list in the public repo — the exact disclosure it exists to
// prevent. So there is not one project name, username, hostname or session id
// anywhere in this source. The sensitive term set is DERIVED AT RUNTIME from the
// local machine:
//
//   · os.userInfo().username and os.homedir() (and its basename)
//   · os.hostname()
//   · the directory names under ~/.claude/projects
//   · the project labels the adapters expose, via tools/setup-discovery.mjs
//     enumerateCandidates() and tools/adapters/index.mjs discoverAll()
//   · the real local session ids (so a fabricated demo id never trips the gate,
//     and a real one always does)
//
// Those terms live in memory for the duration of one run. They are NEVER written
// to disk and the full inventory is NEVER printed — the report quotes the
// MATCHED SPAN and file:line, which is the minimum needed to go fix it. `--json`
// reports `termCount`, a number, and nothing else about the inventory.
//
// Alongside the derived terms, a set of MACHINE-INDEPENDENT patterns runs that
// needs no local knowledge at all: emails, private-key headers, common API-key
// and token shapes, bearer strings, JWTs, private/LAN IPv4, MAC addresses, and
// absolute user-home paths in all three shapes that occur on a Windows box
// (native, forward-slashed, and MSYS/Git-Bash).
//
// BINARIES ARE NOT SCANNED, AND ARE NOT PASSED. A text scan that reports
// "clean" over a repo containing a demo video is a false all-clear: a screen
// recording of the visualizer can show real session titles in the HUD, and an
// image can show a path in a ticker line. Binaries are reported under REVIEW
// REQUIRED until they are explicitly acknowledged in the allow-list file, and
// the summary never says "clean" while any remain unacknowledged.
//
// READ-ONLY. This tool opens files and never writes one. It does not touch
// ~/.claude, ~/.codex, ~/.hermes or ~/.openclaw beyond readdir/stat and the
// read-only enumeration the setup panel already performs.
//
// -----------------------------------------------------------------------------
// USAGE
//
//   npm run pii                      scan tracked files (paths from `git ls-files`,
//                                    content from the WORKING TREE — so an edit you
//                                    have not committed yet is still caught)
//   npm run pii -- --worktree        also scan untracked, non-ignored files
//   npm run pii -- --history         scan EVERY BLOB IN EVERY COMMIT (what is
//                                    already published, including deleted files)
//   npm run pii -- --json            machine-readable report on stdout
//   npm run pii -- --allow <file>    allow-list path (default: .pii-allow.json)
//   npm run pii -- --fail-on-review  also exit non-zero when a binary is
//                                    unacknowledged (use this in a hook)
//   npm run pii -- --help
//
// EXIT CODES:  0 = no findings   1 = findings   2 = the scan itself failed
//
// THE ALLOW-LIST FILE (default `.pii-allow.json` at the repo root, optional).
// It records identifiers the operator has decided are fine in public, so the
// gate stops re-reporting them. It is a normal JSON file and it IS safe to
// commit — but only put things in it you are content to publish, because
// committing it publishes them.
//
//   {
//     "_comment": "Identifiers accepted as public. See tools/pii-scan.mjs.",
//     "terms":    ["<your-public-email>", "<your-git-forge-handle>"],
//     "patterns": ["^https://example\\.invalid/"],
//     "files":    ["path/prefix/to/skip"],
//     "reviewed": ["docs/video/some-demo.mp4"]
//   }
//
//   terms     exact, case-insensitive. A match is suppressed when the matched
//             span OR the whole token surrounding it equals an entry — so
//             allow-listing your public email address suppresses the
//             username-fragment hit inside it without disabling the username
//             rule everywhere else.
//             (Note the placeholders above are written in angle brackets on
//             purpose: a real-looking address in this file would be a finding
//             the moment the scanner is pointed at itself.)
//   patterns  JavaScript regex sources, tested against the matched span. Use
//             sparingly: a loose pattern here is a hole in the gate.
//   files     path prefixes skipped entirely. Blunt instrument; prefer `terms`.
//   reviewed  binaries a human has actually looked at. They move out of REVIEW
//             REQUIRED and stop blocking a true "clean".
//
// DO NOT redirect this report into a file inside the repo. It quotes the PII it
// found; that is the point of it, and it is why the output belongs on a terminal.
//
// ONE EXPECTED EXCEPTION. tests/pii-scan.test.mjs is deliberately full of things
// SHAPED like credentials, emails, LAN IPs, MACs and home paths — that is what a
// fixture for this tool is, and the pattern rules are supposed to fire on them.
// Every one of them is invented. Put it under "files" in the allow-list:
//
//     { "files": ["tests/pii-scan.test.mjs"] }
//
// That silences the PATTERN rules for that one file, and nothing else: the suite
// itself asserts that the file contains no MACHINE-DERIVED term — no real slug,
// no real username, no real session id — so the coverage that actually
// distinguishes invented from local is still enforced there, by a test.

import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, sep, basename } from 'node:path';
import { homedir, hostname, userInfo, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(HERE, '..');

// ---------------------------------------------------------------------------
// generic vocabulary — NOT PII, and therefore safe to hard-code
// ---------------------------------------------------------------------------
// Derived terms that reduce to one of these are dropped. A Claude slug tail of
// "tools" or a Hermes label of "test" is a word this repo says on every page;
// letting it into the term set would bury the real findings in noise, and a
// gate nobody reads is a gate that is off. None of these is an identifier — they
// are English and build-system nouns, so hard-coding them leaks nothing.
const GENERIC = new Set([
  'user', 'users', 'home', 'main', 'src', 'lib', 'bin', 'tmp', 'temp', 'var',
  'test', 'tests', 'spec', 'demo', 'docs', 'doc', 'data', 'dist', 'build',
  'public', 'private', 'tools', 'tool', 'util', 'utils', 'app', 'apps', 'web',
  'api', 'node', 'code', 'work', 'new', 'old', 'local', 'shared', 'common',
  'project', 'projects', 'session', 'sessions', 'workspace', 'repo', 'repos',
  'windows', 'desktop', 'documents', 'downloads', 'program', 'files',
  'claude', 'codex', 'hermes', 'openclaw', 'anthropic', 'github', 'git',
  // Placeholder user names. These appear in this repo's own documentation and
  // in its fixtures ("C:\\Users\\you", "/home/dev"), and a rule that shouts about
  // them teaches the operator to ignore the rule. The DERIVED username term
  // still fires if the local user happens to be called one of these, so the
  // real thing is never let through by this list.
  'you', 'your', 'yourname', 'username', 'someone', 'somebody', 'me', 'myname',
  'dev', 'developer', 'example', 'placeholder', 'foo', 'bar', 'baz',
]);

// ---------------------------------------------------------------------------
// machine-independent patterns
// ---------------------------------------------------------------------------
// Deliberately written so none of them matches this file. The test suite proves
// that property rather than trusting it — if you add a rule here, the self-scan
// test is what tells you whether you just wrote a literal secret into the repo.
const PATTERN_RULES = [
  {
    id: 'private-key',
    severity: 'critical',
    what: 'private key header',
    re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g,
  },
  {
    id: 'aws-access-key',
    severity: 'critical',
    what: 'AWS access key id',
    re: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: 'anthropic-key',
    severity: 'critical',
    what: 'Anthropic API key',
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'openai-key',
    severity: 'critical',
    what: 'OpenAI-shaped API key',
    re: /\bsk-(?:proj-)?[A-Za-z0-9]{24,}/g,
  },
  {
    id: 'github-token',
    severity: 'critical',
    what: 'GitHub token',
    re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  },
  {
    id: 'google-key',
    severity: 'critical',
    what: 'Google API key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: 'slack-token',
    severity: 'critical',
    what: 'Slack token',
    re: /\bxox[baprs]-[0-9A-Za-z-]{12,}/g,
  },
  {
    id: 'jwt',
    severity: 'critical',
    what: 'JSON Web Token',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    id: 'bearer',
    severity: 'critical',
    what: 'bearer credential',
    // The token half must contain a digit: "Bearer <token>" in prose (docs,
    // header examples) is the overwhelmingly common false positive, and a
    // placeholder word has no digits in it.
    re: /\b[Bb]earer\s+(?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{20,}/g,
  },
  {
    id: 'assigned-secret',
    severity: 'high',
    what: 'secret-looking assignment',
    // key = "<20+ chars>" — the shape a leaked .env value takes when it is
    // pasted into source. Placeholder-ish values are filtered in `refine`.
    re: /\b(?:api[_-]?key|apikey|secret|passwd|password|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["'`]([^"'`\n]{20,})["'`]/gi,
  },
  {
    id: 'private-ip',
    severity: 'medium',
    what: 'private/LAN IPv4',
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
  },
  {
    id: 'mac-address',
    severity: 'medium',
    what: 'MAC address',
    re: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g,
  },
  {
    id: 'email',
    severity: 'medium',
    what: 'email address',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}\b/g,
  },
  // The three absolute home-path shapes. Each captures the name so `refine` can
  // widen the reported span to include it: the leak IS the name, not the prefix.
  {
    id: 'home-path',
    severity: 'high',
    what: 'absolute home path with a username',
    re: /\b[A-Za-z]:\\Users\\([A-Za-z0-9._-]{1,64})/g,
  },
  {
    id: 'home-path',
    severity: 'high',
    what: 'absolute home path with a username',
    re: /\b[A-Za-z]:\/Users\/([A-Za-z0-9._-]{1,64})/g,
  },
  {
    id: 'home-path',
    severity: 'high',
    what: 'absolute home path with a username',
    re: /(?:^|[\s"'`(=])\/[A-Za-z]\/Users\/([A-Za-z0-9._-]{1,64})/g,
  },
  {
    id: 'home-path',
    severity: 'high',
    what: 'absolute home path with a username',
    re: /(?:^|[\s"'`(=])\/(?:home|Users)\/([A-Za-z0-9._-]{1,64})/g,
  },
];

// Values that look like a secret assignment but are placeholders. Filtering
// these keeps the `assigned-secret` rule usable; every one of them is a generic
// word, not an identifier.
const PLACEHOLDER = /^(?:x{4,}|\.{3,}|<[^>]*>|\$\{[^}]*\}|%[A-Z_]+%|your[-_ ]|change[-_ ]?me|placeholder|example|redacted|dummy|sample|todo|none|null|undefined|process\.env)/i;

// ---------------------------------------------------------------------------
// deriving the sensitive term set from THIS machine
// ---------------------------------------------------------------------------

/** Escape a literal for use inside a RegExp. */
function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turn one sensitive term into a matcher.
 *
 * Terms are split on non-alphanumerics and rejoined with a LOOSE separator, so
 * a project slug survives being re-punctuated on the way into the repo: a slug
 * whose parts are joined by '-' is still caught when it appears joined by '_',
 * by '/', by a space, or by nothing at all. That is the shape these things
 * actually leak in — a slug is a munged path, and whoever pastes it usually
 * un-mungs it a little.
 *
 * Both ends are fenced with alphanumeric lookarounds so a short term cannot
 * match inside a longer word or, more importantly, inside the base64 integrity
 * hashes in package-lock.json, which would otherwise generate a wall of noise.
 */
function termMatcher(term, { loose = true } = {}) {
  const parts = String(term).split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!parts.length) return null;
  const body = loose
    ? parts.map(esc).join('[^A-Za-z0-9]{0,3}')
    : esc(String(term));
  try {
    return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'gi');
  } catch {
    return null;
  }
}

/** Is this term too generic or too short to be worth matching? */
function usefulTerm(term, suppress) {
  const t = String(term ?? '').trim();
  if (!t) return false;
  const lower = t.toLowerCase();
  if (suppress.has(lower)) return false;
  const parts = lower.split(/[^a-z0-9]+/).filter(Boolean);
  if (!parts.length) return false;
  // Every part generic AND only one part => drop ("tools", "demo").
  if (parts.length === 1) {
    if (GENERIC.has(parts[0])) return false;
    return parts[0].length >= 4;
  }
  // Multi-part terms: drop only if EVERY part is generic ("users-home").
  if (parts.every((p) => GENERIC.has(p))) return false;
  return parts.join('').length >= 6;
}

/**
 * The whole sensitive vocabulary of this machine, in memory only.
 *
 * Every source is optional and every one is wrapped: a machine with no Claude
 * store, no adapters, or an unreadable one still produces a usable scan from
 * the username/home/hostname alone. Options exist so the test suite can point
 * this at a fixture instead of the operator's real store — nothing on a normal
 * run passes anything.
 */
export async function deriveLocalTerms(options = {}) {
  const {
    username = safe(() => userInfo().username),
    home = safe(() => homedir()),
    host = safe(() => hostname()),
    claudeProjectsDir = home ? join(home, '.claude', 'projects') : null,
    includeAdapters = true,
    suppress = new Set(),
  } = options ?? {};

  const terms = new Set();       // matched loosely (slugs, labels, names)
  const literals = new Set();    // matched exactly (opaque ids)
  const sessionIds = new Set();  // checked against ids found in content

  const add = (t) => { if (usefulTerm(t, suppress)) terms.add(String(t).trim()); };

  // -- identity ------------------------------------------------------------
  if (username) add(username);
  if (host) add(host);
  if (home) {
    add(basename(home));
    // The home path itself, as a term, so "C:\Users\<name>" is caught by the
    // derived rule too and not only by the shape rule.
    add(home);
  }

  // -- Claude project slugs (readdir only; no transcript is opened) ---------
  //
  // The tail matters more than the whole slug. A slug is a munged cwd, and what
  // a human recognises — and therefore what gets pasted into a comment, a doc,
  // or an example — is the project part, not the "<drive>--Users-<name>-"
  // prefix. So both go in the set.
  //
  // The prefix is matched by SHAPE rather than by reconstructing the munging.
  // Claude replaces each separator CHARACTER individually, so a two-character
  // separator (a drive colon followed by a backslash) becomes two dashes, while
  // the obvious `replace(/[^A-Za-z0-9]+/g, '-')` collapses that run into one.
  // Building the matcher out of the home path's alphanumeric segments is
  // agnostic to which of those a given harness did, and works for a posix home
  // as well. Worked examples live in the test suite, where the names are
  // invented — writing a real one here is precisely the mistake this file exists
  // to catch, and the self-scan test will fail if it creeps back in.
  const homePrefixRe = buildHomePrefixMatcher(home);
  if (claudeProjectsDir && existsSync(claudeProjectsDir)) {
    for (const name of safe(() => readdirSync(claudeProjectsDir)) ?? []) {
      const dir = join(claudeProjectsDir, name);
      let isDir = false;
      try { isDir = statSync(dir).isDirectory(); } catch { continue; }
      if (!isDir) continue;

      add(name);
      for (const tail of slugTails(name, homePrefixRe)) add(tail);

      // Real session ids: the .jsonl basenames. Collected as a membership set,
      // not as patterns — there can be thousands, and checking "is this id one
      // of mine?" is O(1) where scanning for each would not be.
      for (const f of safe(() => readdirSync(dir)) ?? []) {
        if (f.endsWith('.jsonl')) sessionIds.add(f.slice(0, -6).toLowerCase());
      }
    }
  }

  // -- project labels from the adapters ------------------------------------
  // Reuses the two modules that already know how to enumerate, rather than
  // re-deriving their rules here (and drifting from them later). Both are
  // read-only; a failure in either costs only that source's labels.
  if (includeAdapters) {
    const cand = await safeAsync(async () => {
      const m = await import('./setup-discovery.mjs');
      return m.enumerateCandidates();
    });
    for (const s of cand?.sources ?? []) {
      for (const p of s.projects ?? []) {
        if (typeof p.project === 'string') add(p.project);
      }
    }

    const rows = await safeAsync(async () => {
      const reg = await import('./adapters/index.mjs');
      const present = (reg.storesPresent() ?? []).map((s) => s.id);
      return present.length ? reg.discoverAll({ sources: present }) : [];
    });
    for (const r of rows ?? []) {
      if (typeof r?.project === 'string') add(r.project);
      const id = String(r?.id ?? '');
      if (!id) continue;
      if (isUuidish(id)) sessionIds.add(id.toLowerCase());
      else if (id.length >= 8) literals.add(id);
    }
  }

  return { terms, literals, sessionIds };
}

/** A matcher for the munged home-directory prefix of a project slug, built from
 *  the home path's alphanumeric segments so it is agnostic to how a given
 *  harness munged the separators. Null when there is no usable home path. */
export function buildHomePrefixMatcher(home) {
  const parts = String(home ?? '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!parts.length) return null;
  try {
    return new RegExp(`^${parts.map(esc).join('[^A-Za-z0-9]+')}[^A-Za-z0-9]+`, 'i');
  } catch { return null; }
}

// A git worktree of project <slug> lands at "<slug>--claude-worktrees-<name>",
// so the interesting term is the part in front of that marker, not the whole
// generated directory name.
const WORKTREE_MARK = /--claude-worktrees.*$/i;

/** The recognisable project names inside one munged project slug. */
export function slugTails(name, homePrefixRe) {
  const out = new Set();
  const base = String(name).replace(WORKTREE_MARK, '');
  if (base && base !== name) out.add(base);

  if (homePrefixRe) {
    const stripped = base.replace(homePrefixRe, '');
    if (stripped && stripped !== base) out.add(stripped);
  }
  // A slug that is not under the home directory still carries a drive prefix
  // ("C--Something-Else"); drop it so the project part stands alone.
  const noDrive = base.replace(/^[A-Za-z][^A-Za-z0-9]+/, '');
  if (noDrive && noDrive !== base) out.add(noDrive);

  return out;
}

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuidish(s) { return UUIDISH.test(String(s)); }

function safe(fn) { try { return fn(); } catch { return null; } }
async function safeAsync(fn) { try { return await fn(); } catch { return null; } }

/** Compile a derived term set into runnable rules. */
export function buildTermRules({ terms, literals }) {
  const rules = [];
  for (const t of terms ?? []) {
    const re = termMatcher(t, { loose: true });
    if (re) rules.push({ id: 'local-term', severity: 'high', what: 'local machine identifier', re });
  }
  for (const t of literals ?? []) {
    const re = termMatcher(t, { loose: false });
    if (re) rules.push({ id: 'local-id', severity: 'high', what: 'local session identifier', re });
  }
  return rules;
}

// ---------------------------------------------------------------------------
// the allow-list
// ---------------------------------------------------------------------------

export function loadAllowlist(path) {
  const empty = { terms: new Set(), patterns: [], files: [], reviewed: new Set(), path: null };
  if (!path || !existsSync(path)) return empty;
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return { ...empty, malformed: true }; }
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);
  const patterns = [];
  for (const p of list(raw.patterns)) {
    try { patterns.push(new RegExp(p)); } catch { /* a bad regex must not fail the gate open */ }
  }
  return {
    terms: new Set(list(raw.terms).map((s) => s.toLowerCase())),
    patterns,
    files: list(raw.files),
    reviewed: new Set(list(raw.reviewed).map((s) => s.replace(/\\/g, '/'))),
    path,
  };
}

// ---------------------------------------------------------------------------
// content scanning
// ---------------------------------------------------------------------------

/** Byte-level binary sniff: a NUL in the head is the classic tell, and git uses
 *  the same heuristic. Reported, never silently skipped. */
export function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Byte offset -> {line, column}, 1-based, via a prebuilt newline index. */
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, column: offset - starts[lo] + 1 };
  };
}

/** Widen a match to the whole surrounding token, so allow-listing a full email
 *  suppresses a username fragment found inside it. */
function surroundingToken(text, start, end) {
  const ok = (c) => /[A-Za-z0-9._%+@-]/.test(c);
  let a = start, b = end;
  while (a > 0 && ok(text[a - 1])) a--;
  while (b < text.length && ok(text[b])) b++;
  return text.slice(a, b);
}

/** Post-match filtering that a regex cannot express. Returns a (possibly
 *  adjusted) finding, or null to drop it. */
function refine(rule, m, text) {
  let span = m[0];
  let start = m.index;

  if (rule.id === 'assigned-secret') {
    const value = m[1] ?? '';
    if (PLACEHOLDER.test(value.trim())) return null;
    // No entropy at all (all one character, or a plain sentence) is prose.
    if (/^[A-Za-z ]+$/.test(value) && !/[0-9]/.test(value)) return null;
  }

  if (rule.id === 'home-path') {
    const name = m[1] ?? '';
    // A path shape whose name is a generic placeholder is documentation, not a
    // leak: "/Users/you", "C:\Users\dev". The DERIVED username rule still fires
    // if the name happens to be this machine's, so nothing real gets a pass.
    if (GENERIC.has(name.toLowerCase())) return null;
    // Trim a leading delimiter the regex had to consume for its boundary.
    const lead = span.match(/^[\s"'`(=]/);
    if (lead) { span = span.slice(1); start += 1; }
  }

  if (rule.id === 'email') {
    // "@types/node"-style specifiers and version-y noise never reach here (the
    // pattern needs a TLD), but a trailing sentence period does.
    span = span.replace(/[.,;:]+$/, '');
    if (!span.includes('@')) return null;
  }

  return { span, start, end: start + span.length };
}

/** Scan one decoded text body against every rule. */
export function scanText(text, rules, { file, allow, sessionIds, blob = null, cap = 200 }) {
  const at = lineIndex(text);
  const out = [];
  const seen = new Set();

  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let m;
    let hits = 0;
    while ((m = rule.re.exec(text)) !== null) {
      if (m[0] === '') { rule.re.lastIndex++; continue; }
      const refined = refine(rule, m, text);
      if (!refined) continue;

      const { span, start, end } = refined;
      const token = surroundingToken(text, start, end);
      if (allowed(span, token, allow)) continue;

      const { line, column } = at(start);
      const key = `${rule.id}|${line}|${column}|${span}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        rule: rule.id, severity: rule.severity, what: rule.what,
        file, blob, line, column, match: truncate(span, 120),
        _s: start, _e: end,
      });
      if (++hits >= cap) break;
    }
  }

  // Session ids are a membership question, not a search: find every id-shaped
  // string, then ask whether it is one of THIS machine's. A fabricated demo id
  // is therefore free, and a real one is never missed for being unusual.
  if (sessionIds?.size) {
    const idRe = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
    let m;
    while ((m = idRe.exec(text)) !== null) {
      if (!sessionIds.has(m[0].toLowerCase())) continue;
      if (allowed(m[0], m[0], allow)) continue;
      const { line, column } = at(m.index);
      out.push({
        rule: 'real-session-id', severity: 'critical',
        what: 'id of a real session on this machine',
        file, blob, line, column, match: m[0],
        _s: m.index, _e: m.index + m[0].length,
      });
    }
  }

  return collapse(out);
}

/**
 * Drop a finding whose span sits INSIDE another finding's span.
 *
 * The derived term set overlaps itself by construction — the username is inside
 * the home path, which is inside the project slug — so one leaked string can
 * otherwise be reported four times at four columns. The operator has to fix it
 * once, so report it once, at the longest (most informative) span. A critical
 * finding is never swallowed by a lower-severity one covering it.
 */
function collapse(findings) {
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  const byLen = [...findings].sort((a, b) => (b._e - b._s) - (a._e - a._s));
  const kept = [];
  for (const f of byLen) {
    const covered = kept.some((k) => k._s <= f._s && f._e <= k._e
      && rank[k.severity] <= rank[f.severity]);
    if (!covered) kept.push(f);
  }
  return kept;
}

function allowed(span, token, allow) {
  if (!allow) return false;
  const s = span.toLowerCase(), t = token.toLowerCase();
  if (allow.terms.has(s) || allow.terms.has(t)) return true;
  for (const re of allow.patterns) { re.lastIndex = 0; if (re.test(span) || re.test(token)) return true; }
  return false;
}

function truncate(s, n) { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

// ---------------------------------------------------------------------------
// enumerating what to scan
// ---------------------------------------------------------------------------

function git(args, cwd, { encoding = 'utf8', input } = {}) {
  const r = spawnSync('git', args, { cwd, encoding, input, maxBuffer: 1024 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

const SKIP_DIR = /(?:^|\/)(?:node_modules|dist|\.git)(?:\/|$)/;

function listPaths(cwd, mode) {
  const args = mode === 'worktree'
    ? ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
    : ['ls-files', '-z'];
  const out = git(args, cwd);
  if (out == null) return null;
  return out.split('\0').filter(Boolean).filter((p) => !SKIP_DIR.test(p));
}

/**
 * Every blob in every commit, deduplicated by sha.
 *
 * This is the mode that answers "what is ALREADY public": a file deleted in a
 * later commit is still there in the objects, and a squash only helps if it
 * happened after the leak. Blobs are streamed out of one `git cat-file --batch`
 * rather than one process per object, which is the difference between seconds
 * and minutes on Windows.
 */
function listHistoryBlobs(cwd) {
  const objs = git(['rev-list', '--objects', '--all'], cwd);
  if (objs == null) return null;

  const pathBySha = new Map();
  for (const line of objs.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const sha = line.slice(0, sp), path = line.slice(sp + 1);
    if (!/^[0-9a-f]{40}$/.test(sha) || !path) continue;
    if (SKIP_DIR.test(path)) continue;
    if (!pathBySha.has(sha)) pathBySha.set(sha, path);
  }
  if (!pathBySha.size) return [];

  const shas = [...pathBySha.keys()];
  const check = git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    cwd, { input: `${shas.join('\n')}\n` });
  if (check == null) return null;

  const blobs = [];
  for (const line of check.split('\n')) {
    const [sha, type, size] = line.trim().split(/\s+/);
    if (type !== 'blob') continue;
    blobs.push({ sha, size: Number(size) || 0, path: pathBySha.get(sha) });
  }
  return blobs;
}

/** Read many blobs in one `git cat-file --batch`. Returns Map<sha, Buffer>. */
function readBlobs(cwd, shas) {
  const out = new Map();
  if (!shas.length) return out;
  const r = spawnSync('git', ['cat-file', '--batch'], {
    cwd, input: `${shas.join('\n')}\n`, maxBuffer: 1024 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return out;
  const buf = r.stdout;
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(10, i);
    if (nl < 0) break;
    const header = buf.toString('utf8', i, nl).trim().split(/\s+/);
    i = nl + 1;
    const [sha, type, sizeStr] = header;
    if (type !== 'blob') break;                 // missing/ambiguous — stop cleanly
    const size = Number(sizeStr) || 0;
    out.set(sha, buf.subarray(i, i + size));
    i += size + 1;                              // trailing newline
  }
  return out;
}

// ---------------------------------------------------------------------------
// the scan
// ---------------------------------------------------------------------------

const MAX_TEXT_BYTES = 8 * 1024 * 1024;

/** The names this repository already publishes about itself: its directory, its
 *  package name, and the repo half of its git remote. Lower-cased. */
export function repoSelfNames(cwd) {
  const out = new Set();
  const push = (v) => { if (typeof v === 'string' && v.trim()) out.add(v.trim().toLowerCase()); };

  push(basename(cwd));
  try { push(JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).name); } catch { /* none */ }
  const remote = git(['config', '--get', 'remote.origin.url'], cwd);
  if (remote) push(remote.trim().replace(/\.git\s*$/, '').split(/[/:]/).pop());
  return out;
}

/**
 * Run a scan and return a report. Everything is injectable so the suite can
 * exercise this against a fixture repo without ever consulting the real machine.
 */
export async function scan(options = {}) {
  const {
    cwd = REPO_ROOT,
    mode = 'tracked',                 // 'tracked' | 'worktree' | 'history'
    allowPath = join(cwd, '.pii-allow.json'),
    allow = loadAllowlist(allowPath),
    localTerms = null,                // pass to skip machine derivation (tests)
    deriveOptions = {},
    only = null,                      // restrict to these repo-relative paths
    maxTextBytes = MAX_TEXT_BYTES,
  } = options ?? {};

  // The repository's OWN names are definitionally public — it is the thing being
  // published. They are also, on this machine, a project slug tail (the checkout
  // lives under the home directory, so a slug ends with the repo's folder name),
  // and without this every mention of the project in its own README would be a
  // finding. Derived from the repo at runtime, never hard-coded.
  const derived = localTerms ?? await deriveLocalTerms({
    suppress: repoSelfNames(cwd),
    ...deriveOptions,
  });
  const rules = [...PATTERN_RULES.map((r) => ({ ...r, re: new RegExp(r.re.source, r.re.flags) })),
    ...buildTermRules(derived)];

  const findings = [];
  const reviewRequired = [];
  const skipped = [];
  let files = 0;
  let bytes = 0;

  const skipFile = (p) => allow.files.some((prefix) => p === prefix || p.startsWith(prefix.replace(/\/?$/, '/')));
  const onlySet = only ? new Set(only.map((p) => p.replace(/\\/g, '/'))) : null;

  const consider = (path, buf, blob) => {
    const p = path.replace(/\\/g, '/');
    if (skipFile(p)) return;
    if (onlySet && !onlySet.has(p)) return;
    files++;
    bytes += buf.length;
    if (looksBinary(buf)) {
      if (!allow.reviewed.has(p)) {
        reviewRequired.push({ file: p, blob, bytes: buf.length, reason: 'binary — not readable by a text scan' });
      }
      return;
    }
    if (buf.length > maxTextBytes) {
      skipped.push({ file: p, blob, bytes: buf.length, reason: 'larger than the text-scan limit' });
      return;
    }
    findings.push(...scanText(buf.toString('utf8'), rules, {
      file: p, blob, allow, sessionIds: derived.sessionIds,
    }));
  };

  if (mode === 'history') {
    const blobs = listHistoryBlobs(cwd);
    if (blobs == null) return fail('git history could not be read (not a git repo?)', mode, allow, derived);
    // Chunked so a large repo does not build one enormous buffer.
    for (let i = 0; i < blobs.length; i += 200) {
      const chunk = blobs.slice(i, i + 200);
      const bodies = readBlobs(cwd, chunk.map((b) => b.sha));
      for (const b of chunk) {
        const body = bodies.get(b.sha);
        if (!body) continue;
        consider(b.path, body, b.sha.slice(0, 10));
      }
    }
  } else {
    const paths = listPaths(cwd, mode);
    if (paths == null) return fail('`git ls-files` failed (not a git repo?)', mode, allow, derived);
    for (const p of paths) {
      let buf;
      try { buf = readFileSync(join(cwd, p)); } catch { continue; }  // deleted/unreadable
      consider(p, buf, null);
    }
  }

  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => (rank[a.severity] - rank[b.severity])
    || a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  // The byte offsets are an internal detail of overlap collapsing; they are not
  // part of the report contract and would only be one more thing to keep stable.
  for (const f of findings) { delete f._s; delete f._e; }

  return {
    tool: 'pii-scan', version: 1, mode,
    scanned: { files, bytes, binaries: reviewRequired.length, skipped: skipped.length },
    // A COUNT, never the inventory. Printing the terms would republish them.
    termCount: (derived.terms?.size ?? 0) + (derived.literals?.size ?? 0),
    sessionIdCount: derived.sessionIds?.size ?? 0,
    allowlist: allow.path && existsSync(allow.path) ? allow.path.replace(/\\/g, '/') : null,
    allowlistMalformed: allow.malformed === true,
    findings, reviewRequired, skipped,
    ok: findings.length === 0,
    error: null,
  };
}

function fail(message, mode, allow, derived) {
  return {
    tool: 'pii-scan', version: 1, mode,
    scanned: { files: 0, bytes: 0, binaries: 0, skipped: 0 },
    termCount: (derived?.terms?.size ?? 0) + (derived?.literals?.size ?? 0),
    sessionIdCount: derived?.sessionIds?.size ?? 0,
    allowlist: null, allowlistMalformed: allow?.malformed === true,
    findings: [], reviewRequired: [], skipped: [],
    ok: false, error: message,
  };
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

const MODE_LABEL = {
  tracked: 'tracked files (working-tree content)',
  worktree: 'tracked + untracked files',
  history: 'every blob in every commit',
};

export function formatReport(r) {
  const L = [];
  const n = (x, one, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;

  L.push(`pii-scan — ${MODE_LABEL[r.mode] ?? r.mode}`);
  if (r.error) { L.push(`  ERROR: ${r.error}`); return L.join('\n'); }

  L.push(`  ${n(r.scanned.files, 'file')} scanned · ${r.termCount} local terms held in memory `
    + `(never printed) · ${r.sessionIdCount} local session ids`);
  if (r.allowlist) L.push(`  allow-list: ${r.allowlist}`);
  if (r.allowlistMalformed) L.push('  WARNING: the allow-list file is malformed and was ignored.');
  L.push('');

  if (r.findings.length) {
    L.push(`FINDINGS (${r.findings.length}) — the matched text is quoted; do not paste this report into the repo`);
    L.push('');
    let lastFile = null;
    for (const f of r.findings) {
      if (f.file !== lastFile) { L.push(`  ${f.file}${f.blob ? `  @${f.blob}` : ''}`); lastFile = f.file; }
      L.push(`    ${String(f.line).padStart(6)}:${String(f.column).padEnd(4)} `
        + `${f.severity.toUpperCase().padEnd(8)} ${f.what}`);
      L.push(`             ${JSON.stringify(f.match)}`);
    }
    L.push('');
  }

  if (r.reviewRequired.length) {
    L.push(`REVIEW REQUIRED (${r.reviewRequired.length}) — binaries a text scan cannot read.`);
    L.push('  A clean text scan over these is NOT an all-clear: a screen recording or');
    L.push('  screenshot can show session titles, paths and transcript text. Open each one,');
    L.push('  then list it under "reviewed" in the allow-list file to acknowledge it.');
    for (const b of r.reviewRequired) {
      L.push(`    ${b.file}${b.blob ? `  @${b.blob}` : ''}  (${(b.bytes / 1024).toFixed(0)} KB)`);
    }
    L.push('');
  }

  if (r.skipped.length) {
    L.push(`SKIPPED (${r.skipped.length}) — too large to scan as text:`);
    for (const s of r.skipped) L.push(`    ${s.file}  (${(s.bytes / 1024 / 1024).toFixed(1)} MB)`);
    L.push('');
  }

  if (!r.findings.length && !r.reviewRequired.length && !r.skipped.length) {
    L.push('CLEAN — no findings.');
  } else if (!r.findings.length) {
    L.push('No text findings, but the items above have not been reviewed — this is NOT an all-clear.');
  } else {
    L.push('NOT CLEAN — fix the findings above before pushing.');
  }
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `pii-scan — pre-push PII gate for this repo.

  node tools/pii-scan.mjs [options]

  --worktree          also scan untracked, non-ignored files
  --history           scan every blob in every commit (what is already public)
  --json              machine-readable report on stdout
  --allow <file>      allow-list path (default: .pii-allow.json at the repo root)
  --fail-on-review    exit non-zero when an unacknowledged binary is present
  --no-local          skip machine-derived terms; run the generic patterns only
  --help

Exit: 0 no findings · 1 findings · 2 the scan failed.

The sensitive term set is derived from this machine at runtime and held in
memory only. It is never written to disk and never printed; the report quotes
the matched span and file:line so you can go fix it. Do not redirect this
report into a file inside the repo.

Allow-list format (all keys optional):
  { "terms": [], "patterns": [], "files": [], "reviewed": [] }
  terms     exact, case-insensitive identifiers accepted as public
  patterns  regex sources tested against the matched span
  files     path prefixes to skip entirely
  reviewed  binaries a human has actually opened and cleared
`;

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP); return 0; }

  const mode = argv.includes('--history') ? 'history' : argv.includes('--worktree') ? 'worktree' : 'tracked';
  const json = argv.includes('--json');
  const failOnReview = argv.includes('--fail-on-review');
  const noLocal = argv.includes('--no-local');
  const ai = argv.indexOf('--allow');
  const allowPath = ai >= 0 && argv[ai + 1] ? argv[ai + 1] : join(REPO_ROOT, '.pii-allow.json');

  const report = await scan({
    cwd: REPO_ROOT, mode, allowPath,
    localTerms: noLocal ? { terms: new Set(), literals: new Set(), sessionIds: new Set() } : null,
  });

  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);

  if (report.error) return 2;
  if (report.findings.length) return 1;
  if (failOnReview && report.reviewRequired.length) return 1;
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => {
    process.stderr.write(`pii-scan failed: ${e?.message ?? e}\n`);
    process.exitCode = 2;
  });
}

export const _internal = {
  PATTERN_RULES, GENERIC, termMatcher, usefulTerm, refine, surroundingToken,
  buildHomePrefixMatcher, slugTails, listPaths, listHistoryBlobs, tmpdir, sep,
};
