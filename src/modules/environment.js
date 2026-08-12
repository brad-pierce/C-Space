// environment.js — THE FLOOR & BEYOND.
//
// Owns: scene fog, the infinite glow-grid floor (custom shader — AA lines,
// per-line luminance travel, light pools under core/tower, and three distance
// curves so intensity AND saturation die into the fog instead of reading
// synthwave-flat), a matte under-floor that takes the lighting rig, the
// distant data-skyline (one InstancedMesh, three depth rings, custom facade
// shader with structured window bands — banded floors, contiguous lit runs,
// rare full-height columns, per-ring intensity — plus per-fragment haze that
// grades from #05060a overhead to a faint violet horizon), two additive haze
// shells slotted between the skyline rings (the volumetric gradient that
// separates mid machine from far city), 1.1k–2.4k drifting dust motes, the
// lighting rig (cool ambient + hemisphere grade + cyan core key + magenta rim
// from the tower side), and a faint BackSide nebula dome. Everything breathes
// on slow desynchronized sines. The single event reaction: a compaction fires
// an expanding grid shockwave ring that decays in under ~2s.
//
// Round 3 — the "environment no-show" was traced OFF-module: post's MSAA fp16
// target lets varyings extrapolate at primitive edges, a pow(negative,
// fractional) elsewhere goes NaN, and bloom smears it over the frame. Rules
// kept from that round: every pow/normalize here is extrapolation-proof, and
// a shot-mode scene-luminance assert (tiny LDR probe render on the first
// settled frame) console.error's + flags window.__ENV_LUMA_FAIL if the mean
// scene luminance is below 1/255 — a void frame can never ship silently.
//
// Round 4 — critic: the grid was uniform full-saturation cyan with no
// falloff, and the skyline was flat cutouts with confetti window pixels, so
// depth collapsed to two planes. Fixes: grid gains separate curves for
// minor-grid kill, saturation (falls fastest, toward the fog hue), and
// intensity; the window Points are gone — windows are now a structured
// facade lattice generated in the monolith shader at three ring intensities;
// per-fragment haze (distance x height gradient, ring-weighted) plus two
// horizon haze shells give ring0/ring1/ring2 distinct tonal planes.
//
// Round 5 — infographic campaign r2 (LEGEND): the window glyphs shared both
// scale and palette with the chronogram's data ticks (raw cache-cyan panes,
// raw fresh-magenta floors), so non-data and data spoke one visual
// vocabulary and the skyline out-competed the encodings in cam0/cam5. Rule
// now in force: THE ENVIRONMENT NEVER WEARS A TOOL-FAMILY HUE AT SATURATION.
// Windows are ~50% dimmer and luma-lerped toward gray (cool slate default,
// rare dull-sodium warm floors); mote accents drop fresh-pink/subagent-
// violet for the same neutrals. Any saturated pink/teal/purple/amber mark
// in frame is therefore guaranteed to be data.
//
// Round 6 — LEGEND r4: the floor light pools (cyan under the core, magenta
// under the tower) out-luminanced actual data marks and owned the
// compositional foreground. Pool intensity halved (0.12→0.06, 0.10→0.05)
// AND pool hue 50% desaturated (new uPoolC/uPoolM uniforms, palette-derived
// via the round-5 desat helper) so world luminance rank-orders by
// information: data > structure > atmosphere. Skyline windows untouched
// (depth cue stays). Perf, same round: the dome's two per-fragment 3-octave
// fbm fields (audit P1, ~line 334) are baked once at init into a 256x256
// tiling RG DataTexture — two mip-free fetches replace 24 sin() calls per
// sky fragment — and the aurora branch early-outs when band < 0.01; the
// shot-mode luma probe RT is disposed after its single frame-2 readback
// (audit P2, ~line 596).
//
// Budget: 7 draw calls, ~4.6k triangles, zero per-frame allocation.
// (The luma probe adds one 160x90 render + readback, once, shot mode only,
// and is disposed afterward.)

import * as THREE from 'three';

/* ---------------------------------------------------------------- helpers */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FOG_BASE = 0.0046;   // tuned so ring 1 skyline reads ~60%, ring 3 ~5%

/* ---------------------------------------------------------------- shaders */

const GRID_VERT = /* glsl */`
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

// cameraPosition is auto-injected by three into ShaderMaterial fragments.
// Distance discipline (round 4): saturation collapses toward the fog hue
// faster than luminance fades, and the minor grid dies before either — the
// floor reads neon underfoot, muted at mid-field, and gone into the haze.
const GRID_FRAG = /* glsl */`
varying vec3 vW;
uniform float uTime, uPulse, uFogD, uBright;
uniform vec3 uLine, uGlow, uPoolC, uPoolM, uFogHue;

