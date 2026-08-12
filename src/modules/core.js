// core.js — THE CORE. Nested gyroscope reactor: precessing machined rings
// around a fresnel plasma heart, with ONE ring serving as the session's
// output-token gauge. The core is DATA-BEARING, not ornament.
//
// Round-9 refit (KILLSCREEN r4 + LEGEND r4 + UR-3, luminance law binding):
// (1) THE EQUATORIAL MAGENTA FLARE ANNULUS IS DELETED. The expanding
//     shockwave rings (UR-3's mystery mesh — data-free, blown, washing the
//     heart to white in plate views) are gone entirely. A 'user' event now
//     reads as the heart's magenta fresnel rim kick + halo/light surge — an
//     envelope (userFlare) that decays within ~2s and lives under the heart's
//     luminance ceiling. Nothing about a user gate can blow out a frame.
// (2) EXACTLY ONE RING IS THE GAUGE (LEGEND r4). The old billboarded dial is
//     retired. The outermost ring is now a STATIC EQUATORIAL instrument:
//     a quiet machined track torus (no greeble, no circuitry band — low-mid
//     body), a flat holographic annulus welded to its plane carrying the tick
//     structure and a bright continuous 0-to-current amber arc (the thin hot
//     rim over the low-mid body), and tick labels baked into ONE canvas plane
//     welded to the same plane (0/1K/2K/4K/8K/16K/32K + captions — one draw,
//     replacing ten sprites; perf P2 core.js:798). Angular convention matches
//     the chronogram: zero at 12 o'clock (world -Z from cam0), clockwise from
//     above. Scale stays LOG2 (round-7 rationale: a typical 1-3K turn was an
//     undecodable sliver on linear) — 45° linear 0→1K, then five 45°
//     doublings to 32K. Arc fill = tokToFill(current turn's output tokens);
//     sweeps back to zero on every 'say'. The live 'OUT N' readout rides the
//     arc tip just above the track. Emissive clamped at 2.4 — far below the
//     heart's 6.0 ceiling, so THE HEART STAYS THE FRAME'S SINGLE HOTTEST
//     POINT (luminance law). Registered in ctx.pick (kind 'gauge') with a
//     METRIC / NOW / SCALE / PEAK card.
// (3) THE OTHER TWO RINGS DROP TO 30% OPACITY (LEGEND r4): they keep their
//     circuitry bands, hardware, precession and rate-coupled spin, but render
//     transparent at 0.30 — structure, middle of the luminance order, never
//     competing with data marks.
// (4) THE HEART'S MARBLING NOW ENCODES RECENT EVENT RATE (LEGEND r4: churn
//     speed AND luminance ride the same ~5s event-rate EMA that drives ring
//     spin). Flow advection integrates on the CPU (flowT) so speed changes
//     never phase-jump the pattern; convection contrast and a modest interior
//     luminance lift scale with the normalized rate. Idle session → calm
//     glass; storm → visible churn. Declared on the pick card (CHURN line).
//     In shot mode the EMA is seeded from actual local event density at the
//     seek point (deterministic), so frozen frames stay honest.
// (5) PICK PROXIES (perf P0 core.js:890): the 6.9k-tri heart and 21.6k-tri
//     gyro tori are no longer raycast. Invisible-material low-poly proxies
//     (8x6 sphere, coarse torus hulls riding each spin group, one fat torus
//     hull for the gauge) are registered instead — the drones.js pattern.
//     Zero draw cost, ~200 tris total for the whole registry walk.
// (6) READOUT REDRAW GATE (perf P1 core.js:1027): the displayed token value
//     quantizes to the nearest 10 while the ease is moving and snaps exact on
//     dt===0 (shot mode) and when the ease settles below a 1-token delta —
//     the 448x112 canvas + GPU reupload now happens a few times a second
//     during sweeps instead of every frame.
// (7) Preserved: 'say' → amber pulse (expo decay ~1.5s) + heart swell + gauge
//     reset sweep; 'thinking' → high-frequency shimmer; 'user' → magenta rim
//     kick (see 1). Ring spin rate ∝ event rate (spinMul 1..3), declared on
//     the card. Distance-authority gain capped (~2.4x) so wides bloom small
//     and hot without washing the frame.
//
// Round-3 verification holds: all shader uniforms start finite at frame 0
// (dt=0 safe); direction vectors are epsilon-guarded; heart output clamped at
// 6.0 and gauge at 2.4 (both far below fp16 max) — this module can never
// inject Inf/NaN into a half-float post chain.
// All colors from PALETTE. All allocation in init().

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// module state (assigned in init)
let group;                 // whole assembly at (0, coreY, 0)
let gyro;                  // rotating gyroscope subgroup (the two ornament rings)
let rings = [];            // { tilt, spin, baseX, baseZ, speed, wobF, wobA, phase }
let ringMat, greebleMat;
let heart, heartMat;
let glowSprite, glowMat;   // additive halo billboard
let disc, discMat;         // ground-projected glow
let coreLight;
let rimC;                  // heart say-surge color (amber → magenta on user flare)
let haloBaseScale = 1;
let gaugeGroup;            // static equatorial instrument assembly
let gaugeMesh, gaugeMat;   // flat holographic annulus: track, ticks, fill arc
let trackMat;              // quiet machined track torus material
let labelMesh, labelMat;   // single baked canvas plane: numerals + captions
let gaugeR = 0;            // gauge ring radius (world units, group-local)
let gaugeReadout;          // live monospace datum tag riding the arc tip
let sessionRef = null;     // for the pick card

let sayPulse = 0, heatEnv = 0, shimmer = 0, time = 0;
let userFlare = 0;         // 'user' event envelope — magenta rim kick, ~2s decay
let flowT = 0;             // integrated churn time — heart advection clock
let gaugeFill = 0, gaugeTok = 0, gaugeResetT = 0;  // fill 0..1 (log2-mapped), eased token datum, reset-sweep timer
let lastReadTok = -1;      // last token count drawn into the readout canvas
let peakOut = 0;           // session's hottest turn (from contextCurve)
let rateEMA = 0;           // smoothed timeline events/sec (~5s memory)
let spinMulNow = 1;        // current ring-spin multiplier — surfaced on the card
let hoverEnv = 0, hoverT = 0;          // pick-hover affordance envelope
let gHoverT = 0, gHoverEnv = 0;        // gauge hover affordance envelope
let filterEnv = 0;         // ctx.state.filterTool dim envelope
let COL_CYAN, COL_AMBER, COL_MAGENTA, tmpC;

const TAU = Math.PI * 2;

// distance-authority gain: 1 at/below GAIN_D0 (close-ups keep the round-3
// calibration), smoothstepped up to 1+GAIN_K at/beyond GAIN_D1 (boulevard).
// Round-5: GAIN_K cut 2.6 → 1.4 — wides still cross the post chain's 1.2
// bloom threshold at the limb, but the heart can no longer wash the rings.
const GAIN_D0 = 16, GAIN_D1 = 60, GAIN_K = 1.4;

