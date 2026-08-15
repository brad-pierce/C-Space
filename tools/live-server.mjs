#!/usr/bin/env node
// live-server.mjs — tails live Claude Code sessions and streams viz items over SSE.
//
//   GET /sessions            → JSON list of allowed sessions, ACROSS SOURCES.
//                              Claude Code rows come from the local tail; rows
//                              from other harnesses (Codex, Hermes, OpenClaw)
//                              come through tools/adapters/ and appear only when
//                              the allowlist opts that source in. Every row
//                              carries `source` and `streamable`.
//   GET /stream?id=<uuid>    → SSE: full replay of the session so far, then live tail
//                              (omit id → most recently modified active session).
//                              CLAUDE ONLY — an allowed session from another
//                              source is refused 501 with the archive path,
//                              because the tail is a Claude JSONL reader.
//
// Also watches the session's subagent transcript dirs: each agent-*.jsonl that
// appears becomes a synthetic spawn (drone), and one that stops growing for
// AGENT_IDLE_MS (or whose task completes) becomes a despawn. This is how
// workflow fleets show up as drones in real time.
//
// Port 5198 by default (CSPACE_TAIL_PORT overrides; a busy port walks up to 10),
// bound to loopback (127.0.0.1) only — never the LAN. Callers are
// gated to loopback Host + loopback Origin (see `guard`), so transcript content
// is unreadable cross-site and from other machines. Read-only — never writes to
// ~/.claude.

