// main.js — orchestrator. Loads session data, builds the shared context, mounts
// every module, runs the render loop. Modules are sandboxed: a module that
// throws at init or update is disabled and logged, never fatal.
//
// MODULE CONTRACT ------------------------------------------------------------
// Each file in src/modules/ default-exports:
//   {
//     name: 'environment',
//     init(ctx)            — build objects, add to ctx.scene. May return a promise.
//     update(dt, state, ctx) — advance animation. state = Timeline.tick() frame:
//        { vt, progress, done, fired[], context{ctx,cacheRead,cacheWrite,fresh,out},
//          activeSubagents[] }
//     resize?(w, h)        — optional
//     reset?(ctx)          — OPTIONAL. Called after ctx.session/ctx.timeline have
//        been replaced by a session swap (see SESSION SWAP CONTRACT below). The
//        module must dispose every session-shaped GPU resource it created
//        (geometry.dispose(), material.dispose(), texture.dispose(), remove
//        meshes from ctx.scene) and rebuild from the new session, or update in
//        place. Modules with no session-shaped state may omit it. A module that
//        throws in reset is disabled like any other failure.
//        Also: a module that keeps an events cursor / prefix / running-total
//        state (hud's ticker index, contextStack's slab prefix sums, anything
//        that walks timeline.events or timeline.vts incrementally) MUST rebuild
//        it — the new timeline starts at vt 0 with cursor 0 and a different
//        events array, so a carried-over cursor indexes the wrong session.
//   }
// ctx = { THREE, scene, camera, renderer, session, timeline, PALETTE, CSS, LAYOUT,
//         TOOL_COLORS, toolFamily, CHRONO, CONTEXT_TOKEN_CAP, params, quality,
//         playing — { mode: 'live'|'archive'|'attract', base, sessionId, project }
//                   what is on screen and where it streams from (hud reads it;
//                   attract.js is active only when mode === 'attract'),
//         setComposer(fn) — post module installs its render fn here,
//         pick — interaction registry (see below),
//         swapSession(target) — in-place session swap (see below),
//         state — shared UI state: { filterTool: string|null } }
// Camera module owns ctx.camera positioning. Post module owns final render call.
//
// IMPORTANT for module authors: ctx.session, ctx.timeline AND ctx.playing are
// REBINDABLE — a swap replaces all three with new objects rather than mutating
// them. Read them through ctx at use time (ctx.timeline.seek(...),
// ctx.playing.sessionId), or re-read them in reset(). A reference captured in
// init() into module-local state is stale the moment a swap happens. main.js's
// own frame loop obeys this rule: it calls ctx.timeline.tick(dt) every frame and
// holds no timeline local.
// STABLE across a swap (safe to capture once): ctx.scene, ctx.camera,
// ctx.renderer, ctx.pick (and its entries Map), ctx.state, ctx.params, and every
// palette/layout constant.
//
// INTERACTION CONTRACT:
//   ctx.pick.register(object3D, spec) where spec = {
//     kind: 'totem'|'drone'|'slab'|'chronogram'|...,
//     recursive?: boolean,           — raycast into descendants
//     card?: (hit) => ({ title, lines: [[label, value], ...] }) — hover card
//     onClick?: (hit) => void,
//     onHover?: (hit|null) => void,  — null on hover end
//   }
//   interact.js owns the raycaster/cards and reads this registry every frame.
//   ctx.state.filterTool: modules dim non-matching content when set.
//   ctx.state.frozen: F-key study freeze — timeline paused and the camera held
//     under manual control (no idle-revert to cinematic). cameraRig owns it.
//
// SESSION SWAP CONTRACT (attract advance without a page load) -----------------
// PROBLEM this exists to solve: attract used to advance between playlist entries
// with location.replace(), so every entry was a full page reload — visible
// stutter, and the SomaFM <audio> element was destroyed and had to re-buffer
// from scratch. A swap keeps the page (and therefore the audio element, the
// WebGL context, the renderer, and the audio module's whole graph) alive.
//
//   ctx.swapSession(target) -> Promise<boolean>
//     target = { session: '<id>' | null, attract: boolean }
//       session: a library session id, or null for the flagship (/data/session.json)
//       attract: true keeps program rotation alive (playing.mode 'attract'),
//                false plays it as an ordinary archive. Forced false under
//                ?freeze=1 — attract must stay inert in shot mode.
//     resolves true when the new session is on screen, false when the swap was
//     refused (one already in flight) or the load failed.
//
//   WHAT IT DOES, in order:
//     1. refuse if a swap is in flight (returns false — the caller retries later)
//     2. fetch + parse the new session, build a new Timeline. On ANY failure:
//        log, leave the session currently on screen completely untouched,
//        resolve false. Nothing is mutated before the load succeeds.
//     3. carry transport state across the cut — timeline.speed (hud's rail) and
//        timeline.playing (cameraRig's F freeze) — so a swap never silently
//        un-freezes or resets playback speed
//     4. rebind ctx.session / ctx.timeline / ctx.playing to the new objects
//     5. clear main.js-owned session-shaped state (ctx.state.filterTool — the
//        old session's tool may not exist in the new one)
//     6. call reset?.(ctx) on every active module, in MODULES order; a module
//        that throws is spliced out of the active list and logged, exactly like
//        an update failure
//     7. prune the ctx.pick entries that existed BEFORE the reset pass and are
//        no longer attached to ctx.scene (interact.js raycasts registered
//        objects DIRECTLY, not via the scene — an orphaned entry would keep
//        scoring hits on disposed geometry). Entries a reset() just registered
//        are never touched, so register-then-add ordering is safe. Then re-adopt
//        module chips into the #chips row.
//     8. release the swap latch; the frame loop resumes on the next rAF
//
//   WHAT IT DOES NOT DO: it never navigates, never recreates the renderer /
//   scene / camera, never re-inits modules, and never touches the audio module.
//   Audio needs no reset hook by construction — the page survives, so the
//   HTMLAudioElement keeps streaming across the cut and the WebAudio graph keeps
//   its nodes. (Its tool→pan table stays keyed to the boot session's tool ring;
//   that is a deliberate non-goal, not an oversight.)
//
//   THE FRAME LOOP IDLES DURING A SWAP: no tick, no module update, no draw —
//   the canvas holds its last presented frame while modules dispose and rebuild
//   (drawing mid-teardown is how you render a disposed geometry). The clock
//   delta keeps being consumed each idle frame, so the first live frame after a
//   swap gets a normal dt instead of the whole load gap.
//
//   ARCHIVE ONLY. Going live (or to the fleet) still navigates: those transitions
//   change the data source, not just the session, and a fresh boot is the honest
//   way to re-run discovery.
//
//   window.__CSPACE_SWAP === ctx.swapSession — verification/debug handle.
//
// URL PARAM SEMANTICS (mode routing, highest precedence first):
//   ?live=1|<id>   — stream a running session; on stream failure falls back to
//                    plain archive (never attract — explicit intent is respected).
//   ?freeze=1      — deterministic shot mode. Attract is always inert here:
//                    mode stays 'archive' even if &attract=1 is also present.
//   ?session=<id>  — archive playback of a library session. mode 'archive'.
//   ?session=<id>&attract=1 — the same archive pipeline plays the session, but
//                    mode is 'attract' so attract.js keeps rotating the program
//                    (advance / live interrupt). Identity chrome shows the
//                    session label normally — SEAMLESS by user ruling: no title
//                    cards, no attract chrome. NOTE: advancing between playlist
//                    entries no longer goes through this URL — it is an in-place
//                    ctx.swapSession (see SESSION SWAP CONTRACT above). This
//                    shape survives as a deep link: "start attract HERE".
//   (none of the above) — live-first boot: fleet.html at 2+ active sessions,
//                    live at exactly 1; otherwise the ARCHIVE FALLBACK plays
//                    the flagship with mode 'attract' — the machine dreams
//                    when the fleet sleeps. A bare ?attract=1 behaves
//                    identically (live always outranks attract).
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import { PALETTE, CSS, LAYOUT, CONTEXT_TOKEN_CAP, TOOL_COLORS, toolFamily, CHRONO } from './lib/palette.js';
import { Timeline } from './lib/timeline.js';
import { LiveTimeline } from './lib/liveTimeline.js';