// THE GAUGE: 270° of arc on a LOG2 scale. Linear 0→1K over the first 45°,
// then one 45° segment per doubling up to 32k (the model family's per-turn
// output ceiling; the session's hottest turn measured 31,633). Log because a
// typical turn (1–3K tokens) was an undecodable sliver on a linear sweep.
const GAUGE_TOKEN_CAP = 32000;
const GAUGE_LOG_FLOOR = 1000;             // linear below this, log2 above
const GAUGE_SEGMENTS = 1 + Math.log2(GAUGE_TOKEN_CAP / GAUGE_LOG_FLOOR); // 6 × 45°
const GAUGE_MAX_ANGLE = Math.PI * 1.5;    // 270°
const GAUGE_RESET_SWEEP = 0.35;           // seconds of sweep-back on 'say'

// log2 angle map: tokens → 0..1 of the 270° span
function tokToFill(tok) {
  const t = Math.max(tok, 0);
  const u = t <= GAUGE_LOG_FLOOR ? t / GAUGE_LOG_FLOOR : 1 + Math.log2(t / GAUGE_LOG_FLOOR);
  return Math.min(u / GAUGE_SEGMENTS, 1);
}

// non-data ornament discipline: the two precessing rings rest dim AND render
// at 30% opacity (LEGEND r4) — structure sits in the middle of the luminance
// order, under the data marks (gauge arc, heart state).
const RING_REST_DIM = 0.50;
// UR-5 (user ruling): full-presence rings — LEGEND's 30% dimming is overruled
const RING_OPACITY = 1.0;

// hardware slimming (round-8): absolute block dimensions scale by this so the
// instanced hardware stays fine filigree on the thinned tubes.
const HW_SLIM = 0.7;

// event-rate → spin/churn coupling. Session average is ~45 events/s of viz
// time; spinMul = 1 + rate/60 capped at 3 → calm 1x, average ~1.75x, peak 3x.
// rateN = rate/90 capped at 1 normalizes the same EMA for the heart's churn
// contrast, advection speed, and interior luminance lift.
const RATE_TAU = 5;        // seconds of smoothing memory
const RATE_TO_SPIN = 1 / 60;
const SPIN_MUL_MAX = 3;
const RATE_NORM = 90;      // events/s that saturate the heart churn

// deterministic PRNG so hardware placement is stable across reloads (shot mode)
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// shaders

const HEART_VERT = /* glsl */`
varying vec3 vN;
varying vec3 vW;
varying vec3 vP;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  vP = position;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const HEART_FRAG = /* glsl */`
uniform float uTime;     // wall clock — cosmetic flicker only
uniform float uFlow;     // integrated churn clock — advection (rate-driven, phase-continuous)
uniform float uBreath;   // 0..1 slow breathing
uniform float uPulse;    // 0..1 say-pulse, fast brightness kick
uniform float uHeat;     // 0..1 interior surge envelope (say events)
uniform float uShimmer;  // 0..1 thinking shimmer
uniform float uRate;     // 0..1 normalized recent event rate — churn contrast + luminance
uniform float uFlare;    // 0..1 user-flare envelope (magenta rim kick)
uniform float uGain;     // 1..~2.4 distance-authority gain (wide shots)
uniform vec3  uBody;     // coreEnergy cyan — the plasma body AND resting rim
uniform vec3  uHot;      // coreHot — pale filament white
uniform vec3  uRim;      // say-surge amber; CPU kicks it magenta on flare
uniform vec3  uMag;      // fresh magenta — user-flare rim color
varying vec3 vN;
varying vec3 vW;
varying vec3 vP;

float hash3(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i),                  hash3(i + vec3(1,0,0)), f.x),
        mix(hash3(i + vec3(0,1,0)),    hash3(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0,0,1)),    hash3(i + vec3(1,0,1)), f.x),
        mix(hash3(i + vec3(0,1,1)),    hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm3(vec3 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { v += a * vnoise(p); p = p * 2.07 + vec3(11.31); a *= 0.5; }
  return v;
}
float fbm4(vec3 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.13 + vec3(7.77); a *= 0.5; }
  return v;
}

