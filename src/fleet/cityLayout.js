// cityLayout.js — FLEET VIEW: THE CITY. Ground plane + placement + atmosphere.
//
// Owns, for the fleet page: scene fog, the neon grid floor (custom shader —
// AA minor/major lines, per-line luminance travel, three distance curves so
// saturation dies before luminance dies before nothing, a district light pool
// whose intensity tracks plot occupancy, and a magenta live-edge wash along
// the front row that scales with how many sessions are actually streaming),
// a matte under-floor that takes the lighting rig, subtle plot pads (dim
// emissive frame rectangles under each OCCUPIED slot — presence = a session
// exists, frame heat = live vs archived, interior fill = log transcript mass
// in MB, pad footprint = the ground the row actually allocates), a faint
// horizon skyline ring far out for depth, ~700 drifting motes, a gradient
// void dome (the night is never pure black), and the 3-light rig
// (hemisphere grade + cyan key over the district + low magenta front rim).
//
// LAYOUT CONTRACT (other fleet modules read this after init):
//   ctx.cityLayout = {
//     slotFor(i) -> { x, y, z, angle }   // angle: yaw about +Y, radians —
//                                        // the plot faces the boulevard
//                                        // vanishing point out front
//     padSizeFor(i) -> number            // ground footprint edge length
//     count,                             // precomputed slots (96)
//     frontRowCount,                     // 4 — matches the live-stream cap
//     bounds: { minX, maxX, minZ, maxZ } // district extent (first 24 plots)
//   }
// Placement: a loose hex-block district facing +Z. Roster order is mtime-desc
// (actives first), so LOW INDEX = RECENT/LIVE: row 0 is 4 wide-spaced
// front-row plots (the streaming sessions), rows recede and tighten behind —
// spacing itself encodes liveness. Deterministic (seeded), jittered ("loose"),
// slots are pure functions of index so siblings may call slotFor at any time.
//
// Data-ink ledger (info-design law): plot position = recency rank, row
// spacing = live vs archived, pad presence = occupancy, pad frame heat =
// active flag, pad fill = transcript sizeMB (log), district ground pool =
// occupancy fraction, front-row magenta wash = live session count / 4.
// Ornament (skyline, motes, dome) stays at the periphery.
//
// Contract-defensive (fleetMain.js was unpublished when this was written):
// roster access mirrors machines.js — ctx.roster / ctx.sessions /
// ctx.fleet.{roster,sessions}, re-checked ~1 Hz; update is signature-tolerant.
// Budget: 6 draw calls, ~6k triangles, all allocation in init().

import * as THREE from 'three';
import { PALETTE as PALETTE_FALLBACK } from '../lib/palette.js';

/* ---------------------------------------------------------------- tunables */

const FOG_BASE = 0.005;
const GRID_SPAN = 800;
const PAD_Y = 0.045;          // above grid plane (0.02), below machine plinths
const MAX_PADS = 64;          // roster server caps at 40; machines pools 48
const SLOT_COUNT = 96;
const SIZE_NORM_MB = 300;     // pad fill saturates at a 300 MB transcript
const FRONT_ROW = 4;          // == the live-stream cap
const FACE_Z = 60;            // boulevard vanishing point plots face

// district rows: [plots, spacing, z]. Front row wide and forward (live),
// rows tighten and recede (archive). 4+5+7+8 = 24 primary plots.
const ROWS = [
  [4, 9.0, 9.5],
  [5, 6.8, 2.8],
  [7, 5.4, -3.4],
  [8, 4.8, -9.2],
];
const EXTRA_ROW_N = 9, EXTRA_ROW_SP = 4.6, EXTRA_ROW_DZ = 5.6;