import environment from './modules/environment.js';
import chronogram from './modules/chronogram.js';
import core from './modules/core.js';
import contextStack from './modules/contextStack.js';
import totems from './modules/totems.js';
import drones from './modules/drones.js';
import cameraRig from './modules/cameraRig.js';
import interact from './modules/interact.js';
import post from './modules/post.js';
import hud from './modules/hud.js';
import library from './modules/library.js';
import audio from './modules/audio.js';
import zoomRail from './modules/zoomRail.js';
import attract from './modules/attract.js';

// attract registers last: its identity normalization needs hud's DOM at init
const MODULES = [environment, chronogram, core, contextStack, totems, drones, cameraRig, interact, post, hud, library, audio, zoomRail, attract];

const params = new URLSearchParams(location.search);
const SHOT_MODE = params.get('freeze') === '1';

// Session ids from the URL flow straight into fetch() paths and location
// navigation. Constrain them to the id shape (uuid-like: alnum, dash,
// underscore) so a crafted ?session/?live can't traverse ('../'), inject a
// path segment, or open-redirect. Rejected values are treated as absent.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const validId = (v) => typeof v === 'string' && SESSION_ID_RE.test(v);
// Numeric params (?t seek, ?speed) must be finite or a NaN silently poisons the
// timeline; fall back to a default and clamp speed to a sane range.
const finiteOr = (v, dflt) => { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : dflt; };