import { createServer } from 'node:http';
import { readdirSync, statSync, openSync, readSync, closeSync, existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { SessionParser, cleanPreview } from './session-parser.mjs';

const PORT = 5198;
const PROJECTS = join(homedir(), '.claude', 'projects');
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;   // "active" = modified in last 10 min
const POLL_MS = 500;
const AGENT_IDLE_MS = 90_000;
const MAX_STREAMS = 8;          // hard cap on concurrent SSE clients (single-user tool)

// ---------- caller gate (loopback only) ----------
// Session transcripts are sensitive. The server binds to 127.0.0.1, but that is
// not enough on its own: a DNS-rebinding attacker resolves their domain to
// 127.0.0.1 and a cross-site page can then reach us. So we (a) require a
// loopback Host header (kills rebinding — the attacker's Host is their domain,
// not localhost) and (b) require any Origin present to be loopback, and echo
// back ONLY that exact origin (never `*`), which keeps the dev split working
// (page on :5199 fetching the tail on :5198) while denying every remote origin.
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i;
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

// Returns true if the request may proceed; otherwise writes a 403 and returns
// false. On success, sets a tight CORS header when a (loopback) Origin is
// present so cross-port dev fetches succeed without ever opening us to `*`.
export function guard(req, res) {
  const host = req.headers.host ?? '';
  if (!LOOPBACK_HOST.test(host)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return false;
  }
  const origin = req.headers.origin;
  if (origin != null) {
    if (!LOOPBACK_ORIGIN.test(origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return false;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  return true;
}

// PROJECT ALLOWLIST — session transcripts are sensitive, so the tail server
// exposes ONLY the projects you curate. The list is a LOCAL, gitignored config
// (cspace.allowlist.json) — never hardcoded here — so a public clone ships no
// project names and, with no config present, shows nothing (safe by default).
// Copy cspace.allowlist.example.json to cspace.allowlist.json to opt projects
// in. Override the path with the CSPACE_ALLOWLIST env var. Slugs are the munged
// directory names under ~/.claude/projects; each also matches that project's
// git worktrees.
//
// SOURCE-AWARE. C-Space reads more than one harness (Claude Code, Codex, Hermes,
// OpenClaw — see tools/adapters/). The config therefore has two keys:
//
//   "allow"    Claude Code project slugs. UNCHANGED meaning, unchanged format.
//   "sources"  OPTIONAL map: source id -> list of that source's project labels.
//              Ids are 'codex' | 'hermes' | 'openclaw' (and 'claude', which is
//              just another spelling of "allow"). "*" in a list means every
//              project of that source.
//
// THE SAFE DEFAULT IS THE POINT: a source with NO entry under "sources" exposes
// NOTHING, and its store is never even opened. A config written before this key
// existed — no "sources" at all — therefore behaves EXACTLY as it did: Claude
// projects per "allow", and zero Codex / Hermes / OpenClaw. The mere presence of
// ~/.codex, ~/.hermes or ~/.openclaw on the machine is never consent.
//
// Shorthand: an "allow" entry may carry a source prefix — "codex:the-dreaming"
// is identical to "sources": { "codex": ["the-dreaming"] }. Claude slugs never
// contain a colon, so an unprefixed entry is always a Claude slug.
//
// Matching for non-Claude sources is EXACT on the row's project label (or "*").
// A session whose project label could not be recovered (null) is matched only
// by "*" — an unlabelled session can never slip in under a named project.
export const KNOWN_SOURCES = ['claude', 'codex', 'hermes', 'openclaw'];
const SOURCE_PREFIX = new RegExp(`^(${KNOWN_SOURCES.join('|')}):(.+)$`);

// Shape: { claude: string[], sources: { [id]: string[] } }.
// KEY PRESENCE in `sources` is the opt-in — an explicitly empty list means
// "this source is configured and currently exposes nothing", which is still
// nothing. A MISSING key means the same thing but also skips the store read.
function normalizeAllowlist(j) {
  const cfg = { claude: [], sources: Object.create(null) };
  let sawAny = false;

  const arr = Array.isArray(j) ? j : j?.allow;
  if (Array.isArray(arr)) {
    sawAny = true;
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
    sawAny = true;
    for (const [id, val] of Object.entries(map)) {
      if (id.startsWith('_')) continue;                      // "_comment"-style keys
      if (!KNOWN_SOURCES.includes(id)) {
        console.warn(`[cspace] allowlist: unknown source "${id}" ignored (known: ${KNOWN_SOURCES.join(', ')})`);
        continue;
      }
      const list = val === true || val === '*'
        ? ['*']
        : Array.isArray(val) ? val.filter((s) => typeof s === 'string' && s) : [];
      if (id === 'claude') { cfg.claude.push(...list); continue; }
      cfg.sources[id] = [...(cfg.sources[id] ?? []), ...list];
    }
  }

  return sawAny ? cfg : null;
}

function loadAllowlist() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  // CSPACE_ALLOWLIST, when set, is AUTHORITATIVE — it is not merely a first
  // candidate. Pointing it at a missing or malformed file must mean "expose
  // nothing", never "quietly fall back to the repo config": an operator who
  // redirects the allowlist (a locked-down box, a CI run, a demo machine) would
  // otherwise get the default config's projects exposed behind their back.
  const envPath = process.env.CSPACE_ALLOWLIST?.trim();
  const candidates = envPath ? [envPath] : [join(repoRoot, 'cspace.allowlist.json')];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const cfg = normalizeAllowlist(JSON.parse(readFileSync(p, 'utf8')));
      if (cfg) return cfg;
    } catch (e) {
      console.warn('[cspace] allowlist parse error at ' + p + ': ' + e.message);
    }
  }
  // Missing config is the #1 first-run stumble, so say exactly what to do.
  // Deliberately print the COUNT, never the slugs: project directory names are
  // themselves sensitive (they are cwd paths — client names, internal codenames)
  // and this line lands in a terminal that gets screen-shared and pasted into
  // issues. `npm run allowlist` prints the list locally, where it belongs.
  let found = 0;
  try {
    found = readdirSync(PROJECTS).filter((d) => !d.includes('--claude-worktrees')).length;
  } catch { /* no project store */ }
  console.warn(
    '[cspace] NO ALLOWLIST — cspace.allowlist.json not found, so NO sessions are exposed.\n' +
    (found
      ? `         ${found} project(s) found locally; none are exposed until you opt them in.\n`
      : `         No project directories found under ${PROJECTS}.\n`) +
    '         Fix:  npm run allowlist     (lists them and scaffolds the config)');
  return { claude: [], sources: Object.create(null) };
}
const ALLOWLIST = loadAllowlist();
const ALLOWED_PROJECTS = ALLOWLIST.claude;
const projectAllowed = (proj) =>
  ALLOWED_PROJECTS.some(a => proj === a || proj.startsWith(a + '--claude-worktrees'));

/** Has this source been explicitly opted into? Claude is always in play (its
 *  own gate is ALLOWED_PROJECTS); every other source must appear in "sources". */
export function sourceOptedIn(id) {
  return id === 'claude' || Object.prototype.hasOwnProperty.call(ALLOWLIST.sources, id);
}

/** The source ids this machine's config permits reading at all. */
export function optedInSources() {
  return KNOWN_SOURCES.filter(sourceOptedIn);
}

/** THE gate: may a session from `source` in `project` be exposed? */
export function sessionAllowed(source, project) {
  if (source === 'claude') return typeof project === 'string' && projectAllowed(project);
  const list = ALLOWLIST.sources[source];
  if (!Array.isArray(list) || list.length === 0) return false;
  if (list.includes('*')) return true;
  if (typeof project !== 'string' || !project) return false;   // unlabelled: "*" only
  return list.includes(project);
}

// ---------- session discovery ----------
// A session orchestrating a workflow writes to <id>/subagents/**/agent-*.jsonl
// while its top-level transcript sits idle — activity must consider both.
// Cost control: the subagent tree is only walked when the top-level file is
// stale but recent (within SUBAGENT_LOOKBACK_MS), so quiet archives cost one
// stat each.
const SUBAGENT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

function newestSubagentMtime(sessionDir) {
  let newest = 0;
  for (const f of walkJsonl(join(sessionDir, 'subagents'))) {
    try {
      const m = statSync(f).mtimeMs;
      if (m > newest) newest = m;
    } catch { /* transient */ }
  }
  return newest;
}

// Never throws: a machine with no ~/.claude/projects (fresh clone, CI, a
// reviewer who has never run Claude Code) returns [] instead of an ENOENT that
// would escape an http callback and kill the process.
export function listSessions() {
  const now = Date.now();
  const out = [];
  let projects;
  try { projects = readdirSync(PROJECTS); } catch { return out; }
  for (const proj of projects) {
    if (!projectAllowed(proj)) continue;
    const dir = join(PROJECTS, proj);
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const full = join(dir, f);
      let st;
      try { st = statSync(full); } catch { continue; }
      let mtime = st.mtimeMs;
      if (now - mtime >= ACTIVE_WINDOW_MS && now - mtime < SUBAGENT_LOOKBACK_MS) {
        const sub = newestSubagentMtime(join(dir, basename(f, '.jsonl')));
        if (sub > mtime) mtime = sub;
      }
      out.push({
        id: basename(f, '.jsonl'), project: proj, path: full,
        sizeMB: +(st.size / 1e6).toFixed(1), mtime,
        active: now - mtime < ACTIVE_WINDOW_MS,
      });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// ---------- other harnesses (source adapters) ----------
// The registry is reached by LAZY DYNAMIC IMPORT, never a static one:
// adapters/claude.mjs imports listSessions from this file, so a static import
// here would close a module cycle that breaks whenever claude.mjs is the module
// reached first. Loading at call time happens after every module body has run,
// so the cycle never exists. A registry that fails to load degrades to
// Claude-only rather than taking the server down.
let registryPromise = null;
function registry() {
  if (!registryPromise) {
    registryPromise = import('./adapters/index.mjs').catch((e) => {
      console.warn('[cspace] source adapters unavailable: ' + (e?.message ?? e));
      return null;
    });
  }
  return registryPromise;
}

// Non-Claude discovery is comparatively expensive (Codex reads the first line of
// every rollout to recover its project; Hermes/OpenClaw open SQLite), and the
// fleet HUD polls /sessions every 5s. These rows are archive-only and never
// stream, so a short cache costs nothing in freshness.
const SOURCE_CACHE_MS = 30_000;
let sourceCache = { at: 0, rows: [] };

async function nonClaudeSessions() {
  // A source whose list is empty is opted in but exposes nothing, so there is
  // no reason to open its store either — same visible result, less reading.
  const extra = optedInSources()
    .filter((id) => id !== 'claude' && (ALLOWLIST.sources[id]?.length ?? 0) > 0);
  if (!extra.length) return [];                       // nothing opted in — no store is touched
  if (sourceCache.rows.length && Date.now() - sourceCache.at < SOURCE_CACHE_MS) return sourceCache.rows;
  const reg = await registry();
  if (!reg) return [];
  let rows = [];
  try {
    // `sources` restricts which adapters are consulted AT ALL; `filter` applies
    // the per-project allowlist. Both gates, every time.
    rows = reg.discoverAll({ sources: extra, filter: (r) => sessionAllowed(r.source, r.project) })
      .map((r) => ({
        ...r,
        sourceLabel: reg.sourceLabel(r.source) ?? r.source,
        libraryId: reg.libraryId(r.source, r.id),
        // HONESTY FLAGS. The SSE tail is an incremental Claude JSONL reader;
        // no other adapter can stream, so these rows are marked non-streamable
        // AND forced inactive so nothing in the UI treats them as a live dive.
        // /stream refuses them explicitly (501) rather than pretending.
        active: false,
        streamable: false,
      }));
  } catch (e) {
    console.warn('[cspace] source discovery failed: ' + (e?.message ?? e));
    rows = [];
  }
  sourceCache = { at: Date.now(), rows };
  return rows;
}

// The full allowed roster: Claude sessions (allowlist-gated as always) plus
// every allowed session from every opted-in source, each tagged with `source`.
// Active rows sort first, then newest — for a Claude-only config this is
// identical to the old pure mtime sort, because `active` is derived from mtime.
export async function listAllowedSessions() {
  const rows = listSessions().map((s) => ({
    ...s, source: 'claude', sourceLabel: 'Claude Code', libraryId: s.id, streamable: true,
  }));
  rows.push(...await nonClaudeSessions());
  rows.sort((a, b) =>
    (Number(b.active === true) - Number(a.active === true)) || ((b.mtime ?? 0) - (a.mtime ?? 0)));
  return rows;
}

// One-line-per-source coverage hint, printed ONCE per process. Says only how
// many sessions a store holds and how many are exposed — never a project name.
// Those labels are cwd- and title-derived (client names, internal codenames) and
// this line lands in terminals that get screen-shared and pasted into issues.
let coverageReported = false;
export async function reportSourceCoverage() {
  if (coverageReported) return;
  coverageReported = true;
  const reg = await registry();
  if (!reg) return;
  let present;
  try { present = reg.storesPresent(); } catch { return; }
  for (const { id, label } of present) {
    if (id === 'claude') continue;
    let all;
    try { all = reg.discoverAll({ sources: [id] }); } catch { continue; }
    if (!all.length) continue;
    const exposed = sourceOptedIn(id)
      ? all.filter((r) => sessionAllowed(r.source, r.project)).length
      : 0;
    if (exposed) {
      console.log(`[cspace] ${label}: ${exposed} of ${all.length} session(s) exposed (archive only — not streamable).`);
    } else {
      console.warn(
        `[cspace] ${label} store present with ${all.length} session(s) — 0 exposed. ` +
        `Opt in per project:  "sources": { "${id}": ["<project>"] }  (or "*") in cspace.allowlist.json.`);
    }
  }
}

// ---------- incremental file tail (poll-based; fs.watch is unreliable on win) ----------
class Tail {
  constructor(path) { this.path = path; this.offset = 0; this.buf = ''; }
  /** returns complete new lines since last call */
  read() {
    let st;
    try { st = statSync(this.path); } catch { return []; }
    if (st.size <= this.offset) return [];
    const len = st.size - this.offset;
    let lines = [];
    // The transcript can vanish, rotate, or be locked between the stat and the
    // open (and openSync/readSync throw on EACCES/EMFILE too). This runs from an
    // http callback and a timer, where a throw would kill the process — so any
    // read failure is a no-op poll; the next tick retries.
    let fd;
    try { fd = openSync(this.path, 'r'); } catch { return []; }
    let read = 0;
    try {
      const b = Buffer.alloc(Math.min(len, 8 * 1024 * 1024));
      while (read < len) {
        const n = readSync(fd, b, 0, Math.min(b.length, len - read), this.offset + read);
        if (n <= 0) break;
        this.buf += b.toString('utf8', 0, n);
        read += n;
      }
    } catch { /* partial read: keep what we got, offset advances below */ } finally {
      // advance past whatever was consumed even on a mid-read failure, so the
      // next poll never re-appends bytes already in this.buf
      this.offset += read;
      closeSync(fd);
    }
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    lines = parts.filter(l => l.trim());
    return lines;
  }
}

// ---------- subagent transcript watcher ----------
class AgentWatcher {
  constructor(sessionDir) {
    this.roots = [join(sessionDir, 'subagents')];
    this.known = new Map(); // path -> {id, lastSize, lastGrow, done}
    this.primed = false;    // first poll registers pre-existing idle files silently
  }
  poll(nowT) {
    const items = [];
    const first = !this.primed;
    this.primed = true;
    for (const root of this.roots) {
      if (!existsSync(root)) continue;
      for (const file of walkJsonl(root)) {
        let st;
        try { st = statSync(file); } catch { continue; }
        let k = this.known.get(file);
        if (!k) {
          // a file already idle when we first look is history, not live activity
          if (first && Date.now() - st.mtimeMs > AGENT_IDLE_MS) {
            this.known.set(file, { id: 'wfagent:' + basename(file, '.jsonl'), lastSize: st.size, lastGrow: 0, done: true });
            continue;
          }
          k = { id: 'wfagent:' + basename(file, '.jsonl'), lastSize: 0, lastGrow: Date.now(), done: false };
          this.known.set(file, k);
          let label = basename(file, '.jsonl');
          try {
            const head = readFileSync(file, 'utf8').split('\n')[0];
            const j = JSON.parse(head);
            const c = j?.message?.content;
            let txt = typeof c === 'string' ? c : Array.isArray(c) ? (c.find(x => x.type === 'text')?.text ?? '') : '';
            // strip boilerplate prompt preamble ("Repo: <path>. ...") for a usable label
            txt = txt.replace(/^Repo: [^.]+\.\s*/, '');
            const focus = txt.match(/YOUR MODULE: (\S+)/);
            if (focus) txt = 'build ' + focus[1];
            if (txt) label = cleanPreview(txt, 60);
          } catch {}
          items.push({ t: nowT, kind: 'spawn', id: k.id, label, type: 'workflow-agent' });
        }
        if (st.size > k.lastSize) { k.lastSize = st.size; k.lastGrow = Date.now(); }
        else if (!k.done && Date.now() - k.lastGrow > AGENT_IDLE_MS) {
          k.done = true;
          items.push({ t: nowT, kind: 'despawn', id: k.id });
        }
      }
    }
    return items;
  }
}
function* walkJsonl(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(p);
    else if (e.name.endsWith('.jsonl') && e.name !== 'journal.jsonl') yield p;
  }
}

// ---------- SSE ----------
function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    // CORS (loopback-only) is set upstream by guard(); never `*` here.
  });
  return (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

// An id that is not a tailable Claude session is either unknown (404) or a
// session from a source that CANNOT be streamed (501). BE HONEST ABOUT
// STREAMING: the tail above is an incremental Claude JSONL reader — Codex,
// Hermes and OpenClaw have no incremental reader behind them, so their rows are
// archive-only and this endpoint refuses them with a message that names the
// supported path rather than a bare failure.
function refuseOrNotFound(id, res) {
  const notFound = () => {
    try {
      if (!res.headersSent) res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('no session');
    } catch { /* client already gone */ }
  };
  if (!id) { notFound(); return; }
  nonClaudeSessions().then((rows) => {
    const row = rows.find((r) => String(r.id) === id || r.libraryId === id);
    if (!row) { notFound(); return; }
    res.writeHead(501, { 'Content-Type': 'text/plain' });
    res.end(
      `live streaming is not supported for ${row.sourceLabel} sessions.\n` +
      `The SSE tail is an incremental Claude Code JSONL reader; the ${row.source} adapter ` +
      `can only read a session in one pass, so there is nothing honest to tail.\n` +
      `Use archive playback instead:  npm run build-library   then open  /?session=${row.libraryId}\n`);
  }).catch(notFound);
}

// ---------- request handling (shared with tools/cspace.mjs) ----------
// Returns a handler(req, res) -> boolean: true if the request was one of the
// tail endpoints (/sessions, /stream) and has been handled, false otherwise.
export function createTailHandler() {
  let activeStreams = 0;   // per-handler concurrent SSE count (see MAX_STREAMS)

  // Fire-and-forget: tell the operator, once, what each non-Claude store on this
  // machine contributes (counts only). Deliberately here rather than at module
  // load so importing this file for its exports (adapters, tests) stays silent.
  void reportSourceCoverage();

  // SAFETY NET. Everything below runs inside an http request callback, where an
  // uncaught throw does not just fail the request — it takes the whole runner
  // process down, after "C-SPACE ONLINE" and (worse) after a 200 header, so the
  // visitor sees an empty success and a dead server. Individual fs calls are
  // guarded at their call sites; this catches whatever still slips through
  // (parser bugs, malformed transcripts) and turns it into a 500.
  function handleTail(req, res) {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`); } catch { return false; }
    if (url.pathname !== '/sessions' && url.pathname !== '/stream') return false;
    if (!guard(req, res)) return true;   // loopback Host/Origin gate
    try {
      return serve(url, req, res);
    } catch (e) {
      console.error(`[cspace] ${url.pathname} failed: ${e?.stack ?? e}`);
      try {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('internal error');
      } catch { /* client already gone */ }
      return true;
    }
  }

  function serve(url, req, res) {
    if (url.pathname === '/sessions') {
      // Async because non-Claude sources are reached through a lazily-imported
      // adapter registry. Its own rejection path is handled inside
      // listAllowedSessions (degrades to Claude-only), so this only has to
      // cover a write to an already-closed socket.
      listAllowedSessions().then((all) => {
        // `path`/`dbPath` are absolute filenames — they leak the OS username and
        // home layout, and no frontend reads them. Strip them from the wire; the
        // internal row keeps them for the tail (and for build-library/adapters).
        const rows = all.slice(0, 40).map(({ path, dbPath, ...row }) => row);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows));
      }).catch((e) => {
        console.error(`[cspace] /sessions failed: ${e?.stack ?? e}`);
        try {
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('internal error');
        } catch { /* client already gone */ }
      });
      return true;
    }

    if (url.pathname === '/stream') {
      if (activeStreams >= MAX_STREAMS) {
        res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '5' });
        res.end('too many streams');
        return true;
      }
      const sessions = listSessions();
      const id = url.searchParams.get('id');
      const target = id ? sessions.find(s => s.id === id) : sessions.find(s => s.active) ?? sessions[0];
      // Only Claude sessions can be tailed. If the id names an allowed session
      // from another source, say so plainly instead of 404-ing or — worse —
      // pretending to stream something we can only read in one shot.
      if (!target) { refuseOrNotFound(id, res); return true; }

      activeStreams++;
      let alive = true;
      let iv = null;
      // idempotent, and registered before anything can throw, so the stream slot
      // is always released (a leaked slot would eventually 503 every client)
      const cleanup = () => {
        if (!alive) return;
        alive = false;
        if (iv) clearInterval(iv);
        activeStreams--;
      };
      req.on('close', cleanup);

      try {
        const send = sse(res);
        const parser = new SessionParser(target.id);
        const tail = new Tail(target.path);
        const agents = new AgentWatcher(join(PROJECTS, target.project, target.id));

        // full replay of what exists now
        const backlog = [];
        for (const line of tail.read()) backlog.push(...parser.feed(line));
        send('snapshot', {
          meta: parser.snapshotMeta(), tools: parser.toolsObject(),
          project: target.project, live: true, items: backlog,
        });

        iv = setInterval(() => {
          if (!alive) return;
          // A timer callback is outside handleTail's try/catch, so it needs its
          // own: an uncaught throw here would be fatal to the process.
          try {
            const items = [];
            for (const line of tail.read()) items.push(...parser.feed(line));
            items.push(...agents.poll(parser.lastT));
            if (items.length) send('items', { items, tools: parser.toolsObject(), meta: parser.snapshotMeta() });
            else send('ping', { t: Date.now() });
          } catch (e) {
            console.error(`[cspace] stream tail stopped for ${target.id}: ${e?.stack ?? e}`);
            cleanup();
            try { res.end(); } catch { /* client already gone */ }
          }
        }, POLL_MS);
      } catch (e) {
        cleanup();
        throw e;
      }
      return true;
    }

    return false;
  }

  return handleTail;
}

// ---------- standalone mode (`npm run live`) ----------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // Loopback by default — transcripts are sensitive and the caller gate above
  // assumes a loopback-only listener. CSPACE_HOST widens the bind (e.g. to
  // 0.0.0.0) and is deliberately an explicit opt-in; do not set it unless you
  // accept exposing transcript content to your network. (HARNESS_VIZ_HOST is
  // the pre-rename name, still honoured silently for one release.)
  const HOST = process.env.CSPACE_HOST || process.env.HARNESS_VIZ_HOST || '127.0.0.1';

  // CSPACE_TAIL_PORT overrides the default; on a collision walk up to 10 ports
  // rather than dying with a raw EADDRINUSE stack (same behaviour as cspace.mjs).
  const envPort = parseInt(process.env.CSPACE_TAIL_PORT ?? '', 10);
  const BASE_PORT = Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535 ? envPort : PORT;
  if (process.env.CSPACE_TAIL_PORT && BASE_PORT !== envPort) {
    console.error(`[live-server] ignoring invalid CSPACE_TAIL_PORT=${process.env.CSPACE_TAIL_PORT} — using ${BASE_PORT}`);
  }

  const handleTail = createTailHandler();
  const server = createServer((req, res) => {
    if (handleTail(req, res)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  function listen(port, attemptsLeft) {
    // paired once-listeners: whichever fires first detaches the other, so a
    // failed attempt's stale 'listening' callback can never fire on a retry
    const onError = (err) => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
        console.log(`[live-server] port ${port} busy — trying ${port + 1}`);
        listen(port + 1, attemptsLeft - 1);
      } else {
        console.error(`[live-server] failed to bind ${HOST}:${port}: ${err.message}`);
        process.exit(1);
      }
    };
    const onListening = () => {
      server.off('error', onError);
      if (port !== BASE_PORT) console.log(`[live-server] port ${BASE_PORT} was busy — port ${port} won`);
      console.log(`[live-server] tailing ~/.claude/projects on http://localhost:${port} — /sessions, /stream?id=`);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  }

  listen(BASE_PORT, 10);
}