/* ------------------------------------------------- pure helpers (no DOM) */

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Precompute every slot once. Pure function of index — no roster dependence.
function buildSlots() {
  const rng = mulberry32(0xC17F1EE7);
  const slots = [];
  const rowMeta = [];   // parallel: spacing of the row each slot lives in
  const pushRow = (n, sp, z, jx, jz) => {
    for (let i = 0; i < n && slots.length < SLOT_COUNT; i++) {
      const bx = (i - (n - 1) / 2) * sp;
      const x = bx + (rng() * 2 - 1) * jx;
      const zz = z + (rng() * 2 - 1) * jz;
      const angle = Math.atan2(-x, FACE_Z - zz) + (rng() * 2 - 1) * 0.05;
      slots.push({ x, y: 0, z: zz, angle });
      rowMeta.push(sp);
    }
  };
  for (let r = 0; r < ROWS.length; r++) {
    const [n, sp, z] = ROWS[r];
    // front row barely jitters — the live rank must read ordered
    pushRow(n, sp, z, r === 0 ? 0.3 : 0.55, r === 0 ? 0.35 : 0.8);
  }
  let r = ROWS.length;
  while (slots.length < SLOT_COUNT) {
    pushRow(EXTRA_ROW_N, EXTRA_ROW_SP,
      ROWS[ROWS.length - 1][2] - EXTRA_ROW_DZ * (r - ROWS.length + 1), 0.55, 0.8);
    r++;
  }
  const b = { minX: 1e9, maxX: -1e9, minZ: 1e9, maxZ: -1e9 };
  for (let i = 0; i < 24; i++) {
    b.minX = Math.min(b.minX, slots[i].x); b.maxX = Math.max(b.maxX, slots[i].x);
    b.minZ = Math.min(b.minZ, slots[i].z); b.maxZ = Math.max(b.maxZ, slots[i].z);
  }
  return { slots, rowMeta, bounds: b };
}

// roster adapter — mirrors machines.js so both modules see the same shape
function rosterOf(ctx) {
  const cands = [ctx?.roster, ctx?.sessions, ctx?.fleet?.roster, ctx?.fleet?.sessions];
  for (const c of cands) {
    if (Array.isArray(c)) return c;
    if (Array.isArray(c?.sessions)) return c.sessions;
  }
  return null;
}

/* ---------------------------------------------------------------- shaders */

const GRID_VERT = /* glsl */`
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

// Three distance curves (all extrapolation-proof: exp of squares, never pow):
// minor grid dies first, saturation collapses to the fog hue next, luminance
// last — neon underfoot, muted mid-field, gone into the haze.
// uOcc: occupied-plot fraction drives the district ground pool.
// uLive: live-session fraction (n/4) drives the front-row magenta wash.
const GRID_FRAG = /* glsl */`
varying vec3 vW;
uniform float uTime, uFogD, uBright, uOcc, uLive;
uniform vec3 uLine, uGlow, uMag, uFogHue;

float hash1(float n) { return fract(sin(n) * 43758.5453123); }

