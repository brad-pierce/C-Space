// setup-discovery.mjs — the CANDIDATE ENUMERATOR for the setup panel.
//
// This module answers exactly one question: "what could the operator tick?"
// It is the component that turns filesystem contents into the id space, so the
// traversal fence of the setup surface lives or dies here. Read these five
// properties before the code:
//
//  1. IT TAKES NO ARGUMENTS. `enumerateCandidates()` has an empty parameter
//     list, deliberately. There is no store path, no source filter, no glob, no
//     "scan this instead" — nothing a request body could ever be threaded into.
//     The only directory this module reads is a module constant. Combined with
//     setup-server.mjs's rule that an id is resolved by Map.get against a map
//     built from THIS scan, on THIS request, there is no code path from request
//     bytes to join()/open()/readdir(). Traversal is not validated against; it
//     is unrepresentable. (`_internal` exists for tests and is not routed to.)
//
//  2. IT EMITS LABELS AND COUNTS, NOTHING ELSE. Each project row is
//     { project, sessions, lastActiveAt, onThisMachine } — contract §3.3. No
//     absolute path, no transcript id, no file name ever leaves this module.
//
//  3. IT OPENS NO TRANSCRIPT. The Claude scan is readdir + stat, full stop; it
//     never opens a .jsonl. (The non-Claude sources are enumerated through the
//     adapter registry, exactly as the contract prescribes — recovering a Codex
//     project label costs that adapter one first-line read, and Hermes/OpenClaw
//     open SQLite read-only. That is the adapters' documented behaviour, not
//     something this module adds.)
//
//  4. IT NEVER THROWS. A missing store, an unreadable store, an adapter that
//     blows up, a malformed allowlist — every one of them degrades to "that
//     source contributes nothing", because this runs on an unauthenticated
//     (locality-gated) GET that the panel polls once a second.
//
//  5. IT LOGS NOTHING. Not a name, not a count, not a path (F6). Project
//     directory slugs ARE cwd paths — client names, internal codenames — and
//     the runner console gets screen-shared. Labels go to the local page and
//     nowhere else.
//
// WHY A PURPOSE-BUILT CLAUDE SCAN (contract §1.1a). `discoverAll()` cannot
// enumerate candidate Claude projects: adapters/claude.mjs discover() delegates
// to live-server.mjs listSessions(), which is ALREADY allowlist-filtered. On a
// fresh machine — precisely the machine the setup panel exists for — it returns
// []. So Claude candidates come from a direct scan of ~/.claude/projects that
// MIRRORS tools/allowlist-init.mjs: the panel must offer exactly the slugs the
// CLI offers, or the two curation surfaces disagree about what exists, which is
// a bug in a privacy control.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { KNOWN_SOURCES, readAllowlist } from './allowlist-store.mjs';

// The one directory this module reads. A constant, never a parameter (property 1).
const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');

// A git worktree of project <slug> lands at "<slug>--claude-worktrees...".
// live-server.mjs's projectAllowed() already treats an allow entry for <slug> as
// covering those, so a worktree is never its own candidate — it is folded into
// the slug that already governs it.
const WORKTREE_MARK = '--claude-worktrees';

// 5 s, per contract §3.3. The panel polls GET /setup/state at 1 Hz and every
// poll would otherwise re-walk the Claude store and re-open two SQLite files.
const CACHE_MS = 5_000;

// Fallback display names, used when the adapter registry could not be loaded (or
// a source appears only because the config still names it). Kept identical to
// the adapters' own `label` fields.
const SOURCE_LABELS = {
  claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes', openclaw: 'OpenClaw',
};

// ---------------------------------------------------------------------------
// the adapter registry, reached by lazy dynamic import
// ---------------------------------------------------------------------------
// adapters/index.mjs pulls in claude.mjs → live-server.mjs and does top-level
// await over its optional siblings. Loading it lazily keeps this module cheap to
// import, keeps it out of live-server's import cycle, and — the point — means a
// registry that fails to load costs only the non-Claude sources. The Claude
// candidate list, which is what an empty allowlist actually needs, still works.
let registryPromise = null;
function registry() {
  return (registryPromise ??= import('./adapters/index.mjs').catch(() => null));
}

