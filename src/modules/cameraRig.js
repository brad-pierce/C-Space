// cameraRig.js — owns the camera. Deterministic presets for shot mode; a live
// director for playback: intro crane-down, slow drift-orbit base, event-driven
// focus beats (spawn → medium shot framing core + drone shell, compaction →
// tower shot), and a manual pointer override (drag orbits, wheel zooms) that
// eases back into the director after 6s idle. All motion eased — no linear
// time-lerps anywhere.
//
// Round 2 (KILLSCREEN): presets 0 and 5 re-staged at grid level so the machine
// fills the vertical frame instead of banding across empty grid, and the rig
// stages a repoussoir — a camera-space near-mote veil that breathes in every
// mode — so each frame layers near/mid/far occlusion and the tower breaks the
// skyline silhouette.
// Round 3 (LEGEND): the round-2 conduit-trench slab is removed. It was an
// unlit non-encoding prop intruding into center frame in cam0/cam5 — a
// data-ink violation. The rig now contributes only the dim mote veils
// (sanctioned periphery ornament); every occluding object in frame is a
// data-bearing element owned by a data module.
// Round 4 (KILLSCREEN r4, grand refinement): trench deletion CONFIRMED and
// made permanent. The trench read as broken geometry in presets 0/5 and was
// a likely contributor to user dark-streak reports — DO NOT RE-ADD IT under
// any critic directive. The rig's only camera-attached props are the two
// mote veils (atmosphere tier under the luminance law: dimmest rank, never
// competing with data marks or the core heart).
//
// SHOT PRESETS (?cam=N) — the critic loop depends on these being stable:
//   0 wide establishing   1 core close-up      2 context tower
//   3 totem ring low      4 drone shell high   5 down-the-boulevard

import { PALETTE, LAYOUT } from '../lib/palette.js';

const PRESETS = [
  // 0 wide establishing — grid level (round 2): horizon drops to the lower
  // third, near grid rushes under the lens, totem ring holds the mid-ground,
  // tower breaks the skyline left of center
  { pos: [3.5, 2.3, 54], look: [-2.5, LAYOUT.coreY + 4.5, -4] },
  { pos: [6.5, LAYOUT.coreY + 1.5, 10.5], look: [0, LAYOUT.coreY, 0] },
  { pos: [-40, 13, 14], look: [-16, 12, -10] },
  { pos: [14, 2.2, 24], look: [0, 6, 0] },
  { pos: [24, 30, 34], look: [0, LAYOUT.coreY, 0] },
  // 5 down-the-boulevard — dropped to conduit eye level (round 2), slightly
  // off-axis so the avenue reads in perspective instead of dead symmetry
  { pos: [1.6, 1.7, 63], look: [-0.6, LAYOUT.coreY + 4, -9] },
  { pos: [0, 58, 7], look: [0, 0, 0] },   // 6: chronogram top-down plate
];

// ---- director tuning --------------------------------------------------------
const PIVOT_Y = LAYOUT.coreY + 1.5;      // orbit & manual look height
const BEAT_TRANSIT = 1.2;                // s — eased transit into/out of a beat
const BEAT_HOLD = { spawn: 3.5, compaction: 4.0 };
const BEAT_MIN_GAP = 8;                  // s minimum between beat starts
const IDLE_LEN = 6;                      // s of no input before auto resumes
const RETURN_LEN = 2.2;                  // s manual → director ease-back
const ZOOM_MIN = 25, ZOOM_MAX = 80;      // manual radius clamp
const ELEV_MIN = -0.08, ELEV_MAX = 1.35; // manual elevation clamp (rad)
const DRAG_SENS = 0.005;                 // rad per pixel of drag
const MANUAL_SMOOTH = 8;                 // exponential smoothing rate (1/s)
// Compaction tower-shot anchor: world (-40, *, 6) in cylindrical form — outside
// the totem ring, ~27u off the tower, whole 26u collapse fits the 55° frustum.
const TOWER_AZ = Math.atan2(-40, 6);
const TOWER_R = Math.hypot(40, 6);
const TAU = Math.PI * 2;

// Poses are cylindrical around world origin {az, r, y} + a look target. All
// blends interpolate az on the shortest arc so transits never chord through
// the core — auto-mode horizontal radius stays > 34 at every endpoint.
const makePose = () => ({ az: 0, r: 50, y: 15, lx: 0, ly: PIVOT_Y, lz: 0 });

