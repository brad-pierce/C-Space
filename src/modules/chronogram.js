// chronogram.js — THE CHRONOGRAM. The radial session infographic on the floor
// annulus (CHRONO in palette.js): the whole 180s warped playback mapped onto
// 360°, vt=0 at CHRONO.startAngle (12 o'clock as seen from cam0, world -Z),
// CLOCKWISE. Every geometric property encodes a real quantity (data-ink law):
//
//   tools lane     [12.2..15.0]  one 1-2px radial tick per tool_call, hue =
//                                TOOL_COLORS[toolFamily], length = log of the
//                                matched result's chars, error → red tip
//   dialogue lane  [10.2..12.0]  user = tall magenta gates, say = amber,
//                                thinking = short dim cyan
//   subagents lane [ 8.0..10.0]  29 violet Gantt arcs spawnVt→endVt, greedily
//                                stacked into 3 sub-rings so overlaps never
//                                collide; bright spawn node, tail fades
//   hooks lane     [ 6.9.. 7.8]  mint micro-ticks (hook errors red-tipped)
//
// 5 compaction scars cut radially across all lanes as full-radius notched GAPS:
// a dark normal-blended band (renderOrder 3.5, drawn over the lane ink) erases
// what lies beneath, edged by a signal-red keyline — the SAME red the HUD
// legend swatch uses, so plate and legend agree — with faint glitch static
// inside: five discrete, countable cuts. The playhead is the single widest,
// brightest spoke on the plate: a wide cyan beam with a white-hot center line,
// a triangular tip marker riding just outside the rim, and a cyan TIME label
// sprite riding beyond the tip (canvas redrawn only when the second turns).
// PAST ink renders full brightness and saturation; FUTURE dims to ~35% AND
// desaturates to ~25% chroma — on ticks/arcs via aFrac vs a uFrac uniform, and
// on the plate itself (grid, separators, brushed texture) via an angular
// shader term — so the sector division reads instantly at the playhead and the
// disc visibly fills with light behind the sweep, a running clock. An
// exponential ~1.5s wake relights events the sweep just crossed; a node flares
// when events fire.
// All 5.5k+ ticks are ONE InstancedBufferGeometry draw, additive, so density
// reads as luminous texture — a barcode of the session's life.
//
// ROUND 2 (LEGEND): dark gutter channels cut between lanes (brushed noise and
// minute-grid stop at each band edge) + lane names engraved along each band
// just clockwise of 0:00 — TOOLS / DIALOGUE / AGENTS / HOOKS — so the rings
// decode without a legend. Camera-distance LOD: beyond ~30u the subpixel event
// ticks (confetti at overview range) crossfade to a residual shimmer while
// per-lane 1s density-histogram arcs carry the read — bar length = events/bin,
// hue = dominant family/kind in bin, red tip = the bin contains an error. User
// gates and subagent spawn nodes stay individually lit at every distance
// (structural landmarks, aKeep). An active tool filter forces detail ticks
// (the matching set is sparse) and mutes the aggregate bands.
//
// ROUND 3 (LEGEND): the future sector desaturates as well as dims so the
// past/future division is unmistakable right at the playhead; compaction scars
// draw their keyline in pure signal red, matching the legend swatch instead of
// contradicting it; quarter labels gain a soft void scrim and a small lift so
// passing drone/beam/spawn glyphs can't wash out the 0:00 anchor; and the
// playhead TIME glyph collision-offsets outward/up as it nears any quarter
// label so marker never sits on axis mark.
//
// Interaction (ctx.pick, kind 'chronogram', works in freeze mode):
//   click → hit point → angle → vt → ctx.timeline.seek(vt)
//   hover → lane-aware card: nearest tool call / dialogue event / subagent
//           arc / hook within a small vt window, else a plain TIME readout;
//           a ghost cursor line + plate brighten communicate affordance.
// ctx.state.filterTool: non-matching tool ticks dim to 15% via a per-instance
// attribute rewritten only when the filter changes ('OTHER' = not in top 12).
//
// Base plate: near-black annulus canvas texture — hairline lane separators,
// faint 15s radial minute-grid (quarters brighter), rim lines, start notch —
// with quarter-mark sprite labels (0:00 / 0:45 / 1:30 / 2:15) outside rOuter.
// The 0:00 anchor is the time origin: cyan, larger, full-bright, and its notch
// is exempt from future-dimming so the origin always reads.
// Budget: ~16 draw calls, ~16k tris, zero per-frame allocation.
//
// SESSION SWAP (reset): the plate is a printed instrument FACE and the playhead
// is chrome — both are pure CHRONO/CSS constants, so they are built once in
// init() and survive every swap, 2048² canvas texture included. The INK on the
// plate is the session: the detail-tick batch, the density-band batch, the Gantt
// arc mesh, the compaction scars, the per-lane nearest-event search arrays, the
// subagent ring stacking and the top-12 filter predicate. All of that lives in
// ONE private builder, buildSession(), which init() and reset() both call;
// reset() then disposes the four old geometries and hangs the new ones on the
// same meshes (materials and shared uniform objects are session-independent and
// are deliberately reused, so a swap costs no shader recompile). See the KEPT ON
// PURPOSE list on reset() for the full disposal ledger.

import * as THREE from 'three';

const TAU = Math.PI * 2;

// ---- shaders -----------------------------------------------------------------

const TICK_VERT = /* glsl */`
attribute float aAngle;
attribute float aR0;
attribute float aLen;
attribute float aWidth;
attribute vec3  aColor;
attribute float aInt;
attribute float aErr;
attribute float aFrac;
attribute float aDim;
attribute float aKeep;
uniform float uFrac;
uniform float uY;
uniform float uLod;
varying vec2  vUv;
varying vec3  vCol;
varying float vB;
varying float vErr;
void main() {
  vec2 dir = vec2(sin(aAngle), cos(aAngle));
  vec2 tng = vec2(cos(aAngle), -sin(aAngle));
  float r = aR0 + position.y * aLen;
  vec2 xz = dir * r + tng * (position.x * aWidth);
  float past = step(aFrac, uFrac);
  float wake = exp(-max(uFrac - aFrac, 0.0) * 480.0) * past;
  float b = (mix(0.35, 1.0, past) + wake * 1.5) * mix(1.0, 0.15, aDim);
  b *= mix(uLod, 1.0, aKeep);   // LOD crossfade; structural marks are exempt
  vB = b * aInt;
  // future ink desaturates as well as dims (LEGEND r3) — brightness alone
  // vanishes under additive blending; the gray shift makes the sector read
  float lum = dot(aColor, vec3(0.299, 0.587, 0.114));
  vCol = mix(mix(vec3(lum), aColor, 0.25), aColor, past);
  vErr = aErr;
  vUv = vec2(position.x + 0.5, position.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, uY, xz.y, 1.0);
}`;

const TICK_FRAG = /* glsl */`
uniform vec3 uErrCol;
varying vec2  vUv;
varying vec3  vCol;
varying float vB;
varying float vErr;
void main() {
  float ax = 1.0 - abs(vUv.x - 0.5) * 2.0;   // soft tangential profile — thin
  ax *= ax;                                  // quads melt into additive texture
  float tip = smoothstep(0.72, 0.86, vUv.y) * vErr;
  vec3 col = mix(vCol, uErrCol, tip * 0.92);
  float endFade = 1.0 - smoothstep(0.9, 1.0, vUv.y) * 0.3;
  gl_FragColor = vec4(col * (vB * ax * endFade), 1.0);
}`;

const ARC_VERT = /* glsl */`
attribute float aFrac;
attribute float aFade;
attribute float aU;
uniform float uFrac;
varying float vB;
varying float vU;
varying float vPast;
void main() {
  float past = step(aFrac, uFrac);
  float wake = exp(-max(uFrac - aFrac, 0.0) * 480.0) * past;
  vB = (mix(0.35, 1.0, past) + wake * 1.2) * aFade;
  vU = aU;
  vPast = past;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const ARC_FRAG = /* glsl */`
