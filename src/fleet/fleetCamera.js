// fleetCamera.js — FLEET VIEW: owns ctx.camera. A slow cinematic drift over the
// machine district: an eased figure-eight (Lissajous 1:2) at 25–40u altitude
// with a gentle ground-level look-ahead, so the city slides under the lens like
// an aerial establishing shot that never ends. Manual override mirrors the main
// page's cameraRig feel exactly (same drag sensitivity, exponential wheel zoom,
// eased pursuit smoothing, 6s idle → 2.2s eased return to the drift, kept on
// phase). ?cam=0 (or ?freeze=1) freezes a deterministic high three-quarter
// overview computed to frame the whole district in the current frustum.
//
// FOCUS BEATS: when a live stream's timeline grows its subagents list (a spawn),
// the camera eases toward that machine for 3s — transit in, held close-orbit
// creep, transit back to the drift — rate-limited to one beat start per 10s.
// Streams are read via ctx.streams (LiveTimeline-ish: .subagents array grows on
// spawn); first sight of a stream primes silently so backlog history never
// steals the camera.
//
// STREET MODE: any of WASD / arrows engages a first-person fly-through from the
// CURRENT pose — no teleport, no snap; a beat or return in flight yields
// gracefully. Ground translation is heading-relative with eased acceleration to
// ~14 u/s cruise (SHIFT doubles it) and exponential glide on release; Q/E (or
// PageDown/PageUp) sink/rise; drag is smoothed-pursuit look (yaw free, pitch
// clamped); wheel is a decaying dolly along the look ray. Bounds are soft:
// motion into an edge fades across an eased band (altitude 2.5..55, district
// envelope r=160) — pushback, never a wall, never below the floor. ESC or 10s
// of zero input hands back to the drift with the same eased 2s return the idle
// path uses, re-entering the figure-eight on phase. A single self-owned chip in
// #hud announces the mode (200ms fades). Fully disabled under ?freeze=1/?cam=N
// so capture determinism is untouched; keys are ignored while a text input has
// focus and handled keys are preventDefault-ed so arrows never scroll.
//
// Every camera quantity is driven by a real one: flight extents fit the actual
// district bounds (ctx.cityLayout slots over the roster), the freeze preset's
// distance is solved from the district's bounding sphere and the live frustum,
// and beats aim at the true slot position of the machine that spawned.
//
// Contract-defensive (written while fleetMain.js was unpublished; adapters
// mirror src/fleet/machines.js so both modules agree on roster order, slot
// positions, and stream shapes). All state allocated in init(); the update
// loop allocates nothing. Import-clean under node — no DOM/GL at module scope.

import * as THREE from 'three';

// ---- drift tuning -----------------------------------------------------------
const DRIFT_SPEED = 0.048;     // rad/s of figure-eight phase (~130s per lap)
const DRIFT_WOBBLE = 0.35;     // sinusoidal phase modulation — never linear
const DRIFT_WOBBLE_HZ = 0.023;
const DRIFT_PHASE0 = 0.9;      // start mid-lobe: high oblique opening frame,
                               // never the degenerate straight-down over center
const ALT_BASE = 32.5;         // altitude breathes 25..40 (spec band, exactly)
const ALT_SWING = 7.5;
const ALT_RATE = 0.5;          // altitude phase = θ/2 → alternating high/low laps
const LOOK_LEAD = 0.16;        // rad of phase the look target flies ahead
const LOOK_Y = 2.2;            // look-ahead aims at machine mid-height
const LOOK_CENTER_PULL = 0.25; // look target blended toward district center
const MARGIN_X = 8, MARGIN_Z = 6; // flight overshoot past district edges
const MIN_AX = 16, MIN_BZ = 10;   // extents floor for a near-empty district
const BOUNDS_EASE = 0.8;       // 1/s — extents/pivot pursue roster growth

// ---- manual override — mirrors src/modules/cameraRig.js feel ----------------
const PIVOT_Y = 2.0;           // orbit/look height: machine mid-body
const IDLE_LEN = 6;            // s of no input before auto resumes (spec)
const RETURN_LEN = 2.2;        // s manual → drift ease-back
const ZOOM_MIN = 9, ZOOM_MAX = 95;
const ELEV_MIN = 0.06, ELEV_MAX = 1.45;
const DRAG_SENS = 0.005;       // rad per pixel — same hand as the main page
const WHEEL_SENS = 0.0012;     // exponential zoom, same curve
const MANUAL_SMOOTH = 8;       // eased pursuit rate (1/s)

