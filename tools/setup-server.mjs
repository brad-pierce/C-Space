// setup-server.mjs — the in-app setup surface: /setup/state, /setup/allow,
// /setup/deny, /setup/build. Mounted by the runner (tools/cspace.mjs) and, with
// its own per-run token, by the Vite dev server (vite.config.js).
//
// THIS IS THE ONE PLACE THE SERVER STOPPED BEING READ-ONLY ABOUT ITS OWN
// CONFIGURATION, so read the fences before the routes:
//
//  F1 PER-RUN TOKEN. Every mutation carries X-CSpace-Setup-Token, compared with
//     timingSafeEqual after an explicit length check. The token exists only in
//     this process's memory, only for this run, and reaches the page ONLY by
//     HTML injection (tools/setup-token.mjs) — no endpoint returns it.
//
//     F1 NOW COVERS READS TOO, and this is the one deviation from the contract's
//     §4.4 ("token optional") that is deliberate. Enumeration returns the labels
//     of projects the operator has NOT opted in to — that is the whole point of a
//     setup panel — so an unauthenticated GET /setup/state would hand every local
//     process a list of every project on the machine. Before this round nothing
//     over HTTP could enumerate a non-allowlisted project; leaving the read open
//     would have quietly retired that property. So:
//
//       · with a valid token  ⇒ the full document (labels, ids, lastActiveAt);
//       · without one         ⇒ 200 with the SAME envelope, degraded to counts
//         and storePresent. No labels, no ids, no lastActiveAt, no flagship id.
//
//     Never a 404 for the token-less case: 404 means "this surface does not
//     exist" (F3) and would make the panel stop offering setup altogether. The
//     honest answer is "it exists, you may not see inside it", which is what
//     `authenticated:false, detail:'counts'` says.
//
//  F2 BOUNDED VERBS. The wire carries `allow` / `deny` / `build` and opaque ids.
//     NO REQUEST FIELD IS, CONTAINS, OR BUILDS A FILESYSTEM PATH. An id is 24
//     characters of keyed digest; the only thing done with it is Map.get on a
//     map this server built from its OWN scan one millisecond earlier, and the
//     (source, project) pair that comes out goes to allowlist-store's bounded
//     verbs, which take no path either. There is no code path from request
//     bytes to join()/open()/readdir() — traversal is not validated against, it
//     is unrepresentable.
//
//  F3 LOOPBACK-ONLY, AUTO-OFF. Bound off loopback ⇒ the factory returns a
//     handler that declines everything and /setup/* 404s like any unknown path.
//     Per request: loopback socket peer, loopback Host, same-origin. Any miss ⇒
//     404 with the static server's exact body. NEVER 403 — a 403 advertises
//     that there is something here to attack.
//
//  F4 NO ALLOW-ALL. Nothing here can write a "*": allowlist-store refuses the
//     literal, and the unlabelled-sessions row (whose allowlist meaning IS the
//     source's "*") is refused for `allow` rather than quietly expanded.
//
//  F5 The panel (not this file) states that ingesting parses transcripts into a
//     derived copy on disk. This file's job is to make `dataDir` visible so the
//     panel can name it.
//
//  F6 NO PROJECT NAMES ON THE CONSOLE, EVER — including from error handlers and
//     child output. Labels go to the local page (the operator has to see what
//     they are ticking) and nowhere else. Error BODIES carry a code and a short
//     name-free message; never a label, never a path.

