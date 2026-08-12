// fleetMain.js — FLEET VIEW orchestrator (page 2 of C-SPACE). Builds the
// shared ctx, owns the roster poll and every SSE stream, mounts the five fleet
// modules, runs the render loop. Modules are sandboxed exactly like the main
// page: a module that throws at init or update is disabled and logged, never
// fatal.
//
// CTX CONTRACT (what the fleet modules read) ----------------------------------
//   ctx = {
//     THREE, scene, camera, renderer,
//     PALETTE, CSS, LAYOUT, CONTEXT_TOKEN_CAP, TOOL_COLORS, toolFamily, CHRONO,
//     params, quality,
//     roster,       — /sessions array [{id,project,path,sizeMB,mtime,active}],
//                     server order (mtime desc, actives first); null until the
//                     tail server answers (fleetHud shows OFFLINE on null).
//                     Slot order everywhere = first-seen roster order, so the
//                     array is only ever REPLACED wholesale, never reordered
//                     in place.
//     streams,      — Map(id → LiveTimeline), active sessions only, hard cap 4
//                     (MAX_STREAMS). fleetMain owns tick(); modules only read
//                     (.events growth, .contextAt(duration), .subagents).
//     cityLayout,   — published by cityLayout.init() (slotFor/padSizeFor/…);
//                     init order below guarantees it exists before machines,
//                     fleetCamera, or fleetHud run.
//     fade,         — { out(cb[,s]), in([s]) } eased black-overlay dive/ascend
//                     handshake, published by fleetInteract.init(). Dives set
//                     sessionStorage cspaceFade=1 before navigating; a page
//                     that boots with the key set clears it and fades in.
//   }
//   update(dt, ctx) — fleet modules are signature-tolerant; this page passes
//   the ctx bag as the second argument.
// -----------------------------------------------------------------------------

import * as THREE from 'three';
import {
  PALETTE, CSS, LAYOUT, CONTEXT_TOKEN_CAP, TOOL_COLORS, toolFamily, CHRONO,
} from '../lib/palette.js';
import { LiveTimeline } from '../lib/liveTimeline.js';

import cityLayout from './cityLayout.js';
import machines from './machines.js';
import fleetCamera from './fleetCamera.js';
import fleetInteract from './fleetInteract.js';
import fleetHud from './fleetHud.js';

// Init order is contract: cityLayout publishes ctx.cityLayout first;
// fleetInteract publishes ctx.fade before fleetHud runs.
const MODULES = [cityLayout, machines, fleetCamera, fleetInteract, fleetHud];

const LIVE_SERVER = 'http://localhost:5198';
const ROSTER_POLL_MS = 5000;   // /sessions refresh cadence
const MAX_STREAMS = 4;         // concurrent SSE cap (spec)

// Tail discovery mirrors src/main.js: same-origin first (the cspace.mjs runner
// serves /sessions and /stream on the page's own port), then the standalone
// dev tail on localhost:5198. The base that answers is remembered for /stream.
let tailBase = null;           // '' = same-origin; null = not discovered yet

async function fetchRosterFrom(base) {
  const r = await fetch(base + '/sessions');
  if (!r.ok) throw new Error('roster HTTP ' + r.status);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('roster payload is not a list');
  return j;
}