// ---- focus beats ------------------------------------------------------------
const BEAT_IN = 1.0;           // eased transit toward the machine
const BEAT_HOLD = 2.0;         // close-orbit creep (IN+HOLD = the 3s of spec)
const BEAT_OUT = 1.2;          // eased transit back onto the drift path
const BEAT_MIN_GAP = 10;       // s between beat starts (spec rate limit)
const BEAT_R = 12, BEAT_R_IN = 10.5; // approach radius, eased push-in
const BEAT_EL = 0.5;           // rad above the machine's horizon
const BEAT_CREEP = 0.1;        // rad of azimuth drift across the hold
const WATCH_DT = 0.25;         // s between stream-growth sweeps

// ---- freeze preset (?cam=0) -------------------------------------------------
const FREEZE_AZ = Math.PI * 0.25;  // high three-quarter: +x/+z corner
const FREEZE_EL = 0.66;            // ~38° elevation
const FREEZE_FIT = 1.06;           // breathing room past exact frustum fit
const FREEZE_MIN_D = 28;
const FREEZE_LOOK_Y = 1.2;

// ---- street mode ------------------------------------------------------------
const ST_CRUISE = 14;          // u/s ground cruise (spec); SHIFT doubles it
const ST_SPRINT = 2;
const ST_VERT = 8.5;           // u/s rise/sink on Q/E — SHIFT boosts this too
const ST_ACCEL = 4.2;          // 1/s eased spin-up toward cruise — floaty-precise
const ST_DAMP = 2.7;           // 1/s exponential glide on release — never a step
const ST_PITCH_MIN = -0.35;    // rad, downward-positive: up-glance limit (spec)
const ST_PITCH_MAX = 0.9;      //                          down-stare limit (spec)
const ST_ALT_MIN = 2.5, ST_ALT_MAX = 55;   // flight ceiling/floor band (spec)
const ST_RADIUS = 160;         // district envelope from origin (spec)
const ST_EDGE_BAND = 24;       // horizontal eased-pushback band inside the ring
const ST_EDGE_BAND_Y = 6;      // vertical band against floor and ceiling
const ST_EDGE_PULL = 5;        // 1/s home-pull on any residual overshoot
const ST_FLOOR_HARD = 1.4;     // absolute invariant — never below the floor
const ST_WHEEL = 0.045;        // wheel deltaY → dolly u/s along the look ray
const ST_DOLLY_MAX = 34;       // u/s dolly speed cap
const ST_DOLLY_DAMP = 3.2;     // 1/s exponential dolly bleed-off
const ST_IDLE = 10;            // s of zero input → overview return (spec)
const ST_RETURN_LEN = 2.0;     // s eased handback to the drift (spec)
const ST_LOOK_DIST = 12;       // look-target throw — direction is what matters
const CHIP_FADE = 15;          // 1/s exponential chip opacity — ~200ms fades

// physical key → movement axis (layout-independent via e.code)
const ST_KEYS = {
  KeyW: 'f', ArrowUp: 'f',
  KeyS: 'b', ArrowDown: 'b',
  KeyA: 'l', ArrowLeft: 'l',
  KeyD: 'r', ArrowRight: 'r',
  KeyE: 'u', PageUp: 'u',
  KeyQ: 'd', PageDown: 'd',
};

const MAX_SLOTS = 48;          // mirror machines.js pool cap
const TAU = Math.PI * 2;

// ---- easing (no raw time-linear motion anywhere) ----------------------------
const lerp = (a, b, f) => a + (b - a) * f;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const smoother = (x) => { const c = clamp(x, 0, 1); return c * c * c * (c * (c * 6 - 15) + 10); };
const easeIO = (x) => {
  const c = clamp(x, 0, 1);
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
};

// ---- contract adapters (mirror machines.js exactly) -------------------------
function rosterOf(ctx) {
  const cands = [ctx?.roster, ctx?.sessions, ctx?.fleet?.roster, ctx?.fleet?.sessions];
  for (const c of cands) {
    if (Array.isArray(c)) return c;
    if (Array.isArray(c?.sessions)) return c.sessions;
  }
  return null;
}

function slotOf(ctx, i, out) {
  let p = null;
  try {
    if (typeof ctx?.cityLayout?.slotFor === 'function') p = ctx.cityLayout.slotFor(i);
    else if (Array.isArray(ctx?.cityLayout?.slots)) p = ctx.cityLayout.slots[i];
  } catch { /* fall through to grid */ }
  if (p) {
    if (Array.isArray(p)) return out.set(p[0] ?? 0, p.length > 2 ? p[1] : 0, p.length > 2 ? p[2] : p[1] ?? 0);
    if (Number.isFinite(p.x)) return out.set(p.x, Number.isFinite(p.y) ? p.y : 0, Number.isFinite(p.z) ? p.z : 0);
  }
  const col = i % 8, row = (i / 8) | 0;     // fallback: 8-wide city grid
  return out.set((col - 3.5) * 6, 0, (row - 2) * 6);
}