const LIVE_SERVER = 'http://localhost:5198';
const ROSTER_TIMEOUT_MS = 1500;
const ROSTER_POLL_MS = 15_000;

// Fetch the session roster from a tail base ('' = same-origin). Throws on
// timeout, HTTP error, or non-roster payload (e.g. an SPA index fallback).
async function fetchRoster(base) {
  const ac = new AbortController();
  const bail = setTimeout(() => ac.abort(), ROSTER_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/sessions`, { signal: ac.signal });
    if (!res.ok) throw new Error(`roster HTTP ${res.status}`);
    const roster = await res.json();
    if (!Array.isArray(roster)) throw new Error('roster payload is not a list');
    return roster;
  } finally { clearTimeout(bail); }
}

// Discover the working tail base: same-origin first (deployed posture), then
// the dev tail server on localhost:5198. The base that answers /sessions is
// remembered and reused for /stream. Returns { base, roster } or null.
async function discoverTail() {
  for (const base of ['', LIVE_SERVER]) {
    try { return { base, roster: await fetchRoster(base) }; } catch { /* try next */ }
  }
  return null;
}

// Open an SSE stream against a tail base and wrap it in a LiveTimeline.
// id '' streams the server's default (most recently active) session.
async function openLiveStream(base, id) {
  const qs = id ? `?id=${encodeURIComponent(id)}` : '';
  const es = new EventSource(`${base}/stream${qs}`);
  const snapshot = await new Promise((resolve, reject) => {
    const fail = (err) => { clearTimeout(bail); es.close(); reject(err); };
    const bail = setTimeout(() => fail(new Error('live server timeout')), 5000);
    es.addEventListener('snapshot', (e) => {
      clearTimeout(bail);
      es.onerror = null; // from here on, EventSource auto-reconnect handles drops
      resolve(JSON.parse(e.data));
    });
    es.onerror = () => fail(new Error('live server unreachable'));
  });
  const timeline = new LiveTimeline(snapshot);
  es.addEventListener('items', (e) => {
    const d = JSON.parse(e.data);
    timeline.ingest(d.items);
    timeline.updateAggregates(d.tools, d.meta);
  });
  return { session: timeline.session, timeline, snapshot };
}

// LIVE-FIRST ROSTER WATCH (single-live mode only): poll the roster, publish it
// on window.__CSPACE_ROSTER, and if the watched session goes idle while another
// is active, hop to that one.
function watchRoster(base, watchedId) {
  const iv = setInterval(async () => {
    let roster;
    try { roster = await fetchRoster(base); } catch { return; } // transient — keep polling
    window.__CSPACE_ROSTER = roster;
    const watched = roster.find(s => s.id === watchedId);
    if (watched?.active) return;
    const next = roster.find(s => s.active); // roster is mtime-desc: most recent active
    if (next) {
      clearInterval(iv);
      const q = new URLSearchParams(location.search);
      q.set('live', next.id);
      location.replace(`${location.pathname}?${q}`);
    }
  }, ROSTER_POLL_MS);
}

// ARCHIVE LOADER — the data-loading half of a session load, extracted so a
// session can be loaded AGAIN after boot (ctx.swapSession). Fetches a parsed
// session (library id, or the flagship when pick is null), builds a fresh
// Timeline, and returns the { session, timeline, playing } triple in
// archive/attract shape. THROWS on fetch / HTTP / parse failure — the caller owns
// the fallback: bootTimeline tries a tail replay and then the bundled synthetic
// demo (/demo/session.json), swapSession keeps the session already on screen.
// Pure data + Timeline: no DOM, no GL, no module contact.
async function loadArchiveSession(pick, attract) {
  const url = pick ? `/data/library/${pick}.json` : '/data/session.json';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`archive HTTP ${res.status}`);
  const session = await res.json();
  return { session, timeline: new Timeline(session), playing: {
    mode: attract ? 'attract' : 'archive', base: null, sessionId: pick ?? null, project: null,
  } };
}

async function bootTimeline() {
  // ATTRACT ELIGIBILITY (Phase C): true when ?attract=1 rides an archive load
  // (attract continuing between playlist entries) or when the live-first boot
  // below finds nothing to stream. Never in shot mode — attract must stay
  // inert under ?freeze=1 (attract.js checks as well; belt and suspenders).
  let attract = params.get('attract') === '1' && !SHOT_MODE;

  // EXPLICIT LIVE MODE (?live=1 or ?live=<sessionId>): stream a running session
  // from the tail server — same-origin when it answers, else the localhost:5198
  // dev fallback. Falls back to the archived session with a console warning if
  // the tail server is down.
  const live = params.get('live');
  if (live && validId(live)) {
    try {
      const base = (await discoverTail())?.base ?? LIVE_SERVER;
      const id = live === '1' ? '' : live;
      const { session, timeline, snapshot } = await openLiveStream(base, id);
      return { session, timeline, playing: {
        mode: 'live', base,
        sessionId: id || (snapshot.meta?.sessionId ?? null),
        project: snapshot.project ?? null,
      } };
    } catch (err) {
      console.warn('[c-space] live mode unavailable, falling back to archive:', err.message);
    }
  }

  // LIVE-FIRST BOOT (no explicit mode param — no ?session/?live/?freeze):
  // discover the tail, read the roster, and route — fleet when 2+ sessions are
  // active, live when exactly one is, archive attract otherwise.
  if (!params.has('live') && !params.has('session') && !params.has('freeze')) {
    const tail = await discoverTail();
    window.__CSPACE_ROSTER = tail?.roster ?? [];
    const activeSessions = tail ? tail.roster.filter(s => s.active) : [];
    if (activeSessions.length >= 2) {
      location.replace('/fleet.html');
      return new Promise(() => {}); // navigating away — never resolve
    }
    if (activeSessions.length === 1) {
      const target = activeSessions[0];
      try {
        const { session, timeline, snapshot } = await openLiveStream(tail.base, target.id);
        watchRoster(tail.base, target.id);
        return { session, timeline, playing: {
          mode: 'live', base: tail.base, sessionId: target.id,
          project: target.project ?? snapshot.project ?? null,
        } };
      } catch (err) {
        attract = true;
        console.info('[c-space] live-first: stream failed — archive fallback, attract mode:', err.message);
      }
    } else {
      attract = true;
      console.info(`[c-space] live-first: ${tail ? 'no active sessions' : 'tail unreachable'} — archive fallback, attract mode`);
    }
  }

  // ?demo=1 — play the bundled synthetic session explicitly, even on a machine
  // that has its own data. It is the only session safe to screenshot or screen-
  // share (nothing in it came from a real transcript), so the README stills and
  // any demo recording are reproducible by anyone with the repo.
  if (params.get('demo') === '1') {
    try {
      const res = await fetch('/demo/session.json');
      if (!res.ok) throw new Error(`demo HTTP ${res.status}`);
      const session = await res.json();
      return { session, timeline: new Timeline(session), playing: {
        mode: SHOT_MODE ? 'archive' : 'attract', base: null,
        sessionId: null, project: session.meta?.cwd ?? 'demo',
      } };
    } catch (err) {
      console.warn('[c-space] ?demo=1 requested but the bundled demo is unavailable:', err.message);
    }
  }

  // ARCHIVE MODE: ?session=<id> loads a parsed session from the library,
  // default remains the flagship session. mode 'attract' plays the
  // same pipeline but hands program rotation to attract.js (see header).
  const rawPick = params.get('session');
  const pick = validId(rawPick) ? rawPick : null;
  try {
    return await loadArchiveSession(pick, attract);
  } catch (err) {
    // FRESH-MACHINE FALLBACK: a new clone ships no parsed data (the store lives
    // is gitignored). If a tail server is reachable, replay its most recent
    // allowlisted session instead of dying — first run works with zero setup.
    console.info('[c-space] no archive data:', err.message, '— trying tail replay');
    const tail = await discoverTail();
    if (tail && tail.roster.length) {
      const { session, timeline, snapshot } = await openLiveStream(tail.base, '');
      return { session, timeline, playing: {
        mode: 'live', base: tail.base,
        sessionId: snapshot.meta?.sessionId ?? null, project: snapshot.project ?? null,
      } };
    }
    // BUNDLED SYNTHETIC DEMO: last resort before failing. A fresh clone has no
    // parsed data AND no allowlist, so both sources above come up empty and the
    // first-time visitor used to get a black BOOT FAILURE screen. public/demo/
    // ships a fabricated-but-structurally-real session (tools/make-demo.mjs,
    // `npm run demo`) — committed, safe to screenshot, contains nothing from any
    // real transcript. Plays through the ordinary archive pipeline; attract
    // eligibility is whatever the boot decided, so ?freeze=1 still gets an inert
    // 'archive' and the default boot gets a rotating 'attract'.
    try {
      const res = await fetch('/demo/session.json');
      if (!res.ok) throw new Error(`demo HTTP ${res.status}`);
      const session = await res.json();
      console.info('[c-space] no local sessions — playing the bundled synthetic demo');
      return { session, timeline: new Timeline(session), playing: {
        mode: attract ? 'attract' : 'archive', base: null, sessionId: null, project: null,
      } };
    } catch (demoErr) {
      console.warn('[c-space] bundled demo unavailable:', demoErr.message);
    }

    // Every source empty, demo included. On a fresh clone this is nearly always a
    // missing allowlist (gitignored, per-machine) rather than missing parsed data,
    // so lead with that — the previous wording sent people down the parse path.
    throw new Error(
      'NO SESSIONS. The project allowlist is per-machine and not in git, so a fresh ' +
      'clone exposes nothing. Run "npm run allowlist", move your projects into ' +
      '"allow" in cspace.allowlist.json, then "npm run build-library && npm run build".');
  }
}

async function boot() {
  // The boot triple is consumed straight into ctx below and then released: ctx
  // holds the only bindings, so a session swap cannot leave a stale copy behind
  // (nor keep the boot session's event arrays alive). See SESSION SWAP CONTRACT.
  let initial = await bootTimeline();

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  document.getElementById('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.void);

  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 900);
  camera.position.set(0, 14, 46);
  camera.lookAt(0, LAYOUT.coreY, 0);

  const pickEntries = new Map();
  // Declared ahead of ctx so swapSession (which closes over both) can never hit
  // a temporal-dead-zone reference, even if a module called it from init().
  const active = [];
  let swapping = false;     // swap latch: one at a time, frame loop idles while true
  let settleFrames = 0;     // shot-mode settle counter — per-session, reset on swap

  const ctx = {
    THREE, scene, camera, renderer,
    session: initial.session, timeline: initial.timeline, playing: initial.playing,
    PALETTE, CSS, LAYOUT, CONTEXT_TOKEN_CAP, TOOL_COLORS, toolFamily, CHRONO,
    params, quality: params.get('q') ?? 'high',
    composerRender: null,
    setComposer(fn) { ctx.composerRender = fn; },
    pick: {
      entries: pickEntries,
      register(obj, spec) { pickEntries.set(obj, spec); },
      unregister(obj) { pickEntries.delete(obj); },
    },
    swapSession,
    state: { filterTool: null, frozen: false },
  };
  initial = null;   // ctx owns it now — drop the boot-session reference

  // adopt any self-positioned top-center chips into the shared #chips flex row
  // (index.html) — overlap between module chips is structurally impossible there.
  // Runs after init and again after every swap (a module that rebuilds its chip
  // in reset() re-parents it into #hud, and would otherwise float free).
  function adoptChips() {
    const chipRow = document.getElementById('chips');
    if (!chipRow) return;
    for (const el of document.querySelectorAll('#hud .audiox-chip, #hud [data-hud-chip]')) {
      chipRow.appendChild(el);
    }
  }

  // interact.js raycasts every registered object DIRECTLY (intersectObject per
  // entry), not by walking the scene — so an entry whose object a reset()
  // detached would keep scoring hover hits on disposed geometry. Drop any entry
  // from `keys` (the registry as it stood BEFORE the reset pass) that is no
  // longer rooted at ctx.scene. Entries still in the scene — module chrome that
  // outlives the session — keep their registration untouched, and entries
  // registered DURING the reset pass are never considered, so a module that
  // registers before it calls scene.add() is not punished for the ordering.
  function pruneOrphanPicks(keys) {
    let dropped = 0;
    for (const obj of keys) {
      if (!pickEntries.has(obj)) continue;      // the module unregistered it itself
      let root = obj;
      while (root.parent) root = root.parent;
      if (root !== scene) { pickEntries.delete(obj); dropped++; }
    }
    return dropped;
  }

  // IN-PLACE SESSION SWAP — the full contract lives in the header. Never
  // navigates, never rebuilds the renderer, never touches audio.
  async function swapSession(target) {
    if (swapping) {
      console.warn('[c-space] swapSession: a swap is already in flight — ignored');
      return false;
    }
    const t = target ?? {};
    // Same id hardening as the URL params: a value that is not id-shaped is
    // treated as absent (→ flagship), never spliced into the fetch path.
    const pick = validId(t.session) ? t.session : null;
    const wantAttract = !!t.attract && !SHOT_MODE;
    const label = pick ?? 'flagship';

    // ARCHIVE ONLY (see header). Swapping out of live is out of contract: the
    // EventSource opened at boot has no close handle here, so it would keep
    // streaming into a LiveTimeline nothing reads. Warn loudly rather than leak
    // silently — live/fleet transitions are supposed to navigate.
    if (ctx.playing?.mode === 'live') {
      console.warn('[c-space] swapSession called while live — the live stream stays open;' +
        ' live transitions should navigate, not swap');
    }

    swapping = true;                      // latch BEFORE the first await
    try {
      // 1. Load first, mutate nothing. A failed load must leave the session
      //    currently on screen exactly as it was.
      let next;
      try {
        next = await loadArchiveSession(pick, wantAttract);
      } catch (err) {
        console.warn(`[c-space] swapSession: load failed for ${label} — keeping current session:`,
          err.message);
        return false;
      }

      // 2. Carry transport state across the cut: a hud-picked speed and a
      //    cameraRig study freeze both outlive the session they were set on.
      const prev = ctx.timeline;
      next.timeline.speed = prev?.speed ?? 1;
      next.timeline.playing = prev?.playing ?? true;

      // 3. Rebind. From here on every ctx.timeline/ctx.session read is the new
      //    session — which is why modules must read through ctx, not a local.
      ctx.session = next.session;
      ctx.timeline = next.timeline;
      ctx.playing = next.playing;

      // 4. main.js-owned session-shaped state. filterTool names a tool from the
      //    old session's ring that may not exist in the new one; the settle
      //    counter belongs to the session it was counting for.
      ctx.state.filterTool = null;
      settleFrames = 0;

      // 5. Module resets, MODULES order, sandboxed exactly like update().
      //    Iterate a copy: a thrower is spliced out of `active` mid-pass.
      const picksBefore = [...pickEntries.keys()];
      for (const m of [...active]) {
        if (typeof m.reset !== 'function') continue;
        try { m.reset(ctx); }
        catch (e) {
          console.error(`[c-space] module "${m.name}" failed reset — disabled`, e);
          const i = active.indexOf(m);
          if (i >= 0) active.splice(i, 1);
        }
      }

      // 6. Post-reset housekeeping on the registries main.js owns.
      const dropped = pruneOrphanPicks(picksBefore);
      adoptChips();

      console.info(`[c-space] session swapped in place → ${label}` +
        ` (mode ${ctx.playing.mode}, ${ctx.timeline.events.length} events` +
        `${dropped ? `, ${dropped} orphan pick${dropped === 1 ? '' : 's'} pruned` : ''})`);
      return true;
    } finally {
      swapping = false;                   // frame loop resumes on the next rAF
    }
  }

  for (const m of MODULES) {
    try { await m.init(ctx); active.push(m); }
    catch (e) { console.error(`[c-space] module "${m.name}" failed init — disabled`, e); }
  }

  adoptChips();

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    for (const m of active) { try { m.resize?.(innerWidth, innerHeight); } catch {} }
  });

  // Shot mode: deterministic frame for the critic. ?freeze=1&t=<vt>&cam=<n>
  if (SHOT_MODE) {
    const tl = ctx.timeline;                 // boot-time only — no swap can run yet
    tl.playing = false;
    tl.seek(finiteOr(params.get('t'), 90));
    // fire everything up to the seek point in one batch so state is consistent
    const preState = { ...stateAt(tl), fired: tl.events.slice(0, tl.cursor) };
    for (const m of active) { try { m.update(0, preState, ctx); } catch (e) { console.error(m.name, e); } }
  }

  // ?speed / ?t apply to the BOOT session. A later swap carries the live speed
  // forward (see swapSession step 2) and always starts the new session at vt 0 —
  // re-seeking to ?t on every attract advance would be a surprise, not a feature.
  ctx.timeline.speed = Math.min(Math.max(finiteOr(params.get('speed'), 1), 0), 16);
  if (params.get('t') && !SHOT_MODE) ctx.timeline.seek(finiteOr(params.get('t'), 0));

  const clock = new THREE.Clock();

  function frame() {
    requestAnimationFrame(frame);           // first: an idle/failed frame never kills the loop
    const dt = Math.min(clock.getDelta(), 0.1);

    // A swap is in flight: ctx.timeline/ctx.session are mid-replacement and
    // modules may be disposing GPU resources. Idle completely — no tick, no
    // update, no draw (drawing mid-teardown is how you render a disposed
    // geometry); the canvas holds its last presented frame. The delta above is
    // still consumed every idle frame, so the first live frame after the swap
    // resumes with a normal dt instead of the whole load gap.
    if (swapping) return;

    // ctx.timeline is read fresh every frame — never a captured local, or an
    // in-place swap would keep ticking the session that is no longer on screen.
    const state = ctx.timeline.tick(SHOT_MODE ? 0 : dt);
    for (const m of active) {
      try { m.update(SHOT_MODE ? 0.016 : dt, state, ctx); }
      catch (e) {
        console.error(`[c-space] module "${m.name}" failed update — disabled`, e);
        active.splice(active.indexOf(m), 1);
      }
    }
    if (ctx.composerRender) ctx.composerRender(dt);
    else renderer.render(scene, camera);

    if (SHOT_MODE && ++settleFrames === 30) {
      window.__SHOT_READY = true;   // playwright waits for this
      document.title = 'SHOT_READY';
    }
    // (the next frame was already scheduled at the top of this one)
  }

  document.getElementById('boot').classList.add('done');
  window.__HARNESS = ctx;                 // debug handle
  window.__CSPACE_SWAP = ctx.swapSession; // verification handle — see header
  frame();
}

function stateAt(tl) {
  return {
    vt: tl.vt, progress: tl.vt / tl.duration, done: false, fired: [],
    context: tl.contextAt(tl.vt),
    activeSubagents: tl.subagents.filter(s => s.spawnVt <= tl.vt && s.endVt > tl.vt),
  };
}

boot().catch(e => {
  console.error('[c-space] boot failed', e);
  document.getElementById('boot').textContent = 'BOOT FAILURE // ' + e.message;
});
