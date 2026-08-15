// totems.js — THE RING. One monolith per tool (top 12 by call count + OTHER),
// arranged on LAYOUT.totemRingRadius. Round 4 refit — information design pass:
// • MATERIAL: dark gunmetal obelisks. The emissive mask is now thin circuit
//   seams + etched name label on a near-black body; the family color
//   (TOOL_COLORS[toolFamily(name)]) lives ONLY in those seams/label — the slab
//   itself stays low-mid gunmetal. Candy-glass look killed.
// • CONDUITS: raised into ARCHES that vault over the chronogram annulus
//   (cubic bezier, apex y 3.5–5 scaled by log call volume) so the floor
//   annulus stays clean for the chronogram. Tube thickness AND brightness are
//   ∝ log call volume — the busiest tools carry visibly heavier trunks.
// • INTERACTION: every obelisk registers with ctx.pick (kind 'totem',
//   debugKey = display name). Hover → seams brighten + card (CALLS / ERRORS /
//   OUTPUT KB / FAMILY). Click → toggles ctx.state.filterTool between this
//   tool and null.
// • FILTER: when ctx.state.filterTool is set and isn't this totem's tool, its
//   emissives/pulses ease down to 40%; the filtered totem gets a pulsing
//   highlight ring at its base, tinted by family.
// • PULSES: comet-streak traffic kept (call out / result back / error red with
//   seam scorch-flicker), now hued by tool family. Pool is instanced; a
//   self-topping ambient floor keeps the ring alive; seek floods stagger ages
//   so freeze frames show traffic mid-flight. All colors from palette exports.
// Round 3 carryovers: counts coerced finite (no NaN geometry) and init logs a
// one-line construction receipt for the critique pipeline.
// KILLSCREEN refinement r1 (infographic campaign): base glow pools cut to half
// energy (opacity 0.32→0.16, breathing halved to match) and shrunk (scale cap
// 1.9→1.25) with a gradient that hits hard zero by 0.8r — pools can no longer
// merge into a single blob from the grazing presets (cam3/cam5) or feed their
// bloom, and the pool footprint (light reach r≈16.0) now clears both the
// chronogram annulus (rOuter 15) and the quarter-label band beyond it. The
// quarter-mark labels themselves are chronogram.js territory — not touched.
// INFOGRAPHIC r3 (legend/scale pass — deliberately small, additive only):
// • SCALE: floating cap numerals shipped here and were REMOVED by UR-4 — see
//   GRAND REFINEMENT r1 below; the count now lives etched on the face.
// • LEGEND: a '// TOTEM RING' key row is appended into the HUD legend panel
//   (id-guarded, retry-capped, silent no-op when hud is absent) stating
//   HEIGHT: LOG SCALE · CAP = CALLS and defining the arc-flight grammar:
//   PULSE = CALL OUT / RESULT BACK. Styled with hud's own row classes so it
//   reads as one grammar; my glyph CSS lives in a totm-scoped style block.
// • CARD: hover card gains two derived rows — % OF CALLS (share of every
//   tool call in the session) and ERR RATE (errors/calls).
// GRAND REFINEMENT r1 (2026-08-11 — user rulings + perf audit):
// • UR-1 (comet fusion): trail segments now FUSE into one comet — TRAIL_GAP
//   0.034→0.015 so adjacent segments intersect at their radii, TRAIL_FALL
//   steepened (tail ≤15% of head brightness by segment 3), tails elongate
//   further along the travel tangent with progressively shrinking
//   cross-sections. In motion: one clean comet, zero discrete-echo reads.
// • UR-4 (USER OVERRIDE — do not re-add): floating call-count numerals above
//   the obelisks are GONE. The count is etched small into the obelisk face
//   below the name — same emissive-mask etch, dimmer than the name, no halo —
//   and nothing floats above the silhouette line.
// • PERF P1 (audit totems.js:509): live pulses compact to the front of the
//   instance buffer each frame and pulseMesh.count tracks demand — dead pool
//   slots cost zero vertex work; segment geometry 10x8→6x4 (~140→36 tris);
//   pulse buffer uploads gated to live frames and range-limited to the prefix.
// IN-PLACE SESSION SWAP (2026-08-12): construction is split in two —
// buildStatics() allocates what no session can change (once per page) and
// buildSession() allocates what session.tools shapes (again on every swap,
// after releaseSession() disposes the previous one). init() = statics +
// session; reset() = release + session; no build code is duplicated. The
// keep-vs-release ledger lives in the block above reset(). Visual design is
// untouched by that refactor — the same objects with the same numbers.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const TOP_N = 12;
const MAX_RING = TOP_N + 1;         // top 12 + OTHER — the ring's hard ceiling
const PAD_H = 0.5;                  // pad slab height (positions key off it)
const PULSE_POOL = 128;
const TRAIL = 5;                    // head + 4 tail segments fused into one comet
const TRAIL_GAP = 0.015;            // UR-1: below segment intersect radius — tails overlap
const TRAIL_FALL = [1, 0.4, 0.15, 0.055, 0.02]; // UR-1: tail ≤15% of head by segment 3
const EVENT_LIFE = 0.85;            // seconds core→totem (decays well < 2s)
const HEAD_BOOST = 3.0;             // HDR multiplier — pushes heads past bloom threshold
const AMBIENT_BOOST = 1.5;          // idle traffic sits just under the threshold
const AMBIENT_MIN = 6;              // the ring is never dead: keep >= this in flight
const CURVE_SAMPLES = 48;
const FLOOD_CAP = 64;               // max fired events processed per frame (seek floods)
const TEX_W = 512, TEX_H = 1024;    // 128px per obelisk face — seams must stay crisp
const ARCH_APEX_MIN = 3.5;          // conduit arch apex range (over the chronogram)
const ARCH_APEX_MAX = 5.0;
const DIM_FLOOR = 0.4;              // filtered-out emissive/pulse level
const LEGEND_RETRY = 240;           // update frames to wait for hud's legend panel
const LEGEND_KEY_ID = 'totm-ring-key';