// Accept a LiveTimeline directly or wrapped ({timeline}/{tl}); need .subagents.
function timelineFrom(entry) {
  for (const t of [entry, entry?.timeline, entry?.tl]) {
    if (t && Array.isArray(t.subagents)) return t;
  }
  return null;
}

// ---- pose math (Cartesian: position + look target) --------------------------
function copyPose(dst, src) { dst.p.copy(src.p); dst.l.copy(src.l); }
function mixPose(out, a, b, f) {           // f arrives pre-eased
  out.p.lerpVectors(a.p, b.p, f);
  out.l.lerpVectors(a.l, b.l, f);
}
function applyPose(cam, pose) {
  cam.position.copy(pose.p);
  cam.lookAt(pose.l);
}

// ---- street mode helpers ----------------------------------------------------
// True while the keyboard belongs to a text field (none exist today — guarded
// anyway per spec). Runtime-only; wrapped so a headless ctx can never throw.
function typingTarget() {
  try {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
      el.isContentEditable === true;
  } catch { return false; }
}

// Forward ray from the street heading (pitch is downward-positive).
function streetLookDir(out) {
  const st = S.street;
  const cp = Math.cos(st.pitch);
  return out.set(Math.sin(st.yaw) * cp, -Math.sin(st.pitch), Math.cos(st.yaw) * cp);
}

// Engage from whatever pose is on screen RIGHT NOW — S.cur is the applied pose
// in every mode, so a drift frame, a mid-beat frame, or a mid-return frame all
// hand over seamlessly (the beat/return in progress simply yields).
function enterStreet() {
  const st = S.street, m = S.m, c = S.cur;
  const dx = c.l.x - c.p.x, dy = c.l.y - c.p.y, dz = c.l.z - c.p.z;
  const dh = Math.max(Math.hypot(dx, dz), 1e-4);
  st.yaw = Math.atan2(dx, dz);
  st.pitch = Math.atan2(-dy, dh);                       // may start past the clamp…
  st.yawT = st.yaw;
  st.pitchT = clamp(st.pitch, ST_PITCH_MIN, ST_PITCH_MAX); // …and eases into it
  st.vel.set(0, 0, 0);
  st.velT.set(0, 0, 0);
  st.dolly = 0;
  st.lastInput = S.t;
  S.beat.active = false;                                // beat in flight yields
  m.dragging = false;
  m.mode = 'street';
  S.chipT = 1;
}

// Hand back to the drift exactly like the idle path: eased return onto the
// live figure-eight, kept on phase — just with the street's 2s length.
function exitStreet() {
  const st = S.street, m = S.m;
  for (const k in st.keys) st.keys[k] = false;
  st.dolly = 0;
  m.dragging = false;          // ESC mid-drag: the grab dies with the mode
  m.mode = 'return';
  m.returnT = 0;
  m.returnLen = ST_RETURN_LEN;
  copyPose(S.retFrom, S.cur);
  S.chipT = 0;
}

// ---------------------------------------------------------------------------
let S = null; // module state bag — filled in init()

const makePose = () => ({ p: new THREE.Vector3(0, ALT_BASE, 30), l: new THREE.Vector3(0, LOOK_Y, 0) });

// The figure-eight in plan: x = ax·sinθ, z = bz·sin2θ; altitude breathes on θ/2
// so alternate laps fly high and low. Everything sinusoidal — velocity is never
// constant, and there is no seam anywhere on the loop.
function pathAt(theta, out) {
  const w = S.world;
  out.set(
    w.cx + w.ax * Math.sin(theta),
    ALT_BASE + ALT_SWING * Math.sin(theta * ALT_RATE + 1.1),
    w.cz + w.bz * Math.sin(theta * 2)
  );
}

function driftTheta(t) { return DRIFT_PHASE0 + DRIFT_SPEED * t + DRIFT_WOBBLE * Math.sin(t * DRIFT_WOBBLE_HZ); }