// ---------------------------------------------------------------------------
// the Claude store scan  (mirror of tools/allowlist-init.mjs)
// ---------------------------------------------------------------------------

/** Count transcripts in one project directory and find the newest mtime.
 *  readdir + stat only — no file is ever opened. */
function countTranscripts(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return { sessions: 0, lastActiveAt: null }; }
  let sessions = 0;
  let lastActiveAt = null;
  for (const name of names) {
    // Same predicate as allowlist-init.mjs: a plain endsWith on the entry name.
    if (!name.endsWith('.jsonl')) continue;
    sessions++;
    try {
      const m = statSync(join(dir, name)).mtimeMs;
      if (lastActiveAt === null || m > lastActiveAt) lastActiveAt = m;
    } catch { /* vanished mid-scan — it still counts, we just have no mtime */ }
  }
  return { sessions, lastActiveAt };
}

/**
 * Enumerate candidate Claude projects under `root`.
 *
 * `root` is a parameter for ONE reason: tests must be able to point this at a
 * fixture instead of the operator's real ~/.claude (which is read-only, forever,
 * and must not be a test dependency). It is exported only via `_internal`; the
 * public entry point passes the module constant and nothing else, so no caller —
 * least of all an HTTP handler — can steer it.
 *
 * Mirrors allowlist-init.mjs exactly on the two things that must not drift:
 *   · a directory whose name contains "--claude-worktrees" is never its own
 *     candidate;
 *   · a slug is a candidate iff its OWN directory holds at least one .jsonl.
 * Worktree sessions are then folded into their parent slug's count and mtime
 * (contract §3.3), which is what the allowlist entry for that slug actually
 * exposes. A worktree whose parent slug has no directory of its own is dropped:
 * the CLI does not offer it either, and a divergence between what `npm run
 * allowlist` offers and what the panel offers is a bug, not a feature.
 */