async function fetchRoster() {
  if (tailBase !== null) return fetchRosterFrom(tailBase);
  for (const base of ['', LIVE_SERVER]) {
    try {
      const roster = await fetchRosterFrom(base);
      tailBase = base;
      return roster;
    } catch { /* try next */ }
  }
  throw new Error('tail unreachable (same-origin and ' + LIVE_SERVER + ')');
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const SHOT_MODE = params.get('freeze') === '1';

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  document.getElementById('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.void);

  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 900);
  camera.position.set(0, 32, 40);     // fleetCamera owns the pose from frame one
  camera.lookAt(0, 2, 0);

  const ctx = {
    THREE, scene, camera, renderer,
    PALETTE, CSS, LAYOUT, CONTEXT_TOKEN_CAP, TOOL_COLORS, toolFamily, CHRONO,
    params, quality: params.get('q') ?? 'high',
    roster: null,
    streams: new Map(),
  };

  // Roster before module init so the district builds on frame one. A down
  // tail server leaves roster null (fleetHud shows OFFLINE); the poll below
  // keeps retrying and modules pick the roster up at their ~1 Hz resyncs.
  try { ctx.roster = await fetchRoster(); }
  catch (e) { console.warn('[fleet] tail server unreachable at boot:', e.message); }
  ctx.tailBase = tailBase;   // '' = same-origin, string = explicit base, null = undiscovered

  // ---- SSE stream lifecycle -------------------------------------------------
  const sources = new Map();   // id → EventSource (parallel to ctx.streams)

  function openStream(id) {
    const es = new EventSource(`${tailBase ?? LIVE_SERVER}/stream?id=${encodeURIComponent(id)}`);
    sources.set(id, es);
    es.addEventListener('snapshot', (e) => {
      try {
        ctx.streams.set(id, new LiveTimeline(JSON.parse(e.data)));
      } catch (err) { console.warn('[fleet] bad snapshot for', id, err); }
    });
    es.addEventListener('items', (e) => {
      const tl = ctx.streams.get(id);
      if (!tl) return;
      try {
        const d = JSON.parse(e.data);
        tl.ingest(d.items ?? []);
        tl.updateAggregates(d.tools, d.meta);
      } catch { /* skip malformed frame */ }
    });
    es.onerror = () => {
      // EventSource auto-reconnect would replay the full backlog into the same
      // timeline (double ingest). Close instead; the next reconcile reopens
      // with a fresh LiveTimeline.
      es.close();
      sources.delete(id);
      ctx.streams.delete(id);
    };
  }

  function reconcileStreams() {
    const roster = ctx.roster ?? [];
    const want = [];
    for (const s of roster) {
      if (s.active && want.length < MAX_STREAMS) want.push(String(s.id));
    }
    for (const [id, es] of sources) {
      if (!want.includes(id)) {
        es.close();
        sources.delete(id);
        ctx.streams.delete(id);
      }
    }
    for (const id of want) if (!sources.has(id)) openStream(id);
  }

  reconcileStreams();
  setInterval(async () => {
    try { ctx.roster = await fetchRoster(); }
    catch { /* keep the last good roster; fleetHud flags offline on its own */ }
    ctx.tailBase = tailBase;
    reconcileStreams();
  }, ROSTER_POLL_MS);

  // ---- modules --------------------------------------------------------------
  const active = [];
  for (const m of MODULES) {
    try { await m.init(ctx); active.push(m); }
    catch (e) { console.error(`[fleet] module "${m.name}" failed init — disabled`, e); }
  }

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    for (const m of active) { try { m.resize?.(innerWidth, innerHeight); } catch {} }
  });

  // ---- render loop ----------------------------------------------------------
  const clock = new THREE.Clock();
  let settleFrames = 0;

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.1);
    // fleetMain owns time: advance every live timeline once per frame.
    for (const tl of ctx.streams.values()) tl.tick(dt);
    for (const m of active) {
      try { m.update(dt, ctx); }
      catch (e) {
        console.error(`[fleet] module "${m.name}" failed update — disabled`, e);
        active.splice(active.indexOf(m), 1);
      }
    }
    renderer.render(scene, camera);
    if (SHOT_MODE && ++settleFrames === 30) {
      window.__SHOT_READY = true;   // critique pipeline waits for this
      document.title = 'SHOT_READY';
    }
    requestAnimationFrame(frame);
  }

  document.getElementById('boot')?.classList.add('done');
  window.__FLEET = ctx;   // debug handle
  frame();
}

// Import-clean under plain node (module discipline): boot only in a browser.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  boot().catch((e) => {
    console.error('[fleet] boot failed', e);
    const b = document.getElementById('boot');
    if (b) b.textContent = 'BOOT FAILURE // ' + e.message;
  });
}