// Live drift pose at time t: position on the eight, look target flying a beat
// ahead at machine height, pulled toward the district center so the city never
// leaves the frame at the loop's extremes.
function driftPose(out, t) {
  const w = S.world;
  const theta = driftTheta(t);
  pathAt(theta, out.p);
  pathAt(theta + LOOK_LEAD, S.tmpA);
  out.l.set(
    lerp(S.tmpA.x, w.cx, LOOK_CENTER_PULL),
    LOOK_Y,
    lerp(S.tmpA.z, w.cz, LOOK_CENTER_PULL)
  );
}

// Beat pose at hold-progress s (0..1, pre-smoothed): a close three-quarter
// orbit of the spawning machine, approached from the camera's current bearing
// so the transit never whips across the district.
function beatPoseAt(out, s) {
  const b = S.beat;
  const az = b.az + BEAT_CREEP * s;
  const r = lerp(BEAT_R, BEAT_R_IN, s);
  const ch = Math.cos(BEAT_EL) * r, sh = Math.sin(BEAT_EL) * r;
  out.p.set(b.mx + Math.sin(az) * ch, b.my + sh + PIVOT_Y, b.mz + Math.cos(az) * ch);
  out.l.set(b.mx, b.my + lerp(1.9, 2.6, s), b.mz);
}

// District bounds from the occupied slots → drift extents, orbit pivot, and the
// freeze preset's bounding sphere. Called at ~0.5 Hz; targets are then eased.
function measureDistrict(ctx) {
  const w = S.world;
  const n = S.slotCount;
  if (n <= 0) return;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    slotOf(ctx, i, S.tmpA);
    if (S.tmpA.x < minX) minX = S.tmpA.x;
    if (S.tmpA.x > maxX) maxX = S.tmpA.x;
    if (S.tmpA.z < minZ) minZ = S.tmpA.z;
    if (S.tmpA.z > maxZ) maxZ = S.tmpA.z;
  }
  const halfX = Math.max((maxX - minX) / 2, 3), halfZ = Math.max((maxZ - minZ) / 2, 3);
  w.cxT = (minX + maxX) / 2;
  w.czT = (minZ + maxZ) / 2;
  w.axT = Math.max(halfX + MARGIN_X, MIN_AX);
  w.bzT = Math.max(halfZ + MARGIN_Z, MIN_BZ);
  w.radiusT = Math.hypot(halfX + 3, halfZ + 3) + 1.5; // +margin, columns are ~5u
}

// Roster order defines slot order (mirror machines.js: first build in roster
// order, late arrivals append). byId lets a spawn beat find its machine.
function syncRoster(ctx) {
  const roster = rosterOf(ctx);
  if (!roster) return;
  for (const sess of roster) {
    const id = String(sess.id);
    if (!S.slotById.has(id) && S.slotCount < MAX_SLOTS) {
      S.slotById.set(id, S.slotCount++);
    }
  }
}

// Watch ctx.streams timelines for subagent growth. First sight primes silently
// (backlog is history, not a live spawn); growth nominates a beat target.
function watchSpawns(ctx) {
  const s = ctx?.streams;
  if (!s) return null;
  let target = null;
  const scan = (id, entry) => {
    const tl = timelineFrom(entry);
    if (!tl) return;
    // an array-shaped ctx.streams keys by index — prefer the entry's own id
    const key = String(entry?.id ?? entry?.sessionId ?? id);
    const n = tl.subagents.length;
    const prev = S.subCounts.get(key);
    if (prev === undefined) { S.subCounts.set(key, n); return; }
    if (n > prev) {
      S.subCounts.set(key, n);
      if (S.slotById.has(key)) target = key;
    }
  };
  if (typeof s.forEach === 'function' && typeof s.get === 'function') {
    s.forEach((entry, id) => scan(id, entry));               // Map-like
  } else if (typeof s === 'object') {
    for (const id in s) scan(id, s[id]);                     // plain object
  }
  return target;
}