const rig = {
  name: 'cameraRig',
  _t: 0,
  _shot: null,
  _shotIdx: -1,
  _fg: null,
  _intro: 0,

  init(ctx) {
    const cam = parseInt(ctx.params.get('cam') ?? '', 10);
    if (ctx.params.get('freeze') === '1') {
      this._shotIdx = Number.isInteger(cam) ? Math.abs(cam) % PRESETS.length : 0;
      this._shot = PRESETS[this._shotIdx];
    }
    this._introLen = ctx.params.get('t') || this._shot ? 0 : 7; // skip intro when seeking

    // director state — everything allocated here, never per-frame
    this._cur = makePose();       // pose actually applied last frame
    this._auto = makePose();      // live orbit pose, re-evaluated each frame
    this._beatFrom = makePose();  // pose snapshot at beat start
    this._beatTo = makePose();    // beat pose scratch
    this._retFrom = makePose();   // pose snapshot at manual → auto handback
    this._beat = { active: false, kind: '', t: 0, hold: 0, az: 0 };
    this._lastBeatStart = -1e9;
    this._m = {
      mode: 'auto',               // 'auto' | 'manual' | 'return'
      dragging: false, px: 0, py: 0, lastInput: -1e9, returnT: 0,
      az: 0, el: 0.3, rad: 50,    // smoothed spherical state around the pivot
      azT: 0, elT: 0.3, radT: 50, // input targets
      introSkip: false,
    };
    this._wasPlaying = true;      // timeline.playing snapshot across a freeze
    this._buildForeground(ctx);
    if (!this._shot) { this._bindInput(ctx); this._buildFrozenBadge(ctx); }
  },

  // Small self-owned "FROZEN" chip in #hud, shown while ctx.state.frozen. Kept
  // in this module (which owns the freeze) so the whole feature is one file.
  _buildFrozenBadge(ctx) {
    const hud = document.getElementById('hud');
    if (!hud) return;
    const C = ctx.CSS;
    const b = document.createElement('div');
    b.textContent = '❄ FROZEN · F';
    b.style.cssText =
      'position:absolute;top:26px;left:50%;transform:translateX(-50%) translateY(-34px);' +
      'padding:5px 12px;color:' + C.coreHot + ';background:' + C.void + 'e0;' +
      'font:10px/1 "Cascadia Code",ui-monospace,monospace;letter-spacing:.28em;' +
      'text-transform:uppercase;text-shadow:0 0 8px ' + C.cache + '99;' +
      'box-shadow:inset 0 0 0 1px ' + C.cache + '66,0 0 18px ' + C.void + 'cc;' +
      'opacity:0;transition:opacity .18s ease,transform .18s ease;pointer-events:none;z-index:30;';
    hud.appendChild(b);
    this._badge = b;
  },

  // ---- repoussoir: near-field layer parented to the camera ------------------
  // A frame is a place only if something near crosses it. Two dim mote veils
  // (sanctioned ornament: motes) drift 3–10u ahead of the lens in every mode.
  // All geometry allocated here; update only mutates rotations. The camera
  // joins the scene graph so its children render.
  _buildForeground(ctx) {
    const T = ctx.THREE;
    ctx.scene.add(ctx.camera);
    const fg = this._fg = new T.Group();
    ctx.camera.add(fg);

    // soft round sprite so motes read as bokeh dust, not square points
    const cv = document.createElement('canvas');
    cv.width = cv.height = 32;
    const c2 = cv.getContext('2d');
    const grad = c2.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    c2.fillStyle = grad;
    c2.fillRect(0, 0, 32, 32);
    const sprite = new T.CanvasTexture(cv);

    const cloud = (n, size, color, opacity) => {
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const z = -(3 + Math.random() * 7);        // 3–10u ahead of the lens
        const s = -z / 6.5;                        // spread widens with depth
        pos[i * 3] = (Math.random() * 2 - 1) * 7.5 * s;
        pos[i * 3 + 1] = (Math.random() * 2 - 1) * 4.6 * s;
        pos[i * 3 + 2] = z;
      }
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(pos, 3));
      const pts = new T.Points(geo, new T.PointsMaterial({
        color, size, opacity, map: sprite, transparent: true,
        blending: T.AdditiveBlending, depthWrite: false, fog: false,
      }));
      pts.frustumCulled = false;
      fg.add(pts);
      return pts;
    };
    this._veilA = cloud(64, 0.05, PALETTE.gridGlow, 0.28);   // fine dust
    this._veilB = cloud(48, 0.11, PALETTE.coreEnergy, 0.16); // near bokeh

    // veil everywhere except the top-down chronogram plate, which stays a
    // clean data read
    fg.visible = !(this._shot !== null && this._shotIdx === 6);
  },

  _bindInput(ctx) {
    const el = ctx.renderer.domElement;
    const m = this._m;
    const engage = () => {
      if (m.mode !== 'manual') {
        const p = ctx.camera.position;
        const dh = Math.hypot(p.x, p.z), dy = p.y - PIVOT_Y;
        m.rad = clamp(Math.hypot(dh, dy), ZOOM_MIN, ZOOM_MAX);
        m.el = clamp(Math.atan2(dy, dh), ELEV_MIN, ELEV_MAX);
        m.az = Math.atan2(p.x, p.z);
        m.azT = m.az; m.elT = m.el; m.radT = m.rad;
        m.mode = 'manual';
        m.introSkip = true;       // grabbing the camera abandons the crane
        this._beat.active = false;
      }
      m.lastInput = this._t;
    };
    el.addEventListener('pointerdown', (e) => {
      engage();
      m.dragging = true; m.px = e.clientX; m.py = e.clientY;
      try { el.setPointerCapture(e.pointerId); } catch {}
    });
    el.addEventListener('pointermove', (e) => {
      if (!m.dragging) return;
      m.azT -= (e.clientX - m.px) * DRAG_SENS;                          // grab semantics
      m.elT = clamp(m.elT + (e.clientY - m.py) * DRAG_SENS, ELEV_MIN, ELEV_MAX);
      m.px = e.clientX; m.py = e.clientY; m.lastInput = this._t;
    });
    const drop = () => { m.dragging = false; m.lastInput = this._t; };
    el.addEventListener('pointerup', drop);
    el.addEventListener('pointercancel', drop);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      engage();
      m.radT = clamp(m.radT * Math.exp(e.deltaY * 0.0012), ZOOM_MIN, ZOOM_MAX);
    }, { passive: false });

    // F — study freeze: pause the timeline and hold the camera under manual
    // control so exploring the chronogram never idles back to cinematic. F
    // again resumes playback and eases the camera back to the director.
    addEventListener('keydown', (e) => {
      if (e.code !== 'KeyF' || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const el2 = document.activeElement;
      if (el2 && /^(INPUT|TEXTAREA|SELECT)$/.test(el2.tagName)) return;
      e.preventDefault();
      const frozen = !ctx.state.frozen;
      ctx.state.frozen = frozen;
      if (frozen) {
        engage();                                   // capture pose → manual hold
        this._wasPlaying = ctx.timeline.playing;
        ctx.timeline.playing = false;
      } else {
        ctx.timeline.playing = this._wasPlaying;    // resume playback
        if (m.mode === 'manual') {                  // glide back to cinematic now
          m.mode = 'return'; m.returnT = 0;
          copyPose(this._retFrom, this._cur);
        }
      }
    });
  },

  update(dt, state, ctx) {
    const c = ctx.camera;
    this._t += dt;
    const t = this._t;
    // near-field veil breathes in every mode, frozen stills included
    if (this._fg) {
      this._veilA.rotation.z = t * 0.016;
      this._veilB.rotation.z = -t * 0.023;
      this._fg.position.y = Math.sin(t * 0.21) * 0.05;
    }
    if (this._shot) {
      c.position.set(...this._shot.pos);
      c.lookAt(...this._shot.look);
      return;
    }
    // freeze badge follows shared state (set by the F handler)
    if (this._badge) {
      const on = ctx.state.frozen;
      this._badge.style.opacity = on ? '1' : '0';
      this._badge.style.transform = 'translateX(-50%) translateY(' + (on ? '0' : '-34px') + ')';
    }
    const m = this._m;
    const orbitT = m.introSkip ? t : Math.max(0, t - this._introLen);

    // ---- manual override -----------------------------------------------------
    if (m.mode === 'manual') {
      const k = 1 - Math.exp(-dt * MANUAL_SMOOTH);   // eased pursuit of targets
      m.az += (m.azT - m.az) * k;
      m.el += (m.elT - m.el) * k;
      m.rad += (m.radT - m.rad) * k;
      setPose(this._cur, m.az, Math.cos(m.el) * m.rad, PIVOT_Y + Math.sin(m.el) * m.rad,
              0, PIVOT_Y, 0);
      applyPose(c, this._cur);
      // frozen holds manual indefinitely — the idle timer never reverts to
      // cinematic while the user is studying the rings
      if (!m.dragging && !ctx.state.frozen && t - m.lastInput > IDLE_LEN) {
        m.mode = 'return'; m.returnT = 0;
        copyPose(this._retFrom, this._cur);
      }
      return;
    }
    if (m.mode === 'return') {
      m.returnT += dt;
      const f = easeIO(Math.min(m.returnT / RETURN_LEN, 1));
      orbitPose(this._auto, orbitT);                 // live target — orbit kept phase
      mixPose(this._cur, this._retFrom, this._auto, f);
      applyPose(c, this._cur);
      if (f >= 1) m.mode = 'auto';
      return;
    }

    // ---- intro crane (kept) --------------------------------------------------
    if (!m.introSkip && t < this._introLen) {
      const f = smooth(t / this._introLen);
      setPose(this._cur, 0, lerp(4, 52, f), lerp(90, 16, f), 0, LAYOUT.coreY + 2, 0);
      applyPose(c, this._cur);
      return;
    }

    // ---- focus-beat detection (rate-limited, skipped while one is active) ----
    const b = this._beat;
    if (!b.active && t - this._lastBeatStart >= BEAT_MIN_GAP) {
      let kind = null;
      for (const ev of state.fired) {
        if (ev.kind === 'compaction') { kind = 'compaction'; break; }
        if (ev.kind === 'spawn') kind = 'spawn';
      }
      if (kind) {
        b.active = true; b.kind = kind; b.t = 0; b.hold = BEAT_HOLD[kind];
        b.az = this._cur.az + 0.4;                   // slightly ahead of the orbit
        copyPose(this._beatFrom, this._cur);
        this._lastBeatStart = t;
      }
    }

    // ---- compose: drift orbit base + active beat -----------------------------
    orbitPose(this._auto, orbitT);
    if (b.active) {
      b.t += dt;
      const T = BEAT_TRANSIT, H = b.hold;
      if (b.t < T) {                                 // eased transit in
        beatPose(this._beatTo, b, 0);
        mixPose(this._cur, this._beatFrom, this._beatTo, easeIO(b.t / T));
      } else if (b.t < T + H) {                      // hold, with slow eased creep
        beatPose(this._cur, b, (b.t - T) / H);
      } else if (b.t < T + H + T) {                  // eased transit back to orbit
        beatPose(this._beatTo, b, 1);
        mixPose(this._cur, this._beatTo, this._auto, easeIO((b.t - T - H) / T));
      } else {
        b.active = false;
        copyPose(this._cur, this._auto);             // orbit resumes on phase
      }
    } else {
      copyPose(this._cur, this._auto);
    }
    applyPose(c, this._cur);
  },
};

