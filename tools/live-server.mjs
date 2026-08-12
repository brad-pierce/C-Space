#!/usr/bin/env node
// live-server.mjs — tails live Claude Code sessions and streams viz items over SSE.
//
//   GET /sessions            → JSON list of recently-active sessions
//   GET /stream?id=<uuid>    → SSE: full replay of the session so far, then live tail
//                              (omit id → most recently modified active session)
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
      const j = JSON.parse(readFileSync(p, 'utf8'));
      const arr = Array.isArray(j) ? j : j.allow;
      if (Array.isArray(arr)) return arr.filter((s) => typeof s === 'string' && s);
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
  return [];
}
const ALLOWED_PROJECTS = loadAllowlist();
const projectAllowed = (proj) =>
  ALLOWED_PROJECTS.some(a => proj === a || proj.startsWith(a + '--claude-worktrees'));

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

// ---------- request handling (shared with tools/cspace.mjs) ----------
// Returns a handler(req, res) -> boolean: true if the request was one of the
// tail endpoints (/sessions, /stream) and has been handled, false otherwise.
export function createTailHandler() {
  let activeStreams = 0;   // per-handler concurrent SSE count (see MAX_STREAMS)

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
      // `path` is the absolute transcript filename — it leaks the OS username
      // and home layout, and no frontend reads it. Strip it from the wire; the
      // internal row keeps it for the tail (and for build-library/adapters).
      const rows = listSessions().slice(0, 40).map(({ path, ...row }) => row);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
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
      if (!target) { res.writeHead(404); res.end('no session'); return true; }

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