void main() {
  // epsilon-guarded normalize: a fly-through camera or degenerate varying
  // interpolation can never produce a zero-length vector → NaN here
  vec3 Vd = cameraPosition - vW;
  vec3 V = Vd / max(length(Vd), 1e-5);
  vec3 N = vN / max(length(vN), 1e-5);
  float ndv = clamp(dot(N, V), 0.0, 1.0);

  // -- flow field: height-sheared swirl + rising convection, domain-warped
  // twice. Advection rides uFlow — the CPU-integrated churn clock — so the
  // plasma literally moves faster when the session runs hot, with no phase
  // jumps as the rate changes.
  float tt = uFlow;
  float sw = tt * 0.24 + vP.y * 0.5;
  mat2 rot = mat2(cos(sw), -sin(sw), sin(sw), cos(sw));
  vec3 p = vP * vec3(1.4, 0.9, 1.4);               // vertically stretched cells
  p.xz = rot * p.xz;

  float q = fbm3(p * 1.4 + vec3(0.0, -tt * 0.6, 0.0));
  float w = fbm3(p * 2.3 + vec3(tt * 0.17, -tt * 0.45, -tt * 0.11) + q * 3.0);
  float n = fbm4(p * 2.0 + vec3(w * 3.4, w * 2.5 - tt * 0.3, q * 2.6));

  // marbling = RECENT EVENT RATE (LEGEND r4): convection contrast rides the
  // normalized ~5s event-rate EMA — an idle session flattens toward calm
  // glass, a tool-call storm visibly churns. Contrast-only here (speed lives
  // in uFlow), so the pattern never phase-jumps as the envelope moves.
  float act = 0.35 + 0.65 * uRate;
  float churn = smoothstep(0.26, 0.76, n) * act;     // convection cells
  float ridge = pow(1.0 - abs(2.0 * w - 1.0), 5.0) * act; // filament streaks

  // -- interior: CHURN drives luminance (round-5). View depth only opens the
  // window — the convection cells stay legible at dead center because a
  // low-churn cell at ndv=1 still reads deep, not white. Most of the body
  // sits in the low-mids per the lighting law.
  float depth = pow(ndv, 1.5);
  float heat = depth * (0.18 + 0.82 * churn) + ridge * depth * 0.30;
  heat *= 0.85 + 0.15 * uBreath;
  heat = clamp(heat, 0.0, 1.0);

  // -- cyan plasma body: deep floor → coreEnergy → pale filament threads.
  // Filaments approach uHot; cells never do — that contrast IS the churn.
  vec3 deep = uBody * uBody * 0.45;
  vec3 col = deep * (0.22 + 0.38 * churn);
  col = mix(col, uBody, smoothstep(0.15, 0.62, heat));
  col = mix(col, mix(uBody, uHot, 0.75), smoothstep(0.72, 0.98, heat));
  col *= 0.35 + 0.80 * heat + 0.30 * churn;
  col += uHot * ridge * depth * (0.30 + 0.55 * heat);

  // churn LUMINANCE also rides the event rate (LEGEND r4) — interior only,
  // applied before the rim/say terms so transients keep full strength
  col *= 0.88 + 0.30 * uRate;

  // high-frequency shimmer: 48Hz stepped flicker, only while uShimmer > 0
  float flick = fract(sin(floor(uTime * 48.0) * 7.31) * 43758.5453) - 0.5;

  // -- RESTING fresnel rim: cyan, modest — the machine at calm is cold light.
  float f1 = pow(1.0 - ndv, 2.0);
  float f2 = pow(1.0 - ndv, 5.0);
  float rimMix = smoothstep(0.25, 0.75, f1);
  col = mix(col, uBody * (0.50 + 0.40 * churn), rimMix * 0.55);
  col += uBody * f1 * (0.45 + 0.15 * uBreath);
  col += mix(uBody, uHot, 0.70) * f2 * (1.8 + 0.3 * uBreath)
         * (1.0 + uShimmer * flick * 0.9);
  col *= 1.0 + uShimmer * flick * 0.22;

  // -- SAY: amber exists only here, gated by the decaying surge envelope.
  // The speaking color floods the churn field from the center out, and the
  // rim goes amber with it — then everything cools back to cyan.
  vec3 surge = mix(uRim, vec3(1.0), 0.30 + 0.25 * uPulse);
  col = mix(col, surge * (0.6 + 1.3 * heat + 0.6 * churn), uHeat * 0.85);
  col += uRim * f1 * uHeat * 1.3;
  col += mix(uRim, vec3(1.0), 0.55) * f2 * uHeat * 2.0;

  // -- USER flare: magenta rim kick, decaying envelope (~2s). This IS the
  // user-gate visual now — the blown equatorial annulus is deleted (UR-3).
  col += uMag * f1 * uFlare * 1.1;
  col = mix(col, uMag * (0.5 + 0.8 * heat), uFlare * rimMix * 0.35);

  // say-pulse: quick gain kick on top of the surge
  col *= 1.0 + uPulse * 0.45;

  // -- distance authority: in wides the heart is few pixels but the limb
  // clears the post chain's bloom threshold — small, hot, anchoring
  col *= uGain;

  // -- luminance ceiling: capped LOW so the rings crossing the heart stay
  // readable through bloom, but this 6.0 is still the HIGHEST clamp in the
  // module — the heart is the frame's single hottest point (luminance law).
  // Far below fp16 max — no Inf/NaN can leave this shader.
  col = min(col, vec3(6.0));

  gl_FragColor = vec4(col, 1.0);
}`;

// THE GAUGE — static equatorial instrument ring; fill angle = the current
// turn's output tokens, LOG2-mapped (CPU side, tokToFill). Zero at 12 o'clock
// (world -Z from cam0, matching the chronogram's start), clockwise viewed
// from above; 270° = GAUGE_TOKEN_CAP. Anatomy: a quiet rail track across the
// full span (the axis), a legible boundary tick at every log2 doubling
// (uniform 45° spacing), long bright end stops at 0 and max, a bright
// continuous amber fill arc from 0 to the live datum, and a hot terminus dot
// at the fill head. uR0/uR1 are the RAIL radii; the mesh carries extra radial
// margin so ticks and the dot draw outside the rail without clipping.
// Output clamped at 2.4 — the heart (6.0) stays the frame's hottest point.
const GAUGE_VERT = /* glsl */`
varying vec2 vXY;
void main() {
  vXY = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const GAUGE_FRAG = /* glsl */`
uniform float uFill;     // 0..1 of the 270° span
uniform float uPulse;    // say flash
uniform float uTime;
uniform float uLevel;    // master intensity (hover lift, filter dim)
uniform float uR0;       // rail inner radius (world units, local plane)
uniform float uR1;       // rail outer radius
uniform vec3  uFillC;    // amber — model output
uniform vec3  uTrackC;   // hudDim — the scale track and ticks
varying vec2 vXY;

const float MAXA = 4.7123890;   // 270°
const float TAU  = 6.2831853;

// angular gaussian tick with wrap-around, sharpness S in rad^-2
float tickAt(float a, float at, float S) {
  float d = abs(a - at);
  d = min(d, TAU - d);
  return exp(-d * d * S);
}

void main() {
  float r = length(vXY);
  float mid = 0.5 * (uR0 + uR1);
  float hw  = max(0.5 * (uR1 - uR0), 1e-4);

  float ang = atan(vXY.y, vXY.x);
  float a = mod(1.5707963 - ang, TAU);        // clockwise from local 12
  float inSpan = 1.0 - smoothstep(MAXA, MAXA + 0.02, a);

  // -- the rail: a fixed 270° track, always readable — this is the axis
  float rail = smoothstep(hw, hw * 0.30, abs(r - mid));
  vec3 col = uTrackC * 0.95 * rail * inSpan;

  // -- ticks: log2 boundary marks (1K/2K/4K/8K/16K — one per doubling,
  // uniform 45° spacing) crossing the rail; end stops at 0 and 32K reach
  // further both ways and burn brighter (scale anchors). The scale must
  // decode from a full-frame close-up, not just under inspection.
  float rQ = smoothstep(mid - hw * 2.0, mid - hw * 0.5, r)
           * (1.0 - smoothstep(mid + hw * 3.5, mid + hw * 4.5, r));
  float rE = smoothstep(mid - hw * 3.5, mid - hw * 2.0, r)
           * (1.0 - smoothstep(mid + hw * 5.0, mid + hw * 6.0, r));
  float q = 0.0;
  for (int k = 1; k < 6; k++) q += tickAt(a, MAXA * float(k) / 6.0, 9000.0);
  float e = tickAt(a, 0.0, 5000.0) + tickAt(a, MAXA, 5000.0);
  col += mix(uTrackC, vec3(1.0), 0.20) * q * rQ * 2.4;    // doublings: legible
  col += mix(uTrackC, vec3(1.0), 0.40) * e * rE * 3.0;    // end stops: anchors

  // -- amber fill on the rail: the bright continuous 0-to-current arc —
  // brightens toward the head, carries the eye (the thin hot rim over the
  // ring's low-mid body)
  float fillA = uFill * MAXA;
  float lit = (1.0 - smoothstep(fillA - 0.015, fillA + 0.015, a)) * inSpan;
  float grad = 0.55 + 0.45 * clamp(a / max(fillA, 1e-3), 0.0, 1.0);
  col += uFillC * rail * lit * grad * (1.25 + 0.75 * uPulse);

  // -- terminus dot: the live datum — a hot round marker at the fill head
  vec2 tipP = vec2(sin(fillA), cos(fillA)) * mid;
  float dd2 = dot(vXY - tipP, vXY - tipP);
  float dotC = exp(-dd2 * 340.0);
  float halo = exp(-dd2 * 60.0) * 0.35;
  col += mix(uFillC, vec3(1.0), 0.55) * (dotC * (1.9 + 0.9 * uPulse) + halo);

  // holographic scan shimmer, subtle
  col *= 1.0 + 0.06 * sin(a * 60.0 - uTime * 4.0);

  col *= uLevel;
  // luminance law: hard ceiling well below the heart's 6.0 — the gauge is
  // the brightest STRUCTURE-ADJACENT data mark, never the hottest point
  col = min(col, vec3(2.4));
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------
// canvas textures (procedural, generated in init — no external assets)

// Circuitry band wrapped around each torus: twin rails, machined panel seams,
// dashed data runs down the center channel, tick clusters, hot node pads.
function makeRingBandTexture() {
  const rnd = mulberry32(90210);
  const c = document.createElement('canvas');
  c.width = 2048; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 2048, 64);

  // machined panels of irregular width with bright seam edges
  let x = 0;
  while (x < 2048) {
    const w = 60 + rnd() * 160;
    g.fillStyle = `rgba(255,255,255,${(0.04 + rnd() * 0.05).toFixed(3)})`;
    g.fillRect(x + 2, 4, w - 4, 56);
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillRect(x, 12, 2, 40);
    x += w;
  }

  // twin continuous rails — the machined track read
  g.fillStyle = 'rgba(255,255,255,0.5)';
  g.fillRect(0, 8, 2048, 2);
  g.fillRect(0, 54, 2048, 2);

  // dashed data runs down the center channel
  x = 0;
  while (x < 2048) {
    const w = 20 + rnd() * 90;
    if (rnd() < 0.7) {
      g.fillStyle = `rgba(255,255,255,${(0.18 + rnd() * 0.25).toFixed(3)})`;
      g.fillRect(x, 29, w, 6);
    }
    x += w + 6 + rnd() * 30;
  }

  // circuitry ticks of varying width/height/brightness
  for (let i = 0; i < 170; i++) {
    const tx = rnd() * 2048;
    const w = 2 + rnd() * 8;
    const h = 6 + rnd() * 30;
    const b = 0.15 + rnd() * 0.6;
    g.fillStyle = `rgba(255,255,255,${b.toFixed(3)})`;
    g.fillRect(tx, 32 - h / 2, w, h);
  }

  // hot node pads riding the rails
  for (let i = 0; i < 48; i++) {
    const tx = rnd() * 2048;
    const ty = rnd() < 0.5 ? 5 : 51;
    const s = 4 + rnd() * 3;
    g.fillStyle = `rgba(255,255,255,${(0.6 + rnd() * 0.4).toFixed(3)})`;
    g.fillRect(tx, ty, s, s + 2);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Small circuit-chip face for the instanced hardware blocks: bus traces,
// solder pads, one hot strip. Every block face reads as etched circuitry.
function makeChipTexture() {
  const rnd = mulberry32(4242);
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 7; i++) {
    g.fillStyle = `rgba(255,255,255,${(0.18 + rnd() * 0.3).toFixed(3)})`;
    g.fillRect(rnd() * 60, 8 + rnd() * 112, 30 + rnd() * 80, 2);
  }
  for (let i = 0; i < 7; i++) {
    g.fillStyle = `rgba(255,255,255,${(0.15 + rnd() * 0.28).toFixed(3)})`;
    g.fillRect(8 + rnd() * 112, rnd() * 60, 2, 30 + rnd() * 80);
  }
  for (let i = 0; i < 16; i++) {
    const s = 3 + rnd() * 5;
    g.fillStyle = `rgba(255,255,255,${(0.5 + rnd() * 0.5).toFixed(3)})`;
    g.fillRect(rnd() * (128 - s), rnd() * (128 - s), s, s);
  }
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.fillRect(rnd() * 90, rnd() * 120, 26 + rnd() * 30, 3);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeRadialTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.16)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// gauge chart labels.
//
// TICK LABELS ARE WELDED TO THE RING'S PLANE (LEGEND r4): every numeral and
// caption is baked once into a single transparent canvas mapped onto ONE flat
// plane lying in the gauge's equatorial plane — one draw call for all static
// chart text (was ten sprites; perf P2 core.js:798). Text is drawn white and
// tinted through material.color (palette discipline). Numerals sit INSIDE the
// rail (speedometer idiom); non-uniform values (0/1K/2K/4K/8K/16K/32K) at
// uniform 45° spacing announce the log scale, and the LOG2 SCALE sub-caption
// says it in words. The caption pair sits in the dead quadrant, pulled INSIDE
// the ring so nothing projects over the chronogram's lanes in the top-down
// plate (UR-3 discipline). depthTest OFF: chart ink is holographic — the
// precessing rings would otherwise slice glyphs mid-word at close-up, and a
// chart that sometimes fails to decode is not a chart.

const LABEL_PLANE_SIZE = 14.4;   // world units, square
const LABEL_PLANE_PX = 1024;

function makeGaugeLabelPlane(gaugeRadius, hudTextColor) {
  const cv = document.createElement('canvas');
  cv.width = LABEL_PLANE_PX; cv.height = LABEL_PLANE_PX;
  const g = cv.getContext('2d');
  const k = LABEL_PLANE_PX / LABEL_PLANE_SIZE;      // px per world unit
  const cx = LABEL_PLANE_PX / 2, cy = LABEL_PLANE_PX / 2;

  // angle a: clockwise from 12 o'clock (local +Y = canvas up), radius r world
  const put = (txt, a, r, px, alpha, spacing, dy = 0) => {
    g.font = `700 ${px}px Consolas, "Courier New", monospace`;
    if ('letterSpacing' in g) g.letterSpacing = spacing;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = `rgba(255,255,255,${alpha})`;
    g.fillText(txt, cx + Math.sin(a) * r * k, cy - Math.cos(a) * r * k + dy);
  };

  // scale numerals at every log2 boundary, inside the rail. End numerals are
  // brighter (scale anchors) and inset ±0.13 rad to clear the end-stop ticks.
  const rNum = gaugeRadius - 0.62;
  const NUMERALS = [   // [text, fraction of span, angular inset, font px, alpha]
    ['0',   0,     -0.13, 40, 0.62],
    ['1K',  1 / 6,  0,    32, 0.50],
    ['2K',  2 / 6,  0,    32, 0.50],
    ['4K',  3 / 6,  0,    32, 0.50],
    ['8K',  4 / 6,  0,    32, 0.50],
    ['16K', 5 / 6,  0,    32, 0.50],
    ['32K', 1,      0.13, 40, 0.62],
  ];
  for (const [txt, f, aOff, px, alpha] of NUMERALS) {
    put(txt, f * GAUGE_MAX_ANGLE + aOff, rNum, px, alpha, '1px');
  }

  // caption pair in the dead quadrant (315°), INSIDE the ring
  const capA = GAUGE_MAX_ANGLE + (TAU - GAUGE_MAX_ANGLE) * 0.5;
  const capR = gaugeRadius - 1.55;
  put('TOKENS OUT / TURN', capA, capR, 26, 0.55, '5px');
  put('LOG2 SCALE', capA, capR, 20, 0.38, '4px', 30);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = new THREE.MeshBasicMaterial({
    map: tex, color: hudTextColor, transparent: true,
    depthWrite: false, depthTest: false, opacity: 0.92,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(LABEL_PLANE_SIZE, LABEL_PLANE_SIZE), mat);
  mesh.rotation.x = -Math.PI / 2;      // local +Y → world -Z: 12 o'clock
  mesh.position.y = 0.10;
  mesh.renderOrder = 20;
  return { mesh, mat };
}

// live readout — the one dynamic text element, a billboarded sprite riding
// the arc tip (canvas redrawn only when the QUANTIZED value changes; P1 fix)
function drawGaugeText(entry, text) {
  const { cv, g } = entry;
  g.clearRect(0, 0, cv.width, cv.height);
  g.font = `700 ${entry.size}px Consolas, "Courier New", monospace`;
  if ('letterSpacing' in g) g.letterSpacing = entry.spacing;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(255,255,255,0.97)';
  g.fillText(text, cv.width / 2, cv.height / 2 + 2);
  entry.tex.needsUpdate = true;
}

function makeGaugeLabel(text, size, spacing, w, h, color, opacity, scaleW) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = new THREE.SpriteMaterial({
    map: tex, color, transparent: true, depthWrite: false, depthTest: false, opacity,
  });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(scaleW, scaleW * h / w, 1);
  sp.renderOrder = 20;
  const entry = { sp, cv, g, tex, mat, size, spacing, baseOpacity: opacity };
  drawGaugeText(entry, text);
  return entry;
}

// ---------------------------------------------------------------------------
// ring hardware: four families of machined blocks at strongly varied scales,
// irregular angular spacing — anchor nodes, collar clamps, panel plates,
// clustered chips. One InstancedMesh per ring. (The gauge ring carries NONE
// of this — its greeble is stripped to a quiet track, LEGEND r4.)

function buildRingHardware(s, rnd, geo, mat) {
  const items = [];

  // anchor nodes — large machined blocks that break the ring into arcs
  const a0 = rnd() * TAU;
  for (let k = 0; k < 3; k++) {
    items.push({
      a: a0 + (k / 3) * TAU + (rnd() - 0.5) * 0.6,
      rOff: 0,
      sx: s.tube * (3.4 + rnd() * 1.2),
      sy: (0.30 + rnd() * 0.26) * HW_SLIM,
      sz: s.tube * (4.0 + rnd() * 1.4),
      tone: 0.9 + rnd() * 0.1,
    });
  }

  // collar clamps — wrap the tube at irregular spacing, varied widths
  const nClamp = 11 + Math.floor(rnd() * 5);
  for (let k = 0; k < nClamp; k++) {
    items.push({
      a: rnd() * TAU,
      rOff: 0,
      sx: s.tube * (2.5 + rnd() * 0.6),
      sy: (0.08 + rnd() * 0.24) * HW_SLIM,
      sz: s.tube * (2.5 + rnd() * 1.0),
      tone: 0.5 + rnd() * 0.35,
    });
  }

  // panel plates — long, low-profile, hugging the outer (mostly) or inner face
  const nPlate = 14 + Math.floor(rnd() * 6);
  for (let k = 0; k < nPlate; k++) {
    const side = rnd() < 0.7 ? 1 : -1;
    const th = 0.035 + rnd() * 0.05;
    items.push({
      a: rnd() * TAU,
      rOff: side * (s.tube + th * 0.5),
      sx: th,
      sy: (0.26 + rnd() * 0.62) * HW_SLIM,
      sz: s.tube * (1.1 + rnd() * 1.0),
      tone: 0.7 + rnd() * 0.3,
    });
  }

  // chip clusters — small blocks bunched near cluster centers on the outer face
  for (let cl = 0; cl < 5; cl++) {
    const ca = rnd() * TAU;
    const n = 4 + Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) {
      const th = 0.05 + rnd() * 0.09;
      items.push({
        a: ca + (rnd() - 0.5) * 0.55,
        rOff: s.tube + th * 0.5,
        sx: th,
        sy: 0.05 + rnd() * 0.13,
        sz: 0.05 + rnd() * 0.15,
        tone: 0.55 + rnd() * 0.45,
      });
    }
  }

  const im = new THREE.InstancedMesh(geo, mat, items.length);
  const dummy = new THREE.Object3D();
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    const rad = s.radius + it.rOff;
    dummy.position.set(Math.cos(it.a) * rad, Math.sin(it.a) * rad, 0);
    dummy.rotation.set(0, 0, it.a);            // x radial, y tangential, z depth
    dummy.scale.set(it.sx, it.sy, it.sz);
    dummy.updateMatrix();
    im.setMatrixAt(k, dummy.matrix);
    im.setColorAt(k, tmpC.setScalar(it.tone));
  }
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  return im;
}

// ---------------------------------------------------------------------------

export default {
  name: 'core',

  init(ctx) {
    const { scene, PALETTE, LAYOUT, session } = ctx;
    const R = LAYOUT.coreRadius;
    const rnd = mulberry32(1337);
    sessionRef = session;
    lastReadTok = -1;
    gaugeFill = 0; gaugeTok = 0; gaugeResetT = 0;
    rateEMA = 0; spinMulNow = 1; flowT = 0; userFlare = 0;

    COL_CYAN = new THREE.Color(PALETTE.coreEnergy);
    COL_AMBER = new THREE.Color(PALETTE.output);
    COL_MAGENTA = new THREE.Color(PALETTE.fresh);
    tmpC = new THREE.Color();

    group = new THREE.Group();
    group.position.set(0, LAYOUT.coreY, 0);
    scene.add(group);

    // -- plasma heart -------------------------------------------------------
    heartMat = new THREE.ShaderMaterial({
      vertexShader: HEART_VERT,
      fragmentShader: HEART_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uFlow: { value: 0 },
        uBreath: { value: 0 },
        uPulse: { value: 0 },
        uHeat: { value: 0 },
        uShimmer: { value: 0 },
        uRate: { value: 0 },
        uFlare: { value: 0 },
        uGain: { value: 1 },
        uBody: { value: new THREE.Color(PALETTE.coreEnergy) },
        uHot: { value: new THREE.Color(PALETTE.coreHot) },
        uRim: { value: new THREE.Color(PALETTE.output) },
        uMag: { value: new THREE.Color(PALETTE.fresh) },
      },
    });
    rimC = heartMat.uniforms.uRim.value;   // CPU writes the say-surge color here
    heart = new THREE.Mesh(new THREE.SphereGeometry(R * 0.6, 72, 48), heartMat);
    group.add(heart);

    // -- additive halo billboard around the heart — resting CYAN ------------
    const radialTex = makeRadialTexture();
    glowMat = new THREE.SpriteMaterial({
      map: radialTex,
      color: PALETTE.coreEnergy,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 0.22,
    });
    glowSprite = new THREE.Sprite(glowMat);
    haloBaseScale = R * 3.3;
    glowSprite.scale.set(haloBaseScale, haloBaseScale, 1);
    glowSprite.renderOrder = 3;
    group.add(glowSprite);

    // -- gyroscope: TWO precessing circuitry rings at 30% opacity -----------
    // (LEGEND r4: the third ring's role passes to the static gauge below)
    const bandTex = makeRingBandTexture();
    const chipTex = makeChipTexture();
    ringMat = new THREE.MeshStandardMaterial({
      color: PALETTE.coreShell,
      metalness: 0.95,
      roughness: 0.22,
      emissive: PALETTE.coreEnergy,
      emissiveIntensity: 0.9,
      emissiveMap: bandTex,
      transparent: true,
      opacity: RING_OPACITY,
    });
    greebleMat = new THREE.MeshStandardMaterial({
      color: PALETTE.coreShell,
      metalness: 0.9,
      roughness: 0.3,
      emissive: PALETTE.coreEnergy,
      emissiveIntensity: 0.5,
      emissiveMap: chipTex,
      transparent: true,
      opacity: RING_OPACITY,
    });

    gyro = new THREE.Group();
    group.add(gyro);

    // shared invisible-material proxy stock (perf P0): raycastable, zero draws
    const proxyMat = new THREE.MeshBasicMaterial({ visible: false });

    // pick spec built below; ring proxies register after pickSpec exists
    // UR-5 (user ruling): THREE full-presence rings — the third, retired by
    // LEGEND r4 in favor of the (now deleted) gauge, is restored.
    const SPECS = [
      { radius: R * 1.16, tube: 0.051, baseX: Math.PI / 2 - 0.9, baseZ: 0.55, speed: -0.17, wobF: 0.08, wobA: 0.14, phase: 2.1 },
      { radius: R * 1.45, tube: 0.063, baseX: 0.42,              baseZ: -0.6, speed:  0.11, wobF: 0.06, wobA: 0.17, phase: 4.2 },
      { radius: R * 1.76, tube: 0.072, baseX: -0.38,             baseZ: 0.22, speed:  0.07, wobF: 0.05, wobA: 0.12, phase: 0.7 },
    ];

    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    rings = [];
    const ringProxies = [];
    for (let i = 0; i < SPECS.length; i++) {
      const s = SPECS[i];
      const tilt = new THREE.Group();
      tilt.rotation.set(s.baseX, 0, s.baseZ);
      const spin = new THREE.Group();          // spins about torus symmetry axis (local Z)
      tilt.add(spin);
      gyro.add(tilt);

      spin.add(new THREE.Mesh(new THREE.TorusGeometry(s.radius, s.tube, 20, 180), ringMat));
      spin.add(buildRingHardware(s, rnd, boxGeo, greebleMat));

      // coarse invisible hull rides the spin group — the ONLY thing raycast
      const proxy = new THREE.Mesh(
        new THREE.TorusGeometry(s.radius, Math.max(s.tube * 3, 0.16), 8, 24), proxyMat);
      spin.add(proxy);
      ringProxies.push(proxy);

      rings.push({
        tilt, spin,
        baseX: s.baseX, baseZ: s.baseZ,
        speed: s.speed, wobF: s.wobF, wobA: s.wobA, phase: s.phase,
      });
    }

    // -- THE GAUGE RING: the static equatorial instrument -------------------
    // One ring IS the gauge (LEGEND r4 / KILLSCREEN r4): quiet track torus
    // (low-mid body, greeble stripped), flat data annulus (ticks + bright
    // 0-to-current arc + terminus dot) welded just above its plane, and one
    // baked label plane. It replaces both the retired billboarded dial and
    // the deleted magenta flare annulus at the core's equator.
    gaugeR = R * 1.76;
    gaugeGroup = new THREE.Group();            // equator: group-local y = 0
    group.add(gaugeGroup);
    // Design ruling: the tokens-out gauge is
    // removed — the core is kinetic sculpture, not an instrument panel.
    // Assembly kept intact but never rendered; raycaster ignores invisible.
    gaugeGroup.visible = false;

    trackMat = new THREE.MeshStandardMaterial({
      color: PALETTE.coreShell,
      metalness: 0.92,
      roughness: 0.3,
      emissive: PALETTE.coreEnergy,
      emissiveIntensity: 0.30,                 // quiet: structure, not data
    });
    const track = new THREE.Mesh(new THREE.TorusGeometry(gaugeR, 0.045, 10, 128), trackMat);
    track.rotation.x = -Math.PI / 2;
    gaugeGroup.add(track);

    const gR0 = gaugeR - 0.055, gR1 = gaugeR + 0.055;
    gaugeMat = new THREE.ShaderMaterial({
      vertexShader: GAUGE_VERT,
      fragmentShader: GAUGE_FRAG,
      uniforms: {
        uFill: { value: 0 },
        uPulse: { value: 0 },
        uTime: { value: 0 },
        uLevel: { value: 1 },
        uR0: { value: gR0 },
        uR1: { value: gR1 },
        uFillC: { value: new THREE.Color(PALETTE.output) },   // amber = output
        uTrackC: { value: new THREE.Color(PALETTE.hudDim) },  // scale + ticks
      },
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    // radial margin (±0.55) lets end-stop ticks and the terminus halo draw
    // outside the rail without clipping; lifted 0.08 above the track torus so
    // the data ink is never occluded by the tube's upper half
    gaugeMesh = new THREE.Mesh(new THREE.RingGeometry(gaugeR - 0.55, gaugeR + 0.55, 192, 1), gaugeMat);
    gaugeMesh.rotation.x = -Math.PI / 2;
    gaugeMesh.position.y = 0.08;
    gaugeMesh.renderOrder = 3;
    gaugeGroup.add(gaugeMesh);

    // tick labels + captions: ONE baked canvas plane welded to the ring's plane
    const lbl = makeGaugeLabelPlane(gaugeR, PALETTE.hudText);
    labelMesh = lbl.mesh; labelMat = lbl.mat;
    gaugeGroup.add(labelMesh);

    // live readout rides the arc tip, floating just above the track
    gaugeReadout = makeGaugeLabel('OUT 0', 60, '2px', 448, 112, PALETTE.output, 0.95, 2.05);
    gaugeGroup.add(gaugeReadout.sp);

    // session's hottest turn, for the gauge card
    peakOut = 0;
    const curve = (session && session.contextCurve) || [];
    for (let i = 0; i < curve.length; i++) if (curve[i].out > peakOut) peakOut = curve[i].out;

    // -- ground-projected glow disc -----------------------------------------
    // Radius R*1.9 = 6.08, INSIDE the chronogram hub (CHRONO.rInner 6.5) —
    // light pools on the hub; the lanes stay ink (round-8, UR-3).
    discMat = new THREE.MeshBasicMaterial({
      map: radialTex,
      color: PALETTE.coreEnergy,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 0.45,
    });
    disc = new THREE.Mesh(new THREE.CircleGeometry(R * 1.9, 48), discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(0, 0.02, 0);
    disc.renderOrder = 2;
    scene.add(disc);

    // -- reactor light: the core lights its surroundings --------------------
    coreLight = new THREE.PointLight(PALETTE.coreEnergy, 260, 70, 2);
    group.add(coreLight);

    // -- ctx.pick: the core is a first-class interactive citizen ------------
    // Perf P0: only invisible LOW-POLY PROXIES are registered — the hi-res
    // heart (6.9k tris) and gyro tori (21.6k) are never raycast again.
    const meta = (session && session.meta) || {};
    const events = (session && session.events) || [];
    const assistantTurns = meta.assistantTurns ?? events.filter(e => e.kind === 'say').length;
    const thinkingBlocks = meta.thinkingBlocks ?? events.filter(e => e.kind === 'thinking').length;
    const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n));
    const pickSpec = {
      kind: 'core',
      debugKey: 'core',
      card: () => ({
        title: 'THE CORE — AGENT LOOP',
        lines: [
          ['MODEL', String(meta.model ?? 'unknown')],
          ['TURNS', fmt(assistantTurns)],
          ['THINKING', fmt(thinkingBlocks)],
          // the heart's churn and the rings' spin decode the same signal —
          // recent event rate — and the card declares both mappings
          ['CHURN', `EVENT RATE ${Math.round(rateEMA)}/S`],
          ['RINGS', `SPIN ×${spinMulNow.toFixed(1)}`],
          ['STATE', sayPulse > 0.06 ? 'SPEAKING' : shimmer > 0.06 ? 'THINKING' : 'IDLE'],
        ],
      }),
      onHover: (hit) => { hoverT = hit ? 1 : 0; },
    };

    const heartProxy = new THREE.Mesh(new THREE.SphereGeometry(R * 0.6, 8, 6), proxyMat);
    group.add(heartProxy);
    ctx.pick.register(heartProxy, pickSpec);
    for (const p of ringProxies) ctx.pick.register(p, pickSpec);

    // the gauge is a chart — it explains itself on demand. Fat invisible
    // torus hull: hittable from any camera angle, zero draw cost.
    const gaugeProxy = new THREE.Mesh(new THREE.TorusGeometry(gaugeR, 0.5, 6, 24), proxyMat);
    gaugeProxy.rotation.x = -Math.PI / 2;
    gaugeGroup.add(gaugeProxy);
    ctx.pick.register(gaugeProxy, {
      kind: 'gauge',
      debugKey: 'gauge',
      card: () => ({
        title: 'OUTPUT GAUGE',
        lines: [
          ['METRIC', 'TOKENS OUT / TURN'],
          ['NOW', fmt(Math.round(gaugeTok))],
          ['SCALE', 'LOG2 · 0–32K / 270°'],
          ['PEAK TURN', fmt(Math.round(peakOut))],
        ],
      }),
      onHover: (hit) => { gHoverT = hit ? 1 : 0; },
    });
  },

  update(dt, state, ctx) {
    if (!group) return;
    time += dt;

    // -- ingest fired events ------------------------------------------------
    const fired = (state && state.fired) || [];
    let sawSay = false;
    for (let i = 0; i < fired.length; i++) {
      const k = fired[i].kind;
      if (k === 'say') { sayPulse = 1; sawSay = true; }
      else if (k === 'thinking') shimmer = Math.min(shimmer + 0.6, 1);
      else if (k === 'user') userFlare = 1;
    }

    // -- event-rate EMA (~5s memory) → ring spin + heart churn --------------
    // Leaky integrator of instantaneous events/sec. In FROZEN shot mode the
    // EMA is instead HELD at the actual local event density around the seek
    // point (binary search + short back-walk) — every settle frame shows the
    // churn the session really had at that moment, deterministically, instead
    // of a seeded value decaying toward a flat heart.
    const frozen = !!(ctx && ctx.params && ctx.params.get && ctx.params.get('freeze') === '1');
    if (dt > 0 && !frozen) {
      const inst = Math.min(fired.length / Math.max(dt, 1 / 120), 400);
      rateEMA += (inst - rateEMA) * (1 - Math.exp(-dt / RATE_TAU));
    } else if (state && ctx && ctx.timeline && ctx.timeline.vts) {
      const vts = ctx.timeline.vts;
      let lo = 0, hi = vts.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (vts[mid] <= state.vt) lo = mid + 1; else hi = mid; }
      let n = 0;
      for (let i = lo - 1; i >= 0 && vts[i] >= state.vt - RATE_TAU; i--) n++;
      rateEMA = n / RATE_TAU;
    }
    const spinMul = 1 + Math.min(rateEMA * RATE_TO_SPIN, SPIN_MUL_MAX - 1);
    spinMulNow = spinMul;
    const rateN = Math.min(rateEMA / RATE_NORM, 1);   // 0..1 churn drive

    // churn clock: advection speed rides the rate, integrated on the CPU so
    // the marbling never phase-jumps as the rate moves (0.35x calm → 2x storm)
    flowT += dt * (0.35 + 1.65 * rateN);

    // expo decay; clamp to hard zero well before 2.5s
    sayPulse *= Math.exp(-dt * 3.0);   // ~1.5s perceptual decay
    if (sayPulse < 0.004) sayPulse = 0;
    // interior surge envelope: snaps up with the pulse, cools slower — the
    // heart floods with the speaking color, then the churn re-emerges cyan
    heatEnv = Math.max(heatEnv * Math.exp(-dt * 2.2), sayPulse);
    if (heatEnv < 0.01) heatEnv = 0;   // fully cool < 2.1s after last pulse
    shimmer *= Math.exp(-dt * 2.6);
    if (shimmer < 0.004) shimmer = 0;
    // user-flare envelope: the magenta rim kick decays within ~2s (motion law)
    userFlare *= Math.exp(-dt * 2.0);
    if (userFlare < 0.01) userFlare = 0;

    const breath = 0.5 + 0.5 * Math.sin(time * 0.9);   // idle heartbeat

    // hover affordance + tool-filter dim, both eased
    hoverEnv += (hoverT - hoverEnv) * (1 - Math.exp(-dt * 10));
    gHoverEnv += (gHoverT - gHoverEnv) * (1 - Math.exp(-dt * 10));
    const filterOn = ctx && ctx.state && ctx.state.filterTool ? 1 : 0;
    filterEnv += (filterOn - filterEnv) * (1 - Math.exp(-dt * 6));
    const dimF = 1 - 0.6 * filterEnv;                  // world-dim when filtering
    const hoverF = 1 + 0.25 * hoverEnv;                // brighten on hover

    // -- distance authority: unity at close-up, ~2.4x at boulevard.
    // Smooth in distance and the rig eases all camera motion → no popping.
    let dg = 1;
    const cam = ctx && ctx.camera;
    if (cam) {
      const d = cam.position.distanceTo(group.position);
      let x = (d - GAIN_D0) / (GAIN_D1 - GAIN_D0);
      x = x < 0 ? 0 : x > 1 ? 1 : x;
      dg = 1 + GAIN_K * x * x * (3 - 2 * x);
    }

    // -- gyroscope motion: distinct spins + slow precession, rate-coupled ---
    // The loop spins faster when the session runs hot (spinMul 1..3).
    gyro.rotation.y += dt * 0.045 * spinMul;
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      r.spin.rotation.z += dt * r.speed * spinMul;
      r.tilt.rotation.x = r.baseX + Math.sin(time * r.wobF + r.phase) * r.wobA;
      r.tilt.rotation.z = r.baseZ + Math.cos(time * r.wobF * 0.8 + r.phase * 1.7) * r.wobA * 0.8;
    }

    // -- THE GAUGE: fill = log2-mapped current-turn output tokens -----------
    // Ease in TOKEN space, then map — the readout and the arc always agree,
    // and the sweep-back reads linear on the log dial (each halving = 45°).
    const outTok = (state && state.context && state.context.out) || 0;
    if (sawSay) gaugeResetT = GAUGE_RESET_SWEEP;       // reset each 'say'
    if (dt === 0) {
      gaugeTok = outTok;         // shot mode: exact datum — and kill the
      gaugeResetT = 0;           // pending sweep so settle frames hold it
    } else if (gaugeResetT > 0) {
      gaugeResetT -= dt;
      gaugeTok *= Math.exp(-dt * 14);                   // fast sweep back to zero
    } else {
      gaugeTok += (outTok - gaugeTok) * (1 - Math.exp(-dt * 5));
    }
    gaugeFill = tokToFill(gaugeTok);

    const gu = gaugeMat.uniforms;
    gu.uFill.value = gaugeFill;
    gu.uPulse.value = sayPulse;
    gu.uTime.value = time;
    gu.uLevel.value = (1.0 + 0.35 * (dg - 1)) * dimF * (1 + 0.30 * gHoverEnv);

    // quiet track: steady structure light, never event-tinted — the gauge is
    // an instrument, and its axis does not celebrate
    trackMat.emissiveIntensity = (0.28 + 0.05 * breath) * dimF;

    // live readout rides the fill head, floating just above the track. The
    // canvas redraws only when the QUANTIZED value changes (perf P1): nearest
    // 10 tokens while the ease is moving, exact when settled or in shot mode.
    const tipA = gaugeFill * GAUGE_MAX_ANGLE;
    gaugeReadout.sp.position.set(Math.sin(tipA) * gaugeR, 0.34, -Math.cos(tipA) * gaugeR);
    const settled = gaugeResetT <= 0 && Math.abs(outTok - gaugeTok) < 1;
    const shownTok = (dt === 0 || settled)
      ? Math.round(gaugeTok)
      : Math.round(gaugeTok / 10) * 10;
    if (shownTok !== lastReadTok) {
      lastReadTok = shownTok;
      drawGaugeText(gaugeReadout, 'OUT ' + shownTok.toLocaleString('en-US'));
    }
    const lblDim = Math.min(dimF * (1 + 0.20 * gHoverEnv), 1);
    gaugeReadout.mat.opacity = gaugeReadout.baseOpacity * lblDim;
    labelMat.opacity = 0.92 * lblDim;

    // -- heart: resting cyan churn; amber only through the say envelopes ----
    heart.rotation.y += dt * 0.1 * (0.6 + 0.4 * spinMul);   // churn drift
    const hu = heartMat.uniforms;
    hu.uTime.value = time;
    hu.uFlow.value = flowT;
    hu.uBreath.value = breath;
    hu.uPulse.value = sayPulse;
    hu.uHeat.value = heatEnv;
    hu.uShimmer.value = shimmer;
    hu.uRate.value = rateN;
    hu.uFlare.value = userFlare;
    hu.uGain.value = dg * dimF * (1 + 0.12 * hoverEnv);
    // say-surge color: amber, kicked toward magenta if a user flare overlaps
    rimC.copy(COL_AMBER).lerp(COL_MAGENTA, userFlare * 0.65);
    heart.scale.setScalar(1 + 0.055 * sayPulse + 0.013 * (breath * 2 - 1));

    // shared event tint for rings/disc/light: cyan → amber on say (decaying),
    // → magenta on user flare. At rest this is pure machine cyan.
    tmpC.copy(COL_CYAN).lerp(COL_AMBER, sayPulse * 0.85).lerp(COL_MAGENTA, userFlare * 0.55);

    // -- ornament rings + hardware: structure at 30% opacity (LEGEND r4).
    // Resting emissive held dim; say/flare transients still lift them,
    // because those transients ARE events, and they decay within ~2s.
    const ringGain = (1 + 0.5 * (dg - 1)) * dimF * hoverF;
    ringMat.emissive.copy(tmpC);
    ringMat.emissiveIntensity = ((0.9 + 0.25 * breath) * RING_REST_DIM + sayPulse * 1.5 + userFlare * 0.55) * ringGain;
    greebleMat.emissive.copy(tmpC);
    greebleMat.emissiveIntensity = ((0.5 + 0.15 * breath) * RING_REST_DIM + sayPulse * 1.0 + userFlare * 0.35) * ringGain;

    // -- halo: resting cyan, amber only while a say pulse decays. HDR lift
    // with distance stays modest — the heart's cap owns the ceiling.
    glowMat.color.copy(COL_CYAN).lerp(COL_AMBER, sayPulse * 0.9).lerp(COL_MAGENTA, userFlare * 0.6)
      .multiplyScalar(0.65 + 0.55 * (dg - 1));
    glowMat.opacity = (0.20 + 0.08 * breath + sayPulse * 0.28 + userFlare * 0.20) * dimF;
    const hs = haloBaseScale * (1 + 0.22 * (dg - 1));
    glowSprite.scale.set(hs, hs, 1);

    // -- ground disc, light -------------------------------------------------
    discMat.color.copy(tmpC);
    discMat.opacity = Math.min(
      (0.38 + 0.12 * breath + sayPulse * 0.25 + userFlare * 0.30) * (1 + 0.18 * (dg - 1)), 0.9) * dimF;

    coreLight.color.copy(tmpC);
    coreLight.intensity = 260 * (0.8 + 0.35 * breath) * (1 + sayPulse * 1.7 + userFlare * 1.1)
      * (1 + 0.3 * (dg - 1)) * dimF;

    // whole-core slight swell on say
    group.scale.setScalar(1 + 0.02 * sayPulse);
  },
};