void main() {
  vec2 p = vW.xz;

  // minor grid — cell 4, moire guard melts it at distance
  vec2 qn = abs(fract(p / 4.0 - 0.5) - 0.5) * 4.0;
  vec2 fn = fwidth(qn) + 1e-4;
  float guard = clamp(1.0 - max(fn.x, fn.y) * 0.55, 0.0, 1.0);
  float mnx = 1.0 - smoothstep(0.02, 0.02 + fn.x * 1.6, qn.x);
  float mny = 1.0 - smoothstep(0.02, 0.02 + fn.y * 1.6, qn.y);
  float minor = max(mnx, mny) * guard;

  // major grid — cell 20, luminance travels along each line, per-line phase
  vec2 qm = abs(fract(p / 20.0 - 0.5) - 0.5) * 20.0;
  vec2 fm = fwidth(qm) + 1e-4;
  vec2 idm = floor(p / 20.0 + 0.5);
  float phx = hash1(idm.x * 127.1);
  float phy = hash1(idm.y * 269.5);
  float mx = 1.0 - smoothstep(0.055, 0.055 + fm.x * 1.6, qm.x);
  float my = 1.0 - smoothstep(0.055, 0.055 + fm.y * 1.6, qm.y);
  float wx = 0.45 + 0.55 * sin(p.y * 0.11 - uTime * (0.42 + 0.22 * phx) + phx * 6.2831);
  float wy = 0.45 + 0.55 * sin(p.x * 0.11 - uTime * (0.36 + 0.22 * phy) + phy * 6.2831);
  float glow = exp(-min(qm.x, qm.y) * 1.1);

  float dcam = distance(p, cameraPosition.xz);
  float fA = dcam * uFogD * 2.0;  float fade  = exp(-fA * fA);  // luminance
  float sA = dcam * uFogD * 3.2;  float sat   = exp(-sA * sA);  // hue, dies first
  float mA = dcam * uFogD * 4.4;  float mfade = exp(-mA * mA);  // minor, dies soonest

  vec3 col = uLine * minor * 0.40 * mfade
           + uGlow * (mx * wx + my * wy) * 0.66
           + uGlow * glow * 0.075;

  // district ground pool — brightness tracks how full the city is
  vec2 dc = p - vec2(0.0, -1.0);
  col += uGlow * exp(-dot(dc, dc) * 0.0032) * (0.05 + 0.10 * uOcc);

  // live-edge wash along the front row — magenta = fresh, scaled by n/4 live
  float bz = (p.y - 9.5) / 7.0;
  float bx = p.x / 24.0;
  col += uMag * exp(-(bz * bz + bx * bx)) * (0.075 * uLive);

  // scattering kills hue before it kills light
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(luma * uFogHue, col, sat);

  gl_FragColor = vec4(max(col, vec3(0.0)) * uBright * fade, 1.0);
}`;

// Plot pads — dim emissive frame rectangles. Frame heat = live/archived,
// interior fill = transcript mass, breath is slow and desynchronized.
const PAD_VERT = /* glsl */`
attribute vec3 aState;   // fade, activeMix, fill
attribute float aSeed;
varying vec2 vUv;
varying vec3 vState;
varying float vSeed;
void main() {
  vUv = uv;
  vState = aState;
  vSeed = aSeed;
  #ifdef USE_INSTANCING
    vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  #else
    vec4 w = modelMatrix * vec4(position, 1.0);
  #endif
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const PAD_FRAG = /* glsl */`
uniform float uTime;
uniform vec3 uLine, uGlow;
varying vec2 vUv;
varying vec3 vState;
varying float vSeed;
void main() {
  float fade = vState.x, act = vState.y, fill = vState.z;
  if (fade < 0.004) discard;
  vec2 q = abs(vUv - 0.5);
  float m = max(q.x, q.y);
  vec2 fw = fwidth(vUv) + 1e-4;
  float aa = max(fw.x, fw.y) * 1.5;

  // outer frame line
  float frame = smoothstep(0.5 - 0.038 - aa, 0.5 - 0.038, m)
              * (1.0 - smoothstep(0.5 - aa * 0.5, 0.5, m));
  // corner emphasis — the frame reads as a marked plot, not a tile
  float corner = smoothstep(0.30, 0.42, q.x) * smoothstep(0.30, 0.42, q.y);
  // faint inner rule
  float rule = smoothstep(0.345, 0.345 + aa, m) * (1.0 - smoothstep(0.365, 0.365 + aa, m));
  // interior — transcript mass as a soft floor glow
  float interior = (1.0 - smoothstep(0.20, 0.34, m)) * fill;

  float breath = 0.86 + 0.14 * sin(uTime * (0.35 + 0.2 * fract(vSeed * 7.31)) + vSeed * 6.2831);
  vec3 col = mix(uLine, uGlow, act);
  float I = frame * (0.28 + 0.62 * act) * (1.0 + corner * 0.9)
          + rule * 0.10
          + interior * 0.085;
  gl_FragColor = vec4(col * (I * fade * breath), 1.0);
}`;

// Horizon skyline — one instanced ring of silhouettes, sparse window lattice,
// per-fragment haze grading to a violet-lifted horizon. Depth, not spectacle.
const SKY_VERT = /* glsl */`
attribute vec3 aDim;
attribute vec3 aMeta;
varying vec3 vLocal, vNrm, vWorld, vDim, vMeta;
void main() {
  vDim = aDim;
  vMeta = aMeta;
  vLocal = position * aDim;
  vNrm = normal;
  #ifdef USE_INSTANCING
    vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  #else
    vec4 w = modelMatrix * vec4(position, 1.0);
  #endif
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const SKY_FRAG = /* glsl */`
varying vec3 vLocal, vNrm, vWorld, vDim, vMeta;
uniform float uTime, uFogD;
uniform vec3 uBase, uHazeLow, uHazeHigh, uWin;

float h1(float n) { return fract(sin(n) * 43758.5453123); }
float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

void main() {
  float seed = vMeta.x, depth01 = vMeta.y, shade = vMeta.z;
  vec3 n = vNrm;

  float u, span, faceId;
  if (abs(n.x) > 0.5)      { u = vLocal.z; span = vDim.z; faceId = step(0.0, n.x); }
  else if (abs(n.z) > 0.5) { u = vLocal.x; span = vDim.x; faceId = 2.0 + step(0.0, n.z); }
  else                     { u = 0.0;      span = 0.0;    faceId = 4.0; }
  float v = vLocal.y + vDim.y * 0.5;

  // window lattice — 2.0m x 3.8m cells, AA panes, banded floors
  float cu = floor(u / 2.0), fu = fract(u / 2.0);
  float cv = floor(v / 3.8), fv = fract(v / 3.8);
  vec2 fw = fwidth(vec2(u / 2.0, v / 3.8)) + 1e-4;
  float px = smoothstep(0.28 - fw.x, 0.28 + fw.x, fu) * (1.0 - smoothstep(0.72 - fw.x, 0.72 + fw.x, fu));
  float py = smoothstep(0.30 - fw.y, 0.30 + fw.y, fv) * (1.0 - smoothstep(0.74 - fw.y, 0.74 + fw.y, fv));
  float pane = px * py;

  float fs = seed + faceId * 7.31;
  float floorOn = step(0.66, h2(vec2(cv, fs)));            // whole floors together
  float cellOn = step(0.42, h2(vec2(cu, cv * 1.7 + fs)));
  float lit = floorOn * cellOn;
  lit *= step(2.0, v) * step(v, vDim.y - 1.5);
  lit *= step(abs(u), span * 0.5 - 0.8) * step(faceId, 3.5);

  float br = 0.6 + 0.4 * h2(vec2(cu * 3.1, cv * 1.7) + fs);
  float breathe = 0.8 + 0.2 * sin(uTime * 0.14 + seed * 5.0);
  vec3 emis = uWin * (pane * lit * br * breathe * 0.55 * exp(-depth01 * 1.3));

  float hGrad = clamp(v / max(vDim.y, 1.0), 0.0, 1.0);
  vec3 base = uBase * (shade * (0.5 + 0.5 * hGrad));

  float hd = distance(vWorld, cameraPosition) * uFogD * (1.05 + depth01 * 0.45);
  float hz = min(1.0 - exp(-hd * hd), 0.95);
  vec3 hazeC = mix(uHazeHigh, uHazeLow, exp(-max(vWorld.y, 0.0) * 0.05));
  vec3 col = mix(base, hazeC, hz) + emis * (1.0 - hz * 0.8);

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}`;

const MOTE_VERT = /* glsl */`
attribute float aSeed;
attribute float aSize;
attribute vec3 aCol;
uniform float uTime, uVH, uFogD, uHalf;
varying vec3 vCol;
varying float vA;
void main() {
  float s = aSeed;
  vec3 p = position;
  float ang = s * 6.2831853;
  float spd = 0.20 + 0.45 * fract(s * 7.31);
  p.x += cos(ang) * spd * uTime;
  p.z += sin(ang) * spd * uTime;
  p.x = mod(p.x + uHalf, uHalf * 2.0) - uHalf;
  p.z = mod(p.z + uHalf, uHalf * 2.0) - uHalf;
  p.y += sin(uTime * 0.15 + s * 43.7) * (0.7 + fract(s * 3.7));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = max(-mv.z, 0.001);
  gl_PointSize = clamp(aSize * projectionMatrix[1][1] * uVH * 0.5 / dist, 1.0, 4.0);
  float tw = 0.5 + 0.5 * sin(uTime * (0.22 + 0.5 * fract(s * 3.17)) + s * 91.0);
  float fA = dist * uFogD * 1.2;
  vA = (0.28 + 0.72 * tw * tw) * exp(-fA * fA) * smoothstep(2.5, 8.0, dist);
  vCol = aCol;
  gl_Position = projectionMatrix * mv;
}`;

const MOTE_FRAG = /* glsl */`
varying vec3 vCol;
varying float vA;
void main() {
  float a = smoothstep(0.5, 0.08, length(gl_PointCoord - 0.5));
  gl_FragColor = vec4(vCol * (a * max(vA, 0.0)), 1.0);
}`;

const DOME_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Powers built by multiplication — no pow, nothing to go NaN.
const DOME_FRAG = /* glsl */`
varying vec3 vDir;
uniform vec3 uVoid, uFogC, uCyan, uViolet;
void main() {
  vec3 dir = normalize(vDir);   // sphere surface — never zero length
  float hz = clamp(1.0 - abs(dir.y), 0.0, 1.0);
  float hz2 = hz * hz;
  float hz5 = hz2 * hz2 * hz;
  vec3 col = uVoid
           + uFogC * hz5 * 2.5
           + uCyan * hz5 * hz2 * 0.05
           + uViolet * hz5 * hz2 * 0.055;
  gl_FragColor = vec4(col, 1.0);
}`;

/* ------------------------------------------------------------------ module */

let S = null;   // module state bag — filled in init()

function padTargetsFrom(roster) {
  // Build-once, append-later — the exact discipline machines.js uses, so pad i
  // stays under machine i for the life of the page.
  for (const sess of roster) {
    const id = String(sess.id);
    let p = S.byId.get(id);
    if (!p) {
      if (S.assigned >= Math.min(MAX_PADS, S.layout.count)) continue;
      p = { slot: S.assigned++, fade: 0, act: 0, fadeT: 1, actT: 0, fill: 0 };
      S.byId.set(id, p);
      S.stateAttr.setXYZ(p.slot, 0, 0, 0);
    }
    p.fadeT = 1;
    p.actT = sess.active ? 1 : 0;
    // transcript mass grows while a session streams — keep the fill honest
    const size = Number(sess.sizeMB) || 0;
    const fill = clamp01(Math.log(size + 1) / Math.log(SIZE_NORM_MB + 1));
    if (Math.abs(fill - p.fill) > 1e-3) {
      p.fill = fill;
      S.stateAttr.setXYZ(p.slot, p.fade, p.act, p.fill);
      S.stateAttr.needsUpdate = true;
    }
  }
  let occ = 0, live = 0;
  for (const p of S.byId.values()) { occ++; if (p.actT > 0.5) live++; }
  S.occT = clamp01(occ / 24);
  S.liveT = clamp01(live / FRONT_ROW);
}

export default {
  name: 'cityLayout',

  init(ctx) {
    const P = ctx.PALETTE ?? PALETTE_FALLBACK;
    const scene = ctx.scene;
    const rng = mulberry32(0xD15C7C1);         // deterministic city for the critic
    const hi = ctx.quality !== 'low';
    const C = (hex, s = 1) => new THREE.Color(hex).multiplyScalar(s);
    const pixelRatio = ctx.renderer?.getPixelRatio?.() ?? 1;
    const size = ctx.renderer?.getSize?.(new THREE.Vector2()) ?? { y: 1080 };

    // ---- the layout API — published before any geometry so siblings can read
    const { slots, rowMeta, bounds } = buildSlots();
    const padSizeFor = (i) => {
      const sp = rowMeta[Math.min(Math.max(i | 0, 0), rowMeta.length - 1)];
      return Math.min(4.6, Math.max(2.4, sp * 0.58));
    };
    ctx.cityLayout = {
      slotFor(i) { return slots[Math.min(Math.max(i | 0, 0), SLOT_COUNT - 1)]; },
      padSizeFor,
      count: SLOT_COUNT,
      frontRowCount: FRONT_ROW,
      bounds,
    };

    S = {
      ctx, layout: ctx.cityLayout,
      byId: new Map(), assigned: 0,
      occ: 0, occT: 0, live: 0, liveT: 0,
      time: 0, rosterTimer: 0, pixelRatio,
    };

    const U = S.U = {
      uTime: { value: 0 },
      uFogD: { value: FOG_BASE },
      uBright: { value: 1 },
      uOcc: { value: 0 },
      uLive: { value: 0 },
      uVH: { value: size.y * pixelRatio },
    };

    // ---- fog ----
    S.fog = new THREE.FogExp2(P.fogColor, FOG_BASE);
    scene.fog = S.fog;

    const fogC = C(P.fogColor);
    const fogLuma = 0.2126 * fogC.r + 0.7152 * fogC.g + 0.0722 * fogC.b;
    const fogHue = fogC.clone().multiplyScalar(1 / Math.max(fogLuma, 1e-4));

    // ---- matte under-floor: catches the rig ----
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(GRID_SPAN, GRID_SPAN),
      new THREE.MeshStandardMaterial({
        color: C(P.coreShell, 0.8), metalness: 0.6, roughness: 0.45,
      }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.05;
    scene.add(floor);

    // ---- neon grid ----
    const grid = new THREE.Mesh(
      new THREE.PlaneGeometry(GRID_SPAN, GRID_SPAN),
      new THREE.ShaderMaterial({
        vertexShader: GRID_VERT, fragmentShader: GRID_FRAG,
        uniforms: {
          uTime: U.uTime, uFogD: U.uFogD, uBright: U.uBright,
          uOcc: U.uOcc, uLive: U.uLive,
          uLine: { value: C(P.gridLine) },
          uGlow: { value: C(P.gridGlow) },
          uMag:  { value: C(P.fresh) },
          uFogHue: { value: fogHue },
        },
        transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, fog: false,
      }));
    grid.rotation.x = -Math.PI / 2;
    grid.position.y = 0.02;
    grid.renderOrder = 1;
    grid.frustumCulled = false;
    scene.add(grid);

    // ---- plot pads: one instanced draw, aState carries all the data ----
    const padGeo = new THREE.PlaneGeometry(1, 1);
    S.stateAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PADS * 3), 3);
    S.stateAttr.setUsage(THREE.DynamicDrawUsage);
    const seedAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PADS), 1);
    padGeo.setAttribute('aState', S.stateAttr);
    padGeo.setAttribute('aSeed', seedAttr);
    const padMat = new THREE.ShaderMaterial({
      vertexShader: PAD_VERT, fragmentShader: PAD_FRAG,
      uniforms: {
        uTime: U.uTime,
        uLine: { value: C(P.gridLine, 1.6) },
        uGlow: { value: C(P.gridGlow) },
      },
      transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    S.pads = new THREE.InstancedMesh(padGeo, padMat, MAX_PADS);
    S.pads.frustumCulled = false;
    S.pads.renderOrder = 2;
    {
      const m = new THREE.Matrix4();
      const pos = new THREE.Vector3();
      const qX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
      const up = new THREE.Vector3(0, 1, 0);
      const qY = new THREE.Quaternion();
      const q = new THREE.Quaternion();
      const sc = new THREE.Vector3();
      for (let i = 0; i < MAX_PADS; i++) {
        const s = slots[Math.min(i, SLOT_COUNT - 1)];
        const e = padSizeFor(i);
        qY.setFromAxisAngle(up, s.angle);
        q.copy(qY).multiply(qX);
        m.compose(pos.set(s.x, PAD_Y, s.z), q, sc.set(e, e, 1));
        S.pads.setMatrixAt(i, m);
        seedAttr.setX(i, rng());
        S.stateAttr.setXYZ(i, 0, 0, 0);   // unoccupied: invisible
      }
    }
    scene.add(S.pads);

    // ---- horizon skyline ring: one instanced draw, periphery only ----
    const SKY_N = hi ? 96 : 64;
    const skyGeo = new THREE.BoxGeometry(1, 1, 1);
    const aDim = new Float32Array(SKY_N * 3);
    const aMeta = new Float32Array(SKY_N * 3);
    const hazeLow = C(P.fogColor, 1.6).add(C(P.subagent, 0.05));
    const hazeHigh = C(P.void);
    const sky = new THREE.InstancedMesh(
      skyGeo,
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
        uniforms: {
          uTime: U.uTime, uFogD: U.uFogD,
          uBase: { value: C(P.coreShell) },
          uHazeLow: { value: hazeLow },
          uHazeHigh: { value: hazeHigh },
          uWin: { value: C(P.cache, 0.9) },
        },
        fog: false,
      }),
      SKY_N);
    sky.frustumCulled = false;
    {
      const dummy = new THREE.Object3D();
      for (let i = 0; i < SKY_N; i++) {
        const ang = (i / SKY_N) * Math.PI * 2 + (rng() - 0.5) * (Math.PI * 2 / SKY_N) * 0.9;
        const rad = 175 + rng() * 62;
        let w = 6 + rng() * 14;
        let h = 10 + rng() * 36;
        let d = 6 + rng() * 14;
        if (rng() < 0.12) { h *= 1.5; w *= 0.55; d *= 0.6; }   // spires
        dummy.position.set(Math.cos(ang) * rad, h / 2, Math.sin(ang) * rad);
        dummy.rotation.set(0, ang + (rng() - 0.5) * 0.7, 0);
        dummy.scale.set(w, h, d);
        dummy.updateMatrix();
        sky.setMatrixAt(i, dummy.matrix);
        aDim[i * 3] = w; aDim[i * 3 + 1] = h; aDim[i * 3 + 2] = d;
        aMeta[i * 3] = rng() * 100;                     // facade seed
        aMeta[i * 3 + 1] = rng();                       // depth layer 0..1
        aMeta[i * 3 + 2] = 0.5 + rng() * 0.7;           // shade
      }
      skyGeo.setAttribute('aDim', new THREE.InstancedBufferAttribute(aDim, 3));
      skyGeo.setAttribute('aMeta', new THREE.InstancedBufferAttribute(aMeta, 3));
    }
    scene.add(sky);

    // ---- drifting motes ----
    const N = hi ? 900 : 450;
    const HALF = 70;
    const mPos = new Float32Array(N * 3);
    const mSeed = new Float32Array(N);
    const mSize = new Float32Array(N);
    const mCol = new Float32Array(N * 3);
    const cA = C(P.gridGlow, 0.5), cB = C(P.fresh, 0.3), cC = C(P.subagent, 0.38);
    for (let i = 0; i < N; i++) {
      mPos[i * 3] = (rng() * 2 - 1) * HALF;
      mPos[i * 3 + 1] = 1.2 + rng() * rng() * 26;
      mPos[i * 3 + 2] = (rng() * 2 - 1) * HALF;
      mSeed[i] = rng() * 1000;
      mSize[i] = 0.05 + rng() * 0.12;
      const roll = rng();
      const cc = roll < 0.74 ? cA : roll < 0.87 ? cB : cC;
      mCol[i * 3] = cc.r; mCol[i * 3 + 1] = cc.g; mCol[i * 3 + 2] = cc.b;
    }
    const moteGeo = new THREE.BufferGeometry();
    moteGeo.setAttribute('position', new THREE.BufferAttribute(mPos, 3));
    moteGeo.setAttribute('aSeed', new THREE.BufferAttribute(mSeed, 1));
    moteGeo.setAttribute('aSize', new THREE.BufferAttribute(mSize, 1));
    moteGeo.setAttribute('aCol', new THREE.BufferAttribute(mCol, 3));
    const motes = new THREE.Points(moteGeo, new THREE.ShaderMaterial({
      vertexShader: MOTE_VERT, fragmentShader: MOTE_FRAG,
      uniforms: { uTime: U.uTime, uFogD: U.uFogD, uVH: U.uVH, uHalf: { value: HALF } },
      transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false,
    }));
    motes.renderOrder = 3;
    motes.frustumCulled = false;
    scene.add(motes);

    // ---- void dome: the night is never pure black ----
    S.dome = new THREE.Mesh(
      new THREE.SphereGeometry(600, 36, 20),
      new THREE.ShaderMaterial({
        vertexShader: DOME_VERT, fragmentShader: DOME_FRAG,
        uniforms: {
          uVoid: { value: C(P.void) },
          uFogC: { value: C(P.fogColor) },
          uCyan: { value: C(P.gridGlow) },
          uViolet: { value: C(P.subagent) },
        },
        side: THREE.BackSide, depthWrite: false, fog: false,
      }));
    S.dome.renderOrder = -10;
    scene.add(S.dome);

    // ---- lighting rig: 3 lights ----
    scene.add(new THREE.HemisphereLight(C(P.gridLine, 1.2), C(P.void), 1.5));
    S.keyLight = new THREE.PointLight(C(P.coreEnergy), 900, 170, 1.8);
    S.keyLight.position.set(0, 26, 4);            // over the district
    scene.add(S.keyLight);
    S.rimLight = new THREE.PointLight(C(P.fresh), 260, 120, 1.9);
    S.rimLight.position.set(-8, 7, 34);           // low magenta rim off the live edge
    scene.add(S.rimLight);

    const first = rosterOf(ctx);
    if (first?.length) padTargetsFrom(first);

    console.log(
      `[fleet/cityLayout] district online — ${SLOT_COUNT} slots (${FRONT_ROW} front-row), ` +
      `${SKY_N} skyline silhouettes, ${N} motes, 6 draws`);
  },

  update(dt, a, b) {
    if (!S) return;
    // signature-tolerant: (dt, state, ctx) or (dt, ctx)
    const ctx = (b && (b.scene || b.streams || b.THREE)) ? b
      : (a && (a.scene || a.streams || a.THREE)) ? a : S.ctx;
    S.ctx = ctx;
    const t = (S.time += dt);
    const U = S.U;

    U.uTime.value = t;

    // slow desynchronized breathing across fog, grid, and the rig
    S.fog.density = FOG_BASE * (1 + 0.04 * Math.sin(t * 0.11));
    U.uFogD.value = S.fog.density;
    U.uBright.value = 0.92 + 0.08 * Math.sin(t * 0.21);
    S.keyLight.intensity = 900 * (1 + 0.07 * Math.sin(t * 0.23));
    S.rimLight.intensity = 260 * (0.6 + 0.4 * S.live) * (1 + 0.10 * Math.sin(t * 0.17 + 2.1));
    S.dome.rotation.y += dt * 0.0015;

    // roster resync ~1 Hz: occupancy, liveness flips, late arrivals
    if ((S.rosterTimer -= dt) <= 0) {
      S.rosterTimer = 1.0;
      const roster = rosterOf(ctx);
      if (roster?.length) padTargetsFrom(roster);
    }

    // eased pad transitions (exp approach — nothing snaps)
    const k = 1 - Math.exp(-dt * 3.0);
    let dirty = false;
    for (const p of S.byId.values()) {
      const df = (p.fadeT - p.fade) * k;
      const da = (p.actT - p.act) * k;
      if (Math.abs(df) + Math.abs(da) > 1e-4) {
        p.fade += df; p.act += da;
        S.stateAttr.setXYZ(p.slot, p.fade, p.act, p.fill);
        dirty = true;
      }
    }
    if (dirty) S.stateAttr.needsUpdate = true;

    // district pool + live-edge wash ease toward roster truth
    S.occ += (S.occT - S.occ) * k;
    S.live += (S.liveT - S.live) * k;
    U.uOcc.value = S.occ;
    U.uLive.value = S.live;
  },

  resize(_w, h) {
    if (S) S.U.uVH.value = h * S.pixelRatio;
  },
};