// ---- pose math --------------------------------------------------------------
function setPose(p, az, r, y, lx, ly, lz) {
  p.az = az; p.r = r; p.y = y; p.lx = lx; p.ly = ly; p.lz = lz;
}
function copyPose(dst, src) {
  setPose(dst, src.az, src.r, src.y, src.lx, src.ly, src.lz);
}
function mixPose(out, a, b, f) {       // f arrives pre-eased
  out.az = arcLerp(a.az, b.az, f);
  out.r = lerp(a.r, b.r, f);
  out.y = lerp(a.y, b.y, f);
  out.lx = lerp(a.lx, b.lx, f);
  out.ly = lerp(a.ly, b.ly, f);
  out.lz = lerp(a.lz, b.lz, f);
}
function applyPose(cam, p) {
  cam.position.set(Math.sin(p.az) * p.r, p.y, Math.cos(p.az) * p.r);
  cam.lookAt(p.lx, p.ly, p.lz);
}

// slow drift orbit with gentle breathing height (base behavior, phase = time)
function orbitPose(out, t) {
  setPose(out,
    t * 0.055,
    50 + Math.sin(t * 0.11) * 5,
    15 + Math.sin(t * 0.07) * 4,
    0, PIVOT_Y, 0);
}

// beat target pose at hold-progress p (0..1); creep is eased so velocity is
// continuous entering and leaving the hold
function beatPose(out, beat, p) {
  const s = smoother(clamp(p, 0, 1));
  if (beat.kind === 'compaction') {
    setPose(out,
      TOWER_AZ + 0.1 * s,                            // lateral drift past the tower
      lerp(TOWER_R, TOWER_R - 4, s),                 // gentle push-in
      lerp(12, 15.5, s),                             // rise with the dissolving debris
      LAYOUT.towerPos[0], lerp(9, 13, s), LAYOUT.towerPos[2]);
  } else {                                           // spawn — core + drone shell
    setPose(out,
      beat.az + 0.12 * s,
      lerp(40, 34.5, s),
      lerp(16.5, 13.5, s),
      0, lerp(8.5, 10.2, s), 0);
  }
}

// ---- easing (no raw time-linear motion anywhere) ----------------------------
const lerp = (a, b, f) => a + (b - a) * f;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const smooth = (x) => { const c = clamp(x, 0, 1); return c * c * (3 - 2 * c); };
const smoother = (x) => x * x * x * (x * (x * 6 - 15) + 10);
const easeIO = (x) => {
  const c = clamp(x, 0, 1);
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
};
const arcLerp = (a, b, f) => {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
  return a + d * f;
};

export default rig;