export default {
  name: 'fleetCamera',

  init(ctx) {
    let params = ctx?.params;
    if (!params) {
      try { params = new URLSearchParams(typeof location !== 'undefined' ? location.search : ''); }
      catch { params = new URLSearchParams(''); }
    }
    const camParam = params.get('cam');

    S = {
      ctx,
      t: 0,
      // ?cam=0 or ?freeze=1 → deterministic high 3/4 overview, no input, no
      // beats (only one fleet preset exists; any ?cam value lands on it)
      frozen: params.get('freeze') === '1' || (camParam !== null && camParam !== ''),
      world: {
        cx: 0, cz: 0, ax: 24, bz: 16, radius: 24,            // eased live values
        cxT: 0, czT: 0, axT: 24, bzT: 16, radiusT: 24,       // measured targets
      },
      slotById: new Map(), slotCount: 0,
      subCounts: new Map(),
      rosterT: 0, watchT: 0,
      // poses — everything allocated here, never per-frame
      cur: makePose(),        // pose actually applied last frame
      auto: makePose(),       // live drift pose, re-evaluated each frame
      beatFrom: makePose(),   // pose snapshot at beat start
      beatTo: makePose(),     // beat pose scratch
      retFrom: makePose(),    // snapshot at manual/street → drift handback
      tmpA: new THREE.Vector3(),
      tmpB: new THREE.Vector3(),
      beat: { active: false, t: 0, az: 0, mx: 0, my: 0, mz: 0 },
      lastBeatStart: -1e9,
      m: {
        mode: 'auto',          // 'auto' | 'manual' | 'return' | 'street'
        dragging: false, px: 0, py: 0, lastInput: -1e9,
        returnT: 0, returnLen: RETURN_LEN,
        az: 0, el: 0.5, rad: 40,     // smoothed spherical state around the pivot
        azT: 0, elT: 0.5, radT: 40,  // input targets
      },
      street: {
        keys: { f: false, b: false, l: false, r: false, u: false, d: false },
        shift: false,
        yaw: 0, pitch: 0,      // smoothed look state (pitch downward-positive)
        yawT: 0, pitchT: 0,    // drag targets — same pursuit hand as the orbit
        vel: new THREE.Vector3(),   // eased velocity, world space
        velT: new THREE.Vector3(),  // key-derived target velocity
        dolly: 0,              // wheel impulse, u/s along the look ray, decaying
        lastInput: -1e9,
      },
      chip: null, chipA: 0, chipT: 0,   // street affordance element + opacity
    };

    syncRoster(ctx);
    measureDistrict(ctx);
    // start on measured targets — no visible pop as the roster arrives
    const w = S.world;
    w.cx = w.cxT; w.cz = w.czT; w.ax = w.axT; w.bz = w.bzT; w.radius = w.radiusT;

    if (!S.frozen && ctx?.renderer?.domElement) this._bindInput(ctx);
    // Street mode is a live-interaction feature only — frozen captures (?cam=N,
    // ?freeze=1) never bind keys and never own a chip, so determinism holds.
    if (!S.frozen && typeof window !== 'undefined' && typeof document !== 'undefined') {
      this._bindKeys();
      this._makeChip(ctx);
    }
  },

  _bindInput(ctx) {
    const el = ctx.renderer.domElement;
    const m = S.m;
    const engage = () => {
      if (m.mode !== 'manual') {
        // capture the flight pose as spherical state around the district pivot
        const p = (S.ctx?.camera ?? ctx.camera).position, w = S.world;
        const dx = p.x - w.cx, dz = p.z - w.cz, dy = p.y - PIVOT_Y;
        const dh = Math.hypot(dx, dz);
        m.rad = clamp(Math.hypot(dh, dy), ZOOM_MIN, ZOOM_MAX);
        m.el = clamp(Math.atan2(dy, dh), ELEV_MIN, ELEV_MAX);
        m.az = Math.atan2(dx, dz);
        m.azT = m.az; m.elT = m.el; m.radT = m.rad;
        m.mode = 'manual';
        S.beat.active = false;      // grabbing the camera cancels any beat
      }
      m.lastInput = S.t;
    };
    el.addEventListener('pointerdown', (e) => {
      if (m.mode === 'street') {                             // street: drag = look
        m.dragging = true; m.px = e.clientX; m.py = e.clientY;
        S.street.lastInput = S.t;
        try { el.setPointerCapture(e.pointerId); } catch {}
        return;
      }
      engage();
      m.dragging = true; m.px = e.clientX; m.py = e.clientY;
      try { el.setPointerCapture(e.pointerId); } catch {}
    });
    el.addEventListener('pointermove', (e) => {
      if (!m.dragging) return;
      if (m.mode === 'street') {                             // same hand as orbit:
        const st = S.street;                                 // drag right → yaw -,
        st.yawT -= (e.clientX - m.px) * DRAG_SENS;           // drag down → pitch down
        st.pitchT = clamp(st.pitchT + (e.clientY - m.py) * DRAG_SENS,
          ST_PITCH_MIN, ST_PITCH_MAX);
        m.px = e.clientX; m.py = e.clientY;
        st.lastInput = S.t;
        return;
      }
      m.azT -= (e.clientX - m.px) * DRAG_SENS;               // grab semantics
      m.elT = clamp(m.elT + (e.clientY - m.py) * DRAG_SENS, ELEV_MIN, ELEV_MAX);
      m.px = e.clientX; m.py = e.clientY; m.lastInput = S.t;
    });
    const drop = () => { m.dragging = false; m.lastInput = S.t; S.street.lastInput = S.t; };
    el.addEventListener('pointerup', drop);
    el.addEventListener('pointercancel', drop);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (m.mode === 'street') {                             // street: wheel = dolly
        const st = S.street;                                 // along the look ray
        st.dolly = clamp(st.dolly - e.deltaY * ST_WHEEL, -ST_DOLLY_MAX, ST_DOLLY_MAX);
        st.lastInput = S.t;
        return;
      }
      engage();
      m.radT = clamp(m.radT * Math.exp(e.deltaY * WHEEL_SENS), ZOOM_MIN, ZOOM_MAX);
    }, { passive: false });
  },

  // Keyboard on window (spec): WASD/arrows engage + steer, Q/E and PageDown/
  // PageUp sink/rise, ESC exits. Handled keys preventDefault so arrows never
  // scroll; anything typed into a text field is ignored; browser shortcuts
  // (ctrl/alt/meta chords) pass through untouched.
  _bindKeys() {
    const st = S.street, m = S.m;
    addEventListener('keydown', (e) => {
      if (S.frozen || typingTarget()) return;
      if (e.code === 'Escape') {
        if (m.mode === 'street') { e.preventDefault(); exitStreet(); }
        return;
      }
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        st.shift = true;
        if (m.mode === 'street') st.lastInput = S.t;
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const bind = ST_KEYS[e.code];
      if (!bind) return;
      e.preventDefault();
      if (m.mode !== 'street') {
        // only a fresh press engages — auto-repeat from a key held across an
        // ESC exit must never instantly undo the handback to the drift
        if (e.repeat) return;
        enterStreet();
      }
      st.keys[bind] = true;
      st.shift = e.shiftKey;
      st.lastInput = S.t;
    });
    addEventListener('keyup', (e) => {
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { st.shift = false; return; }
      const bind = ST_KEYS[e.code];
      if (bind) { st.keys[bind] = false; st.lastInput = S.t; }
    });
    // focus loss with a key held (alt-tab) must never leave the camera flying
    addEventListener('blur', () => {
      for (const k in st.keys) st.keys[k] = false;
      st.shift = false;
      m.dragging = false;
    });
  },

  // The one self-owned DOM element (spec): a micro-type chip in #hud, inline-
  // styled from ctx.CSS, opacity-driven from update(). Purely an affordance —
  // a headless or hudless page just runs without it.
  _makeChip(ctx) {
    try {
      const C = ctx?.CSS ?? {};
      const host = document.getElementById('hud') ?? document.body;
      const el = document.createElement('div');
      el.id = 'fleet-street-chip';
      el.style.cssText = [
        'position:absolute', 'left:50%', 'bottom:22px', 'transform:translateX(-50%)',
        'padding:5px 12px',
        `color:${C.hudText ?? '#c8f7ff'}`,
        `border:1px solid ${C.hudDim ?? '#3a5a66'}`,
        'background:rgba(5,6,10,0.62)',
        'font-family:ui-monospace,Menlo,Consolas,monospace',
        'font-size:10px', 'letter-spacing:0.16em', 'text-transform:uppercase',
        'white-space:nowrap', 'pointer-events:none', 'user-select:none',
        'opacity:0',
      ].join(';');
      // Built via DOM APIs (no innerHTML) so the sink never parses markup,
      // regardless of where the palette color ever comes from.
      const label = document.createElement('span');
      label.style.color = C.gridGlow ?? '#19c6d1';
      label.textContent = 'STREET //';
      el.appendChild(label);
      el.appendChild(document.createTextNode(' WASD MOVE · DRAG LOOK · Q/E RISE · ESC OVERVIEW'));
      host.appendChild(el);
      S.chip = el;
    } catch { S.chip = null; }
  },

  update(dt, a, b) {
    if (!S) return;
    // signature-tolerant: (dt, state, ctx) or (dt, ctx) — find the ctx bag
    const ctx = (b && (b.camera || b.streams || b.THREE)) ? b
      : (a && (a.camera || a.streams || a.THREE)) ? a : S.ctx;
    S.ctx = ctx;
    const cam = ctx?.camera;
    if (!cam) return;
    S.t += dt;
    const t = S.t;
    const w = S.world;

    // ---- roster / district measurement (~0.5 Hz), eased pursuit --------------
    if ((S.rosterT -= dt) <= 0) {
      S.rosterT = 2.0;
      syncRoster(ctx);
      measureDistrict(ctx);
    }
    if (!S.frozen) {
      const k = 1 - Math.exp(-dt * BOUNDS_EASE);
      w.cx += (w.cxT - w.cx) * k; w.cz += (w.czT - w.cz) * k;
      w.ax += (w.axT - w.ax) * k; w.bz += (w.bzT - w.bz) * k;
    }

    // ---- ?cam=0: deterministic high three-quarter district overview ----------
    if (S.frozen) {
      // solve distance so the district's bounding sphere fits the live frustum
      const vHalf = ((cam.fov ?? 55) * Math.PI / 180) / 2;
      const hHalf = Math.atan(Math.tan(vHalf) * (cam.aspect || 1.6));
      const d = Math.max(FREEZE_MIN_D, (w.radiusT / Math.tan(Math.min(vHalf, hHalf))) * FREEZE_FIT);
      const ch = Math.cos(FREEZE_EL) * d, sh = Math.sin(FREEZE_EL) * d;
      S.cur.p.set(w.cxT + Math.sin(FREEZE_AZ) * ch, sh, w.czT + Math.cos(FREEZE_AZ) * ch);
      S.cur.l.set(w.cxT, FREEZE_LOOK_Y, w.czT);
      applyPose(cam, S.cur);
      return;
    }

    // ---- street chip fade (exponential ≈200ms; settles exactly, then sleeps) -
    if (S.chip && S.chipA !== S.chipT) {
      const ck = 1 - Math.exp(-dt * CHIP_FADE);
      let a = S.chipA + (S.chipT - S.chipA) * ck;
      if (Math.abs(a - S.chipT) < 0.004) a = S.chipT;
      S.chipA = a;
      S.chip.style.opacity = String(a);
    }

    // ---- spawn watch (primes silently; growth nominates a beat target) -------
    let spawnId = null;
    if ((S.watchT -= dt) <= 0) {
      S.watchT = WATCH_DT;
      spawnId = watchSpawns(ctx);
    }

    const m = S.m;

    // ---- street mode: first-person fly-through, everything eased -------------
    if (m.mode === 'street') {
      const st = S.street;
      const k = st.keys;

      // a held key or an active drag IS input — idle means truly hands-off
      if (k.f || k.b || k.l || k.r || k.u || k.d || m.dragging) st.lastInput = t;

      // desired velocity in the ground frame of the current heading:
      // forward (sinYaw, cosYaw), screen-right (-cosYaw, sinYaw)
      const boost = st.shift ? ST_SPRINT : 1;
      const fwd = (k.f ? 1 : 0) - (k.b ? 1 : 0);
      const str = (k.r ? 1 : 0) - (k.l ? 1 : 0);
      const sy = Math.sin(st.yaw), cy = Math.cos(st.yaw);
      let vx = sy * fwd - cy * str;
      let vz = cy * fwd + sy * str;
      const hl = Math.hypot(vx, vz);
      if (hl > 1e-6) {
        const sc = (ST_CRUISE * boost) / hl;                 // diagonals ride cruise too
        vx *= sc; vz *= sc;
      }
      const vy = ((k.u ? 1 : 0) - (k.d ? 1 : 0)) * ST_VERT * boost;
      st.velT.set(vx, vy, vz);

      // eased spin-up toward cruise, exponential glide on release — no steps
      const hasInput = fwd !== 0 || str !== 0 || vy !== 0;
      st.vel.lerp(st.velT, 1 - Math.exp(-dt * (hasInput ? ST_ACCEL : ST_DAMP)));

      // look: smoothed pursuit, the orbit manual mode's exact hand
      const lk = 1 - Math.exp(-dt * MANUAL_SMOOTH);
      st.yaw += (st.yawT - st.yaw) * lk;
      st.pitch += (st.pitchT - st.pitch) * lk;
      streetLookDir(S.tmpB);

      // wheel dolly rides the look ray and bleeds off exponentially
      st.dolly *= Math.exp(-dt * ST_DOLLY_DAMP);
      S.tmpA.copy(st.vel).addScaledVector(S.tmpB, st.dolly);

      // eased pushback: motion into an edge fades across the band — never a wall
      const p = S.cur.p;
      if (S.tmpA.y > 0) S.tmpA.y *= smoother((ST_ALT_MAX - p.y) / ST_EDGE_BAND_Y);
      else              S.tmpA.y *= smoother((p.y - ST_ALT_MIN) / ST_EDGE_BAND_Y);
      const rh = Math.hypot(p.x, p.z);
      if (rh > 1e-4) {
        const rx = p.x / rh, rz = p.z / rh;
        const out = S.tmpA.x * rx + S.tmpA.z * rz;
        if (out > 0) {                                       // only outbound motion fades
          const keep = smoother((ST_RADIUS - rh) / ST_EDGE_BAND);
          S.tmpA.x -= rx * out * (1 - keep);
          S.tmpA.z -= rz * out * (1 - keep);
        }
      }
      p.addScaledVector(S.tmpA, dt);

      // residual overshoot eases home; the floor itself is inviolable
      const pk = 1 - Math.exp(-dt * ST_EDGE_PULL);
      const rh2 = Math.hypot(p.x, p.z);
      if (rh2 > ST_RADIUS) {
        const s = 1 - (1 - ST_RADIUS / rh2) * pk;
        p.x *= s; p.z *= s;
      }
      p.y += (clamp(p.y, ST_ALT_MIN, ST_ALT_MAX) - p.y) * pk;
      if (p.y < ST_FLOOR_HARD) p.y = ST_FLOOR_HARD;

      S.cur.l.copy(p).addScaledVector(S.tmpB, ST_LOOK_DIST);
      applyPose(cam, S.cur);

      if (t - st.lastInput > ST_IDLE) exitStreet();          // hands-off → overview
      return;
    }

    // ---- manual override — the main page's hand, verbatim --------------------
    if (m.mode === 'manual') {
      const k = 1 - Math.exp(-dt * MANUAL_SMOOTH);           // eased pursuit
      m.az += (m.azT - m.az) * k;
      m.el += (m.elT - m.el) * k;
      m.rad += (m.radT - m.rad) * k;
      const ch = Math.cos(m.el) * m.rad;
      S.cur.p.set(w.cx + Math.sin(m.az) * ch, PIVOT_Y + Math.sin(m.el) * m.rad, w.cz + Math.cos(m.az) * ch);
      S.cur.l.set(w.cx, PIVOT_Y, w.cz);
      applyPose(cam, S.cur);
      if (!m.dragging && t - m.lastInput > IDLE_LEN) {
        m.mode = 'return'; m.returnT = 0; m.returnLen = RETURN_LEN;
        copyPose(S.retFrom, S.cur);
      }
      return;
    }
    if (m.mode === 'return') {
      m.returnT += dt;
      const f = easeIO(Math.min(m.returnT / m.returnLen, 1));
      driftPose(S.auto, t);                                  // live target — kept on phase
      mixPose(S.cur, S.retFrom, S.auto, f);
      applyPose(cam, S.cur);
      if (f >= 1) m.mode = 'auto';
      return;
    }

    // ---- beat trigger (rate-limited, never while one is active) --------------
    const bt = S.beat;
    if (spawnId && !bt.active && t - S.lastBeatStart >= BEAT_MIN_GAP) {
      const slot = S.slotById.get(spawnId);
      if (slot !== undefined) {
        slotOf(ctx, slot, S.tmpA);
        bt.mx = S.tmpA.x; bt.my = S.tmpA.y; bt.mz = S.tmpA.z;
        // approach from the camera's current bearing — no whip across the city
        bt.az = Math.atan2(S.cur.p.x - bt.mx, S.cur.p.z - bt.mz);
        bt.active = true; bt.t = 0;
        copyPose(S.beatFrom, S.cur);
        S.lastBeatStart = t;
      }
    }

    // ---- compose: figure-eight drift + active focus beat ---------------------
    driftPose(S.auto, t);
    if (bt.active) {
      bt.t += dt;
      if (bt.t < BEAT_IN) {                                  // eased transit in
        beatPoseAt(S.beatTo, 0);
        mixPose(S.cur, S.beatFrom, S.beatTo, easeIO(bt.t / BEAT_IN));
      } else if (bt.t < BEAT_IN + BEAT_HOLD) {               // hold: slow eased creep
        beatPoseAt(S.cur, smoother((bt.t - BEAT_IN) / BEAT_HOLD));
      } else if (bt.t < BEAT_IN + BEAT_HOLD + BEAT_OUT) {    // eased transit back
        beatPoseAt(S.beatTo, 1);
        mixPose(S.cur, S.beatTo, S.auto, easeIO((bt.t - BEAT_IN - BEAT_HOLD) / BEAT_OUT));
      } else {
        bt.active = false;
        copyPose(S.cur, S.auto);                             // drift resumes on phase
      }
    } else {
      copyPose(S.cur, S.auto);
    }
    applyPose(cam, S.cur);
  },
};