import { createHash } from 'node:crypto';
import { statSync, readFileSync, existsSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { sep, dirname } from 'node:path';
import { ID_RE, projectId, tokenValid } from './setup-token.mjs';
import { dehome } from '../src/lib/paths.js';
import { DATA_DIR, INDEX_FILE } from './cspace-paths.mjs';
import { reloadAllowlist } from './live-server.mjs';
import {
  KNOWN_SOURCES, readAllowlist, resolveAllowlistPath,
  wildcardInEffect, coveredByBroaderEntry, applyAllowlistOps,
} from './allowlist-store.mjs';
import { startBuild, buildStatus, isBuildRunning } from './build-runner.mjs';

export { injectSetupBootstrap, setupBootstrap } from './setup-token.mjs';

const MAX_BODY = 16 * 1024;          // 16 KiB, enforced WHILE reading — never buffered past it
const MAX_IDS = 200;
const RATE_LIMIT = 30;               // mutations per minute, per process
const READ_RATE_LIMIT = 240;         // GET /setup/state per minute (panel polls at 1 Hz)
const RATE_WINDOW_MS = 60_000;

// Same loopback policy as live-server.mjs's guard(), by construction — one
// policy in the codebase, not two that can drift.
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i;
const LOOPBACK_PEER = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_BIND = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1']);

// "project" is a session title for these two, so ticking a row exposes the
// TITLE as well as the sessions under it. That is a fact about PROVENANCE, and
// it is the only thing this flag claims.
//
// DO NOT ADD 'codex' HERE. Codex labels are cwd basenames — genuinely folder
// names — and this flag would then be false about what a tick exposes. The real
// problem codex poses is that those basenames can READ as the operator's own
// questions on screen ("how-much-tax-do-i-owe-on"), which is a property of
// the strings, not of the source, and is measured where the strings are
// rendered: readsAsProse()/labelCaution() in src/modules/setup.js. A source
// whose labels happen to be tidy is not cautioned; one whose labels are prose
// is, whichever harness it came from. Keep the two signals separate.
const LABELS_ARE_TITLES = new Set(['hermes', 'openclaw']);

/** Is this resolved bind address loopback? The single source of truth for
 *  whether the setup surface exists at all (F3) — the runner uses it to decide
 *  what to inject, the factory uses it to decide what to mount. */
export const isLoopbackBind = (host) => LOOPBACK_BIND.has(String(host ?? '').trim());

// ---------------------------------------------------------------------------
// discovery, reached by LAZY DYNAMIC IMPORT
// ---------------------------------------------------------------------------
// live-server.mjs already demonstrates why a static import here is a trap (its
// adapter registry closes an import cycle when loaded statically), and a module
// that fails to load must degrade to "nothing to tick" rather than taking the
// runner down. Degrading is fail-CLOSED: with no enumeration there are no ids,
// so every mutation 404s.
//
// FAIL CLOSED, BUT NOT SILENTLY. Failing closed used to be indistinguishable
// from success-with-nothing-found: both produced `sources: []`, and the panel
// rendered §7.1, "no harness store was found on this machine" — an assertion
// about the operator's disk that the server had no evidence for and that was, on
// the machine this shipped to, simply false. So every enumeration now carries
// `discovery: 'ok' | 'unavailable'`:
//
//   'ok'          the scan ran; whatever it found (including nothing) is real.
//   'unavailable' the scan did not run — module missing, module threw, or it
//                 returned a shape this server does not recognise. The candidate
//                 list is empty because we could not look, NOT because the disk
//                 is empty. No ids resolve, so mutations still 404 (closed), and
//                 the panel gets to say "could not enumerate" instead of lying.
let discoveryPromise = null;
let discoveryScanWarned = false;
function discovery() {
  return (discoveryPromise ??= import('./setup-discovery.mjs').catch((e) => {
    // code only — never the specifier, never a message that could carry a path.
    console.warn(`[cspace] setup: project discovery unavailable (${e?.code ?? 'load failed'})`);
    return null;
  }));
}

// ---------------------------------------------------------------------------
// responses
// ---------------------------------------------------------------------------

// The runner's guard() sets a tight Access-Control-Allow-Origin for loopback
// cross-port dev fetches (:5199 → :5198). The setup surface is same-origin ONLY
// and must never carry a CORS header, so whatever guard() set is removed here.
function strip(res) {
  try {
    res.removeHeader('Access-Control-Allow-Origin');
    res.removeHeader('Vary');
  } catch { /* headers already sent */ }
}

// Byte-identical to the static server's miss. The setup surface answers this
// for "you are not local" as well as for "no such route": a caller must not be
// able to tell the two apart.
function notFound(res) {
  strip(res);
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

function sendJson(res, status, body, extra) {
  strip(res);
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(buf);
}

const fail = (res, status, error, message, extra) =>
  sendJson(res, status, { error, message }, extra);

// allowlist-store throws AllowlistError with a stable `.code`; fs failures come
// through as errno. Both are safe to surface — they are not names and not paths
// — and they are the single most useful thing about a failed write.
function failWrite(res, e) {
  const code = e?.code ?? 'EIO';
  if (code === 'wildcard-in-effect') {
    fail(res, 409, 'wildcard-in-effect',
      'this source is exposed by a wildcard — edit the config file to narrow it');
    return;
  }
  if (code === 'bad-argument' || code === 'bad-verb' || code === 'wildcard-not-writable') {
    fail(res, 400, 'bad-request', 'the requested change is not expressible here');
    return;
  }
  fail(res, 500, 'allowlist-write-failed', `could not write the allowlist (${code})`);
}

// ---------------------------------------------------------------------------
// display paths
// ---------------------------------------------------------------------------
// dataDir and allowlistPath are the only two paths that ever leave this server,
// they are display-only (no endpoint accepts them back), and they land in
// screenshots — so collapse the home prefix, which is what leaks the OS
// username and home layout. A path the operator set outside home is shown
// verbatim: they chose it, and hiding it would only confuse them.
// Was a private prefix-only copy of the home rule — the SIXTH in the codebase,
// and it leaked: stripping only the LEADING home dir leaves any later username
// occurrence intact, including Claude's own munged 'C--Users-<name>' segment
// that appears inside temp paths. dehome() already collapses every occurrence
// and every path shape, and tests/dehome.test.mjs pins exactly this case.
// One rule, one implementation.
const collapseHome = (p) => dehome(String(p ?? ''));

/** Can the config actually be written? Display-only, so the panel can say so up
 *  front instead of letting the operator tick fifteen boxes and then fail. */
function allowlistWritable() {
  const p = resolveAllowlistPath();
  try {
    accessSync(existsSync(p) ? p : dirname(p), constants.W_OK);
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// enumeration → the id map
// ---------------------------------------------------------------------------

class IdCollision extends Error {}

const UNAVAILABLE = { sources: [], discovery: 'unavailable' };

async function enumerate({ fresh }) {
  const mod = await discovery();
  if (!mod) return UNAVAILABLE;
  // §3.2: a mutation re-runs the enumeration FROM SCRATCH. Dropping the
  // discovery module's own 5s cache first is what makes "from scratch" true
  // through both layers.
  if (fresh) { try { mod.invalidateCandidates?.(); } catch { /* optional export */ } }
  let out;
  try {
    out = await mod.enumerateCandidates();
  } catch (e) {
    // A throw from the scan (an unreadable store, a locked SQLite file, a
    // missing export) must not 500 the state read — the panel still has to be
    // able to render, and a 500 tells it nothing about why. Warn ONCE, so a
    // 1 Hz poll cannot turn one broken store into a scrolling console.
    // Code only: an exception message here can carry a store path.
    if (!discoveryScanWarned) {
      discoveryScanWarned = true;
      console.warn(`[cspace] setup: project discovery failed (${e?.code ?? 'error'})`);
    }
    return UNAVAILABLE;
  }
  if (!out || !Array.isArray(out.sources)) return UNAVAILABLE;
  // setup-discovery.mjs documents enumerateCandidates() as "never throws" and
  // absorbs its own failures into `{ sources: [] }` — which, read naively here,
  // is indistinguishable from a clean scan of an empty machine and would put the
  // falsehood straight back. So honour a signal it reports about ITSELF if it
  // ever grows one; the pass-through costs nothing and means the two modules can
  // agree without this one having to guess.
  if (out.discovery === 'unavailable') return { sources: out.sources, discovery: 'unavailable' };
  // An empty `sources` from a scan that RAN is 'ok' — that is the honest "no
  // harness stores on this machine", and it is exactly the case the panel is
  // allowed to assert.
  return { sources: out.sources, discovery: 'ok' };
}

// Explicit = named in the config, as opposed to swept in by a "*". Mirrors the
// reader's matching exactly, including the fact that Claude entries also cover
// that project's worktrees and that Claude has no wildcard semantics at all.
function explicitlyAllowed(cfg, source, project) {
  if (typeof project !== 'string' || !project) return false;
  if (source === 'claude') {
    return cfg.claude.some((a) => a !== '*' && (project === a || project.startsWith(a + '--claude-worktrees')));
  }
  return (cfg.sources[source] ?? []).includes(project);
}

/**
 * Turn one enumeration into (a) the id→(source, project) map used to resolve
 * mutations and (b) the `sources` array of the state response.
 *
 * The map is built and consumed within a single request. It is never cached,
 * never persisted, and never accepted from the client — which is precisely why
 * an id from a previous process, or for a project that has since vanished,
 * resolves to nothing.
 */
function indexCandidates(cand, cfg) {
  const wildcards = {};
  for (const id of KNOWN_SOURCES) wildcards[id] = wildcardInEffect(cfg, id);

  const byId = new Map();
  const sources = [];
  for (const s of cand.sources ?? []) {
    const src = String(s.id ?? '');
    const wild = wildcards[src] === true;
    const projects = [];
    for (const p of s.projects ?? []) {
      const project = p.project ?? null;
      const id = projectId(src, project);
      // Two distinct keys digesting to one id would make that id ambiguous, and
      // acting on an ambiguous id is worse than refusing the whole request.
      if (byId.has(id)) throw new IdCollision();
      byId.set(id, { source: src, project });
      const explicit = explicitlyAllowed(cfg, src, project);
      projects.push({
        id,
        label: project,                        // null = the unlabelled bucket (§7.6)
        sessions: Number(p.sessions ?? 0),
        lastActiveAt: p.lastActiveAt ?? null,
        allowed: explicit || wild,
        viaWildcard: wild && !explicit,
        onThisMachine: p.onThisMachine !== false,
      });
    }
    sources.push({
      id: src,
      label: String(s.label ?? src),
      storePresent: s.storePresent === true,
      sessionsTotal: Number(s.sessionsTotal ?? 0),
      projectCount: projects.length,
      // A count, so it survives the token-less degradation below — it is what
      // lets an unauthenticated read still answer "is anything opted in yet?"
      // without naming a single thing.
      allowedCount: projects.reduce((n, p) => n + (p.allowed ? 1 : 0), 0),
      streamable: src === 'claude',            // the SSE tail is a Claude JSONL reader
      labelsAreTitles: LABELS_ARE_TITLES.has(src),
      projects,
    });
  }

  // Advisory only: the UI may use it to notice the candidate set moved under
  // it. The server never requires the client to send it back.
  const generation = 'g_' + createHash('sha256')
    .update([...byId.keys()].sort().join('\n'), 'utf8').digest('hex').slice(0, 8);

  return { byId, sources, wildcards, generation };
}

function libraryState() {
  try {
    const st = statSync(INDEX_FILE);
    const j = JSON.parse(readFileSync(INDEX_FILE, 'utf8'));
    const f = j?.flagship;
    return {
      exists: true,
      sessions: Array.isArray(j?.sessions) ? j.sessions.length : 0,
      builtAt: st.mtimeMs,
      flagship: f ? { id: f.id, source: f.source, toolCalls: f.toolCalls ?? null } : null,
    };
  } catch {
    return { exists: false, sessions: 0, builtAt: null, flagship: null };
  }
}

// ---------------------------------------------------------------------------
// the handler factory
// ---------------------------------------------------------------------------

/**
 * @param {{boundHost?: string, mutable?: boolean}} opts
 * @returns {(req, res) => boolean} true iff the request was handled here.
 *
 * A non-loopback bind returns a handler that declines EVERYTHING, so the routes
 * are never registered and /setup/* falls through to the static 404 — for the
 * local operator too. That is the intended auto-off (F3): a server reachable
 * from a network has no setup surface at all.
 */
export function createSetupHandler({ boundHost = '127.0.0.1', mutable = true } = {}) {
  if (!isLoopbackBind(boundHost)) return () => false;

  // sliding-window rate limits, per process. Mutations are capped tightly; reads
  // are capped loosely but ARE capped: GET /setup/state takes no token (that is
  // what makes the read-only degradation of §2.5 possible) and every call re-runs
  // a scan of the harness stores — directory walks and read-only SQLite opens.
  // An unauthenticated local endpoint that does filesystem work per request is an
  // amplifier, so give it a ceiling well above the panel's 1 Hz poll.
  const hits = [];
  const readHits = [];
  function windowOk(bucket, limit) {
    const now = Date.now();
    while (bucket.length && now - bucket[0] > RATE_WINDOW_MS) bucket.shift();
    if (bucket.length >= limit) return false;
    bucket.push(now);
    return true;
  }
  const rateOk = () => windowOk(hits, RATE_LIMIT);
  const readRateOk = () => windowOk(readHits, READ_RATE_LIMIT);

  function local(req) {
    // The Host check alone is not enough: a server mistakenly bound wide can be
    // reached by a remote peer that simply forges `Host: localhost`. Only the
    // socket-peer check catches that.
    if (!LOOPBACK_PEER.has(req.socket?.remoteAddress ?? '')) return false;
    const host = req.headers.host ?? '';
    if (!LOOPBACK_HOST.test(host)) return false;
    const origin = req.headers.origin;
    if (origin == null) return true;                       // same-origin request without Origin
    const proto = req.socket?.encrypted ? 'https' : 'http';
    return origin === `${proto}://${host}`;                // exact same-origin only
  }

  /**
   * The state document. Every mutation answers with a freshly recomputed copy of
   * it, so the UI has exactly one renderer.
   *
   * TWO DETAIL LEVELS, one envelope (see F1 at the top of this file).
   *
   * `authenticated:true` — the caller presented the per-run token — gets the
   * full document: project labels, wire ids, lastActiveAt, the flagship id.
   *
   * `authenticated:false` gets the same envelope with every per-project fact
   * removed: `projects: []` on every source, no `generation` (a digest over the
   * id set), no flagship id. What survives is counts and `storePresent` — enough
   * for the panel to know the surface exists and to render its read-only state
   * honestly, and not enough for `curl http://127.0.0.1:5173/setup/state` to
   * enumerate a machine's projects.
   *
   * `mutable` reports what THIS CALLER can do, so it is false without a token
   * even in a process that holds one: a page that renders live ticks it cannot
   * commit is worse than one that renders the read-only presentation. The reason
   * is in `authenticated` — a caller that expected write access and finds
   * `authenticated:false` is missing the header, not the surface.
   */
  async function state(extra, authenticated = true) {
    // Read the config FROM DISK on every call. It is a file the operator may be
    // hand-editing while the panel is open; reporting a startup snapshot would
    // show stale ticks and — worse — evaluate the "*" fence against a config
    // that no longer exists.
    const cfg = readAllowlist().config;
    const cand = await enumerate({ fresh: false });
    const { sources, wildcards, generation } = indexCandidates(cand, cfg);
    const base = {
      ok: true,
      mutable: authenticated ? mutable : false,
      authenticated,
      detail: authenticated ? 'full' : 'counts',
      // 'ok' | 'unavailable' — whether the scan behind `sources` actually ran.
      // Present at BOTH detail levels: it is a health signal, not a fact about
      // anybody's projects, and the panel needs it to choose between "no stores
      // found" and "could not enumerate".
      discovery: cand.discovery,
      dataDir: collapseHome(DATA_DIR),
      allowlistPath: collapseHome(resolveAllowlistPath()),
      allowlistWritable: allowlistWritable(),
      wildcards,
      build: buildStatus(),                 // counts and a code; never a label
    };

    if (!authenticated) {
      return {
        ...base,
        sources: sources.map((s) => ({
          id: s.id, label: s.label,          // the SOURCE's name ("Claude Code"),
          storePresent: s.storePresent,      // never a project's
          sessionsTotal: s.sessionsTotal,
          projectCount: s.projectCount,
          allowedCount: s.allowedCount,
          streamable: s.streamable,
          labelsAreTitles: s.labelsAreTitles,
          projects: [],                      // ← the whole point of this branch
        })),
        // Counts and an mtime. The flagship id is a real session id, so it is
        // withheld with everything else that identifies content.
        library: { ...libraryState(), flagship: null },
        ...extra,
      };
    }

    return { ...base, generation, sources, library: libraryState(), ...extra };
  }

  // ---- body reading, capped ----
  // Aborts the moment the cap is exceeded: the accumulator is dropped and every
  // further chunk is discarded, so a 20 KiB post never becomes 20 KiB of RAM.
  function readBody(req, res) {
    return new Promise((resolve) => {
      let len = 0;
      let chunks = [];
      let settled = false;
      req.on('data', (c) => {
        if (settled) return;
        len += c.length;
        if (len > MAX_BODY) {
          settled = true;
          chunks = null;
          fail(res, 413, 'too-large', 'request body too large');
          resolve(null);
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks));
      });
      req.on('error', () => {
        if (settled) return;
        settled = true;
        resolve(null);
      });
    });
  }

  /** Common preamble for the three mutations. Returns the parsed body, or null
   *  when it has already answered. */
  async function mutationBody(req, res) {
    // `mutable:false` means this process told the page `token:null` and promised
    // it a read-only surface (§2.5). Without this check the promise is only kept
    // because nothing currently constructs that combination — the routes would
    // still honour a valid token from a handler advertised as read-only. Make
    // the refusal structural rather than incidental.
    if (mutable !== true) {
      fail(res, 403, 'forbidden', 'the setup surface is read-only in this context');
      return null;
    }
    if (!tokenValid(req.headers['x-cspace-setup-token'])) {
      fail(res, 403, 'forbidden', 'setup token missing or invalid');
      return null;
    }
    const ct = String(req.headers['content-type'] ?? '').trim().toLowerCase();
    if (!ct.startsWith('application/json')) {
      fail(res, 415, 'unsupported-media-type', 'expected application/json');
      return null;
    }
    if (!rateOk()) {
      fail(res, 429, 'rate-limited', 'too many setup changes', { 'Retry-After': '60' });
      return null;
    }
    const raw = await readBody(req, res);
    if (raw == null) return null;                       // 413 already sent, or the socket died
    if (!raw.length) return {};
    try {
      const j = JSON.parse(raw.toString('utf8'));
      if (j == null || typeof j !== 'object' || Array.isArray(j)) {
        fail(res, 400, 'bad-request', 'expected a JSON object');
        return null;
      }
      return j;
    } catch {
      fail(res, 400, 'bad-request', 'malformed JSON');
      return null;
    }
  }

  /**
   * Resolve a wire id list against a FRESH enumeration and a FRESH config read.
   *
   * This is the whole of F2. `ids` are 24-character digests; `byId` was built
   * from this server's own scan on this request; resolution is Map.get. An id
   * that is not in that map — stale, from a previous process, invented — is a
   * 404, and the request writes nothing. All-or-nothing: a partially applied
   * tick list is a worse outcome than a rejected one.
   */
  async function resolveIds(res, body) {
    const ids = body?.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      fail(res, 400, 'bad-request', 'expected { ids: [ … ] }');
      return null;
    }
    if (ids.length > MAX_IDS) {
      fail(res, 400, 'bad-request', `at most ${MAX_IDS} ids per request`);
      return null;
    }
    for (const id of ids) {
      if (typeof id !== 'string' || !ID_RE.test(id)) {
        fail(res, 400, 'bad-request', 'malformed id');
        return null;
      }
    }
    const cfg = readAllowlist().config;
    const { byId, wildcards } = indexCandidates(await enumerate({ fresh: true }), cfg);
    const entries = [];
    for (const id of new Set(ids)) {
      const hit = byId.get(id);
      if (!hit) {
        fail(res, 404, 'unknown-id', 'no such project in the current scan');
        return null;
      }
      entries.push(hit);
    }
    return { entries, wildcards, cfg };
  }

  /** Hand a set of bounded ops to the one writer, then re-read. */
  async function commit(res, ops) {
    if (!ops.length) { sendJson(res, 200, await state({ changed: 0 })); return; }
    let out;
    try {
      out = await applyAllowlistOps(ops);
    } catch (e) {
      failWrite(res, e);
      return;
    }
    // The tail server derives every visibility decision from a binding loaded
    // once at startup, so without this the new config would not take effect
    // until a restart. Counts only — reloadAllowlist never logs and never names.
    try { reloadAllowlist(); } catch { /* a reload failure must not fail the write */ }
    try { (await discovery())?.invalidateCandidates?.(); } catch { /* optional export */ }
    sendJson(res, 200, await state({
      changed: out.changed, ...(out.migrated ? { migrated: true } : {}),
    }));
  }

  // ---- routes ----

  async function routeState(req, res) {
    // Unauthenticated but not unlimited: this route takes no token in its
    // token-less form and every call re-runs a scan of the harness stores —
    // directory walks and read-only SQLite opens. See readRateOk above.
    if (!readRateOk()) {
      fail(res, 429, 'rate-limited', 'too many state reads', { 'Retry-After': '60' });
      return;
    }
    // The token gates DETAIL, not existence (F1 at the top of this file). A
    // caller without it still gets 200 and the envelope — so the panel keeps
    // working, and §2.5's read-only degradation still has a surface to degrade
    // to — but the projects arrays come back empty. Names of projects the
    // operator has not opted in to are exactly what an allowlist exists to
    // withhold; handing them to any local process over an unauthenticated GET
    // would have been a new leak, not a continuation of an old one.
    const authenticated = tokenValid(req.headers['x-cspace-setup-token']);
    sendJson(res, 200, await state(undefined, authenticated));
  }

  async function routeAllow(req, res) {
    const body = await mutationBody(req, res);
    if (!body) return;
    const resolved = await resolveIds(res, body);
    if (!resolved) return;

    const ops = [];
    for (const e of resolved.entries) {
      // The unlabelled bucket cannot be ticked. Its allowlist meaning IS the
      // source's "*", and one checkbox that quietly exposes every project of a
      // store — including ones that do not exist yet — is exactly the allow-all
      // control this round refuses to build (F4). The file still honours a
      // hand-written "*"; the UI just never produces one.
      if (e.project == null) {
        fail(res, 400, 'bad-request',
          'unlabelled sessions can only be exposed by editing the config file directly');
        return;
      }
      if (resolved.wildcards[e.source]) continue;      // already exposed by "*" — nothing to add
      ops.push({ verb: 'allow', source: e.source, project: e.project });
    }
    await commit(res, ops);
  }

  async function routeDeny(req, res) {
    const body = await mutationBody(req, res);
    if (!body) return;
    const resolved = await resolveIds(res, body);
    if (!resolved) return;

    // A DENY THAT CANNOT SUCCEED MUST SAY SO. This is the verb that WITHDRAWS
    // exposure; answering 200 `changed:0` when the project stays visible is the
    // worst available failure mode, because the operator's evidence that the
    // untick worked is precisely that the request succeeded. Both refusals are
    // checked across ALL entries before any of them is applied, so a multi-id
    // request is never half-committed.
    for (const e of resolved.entries) {
      // Never rewrite a "*" into an enumerated list to satisfy one untick: that
      // silently changes what happens to FUTURE projects of that source, which
      // is a config decision, not a checkbox. Checked here as well as in the
      // writer so a multi-id request is refused before any of it is applied.
      if (resolved.wildcards[e.source]) {
        fail(res, 409, 'wildcard-in-effect',
          'this source is exposed by a wildcard — edit the config file to narrow it');
        return;
      }
      // The other way an untick evaporates: the project is exposed by an entry
      // that is not its own name. A Claude entry also covers that project's
      // worktrees ('<slug>--claude-worktrees…'), so removing the exact name —
      // which may not even be in the file — leaves the reader still exposing it.
      // Refuse, with a code the panel can turn into "the untick did not take
      // effect, and here is why", rather than a silent no-op.
      if (coveredByBroaderEntry(resolved.cfg, e.source, e.project)) {
        fail(res, 409, 'covered-by-broader-entry',
          'a broader allowlist entry still exposes this project — edit the config file to narrow it');
        return;
      }
    }
    const ops = resolved.entries
      .filter((e) => e.project != null)
      .map((e) => ({ verb: 'deny', source: e.source, project: e.project }));
    await commit(res, ops);
  }

  async function routeBuild(req, res) {
    const body = await mutationBody(req, res);
    if (!body) return;

    // Preconditions BEFORE anything is spawned.
    if (isBuildRunning()) {
      fail(res, 409, 'build-in-progress', 'a build is already running');
      return;
    }
    const cfg = readAllowlist().config;
    const anything = cfg.claude.length > 0 ||
      Object.values(cfg.sources).some((l) => Array.isArray(l) && l.length > 0);
    if (!anything) {
      // Do not spawn a child just to have it exit 2.
      fail(res, 409, 'nothing-allowed', 'no projects are allowed yet');
      return;
    }

    const handle = startBuild({ force: body.force === true });
    if (!handle?.ok) {
      // Lost a race with another request between the check above and here.
      fail(res, 409, handle?.code ?? 'build-in-progress', 'a build is already running');
      return;
    }

    // The progress stream IS the response. The token travels in a request
    // header, which EventSource cannot set, and putting a per-run secret in a
    // query string to satisfy EventSource would undo F1 — so the UI reads this
    // streaming body with fetch() instead.
    strip(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
    });

    // A client that disconnects (reload, panel closed) does NOT cancel the
    // build: breaking out of the iteration only unsubscribes this stream. The
    // child keeps running and GET /setup/state keeps reporting live counts —
    // that polling path is the documented recovery for a lost stream.
    let open = true;
    req.on('close', () => { open = false; });

    // Coalescing (≤10/s), the 10s heartbeat, the 30-minute timeout and the
    // guarantee of exactly one terminal event all belong to build-runner.mjs.
    // This loop only frames what it is given.
    for await (const { type, data } of handle) {
      if (!open) break;
      try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); }
      catch { open = false; break; }
    }
    try { res.end(); } catch { /* client already gone */ }
  }

  const ROUTES = {
    '/setup/state': { GET: routeState },
    '/setup/allow': { POST: routeAllow },
    '/setup/deny': { POST: routeDeny },
    '/setup/build': { POST: routeBuild },
  };

  return function handleSetup(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`).pathname;
    } catch { return false; }
    if (pathname !== '/setup' && !pathname.startsWith('/setup/')) return false;

    // F3, before anything else. Not local ⇒ this surface does not exist.
    if (!local(req)) { notFound(res); return true; }

    // OPTIONS is a 404, never a preflight answer. The mutations carry a custom
    // header, so they are never "simple" requests; with no preflight and no
    // CORS header, a cross-origin page cannot reach them at all.
    if (req.method === 'OPTIONS') { notFound(res); return true; }

    const route = ROUTES[pathname];
    if (!route) { notFound(res); return true; }

    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const fn = route[method];
    if (!fn) {
      fail(res, 405, 'method-not-allowed', 'wrong method for this route',
        { 'Allow': Object.keys(route).join(', ') });
      return true;
    }

    Promise.resolve()
      .then(() => fn(req, res))
      .catch((e) => {
        if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
        if (e instanceof IdCollision) {
          fail(res, 500, 'id-collision', 'ambiguous project id — refusing to act');
          return;
        }
        // Code only. An exception message here can carry a path.
        console.error(`[cspace] setup ${pathname} failed (${e?.code ?? 'error'})`);
        fail(res, 500, 'internal', 'internal error');
      });
    return true;
  };
}
