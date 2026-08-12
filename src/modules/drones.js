// drones.js — THE SHELL: subagent minds.
//
// Live minds only: a violet drone spawns from the core when its real subagent
// spawns, flies an eased arc out to a personal golden-angle slot on the orbit
// shell (LAYOUT.droneOrbitRadius / droneOrbitY), orbits while the subagent
// WORKS, then burns partway home and dissolves into particles streaming into
// the reactor while its tether retracts.
//
// Refit r5 — information-design pass:
//   · HONEST POPULATION, HONEST POOL: the timeline now guarantees every
//     spawned mind ≥12s of visible life (MIN_DRONE_LIFE in lib/timeline.js),
//     so life comes straight from [spawnVt, endVt] with only a tiny floor for
//     spawns clipped by the end of playback. Measured peak concurrency on the
//     warped axis (vt 17–41 delegation burst, return+dissolve tail included)
//     is 14 — POOL is 16. The old pool of 10 silently dropped drones.
//   · GOLDEN-ANGLE SLOT CHOREOGRAPHY: pool-independent interval coloring at
//     init assigns each mind the lowest slot free for its whole visible
//     window; baseAngle = slot × golden angle (+ small jitter), with radial
//     and vertical stagger keyed to the slot. Concurrent drones can never
//     share a bearing — fourteen minds aloft still read as fourteen.
//   · BODY PER CRITIQUE: dark faceted octahedral hull (~40% smaller than r4,
//     BODY_SCALE 1.12 → 0.68), tight violet fresnel rim, and a HOT INNER
//     SPECK — a white-violet heart rendered by ray-proximity in the hull
//     shader so it sits at the visual center from any angle. Trails are
//     short expo-decay streaks (exp(-4.2·t)), not linear fades.
//   · WORKING IS LEGIBLE: while the real subagent is on the roster, the
//     tether pulses with energy dashes flowing DRONE→CORE (results streaming
//     home, same direction as the bright packet) and the drone carries a
//     slowly rotating activity glyph ring — a procedural code-halo that
//     lights on arrival and dies exactly when the subagent completes. The
//     despawn dissolve (particles streaming into the core) closes the story.
//   · PICKABLE: every active drone registers an invisible-material hit proxy
//     with ctx.pick — kind 'drone', debugKey = subagent id, hover card
//     (TASK / TYPE / SPAN / STATUS), onHover brightens the tether.
//
// Every position and intensity is a deterministic function of state.vt —
// seeks and freeze-frame shots are exact, and trails survive frozen frames
// because they are history lookups, not accumulation.
//
// Draw calls: 5 (instanced bodies, instanced fresnel shells, instanced glyph
// rings, one merged LineSegments for all tethers + trails, one Points cloud
// for nav lights + engine sprites + dissolve particles). Pick proxies use an
// invisible material — raycastable, never rendered, zero draw cost. All
// buffers allocated in init(); update() only writes floats.
//
// SESSION SWAP (reset) — see the SESSION SWAP CONTRACT in main.js. What is
// session-shaped here is exactly the subagent set: S.subs (flight plans +
// golden-angle choreography derived from ctx.timeline.subagents), the
// subagent-indexed S.slotOf table, and whichever pool slots currently hold a
// drone (their pick registrations, eased surge/work/hover state and buffer
// writes). All of that is rebuilt by buildSubs() + parkPool(), the same two
// helpers init() uses, so there is one build path and no duplicated code.
// Nothing here is a per-session GPU allocation: every geometry, material and
// attribute is POOL-shaped (POOL is a compile-time constant), so a swap
// disposes nothing and leaks nothing — see the note on reset() below.

import * as THREE from 'three';

const POOL = 16;                 // live render capacity (measured visible peak = 14)
const SEG = 26;                  // tether curve segments per drone
const TRAIL_SEG = 16;            // motion-trail segments per drone
const DIS_N = 42;                // dissolve particles per drone
const PTS_PER = 2 + DIS_N;       // nav light + engine sprite + dissolve particles
const GOLDEN = 2.399963229728653;

const LIFE_FLOOR = 3.0;          // only for spawns clipped by end-of-playback
const T_OUT = 1.5;               // spawn flight duration
const T_RET = 0.75;              // despawn return-partway duration
const T_DIS = 1.1;               // dissolve duration
const RETURN_FRAC = 0.45;        // how far home the return leg travels
const BODY_SCALE = 0.68;         // r5: ~40% down from r4's 1.12

const clamp01 = t => (t < 0 ? 0 : t > 1 ? 1 : t);
const fract = x => x - Math.floor(x);
const hash = n => fract(Math.sin(n * 127.1 + 311.7) * 43758.5453123);
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeInCubic = t => t * t * t;
const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack = t => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// mm:ss on the 180s playback axis — card SPAN values
const fmtVt = vt => {
  const t = Math.max(0, Math.round(vt));
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
};

const FOG_CHUNK = /* glsl */`
uniform vec3 uCamPos;
uniform vec3 uFogColor;
uniform float uFogType;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFogDensity;
float fogF(vec3 wp) {
  if (uFogType < 0.5) return 0.0;
  float d = distance(wp, uCamPos);
  if (uFogType < 1.5) return clamp((d - uFogNear) / max(uFogFar - uFogNear, 0.001), 0.0, 1.0);
  float k = d * uFogDensity;
  return clamp(1.0 - exp(-k * k), 0.0, 1.0);
}
`;