// ---- module state (allocated in init; plain data only at top level) ----------
let CTX = null;                // ctx captured at init (pick callbacks, state)
let group = null;
let totems = [];               // { name, count, errors, chars, family, height, angle, px, pz, mat, iMul }
let toolIndex = null;          // Map name -> ring index
let otherIdx = 0;
let bodies = [];               // per-totem monolith Mesh — session-shaped GPU objects
let capMesh, padMesh, conduitMesh, pulseMesh, discMesh, ringMesh;
let conduitMat, discMat, ringMat, stripTex;
let emptyGeo = null;           // parking geometry for conduitMesh between builds
let conduitColAttr = null;     // merged conduit vertex-color attribute (live-dimmed)
let conduitRanges = [];        // { start, count } vertex spans per conduit in merged geo
let conduitBase = [];          // per-conduit premultiplied base Color (volume brightness baked)
let conduitMulPrev = null;     // last written runtime multiplier per conduit
let curvePts = [];             // per-totem Vector3[CURVE_SAMPLES+1] along the arch
let pulses = [];               // pool records
let poolCursor = 0;
let activePulses = 0;
let capGlow, errFlick, phase;  // Float32Array per totem
let dimCur, hoverCur, hoverTarget; // filter/hover eased state per totem
let accentCols = [];           // per-totem THREE.Color — family accent
let capDimCols = [];           // per-totem resting cap color
let cumWeights = null, weightSum = 0;
let ambientTimer = 0;
let rng = null;
let time = 0;
let legendPending = 0;         // >0: still waiting to append the hud legend key

// temps (reused, never per-frame allocated)
let _v, _v2, _z, _m, _q, _s, _c, _capCol;
let COL = null;                // preallocated Color set
let seamErr, capHot;

// ---- helpers -----------------------------------------------------------------
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const easeOutCubic = (k) => 1 - Math.pow(1 - k, 3);
const kbLabel = (chars) => `${Math.max(0, Math.round(chars / 1024)).toLocaleString('en-US')} KB`;
const pctOf = (num, den) => {
  const p = den > 0 ? (num / den) * 100 : 0;
  return p > 0 && p < 0.05 ? '<0.1%' : `${p.toFixed(1)}%`;
};