uniform vec3 uCol;
varying float vB;
varying float vU;
varying float vPast;
void main() {
  // flat-top profile with crisp edges — arcs read as Gantt BARS, a mark class
  // distinct from the soft-profile event ticks
  float bar = smoothstep(0.0, 0.16, vU) * (1.0 - smoothstep(0.84, 1.0, vU));
  // future span of an arc desaturates like every other future ink (LEGEND r3)
  float lum = dot(uCol, vec3(0.299, 0.587, 0.114));
  vec3 col = mix(mix(vec3(lum), uCol, 0.25), uCol, vPast);
  gl_FragColor = vec4(col * (vB * bar * 0.62), 1.0);
}`;

const SCAR_VERT = /* glsl */`
attribute float aAngle;
attribute float aFrac;
attribute float aSeed;
uniform float uFrac;
uniform float uY;
uniform float uR0;
uniform float uLen;
uniform float uW;
varying vec2  vUv;
varying float vB;
varying float vSeed;
void main() {
  vec2 dir = vec2(sin(aAngle), cos(aAngle));
  vec2 tng = vec2(cos(aAngle), -sin(aAngle));
  float r = uR0 + position.y * uLen;
  vec2 xz = dir * r + tng * (position.x * uW);
  vB = mix(0.35, 1.0, step(aFrac, uFrac));
  vSeed = aSeed;
  vUv = vec2(position.x + 0.5, position.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, uY, xz.y, 1.0);
}`;

// no pow() anywhere — squared gaussians only (pow(neg, frac) NaN-poisons the
// shared fp16 composer target; see environment.js round-3 postmortem)
// NORMAL blending, drawn after the lane ink (renderOrder 3.5): the dark gap
// genuinely erases ticks/arcs beneath it, so each compaction reads as a
// physical notch cut out of the record, outlined by a pure signal-red keyline
// — the same red the HUD legend swatch uses (LEGEND r3: plate and legend must
// never contradict each other).
const SCAR_FRAG = /* glsl */`
uniform float uTime;
uniform vec3 uHot;
uniform vec3 uRed;
varying vec2  vUv;
varying float vB;
varying float vSeed;
float hash(float n) { return fract(sin(n) * 43758.5453123); }
void main() {
  float au = abs(vUv.x - 0.5) * 2.0;                 // 0 at center → 1 at edge
  float gap = 1.0 - smoothstep(0.52, 0.62, au);      // dark notched gap interior
  float d = (au - 0.57) * 16.0;
  float line = exp(-d * d);                          // hairline outline, both edges
  float band = floor(vUv.y * 40.0);
  float tstep = mod(floor(uTime * 9.0), 64.0);       // bounded sin() args
  float h = hash(band * 12.9898 + vSeed * 78.233 + tstep * 0.917);
  float on = step(0.84, h);                          // sparse glitch static
  float off2 = (hash(band * 3.71 + vSeed * 1.618 + tstep) - 0.5) * 0.5 * on;
  float q2 = (vUv.x - 0.5 - off2) * 14.0;
  float seg = exp(-q2 * q2) * on * gap;              // displaced dashes, gap only
  float endFade = smoothstep(0.0, 0.04, vUv.y) * (1.0 - smoothstep(0.96, 1.0, vUv.y));
  // keyline and static are PURE legend red — the old 60% white-hot mix on the
  // hairline bloomed to white on the plate and contradicted the legend swatch
  vec3 col = uRed * (line * 1.7 * vB) + uRed * (seg * 0.5 * vB);
  float alpha = clamp(gap * 0.86 + line * vB, 0.0, 1.0) * endFade;
  gl_FragColor = vec4(col, alpha);
}`;

const SWEEP_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SWEEP_FRAG = /* glsl */`
uniform float uPulse;
uniform vec3 uCyan;
uniform vec3 uHot;
varying vec2 vUv;
void main() {
  // the single widest, brightest spoke on the plate: wide cyan beam + white-hot
  // center line — nothing in the minute-grid comes close
  float u = vUv.x - 0.5;
  float q = u * 4.6;   float core = exp(-q * q);     // wide beam body
  float qc = u * 13.0; float hotc = exp(-qc * qc);   // white-hot center line
  float q2 = u * 1.9;  float halo = exp(-q2 * q2);
  float radial = 0.5 + 0.5 * vUv.y;
  float ny = (vUv.y - 0.787) * 7.0;                  // node at tools-lane radius
  float node = exp(-ny * ny) * uPulse;
  float edge = smoothstep(0.0, 0.05, vUv.y) * (1.0 - smoothstep(0.96, 1.0, vUv.y));
  vec3 col = mix(uCyan, uHot, clamp(hotc * 0.85 + node * 0.6, 0.0, 1.0));
  float b = (core * 1.7 + hotc * 2.6 + halo * 0.3 + node * (core * 2.2 + halo * 0.8)) * radial * edge;
  gl_FragColor = vec4(col * b, 1.0);
}`;

const WAKE_VERT = /* glsl */`
attribute float aA;
attribute float aV;
varying float vA;
varying float vV;
void main() {
  vA = aA;
  vV = aV;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const WAKE_FRAG = /* glsl */`
uniform float uWakeOn;
uniform vec3 uCol;
varying float vA;
varying float vV;
void main() {
  float e = 1.0 - vA;  e *= e;                       // hottest at the sweep
  float rv = smoothstep(0.0, 0.12, vV) * (1.0 - smoothstep(0.88, 1.0, vV));
  gl_FragColor = vec4(uCol * (e * rv * 0.14 * uWakeOn), 1.0);
}`;

// Plate ink is future-dimmed AND future-desaturated in the shader so the whole
// disc — grid, lane separators, brushed texture — visibly divides at the
// playhead into a lit past sector and a ~35% gray-shifted future sector. The
// 0:00 anchor notch never dims or desaturates.
const PLATE_VERT = /* glsl */`
varying vec2 vUv;
varying vec2 vLp;
void main() {
  vUv = uv;
  vLp = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const PLATE_FRAG = /* glsl */`
#define TAU 6.283185307179586
uniform sampler2D uMap;
uniform float uFrac;
uniform float uBright;
uniform float uStart;
varying vec2 vUv;
varying vec2 vLp;
void main() {
  vec4 tex = texture2D(uMap, vUv);
  // ring lies in local XY; mesh rotation.x = -PI/2 maps local (x,y) → world
  // (x, 0, -y), so world theta = atan2(wx, wz) = atan(lx, -ly)
  float theta = atan(vLp.x, -vLp.y);
  float frac = fract((uStart - theta) / TAU);
  float past = step(frac, uFrac);
  // the 0:00 anchor notch is an axis mark, not data ink — exempt from dimming
  float anchor = max(step(0.9965, frac), 1.0 - step(0.0035, frac));
  float lit = max(past, anchor);
  float ink = mix(0.35, 1.0, lit);
  // future plate ink gray-shifts with the rest of the future sector (LEGEND r3)
  float lum = dot(tex.rgb, vec3(0.299, 0.587, 0.114));
  vec3 rgb = mix(mix(vec3(lum), tex.rgb, 0.25), tex.rgb, lit);
  gl_FragColor = vec4(rgb * (ink * uBright), tex.a);
}`;

// ---- module state (allocated in init) ----------------------------------------

let group = null;
let plateMesh, plateMat;
let tickMesh, tickDimAttr, tickToolArr;
let bandMesh;                  // density-histogram LOD twin of tickMesh
let arcMesh, scarMesh;
let sweepGroup, hoverGroup, hoverMat;
let timeSprite, timeTex, timeG, timeScrim, timeFill, lastSec = -1;
let uFrac, uTime, uPulse, uWakeOn, uLodTick, uLodBand;
let lodEase = 0;
let subs = [];                 // annotated subagent copies (ring, ringR)
let lane = null;               // per-lane nearest-event search arrays
let duration = 180, startAngle = Math.PI;
let CH = null;
let matchesFilter = null;      // (tool, filter) => bool, built in init
let lastFilter = null;
let hoverTarget = 0, hoverEase = 0, hoverAngle = Math.PI;
let pulseV = 0, time = 0;

// ---- helpers -----------------------------------------------------------------

function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth01 = (x) => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); };

function fmtTime(vt) {
  const s = Math.max(0, Math.min(vt, duration));
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function fmtLife(sec) {
  if (sec < 90) return `${sec.toFixed(1)}S`;
  if (sec < 5400) return `${(sec / 60).toFixed(1)}M`;
  return `${(sec / 3600).toFixed(1)}H`;
}

function trim(s, n = 46) {
  if (!s) return '—';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// palette hex ('#rrggbb') → rgba() string at a given alpha — canvas gradients
// need alpha stops, and every color still originates from the palette exports
function rgbaOf(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function vtOfPoint(x, z) {
  const theta = Math.atan2(x, z);
  const frac = (((startAngle - theta) / TAU) % 1 + 1) % 1;
  return frac * duration;
}

// nearest index in an ascending vt array (init-built plain arrays)
function nearest(vts, v) {
  if (!vts.length) return -1;
  let lo = 0, hi = vts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (vts[mid] <= v) lo = mid; else hi = mid;
  }
  return Math.abs(vts[lo] - v) <= Math.abs(vts[hi] - v) ? lo : hi;
}

// ---- plate canvas texture ----------------------------------------------------

function makePlateTexture(CSS, ch) {
  const SIZE = 2048, S = ch.rOuter + 1.5, C = SIZE / 2, k = C / S;
  const cv = document.createElement('canvas');
  cv.width = cv.height = SIZE;
  const g = cv.getContext('2d');
  const rng = mulberry(0x0C0C0C);
  // canvas mapping (verified against RingGeometry planar UVs + flipY):
  //   px = C + k*r*sin(theta), py = C + k*r*cos(theta)
  // → theta=startAngle(π) lands at canvas top, clockwise = clockwise on screen.
  const px = (r, th) => C + k * r * Math.sin(th);
  const py = (r, th) => C + k * r * Math.cos(th);
  const ring = (r0, r1, style, alpha) => {
    g.globalAlpha = alpha; g.fillStyle = style;
    g.beginPath();
    g.arc(C, C, k * r1, 0, TAU);
    g.arc(C, C, k * r0, 0, TAU, true);
    g.fill();
  };
  const circle = (r, style, alpha, lw) => {
    g.globalAlpha = alpha; g.strokeStyle = style; g.lineWidth = lw;
    g.beginPath(); g.arc(C, C, k * r, 0, TAU); g.stroke();
  };
  const radial = (r0, r1, th, style, alpha, lw) => {
    g.globalAlpha = alpha; g.strokeStyle = style; g.lineWidth = lw;
    g.beginPath(); g.moveTo(px(r0, th), py(r0, th)); g.lineTo(px(r1, th), py(r1, th)); g.stroke();
  };

  // base annulus — near-black, faintly lifted off the void
  ring(ch.rInner, ch.rOuter, CSS.void, 0.94);
  ring(ch.rInner, ch.rOuter, CSS.hudText, 0.018);

  // alternating faint lane fills — bands parse without a legend
  const L = ch.lanes;
  ring(L.tools[0], L.tools[1], CSS.hudText, 0.028);
  ring(L.subagents[0], L.subagents[1], CSS.hudText, 0.028);

  // brushed concentric noise — plate reads as machined metal, not flat fill
  for (let i = 0; i < 360; i++) {
    const r = ch.rInner + rng() * (ch.rOuter - ch.rInner);
    const a0 = rng() * TAU, span = 0.2 + rng() * 1.4;
    g.globalAlpha = 0.014; g.strokeStyle = CSS.hudDim; g.lineWidth = 1;
    g.beginPath(); g.arc(C, C, k * r, a0, a0 + span); g.stroke();
  }

  // minute marks: short RIM ticks only (UR-2 root cause: the old full-radius
  // grid lines crossed the whole annulus, and a radial line seen at grazing
  // angle IS a long bright streak — they read as ghost smears from any low
  // camera. Time stays legible from the rim ticks + quarter labels; nothing
  // printed crosses the lane field anymore.)
  for (let i = 0; i < 12; i++) {
    const th = startAngle - (i / 12) * TAU;
    radial(ch.rOuter + 0.05, ch.rOuter + 0.28, th, CSS.hudText, i % 3 === 0 ? 0.30 : 0.14, 1.5);
  }

  // dark gutter channels between lanes (LEGEND r2): brushed noise and the
  // minute-grid stop at each band edge, so every lane reads as its own
  // printed strip and the gantt lane no longer sinks into tick texture
  ring(L.hooks[1], L.subagents[0], CSS.void, 0.92);
  ring(L.subagents[1], L.dialogue[0], CSS.void, 0.92);
  ring(L.dialogue[1], L.tools[0], CSS.void, 0.92);

  // hairline concentric lane separators + rims
  for (const r of [L.hooks[0], L.hooks[1], L.subagents[0], L.subagents[1],
                   L.dialogue[0], L.dialogue[1], L.tools[0]]) {
    circle(r, CSS.hudText, 0.10, 2);
  }
  circle(ch.rInner, CSS.hudText, 0.18, 2.5);
  circle(ch.rOuter, CSS.hudText, 0.20, 2.5);
  circle(ch.rOuter + 0.55, CSS.hudDim, 0.10, 1.5);

  // quarter-mark ticks outside the rim (labels sit just beyond) + start notch
  for (let i = 0; i < 4; i++) {
    const th = startAngle - (i / 4) * TAU;
    radial(ch.rOuter + 0.05, ch.rOuter + 0.45, th, CSS.hudText, 0.5, 2.5);
  }
  radial(ch.rOuter + 0.05, ch.rOuter + 0.75, startAngle, CSS.cache, 1.0, 5);

  // lane names engraved along each band, starting just clockwise of 0:00 —
  // the rings decode without a legend. Small, uppercase, precise; plate ink,
  // so they inherit the past/future dimming like every other printed mark.
  const laneName = (text, r, size) => {
    g.font = `600 ${size}px Consolas, "Courier New", monospace`;
    g.fillStyle = CSS.hudText; g.globalAlpha = 0.55;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const R = k * r;
    let arc = 0;                        // px advanced along the band arc
    for (const chr of text) {
      const w = g.measureText(chr).width + size * 0.1;
      // canvas polar angle a = PI/2 - theta (same mapping as px/py above);
      // advancing a moves clockwise on screen = forward in session time
      const a = Math.PI / 2 - (startAngle - 0.1) + (arc + w / 2) / R;
      g.save();
      g.translate(C + R * Math.cos(a), C + R * Math.sin(a));
      g.rotate(a + Math.PI / 2);
      g.fillText(chr, 0, 0);
      g.restore();
      arc += w;
    }
  };
  laneName('TOOLS', 14.45, 40);
  laneName('DIALOGUE', 11.62, 32);
  laneName('AGENTS', 9.45, 27);
  laneName('HOOKS', 7.35, 25);

  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;   // grazing-angle crispness for the remaining hairlines
  return tex;
}

function makeLabel(text, CSS, color = null, scale = 1, opacity = 0.9) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 128;
  const g = cv.getContext('2d');
  g.font = '600 64px Consolas, "Courier New", monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  // soft void scrim behind the glyphs (LEGEND r3): axis labels stay legible
  // when a bright drone, tether beam, or spawn glyph crosses behind them
  const scrim = g.createRadialGradient(128, 62, 10, 128, 62, 84);
  scrim.addColorStop(0, rgbaOf(CSS.void, 0.78));
  scrim.addColorStop(0.6, rgbaOf(CSS.void, 0.55));
  scrim.addColorStop(1, rgbaOf(CSS.void, 0));
  g.fillStyle = scrim;
  g.fillRect(0, 0, 256, 128);
  g.globalAlpha = 0.95; g.fillStyle = color ?? CSS.hudText;
  g.fillText(text, 128, 62);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, opacity,
  }));
  sp.scale.set(2.7 * scale, 1.35 * scale, 1);
  sp.renderOrder = 4;
  return sp;
}

// ---- instanced batch builders (session-shaped; shared by init and reset) ------

// One InstancedBufferGeometry for a list of tick records. The detail ticks and
// the density-histogram bands are the same mark class with different records,
// so they share this builder — and so does every rebuild after a session swap.
// The returned `dim` attribute is the filter-dimming channel update() rewrites.
function buildTickGeo(rs) {
  const n = rs.length, S = CH.rOuter + 1.5;
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0], 3));
  geo.setIndex([0, 2, 1, 1, 2, 3]);
  const fA = new Float32Array(n), fR = new Float32Array(n), fL = new Float32Array(n),
    fW = new Float32Array(n), fC = new Float32Array(n * 3), fI = new Float32Array(n),
    fE = new Float32Array(n), fF = new Float32Array(n), fD = new Float32Array(n),
    fK = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rs[i];
    fA[i] = r.a; fR[i] = r.r0; fL[i] = r.len; fW[i] = r.w;
    fC[i * 3] = r.c.r; fC[i * 3 + 1] = r.c.g; fC[i * 3 + 2] = r.c.b;
    fI[i] = r.i; fE[i] = r.e; fF[i] = r.frac; fD[i] = 0; fK[i] = r.keep ? 1 : 0;
  }
  geo.setAttribute('aAngle', new THREE.InstancedBufferAttribute(fA, 1));
  geo.setAttribute('aR0', new THREE.InstancedBufferAttribute(fR, 1));
  geo.setAttribute('aLen', new THREE.InstancedBufferAttribute(fL, 1));
  geo.setAttribute('aWidth', new THREE.InstancedBufferAttribute(fW, 1));
  geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(fC, 3));
  geo.setAttribute('aInt', new THREE.InstancedBufferAttribute(fI, 1));
  geo.setAttribute('aErr', new THREE.InstancedBufferAttribute(fE, 1));
  geo.setAttribute('aFrac', new THREE.InstancedBufferAttribute(fF, 1));
  geo.setAttribute('aKeep', new THREE.InstancedBufferAttribute(fK, 1));
  const dim = new THREE.InstancedBufferAttribute(fD, 1);
  dim.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aDim', dim);
  geo.instanceCount = n;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, CH.y, 0), S + 1);
  return { geo, dim };
}

// Tick material. NOT session-shaped — every uniform is either one of the shared
// uniform OBJECTS (uFrac/uLod, written once per frame in update) or a palette
// constant — so it is built once in init and survives every swap untouched.
// Re-creating identical ShaderMaterials per swap would drop and recompile the
// program on every attract advance for no gain.
const makeTickMat = (PALETTE, yVal, lod) => new THREE.ShaderMaterial({
  uniforms: { uFrac, uY: { value: yVal }, uLod: lod, uErrCol: { value: new THREE.Color(PALETTE.error) } },
  vertexShader: TICK_VERT, fragmentShader: TICK_FRAG,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
});

// THE SESSION-SHAPED BUILD — everything that is a function of ctx.session /
// ctx.timeline and nothing else: subagent ring stacking, the per-event tick
// records, the 1s density histogram, the Gantt tessellation, the compaction
// scars, the per-lane nearest-event search arrays and the filter predicate.
// Called by init() and again by reset() after a session swap; the CALLER owns
// installing the geometries (init builds the meshes, reset disposes the old
// geometries and assigns the new ones onto the same meshes).
//
// Module state (subs / lane / matchesFilter / duration) is assigned only at the
// very END, so a throw mid-build leaves the session currently on screen
// internally consistent instead of half-swapped.
function buildSession(ctx) {
  const { session, timeline: tl, PALETTE, TOOL_COLORS, toolFamily } = ctx;
  const L = CH.lanes;
  const S = CH.rOuter + 1.5;
  const dur = tl.duration;

  // -- subagent sub-ring stacking (greedy interval coloring) ----------------
  const ringLast = [-Infinity, -Infinity, -Infinity];
  // 3 sub-ring centers spread across the lane band (band 8.0..10.0 → 8.45/9.13/9.81)
  const bandH = L.subagents[1] - L.subagents[0];
  const ringR = [0, 1, 2].map((i) => L.subagents[0] + bandH * (0.225 + i * 0.34));
  const subsNew = tl.subagents.map((s) => ({ ...s })).sort((a, b) => a.spawnVt - b.spawnVt);
  for (const s of subsNew) {
    let ri = ringLast.findIndex((end) => end <= s.spawnVt - 0.4);
    if (ri === -1) {                              // all occupied: least-recent ring
      ri = 0;
      for (let i = 1; i < 3; i++) if (ringLast[i] < ringLast[ri]) ri = i;
    }
    s.ring = ri;
    s.ringR = ringR[ri];
    ringLast[ri] = Math.max(ringLast[ri], s.endVt);
  }

  // -- event tick records ----------------------------------------------------
  const resById = new Map();
  let maxChars = 1;
  for (const e of tl.events) {
    if (e.kind === 'tool_result' && e.id) {
      resById.set(e.id, e);
      if (Number.isFinite(e.chars) && e.chars > maxChars) maxChars = e.chars;
    }
  }
  const logMax = Math.log(1 + maxChars);
  const famCol = {};
  for (const [fam, hex] of Object.entries(TOOL_COLORS)) famCol[fam] = new THREE.Color(hex);
  const famNames = Object.keys(TOOL_COLORS);
  const famIdx = {};
  famNames.forEach((fam, fi) => { famIdx[fam] = fi; });
  const cFresh = new THREE.Color(PALETTE.fresh);
  const cOut = new THREE.Color(PALETTE.output);
  const cThink = new THREE.Color(PALETTE.cache);
  const cHook = new THREE.Color(PALETTE.hook);
  const cSpawn = new THREE.Color(PALETTE.subagent).lerp(new THREE.Color(PALETTE.coreHot), 0.3);

  const dialH = L.dialogue[1] - L.dialogue[0];
  const toolH = L.tools[1] - L.tools[0];
  const recs = [];
  const laneNew = {
    tools: { vts: [], ev: [] },
    dial: { vts: [], ev: [] },
    hooks: { vts: [], ev: [] },
    all: { vts: [], ev: [] },
  };

  for (let i = 0; i < tl.events.length; i++) {
    const e = tl.events[i];
    const vt = tl.vts[i];
    const frac = vt / dur;
    const a = startAngle - frac * TAU;
    laneNew.all.vts.push(vt); laneNew.all.ev.push(e);
    if (e.kind === 'tool_call') {
      const res = resById.get(e.id);
      const chars = res && Number.isFinite(res.chars) ? res.chars : 0;
      const norm = logMax > 0 ? Math.log(1 + Math.max(0, chars)) / logMax : 0;
      recs.push({
        a, frac, r0: L.tools[0] + 0.06, len: 0.38 + (toolH - 0.55) * norm,
        w: 0.032, c: famCol[toolFamily(e.tool)] ?? famCol.other,
        i: 0.36, e: res && res.err ? 1 : 0, tool: e.tool,
      });
      laneNew.tools.vts.push(vt); laneNew.tools.ev.push(e);
    } else if (e.kind === 'user') {
      // full-height gate, trimmed to the band so the gutters stay clean;
      // keep: user turns are structural landmarks, exempt from LOD fade
      recs.push({ a, frac, r0: L.dialogue[0], len: dialH,
        w: 0.075, c: cFresh, i: 0.85, e: 0, tool: null, keep: 1 });
      laneNew.dial.vts.push(vt); laneNew.dial.ev.push(e);
    } else if (e.kind === 'say') {
      recs.push({ a, frac, r0: L.dialogue[0] + 0.06, len: dialH * 0.6,
        w: 0.026, c: cOut, i: 0.15, e: 0, tool: null });
      laneNew.dial.vts.push(vt); laneNew.dial.ev.push(e);
    } else if (e.kind === 'thinking') {
      recs.push({ a, frac, r0: L.dialogue[0] + 0.06, len: dialH * 0.3,
        w: 0.026, c: cThink, i: 0.085, e: 0, tool: null });
      laneNew.dial.vts.push(vt); laneNew.dial.ev.push(e);
    } else if (e.kind === 'hook') {
      recs.push({ a, frac, r0: L.hooks[0] + 0.12, len: 0.42,
        w: 0.05, c: cHook, i: 0.5, e: e.err ? 1 : 0, tool: null });
      laneNew.hooks.vts.push(vt); laneNew.hooks.ev.push(e);
    }
  }
  // spawn nodes ride the tick batch: bright violet markers at each arc's ring,
  // clamped inside the subagent band (gutters stay clean) and LOD-exempt
  for (const s of subsNew) {
    const nr0 = Math.max(L.subagents[0] + 0.05, s.ringR - 0.45);
    const nr1 = Math.min(L.subagents[1] - 0.05, s.ringR + 0.45);
    recs.push({
      a: startAngle - (s.spawnVt / dur) * TAU, frac: s.spawnVt / dur,
      r0: nr0, len: nr1 - nr0, w: 0.085, c: cSpawn, i: 1.0, e: 0, tool: null, keep: 1,
    });
  }

  // -- per-lane density bins (1s each): the overview LOD aggregate -----------
  // At overview range individual ticks are subpixel confetti, so each lane
  // aggregates into a histogram arc: bar length = events in bin, hue =
  // dominant family/kind, red tip = the bin contains an error.
  const NB = 180, NF = famNames.length, binW = dur / NB;
  const tCount = new Float32Array(NB), tFam = new Float32Array(NB * NF), tErrB = new Float32Array(NB);
  const dCount = new Float32Array(NB), dKind = new Float32Array(NB * 3);
  const hCount = new Float32Array(NB), hErrB = new Float32Array(NB);
  for (let i = 0; i < tl.events.length; i++) {
    const e = tl.events[i];
    const bi = Math.min(NB - 1, (tl.vts[i] / binW) | 0);
    if (e.kind === 'tool_call') {
      tCount[bi]++;
      tFam[bi * NF + famIdx[toolFamily(e.tool)]]++;
      const res = resById.get(e.id);
      if (res && res.err) tErrB[bi] = 1;
    } else if (e.kind === 'user') { dCount[bi]++; dKind[bi * 3] += 5; }
    else if (e.kind === 'say') { dCount[bi]++; dKind[bi * 3 + 1] += 1.2; }
    else if (e.kind === 'thinking') { dCount[bi]++; dKind[bi * 3 + 2] += 0.5; }
    else if (e.kind === 'hook') { hCount[bi]++; if (e.err) hErrB[bi] = 1; }
  }
  let tMax = 1, dMax = 1, hMax = 1;
  for (let b = 0; b < NB; b++) {
    if (tCount[b] > tMax) tMax = tCount[b];
    if (dCount[b] > dMax) dMax = dCount[b];
    if (hCount[b] > hMax) hMax = hCount[b];
  }
  const hookH = L.hooks[1] - L.hooks[0];
  const bandRecs = [];
  for (let b = 0; b < NB; b++) {
    const a = startAngle - ((b + 0.5) / NB) * TAU;
    const frac = (b + 0.5) / NB;
    if (tCount[b] > 0) {
      let fi = 0;
      for (let j = 1; j < NF; j++) if (tFam[b * NF + j] > tFam[b * NF + fi]) fi = j;
      const nm = tCount[b] / tMax;
      bandRecs.push({ a, frac, r0: L.tools[0] + 0.06, len: 0.3 + (toolH - 0.6) * nm,
        w: 0.4, c: famCol[famNames[fi]], i: 0.38 + 0.3 * nm, e: tErrB[b], tool: null });
    }
    if (dCount[b] > 0) {
      const wu = dKind[b * 3], ws = dKind[b * 3 + 1], wt = dKind[b * 3 + 2];
      const c = wu >= ws && wu >= wt ? cFresh : ws >= wt ? cOut : cThink;
      const nm = dCount[b] / dMax;
      bandRecs.push({ a, frac, r0: L.dialogue[0] + 0.05, len: 0.25 + (dialH - 0.5) * nm,
        w: 0.36, c, i: 0.34 + 0.28 * nm, e: 0, tool: null });
    }
    if (hCount[b] > 0) {
      const nm = hCount[b] / hMax;
      bandRecs.push({ a, frac, r0: L.hooks[0] + 0.08, len: 0.16 + (hookH - 0.35) * nm,
        w: 0.24, c: cHook, i: 0.45, e: hErrB[b], tool: null });
    }
  }

  // -- instanced tick batches (detail ticks + density bands) -----------------
  const N = recs.length;
  const tickTools = new Array(N);
  for (let i = 0; i < N; i++) tickTools[i] = recs[i].tool;
  const tickBuilt = buildTickGeo(recs);
  const bandBuilt = buildTickGeo(bandRecs);

  // -- subagent Gantt arcs (one merged geometry) -----------------------------
  const aPos = [], aFrac2 = [], aFade = [], aU = [], aIdx = [];
  const hw = 0.24, arcY = CH.y + 0.035;   // thicker bars: gantt reads over tick noise
  let vbase = 0;
  for (const s of subsNew) {
    const f0 = s.spawnVt / dur, f1 = s.endVt / dur;
    const span = (f1 - f0) * TAU;
    const segs = Math.min(160, Math.max(6, Math.ceil(span / 0.025)));
    for (let k2 = 0; k2 <= segs; k2++) {
      const t = k2 / segs;
      const th = startAngle - (f0 + (f1 - f0) * t) * TAU;
      const fade = 1 - 0.7 * t;                   // bright spawn end, fading tail
      const fr = f0 + (f1 - f0) * t;
      const sn = Math.sin(th), cs = Math.cos(th);
      aPos.push(sn * (s.ringR - hw), arcY, cs * (s.ringR - hw),
                sn * (s.ringR + hw), arcY, cs * (s.ringR + hw));
      aFrac2.push(fr, fr); aFade.push(fade, fade); aU.push(0, 1);
      if (k2 < segs) {
        const b = vbase + k2 * 2;
        aIdx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
      }
    }
    vbase += (segs + 1) * 2;
  }
  const arcGeo = new THREE.BufferGeometry();
  arcGeo.setAttribute('position', new THREE.Float32BufferAttribute(aPos, 3));
  arcGeo.setAttribute('aFrac', new THREE.Float32BufferAttribute(aFrac2, 1));
  arcGeo.setAttribute('aFade', new THREE.Float32BufferAttribute(aFade, 1));
  arcGeo.setAttribute('aU', new THREE.Float32BufferAttribute(aU, 1));
  arcGeo.setIndex(aIdx);

  // -- compaction scars (instanced radial cuts) ------------------------------
  const NC = tl.compactions.length;
  const scarGeo = new THREE.InstancedBufferGeometry();
  scarGeo.setAttribute('position', new THREE.Float32BufferAttribute(
    [-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0], 3));
  scarGeo.setIndex([0, 2, 1, 1, 2, 3]);
  const sA = new Float32Array(NC), sF = new Float32Array(NC), sS = new Float32Array(NC);
  for (let i = 0; i < NC; i++) {
    const fr = tl.compactions[i].vt / dur;
    sA[i] = startAngle - fr * TAU; sF[i] = fr; sS[i] = 3.7 + i * 17.31;
  }
  scarGeo.setAttribute('aAngle', new THREE.InstancedBufferAttribute(sA, 1));
  scarGeo.setAttribute('aFrac', new THREE.InstancedBufferAttribute(sF, 1));
  scarGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(sS, 1));
  scarGeo.instanceCount = NC;
  scarGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, CH.y, 0), S + 1);

  // -- filter semantics: totem names are top-12 tools + 'OTHER' --------------
  const numOf = (v) => (Number.isFinite(v?.count) ? Math.max(0, v.count) : 0);
  const top12 = new Set(Object.entries(session.tools ?? {})
    .sort((a, b) => numOf(b[1]) - numOf(a[1])).slice(0, 12).map(([n]) => n));
  const matches = (tool, f) => (f === 'OTHER' ? !top12.has(tool) : tool === f);

  // publish module state only now that the whole build has succeeded
  duration = dur;
  subs = subsNew;
  lane = laneNew;
  matchesFilter = matches;

  let rings = 0;                                  // no spread: subs can be long
  for (const s of subsNew) if (s.ring + 1 > rings) rings = s.ring + 1;
  console.log(`[chronogram] plate r${CH.rInner}-${CH.rOuter} · ${laneNew.tools.ev.length} tool ticks · ` +
    `${laneNew.dial.ev.length} dialogue · ${laneNew.hooks.ev.length} hooks · ` +
    `${subsNew.length} gantt arcs on ${rings} sub-rings · ${NC} scars · ${N} instanced ticks · ` +
    `${bandRecs.length} density bands`);

  return {
    tickGeo: tickBuilt.geo, tickDim: tickBuilt.dim, tickTools,
    bandGeo: bandBuilt.geo, arcGeo, scarGeo,
  };
}

// ---- module ------------------------------------------------------------------

export default {
  name: 'chronogram',

  init(ctx) {
    const { scene, PALETTE, CSS, CHRONO } = ctx;
    CH = CHRONO;
    startAngle = CH.startAngle;
    const L = CH.lanes;

    group = new THREE.Group();
    group.name = 'chronogram';

    // shared uniforms — one write in update() drives every material
    uFrac = { value: 0 };
    uTime = { value: 0 };
    uPulse = { value: 0 };
    uWakeOn = { value: 0 };
    uLodTick = { value: 1 };   // detail ticks: 1 near → 0.18 residual far
    uLodBand = { value: 0 };   // density bands: 0 near → 1 far

    // -- base plate (also the pick surface: RingGeometry → no corner hits) -----
    const S = CH.rOuter + 1.5;
    const plateGeo = new THREE.RingGeometry(CH.rInner - 0.4, S, 160, 1);
    const pos = plateGeo.attributes.position, uv = plateGeo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {           // planar UVs over the full disc
      uv.setXY(i, (pos.getX(i) / S + 1) / 2, (pos.getY(i) / S + 1) / 2);
    }
    plateMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: makePlateTexture(CSS, CH) },
        uFrac, uBright: { value: 1 },
        uStart: { value: startAngle },
      },
      vertexShader: PLATE_VERT, fragmentShader: PLATE_FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    plateMesh = new THREE.Mesh(plateGeo, plateMat);
    plateMesh.rotation.x = -Math.PI / 2;
    plateMesh.position.y = CH.y;
    plateMesh.renderOrder = 0.75;                   // after grid, before conduits
    group.add(plateMesh);

    // -- session-shaped batches: ticks, density bands, gantt arcs, scars -------
    // Built by the shared builder (see buildSession above) so init and reset()
    // walk exactly one code path. The MATERIALS below are built here and only
    // here — none of them is session-shaped, so a swap reuses them and never
    // pays a shader recompile.
    const built = buildSession(ctx);

    tickDimAttr = built.tickDim;
    tickToolArr = built.tickTools;
    tickMesh = new THREE.Mesh(built.tickGeo, makeTickMat(PALETTE, CH.y + 0.05, uLodTick));
    tickMesh.frustumCulled = false;
    tickMesh.renderOrder = 3;
    group.add(tickMesh);

    // density bands sit just under the detail ticks; the same shader dims the
    // future sector and relights the wake, so both LOD states read as one plate
    bandMesh = new THREE.Mesh(built.bandGeo, makeTickMat(PALETTE, CH.y + 0.03, uLodBand));
    bandMesh.frustumCulled = false;
    bandMesh.renderOrder = 2.9;
    group.add(bandMesh);

    const arcMat = new THREE.ShaderMaterial({
      uniforms: { uFrac, uCol: { value: new THREE.Color(PALETTE.subagent) } },
      vertexShader: ARC_VERT, fragmentShader: ARC_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    arcMesh = new THREE.Mesh(built.arcGeo, arcMat);
    arcMesh.renderOrder = 3;
    group.add(arcMesh);

    const scarMat = new THREE.ShaderMaterial({
      uniforms: {
        uFrac, uTime, uY: { value: CH.y + 0.065 },
        uR0: { value: CH.rInner - 0.3 }, uLen: { value: CH.rOuter - CH.rInner + 0.65 },
        uW: { value: 0.8 },
        uHot: { value: new THREE.Color(PALETTE.coreHot) },
        uRed: { value: new THREE.Color(PALETTE.error) },
      },
      vertexShader: SCAR_VERT, fragmentShader: SCAR_FRAG,
      transparent: true, depthWrite: false, blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    scarMesh = new THREE.Mesh(built.scarGeo, scarMat);
    scarMesh.frustumCulled = false;
    scarMesh.renderOrder = 3.5;      // after lane ink → the gap truly erases it
    group.add(scarMesh);
    // Design ruling: compaction marks on the ring
    // are removed entirely — compactions still read via the scrubber ticks,
    // HUD counter, and the tower collapse. Mesh kept but never rendered.
    scarMesh.visible = false;

    // -- playhead: sweep line + trailing wake wedge (rotated as one group) -----
    sweepGroup = new THREE.Group();
    const rA = CH.rInner - 0.3, rB = CH.rOuter + 0.6, sy = CH.y + 0.08, shw = 0.30;
    const sweepGeo = new THREE.BufferGeometry();
    sweepGeo.setAttribute('position', new THREE.Float32BufferAttribute(
      [-shw, sy, -rA, shw, sy, -rA, -shw, sy, -rB, shw, sy, -rB], 3));
    sweepGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
    sweepGeo.setIndex([0, 2, 1, 1, 2, 3]);
    const sweepMat = new THREE.ShaderMaterial({
      uniforms: {
        uPulse,
        uCyan: { value: new THREE.Color(PALETTE.coreEnergy) },
        uHot: { value: new THREE.Color(PALETTE.coreHot) },
      },
      vertexShader: SWEEP_VERT, fragmentShader: SWEEP_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const sweep = new THREE.Mesh(sweepGeo, sweepMat);
    sweep.frustumCulled = false;
    sweep.renderOrder = 4;
    sweepGroup.add(sweep);

    // triangular tip marker just outside the rim, pointing inward at the
    // playhead angle — the sweep is findable at a glance from any camera
    const tipGeo = new THREE.BufferGeometry();
    tipGeo.setAttribute('position', new THREE.Float32BufferAttribute([
      0, sy, -(CH.rOuter + 0.5),
      -0.32, sy, -(CH.rOuter + 1.1),
      0.32, sy, -(CH.rOuter + 1.1),
    ], 3));
    const tipMat = new THREE.MeshBasicMaterial({
      color: PALETTE.coreEnergy, transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const tip = new THREE.Mesh(tipGeo, tipMat);
    tip.frustumCulled = false;
    tip.renderOrder = 4;
    sweepGroup.add(tip);

    const WSEG = 28, WANG = 0.5, wy = CH.y + 0.015;
    const wPos = [], wA = [], wV = [], wIdx = [];
    for (let k2 = 0; k2 <= WSEG; k2++) {
      const t = k2 / WSEG;
      const th = startAngle + t * WANG;             // trailing side (past angles)
      const sn = Math.sin(th), cs = Math.cos(th);
      wPos.push(sn * CH.rInner, wy, cs * CH.rInner, sn * CH.rOuter, wy, cs * CH.rOuter);
      wA.push(t, t); wV.push(0, 1);
      if (k2 < WSEG) {
        const b = k2 * 2;
        wIdx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
      }
    }
    const wakeGeo = new THREE.BufferGeometry();
    wakeGeo.setAttribute('position', new THREE.Float32BufferAttribute(wPos, 3));
    wakeGeo.setAttribute('aA', new THREE.Float32BufferAttribute(wA, 1));
    wakeGeo.setAttribute('aV', new THREE.Float32BufferAttribute(wV, 1));
    wakeGeo.setIndex(wIdx);
    const wakeMat = new THREE.ShaderMaterial({
      uniforms: { uWakeOn, uCol: { value: new THREE.Color(PALETTE.coreEnergy) } },
      vertexShader: WAKE_VERT, fragmentShader: WAKE_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const wake = new THREE.Mesh(wakeGeo, wakeMat);
    wake.frustumCulled = false;
    wake.renderOrder = 3;
    sweepGroup.add(wake);
    group.add(sweepGroup);

    // -- hover ghost cursor (affordance: a dim line under the mouse angle) -----
    hoverGroup = new THREE.Group();
    hoverMat = new THREE.MeshBasicMaterial({
      color: PALETTE.hudText, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const hy = CH.y + 0.07, hhw = 0.028;
    const hovGeo = new THREE.BufferGeometry();
    hovGeo.setAttribute('position', new THREE.Float32BufferAttribute(
      [-hhw, hy, -(CH.rInner - 0.2), hhw, hy, -(CH.rInner - 0.2),
       -hhw, hy, -(CH.rOuter + 0.3), hhw, hy, -(CH.rOuter + 0.3)], 3));
    hovGeo.setIndex([0, 2, 1, 1, 2, 3]);
    const hovLine = new THREE.Mesh(hovGeo, hoverMat);
    hovLine.frustumCulled = false;
    hovLine.renderOrder = 4;
    hoverGroup.add(hovLine);
    group.add(hoverGroup);

    // -- quarter-mark labels ---------------------------------------------------
    const labelR = CH.rOuter + 1.55;
    const quarters = ['0:00', '0:45', '1:30', '2:15'];
    for (let i = 0; i < 4; i++) {
      const th = startAngle - (i / 4) * TAU;
      // 0:00 is THE time origin: cache-cyan (matches the start notch), larger,
      // full-bright — the anchor decodes before anything else on the plate
      const sp = i === 0
        ? makeLabel('0:00', CSS, CSS.cache, 1.3, 1.0)
        : makeLabel(quarters[i], CSS);
      // small lift (LEGEND r3) clears the tip triangle and in-plate glyph
      // traffic at grazing camera angles
      sp.position.set(Math.sin(th) * labelR, CH.y + 0.62, Math.cos(th) * labelR);
      group.add(sp);
    }

    // -- time label riding the playhead tip ------------------------------------
    // Cyan (binds to the sweep beam), just beyond the tip triangle and the
    // quarter labels; canvas redrawn only when the displayed second changes.
    const tcv = document.createElement('canvas');
    tcv.width = 256; tcv.height = 128;
    timeG = tcv.getContext('2d');
    timeG.font = '600 58px Consolas, "Courier New", monospace';
    timeG.textAlign = 'center'; timeG.textBaseline = 'middle';
    // scrim + fill rebuilt each redraw (the scrim keeps the readout legible
    // over rim glyphs); gradient allocated once here, reused every second
    timeScrim = timeG.createRadialGradient(128, 62, 8, 128, 62, 82);
    timeScrim.addColorStop(0, rgbaOf(CSS.void, 0.78));
    timeScrim.addColorStop(0.6, rgbaOf(CSS.void, 0.55));
    timeScrim.addColorStop(1, rgbaOf(CSS.void, 0));
    timeFill = CSS.coreEnergy;
    timeTex = new THREE.CanvasTexture(tcv);
    timeTex.colorSpace = THREE.SRGBColorSpace;
    timeTex.anisotropy = 4;
    timeSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: timeTex, transparent: true, depthWrite: false, opacity: 0.95,
    }));
    timeSprite.scale.set(2.2, 1.1, 1);
    timeSprite.renderOrder = 4;
    timeSprite.position.set(Math.sin(startAngle) * (CH.rOuter + 2.75), CH.y + 0.55,
      Math.cos(startAngle) * (CH.rOuter + 2.75));
    group.add(timeSprite);

    scene.add(group);

    // -- interaction: click = seek, hover = lane-aware data card ---------------
    // Registered ONCE, on the plate — which is static chrome that survives every
    // swap, so the registration survives too (main.js only prunes picks whose
    // object left the scene). The cards read the module-level `lane` / `subs` /
    // `matchesFilter` bindings, which buildSession() re-points at the new
    // session, and seek() goes through ctx.timeline — never a captured local.
    const subCard = (vt, r) => {
      let best = null, bestD = Infinity;
      for (const s of subs) {                       // covering arc, nearest ring
        if (s.spawnVt <= vt && s.endVt >= vt) {
          const d = Math.abs(s.ringR - r);
          if (d < bestD) { bestD = d; best = s; }
        }
      }
      if (!best) {                                  // else nearest spawn in window
        for (const s of subs) {
          const d = Math.abs(s.spawnVt - vt);
          if (d < 3 && d < bestD) { bestD = d; best = s; }
        }
      }
      if (!best) return null;
      return {
        title: (best.type || 'SUBAGENT').toUpperCase(),
        lines: [
          ['TIME', fmtTime(best.spawnVt)],
          ['TOOL', best.type || 'Agent'],
          ['DETAIL', trim(best.label)],
          ['LIFE', fmtLife(Math.max(0, best.endT - best.spawnT))],
        ],
      };
    };
    const evCard = (ln, vt, win) => {
      const i = nearest(ln.vts, vt);
      if (i < 0 || Math.abs(ln.vts[i] - vt) > win) return null;
      const e = ln.ev[i];
      const lines = [['TIME', fmtTime(ln.vts[i])]];
      if (e.tool) lines.push(['TOOL', e.tool]);
      lines.push(['DETAIL', trim(e.label ?? e.preview ?? e.name ??
        (Number.isFinite(e.chars) ? `${e.chars} CHARS` : '—'))]);
      if (e.err) lines.push(['ERR', 'TRUE']);
      return { title: (e.tool || e.kind).toUpperCase(), lines };
    };
    const cardForHit = (hit) => {
      const p = hit && hit.point;
      if (!p) return null;
      const r = Math.hypot(p.x, p.z);
      const vt = vtOfPoint(p.x, p.z);
      let card = null;
      if (r >= L.tools[0] - 0.1) card = evCard(lane.tools, vt, 1.2);
      else if (r >= L.dialogue[0] - 0.1) card = evCard(lane.dial, vt, 1.2);
      else if (r >= L.subagents[0] - 0.1) card = subCard(vt, r);
      else if (r >= CH.rInner - 0.2) card = evCard(lane.hooks, vt, 2.5);
      if (!card) card = evCard(lane.all, vt, 1.0);
      if (!card) card = { title: 'TIMELINE', lines: [['TIME', fmtTime(vt)], ['SEEK', 'CLICK TO JUMP']] };
      return card;
    };
    ctx.pick.register(plateMesh, {
      kind: 'chronogram',
      card: cardForHit,
      onClick: (hit) => {
        const p = hit && hit.point;
        if (p) ctx.timeline.seek(vtOfPoint(p.x, p.z));
      },
      onHover: (hit) => {
        const p = hit && hit.point;
        if (!p) { hoverTarget = 0; return; }
        hoverTarget = 1;
        hoverAngle = Math.atan2(p.x, p.z);
      },
    });

    lastFilter = null;
    hoverEase = 0; hoverTarget = 0; pulseV = 0; time = 0;
    lodEase = 0; lastSec = -1;
  },

  // IN-PLACE SESSION SWAP (see the SESSION SWAP CONTRACT in main.js). The plate
  // is a printed instrument face and the playhead is chrome: neither depends on
  // the session, so both stay. What IS session-shaped is the ink on the plate —
  // the four instanced/merged batches — plus the search arrays behind the hover
  // cards. Rebuild those from ctx.timeline, and give the old GPU buffers back
  // before returning: attract advances every few minutes for hours, so one
  // missed dispose is an unbounded leak, not a rounding error.
  //
  // KEPT ON PURPOSE (session-independent, allocated once in init, never leaked):
  //   · group, and its position in ctx.scene
  //   · plateMesh + its RingGeometry + plateMat + the 2048² plate CanvasTexture —
  //     the printed face (lanes, gutters, rim ticks, brushed noise, engraved lane
  //     names) is drawn from CHRONO radii and CSS only, with a fixed RNG seed. No
  //     session data touches it, so re-rasterizing that canvas on every advance
  //     would burn tens of ms and produce a byte-identical texture.
  //   · sweepGroup (beam + tip triangle + wake wedge) and hoverGroup + hoverMat,
  //     all pure CHRONO-constant geometry
  //   · the 4 quarter-label sprites and their canvas textures — fixed strings on
  //     a fixed 180s axis (Timeline.PLAY_SECONDS), identical for every session
  //   · timeSprite / timeTex / the TIME canvas + its cached scrim gradient — the
  //     readout is redrawn in place when the second turns; lastSec = -1 below
  //     forces that redraw on the first frame of the new session
  //   · the shared uniform OBJECTS (uFrac/uTime/uPulse/uWakeOn/uLodTick/uLodBand)
  //     — plateMat and the sweep hold references to these, so they must be
  //     mutated, never replaced, or the plate would stop tracking the playhead
  //   · all four ShaderMaterials of the data batches (tick / band / arc / scar):
  //     every uniform in them is
  //     either one of those shared objects or a palette constant, so recreating
  //     them would only buy a shader recompile per advance
  //   · the ctx.pick registration on plateMesh (plate never leaves the scene)
  reset(ctx) {
    if (!group) return;                 // init never completed — nothing to swap

    // Build FIRST: buildSession publishes module state only on success, so a
    // throw here leaves the session already on screen intact and consistent
    // (main.js then disables this module rather than rendering a half-swap).
    const built = buildSession(ctx);

    // Old session's GPU buffers — the only session-shaped allocations this
    // module makes. dispose() drops the VBOs/IBOs for every attribute,
    // including the instanced ones and the DynamicDrawUsage aDim channel.
    tickMesh.geometry.dispose();
    bandMesh.geometry.dispose();
    arcMesh.geometry.dispose();
    scarMesh.geometry.dispose();

    // Swap the new buffers onto the SAME meshes: group membership, renderOrder,
    // frustumCulled and material bindings all stay exactly as init set them, so
    // there is no window in which a mesh is detached or draw order can shift.
    tickMesh.geometry = built.tickGeo;
    tickDimAttr = built.tickDim;
    tickToolArr = built.tickTools;
    bandMesh.geometry = built.bandGeo;
    arcMesh.geometry = built.arcGeo;
    scarMesh.geometry = built.scarGeo;

    // Session-derived transients. lastFilter = null matches the freshly zeroed
    // aDim channel and main.js's clearing of ctx.state.filterTool, so the first
    // update() neither re-dims wrongly nor rewrites the attribute for nothing;
    // lastSec = -1 forces the TIME canvas redraw at the new session's vt 0;
    // pulseV is an event-fire flare belonging to the session that just ended.
    lastFilter = null;
    pulseV = 0;
    lastSec = -1;
    uFrac.value = 0;
    uPulse.value = 0;
    uWakeOn.value = 0;
    sweepGroup.rotation.y = 0;          // playhead back to 0:00 before the first frame

    // NOT reset — view/pointer state, not session state, and stable across a
    // swap per main.js's header: `lodEase` tracks ctx.camera distance (zeroing it
    // would pop the LOD crossfade back to detail ticks and re-fade for no
    // reason), `time` is the monotonic shader clock, and hoverEase/hoverTarget/
    // hoverAngle belong to the pointer, which interact.js re-drives every frame.
  },

  update(dt, state, ctx) {
    if (!group) return;
    time += dt;
    uTime.value = time;

    // playhead: angle from progress; wake ramps in over the first wedge-width
    const frac = state.progress;
    uFrac.value = frac;
    sweepGroup.rotation.y = -frac * TAU;
    uWakeOn.value = Math.min(1, (frac * TAU) / 0.5);

    // pulse where the sweep crosses fresh events (eases out < 2s)
    if (state.fired.length > 0) {
      pulseV = Math.min(1, pulseV + 0.3 + 0.02 * state.fired.length);
    }
    pulseV *= Math.exp(-3.4 * dt);
    uPulse.value = pulseV;

    // LOD: far camera aggregates ticks → density bands (eased crossfade on
    // camera distance; presets 0/2/4/5/6 land in band range, close-ups in tick
    // range). An active filter forces detail ticks — the matching set is
    // sparse, so it never reads as confetti — and mutes the aggregate bands.
    const f = ctx.state.filterTool;
    const lodT = smooth01((ctx.camera.position.length() - 30) / 14);
    lodEase += (lodT - lodEase) * Math.min(1, dt * 8);
    uLodTick.value = f ? 1 : 1 - 0.82 * lodEase;
    uLodBand.value = (f ? 0.12 : 1) * lodEase;

    // filter dimming — attribute rewrite only when the filter actually changes
    if (f !== lastFilter) {
      lastFilter = f;
      const dims = tickDimAttr.array;
      for (let i = 0; i < tickToolArr.length; i++) {
        const t = tickToolArr[i];
        dims[i] = f && t && !matchesFilter(t, f) ? 1 : 0;
      }
      tickDimAttr.needsUpdate = true;
    }

    // hover affordance: ghost cursor line + plate brighten, eased
    hoverEase += (hoverTarget - hoverEase) * Math.min(1, dt * 12);
    hoverMat.opacity = 0.3 * hoverEase;
    if (hoverTarget > 0) hoverGroup.rotation.y = hoverAngle - startAngle;
    plateMat.uniforms.uBright.value = 1 + 0.22 * hoverEase;

    // time label rides the playhead tip; canvas redraw only when the second turns
    const sec = Math.floor(state.vt);
    if (sec !== lastSec) {
      lastSec = sec;
      timeG.clearRect(0, 0, 256, 128);
      timeG.fillStyle = timeScrim;
      timeG.fillRect(0, 0, 256, 128);
      timeG.fillStyle = timeFill;
      timeG.fillText(fmtTime(state.vt), 128, 62);
      timeTex.needsUpdate = true;
    }
    // collision-offset (LEGEND r3): as the playhead nears a quarter mark the
    // TIME glyph glides outward and up, so it never sits on the printed
    // 0:00 / 0:45 / 1:30 / 2:15 axis labels (worst case was vt=0: two cyan
    // "0:00" readouts stacked at 12 o'clock)
    const tipA = startAngle - frac * TAU;
    const qf = (frac * 4) % 1;
    const qPush = smooth01(1 - Math.min(qf, 1 - qf) * (TAU / 4) / 0.26);
    const tipR = CH.rOuter + 2.75 + 1.35 * qPush;
    timeSprite.position.set(Math.sin(tipA) * tipR, CH.y + 0.55 + 0.5 * qPush, Math.cos(tipA) * tipR);
  },
};