function scanClaudeStore(root) {
  const absent = { storePresent: false, sessionsTotal: 0, projects: [] };
  let names;
  try { names = readdirSync(root); } catch { return absent; }

  const byslug = new Map();          // slug -> { sessions, lastActiveAt }
  const worktrees = [];              // { parent, sessions, lastActiveAt }

  for (const name of names) {
    const dir = join(root, name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    const mark = name.indexOf(WORKTREE_MARK);
    const counted = countTranscripts(dir);
    if (mark > 0) { worktrees.push({ parent: name.slice(0, mark), ...counted }); continue; }
    if (mark === 0) continue;        // degenerate name with no parent slug
    byslug.set(name, counted);
  }

  for (const w of worktrees) {
    const parent = byslug.get(w.parent);
    if (!parent) continue;           // CLI parity — see the doc comment
    parent.sessions += w.sessions;
    if (w.lastActiveAt !== null && (parent.lastActiveAt === null || w.lastActiveAt > parent.lastActiveAt)) {
      parent.lastActiveAt = w.lastActiveAt;
    }
  }

  const projects = [];
  let sessionsTotal = 0;
  for (const [project, c] of byslug) {
    if (!c.sessions) continue;       // a directory with zero transcripts is omitted
    sessionsTotal += c.sessions;
    projects.push({
      project, sessions: c.sessions, lastActiveAt: c.lastActiveAt, onThisMachine: true,
    });
  }
  return { storePresent: true, sessionsTotal, projects: sortProjects(projects) };
}

// ---------------------------------------------------------------------------
// the other sources, through the adapter registry
// ---------------------------------------------------------------------------

/** Group discovery rows into project rows. `null` is PRESERVED as its own
 *  bucket — sessions whose label could not be recovered are a real thing the
 *  operator has to be told about, and the allowlist's meaning for them is the
 *  source's "*" (contract §3.1), which is why the panel shows them and the
 *  server refuses to tick them. */
function groupRows(rows) {
  const by = new Map();
  for (const r of rows ?? []) {
    const project = typeof r?.project === 'string' && r.project ? r.project : null;
    const cur = by.get(project) ?? { project, sessions: 0, lastActiveAt: null, onThisMachine: true };
    cur.sessions++;
    const m = Number(r?.mtime);
    if (Number.isFinite(m) && (cur.lastActiveAt === null || m > cur.lastActiveAt)) cur.lastActiveAt = m;
    by.set(project, cur);
  }
  return sortProjects([...by.values()]);
}

/**
 * Candidates for codex / hermes / openclaw.
 *
 * `discoverAll({ sources })` is the enumerator here (contract §1.1a): those
 * adapters do not consult the allowlist, so unlike Claude they DO list on a
 * fresh machine. Only adapters that report storeExists() are passed in, so a
 * store the operator has not opted into is not so much as opened — presence is
 * not consent, and this scan runs before any consent exists.
 */
async function scanOtherSources() {
  const out = new Map();             // id -> { label, storePresent, sessionsTotal, projects }
  const reg = await registry();
  if (!reg) return out;

  const present = [];
  for (const a of reg.adapters ?? []) {
    const id = a?.id;
    if (typeof id !== 'string' || id === 'claude' || !KNOWN_SOURCES.includes(id)) continue;
    let storePresent = false;
    try { storePresent = a.storeExists() === true; } catch { storePresent = false; }
    out.set(id, {
      label: typeof a.label === 'string' && a.label ? a.label : (SOURCE_LABELS[id] ?? id),
      storePresent, sessionsTotal: 0, projects: [],
    });
    if (storePresent) present.push(id);
  }
  if (!present.length) return out;

  let rows = [];
  try { rows = reg.discoverAll({ sources: present }) ?? []; } catch { rows = []; }

  const bySource = new Map();
  for (const r of rows) {
    const src = r?.source;
    if (!out.has(src)) continue;     // a row from a source we did not ask for
    let bucket = bySource.get(src);
    if (!bucket) { bucket = []; bySource.set(src, bucket); }
    bucket.push(r);
  }
  for (const [id, srcRows] of bySource) {
    const entry = out.get(id);
    entry.projects = groupRows(srcRows);
    entry.sessionsTotal = entry.projects.reduce((n, p) => n + p.sessions, 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// stale allowlist entries
// ---------------------------------------------------------------------------

/**
 * Entries the config still names that this machine no longer has (a laptop/
 * desktop pair with different slugs, a project since deleted, a typo).
 *
 * They are emitted as rows with `sessions: 0, onThisMachine: false` so they get
 * an id from the same digest space and can therefore be DENIED. Without this a
 * curation could only ever grow from the panel, which is the wrong direction for
 * a privacy control. They are emitted even when the store is absent entirely —
 * "configured, not on this machine" (§7.6) is exactly the state of a box that
 * has the config synced but no harness installed.
 *
 * A literal "*" is skipped: it is not a project, the writer refuses to produce
 * or remove one (F4), and offering it as a row would only produce a checkbox
 * that cannot be actioned.
 */
function staleEntries(cfg, source, known) {
  const list = source === 'claude' ? cfg.claude : (cfg.sources?.[source] ?? []);
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    if (typeof entry !== 'string' || !entry || entry === '*') continue;
    if (known.has(entry) || seen.has(entry)) continue;
    seen.add(entry);
    out.push({ project: entry, sessions: 0, lastActiveAt: null, onThisMachine: false });
  }
  return out;
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

/** Busiest first, then alphabetical. Stale rows (0 sessions) sink to the bottom,
 *  and the unlabelled bucket sorts under an empty string rather than crashing. */
function sortProjects(projects) {
  return projects.sort((a, b) =>
    (b.sessions - a.sessions) || String(a.project ?? '').localeCompare(String(b.project ?? '')));
}

/** Shallow-freeze the whole tree. The value is shared between every caller for
 *  up to 5 s; a consumer mutating it would corrupt the next request's view. */
function freeze(out) {
  for (const s of out.sources) { s.projects.forEach(Object.freeze); Object.freeze(s.projects); Object.freeze(s); }
  Object.freeze(out.sources);
  return Object.freeze(out);
}

async function build() {
  // Read the config from disk on every build: the operator may be hand-editing
  // it while the panel is open, and a startup snapshot would report stale rows
  // for entries they just removed. readAllowlist() never throws — a missing or
  // malformed file normalizes to "nothing configured".
  let cfg;
  try { cfg = readAllowlist().config; } catch { cfg = { claude: [], sources: {} }; }

  const claude = scanClaudeStore(CLAUDE_PROJECTS);
  const others = await scanOtherSources();

  const sources = [];
  for (const id of KNOWN_SOURCES) {
    const found = id === 'claude'
      ? { label: SOURCE_LABELS.claude, ...claude }
      : others.get(id);

    const known = new Set((found?.projects ?? [])
      .map((p) => p.project).filter((p) => typeof p === 'string'));
    const stale = staleEntries(cfg, id, known);

    // An adapter that is not installed contributes no source — UNLESS the config
    // still names projects for it, in which case the operator needs the rows to
    // untick them.
    if (!found && !stale.length) continue;

    sources.push({
      id,
      label: found?.label ?? SOURCE_LABELS[id] ?? id,
      storePresent: found?.storePresent === true,
      sessionsTotal: found?.sessionsTotal ?? 0,
      projects: [...(found?.projects ?? []), ...stale],
    });
  }
  return freeze({ sources });
}

// ---------------------------------------------------------------------------
// the cache and the public entry points
// ---------------------------------------------------------------------------

let cache = null;         // { at, value, gen }
let inflight = null;      // { gen, promise }
let gen = 0;              // bumped by invalidateCandidates()

/**
 * Every (source, project) pair the operator could tick, right now.
 *
 * TAKES NO ARGUMENTS, BY DESIGN (property 1 at the top of this file). Result per
 * contract §3.3:
 *
 *   { sources: [{ id, label, storePresent, sessionsTotal,
 *                 projects: [{ project, sessions, lastActiveAt, onThisMachine }] }] }
 *
 * The wire id for a row is computed by the CALLER (setup-server.mjs, via
 * setup-token.mjs projectId()) — a keyed digest over (source, project), salted
 * per process with SETUP_ID_SALT, which is a different secret from the auth
 * token. Nothing decodes out of it and no path ever enters it. This module does
 * not mint ids and holds no id→anything table, so there is nothing here for a
 * client-supplied id to resolve against: an id this process's scan did not just
 * produce simply is not in the caller's map.
 *
 * Never throws.
 */
export async function enumerateCandidates() {
  const g = gen;
  if (cache && cache.gen === g && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (inflight && inflight.gen === g) return inflight.promise;

  const p = build().then(
    (value) => {
      // A build that started before an invalidation must not repopulate the
      // cache: the mutation that invalidated it is about to resolve ids against
      // a scan it believes is fresh.
      if (gen === g) cache = { at: Date.now(), value, gen: g };
      if (inflight?.promise === p) inflight = null;
      return value;
    },
    () => {
      // build() is written not to throw; this is the belt to that braces. A
      // failed enumeration is fail-CLOSED — no candidates means no ids, which
      // means every mutation 404s.
      if (inflight?.promise === p) inflight = null;
      return freeze({ sources: [] });
    },
  );
  inflight = { gen: g, promise: p };
  return p;
}

/**
 * Drop the cache. setup-server.mjs calls this immediately after any successful
 * mutation, and again before resolving ids on the next one, so "the enumeration
 * is re-run from scratch on every mutating request" (§3.2) is true through this
 * layer as well as its own.
 */
export function invalidateCandidates() {
  cache = null;
  inflight = null;
  gen++;
  return true;
}

/** TESTS ONLY. Nothing on a request path reaches these, and `scanClaudeStore`'s
 *  `root` parameter exists solely so the suite can scan a fixture instead of the
 *  operator's real, permanently read-only ~/.claude. */
export const _internal = {
  scanClaudeStore, groupRows, staleEntries, countTranscripts,
  CLAUDE_PROJECTS, WORKTREE_MARK, CACHE_MS,
};