// Gunmetal circuitry mask, grayscale: the material's emissive (family accent)
// tints it, so the same map scorch-flickers toward red without repainting.
// Design intent: the body reads near-black; light lives in THIN edge seams,
// hairline collars, faint machining bands, and the etched label. No washes.
// UR-4: the call count is etched SMALL below the name (y 252..~340 band is
// reserved for it — face detail starts below), same treatment, dimmer, no halo.
function makeTotemTexture(name, count) {
  const cv = document.createElement('canvas');
  cv.width = TEX_W; cv.height = TEX_H;
  const g = cv.getContext('2d');
  g.fillStyle = '#000000'; g.fillRect(0, 0, TEX_W, TEX_H);
  const rnd = mulberry(hashSeed(name));
  const fw = TEX_W / 4;
  const W = (a) => `rgba(255,255,255,${a.toFixed(3)})`;

  for (let f = 0; f < 4; f++) {
    const x0 = f * fw;

    // barely-there panel fill — enough that the slab isn't a void, no more
    g.fillStyle = W(0.02); g.fillRect(x0 + 3, 0, fw - 6, TEX_H);

    // faint base uplight from the pad (kept subtle — gunmetal, not glass)
    const up = g.createLinearGradient(0, TEX_H * 0.86, 0, TEX_H);
    up.addColorStop(0, 'rgba(255,255,255,0)');
    up.addColorStop(1, 'rgba(255,255,255,0.06)');
    g.fillStyle = up; g.fillRect(x0 + 3, TEX_H * 0.86 | 0, fw - 6, TEX_H * 0.14 + 2);

    // THIN edge seams — 2px hot core line + tight 6px inward falloff
    const gl = g.createLinearGradient(x0, 0, x0 + 6, 0);
    gl.addColorStop(0, 'rgba(255,255,255,0.25)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gl; g.fillRect(x0, 0, 6, TEX_H);
    const gr = g.createLinearGradient(x0 + fw, 0, x0 + fw - 6, 0);
    gr.addColorStop(0, 'rgba(255,255,255,0.25)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(x0 + fw - 6, 0, 6, TEX_H);
    g.fillStyle = W(0.95);
    g.fillRect(x0, 0, 2, TEX_H);
    g.fillRect(x0 + fw - 2, 0, 2, TEX_H);

    // hairline collars: crown, below-label, base
    g.fillStyle = W(0.8);  g.fillRect(x0 + 4, 6, fw - 8, 3);
    g.fillStyle = W(0.35); g.fillRect(x0 + 6, 236, fw - 12, 2);
    g.fillStyle = W(0.5);  g.fillRect(x0 + 6, TEX_H - 30, fw - 12, 3);

    // machining lines — periodic 1px horizontal scores, very dim
    g.fillStyle = W(0.06);
    for (let y = 380; y < TEX_H - 60; y += 96) g.fillRect(x0 + 5, y, fw - 10, 1);

    // register band zones — tight 1px data lines, low-mid
    const zones = 2 + ((rnd() * 2) | 0);
    for (let z = 0; z < zones; z++) {
      const zy = 370 + rnd() * (TEX_H - 520);
      const lines = 4 + ((rnd() * 5) | 0);
      const inset = 12 + rnd() * 18;
      for (let l = 0; l < lines; l++) {
        g.fillStyle = W(0.08 + rnd() * 0.1);
        g.fillRect(x0 + inset, (zy + l * 7) | 0, fw - inset * 2, 1);
      }
    }

    // data blocks — dim windows, one or two warm registers
    const blocks = 8 + ((rnd() * 5) | 0);
    for (let b = 0; b < blocks; b++) {
      const bw = 6 + rnd() * 18, bh = 3 + rnd() * 7;
      const bx = x0 + 12 + rnd() * (fw - 24 - bw), by = 370 + rnd() * (TEX_H - 430 - bh);
      g.fillStyle = W(rnd() < 0.12 ? 0.35 + rnd() * 0.2 : 0.04 + rnd() * 0.07);
      g.fillRect(bx | 0, by | 0, bw | 0, bh | 0);
    }

    // circuit traces — thin vertical runs with jogs, small via pads
    g.lineWidth = 1.5;
    const traces = 5 + ((rnd() * 3) | 0);
    for (let c = 0; c < traces; c++) {
      g.strokeStyle = W(0.1 + rnd() * 0.15);
      const sx = x0 + 14 + rnd() * (fw - 28);
      const sy = 380 + rnd() * (TEX_H - 500);
      const run = 40 + rnd() * 140;
      const jog = (rnd() < 0.5 ? -1 : 1) * (10 + rnd() * 30);
      g.beginPath();
      g.moveTo(sx, sy); g.lineTo(sx, sy - run); g.lineTo(sx + jog, sy - run);
      if (rnd() < 0.5) g.lineTo(sx + jog, sy - run - (20 + rnd() * 60));
      g.stroke();
      g.fillStyle = W(0.4);
      g.fillRect(sx - 1, sy - 1, 3, 3);
    }

    // central dashed data lane — quiet (starts below the etched-count band)
    g.fillStyle = W(0.14);
    const cx = (x0 + fw / 2 - 1) | 0;
    for (let y = 368; y < TEX_H - 48; y += 20) g.fillRect(cx, y, 2, 11);
  }

  // etched label — uppercase monospace, vertical near the crown; with the body
  // this dark, the label is the loudest mark after the seams (by design)
  const label = name.toUpperCase();
  const countStr = Math.max(0, Math.round(count ?? 0)).toLocaleString('en-US');
  for (let f = 0; f < 4; f++) {
    g.save();
    g.translate(f * fw + fw / 2, 26);
    g.rotate(Math.PI / 2);
    let size = 44;
    g.font = `bold ${size}px Consolas, "Courier New", monospace`;
    while (g.measureText(label).width > 205 && size > 14) {
      size--; g.font = `bold ${size}px Consolas, "Courier New", monospace`;
    }
    g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.fillText(label, 0, 0);
    // UR-4: call count etched SMALL below the name, under the collar rule —
    // same etched mask treatment, dimmer than the name, no shadow/halo.
    // Nothing floats above the silhouette line.
    g.font = '600 24px Consolas, "Courier New", monospace';
    g.fillStyle = 'rgba(255,255,255,0.4)';
    g.fillText(countStr, 226, 0);
    g.restore();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;   // linear: hairlines keep their emission
  tex.anisotropy = 8;
  return tex;
}

// Scrolling shimmer strip for the conduits (u runs along tube length).
function makeStripTexture() {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 4;
  const g = cv.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0.28)'; g.fillRect(0, 0, 256, 4);
  for (let i = 0; i < 8; i++) {
    const x = i * 32;
    const grad = g.createLinearGradient(x, 0, x + 26, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.8, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(x, 0, 26, 4);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

// Soft radial gradient for the ground glow discs. KILLSCREEN r1: falloff
// tightened — energy concentrated inside 0.55r, hard zero by 0.8r, so the
// additive skirt can't smear neighboring pools together under bloom at
// grazing camera angles.
function makeRadialTexture() {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 128;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.42)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.08)');
  grad.addColorStop(0.8, 'rgba(255,255,255,0)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// One legend entry appended into the HUD's legend panel so the ring's arc
// grammar is keyed where every other mark grammar already lives. Strictly
// additive and defensive: id-guarded against double insert, retry-capped by
// the caller, silent no-op when the hud module (which owns the panel) is
// absent, and styled with hud's own row classes so it reads as one grammar.
// Only the small flight glyph needs CSS of its own — totm-scoped. Colors via
// ctx.CSS only.
function injectLegendKey() {
  if (document.getElementById(LEGEND_KEY_ID)) return true;
  const leg = document.querySelector('.hudx-legend');
  if (!leg) return false;
  const C = CTX.CSS;
  if (!document.getElementById('totm-style')) {
    const st = document.createElement('style');
    st.id = 'totm-style';
    st.textContent = `
.totm-mkg-flight::before{content:"";position:absolute;left:0;top:3px;width:11px;height:10px;
 border:1.5px solid transparent;border-top-color:${C.cache};border-radius:50%;
 filter:drop-shadow(0 0 2px ${C.cache}aa);}
.totm-mkg-flight::after{content:"";position:absolute;left:7px;top:2px;width:3px;height:3px;
 border-radius:50%;background:${C.coreHot};box-shadow:0 0 4px ${C.cache}cc;}`;
    document.head.appendChild(st);
  }
  const div = document.createElement('div');
  div.id = LEGEND_KEY_ID;
  div.className = 'hudx-ldiv';
  const head = document.createElement('div');
  head.className = 'hudx-lhead';
  const t = document.createElement('span');
  t.textContent = '// TOTEM RING';
  const hint = document.createElement('span');
  hint.className = 'hudx-lhint';
  hint.textContent = 'HEIGHT: LOG SCALE · COUNT ETCHED ON FACE';
  head.append(t, hint);
  const row = document.createElement('div');
  row.className = 'hudx-mk';
  const glyph = document.createElement('span');
  glyph.className = 'hudx-mkg totm-mkg-flight';
  const lab = document.createElement('span');
  lab.textContent = 'PULSE = CALL OUT / RESULT BACK';
  row.append(glyph, lab);
  leg.append(div, head, row);
  return true;
}

// -1 when the tool is unknown AND this session raised no OTHER bucket — which
// happens live, where a tool can appear that the aggregate never saw. Callers
// index arrays with the result, so they must skip negatives.
function idxFor(tool) {
  const i = toolIndex.get(tool);
  return i === undefined ? otherIdx : i;
}

function spawnPulse(totIdx, dir, hue, life, boost, age0) {
  const p = pulses[poolCursor];
  poolCursor = (poolCursor + 1) % PULSE_POOL;
  if (p.active) activePulses--;            // recycling a live slot
  p.active = true; p.tot = totIdx; p.dir = dir;
  p.age = age0; p.life = life; p.boost = boost;
  p.hue.copy(hue);
  activePulses++;
}

// Idle traffic: dim family-hued pulse on a call-count-weighted random conduit.
function spawnAmbient(staggered) {
  const r = rng() * weightSum;
  let i = 0;
  while (i < cumWeights.length - 1 && cumWeights[i] < r) i++;
  const life = 1.4 + rng() * 0.6;
  spawnPulse(i, rng() < 0.7 ? 1 : -1, accentCols[i], life, AMBIENT_BOOST,
    staggered ? rng() * life * 0.75 : 0);
}

// Write one conduit's vertex colors = base * runtime multiplier (filter/hover).
function writeConduitColor(i, mul) {
  const { start, count } = conduitRanges[i];
  const arr = conduitColAttr.array;
  const b = conduitBase[i];
  const r = b.r * mul, g = b.g * mul, bl = b.b * mul;
  const end = (start + count) * 3;
  for (let vi = start * 3; vi < end; vi += 3) { arr[vi] = r; arr[vi + 1] = g; arr[vi + 2] = bl; }
}

// Park the whole pulse pool. Every record's .tot indexes the ring it was
// spawned on, so no pulse may survive a session swap. count 0 → dead slots
// submit zero vertex work, and the stale instance matrices beyond it are never
// reached: update() rewrites the live prefix and re-sets .count every frame.
function parkPulses() {
  for (let i = 0; i < pulses.length; i++) pulses[i].active = false;
  poolCursor = 0;
  activePulses = 0;
  ambientTimer = 0;
  pulseMesh.count = 0;
}

// One-line construction receipt for the critique pipeline (init and every swap).
function receipt(how) {
  let hMin = Infinity, hMax = 0;
  for (const t of totems) { hMin = Math.min(hMin, t.height); hMax = Math.max(hMax, t.height); }
  console.log(`[totems] ${how}: ${totems.length} monoliths on ring r=${CTX.LAYOUT.totemRingRadius}, ` +
    `h ${hMin.toFixed(2)}-${hMax.toFixed(2)} (log scale), counts etched on face (UR-4), ` +
    `fused comet pulses (UR-1), arched conduits apex ${ARCH_APEX_MIN}-${ARCH_APEX_MAX} — ` +
    totems.map((t) => `${t.name}:${t.count}`).join(' '));
}

// ---- module ------------------------------------------------------------------
export default {
  name: 'totems',

  init(ctx) {
    CTX = ctx;
    this._statics(ctx);      // once per page — nothing in here is session-shaped
    this._build(ctx);        // the ring itself, from session.tools
    receipt('built');
  },

  // IN-PLACE SESSION SWAP (main.js SESSION SWAP CONTRACT). Release, rebuild,
  // same objects on screen — no navigation, so the page (and the radio) lives.
  //
  // RELEASED (session-shaped GPU, every byte of it — this is the module that
  // would compound hardest over an hours-long attract run):
  //   · per monolith: CylinderGeometry (height = log call volume),
  //     MeshStandardMaterial, and its 512x1024 CanvasTexture emissive mask —
  //     the etched NAME + call COUNT. That is ~2MB of RGBA per tool, ~27MB per
  //     playlist entry, and an entry lasts 3-6 minutes: leaking these would
  //     burn through hundreds of MB of VRAM in the first hour of an attract
  //     run. texture.dispose() + material.dispose() + geometry.dispose().
  //   · the merged conduit TubeGeometry (48 segments x 13 arches).
  //   · every monolith's ctx.pick registration: its card closure captures the
  //     OLD session's calls/errors/chars/share stats, and interact.js raycasts
  //     registered objects DIRECTLY — a stale entry would keep scoring hover
  //     hits on disposed geometry. (main.js prunes orphans too; we unregister
  //     ourselves rather than lean on that.)
  //
  // KEPT ON PURPOSE (static scaffold, allocated once in _statics — rebuilding
  // it per entry would BE the leak: fresh GL buffers and texture uploads every
  // few minutes for data that never changes):
  //   · the group (stays in ctx.scene — never re-added), and the shared
  //     cap/pad/disc/ring/pulse geometries + materials.
  //   · the two procedural textures that encode nothing about the session: the
  //     conduit shimmer strip and the ground-glow radial gradient.
  //   · cap/pad/disc InstancedMeshes, allocated at MAX_RING and drawn with
  //     .count = ring size: a swap rewrites transforms in place instead of
  //     reallocating three instance buffers.
  //   · the PULSE_POOL x TRAIL instance buffers and pool records — parked, not
  //     freed (PULSE_POOL is a module constant no session can change).
  //   · the reusable temps/Colors, and the HUD legend row (static text; the
  //     append is re-armed below in case hud rebuilt its panel in its own reset).
  //   · `time` — seam breathing and shimmer phase carry across the cut so
  //     nothing pops at the seam.
  //
  // PER-TOOL STATE: capGlow / errFlick / phase / dimCur / hoverCur /
  // hoverTarget / conduitMulPrev / cumWeights are rebuilt at the new ring size
  // (a carried-over scorch, hover or filter dim would land on a different
  // tool), the pulse pool is parked, and the filter highlight ring is hidden.
  // ctx.state.filterTool is cleared in _build when the filtered tool is not in
  // the new ring.
  reset(ctx) {
    if (!group) return;      // init never completed — nothing to swap
    CTX = ctx;
    this._release();
    this._build(ctx);
    receipt('rebuilt (session swap)');
  },

  // ---- static scaffold: allocated once per page, reused by every session ------
  _statics(ctx) {
    const { scene, PALETTE } = ctx;
    group = new THREE.Group();
    group.name = 'totems';

    // preallocated temps / colors
    _v = new THREE.Vector3(); _v2 = new THREE.Vector3();
    _z = new THREE.Vector3(0, 0, 1);
    _m = new THREE.Matrix4();
    _q = new THREE.Quaternion(); _s = new THREE.Vector3(1, 1, 1);
    _c = new THREE.Color(); _capCol = new THREE.Color();
    COL = {
      red: new THREE.Color(PALETTE.error),
      cache: new THREE.Color(PALETTE.cache),
    };
    seamErr = new THREE.Color(PALETTE.error);
    capHot = new THREE.Color(PALETTE.coreHot);

    // shared geometries for instanced parts. The instanced meshes are sized to
    // MAX_RING and drawn with .count = ring size, so a session swap rewrites
    // transforms instead of reallocating instance buffers.
    const capGeo = new THREE.ConeGeometry(0.37, 0.72, 4);
    const padGeo = new THREE.BoxGeometry(1.55, PAD_H, 1.55);
    const padMat = new THREE.MeshStandardMaterial({
      color: PALETTE.coreShell, metalness: 0.92, roughness: 0.42,
      emissive: PALETTE.cache, emissiveIntensity: 0.1,
    });
    const capMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    capMesh = new THREE.InstancedMesh(capGeo, capMat, MAX_RING);
    padMesh = new THREE.InstancedMesh(padGeo, padMat, MAX_RING);
    capMesh.count = 0; padMesh.count = 0;          // _build sets the real count

    // ground glow discs — family pools of light at the totem feet. KILLSCREEN
    // r1: energy halved (0.32→0.16) and footprint shrunk so pools stay clear
    // of the annulus (rOuter 15) AND the quarter-label band beyond it, and
    // adjacent pools (centers ~8.1 apart on the ring) can never read as one blob
    discMat = new THREE.MeshBasicMaterial({
      map: makeRadialTexture(), color: 0xffffff, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    discMesh = new THREE.InstancedMesh(new THREE.CircleGeometry(1.0, 24), discMat, MAX_RING);
    discMesh.renderOrder = 2;
    discMesh.count = 0;

    // filter highlight ring — parked hidden, moved to the filtered totem's base
    ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    ringMesh = new THREE.Mesh(new THREE.RingGeometry(1.25, 1.55, 48), ringMat);
    ringMesh.rotation.x = -Math.PI / 2;
    ringMesh.position.y = 0.05;
    ringMesh.renderOrder = 2;
    ringMesh.visible = false;

    // merged conduits: one draw call, shared scrolling shimmer. The MERGED
    // GEOMETRY is session-shaped (swapped in by _build); the mesh, its material
    // and the strip texture are not. emptyGeo is the parking slot so the mesh
    // never points at a geometry we disposed.
    stripTex = makeStripTexture();
    conduitMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, vertexColors: true, map: stripTex, transparent: true,
      opacity: 0.58, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    emptyGeo = new THREE.BufferGeometry();
    conduitMesh = new THREE.Mesh(emptyGeo, conduitMat);
    conduitMesh.renderOrder = 1;

    // -- pulse pool: instanced fused-comet streaks. PERF P1 (:509): low-poly
    // segment geometry (6x4, ~36 tris vs 140) and demand-driven count — live
    // pulses compact to the buffer front each frame; dead slots draw nothing.
    // PULSE_POOL/TRAIL are module constants, so the pool outlives every session.
    const pulseGeo = new THREE.SphereGeometry(0.14, 6, 4);
    const pulseMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    pulseMesh = new THREE.InstancedMesh(pulseGeo, pulseMat, PULSE_POOL * TRAIL);
    pulseMesh.frustumCulled = false;
    pulseMesh.renderOrder = 3;
    pulses = [];
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < PULSE_POOL; i++) {
      pulses.push({ active: false, tot: 0, dir: 1, age: 0, life: EVENT_LIFE, boost: 1, hue: new THREE.Color() });
      for (let j = 0; j < TRAIL; j++) {
        pulseMesh.setMatrixAt(i * TRAIL + j, _m);
        pulseMesh.setColorAt(i * TRAIL + j, COL.cache);
      }
    }
    pulseMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (pulseMesh.instanceColor) pulseMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    parkPulses();                      // count 0 until traffic demands slots

    group.add(capMesh, padMesh, discMesh, conduitMesh, pulseMesh, ringMesh);
    scene.add(group);
  },

  // ---- release the session on screen: dispose everything session-shaped ------
  // Ledger and rationale live in the comment above reset().
  _release() {
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      CTX.pick.unregister(b);          // card/onHover closures hold the old stats
      group.remove(b);
      b.geometry.dispose();
      if (b.material.emissiveMap) b.material.emissiveMap.dispose();
      b.material.dispose();
    }
    bodies = [];
    totems = [];
    const cg = conduitMesh.geometry;
    conduitMesh.geometry = emptyGeo;   // never leave the mesh on a disposed geo
    if (cg !== emptyGeo) cg.dispose();
    conduitColAttr = null;
    conduitRanges = [];
    conduitBase = [];
    curvePts = [];
    accentCols = [];
    capDimCols = [];
    parkPulses();                      // pool records index the OLD ring
    ringMesh.visible = false;          // the filtered tool may be gone
    capMesh.count = 0; padMesh.count = 0; discMesh.count = 0;
  },

  // ---- build everything shaped by session.tools (init AND every swap) --------
  _build(ctx) {
    const { session, PALETTE, LAYOUT, TOOL_COLORS, toolFamily } = ctx;
    // reseed: a given session looks identical whether it was booted into or
    // swapped into (the critique pipeline depends on that reproducibility).
    rng = mulberry(0xC0FFEE);

    // -- select top 12 tools + OTHER aggregate --
    // stats coerced finite/non-negative: a 0-call or malformed entry must never
    // reach the height math as NaN (NaN geometry → NaN frame under the composer)
    const numOf = (v, k = 'count') => (Number.isFinite(v?.[k]) ? Math.max(0, v[k]) : 0);
    const entries = Object.entries(session.tools ?? {})
      .sort((a, b) => numOf(b[1]) - numOf(a[1]));
    // denominator for the card's % OF CALLS row: every call in the session,
    // not just the ring's top-12+OTHER slice
    const totalCalls = Math.max(1, entries.reduce((s, [, v]) => s + numOf(v), 0));
    const top = entries.slice(0, TOP_N);
    let otherCount = 0, otherErrors = 0, otherChars = 0;
    for (const [, v] of entries.slice(TOP_N)) {
      otherCount += numOf(v); otherErrors += numOf(v, 'errors'); otherChars += numOf(v, 'chars');
    }
    const list = top.map(([name, v]) => ({
      name, count: numOf(v), errors: numOf(v, 'errors'), chars: numOf(v, 'chars'),
    }));
    // OTHER is the spill bucket for tools past TOP_N. Only raise it when
    // something actually spilled: a session whose whole vocabulary fits in the
    // ring (common outside Claude — Codex sessions run 2-11 distinct tools)
    // was otherwise given a permanent amber monolith standing for nothing.
    if (otherCount > 0) {
      list.push({ name: 'OTHER', count: otherCount, errors: otherErrors, chars: otherChars });
    }

    const N = list.length;                 // <= MAX_RING by construction
    otherIdx = otherCount > 0 ? N - 1 : -1;   // -1 = no spill bucket this session
    toolIndex = new Map(top.map(([name], i) => [name, i]));

    // The outgoing session's filtered tool may not exist in the new ring.
    // main.js clears ctx.state.filterTool on every swap; re-check here so the
    // module stays self-consistent whoever reset it. OTHER is no longer
    // guaranteed, so a carried-over OTHER filter has to clear with the rest.
    const ft = ctx.state.filterTool;
    const stale = ft === 'OTHER' ? otherIdx < 0 : !toolIndex.has(ft);
    if (ft != null && stale) ctx.state.filterTool = null;

    const maxCount = Math.max(1, list[0].count);
    const R = LAYOUT.totemRingRadius;
    const baseY = LAYOUT.totemBaseY;

    // per-tool runtime state, sized to the NEW ring: a carried-over scorch,
    // hover or filter dim would otherwise land on a different tool
    capGlow = new Float32Array(N);
    errFlick = new Float32Array(N);
    phase = new Float32Array(N);
    dimCur = new Float32Array(N).fill(1);
    hoverCur = new Float32Array(N);
    hoverTarget = new Float32Array(N);
    conduitMulPrev = new Float32Array(N).fill(1);

    // ambient-traffic weights: sqrt(count) so quiet totems still get visits
    cumWeights = new Float32Array(N);
    weightSum = 0;
    for (let i = 0; i < N; i++) { weightSum += Math.sqrt(list[i].count); cumWeights[i] = weightSum; }

    totems = [];
    bodies = [];
    curvePts = [];
    accentCols = [];
    capDimCols = [];
    conduitRanges = [];
    conduitBase = [];
    // hud inits after totems, and may rebuild its legend panel in its own
    // reset() — re-arm the append every build. injectLegendKey is id-guarded,
    // so a row that survived the swap is left exactly as it is.
    legendPending = LEGEND_RETRY;
    const conduitGeos = [];
    let vertBase = 0;
    const lumOf = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

    for (let i = 0; i < N; i++) {
      const { name, count, errors, chars } = list[i];
      const a = (i / N) * Math.PI * 2 + Math.PI / N;   // half-step offset off +z axis
      const px = Math.sin(a) * R, pz = Math.cos(a) * R;
      const logNorm = Math.log(count + 1) / Math.log(maxCount + 1);
      let h = 3 + 5 * logNorm;
      if (!Number.isFinite(h)) h = 3;                  // hard floor — never NaN geometry
      const rnd2 = mulberry(hashSeed(name) ^ 0x9e3779b9);
      phase[i] = rnd2() * Math.PI * 2;

      const family = toolFamily(name);
      const accent = new THREE.Color(TOOL_COLORS[family] ?? TOOL_COLORS.other);
      accentCols.push(accent);
      capDimCols.push(accent.clone().multiplyScalar(0.45));
      // equalize perceived seam brightness across hues (magenta/violet run dim)
      const iMul = Math.min(2.1, Math.max(1, 0.55 / Math.max(lumOf(accent), 0.05)));

      // -- monolith body: tapered 4-sided gunmetal pillar, thin-seam mask --
      const bodyGeo = new THREE.CylinderGeometry(0.3, 0.52, h, 4, 1, true);
      bodyGeo.translate(0, PAD_H + h / 2, 0);
      const tex = makeTotemTexture(name, count);   // UR-4: count etched on the face
      const mat = new THREE.MeshStandardMaterial({
        color: PALETTE.coreShell, metalness: 0.9, roughness: 0.32,
        emissive: accent, emissiveIntensity: 1.25 * iMul,
        emissiveMap: tex, flatShading: true,
      });
      const body = new THREE.Mesh(bodyGeo, mat);
      body.position.set(px, baseY, pz);
      body.rotation.y = a + Math.PI / 4;               // one flat face toward the core
      group.add(body);
      bodies.push(body);                               // _release disposes these

      // -- pick registration: hover card + filter toggle --
      const totIdx = i;
      const stats = {
        count, errors, chars, family,
        share: pctOf(count, totalCalls),        // % of every call this session
        errRate: pctOf(errors, count || 1),     // derived: errors / calls
      };
      ctx.pick.register(body, {
        kind: 'totem',
        debugKey: name,
        card: () => ({
          title: name.toUpperCase(),
          lines: [
            ['CALLS', stats.count.toLocaleString('en-US')],
            ['% OF CALLS', stats.share],
            ['ERRORS', String(stats.errors)],
            ['ERR RATE', stats.errRate],
            ['OUTPUT', kbLabel(stats.chars)],
            ['FAMILY', stats.family.toUpperCase()],
          ],
        }),
        onClick: () => {
          CTX.state.filterTool = CTX.state.filterTool === name ? null : name;
        },
        onHover: (hit) => { hoverTarget[totIdx] = hit ? 1 : 0; },
      });

      // -- cap + pad + disc instances --
      _q.setFromAxisAngle(_v.set(0, 1, 0), a + Math.PI / 4);
      _m.compose(_v.set(px, baseY + PAD_H + h + 0.36, pz), _q, _s.set(1, 1, 1));
      capMesh.setMatrixAt(i, _m);
      capMesh.setColorAt(i, _capCol.copy(capDimCols[i]));
      _m.compose(_v.set(px, baseY + PAD_H / 2, pz), _q, _s.set(1, 1, 1));
      padMesh.setMatrixAt(i, _m);
      _q.setFromAxisAngle(_v.set(1, 0, 0), -Math.PI / 2);
      // pool scale capped 1.25 (was 1.9): geometric reach r=17-1.25=15.75 and
      // light reach ~16.0 (gradient zeroes at 0.8r) — clear of annulus + labels
      const ds = Math.min(1.25, 0.72 + 0.07 * h);
      _m.compose(_v.set(px, 0.035, pz), _q, _s.set(ds, ds, 1));
      discMesh.setMatrixAt(i, _m);
      discMesh.setColorAt(i, _c.copy(accent).multiplyScalar(0.75));

      // -- conduit: cubic-bezier ARCH vaulting the chronogram annulus --
      // apex y 3.5–5, tube radius, and brightness all scale with log volume.
      const apex = ARCH_APEX_MIN + (ARCH_APEX_MAX - ARCH_APEX_MIN) * logNorm;
      const start = new THREE.Vector3(Math.sin(a) * 1.5, 0.25, Math.cos(a) * 1.5);
      const end = new THREE.Vector3(px - Math.sin(a) * 0.9, 0.55, pz - Math.cos(a) * 0.9);
      // cubic apex ≈ 0.75*ctrlY + (y0+y3)/8 → solve ctrlY for the target apex
      const ctrlY = (apex - (start.y + end.y) / 8) / 0.75;
      const bow = (i % 2 ? 1 : -1) * (0.5 + rnd2() * 0.7);
      const perpX = Math.cos(a) * bow, perpZ = -Math.sin(a) * bow;
      const c1 = start.clone().lerp(end, 0.3); c1.y = ctrlY; c1.x += perpX; c1.z += perpZ;
      const c2 = start.clone().lerp(end, 0.7); c2.y = ctrlY; c2.x += perpX * 0.6; c2.z += perpZ * 0.6;
      const curve = new THREE.CubicBezierCurve3(start, c1, c2, end);
      const tubeR = 0.03 + 0.05 * logNorm;             // thickness ∝ log call volume
      const tubeGeo = new THREE.TubeGeometry(curve, 48, tubeR, 5, false);
      // family accent tempered toward cache cyan, brightness ∝ log call volume
      _c.copy(accent).lerp(COL.cache, 0.25).multiplyScalar(0.45 + 0.85 * logNorm);
      conduitBase.push(_c.clone());
      const nVerts = tubeGeo.attributes.position.count;
      const vc = new Float32Array(nVerts * 3);
      for (let vi = 0; vi < vc.length; vi += 3) { vc[vi] = _c.r; vc[vi + 1] = _c.g; vc[vi + 2] = _c.b; }
      tubeGeo.setAttribute('color', new THREE.BufferAttribute(vc, 3));
      conduitRanges.push({ start: vertBase, count: nVerts });
      vertBase += nVerts;
      conduitGeos.push(tubeGeo);
      curvePts.push(curve.getSpacedPoints(CURVE_SAMPLES));

      totems.push({ name, count, errors, chars, family, height: h, angle: a, px, pz, mat, iMul });
    }

    // -- merged conduits: one draw call into the static mesh/material/strip
    //    texture; only this geometry is session-shaped (the old one was disposed
    //    in _release, and conduitMesh has been parked on emptyGeo since) --
    const mergedGeo = mergeGeometries(conduitGeos);
    conduitColAttr = mergedGeo.attributes.color;
    conduitColAttr.setUsage(THREE.DynamicDrawUsage);
    conduitMesh.geometry = mergedGeo;
    for (const g of conduitGeos) g.dispose();      // the per-arch sources merged away

    // -- instanced ring parts: transforms rewritten in place, drawn count = ring
    //    size. needsUpdate re-uploads the (reused) buffers, and the cached
    //    bounding spheres describe the PREVIOUS ring's heights — recompute them
    //    or frustum culling judges this session by the last one's silhouette --
    capMesh.count = N; padMesh.count = N; discMesh.count = N;
    capMesh.instanceMatrix.needsUpdate = true;
    padMesh.instanceMatrix.needsUpdate = true;
    discMesh.instanceMatrix.needsUpdate = true;
    if (capMesh.instanceColor) capMesh.instanceColor.needsUpdate = true;
    if (discMesh.instanceColor) discMesh.instanceColor.needsUpdate = true;
    capMesh.computeBoundingSphere();
    padMesh.computeBoundingSphere();
    discMesh.computeBoundingSphere();
  },

  update(dt, state, ctx) {
    if (!group) return;
    time += dt;
    const uiState = (ctx ?? CTX).state;
    const filterTool = uiState.filterTool;

    // -- legend key: one-shot DOM append once hud's panel exists (retry-capped) --
    if (legendPending > 0) {
      legendPending--;
      if (injectLegendKey()) legendPending = 0;
    }

    // -- consume fired events (cap floods from shot-mode seeks) --
    const fired = state.fired;
    const startAt = Math.max(0, fired.length - FLOOD_CAP);
    // seek floods land in one batch: stagger ages so a still shows mid-flight traffic
    const flood = fired.length - startAt > 6;
    for (let k = startAt; k < fired.length; k++) {
      const ev = fired[k];
      if (ev.kind === 'tool_call') {
        const i = idxFor(ev.tool);
        if (i < 0) continue;               // unknown tool, no OTHER bucket
        spawnPulse(i, 1, accentCols[i], EVENT_LIFE, HEAD_BOOST,
          flood ? rng() * EVENT_LIFE * 0.7 : 0);
        capGlow[i] = 1;
      } else if (ev.kind === 'tool_result') {
        const i = idxFor(ev.tool);
        if (i < 0) continue;               // unknown tool, no OTHER bucket
        const age0 = flood ? rng() * EVENT_LIFE * 0.7 : 0;
        if (ev.err) { spawnPulse(i, -1, COL.red, EVENT_LIFE, HEAD_BOOST + 0.2, age0); errFlick[i] = 1; }
        else spawnPulse(i, -1, accentCols[i], EVENT_LIFE, HEAD_BOOST, age0);
      }
    }

    // -- ambient traffic: steady drip + top-up so no still ever looks dead --
    ambientTimer -= dt;
    if (ambientTimer <= 0) { spawnAmbient(false); ambientTimer = 0.22 + rng() * 0.3; }
    let topUp = 0;
    while (activePulses < AMBIENT_MIN && topUp++ < 2) spawnAmbient(true);

    // -- conduit idle shimmer: slow scroll + faint breathing --
    stripTex.offset.x -= dt * 0.085;
    conduitMat.opacity = 0.52 + 0.09 * Math.sin(time * 1.3);
    discMat.opacity = 0.145 + 0.025 * Math.sin(time * 1.1);  // KILLSCREEN r1: half energy

    // -- per-totem: filter/hover easing, cap glow decay, seam breathing, scorch --
    const N = totems.length;
    const kDim = 1 - Math.exp(-8 * dt);
    const kHov = 1 - Math.exp(-14 * dt);
    let conduitDirty = false;
    for (let i = 0; i < N; i++) {
      const t = totems[i];

      // eased filter dim (1 → DIM_FLOOR when another tool is filtered)
      const dimTarget = (!filterTool || filterTool === t.name) ? 1 : DIM_FLOOR;
      dimCur[i] += (dimTarget - dimCur[i]) * kDim;
      hoverCur[i] += (hoverTarget[i] - hoverCur[i]) * kHov;
      const dim = dimCur[i];

      capGlow[i] *= Math.exp(-3.5 * dt);
      const g = Math.min(capGlow[i], 1);
      capMesh.setColorAt(i, _capCol.copy(capDimCols[i]).lerp(capHot, g)
        .multiplyScalar((1 + 2.2 * g + 0.6 * hoverCur[i]) * dim));

      // seams: family breathing + hover brighten, scorch flicker on errors,
      // whole budget scaled by the filter dim
      const m = t.mat;
      let inten = (1.25 + 0.18 * Math.sin(time * 0.9 + phase[i])) * t.iMul;
      inten += hoverCur[i] * 0.9 * t.iMul;             // affordance: seams brighten
      m.emissive.copy(accentCols[i]);
      if (errFlick[i] > 0) {
        const fl = errFlick[i] * (0.55 + 0.45 * Math.sin(time * 46 + i * 1.7));
        m.emissive.lerp(seamErr, Math.min(1, fl * 1.6));
        inten += fl * 1.5;
        errFlick[i] = Math.max(0, errFlick[i] - dt);   // ~1s scorch
      }
      m.emissiveIntensity = inten * dim;

      // discs follow the filter too — the floor stays honest
      discMesh.setColorAt(i, _c.copy(accentCols[i])
        .multiplyScalar(0.75 * dim * (1 + 0.35 * hoverCur[i])));

      // conduit runtime brightness = filter dim + hover lift (write on change)
      const mul = dim * (1 + 0.5 * hoverCur[i]);
      if (Math.abs(mul - conduitMulPrev[i]) > 0.003) {
        writeConduitColor(i, mul);
        conduitMulPrev[i] = mul;
        conduitDirty = true;
      }
    }
    if (capMesh.instanceColor) capMesh.instanceColor.needsUpdate = true;
    if (discMesh.instanceColor) discMesh.instanceColor.needsUpdate = true;
    if (conduitDirty) conduitColAttr.needsUpdate = true;

    // -- filter highlight ring at the chosen totem's base --
    let ringIdx = -1;
    if (filterTool != null) {
      ringIdx = filterTool === 'OTHER' ? otherIdx : (toolIndex.get(filterTool) ?? -1);
    }
    if (ringIdx >= 0) {
      const t = totems[ringIdx];
      ringMesh.visible = true;
      ringMesh.position.set(t.px, 0.05, t.pz);
      ringMat.color.copy(accentCols[ringIdx]);
      const pulse = Math.sin(time * 2.6);
      ringMat.opacity = 0.55 + 0.2 * pulse;
      const sc = 1 + 0.05 * pulse;
      ringMesh.scale.set(sc, sc, 1);
    } else {
      ringMesh.visible = false;
    }

    // -- pulses: fused comet streaks along the arched conduit samples (UR-1) --
    // PERF P1: live pulses compact to the front of the instance buffer and
    // pulseMesh.count tracks demand, so dead pool slots submit zero vertex work.
    let live = 0;                                       // live-pulse write cursor
    for (let i = 0; i < PULSE_POOL; i++) {
      const p = pulses[i];
      if (!p.active) continue;
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) { p.active = false; activePulses--; continue; }
      const base = (live++) * TRAIL;
      const pdim = dimCur[p.tot];                       // filtered-out conduits run dim
      const env = Math.pow(1 - k, 1.5);                 // eased decay envelope
      const e = easeOutCubic(k);
      const prog = p.dir > 0 ? e : 1 - e;
      const pts = curvePts[p.tot];
      for (let j = 0; j < TRAIL; j++) {
        const slot = base + j;
        const pj = prog - p.dir * j * TRAIL_GAP;        // tail hugs the head's wake
        if (pj <= 0 || pj >= 1) { pulseMesh.setMatrixAt(slot, _m.makeScale(0, 0, 0)); continue; }
        const f = pj * CURVE_SAMPLES;
        const i0 = Math.min(f | 0, CURVE_SAMPLES - 1);
        _v.lerpVectors(pts[i0], pts[i0 + 1], f - i0);
        _v2.subVectors(pts[i0 + 1], pts[i0]).normalize();
        _q.setFromUnitVectors(_z, _v2);                 // elongate along travel tangent
        // UR-1 comet fusion: TRAIL_GAP sits below combined segment half-lengths
        // so adjacent segments intersect; tails stretch further along the
        // tangent with progressively shrinking cross-sections and a steep
        // brightness fall — one comet in motion, no discrete-echo perception.
        let cross, elong, bright;
        if (j === 0) {
          cross = 0.8 + 0.35 * env; elong = 4.6;
          bright = p.boost * (0.35 + 0.65 * env);       // head stays hot → local bloom
        } else {
          cross = (0.52 - 0.08 * j) * (0.55 + 0.45 * env); // shrinking tail sections
          elong = 4.6 + 0.7 * j;                        // tail blends into the wake
          bright = p.boost * TRAIL_FALL[j] * env;       // steep decay behind the head
        }
        pulseMesh.setMatrixAt(slot, _m.compose(_v, _q, _s.set(cross, cross, cross * elong)));
        pulseMesh.setColorAt(slot, _c.copy(p.hue).multiplyScalar(bright * pdim));
      }
    }
    pulseMesh.count = live * TRAIL;
    if (live > 0) {                                     // upload only the live prefix
      const im = pulseMesh.instanceMatrix;
      im.clearUpdateRanges(); im.addUpdateRange(0, live * TRAIL * 16); im.needsUpdate = true;
      const ic = pulseMesh.instanceColor;
      if (ic) { ic.clearUpdateRanges(); ic.addUpdateRange(0, live * TRAIL * 3); ic.needsUpdate = true; }
    }
  },
};