const VERT_INST = /* glsl */`
attribute vec4 aInst;
varying vec3 vN;
varying vec3 vW;
varying vec3 vL;
varying vec4 vI;
varying vec4 vC;
void main() {
  vI = aInst;
  vL = position;
  mat4 im = modelMatrix * instanceMatrix;
  vec4 wp = im * vec4(position, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(im) * normal);
  // instance center + uniform (x-axis) scale — the hull frag uses these to
  // place the hot inner speck at the visual center regardless of orientation
  vC = vec4((im * vec4(0.0, 0.0, 0.0, 1.0)).xyz, length(im[0].xyz));
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

// hull: dark faceted panels under cool machine light, violet rim, emissive
// waist seam, hot inner speck at the heart, engine glow pooling at the aft
// tip. aInst = (energy, dissolve, seed, engine). Local space is the
// unstretched 0.62-radius octahedron — elongation lives in the instance
// matrix, so vL.y tips sit at ±0.62.
const BODY_FRAG = /* glsl */`
uniform vec3 uViolet;
uniform vec3 uHull;
uniform vec3 uAmbient;
uniform float uTime;
varying vec3 vN;
varying vec3 vW;
varying vec3 vL;
varying vec4 vI;
varying vec4 vC;
${FOG_CHUNK}
void main() {
  vec3 V = normalize(uCamPos - vW);
  vec3 N = normalize(vN);
  // two-source hull shading: cool key from above, faint cache-light fill below
  float key = clamp(dot(N, normalize(vec3(0.35, 0.85, 0.4))), 0.0, 1.0);
  float fill = clamp(dot(N, normalize(vec3(-0.5, -0.25, -0.6))), 0.0, 1.0);
  // per-facet paint tone — each flat face reads as its own panel
  float facet = fract(sin(dot(floor(N * 3.0 + 0.5), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  vec3 col = uHull * (0.55 + 0.45 * facet) * (0.30 + 0.85 * key) + uAmbient * fill;
  // tight violet fresnel rim — edge light, not a body glow
  float fres = pow(1.0 - abs(dot(N, V)), 3.0);
  col += uViolet * fres * (0.30 + 0.70 * vI.x);
  // emissive circuit seam ringing the hull waist, phase-lit per mind
  float seam = 1.0 - smoothstep(0.025, 0.075, abs(vL.y));
  seam *= 0.60 + 0.40 * sin(atan(vL.z, vL.x) * 6.0 + uTime * 2.2 + vI.z * 40.0);
  col += uViolet * seam * (0.45 + 0.85 * vI.x);
  // HOT INNER SPECK — perpendicular distance from this fragment to the
  // camera→center ray, normalized by instance scale: a small white-violet
  // heart burning through the hull center from any viewing angle
  vec3 rd = normalize(vC.xyz - uCamPos);
  float bn = length(cross(vW - uCamPos, rd)) / max(vC.w, 1e-4);
  float speck = exp(-bn * bn * 34.0) * (0.85 + 0.15 * sin(uTime * 6.0 + vI.z * 40.0));
  col += mix(uViolet, vec3(1.0), 0.7) * speck * (0.5 + 1.1 * vI.x);
  // engine glow — heat pooling at the aft (lower) tip, hot toward white
  float eng = smoothstep(0.18, 0.52, -vL.y);
  eng *= eng;
  col += mix(uViolet, vec3(1.0), 0.35) * eng * vI.w * 1.7;
  // dissolve overexposure — the mind burns out as it unravels
  col += uViolet * vI.y * 2.2;
  gl_FragColor = vec4(mix(col, uFogColor, fogF(vW)), 1.0);
}
`;

const GLOW_FRAG = /* glsl */`
uniform vec3 uViolet;
varying vec3 vN;
varying vec3 vW;
varying vec3 vL;
varying vec4 vI;
${FOG_CHUNK}
void main() {
  vec3 V = normalize(uCamPos - vW);
  float fres = pow(1.0 - abs(dot(normalize(vN), V)), 2.7);
  float I = fres * vI.x * 0.75;
  vec3 col = uViolet * I * (1.0 - fogF(vW));
  gl_FragColor = vec4(col, 1.0);
}
`;

// activity glyph ring — a slowly rotating procedural code-halo carried by
// WORKING drones. Geometry is a flat annulus (0.80..1.06 local radius) laid
// horizontal by the instance matrix; rotation happens in the shader so the
// halo turns independently of the hull's spin. aInst = (intensity, unused,
// seed, unused). Glyph cells hash on/off per seed; ticks grow outward from a
// thin inner rail with per-cell length; a slow luminance wave breathes
// around the band.
const RING_FRAG = /* glsl */`
uniform vec3 uViolet;
uniform float uTime;
varying vec3 vL;
varying vec3 vW;
varying vec4 vI;
${FOG_CHUNK}
void main() {
  float rN = clamp((length(vL.xy) - 0.80) / 0.26, 0.0, 1.0);
  float dir = vI.z > 0.5 ? 1.0 : -1.0;
  float a = fract(atan(vL.y, vL.x) * 0.15915494 + 0.5 + uTime * (0.030 + vI.z * 0.025) * dir);
  float cells = 26.0;
  float cell = floor(a * cells);
  float cf = fract(a * cells);
  float h1 = fract(sin((cell + vI.z * 91.0) * 12.9898) * 43758.5453);
  float h2 = fract(sin((cell + vI.z * 57.0) * 78.233) * 24634.6345);
  float on = step(0.35, h1);
  float len = 0.30 + 0.62 * h2;
  float tick = on * step(rN, len);
  float pad = smoothstep(0.0, 0.14, cf) * smoothstep(1.0, 0.86, cf);
  float rail = exp(-pow((rN - 0.05) * 14.0, 2.0)) * 0.45;
  float wave = 0.72 + 0.28 * sin(a * 12.566 - uTime * 1.3);
  float I = (tick * pad * 1.1 + rail) * wave * vI.x;
  vec3 col = mix(uViolet, vec3(1.0), 0.15) * I * (1.0 - fogF(vW));
  gl_FragColor = vec4(col, 1.0);
}
`;

const LINE_VERT = /* glsl */`
attribute float aT;
attribute float aI;
attribute float aSeed;
attribute float aMode;
varying float vT;
varying float vLI;
varying float vSeed;
varying float vMode;
varying vec3 vW;
void main() {
  vT = aT;
  vLI = aI;
  vSeed = aSeed;
  vMode = aMode;
  vW = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const LINE_FRAG = /* glsl */`
uniform vec3 uViolet;
uniform float uTime;
varying float vT;
varying float vLI;
varying float vSeed;
varying float vMode;
varying vec3 vW;
${FOG_CHUNK}
void main() {
  // tether: fine energy dashes flowing drone -> core (vT falls toward the
  // core, so phase advancing with +time marches the dashes home)...
  float dash = smoothstep(0.35, 0.95, sin(vT * 44.0 + uTime * 9.0 + vSeed * 6.2831));
  // ...under a bright packet streaming drone -> core on an eased path
  // (results coming home) — brightens as it nears the reactor
  float pf = fract(uTime * 0.30 + vSeed * 3.71);
  float pe = pf * pf * (3.0 - 2.0 * pf);
  // NaN discipline: GLSL pow() is undefined for a negative base (NaN on
  // ANGLE/D3D), and one NaN fragment poisons the whole fp16 post chain via
  // additive blending + bloom. Square via multiply; keep exp() bases finite.
  float pd = (vT - (1.0 - pe)) * 15.0;
  float packet = exp(-pd * pd) * mix(1.35, 0.75, vT);
  float base = mix(1.0, 0.55, vT);
  float tether = (0.32 * base + 0.90 * dash + 2.2 * packet) * smoothstep(0.0, 0.03, vT);
  // trail: expo-decay streak — hot at the head (vT=0), gone fast, with a
  // clean close at the tail and a soft shimmer
  float shimmer = 0.82 + 0.18 * sin(vT * 18.0 - uTime * 7.0 + vSeed * 6.2831);
  float trail = exp(-vT * 4.2) * smoothstep(1.0, 0.82, vT) * shimmer;
  // depth discipline: tethers are near-field detail — they fade with camera
  // distance and vanish beyond ~42m so wides never read a spiderweb. Trails
  // get a gentler, farther fade.
  float camd = distance(vW, uCamPos);
  float tFade = 1.0 - smoothstep(26.0, 42.0, camd);
  float rFade = 1.0 - smoothstep(48.0, 82.0, camd);
  float I = vLI * mix(tether * tFade, trail * rFade, vMode);
  vec3 col = uViolet * I * (1.0 - fogF(vW));
  gl_FragColor = vec4(col, 1.0);
}
`;

const PTS_VERT = /* glsl */`
uniform float uPx;
attribute vec4 aP;
varying float vPI;
varying float vHot;
varying vec3 vW;
void main() {
  vW = position;
  vPI = aP.y;
  vHot = aP.w;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aP.x * uPx / max(-mv.z, 0.5);
  gl_Position = projectionMatrix * mv;
}
`;

const PTS_FRAG = /* glsl */`
uniform vec3 uViolet;
varying float vPI;
varying float vHot;
varying vec3 vW;
${FOG_CHUNK}
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float fall = pow(1.0 - sqrt(r2), 2.0);
  vec3 col = uViolet * (1.0 + vHot * 1.8 * fall) * (vPI * fall) * (1.0 - fogF(vW));
  gl_FragColor = vec4(col, 1.0);
}
`;

let S = null; // module state — built entirely in init()

// orbit-slot pose — deterministic in vt
function slotPos(sub, vt, out) {
  const th = sub.baseAngle + sub.orbSpeed * vt;
  const r = sub.rad * (1 + 0.025 * Math.sin(vt * 0.31 + sub.seed * 7.0));
  out.set(
    Math.cos(th) * r,
    sub.y + Math.sin(vt * sub.bobF + sub.seed * 9.0) * sub.bobA,
    Math.sin(th) * r,
  );
}

function quadBez(out, a, b, c, t) {
  const s = 1 - t;
  const w0 = s * s, w1 = 2 * s * t, w2 = t * t;
  out.set(
    a.x * w0 + b.x * w1 + c.x * w2,
    a.y * w0 + b.y * w1 + c.y * w2,
    a.z * w0 + b.z * w1 + c.z * w2,
  );
}

function bezTan(out, a, b, c, t) {
  const s = 1 - t;
  out.set(
    2 * s * (b.x - a.x) + 2 * t * (c.x - b.x),
    2 * s * (b.y - a.y) + 2 * t * (c.y - b.y),
    2 * s * (b.z - a.z) + 2 * t * (c.z - b.z),
  );
}

// full lifecycle position of a live drone at any vt — used to reconstruct
// motion-trail history deterministically (uses its own scratch registers so
// it never clobbers drive()'s current-frame vectors)
function livePosAt(sub, vt, out) {
  const u = vt - sub.spawnVt;
  if (u <= 0) { out.copy(S.vCore); return; }
  if (u < T_OUT) {
    const e = easeOutCubic(u / T_OUT);
    slotPos(sub, vt, S.vS1);
    S.vS2.copy(S.vCore).addScaledVector(S.vTmpC.copy(S.vS1).sub(S.vCore), 0.28);
    S.vS2.y = S.vCore.y + 9.5;
    quadBez(out, S.vCore, S.vS2, S.vS1, e);
    return;
  }
  if (u < sub.life) { slotPos(sub, vt, out); return; }
  // despawn anchor keeps rotating with the constellation — a frozen anchor
  // lags the shell by up to ~7° and can collapse slot separation
  slotPos(sub, vt, S.vS1);
  if (u < sub.life + T_RET) {
    const e = easeInOutCubic((u - sub.life) / T_RET);
    out.copy(S.vS1).lerp(S.vCore, e * RETURN_FRAC);
    out.y -= Math.sin(e * Math.PI) * 0.9;
    return;
  }
  const dFrac = clamp01((u - sub.life - T_RET) / T_DIS);
  out.copy(S.vS1).lerp(S.vCore, RETURN_FRAC);
  out.lerp(S.vCore, easeInCubic(dFrac) * 0.3);
}

function freeSlot(p) {
  const proxy = S.proxies[p];
  S.pick.unregister(proxy);
  proxy.matrix.makeScale(0, 0, 0);
  proxy.matrixWorldNeedsUpdate = true;
  if (S.hoverSlot === p) S.hoverSlot = -1;
  S.poolSub[p] = -1;
  S.surge[p] = 1;
  S.work[p] = 0;
  S.hoverK[p] = 0;
  S.dissolveOn[p] = false;
  S.m4.makeScale(0, 0, 0);
  S.body.setMatrixAt(p, S.m4);
  S.glow.setMatrixAt(p, S.m4);
  S.ring.setMatrixAt(p, S.m4);
  const ai = p * 4;
  S.bodyInst[ai] = 0; S.bodyInst[ai + 1] = 0; S.bodyInst[ai + 3] = 0;
  S.glowInst[ai] = 0; S.glowInst[ai + 1] = 0; S.glowInst[ai + 3] = 0;
  S.ringInst[ai] = 0;
  const vBase = p * SEG * 2;
  for (let k = 0; k < SEG * 2; k++) S.lineI[vBase + k] = 0;
  const tBase = S.trailBaseV + p * TRAIL_SEG * 2;
  for (let k = 0; k < TRAIL_SEG * 2; k++) S.lineI[tBase + k] = 0;
  const pBase = p * PTS_PER * 4;
  for (let j = 0; j < PTS_PER; j++) S.ptsP[pBase + j * 4 + 1] = 0;
  S.instDirty = S.lineDirty = S.ptsDirty = true;
}

// Park EVERY pool slot: zero-scale the instanced bodies/shells/rings, drop the
// pick registration, clear the per-slot eased state (surge/work/hover/dissolve)
// and zero this slot's tether, trail and point intensities. Shared by init()
// (the shell starts empty, exactly like the roster it renders) and by reset()
// (despawn the outgoing session's drones in one pass). Idempotent per slot:
// freeSlot on an already-free slot is a no-op beyond re-zeroing.
function parkPool() {
  for (let p = 0; p < POOL; p++) freeSlot(p);
  S.hoverSlot = -1;
  flushBuffers();
}

// Push whatever the frame (or a park pass) dirtied to the GPU. Extracted from
// update()'s tail so parkPool() cannot leave a half-written attribute behind
// for the first frame after a swap.
function flushBuffers() {
  if (S.instDirty) {
    S.body.instanceMatrix.needsUpdate = true;
    S.glow.instanceMatrix.needsUpdate = true;
    S.ring.instanceMatrix.needsUpdate = true;
    S.bodyAttr.needsUpdate = true;
    S.glowAttr.needsUpdate = true;
    S.ringAttr.needsUpdate = true;
    S.instDirty = false;
  }
  if (S.lineDirty) {
    S.lineGeo.attributes.position.needsUpdate = true;
    S.lineGeo.attributes.aI.needsUpdate = true;
    S.lineGeo.attributes.aSeed.needsUpdate = true;
    S.lineDirty = false;
  }
  if (S.ptsDirty) {
    S.ptsGeo.attributes.position.needsUpdate = true;
    S.ptsGeo.attributes.aP.needsUpdate = true;
    S.ptsDirty = false;
  }
}

function claim(p, sub, vt) {
  // seek-safe state snap: surge/work land on their converged values so a
  // frozen shot dropped anywhere in the lifecycle is exact
  const live = vt < sub.ref.endVt;
  S.surge[p] = live ? 1.55 : 1.0;
  S.work[p] = live ? 1 : 0;
  S.hoverK[p] = 0;
  S.dissolveOn[p] = false;
  const vBase = p * SEG * 2;
  for (let k = 0; k < SEG * 2; k++) S.lineSeed[vBase + k] = sub.seed;
  const tBase = S.trailBaseV + p * TRAIL_SEG * 2;
  for (let k = 0; k < TRAIL_SEG * 2; k++) S.lineSeed[tBase + k] = sub.seed;
  const pBase = p * PTS_PER * 4;
  for (let j = 0; j < PTS_PER; j++) S.ptsP[pBase + j * 4 + 1] = 0;
  S.lineDirty = S.ptsDirty = true;

  // per-drone pick registration — kind 'drone', debugKey = subagent id.
  // Card resolves STATUS live off S.nowVt so it flips WORKING→DONE in place.
  const ref = sub.ref;
  const span = fmtVt(ref.spawnVt) + '–' + fmtVt(ref.endVt);
  S.pick.register(S.proxies[p], {
    kind: 'drone',
    debugKey: ref.id,
    card: () => ({
      title: 'SUBAGENT',
      lines: [
        ['TASK', ref.label],
        ['TYPE', ref.type],
        ['SPAN', span],
        ['STATUS', S.nowVt < ref.endVt ? 'WORKING' : 'DONE'],
      ],
    }),
    onHover: (hit) => {
      if (hit) S.hoverSlot = p;
      else if (S.hoverSlot === p) S.hoverSlot = -1;
    },
  });
}

function writeTether(n, sub, vt, dronePos, reach, tI) {
  const { vCore, vTmpA, vTmpB, vCtrl2, strip } = S;
  vTmpA.copy(dronePos).sub(vCore);
  const L = Math.max(vTmpA.length(), 1e-4);
  vTmpA.multiplyScalar(1 / L); // unit core→drone
  // beam leaves the core shell, not its center
  S.vA.copy(vCore).addScaledVector(vTmpA, Math.min(S.coreRadius * 0.55, L * 0.4));
  vTmpB.crossVectors(vTmpA, S.vUp);
  if (vTmpB.lengthSq() < 1e-5) vTmpB.set(1, 0, 0); else vTmpB.normalize();
  vCtrl2.copy(S.vA).add(dronePos).multiplyScalar(0.5);
  vCtrl2.y += 2.1 + 0.8 * Math.sin(vt * 0.55 + sub.seed * 5.3);
  vCtrl2.addScaledVector(vTmpB, Math.sin(vt * 0.42 + sub.seed * 2.7) * 1.2);
  for (let k = 0; k <= SEG; k++) quadBez(strip[k], S.vA, vCtrl2, dronePos, (k / SEG) * reach);
  const vBase = n * SEG * 2;
  const pos = S.linePos, aI = S.lineI;
  for (let k = 0; k < SEG; k++) {
    const i0 = (vBase + k * 2) * 3;
    const p0 = strip[k], p1 = strip[k + 1];
    pos[i0] = p0.x; pos[i0 + 1] = p0.y; pos[i0 + 2] = p0.z;
    pos[i0 + 3] = p1.x; pos[i0 + 4] = p1.y; pos[i0 + 5] = p1.z;
    aI[vBase + k * 2] = tI;
    aI[vBase + k * 2 + 1] = tI;
  }
  S.lineDirty = true;
}

// motion trail — short deterministic position-history streak behind drone n:
// an ember arc in orbit, a real streak only during launch/return burns.
function writeTrail(n, sub, vt, headPos, intensity) {
  const pts = S.trailPts;
  pts[0].copy(headPos);
  const dur = sub.trailDur;
  for (let k = 1; k <= TRAIL_SEG; k++) {
    livePosAt(sub, vt - dur * (k / TRAIL_SEG), pts[k]);
  }
  const vBase = S.trailBaseV + n * TRAIL_SEG * 2;
  const pos = S.linePos, aI = S.lineI;
  for (let k = 0; k < TRAIL_SEG; k++) {
    const i0 = (vBase + k * 2) * 3;
    const p0 = pts[k], p1 = pts[k + 1];
    pos[i0] = p0.x; pos[i0 + 1] = p0.y; pos[i0 + 2] = p0.z;
    pos[i0 + 3] = p1.x; pos[i0 + 4] = p1.y; pos[i0 + 5] = p1.z;
    aI[vBase + k * 2] = intensity;
    aI[vBase + k * 2 + 1] = intensity;
  }
  S.lineDirty = true;
}

function writeDissolve(p, sub, dFrac) {
  const { vCore, vReturnEnd, vTmpA, vTmpB, scatter, ptsP, ptsPos } = S;
  vTmpA.copy(vCore).sub(vReturnEnd);
  if (vTmpA.lengthSq() < 1e-6) vTmpA.set(0, 1, 0); else vTmpA.normalize();
  vTmpB.crossVectors(vTmpA, S.vUp);
  if (vTmpB.lengthSq() < 1e-5) vTmpB.set(1, 0, 0); else vTmpB.normalize();
  const ca = Math.cos(sub.seed * 6.2832), sa = Math.sin(sub.seed * 6.2832);
  const appear = sstep(0, 0.12, dFrac);
  const pBase = p * PTS_PER;
  for (let j = 0; j < DIS_N; j++) {
    const o = j * 6;
    const dx = scatter[o], dy = scatter[o + 1], dz = scatter[o + 2];
    const stag = scatter[o + 3], rad = scatter[o + 4], swph = scatter[o + 5];
    const rx = dx * ca - dz * sa, rz = dx * sa + dz * ca;
    const pj = clamp01((dFrac * 1.45 - stag * 0.45));
    const pe = easeInCubic(pj);
    let px = vReturnEnd.x + rx * rad;
    let py = vReturnEnd.y + dy * rad * 0.8;
    let pz = vReturnEnd.z + rz * rad;
    px += (vCore.x - px) * pe;
    py += (vCore.y - py) * pe;
    pz += (vCore.z - pz) * pe;
    const arc = Math.sin(pj * Math.PI);
    const sw = arc * (0.5 + rad * 0.35);
    const wob = Math.sin(pj * 9.42 + swph * 6.28);
    px += vTmpB.x * wob * sw;
    py += Math.cos(pj * 7.5 + swph * 6.28) * sw * 0.45;
    pz += vTmpB.z * wob * sw;
    const pi = (pBase + 2 + j) * 3;
    ptsPos[pi] = px; ptsPos[pi + 1] = py; ptsPos[pi + 2] = pz;
    const ai = (pBase + 2 + j) * 4;
    ptsP[ai] = 0.26 * (1 - 0.55 * pj) + rad * 0.05;
    ptsP[ai + 1] = arc * appear * (0.5 + 0.6 * fract(swph * 7.7)) * 1.1;
    ptsP[ai + 2] = sub.seed;
    ptsP[ai + 3] = 0.35;
  }
  S.ptsDirty = true;
}

function drive(p, sub, vt, dt, state) {
  const { vCore, vTarget, vCtrl, vPos, vDir, vTmpA, vAnchor, vReturnEnd, m4, q1, q2, vScl } = S;
  const u = vt - sub.spawnVt;
  slotPos(sub, vt, vTarget);
  let scale, glowV, engI, dissolveV = 0, reach, tI, dFrac = -1;

  if (u < T_OUT) {
    // ── spawn: eased arc out of the core, engine burning hard ────────────
    const f = u / T_OUT, e = easeOutCubic(f);
    vCtrl.copy(vCore).addScaledVector(vTmpA.copy(vTarget).sub(vCore), 0.28);
    vCtrl.y = vCore.y + 9.5;
    quadBez(vPos, vCore, vCtrl, vTarget, e);
    bezTan(vDir, vCore, vCtrl, vTarget, e);
    scale = easeOutBack(clamp01(f * 3.2));
    glowV = 0.9 + 1.1 * (1 - f) * (1 - f);       // emergence flash, eases off
    engI = 1.9 - 0.9 * f;                        // launch burn tapers
    reach = e;
    tI = 0.35 + 0.75 * e;
  } else if (u < sub.life) {
    // ── orbit: slow drift, gentle bob, engine idling ─────────────────────
    vPos.copy(vTarget);
    const th = sub.baseAngle + sub.orbSpeed * vt;
    vDir.set(-Math.sin(th), 0, Math.cos(th));
    scale = 1;
    glowV = 0.8 + 0.22 * Math.sin(vt * 1.8 + sub.seed * 12.0);
    engI = 0.55 + 0.20 * Math.sin(vt * 2.6 + sub.seed * 15.0);
    reach = 1;
    tI = 1;
  } else {
    // anchor keeps rotating with the shell (see livePosAt) — the return leg
    // reads as a gentle spiral home and slot bearings never collapse
    slotPos(sub, vt, vAnchor);
    if (u < sub.life + T_RET) {
      // ── despawn leg 1: burn partway home ───────────────────────────────
      const r = (u - sub.life) / T_RET, e = easeInOutCubic(r);
      vPos.copy(vAnchor).lerp(vCore, e * RETURN_FRAC);
      vPos.y -= Math.sin(e * Math.PI) * 0.9;
      vDir.copy(vCore).sub(vPos);
      scale = 1 - 0.12 * e;
      glowV = 0.9 + 0.8 * e;                      // energy builds before the burst
      engI = 0.6 + 0.9 * e;                       // return burn
      reach = 1 - 0.35 * easeInCubic(r);
      tI = 1 - 0.35 * r;
    } else {
      // ── despawn leg 2: dissolve into particles streaming coreward ─────
      dFrac = clamp01((u - sub.life - T_RET) / T_DIS);
      vReturnEnd.copy(vAnchor).lerp(vCore, RETURN_FRAC);
      vPos.copy(vReturnEnd).lerp(vCore, easeInCubic(dFrac) * 0.3);
      vDir.copy(vCore).sub(vPos);
      const shrink = 1 - easeInCubic(Math.min(dFrac * 1.6, 1));
      scale = 0.88 * Math.max(shrink, 0);
      glowV = 1.9 * (1 - easeInCubic(dFrac));
      engI = 0.8 * (1 - dFrac);                   // engine dies with the hull
      dissolveV = dFrac;
      reach = 0.65 * (1 - easeInCubic(dFrac));    // tether retracts into the core
      tI = 0.8 * (1 - dFrac);
    }
  }

  // WORKING state — eased flags for the surge glow, tether pulse, glyph ring
  let live = false;
  const act = state.activeSubagents;
  for (let k = 0; k < act.length; k++) if (act[k] === sub.ref) { live = true; break; }
  const sK = 1 - Math.exp(-dt * 7);
  S.surge[p] += ((live ? 1.55 : 1.0) - S.surge[p]) * sK;
  const surge = S.surge[p];
  S.work[p] += ((live ? 1 : 0) - S.work[p]) * (1 - Math.exp(-dt * 4.5));
  const workK = S.work[p];
  // hover affordance — brighten eased in/out
  S.hoverK[p] += ((S.hoverSlot === p ? 1 : 0) - S.hoverK[p]) * (1 - Math.exp(-dt * 10));
  const hoverK = S.hoverK[p];

  // orientation: face travel direction, slow self-spin, fixed personal tilt
  if (vDir.x * vDir.x + vDir.z * vDir.z < 1e-4 * (vDir.y * vDir.y + 1e-6)) {
    const th = sub.baseAngle + sub.orbSpeed * vt;
    vDir.set(-Math.sin(th), 0.15, Math.cos(th));
  }
  vDir.normalize();
  m4.lookAt(S.vZero, vDir, S.vUp);
  q1.setFromRotationMatrix(m4);
  q2.setFromAxisAngle(S.vUp, vt * sub.spin + sub.seed * 20.0);
  q1.multiply(q2);
  q2.setFromAxisAngle(S.vX, (sub.seed - 0.5) * 0.6);
  q1.multiply(q2);

  // per-drone size + elongation — no two silhouettes match
  const s = scale * BODY_SCALE * sub.scl;
  m4.compose(vPos, q1, vScl.set(s, s * sub.str, s));
  S.body.setMatrixAt(p, m4);
  S.glow.setMatrixAt(p, m4);
  const ai = p * 4;
  const g = glowV * surge * (1 + 0.30 * hoverK);
  S.bodyInst[ai] = g; S.bodyInst[ai + 1] = dissolveV; S.bodyInst[ai + 2] = sub.seed; S.bodyInst[ai + 3] = engI * surge;
  S.glowInst[ai] = g; S.glowInst[ai + 1] = dissolveV; S.glowInst[ai + 2] = sub.seed; S.glowInst[ai + 3] = engI * surge;
  S.instDirty = true;

  // tether — WORKING pulse deepens the throb; hover brightens the whole beam
  const pulse = 0.8 + (0.2 + 0.25 * workK) * Math.sin(vt * 2.6 + sub.seed * 11.0);
  writeTether(p, sub, vt, vPos, Math.max(reach, 0.001), tI * pulse * surge * 0.9 * (1 + 1.1 * hoverK));

  const vis = Math.min(scale, 1);
  const fade = dFrac >= 0 ? 1 - dFrac : 1;
  const halfH = s * sub.str * 0.62;               // world half-height of the hull
  const pBase = p * PTS_PER;

  // activity glyph ring — lights after arrival, turns while WORKING, dies
  // exactly when the subagent completes (workK decays over the return leg)
  const arr = sstep(T_OUT * 0.9, T_OUT * 1.5, u);
  const ringI = workK * arr * vis * fade * surge
    * (0.8 + 0.2 * Math.sin(vt * 1.1 + sub.seed * 9.0)) * (1 + 0.35 * hoverK);
  m4.compose(vPos, sub.ringQ, vScl.set(s, s, s));
  S.ring.setMatrixAt(p, m4);
  S.ringInst[ai] = ringI; S.ringInst[ai + 2] = sub.seed;

  // pick proxy — same pose as the hull, inflated for a forgiving hit target
  m4.compose(vPos, q1, vScl.set(s * 1.7, s * sub.str * 1.3, s * 1.7));
  const proxy = S.proxies[p];
  proxy.matrix.copy(m4);
  proxy.matrixWorldNeedsUpdate = true;

  // nav light — hard little strobe at the nose
  const bs = fract(vt * 0.8 + sub.seed * 5.0);
  let blink = 0.04;
  if (bs < 0.05) blink = 1.0; else if (bs >= 0.11 && bs < 0.15) blink = 0.7;
  vTmpA.set(0, 1, 0).applyQuaternion(q1).multiplyScalar(halfH * 1.05).add(vPos);
  let pi = pBase * 3;
  S.ptsPos[pi] = vTmpA.x; S.ptsPos[pi + 1] = vTmpA.y; S.ptsPos[pi + 2] = vTmpA.z;
  let pa = pBase * 4;
  S.ptsP[pa] = 0.36; S.ptsP[pa + 1] = blink * vis * fade * 1.5; S.ptsP[pa + 2] = sub.seed; S.ptsP[pa + 3] = 1.0;

  // engine sprite — hot dot at the aft tip, flickering with the burn
  const flick = 0.85 + 0.15 * Math.sin(vt * 21.0 + sub.seed * 60.0);
  vTmpA.set(0, -1, 0).applyQuaternion(q1).multiplyScalar(halfH * 0.92).add(vPos);
  pi = (pBase + 1) * 3;
  S.ptsPos[pi] = vTmpA.x; S.ptsPos[pi + 1] = vTmpA.y; S.ptsPos[pi + 2] = vTmpA.z;
  pa = (pBase + 1) * 4;
  S.ptsP[pa] = 0.32 + 0.16 * Math.min(engI, 1.5);
  S.ptsP[pa + 1] = engI * surge * flick * vis * fade * 0.9;
  S.ptsP[pa + 2] = sub.seed; S.ptsP[pa + 3] = 1.0;
  S.ptsDirty = true;

  // short expo-decay motion trail — follows the full flight path
  writeTrail(p, sub, vt, vPos, 0.55 * surge * vis * fade);

  // dissolve particle stream
  if (dFrac >= 0) {
    S.dissolveOn[p] = true;
    writeDissolve(p, sub, dFrac);
  } else if (S.dissolveOn[p]) {
    // seeked backwards out of the dissolve window — clear stale particles
    S.dissolveOn[p] = false;
    const b4 = p * PTS_PER * 4;
    for (let j = 0; j < DIS_N; j++) S.ptsP[b4 + (2 + j) * 4 + 1] = 0;
    S.ptsDirty = true;
  }
}

// ── THE session-shaped build ──────────────────────────────────────────────
// Per-subagent flight plan + golden-angle slot choreography, derived from
// ctx.timeline.subagents. Called by init() and AGAIN by reset() after a
// session swap — the subagent set is the only session-shaped input this module
// has, so factoring it here means init and reset share one build path.
//
// Pure JS by construction: this allocates plain objects, one Quaternion per
// mind and a scratch array — NO geometry, material, texture or buffer
// attribute. That is what makes a swap dispose-free (see reset()).
//
// life = the timeline's [spawnVt, endVt] span (≥12s guaranteed by
// MIN_DRONE_LIFE upstream); LIFE_FLOOR only catches spawns clipped by the end
// of playback. The drone exists ONLY inside [spawnVt, endVis] — the sky agrees
// with the HUD roster.
function buildSubs(ctx) {
  const T = ctx.THREE, { LAYOUT } = ctx;
  const subs = (ctx.timeline.subagents ?? []).map((ref, i) => {
    const life = Math.max(ref.endVt - ref.spawnVt, LIFE_FLOOR);
    const ringTilt = new T.Euler(
      Math.PI / 2 + (hash(i + 61.3) - 0.5) * 0.55,
      0,
      (hash(i + 67.1) - 0.5) * 0.55,
    );
    return {
      ref,
      spawnVt: ref.spawnVt,
      life,
      endVis: ref.spawnVt + life + T_RET + T_DIS,
      seed: hash(i + 17.9),
      // uniform shell rotation — per-drone speeds drift bearings together
      // over absolute vt and collapse the golden-angle separation; the
      // constellation turns rigidly, individuality lives in bob/wobble/spin
      orbSpeed: 0.065,
      bobF: 0.5 + hash(i + 23.3) * 0.6,
      bobA: 0.4 + hash(i + 29.1) * 0.4,
      spin: 0.6 + hash(i + 31.7) * 0.8,
      scl: 0.80 + hash(i + 37.9) * 0.55,    // size variation
      str: 1.30 + hash(i + 43.3) * 0.34,    // elongation variation
      trailDur: 0.55 + hash(i + 47.7) * 0.35, // short trails
      ringQ: new T.Quaternion().setFromEuler(ringTilt),
      slot: 0, baseAngle: 0, rad: 0, y: 0,  // choreography pass fills these
    };
  });

  // ── golden-angle slot choreography ────────────────────────────────────
  // Greedy interval coloring over each mind's full visible window: minds
  // whose windows overlap can never share a slot, so concurrent drones are
  // separated by whole golden-angle steps plus radial/vertical stagger.
  // The flagship's vt 17–41 burst needs 14 slots; POOL (16) covers it with
  // margin. Slot indices only feed bearing/radius/height maths — a session
  // whose concurrency exceeds POOL is throttled by the pool scan in update(),
  // never by an out-of-range index here.
  const order = subs.map((_, i) => i).sort((a, b) => subs[a].spawnVt - subs[b].spawnVt);
  const slotFreeAt = [];
  for (const i of order) {
    const sub = subs[i];
    let c = 0;
    while (c < slotFreeAt.length && slotFreeAt[c] > sub.spawnVt + 1e-6) c++;
    slotFreeAt[c] = sub.endVis;
    sub.slot = c;
    // jitter stays well under the ~12.4° minimum separation that 14
    // golden-angle slots guarantee — bearings can never collapse
    sub.baseAngle = c * GOLDEN + (hash(i + 53.9) - 0.5) * 0.10;
    sub.rad = LAYOUT.droneOrbitRadius + ((c % 3) - 1) * 1.5 + (hash(i + 7.3) - 0.5) * 1.8;
    sub.y = LAYOUT.droneOrbitY + ((c % 4) - 1.5) * 1.6 + (hash(i + 11.7) - 0.5) * 2.2;
  }
  return subs;
}

export default {
  name: 'drones',

  init(ctx) {
    const { THREE: T, PALETTE, LAYOUT } = ctx;
    const violet = new T.Color(PALETTE.subagent);
    const hull = new T.Color(PALETTE.coreShell).lerp(violet, 0.30);
    const ambient = new T.Color(PALETTE.cache).multiplyScalar(0.22);

    const shared = {
      uCamPos: { value: new T.Vector3() },
      uFogColor: { value: new T.Color(PALETTE.fogColor) },
      uFogType: { value: 0 },
      uFogNear: { value: 1 },
      uFogFar: { value: 100 },
      uFogDensity: { value: 0 },
      uTime: { value: 0 },
      uPx: { value: 600 },
    };

    // ── per-subagent flight plan + choreography (deterministic) ───────────
    // Session-shaped — the ONLY session-shaped state in this module. reset()
    // calls the same helper after a swap.
    const subs = buildSubs(ctx);

    // ── instanced bodies + fresnel glow shells (live pool only) ───────────
    // Unstretched octahedra — per-drone elongation lives in the instance
    // matrix so the hull shader sees local tips at ±0.62.
    const bodyGeo = new T.OctahedronGeometry(0.62, 0);
    bodyGeo.computeVertexNormals(); // flat faceted normals
    const glowGeo = new T.OctahedronGeometry(0.94, 1);

    const bodyInst = new Float32Array(POOL * 4);
    const glowInst = new Float32Array(POOL * 4);
    const ringInst = new Float32Array(POOL * 4);
    const bodyAttr = new T.InstancedBufferAttribute(bodyInst, 4).setUsage(T.DynamicDrawUsage);
    const glowAttr = new T.InstancedBufferAttribute(glowInst, 4).setUsage(T.DynamicDrawUsage);
    const ringAttr = new T.InstancedBufferAttribute(ringInst, 4).setUsage(T.DynamicDrawUsage);
    bodyGeo.setAttribute('aInst', bodyAttr);
    glowGeo.setAttribute('aInst', glowAttr);

    const bodyMat = new T.ShaderMaterial({
      uniforms: {
        uViolet: { value: violet }, uHull: { value: hull }, uAmbient: { value: ambient },
        uTime: shared.uTime, uCamPos: shared.uCamPos, uFogColor: shared.uFogColor,
        uFogType: shared.uFogType, uFogNear: shared.uFogNear,
        uFogFar: shared.uFogFar, uFogDensity: shared.uFogDensity,
      },
      vertexShader: VERT_INST, fragmentShader: BODY_FRAG,
    });
    const glowMat = new T.ShaderMaterial({
      uniforms: {
        uViolet: { value: violet },
        uCamPos: shared.uCamPos, uFogColor: shared.uFogColor,
        uFogType: shared.uFogType, uFogNear: shared.uFogNear,
        uFogFar: shared.uFogFar, uFogDensity: shared.uFogDensity,
      },
      vertexShader: VERT_INST, fragmentShader: GLOW_FRAG,
      blending: T.AdditiveBlending, transparent: true, depthWrite: false,
    });

    const body = new T.InstancedMesh(bodyGeo, bodyMat, POOL);
    const glow = new T.InstancedMesh(glowGeo, glowMat, POOL);
    body.instanceMatrix.setUsage(T.DynamicDrawUsage);
    glow.instanceMatrix.setUsage(T.DynamicDrawUsage);
    body.frustumCulled = glow.frustumCulled = false;
    glow.renderOrder = 5;

    // ── activity glyph rings (instanced flat annuli, shader-rotated) ──────
    const ringGeo = new T.RingGeometry(0.80, 1.06, 64, 1);
    ringGeo.setAttribute('aInst', ringAttr);
    const ringMat = new T.ShaderMaterial({
      uniforms: {
        uViolet: { value: violet }, uTime: shared.uTime,
        uCamPos: shared.uCamPos, uFogColor: shared.uFogColor,
        uFogType: shared.uFogType, uFogNear: shared.uFogNear,
        uFogFar: shared.uFogFar, uFogDensity: shared.uFogDensity,
      },
      vertexShader: VERT_INST, fragmentShader: RING_FRAG,
      blending: T.AdditiveBlending, transparent: true, depthWrite: false,
      side: T.DoubleSide,
    });
    const ring = new T.InstancedMesh(ringGeo, ringMat, POOL);
    ring.instanceMatrix.setUsage(T.DynamicDrawUsage);
    ring.frustumCulled = false;
    ring.renderOrder = 6;

    // ── merged tethers + motion trails (one LineSegments) ─────────────────
    const tetherVerts = POOL * SEG * 2;
    const trailBaseV = tetherVerts;
    const lineVerts = tetherVerts + POOL * TRAIL_SEG * 2;
    const linePos = new Float32Array(lineVerts * 3);
    const lineT = new Float32Array(lineVerts);
    const lineI = new Float32Array(lineVerts);
    const lineSeed = new Float32Array(lineVerts);
    const lineMode = new Float32Array(lineVerts); // 0 = tether dash, 1 = trail streak
    for (let n = 0; n < POOL; n++) {
      const vBase = n * SEG * 2;
      for (let k = 0; k < SEG; k++) {
        lineT[vBase + k * 2] = k / SEG;
        lineT[vBase + k * 2 + 1] = (k + 1) / SEG;
      }
      const tBase = trailBaseV + n * TRAIL_SEG * 2;
      for (let k = 0; k < TRAIL_SEG; k++) {
        lineT[tBase + k * 2] = k / TRAIL_SEG;
        lineT[tBase + k * 2 + 1] = (k + 1) / TRAIL_SEG;
        lineMode[tBase + k * 2] = 1;
        lineMode[tBase + k * 2 + 1] = 1;
      }
    }
    const lineGeo = new T.BufferGeometry();
    lineGeo.setAttribute('position', new T.BufferAttribute(linePos, 3).setUsage(T.DynamicDrawUsage));
    lineGeo.setAttribute('aT', new T.BufferAttribute(lineT, 1));
    lineGeo.setAttribute('aI', new T.BufferAttribute(lineI, 1).setUsage(T.DynamicDrawUsage));
    lineGeo.setAttribute('aSeed', new T.BufferAttribute(lineSeed, 1).setUsage(T.DynamicDrawUsage));
    lineGeo.setAttribute('aMode', new T.BufferAttribute(lineMode, 1));
    const lineMat = new T.ShaderMaterial({
      uniforms: {
        uViolet: { value: violet }, uTime: shared.uTime,
        uCamPos: shared.uCamPos, uFogColor: shared.uFogColor,
        uFogType: shared.uFogType, uFogNear: shared.uFogNear,
        uFogFar: shared.uFogFar, uFogDensity: shared.uFogDensity,
      },
      vertexShader: LINE_VERT, fragmentShader: LINE_FRAG,
      blending: T.AdditiveBlending, transparent: true, depthWrite: false,
    });
    const lines = new T.LineSegments(lineGeo, lineMat);
    lines.frustumCulled = false;
    lines.matrixAutoUpdate = false;
    lines.renderOrder = 6;

    // ── points cloud: nav lights + engine sprites + dissolve particles ────
    const nPts = POOL * PTS_PER;
    const ptsPos = new Float32Array(nPts * 3);
    const ptsP = new Float32Array(nPts * 4);
    const ptsGeo = new T.BufferGeometry();
    ptsGeo.setAttribute('position', new T.BufferAttribute(ptsPos, 3).setUsage(T.DynamicDrawUsage));
    ptsGeo.setAttribute('aP', new T.BufferAttribute(ptsP, 4).setUsage(T.DynamicDrawUsage));
    const ptsMat = new T.ShaderMaterial({
      uniforms: {
        uViolet: { value: violet }, uPx: shared.uPx,
        uCamPos: shared.uCamPos, uFogColor: shared.uFogColor,
        uFogType: shared.uFogType, uFogNear: shared.uFogNear,
        uFogFar: shared.uFogFar, uFogDensity: shared.uFogDensity,
      },
      vertexShader: PTS_VERT, fragmentShader: PTS_FRAG,
      blending: T.AdditiveBlending, transparent: true, depthWrite: false,
    });
    const points = new T.Points(ptsGeo, ptsMat);
    points.frustumCulled = false;
    points.matrixAutoUpdate = false;
    points.renderOrder = 7;

    // ── pick proxies — invisible-material meshes, one per pool slot ───────
    // WebGLRenderer culls material.visible === false at projectObject, so
    // these cost zero draw calls; Mesh.raycast still intersects them. Each
    // claim() re-registers the slot's proxy with that subagent's card.
    const proxyGeo = new T.OctahedronGeometry(0.62, 1);
    const proxyMat = new T.MeshBasicMaterial({ visible: false });
    const proxies = [];
    for (let n = 0; n < POOL; n++) {
      const m = new T.Mesh(proxyGeo, proxyMat);
      m.matrixAutoUpdate = false;
      m.matrix.makeScale(0, 0, 0);
      m.frustumCulled = false;
      proxies.push(m);
    }

    // dissolve scatter table — shared across drones, rotated per-seed
    const scatter = new Float32Array(DIS_N * 6);
    for (let j = 0; j < DIS_N; j++) {
      const o = j * 6;
      const a = hash(j * 3.7 + 1.3) * Math.PI * 2;
      const z = 2 * hash(j * 9.1 + 4.7) - 1;
      const rxy = Math.sqrt(Math.max(1 - z * z, 0));
      scatter[o] = Math.cos(a) * rxy;
      scatter[o + 1] = z;
      scatter[o + 2] = Math.sin(a) * rxy;
      scatter[o + 3] = hash(j * 5.3 + 8.9);          // stagger
      scatter[o + 4] = 0.34 + 0.78 * hash(j * 7.7 + 2.2); // scatter radius
      scatter[o + 5] = hash(j * 11.3 + 6.1);         // swirl phase
    }

    const group = new T.Group();
    group.matrixAutoUpdate = false;
    group.add(body, glow, ring, lines, points, ...proxies);
    ctx.scene.add(group);

    S = {
      subs, shared, group, body, glow, ring, lines, points, proxies,
      pick: ctx.pick,
      bodyInst, glowInst, ringInst, bodyAttr, glowAttr, ringAttr,
      linePos, lineI, lineSeed, lineGeo, trailBaseV,
      ptsPos, ptsP, ptsGeo,
      scatter,
      coreRadius: LAYOUT.coreRadius,
      slotOf: new Int16Array(subs.length).fill(-1),
      poolSub: new Int16Array(POOL).fill(-1),
      surge: new Float32Array(POOL).fill(1),
      work: new Float32Array(POOL),
      hoverK: new Float32Array(POOL),
      hoverSlot: -1,
      nowVt: 0,
      dissolveOn: new Array(POOL).fill(false),
      instDirty: false, lineDirty: false, ptsDirty: false,
      // scratch — allocated once, reused every frame
      vCore: new T.Vector3(0, LAYOUT.coreY, 0),
      vZero: new T.Vector3(),
      vUp: new T.Vector3(0, 1, 0),
      vX: new T.Vector3(1, 0, 0),
      vTarget: new T.Vector3(), vCtrl: new T.Vector3(), vCtrl2: new T.Vector3(),
      vPos: new T.Vector3(), vDir: new T.Vector3(),
      vTmpA: new T.Vector3(), vTmpB: new T.Vector3(), vTmpC: new T.Vector3(),
      vAnchor: new T.Vector3(), vReturnEnd: new T.Vector3(), vA: new T.Vector3(),
      vS1: new T.Vector3(), vS2: new T.Vector3(),
      vScl: new T.Vector3(), v2: new T.Vector2(),
      m4: new T.Matrix4(), q1: new T.Quaternion(), q2: new T.Quaternion(),
      strip: Array.from({ length: SEG + 1 }, () => new T.Vector3()),
      trailPts: Array.from({ length: TRAIL_SEG + 1 }, () => new T.Vector3()),
    };

    // park every instance at zero scale — the shell starts (and mostly stays)
    // empty, exactly like the roster it renders
    parkPool();
  },

  // IN-PLACE SESSION SWAP (see the SESSION SWAP CONTRACT in main.js). The
  // subagent set is session-shaped, so every drone from the outgoing session is
  // despawned and the slot choreography is rebuilt from the NEW
  // ctx.timeline.subagents — read through ctx here, never from a local captured
  // at init.
  //
  // WHAT IS DISPOSED: nothing, and that is the correct answer rather than a
  // shortcut. Everything this module allocates on the GPU is POOL-shaped, and
  // POOL is a module constant that no session can change: the two octahedron
  // geometries + ring annulus + line/points BufferGeometries + proxy geometry,
  // their five ShaderMaterials and the invisible proxy material, the
  // POOL-length instance attributes (aInst/aT/aI/aSeed/aMode/aP), the POOL
  // InstancedMesh instance matrices, and the pool of pick-proxy meshes. None of
  // it encodes anything about the session — only the FLOATS written into it do,
  // and parkPool() zeroes those. Rebuilding it per swap would be the actual
  // leak risk over an hours-long attract run (five shader recompiles and a
  // fresh set of GL buffers every entry), so it is deliberately reused. There
  // are no per-session textures, render targets or geometries to dispose.
  //
  // WHAT IS RELEASED: the pick registrations for every occupied slot (their
  // card/onHover closures capture the OLD session's subagent ref — leaving them
  // registered would both retain the outgoing session's event data and let
  // interact.js keep scoring hover hits on drones that no longer exist), the
  // old S.subs flight plans with their per-mind Quaternions, and the old
  // subagent-indexed S.slotOf table.
  reset(ctx) {
    if (!S) return;
    parkPool();                                        // despawn every live drone
    S.subs = buildSubs(ctx);                           // new session's minds
    S.slotOf = new Int16Array(S.subs.length).fill(-1);  // subagent-indexed: resize
    S.nowVt = 0;                                       // new timeline starts at vt 0
  },

  update(dt, state, ctx) {
    if (!S) return;
    const vt = state.vt;
    S.nowVt = vt; // hover cards resolve WORKING/DONE against this

    // shared uniforms
    S.shared.uTime.value = vt;
    S.shared.uCamPos.value.copy(ctx.camera.position);
    const fog = ctx.scene.fog;
    if (!fog) S.shared.uFogType.value = 0;
    else if (fog.isFogExp2) {
      S.shared.uFogType.value = 2;
      S.shared.uFogDensity.value = fog.density;
      S.shared.uFogColor.value.copy(fog.color);
    } else {
      S.shared.uFogType.value = 1;
      S.shared.uFogNear.value = fog.near;
      S.shared.uFogFar.value = fog.far;
      S.shared.uFogColor.value.copy(fog.color);
    }
    ctx.renderer.getDrawingBufferSize(S.v2);
    S.shared.uPx.value = S.v2.y * 0.5 * ctx.camera.projectionMatrix.elements[5];

    const subs = S.subs;
    // free drones whose visual window closed (or that seeked out of range)
    for (let i = 0; i < subs.length; i++) {
      const p = S.slotOf[i];
      if (p >= 0 && (vt < subs[i].spawnVt || vt >= subs[i].endVis)) {
        freeSlot(p);
        S.slotOf[i] = -1;
      }
    }
    // assign pool slots to subagents entering their window
    for (let i = 0; i < subs.length; i++) {
      if (S.slotOf[i] >= 0) continue;
      const sub = subs[i];
      if (vt >= sub.spawnVt && vt < sub.endVis) {
        let p = -1;
        for (let k = 0; k < POOL; k++) if (S.poolSub[k] < 0) { p = k; break; }
        if (p < 0) continue; // pool saturated — measured visible peak is 14, never hits this
        S.slotOf[i] = p;
        S.poolSub[p] = i;
        claim(p, sub, vt);
      }
    }
    // drive every occupied live slot
    for (let p = 0; p < POOL; p++) {
      const si = S.poolSub[p];
      if (si >= 0) drive(p, subs[si], vt, dt, state);
    }

    flushBuffers();
  },
};