float hash1(float n) { return fract(sin(n) * 43758.5453123); }

void main() {
  vec2 p = vW.xz;

  // minor grid — cell 4, dim, with a moire guard that melts it at distance
  vec2 qn = abs(fract(p / 4.0 - 0.5) - 0.5) * 4.0;
  vec2 fn = fwidth(qn) + 1e-4;
  float guard = clamp(1.0 - max(fn.x, fn.y) * 0.55, 0.0, 1.0);
  float mnx = 1.0 - smoothstep(0.02, 0.02 + fn.x * 1.6, qn.x);
  float mny = 1.0 - smoothstep(0.02, 0.02 + fn.y * 1.6, qn.y);
  float minor = max(mnx, mny) * guard;

  // major grid — cell 20, luminance travels along each line, phase per line
  vec2 qm = abs(fract(p / 20.0 - 0.5) - 0.5) * 20.0;
  vec2 fm = fwidth(qm) + 1e-4;
  vec2 idm = floor(p / 20.0 + 0.5);
  float phx = hash1(idm.x * 127.1);
  float phy = hash1(idm.y * 269.5);
  float mx = 1.0 - smoothstep(0.055, 0.055 + fm.x * 1.6, qm.x);
  float my = 1.0 - smoothstep(0.055, 0.055 + fm.y * 1.6, qm.y);
  float wx = 0.42 + 0.58 * sin(p.y * 0.12 - uTime * (0.45 + 0.25 * phx) + phx * 6.2831);
  float wy = 0.42 + 0.58 * sin(p.x * 0.12 - uTime * (0.38 + 0.25 * phy) + phy * 6.2831);
  float glow = exp(-min(qm.x, qm.y) * 1.1);

  // three distance curves (all extrapolation-proof: squared, never pow)
  float dcam = distance(p, cameraPosition.xz);
  float fA = dcam * uFogD * 2.2;  float fade  = exp(-fA * fA);  // intensity
  float sA = dcam * uFogD * 3.4;  float sat   = exp(-sA * sA);  // saturation, dies first
  float mA = dcam * uFogD * 4.6;  float mfade = exp(-mA * mA);  // minor grid, dies soonest

  vec3 col = uLine * minor * 0.42 * mfade
           + uGlow * (mx * wx + my * wy) * (0.72 + uPulse * 1.1)
           + uGlow * glow * (0.085 + uPulse * 0.16);

  // light pools: cyan under the core, magenta spill under the tower.
  // LEGEND r4: pools are atmosphere, not data — intensity halved and hue
  // half-desaturated (uPoolC/uPoolM) so no floor wash can out-luminance
  // the marks standing on it.
  float dc = length(p);
  col += uPoolC * exp(-dc * dc * 0.0045) * 0.06;
  vec2 tp = p - vec2(-19.0, -13.0);
  col += uPoolM * exp(-dot(tp, tp) * 0.012) * 0.05;

  // compaction shockwave — ring expands outward as the pulse decays
  float ring = exp(-abs(dc - (1.0 - uPulse) * 95.0) * 0.35);
  col += uGlow * ring * uPulse * 0.55;

  // scattering kills hue before it kills light: collapse to fog hue, then fade
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(luma * uFogHue, col, sat);

  gl_FragColor = vec4(max(col, vec3(0.0)) * uBright * fade, 1.0);
}`;

// Skyline monoliths — instanced silhouettes with a procedural facade lattice.
// Windows are structured, not confetti: whole floors light in bands, windows
// light in contiguous runs of 2-5, rare full-height service columns, ~7% dead
// panes, one-in-forty dying-fluorescent flicker. Ring index sets emissive
// intensity (three depth layers); haze = distance x height gradient so far
// towers melt into a faint violet horizon instead of staying flat cutouts.
const MONO_VERT = /* glsl */`
attribute vec3 aDim;
attribute vec3 aMeta;
varying vec3 vLocal, vNrm, vWorld, vDim, vMeta;
void main() {
  vDim = aDim;
  vMeta = aMeta;
  vLocal = position * aDim;   // facade meters, local
  vNrm = normal;
  #ifdef USE_INSTANCING
    vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  #else
    vec4 w = modelMatrix * vec4(position, 1.0);
  #endif
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const MONO_FRAG = /* glsl */`
varying vec3 vLocal, vNrm, vWorld, vDim, vMeta;
uniform float uTime, uFogD;
uniform vec3 uBase, uHazeLow, uHazeHigh, uWinC, uWinW;

float h1(float n) { return fract(sin(n) * 43758.5453123); }
float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

void main() {
  float seed = vMeta.x, ringz = vMeta.y, shade = vMeta.z;
  vec3 n = vNrm;

  // facade coords: u runs along the face, v is height above the base (meters)
  float u, span, faceId;
  if (abs(n.x) > 0.5)      { u = vLocal.z; span = vDim.z; faceId = step(0.0, n.x); }
  else if (abs(n.z) > 0.5) { u = vLocal.x; span = vDim.x; faceId = 2.0 + step(0.0, n.z); }
  else                     { u = 0.0;      span = 0.0;    faceId = 4.0; }  // roof/underside
  float v = vLocal.y + vDim.y * 0.5;

  // window lattice — 1.9m x 3.6m cells, AA panes
  float cu = floor(u / 1.9), fu = fract(u / 1.9);
  float cv = floor(v / 3.6), fv = fract(v / 3.6);
  vec2 fw = fwidth(vec2(u / 1.9, v / 3.6)) + 1e-4;
  float px = smoothstep(0.26 - fw.x, 0.26 + fw.x, fu) * (1.0 - smoothstep(0.74 - fw.x, 0.74 + fw.x, fu));
  float py = smoothstep(0.28 - fw.y, 0.28 + fw.y, fv) * (1.0 - smoothstep(0.76 - fw.y, 0.76 + fw.y, fv));
  float pane = px * py;

  // structured lighting — banded floors x contiguous runs, rare lit columns
  float fs = seed + faceId * 7.31;
  float density = 0.30 + 0.45 * h1(fs * 0.717);            // per-building character
  float floorOn = step(1.0 - density, h2(vec2(cv, fs)));   // whole floors light together
  float runW = 2.0 + floor(h1(fs * 1.93) * 4.0);           // run length 2-5 windows
  float runOn = step(0.38, h2(vec2(floor(cu / runW), cv * 1.7 + fs)));
  float alive = step(0.07, h2(vec2(cu, cv) + fs));         // ~7% dead panes
  float colOn = step(0.968, h2(vec2(cu, fs + 3.7)));       // rare full-height columns
  float lit = clamp(floorOn * runOn + colOn, 0.0, 1.0) * alive;
  lit *= step(2.2, v) * step(v, vDim.y - 1.4);             // top/bottom margins
  lit *= step(abs(u), span * 0.5 - 0.7) * step(faceId, 3.5);

  // per-cell brightness + the rare dying-fluorescent flicker
  float br = 0.72 + 0.28 * h2(vec2(cu * 3.1, cv * 1.7) + fs);
  float flick = step(0.985, h2(vec2(cu + 13.0, cv) + fs));
  br *= mix(1.0, 0.45 + 0.55 * sin(uTime * (6.0 + 14.0 * h1(fs + cu)) + cu * 9.0), flick);

  // per-floor tint (slate default, ~14% dull-sodium warm floors) — round 5:
  // deliberately desaturated and off every tool-family hue; in this scene
  // saturation is reserved for data marks, the city glows in neutrals
  vec3 winCol = mix(uWinC, uWinW, step(0.86, h2(vec2(cv, fs + 11.0))));
  float ringI = pow(0.5, ringz) * 0.85;                    // 0.85 / 0.43 / 0.21
  float breathe = 0.82 + 0.18 * sin(uTime * 0.16 + seed * 5.0);
  vec3 emis = winCol * (pane * lit * br * ringI * breathe);

  // silhouette base — near-black, faint floor banding, lifts toward the sky
  float hGrad = clamp(v / max(vDim.y, 1.0), 0.0, 1.0);
  float bandTex = 0.88 + 0.12 * (0.5 + 0.5 * cos(fv * 6.2831853));
  vec3 base = uBase * (shade * (0.55 + 0.45 * hGrad) * bandTex);

  // haze — distance x height gradient: #05060a overhead, violet at horizon.
  // Ring-weighted so the three rings occupy three distinct tonal planes.
  float hd = distance(vWorld, cameraPosition) * uFogD * (1.05 + ringz * 0.30);
  float hz = min(1.0 - exp(-hd * hd), 0.94);
  vec3 hazeC = mix(uHazeHigh, uHazeLow, exp(-max(vWorld.y, 0.0) * 0.045));
  vec3 col = mix(base, hazeC, hz) + emis * (1.0 - hz * 0.75);

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}`;

// Horizon haze shells — additive open cylinders slotted between skyline rings.
// The volumetric gradient the silhouettes stand against: strongest at the
// floor, gone by the shell top, slow azimuthal drift so it never sits still.
const SHELL_VERT = /* glsl */`
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const SHELL_FRAG = /* glsl */`
varying vec3 vW;
uniform float uTime, uInt, uTop, uPhase;
uniform vec3 uCol;
void main() {
  float y = max(vW.y, 0.0);
  float a = exp(-y * 0.030) * (1.0 - smoothstep(uTop * 0.55, uTop, y));
  float th = atan(vW.z, vW.x);   // radius >= 180, never atan(0,0)
  a *= 0.78 + 0.14 * sin(th * 3.0 - uTime * 0.050 + uPhase)
            + 0.08 * sin(th * 7.0 + uTime * 0.031 + uPhase * 2.7);
  gl_FragColor = vec4(uCol * (max(a, 0.0) * uInt), 1.0);
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
  float spd = 0.22 + 0.5 * fract(s * 7.31);
  p.x += cos(ang) * spd * uTime;
  p.z += sin(ang) * spd * uTime;
  p.x = mod(p.x + uHalf, uHalf * 2.0) - uHalf;
  p.z = mod(p.z + uHalf, uHalf * 2.0) - uHalf;
  p.y += sin(uTime * 0.16 + s * 43.7) * (0.8 + fract(s * 3.7));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = max(-mv.z, 0.001);
  gl_PointSize = clamp(aSize * projectionMatrix[1][1] * uVH * 0.5 / dist, 1.0, 5.0);
  float tw = 0.5 + 0.5 * sin(uTime * (0.25 + 0.55 * fract(s * 3.17)) + s * 91.0);
  float fA = dist * uFogD * 1.15;
  vA = (0.3 + 0.7 * tw * tw)
     * exp(-fA * fA)
     * smoothstep(2.5, 8.0, dist);
  vCol = aCol;
  gl_Position = projectionMatrix * mv;
}`;

const MOTE_FRAG = /* glsl */`
varying vec3 vCol;
varying float vA;
void main() {
  float a = smoothstep(0.5, 0.08, length(gl_PointCoord - 0.5));
  gl_FragColor = vec4(vCol * (a * max(vA, 0.0)), 1.0);   // never negative into HDR
}`;

const DOME_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const DOME_FRAG = /* glsl */`
varying vec3 vDir;
uniform float uTime;
uniform sampler2D uNoise;
uniform vec3 uVoid, uFogC, uViolet, uCyan, uMag;

void main() {
  vec3 dir = normalize(vDir);
  vec3 col = uVoid;

  // horizon lift — city-glow haze, never pure black at the skyline.
  // Faint violet hugging the horizon line matches the monolith haze gradient.
  float hz = pow(clamp(1.0 - abs(dir.y), 0.0, 1.0), 5.0);
  col += uFogC * hz * 2.6;
  col += uCyan * hz * hz * 0.045;
  col += uViolet * hz * hz * 0.045;

  // magenta haze leaning toward the tower's horizon. Division by a clamped
  // length instead of normalize(): near the dome poles dir.xz shrinks toward
  // zero and normalize(0) is NaN — one NaN pixel is enough to blacken the
  // whole frame once bloom's mip chain smears it (round-3 lesson).
  vec2 xz = dir.xz;
  vec2 flat2 = xz / max(length(xz), 1e-4);
  float side = clamp(dot(flat2, normalize(vec2(-19.0, -13.0))), 0.0, 1.0);
  col += uMag * pow(side, 6.0) * hz * 0.06;

  // faint aurora banding in the upper sky, two drifting layers.
  // Perf audit P1: the two 3-octave fbm fields are baked at init into one
  // tiling RG texture (mip-free, so the fetch inside non-uniform flow needs
  // no derivatives — branch-safe); horizon/zenith fragments early-out and
  // pay nothing. Texture values are UNorm >= 0, so pow() stays NaN-proof.
  float band = smoothstep(0.08, 0.45, dir.y) * (1.0 - smoothstep(0.55, 0.95, dir.y));
  if (band > 0.01) {
    vec2 uv = dir.xz * (1.6 + dir.y * 0.8);   // seam-free domain
    // uvTex = (fbm domain) / 4 — the bake's base octave has period 4 per tile
    float n1 = texture2D(uNoise, uv * 0.35  + vec2(uTime * 0.0025,  uTime * 0.0015)).r;
    float n2 = texture2D(uNoise, uv * 0.575 - vec2(uTime * 0.00175, uTime * 0.00275)).g;
    col += uViolet * pow(n1, 2.2) * band * 0.16;
    col += uCyan  * pow(n2, 2.6) * band * 0.10;
  }

  gl_FragColor = vec4(col, 1.0);
}`;

/* ----------------------------------------------------------- module state */

let U = null;              // shared uniform objects (one write updates all mats)
let fog, keyLight, rimLight, dome;
let pulse = 0, tAcc = 0, pixelRatio = 1;
let probe = null;          // shot-mode scene-luminance assert rig (init-allocated)
let shotFrames = 0;

const PROBE_W = 160, PROBE_H = 90;
const LUMA_FLOOR = 1;      // mean 8-bit luminance below this = the void is showing

/* ----------------------------------------------------------------- module */

export default {
  name: 'environment',

  init(ctx) {
    const { scene, PALETTE: P, LAYOUT: L } = ctx;
    const rng = mulberry32(0x5EED);          // deterministic world for the critic
    const hi = ctx.quality !== 'low';
    pixelRatio = ctx.renderer.getPixelRatio();
    const size = ctx.renderer.getSize(new THREE.Vector2());
    const C = (hex, s = 1) => new THREE.Color(hex).multiplyScalar(s);
    // Round-5 hue discipline: palette color, scaled, then luma-lerped toward
    // its own gray — environment glyphs keep a whisper of hue but can never
    // be mistaken for a saturated data mark. (Palette-derived, no new hues.)
    const desat = (hex, s, amt) => {
      const c = C(hex, s);
      const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      return c.lerp(new THREE.Color(l, l, l), amt);
    };

    U = {
      uTime:   { value: 0 },
      uPulse:  { value: 0 },
      uFogD:   { value: FOG_BASE },
      uBright: { value: 1 },
      uVH:     { value: size.y * pixelRatio },
    };

    // ---- fog: layered depth. Ring 1 skyline reads, ring 3 is a whisper. ----
    fog = new THREE.FogExp2(P.fogColor, FOG_BASE);
    scene.fog = fog;

    // fog hue at unit luminance — the far grid desaturates toward this
    const fogC = C(P.fogColor);
    const fogLuma = 0.2126 * fogC.r + 0.7152 * fogC.g + 0.0722 * fogC.b;
    const fogHue = fogC.clone().multiplyScalar(1 / Math.max(fogLuma, 1e-4));

    // ---- matte under-floor: catches the rig, gives the floor its grade ----
    // LEGEND r4: the FOREGROUND floor pools are the key/rim point lights'
    // specular blobs on this surface (was metalness 0.6 / roughness 0.42 —
    // a glossy mirror). Metalness halved → the color-tinted metallic lobe
    // (the pools' saturation) halves; roughness 0.42→0.58 → peak specular
    // intensity ≈ halves ((0.42/0.58)^2 ≈ 0.52) and the blob softens. The
    // rig still grades the floor, but no reflection can outshine data marks
    // or rival the core heart for hottest point in frame.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(L.gridExtent * 3, L.gridExtent * 3),
      new THREE.MeshStandardMaterial({
        color: C(P.coreShell, 0.8), metalness: 0.3, roughness: 0.58,
      }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.05;
    scene.add(floor);

    // ---- the glow grid ----
    const grid = new THREE.Mesh(
      new THREE.PlaneGeometry(L.gridExtent * 3, L.gridExtent * 3),
      new THREE.ShaderMaterial({
        vertexShader: GRID_VERT, fragmentShader: GRID_FRAG,
        uniforms: {
          uTime: U.uTime, uPulse: U.uPulse, uFogD: U.uFogD, uBright: U.uBright,
          uLine:   { value: C(P.gridLine) },
          uGlow:   { value: C(P.gridGlow) },
          // LEGEND r4: half-intensity, half-saturation floor-pool tints
          uPoolC:  { value: desat(P.gridGlow, 1.0, 0.5) },
          uPoolM:  { value: desat(P.fresh, 1.0, 0.5) },
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

    // ---- data-skyline: three depth rings of monolith silhouettes ----
    const RINGS = [
      { n: 42, r0: 130, r1: 168, w0: 5,  w1: 12, h0: 16, h1: 44, s0: 0.90, s1: 1.25 },
      { n: 58, r0: 196, r1: 252, w0: 8,  w1: 19, h0: 26, h1: 66, s0: 0.65, s1: 1.00 },
      { n: 68, r0: 286, r1: 350, w0: 12, w1: 27, h0: 40, h1: 96, s0: 0.45, s1: 0.80 },
    ];
    const total = RINGS.reduce((s, r) => s + r.n, 0);

    // haze gradient endpoints: void overhead, faint violet-lifted fog at the
    // horizon — the depth cue every silhouette wears, weighted by ring.
    const hazeLow  = C(P.fogColor, 1.6).add(C(P.subagent, 0.05));
    const hazeHigh = C(P.void);

    const monoGeo = new THREE.BoxGeometry(1, 1, 1);
    const aDim  = new Float32Array(total * 3);
    const aMeta = new Float32Array(total * 3);
    const mono = new THREE.InstancedMesh(
      monoGeo,
      new THREE.ShaderMaterial({
        vertexShader: MONO_VERT, fragmentShader: MONO_FRAG,
        uniforms: {
          uTime: U.uTime, uFogD: U.uFogD,
          uBase:     { value: C(P.coreShell) },
          uHazeLow:  { value: hazeLow },
          uHazeHigh: { value: hazeHigh },
          // was C(P.cache, 0.9) / C(P.fresh, 0.75) — full data-vocabulary
          // hues. Now ~50% of the old luminance, 55-62% desaturated: cool
          // slate panes, dull-sodium warm floors. Off every TOOL_COLORS hue.
          uWinC:     { value: desat(P.cache, 0.45, 0.55) },
          uWinW:     { value: desat(P.output, 0.30, 0.62) },
        },
        fog: false,
      }),
      total);
    mono.frustumCulled = false;   // unit-box bounds lie about instance extents

    const dummy = new THREE.Object3D();
    let idx = 0;
    for (let ri = 0; ri < RINGS.length; ri++) {
      const ring = RINGS[ri];
      for (let i = 0; i < ring.n; i++) {
        const ang = (i / ring.n) * Math.PI * 2
                  + (rng() - 0.5) * (Math.PI * 2 / ring.n) * 0.9;
        const rad = ring.r0 + rng() * (ring.r1 - ring.r0);
        let w = ring.w0 + rng() * (ring.w1 - ring.w0);
        let h = ring.h0 + rng() * (ring.h1 - ring.h0);
        let d = ring.w0 + rng() * (ring.w1 - ring.w0);
        if (rng() < 0.14) { h *= 1.55; w *= 0.55; d *= 0.6; }   // spires
        const yaw = ang + (rng() - 0.5) * 0.7;

        dummy.position.set(Math.cos(ang) * rad, h / 2, Math.sin(ang) * rad);
        dummy.rotation.set(0, yaw, 0);
        dummy.scale.set(w, h, d);
        dummy.updateMatrix();
        mono.setMatrixAt(idx, dummy.matrix);

        aDim[idx * 3]     = w;
        aDim[idx * 3 + 1] = h;
        aDim[idx * 3 + 2] = d;
        aMeta[idx * 3]     = rng() * 100;                        // facade seed
        aMeta[idx * 3 + 1] = ri;                                 // ring depth layer
        aMeta[idx * 3 + 2] = ring.s0 + rng() * (ring.s1 - ring.s0); // shade
        idx++;
      }
    }
    monoGeo.setAttribute('aDim',  new THREE.InstancedBufferAttribute(aDim, 3));
    monoGeo.setAttribute('aMeta', new THREE.InstancedBufferAttribute(aMeta, 3));
    mono.instanceMatrix.needsUpdate = true;
    scene.add(mono);

    // ---- horizon haze shells: the gradient between the depth planes ----
    const shellCol = C(P.subagent, 0.5).add(C(P.gridGlow, 0.12)).add(C(P.fogColor, 3.0));
    const shellGeo = new THREE.CylinderGeometry(1, 1, 1, 64, 1, true);
    const mkShell = (r, h, intensity, phase) => {
      const m = new THREE.Mesh(shellGeo, new THREE.ShaderMaterial({
        vertexShader: SHELL_VERT, fragmentShader: SHELL_FRAG,
        uniforms: {
          uTime: U.uTime,
          uInt:   { value: intensity },
          uTop:   { value: h },
          uPhase: { value: phase },
          uCol:   { value: shellCol },
        },
        transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.BackSide, fog: false,
      }));
      m.scale.set(r, h, r);
      m.position.y = h / 2;
      m.renderOrder = 1;
      scene.add(m);
    };
    mkShell(181, 84, 0.12, 0.0);    // between ring 0 and ring 1
    mkShell(268, 110, 0.075, 2.4);  // between ring 1 and ring 2

    // ---- dust motes ----
    const N = hi ? 2400 : 1100;
    const HALF = 145;
    const mPos = new Float32Array(N * 3);
    const mSeed = new Float32Array(N);
    const mSize = new Float32Array(N);
    const mCol = new Float32Array(N * 3);
    // dust is ornament (round 5): no fresh-pink or subagent-violet sparks —
    // gray-teal, dull sodium, and ice neutrals that can't read as data
    const cA = desat(P.gridGlow, 0.5, 0.5),
          cB = desat(P.output, 0.33, 0.55),
          cC = desat(P.hudText, 0.4, 0.2);
    for (let i = 0; i < N; i++) {
      mPos[i * 3]     = (rng() * 2 - 1) * HALF;
      mPos[i * 3 + 1] = 1.5 + Math.pow(rng(), 1.6) * 44;
      mPos[i * 3 + 2] = (rng() * 2 - 1) * HALF;
      mSeed[i] = rng() * 1000;
      mSize[i] = 0.06 + rng() * 0.14;
      const roll = rng();
      const cc = roll < 0.74 ? cA : roll < 0.87 ? cB : cC;
      mCol[i * 3] = cc.r; mCol[i * 3 + 1] = cc.g; mCol[i * 3 + 2] = cc.b;
    }
    const moteGeo = new THREE.BufferGeometry();
    moteGeo.setAttribute('position', new THREE.BufferAttribute(mPos, 3));
    moteGeo.setAttribute('aSeed', new THREE.BufferAttribute(mSeed, 1));
    moteGeo.setAttribute('aSize', new THREE.BufferAttribute(mSize, 1));
    moteGeo.setAttribute('aCol',  new THREE.BufferAttribute(mCol, 3));
    const motes = new THREE.Points(moteGeo, new THREE.ShaderMaterial({
      vertexShader: MOTE_VERT, fragmentShader: MOTE_FRAG,
      uniforms: { uTime: U.uTime, uFogD: U.uFogD, uVH: U.uVH, uHalf: { value: HALF } },
      transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false,
    }));
    motes.renderOrder = 3;
    motes.frustumCulled = false;   // drift happens in the vertex shader
    scene.add(motes);

    // ---- baked aurora noise (perf audit P1) ----
    // Two 3-octave value-noise fbm fields in R/G of one 256x256 tiling
    // texture, generated once here: two texture fetches replace 24 sin()
    // calls per sky-dome fragment. Deterministic integer hash — no RNG state,
    // same sky every run for the critic. Base octave period 4 across the
    // tile, exact 2x lacunarity, so RepeatWrapping tiles seamlessly.
    const NS = 256;
    const nData = new Uint8Array(NS * NS * 4);
    const hInt = (x, y, s) => {
      let n = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
    };
    const vnTile = (x, y, period, s) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      const w = (i, j) => hInt(((i % period) + period) % period, ((j % period) + period) % period, s);
      const a = w(xi, yi), b = w(xi + 1, yi), c = w(xi, yi + 1), d = w(xi + 1, yi + 1);
      const ab = a + (b - a) * u, cd = c + (d - c) * u;
      return ab + (cd - ab) * v;
    };
    for (let y = 0; y < NS; y++) {
      for (let x = 0; x < NS; x++) {
        const fx = x / NS, fy = y / NS;
        let r = 0, g = 0, amp = 0.5, freq = 4;
        for (let o = 0; o < 3; o++) {
          r += amp * vnTile(fx * freq, fy * freq, freq, 11);
          g += amp * vnTile(fx * freq, fy * freq, freq, 29);
          amp *= 0.5; freq *= 2;
        }
        const i = (y * NS + x) * 4;
        nData[i]     = Math.round(r * 255);   // fbm range [0, 0.875], like the old GLSL
        nData[i + 1] = Math.round(g * 255);
        nData[i + 2] = 0;
        nData[i + 3] = 255;
      }
    }
    const noiseTex = new THREE.DataTexture(nData, NS, NS, THREE.RGBAFormat);
    noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
    noiseTex.magFilter = THREE.LinearFilter;
    noiseTex.minFilter = THREE.LinearFilter;   // mip-free: branch-safe fetch
    noiseTex.generateMipmaps = false;
    noiseTex.needsUpdate = true;

    // ---- nebula dome: the void has tonal depth, never pure black ----
    dome = new THREE.Mesh(
      new THREE.SphereGeometry(720, 40, 24),
      new THREE.ShaderMaterial({
        vertexShader: DOME_VERT, fragmentShader: DOME_FRAG,
        uniforms: {
          uTime: U.uTime,
          uNoise:  { value: noiseTex },
          uVoid:   { value: C(P.void) },
          uFogC:   { value: C(P.fogColor) },
          uViolet: { value: C(P.subagent) },
          uCyan:   { value: C(P.gridGlow) },
          uMag:    { value: C(P.fresh) },
        },
        side: THREE.BackSide, depthWrite: false, fog: false,
      }));
    dome.renderOrder = -10;
    scene.add(dome);

    // ---- lighting rig ----
    scene.add(new THREE.AmbientLight(C(P.gridLine), 1.1));            // dim cool
    scene.add(new THREE.HemisphereLight(C(P.gridLine, 1.2), C(P.void), 1.5));
    keyLight = new THREE.PointLight(C(P.coreEnergy), 1600, 260, 1.9); // core key
    keyLight.position.set(0, L.coreY + 7, 0);
    scene.add(keyLight);
    rimLight = new THREE.PointLight(C(P.fresh), 700, 200, 1.9);       // tower rim
    rimLight.position.set(L.towerPos[0] * 1.7, 17, L.towerPos[2] * 1.7);
    scene.add(rimLight);

    // ---- shot-mode scene-luminance assert (critique round 3) ----
    // One 160x90 LDR render of the scene (pre-post, linear, tonemap skipped in
    // RTs on r185) on the first settled shot frame. A live frame — fog floor,
    // grid, skyline, emissives — always means > LUMA_FLOOR; only a dead layer
    // (or a camera staring into nothing) fails. Failure is a console.error +
    // window flags: the capture pipeline collects console errors per shot, so
    // a black environment can never again ship as a silent SHOT_READY frame.
    // (Throwing here would get this module disabled by main.js — detection
    // must not amputate the thing it protects. post.js owns the fatal gate.)
    probe = null;
    shotFrames = 0;
    if (ctx.params.get('freeze') === '1') {
      probe = {
        renderer: ctx.renderer, scene: ctx.scene, camera: ctx.camera,
        rt: new THREE.WebGLRenderTarget(PROBE_W, PROBE_H),
        buf: new Uint8Array(PROBE_W * PROBE_H * 4),
        done: false,
      };
    }
  },

  update(dt, state) {
    tAcc += dt;
    const t = tAcc;

    // compaction → grid shockwave. Skip seek-batches (shot mode fires the
    // whole history in one frame; a stale ring would pollute critic shots).
    const fired = state.fired;
    if (fired.length <= 50) {
      for (let i = 0; i < fired.length; i++) {
        if (fired[i].kind === 'compaction') { pulse = 1; break; }
      }
    }
    pulse *= Math.exp(-dt * 1.9);   // ~2s to imperceptible

    U.uTime.value = t;
    U.uPulse.value = pulse;

    // slow desynchronized breathing across fog, grid, and the rig
    fog.density = FOG_BASE * (1 + 0.05 * Math.sin(t * 0.11));
    U.uFogD.value = fog.density;
    U.uBright.value = 0.9 + 0.1 * Math.sin(t * 0.21);
    keyLight.intensity = 1600 * (1 + 0.07 * Math.sin(t * 0.23));
    rimLight.intensity = 700 * (1 + 0.10 * Math.sin(t * 0.17 + 2.1));
    dome.rotation.y += dt * 0.0016;

    // shot-mode luminance assert — frame 2, after the seek batch has run every
    // module once and cameraRig has locked the preset pose (this module updates
    // first each frame, so frame 1's camera would still be the boot pose).
    if (probe && !probe.done && ++shotFrames >= 2) {
      probe.done = true;
      const { renderer, scene, camera, rt, buf } = probe;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(rt, 0, 0, PROBE_W, PROBE_H, buf);
      renderer.setRenderTarget(prev);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 4)
        sum += 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
      const mean = sum / (PROBE_W * PROBE_H);
      window.__ENV_LUMA = mean;
      if (!(mean >= LUMA_FLOOR)) {
        window.__ENV_LUMA_FAIL = mean;
        console.error(
          `[c-space] environment: LUMA ASSERT — mean scene luminance ` +
          `${mean.toFixed(3)} < ${LUMA_FLOOR} (8-bit linear). The void is ` +
          `showing: grid/fog/skyline emitted no photons at this camera.`);
      }
      // perf audit P2: the probe ran its one frame — free the RT and buffer
      rt.dispose();
      probe.buf = null;
      probe = null;
    }
  },

  resize(_w, h) {
    if (U) U.uVH.value = h * pixelRatio;
  },
};
