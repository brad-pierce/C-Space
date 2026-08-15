// contextStack.js — THE STACK: the context window rendered as a tower of
// hexagonal memory slabs at LAYOUT.towerPos.
//
//   · one slab ≈ 20k tokens; tower height = (ctx / cap) * towerMaxHeight, where
//     cap is the PLAYING SESSION's ceiling (ctx.contextCap, falling back to
//     ctx.CONTEXT_TOKEN_CAP) — a 200k-window Codex session fills the same shaft
//     a 1M Claude session does, instead of reading as an empty plinth
//   · slabs are matte near-black memory hardware — every visible photon is
//     emissive: cyan circuit banding / memory-cell rows on cached slabs, hot
//     magenta seams on the fresh crown, per-slab micro-flicker
//   · epoch banding: each compaction opens a new epoch; the archive hue steps
//     from ice-blue (oldest) toward warm teal (newest) so the session's five
//     epochs read as strata in the stack
//   · axis: a fixed world-space rail (twin hairlines + a 20-division tick
//     ladder, majors on the quarters) with etched uppercase labels RE-DERIVED
//     FROM THE CAP — 250K/500K/750K/1M CEILING on a 1M session,
//     50K/100K/150K/200K CEILING on a 200k one — placed to stand clear of the
//     tower silhouette and sized to read from the tower preset (cam2);
//     hairline gridline rings tie each mark around the shaft
//   · ceiling: the cap is a hexagonal holo-frame (band, corner pylons,
//     gridded plane) that ignites cyan → magenta as the summit approaches
//   · seams: hot magenta gaskets in the slab gaps — the write span (fresh +
//     cacheWrite: tokens written to the window this call) at full boost, then
//     a crown-burn gradient below it (exp falloff from the summit, scaled by
//     fill) so the crown of a near-full tower visibly burns
//   · crown hue (LEGEND r4): the upper-floor hue shift is coded — it means
//     fresh uncached input at the playhead, driven from state.context.fresh,
//     the same channel as the HUD meter tip. No fill-driven blush: a
//     full-but-idle tower stays cyan.
//   · score-lines: each compaction etches a thin pale ring on the shaft at the
//     token height the cut left the tower (first post-compaction context
//     sample) — 5 in the archive session. A scar ignites at the cut, cools to
//     a faint etch within ~2s, and persists as a stratum line as the tower
//     regrows past it; seeking before its compaction removes it.
//   · rim: a subtle fresnel term in the patched slab shader, tinted by the
//     per-instance color, lifts the shaft off the skyline at every preset
//   · compaction: glitch flash (displaced slabs, emissive spike) → the tower
//     sinks while debris shards dissolve upward over ~1.5s; summit beacon kept
//   · pickable (ctx.pick, kind 'slab'): hover card CONTEXT / CACHED / FRESH /
//     COMPACTIONS; hover brightens; ctx.state.filterTool dims the whole rig
//
// Per-instance emissive is driven through instanceColor: a small
// onBeforeCompile patch multiplies totalEmissiveRadiance by vColor and adds a
// vColor-tinted fresnel rim (uRimStrength uniform), so one instanced draw
// carries the epoch strata, magenta crown, rim light, births and glitches.
// All allocation happens in init() (and in reset(), on a session swap only);
// update() is allocation-free.

import * as THREE from 'three';

const SLAB_TOKENS = 20_000;   // tokens per slab
const BIRTH_DUR   = 0.7;      // slab materialize time (s)
const GLITCH_DUR  = 0.12;     // compaction glitch flash (s) — hard hit first 1-2 frames
const COLLAPSE_DUR = 2.0;     // window in which vanishing slabs shed debris (s)
const SHARD_LIFE  = 1.5;      // debris dissolve time (s)
const SHARD_MAX   = 140;      // debris pool
const SEAM_MAX    = 18;       // seam gasket pool (write span + crown burn)
const SCAR_MAX    = 12;       // compaction score-line pool (archive session: 5)
const SCAR_REST   = 0.42;     // resting etch intensity — below the gaskets
const BEAM_H      = 70;       // beacon beam length

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
const fmtTok = (v) => Math.round(v).toLocaleString('en-US');

// The PLAYING session's context ceiling. ctx.contextCap is per-session (a Codex
// session on a 200k window, a Claude one on 1M); CONTEXT_TOKEN_CAP is the
// build-wide fallback for hosts that do not carry a per-session value. Read
// through this everywhere, and RE-READ it in reset() — a swap changes the
// ceiling, and a carried-over cap silently mis-scales the whole tower.
const capOf = (ctx) => Math.max(1, ctx.contextCap ?? ctx.CONTEXT_TOKEN_CAP);

// Axis label text for a token value: 250K, 1M, 1.5M, 50K. Labels are derived
// from the cap, never hardcoded, so the ladder always names the real ceiling.
const fmtAxis = (v) => {
  if (v >= 1e6) { const m = v / 1e6; return (Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)) + 'M'; }
  if (v >= 1000) { const k = v / 1000; return (Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)) + 'K'; }
  return String(Math.round(v));
};

// Fractions of the cap the axis marks (and their gridline rings) sit at. The
// tick ladder below runs 20 divisions, so majors land exactly on these.
const MARK_FRACS = [0.25, 0.5, 0.75, 1.0];

// Everything about the shaft that scales with the ceiling. One slab is always
// SLAB_TOKENS of context, so a smaller cap means fewer, TALLER slabs filling
// the same towerMaxHeight — the shaft reads full at the session's own ceiling.
function towerMetrics(cap, LAYOUT) {
  const slabs = cap / SLAB_TOKENS;
  const STEP = LAYOUT.towerMaxHeight / slabs;
  return { MAX_SLABS: Math.ceil(slabs) + 2, STEP, SLAB_H: STEP * 0.84 };
}

// Multiply the emissive term by the per-instance color so one instanced mesh
// can hold epoch strata, hot fresh slabs, births and glitch spikes.
// NOTE (r185): in the FRAGMENT stage three defines USE_COLOR — not
// USE_INSTANCING_COLOR — when instance colors are present, and vColor is a
// vec4 there. Guard on USE_COLOR and swizzle .rgb, or the tint silently
// compiles out and the tower renders as untinted white stripes.
// The same patch adds a fresnel rim tinted by the instance color (so births
// stay dark, the magenta crown rims magenta, and filter-dim carries through) —
// it lifts the shaft off the skyline at every preset. uRimStrength is a shared
// uniform ref updated once per frame in update().
function patchInstancedEmissive(mat, rimU) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimStrength = rimU;
    shader.fragmentShader = 'uniform float uRimStrength;\n' + shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )\n\ttotalEmissiveRadiance *= vColor.rgb;\n\ttotalEmissiveRadiance += vColor.rgb * uRimStrength * pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), 2.5 );\n#endif'
    );
  };
}

// --- canvas textures (grayscale masks; color arrives via emissive tint) -----

function makeSideTexture(rng) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#000000'; g.fillRect(0, 0, 256, 128);        // dead-black base — matte hardware
  g.fillStyle = 'rgba(255,255,255,0.07)';                     // faint scanlines
  for (let y = 2; y < 128; y += 4) g.fillRect(0, y, 256, 1);
  g.fillStyle = 'rgba(255,255,255,0.3)';                      // bus lines — banding
  for (const y of [18, 44, 74, 110]) g.fillRect(0, y, 256, 1);
  for (let row = 0; row < 3; row++) {                         // memory-cell rows —
    const y = 30 + row * 26;                                  // ~10% burn as lit
    for (let x = 4; x < 252; x += 10) {                       // windows in the night
      const r = rng();
      const a = r < 0.1 ? 0.85 + rng() * 0.15 : r < 0.68 ? 0.24 + rng() * 0.4 : 0.06;
      g.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      g.fillRect(x, y, 6, 4);
    }
  }
  for (let i = 0; i < 20; i++) {                              // manhattan traces
    let x = rng() * 256, y = 16 + rng() * 92;
    const a = 0.08 + rng() * 0.2;
    g.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`;
    g.lineWidth = rng() < 0.25 ? 2 : 1;
    g.beginPath(); g.moveTo(x, y);
    const segs = 2 + ((rng() * 3) | 0);
    for (let s = 0; s < segs; s++) {
      if (s % 2 === 0) x += (rng() - 0.5) * 90; else y += (rng() - 0.5) * 40;
      g.lineTo(x, y);
    }
    g.stroke();
    g.fillStyle = `rgba(255,255,255,${Math.min(1, a * 3).toFixed(3)})`;
    g.fillRect(x - 1.5, y - 1.5, 3, 3);                       // terminal pad
  }
  g.fillStyle = 'rgba(255,255,255,0.5)';                      // vias
  for (let i = 0; i < 26; i++) g.fillRect(rng() * 256, 12 + rng() * 104, 1.5, 1.5);
  g.fillStyle = 'rgba(255,255,255,0.28)';                     // restrained edge rules —
  g.fillRect(0, 0, 256, 2);                                   // the magenta seam gaskets
  g.fillStyle = 'rgba(255,255,255,0.12)';                     // own the between-slab glow
  g.fillRect(0, 126, 256, 2);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping; t.repeat.set(3, 1);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

function makeCapTexture(rng) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#000000'; g.fillRect(0, 0, 128, 128);
  g.translate(64, 64);
  for (let r = 12; r <= 60; r += 12) {                        // concentric hexes
    g.strokeStyle = `rgba(255,255,255,${r === 60 ? 0.7 : 0.16})`;
    g.lineWidth = r === 60 ? 2.5 : 1;
    g.beginPath();
    for (let k = 0; k <= 6; k++) {
      const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
      k ? g.lineTo(Math.cos(a) * r, Math.sin(a) * r) : g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.closePath(); g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1;  // spokes
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    g.beginPath(); g.moveTo(Math.cos(a) * 10, Math.sin(a) * 10);
    g.lineTo(Math.cos(a) * 58, Math.sin(a) * 58); g.stroke();
  }
  for (let i = 0; i < 20; i++) {                              // pads
    const a = rng() * Math.PI * 2, r = 14 + rng() * 42;
    g.fillStyle = `rgba(255,255,255,${(0.15 + rng() * 0.3).toFixed(3)})`;
    g.fillRect(Math.cos(a) * r - 1.5, Math.sin(a) * r - 1.5, 3, 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeTickTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.translate(128, 128);
  for (let i = 0; i < 96; i++) {                              // tick dial — numeric feel, no text
    const a = (i / 96) * Math.PI * 2;
    const major = i % 8 === 0;
    const r0 = major ? 96 : 106, r1 = 118;
    g.strokeStyle = `rgba(255,255,255,${major ? 0.9 : 0.4})`;
    g.lineWidth = major ? 3 : 1.5;
    g.beginPath(); g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1.5;
  g.beginPath(); g.arc(0, 0, 120, 0, Math.PI * 2); g.stroke();
  return new THREE.CanvasTexture(c);
}

function makeBeamTexture() {
  const c = document.createElement('canvas'); c.width = 32; c.height = 256;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 256, 0, 0);            // bright at beam base
  gr.addColorStop(0, 'rgba(255,255,255,0.95)');
  gr.addColorStop(0.25, 'rgba(255,255,255,0.42)');
  gr.addColorStop(0.7, 'rgba(255,255,255,0.10)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 32, 256);
  return new THREE.CanvasTexture(c);
}

// etched uppercase axis label: tick dash + value, tinted cyan by the material.
// Sized for the tower preset (cam2, ~37u out): sprite renders ~1080p 25px tall.
function makeLabelTexture(text) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 64);
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillRect(2, 30, 18, 3);
  g.font = '600 38px Consolas, "Courier New", monospace';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(255,255,255,0.96)';
  g.fillText(text.toUpperCase(), 30, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------

let S = null; // module state bag — filled in init()

function spawnShards(count, y0, y1) {
  for (let j = 0; j < count; j++) {
    const i = S.shardCursor; S.shardCursor = (i + 1) % SHARD_MAX;
    const k = i * 3;
    const a = S.rng() * Math.PI * 2;
    const r = 0.5 + S.rng() * (S.R - 0.5);
    S.pos[k] = Math.cos(a) * r;
    S.pos[k + 1] = y0 + S.rng() * Math.max(0.01, y1 - y0);
    S.pos[k + 2] = Math.sin(a) * r;
    S.vel[k] = Math.cos(a) * (0.2 + S.rng() * 0.6);
    S.vel[k + 1] = 1.0 + S.rng() * 2.0;                       // debris drifts upward
    S.vel[k + 2] = Math.sin(a) * (0.2 + S.rng() * 0.6);
    S.life[i] = SHARD_LIFE * (0.7 + S.rng() * 0.45);
  }
}

// one fresh seam gasket: a thin hot ring at height y, pulsing, glitch-aware
function placeSeam(i, y, boost, now, gn, dimHov) {
  let I = (0.95 + 0.22 * Math.sin(now * 5.3 + y * 2.1)
             + 0.06 * Math.sin(now * 19 + y * 7.3)) * boost * dimHov;
  let px = 0, pz = 0;
  if (gn > 0) {
    px = (S.rng() - 0.5) * 0.5 * gn;
    pz = (S.rng() - 0.5) * 0.5 * gn;
    I *= 1 + 1.6 * gn;
  }
  S.tmpPos.set(px, y, pz);
  S.tmpScale.set(1, 1, 1);
  S.tmpMat.compose(S.tmpPos, S.quatI, S.tmpScale);
  S.seams.setMatrixAt(i, S.tmpMat);
  S.seams.setColorAt(i, S.tmpColor.copy(S.C_FRESH).lerp(S.C_HOT, gn * 0.5).multiplyScalar(I));
}

// token height the tower was cut down to by the compaction at vt: the first
// context sample past the event (both Timeline flavors materialize .vt on the
// curve). Returns -1 while no post-compaction sample exists yet (live mode).
function scarTroughY(vt) {
  const c = S.ctx.timeline.ctxCurve;
  if (!c.length || c[c.length - 1].vt <= vt) return -1;
  let lo = 0, hi = c.length - 1;
  if (c[0].vt > vt) hi = 0;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (c[mid].vt <= vt) lo = mid; else hi = mid;
  }
  return clamp01((c[hi].ctx || 0) / S.cap) * S.maxH;
}

// --- session-shaped meshes: build / teardown --------------------------------
// SESSION SWAP (see the contract in main.js): the three instanced meshes built
// here are the only GPU objects in this module whose CONTENTS are the session —
// the slab tower (height, epoch strata, births), the seam gaskets + compaction
// score-lines, and the collapse debris. init() and reset() both go through
// buildTower(), so there is exactly one build path; reset() tears the previous
// set down with disposeTower() first.
//
// KEPT across a swap, deliberately: the canvas masks (S.sideTex/S.capTex and
// the tick/beam textures baked into their materials — seeded, static,
// byte-identical for every session), the group / pickGrp / follower rig, the
// ceiling holo-frame, the axis rail + label SPRITES, and the plinth. Every one
// of those is sized as a FRACTION of LAYOUT.towerMaxHeight, never from session
// data or the cap, so rebuilding them would re-rasterize canvases and recompile
// shaders to produce the same objects. (The label sprites are kept but
// re-etched: their text is the one cap-dependent thing on the axis, and
// setAxisLabels repaints those four canvases in place.) The pick registration rides pickGrp, which stays attached
// to ctx.scene — main.js's orphan prune leaves it alone and no re-register is
// needed (the hover card closes over module-scope S, so it reads fresh numbers).
function buildTower() {
  const { PALETTE } = S.ctx;
  const { R, MAX_SLABS, SLAB_H } = S;

  // --- memory slabs (one instanced mesh, 3 material groups) ---
  // Matte near-black hardware: low metalness, high roughness — the circuit
  // texture is the only light the slab emits.
  const sideMat = new THREE.MeshStandardMaterial({
    color: PALETTE.coreShell, metalness: 0.15, roughness: 0.85, flatShading: true,
    emissive: 0xffffff, emissiveIntensity: 1.3, emissiveMap: S.sideTex,
    envMapIntensity: 0.2,
  });
  const slabCapMat = new THREE.MeshStandardMaterial({
    color: PALETTE.coreShell, metalness: 0.15, roughness: 0.8, flatShading: true,
    emissive: 0xffffff, emissiveIntensity: 0.6, emissiveMap: S.capTex,
    envMapIntensity: 0.2,
  });
  patchInstancedEmissive(sideMat, S.uRim);      // S.uRim outlives a swap, so the
  patchInstancedEmissive(slabCapMat, S.uRim);   // rebuilt shaders share the ref
  const slabs = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(R, R, SLAB_H, 6, 1, false),
    [sideMat, slabCapMat, slabCapMat], MAX_SLABS);
  slabs.frustumCulled = false;
  slabs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < MAX_SLABS; i++) {
    slabs.setMatrixAt(i, S.zeroMat);
    slabs.setColorAt(i, S.C_CACHE);                          // allocates instanceColor pre-render
  }
  slabs.count = 0;
  S.pickGrp.add(slabs);
  S.slabs = slabs;
  S.slabMats = [sideMat, slabCapMat];   // the UNIQUE set — slabCapMat binds twice

  // --- fresh seam gaskets: thin hot magenta rings in the slab gaps of the
  // write span; the lowest rides the cache/write boundary. These carry the
  // magenta narrative — the cache mass itself stays cold cyan.
  // The tail SCAR_MAX instances of the same mesh are the compaction
  // score-lines (thinner y-scale, pale etch color): one draw call for both.
  S.seamMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const seams = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(R + 0.05, R + 0.05, 0.07, 6, 1, true), S.seamMat, SEAM_MAX + SCAR_MAX);
  seams.frustumCulled = false;
  seams.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < SEAM_MAX + SCAR_MAX; i++) { seams.setMatrixAt(i, S.zeroMat); seams.setColorAt(i, S.C_FRESH); }
  S.group.add(seams);
  S.seams = seams;

  // --- debris shards (compaction fallout, dissolving upward) ---
  S.shardMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const shards = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(0.2, 0), S.shardMat, SHARD_MAX);
  shards.frustumCulled = false;
  shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < SHARD_MAX; i++) { shards.setMatrixAt(i, S.zeroMat); shards.setColorAt(i, S.tmpColor.setScalar(0)); }
  S.group.add(shards);
  S.shards = shards;
}

// Detach the session-shaped meshes and free EVERY GPU resource they own:
// geometry, the unique materials, and — through InstancedMesh.dispose(), which
// the renderer listens for — the instanceMatrix / instanceColor VBOs. Skipping
// that last one is exactly the leak that compounds over an hours-long attract
// run (52 + 30 + 140 instances of matrix/color buffers per swap).
// Textures are intentionally NOT disposed: they are shared and static, reused
// by the next buildTower() (material.dispose() never touches its maps).
function disposeTower() {
  for (const mesh of [S.slabs, S.seams, S.shards]) {
    if (!mesh) continue;
    mesh.parent?.remove(mesh);
    mesh.geometry.dispose();
    mesh.dispose();
  }
  for (const mat of [...(S.slabMats ?? []), S.seamMat, S.shardMat]) mat?.dispose();
  S.slabs = null; S.seams = null; S.shards = null;
  S.slabMats = null; S.seamMat = null; S.shardMat = null;
}

// Re-scale the shaft to a (possibly new) ceiling. Called from reset() BEFORE
// buildTower(), because MAX_SLABS is the instance count of the slab mesh and
// SLAB_H is baked into its geometry. The per-slab pools are indexed by slab
// number, so they are reallocated only when the slab count actually moves —
// swapping between two sessions on the same window costs nothing.
function resizeForCap(cap) {
  const m = towerMetrics(cap, S.ctx.LAYOUT);
  S.cap = cap;
  S.STEP = m.STEP;
  S.SLAB_H = m.SLAB_H;
  if (m.MAX_SLABS !== S.MAX_SLABS) {
    S.MAX_SLABS = m.MAX_SLABS;
    S.birth = new Float32Array(m.MAX_SLABS).fill(-BIRTH_DUR);
    S.epoch = new Uint8Array(m.MAX_SLABS);
    S.hash = new Float32Array(m.MAX_SLABS);
    for (let i = 0; i < m.MAX_SLABS; i++) S.hash[i] = S.rng();
  }
}

// Re-etch the axis labels for a ceiling. Sprite POSITIONS are fractions of
// towerMaxHeight and never move; only the text changes, so this repaints the
// four canvases in place and disposes the textures it replaces. The topmost
// mark carries the CEILING suffix and is the one update() tints with warn.
function setAxisLabels(cap) {
  for (let i = 0; i < S.labelMats.length; i++) {
    const f = MARK_FRACS[i] ?? 1;
    const text = fmtAxis(cap * f) + (f >= 1 ? ' CEILING' : '');
    const mat = S.labelMats[i];
    if (mat.userData.labelText === text) continue;
    mat.userData.labelText = text;
    mat.map?.dispose();
    mat.map = makeLabelTexture(text);
    mat.needsUpdate = true;
  }
}

export default {
  name: 'contextStack',

  init(ctx) {
    const { PALETTE, LAYOUT } = ctx;
    const texRng = mulberry32(0xC0FFEE);

    // The session's own ceiling, not the build-wide constant (see capOf).
    const cap = capOf(ctx);
    const { MAX_SLABS, STEP, SLAB_H } = towerMetrics(cap, LAYOUT);  // 52 / 0.52 on a 1M cap
    const R = LAYOUT.towerRadius;

    S = {
      ctx, rng: mulberry32(0x5EED),
      MAX_SLABS, STEP, SLAB_H, R,
      maxH: LAYOUT.towerMaxHeight, cap,
      time: 0, h: 0, prevN: 0, first: true,
      glitch: 0, collapse: 0, flash: 0, lastComp: -10,
      shardCursor: 0,
      dim: 1, hovered: false, hoverF: 0,
      cardCtx: 0, cardCached: 0, cardFresh: 0, cardWrites: 0, cardComps: 0,
      // compaction score-lines: trough heights resolved lazily (live mode may
      // not have the post-compaction sample yet), etched once known
      scarY: new Float32Array(SCAR_MAX).fill(-1),
      scarVt: new Float32Array(SCAR_MAX),
      scarKnown: 0, scarOn: new Uint8Array(SCAR_MAX),
      // upload gating (perf audit contextStack.js:701): dead slots zero once
      seamPrevSi: 0, seamsWasLive: true, shardsWasLive: true,
      uRim: { value: 0.55 },                                  // shared fresnel-rim uniform
      // scratch (allocation-free update loop)
      tmpMat: new THREE.Matrix4(), tmpPos: new THREE.Vector3(),
      tmpScale: new THREE.Vector3(), tmpQ: new THREE.Quaternion(),
      tmpEuler: new THREE.Euler(), tmpColor: new THREE.Color(),
      zeroMat: new THREE.Matrix4().makeScale(0, 0, 0),
      C_CACHE: new THREE.Color(PALETTE.cache),
      C_FRESH: new THREE.Color(PALETTE.fresh),
      C_HOT: new THREE.Color(PALETTE.coreHot),
      quatI: new THREE.Quaternion(),                          // uniform orientation — no coil twist
      birth: new Float32Array(MAX_SLABS).fill(-BIRTH_DUR),
      hash: new Float32Array(MAX_SLABS),
      epoch: new Uint8Array(MAX_SLABS),                       // compaction epoch per slab
      pos: new Float32Array(SHARD_MAX * 3), vel: new Float32Array(SHARD_MAX * 3),
      life: new Float32Array(SHARD_MAX), spin: new Float32Array(SHARD_MAX * 3),
      tint: new Float32Array(SHARD_MAX),
    };
    for (let i = 0; i < MAX_SLABS; i++) S.hash[i] = S.rng();
    for (let i = 0; i < SHARD_MAX; i++) {
      S.spin[i * 3] = 1 + S.rng() * 4; S.spin[i * 3 + 1] = 1 + S.rng() * 4;
      S.spin[i * 3 + 2] = S.rng() * Math.PI * 2;
      S.tint[i] = i % 5 === 0 ? 0.7 : S.rng() * 0.2;          // mostly cyan, some magenta embers
    }

    // Epoch strata palette: oldest archive is coldest (ice blue), each
    // compaction epoch steps warmer toward teal with a whisper of magenta.
    S.C_EPOCH = [];
    const cIce = new THREE.Color(PALETTE.coreEnergy);
    for (let e = 0; e < 8; e++) {
      const c = cIce.clone().lerp(S.C_CACHE, Math.min(1, e * 0.25));
      c.lerp(S.C_FRESH, Math.min(0.1, e * 0.02));   // whisper only — cache stays cyan
      S.C_EPOCH.push(c);
    }

    const group = new THREE.Group();
    group.position.set(...LAYOUT.towerPos);
    group.rotation.y = Math.PI / 7;
    ctx.scene.add(group);
    S.group = group;

    // Pickable sub-tree: slabs + plinth (kept clear of beam/rings/shards so
    // the hover target is the tower itself, not a 70-unit beam of sky).
    const pickGrp = new THREE.Group();
    group.add(pickGrp);
    S.pickGrp = pickGrp;

    // Canvas masks for the slabs: seeded from a fixed RNG and sized by nothing
    // session-shaped, so they are built ONCE here and reused by every
    // buildTower() — including the one in reset(). capTex is also the ceiling
    // plane's and the plinth's map. Never disposed while the module lives.
    S.sideTex = makeSideTexture(texRng);
    S.capTex = makeCapTexture(texRng);

    // The session-shaped meshes (slabs · seams + score-lines · debris). reset()
    // calls the same builder after disposing the previous set — one build path.
    buildTower();

    // --- follower rig: measuring rings + beacon + top light track the summit ---
    const follow = new THREE.Group();
    group.add(follow);
    S.follow = follow;

    S.ringMat = new THREE.MeshBasicMaterial({
      color: PALETTE.cache, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const ringSpin = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.95, 0.035, 6, 72), S.ringMat);
    ring.rotation.x = -Math.PI / 2;
    ringSpin.add(ring); follow.add(ringSpin);
    S.ringSpin = ringSpin;

    S.tickMat = new THREE.MeshBasicMaterial({
      map: makeTickTexture(), color: PALETTE.cache, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const tickSpin = new THREE.Group();
    const tick = new THREE.Mesh(new THREE.RingGeometry(3.4, 4.7, 64), S.tickMat);
    tick.rotation.x = -Math.PI / 2;
    tickSpin.add(tick); follow.add(tickSpin);
    S.tickSpin = tickSpin;

    S.beamMat = new THREE.MeshBasicMaterial({
      map: makeBeamTexture(), color: PALETTE.cache, transparent: true, opacity: 0.1,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 1.05, BEAM_H, 12, 1, true), S.beamMat);
    beam.position.y = BEAM_H / 2 + 0.2;
    follow.add(beam);
    S.beam = beam;

    S.topLight = new THREE.PointLight(PALETTE.cache, 90, 42, 2);
    S.topLight.position.y = 1.0;
    follow.add(S.topLight);

    // --- the ceiling: a faint hexagonal holo-frame the tower climbs toward.
    // It sits at towerMaxHeight — the TOP OF THE SHAFT, whatever the cap is —
    // so it needs no rescale on a swap; only the axis label naming it does.
    // Band + hairline edges + corner pylons + gridded cap plane; ignites
    // cyan → magenta as the summit closes in (warn, in update). Corners share
    // the slab hex azimuths so frame and tower read as one machined part.
    const ceil = new THREE.Group();
    ceil.position.y = LAYOUT.towerMaxHeight;
    group.add(ceil);
    S.capMat = new THREE.MeshBasicMaterial({
      color: PALETTE.cache, transparent: true, opacity: 0.1,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    ceil.add(new THREE.Mesh(new THREE.CylinderGeometry(4.05, 4.05, 0.22, 6, 1, true), S.capMat));
    const hexPts = [];                        // top + bottom hex outlines, one draw
    for (let e = 0; e < 2; e++) {
      const y = e ? 0.11 : -0.11;
      for (let k = 0; k < 6; k++) {
        const a0 = (k / 6) * Math.PI * 2, a1 = ((k + 1) / 6) * Math.PI * 2;
        hexPts.push(
          new THREE.Vector3(Math.sin(a0) * 4.05, y, Math.cos(a0) * 4.05),
          new THREE.Vector3(Math.sin(a1) * 4.05, y, Math.cos(a1) * 4.05));
      }
    }
    S.ceilLineMat = new THREE.LineBasicMaterial({
      color: PALETTE.cache, transparent: true, opacity: 0.32,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    ceil.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(hexPts), S.ceilLineMat));
    S.postMat = new THREE.MeshBasicMaterial({
      color: PALETTE.cache, transparent: true, opacity: 0.22,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const posts = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.022, 0.022, 0.95, 4, 1), S.postMat, 6);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      S.tmpPos.set(Math.sin(a) * 4.05, -0.585, Math.cos(a) * 4.05);
      S.tmpScale.set(1, 1, 1);
      S.tmpMat.compose(S.tmpPos, S.quatI, S.tmpScale);
      posts.setMatrixAt(k, S.tmpMat);
    }
    ceil.add(posts);
    S.ceilPlaneMat = new THREE.MeshBasicMaterial({
      map: S.capTex, color: PALETTE.cache, transparent: true, opacity: 0.05,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const ceilPlane = new THREE.Mesh(new THREE.CircleGeometry(4.02, 6, -Math.PI / 2), S.ceilPlaneMat);
    ceilPlane.rotation.x = -Math.PI / 2;      // z-spin in update = holo shimmer
    ceil.add(ceilPlane);
    S.ceilPlane = ceilPlane;

    // --- axis: fixed world-space rail + gridline rings, sized for cam2 ---
    // Twin vertical hairlines with a 20-division tick ladder (majors on the
    // quarters, i.e. every cap/4) and etched labels whose TEXT is derived from
    // the cap by setAxisLabels — the geometry below is fraction-of-height only,
    // so it is identical for every ceiling and survives a session swap
    // untouched. The rail direction is biased between the tower shot
    // (cam2 at world -40,13,14) and the origin so it stands clear of the
    // tower silhouette from cam2 and the ticks/labels run toward screen-right
    // over the void, not across the slab face.
    const axis = new THREE.Group();
    group.add(axis);
    const ringPts = [];
    for (let k = 0; k <= 72; k++) {
      const a = (k / 72) * Math.PI * 2;
      ringPts.push(new THREE.Vector3(Math.cos(a) * (R + 0.5), 0, Math.sin(a) * (R + 0.5)));
    }
    const ringGeo = new THREE.BufferGeometry().setFromPoints(ringPts);
    S.axisMat = new THREE.LineBasicMaterial({
      color: PALETTE.cache, transparent: true, opacity: 0.26,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const yUp = new THREE.Vector3(0, 1, 0);
    const toCam2 = new THREE.Vector3(-40 - LAYOUT.towerPos[0], 0, 14 - LAYOUT.towerPos[2]).normalize();
    const toOrigin = new THREE.Vector3(-LAYOUT.towerPos[0], 0, -LAYOUT.towerPos[2]).normalize();
    const railDir = toCam2.lerp(toOrigin, 0.6).normalize().applyAxisAngle(yUp, -group.rotation.y);
    const perp = new THREE.Vector3(railDir.z, 0, -railDir.x);  // ≈ screen-right from cam2
    const RAIL_R = R + 1.45;
    const rp = (s, y) => new THREE.Vector3(
      railDir.x * RAIL_R + perp.x * s, y, railDir.z * RAIL_R + perp.z * s);
    const railPts = [];
    railPts.push(rp(0, 0.55), rp(0, LAYOUT.towerMaxHeight + 0.11));         // main rail
    railPts.push(rp(-0.14, 0.55), rp(-0.14, LAYOUT.towerMaxHeight + 0.11)); // twin hairline
    for (let k = 1; k <= 20; k++) {                            // cap/20 minors, cap/4 majors
      const y = (k / 20) * LAYOUT.towerMaxHeight;
      railPts.push(rp(0, y), rp(k % 5 === 0 ? 0.62 : 0.26, y));
    }
    S.railMat = new THREE.LineBasicMaterial({
      color: PALETTE.cache, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    axis.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(railPts), S.railMat));
    S.labelMats = [];
    for (const f of MARK_FRACS) {
      if (f < 1) {                                            // hairline gridline ring
        const line = new THREE.LineLoop(ringGeo, S.axisMat);
        line.position.y = f * LAYOUT.towerMaxHeight;
        axis.add(line);
      }
      const sMat = new THREE.SpriteMaterial({
        map: null, color: PALETTE.cache, transparent: true,
        opacity: 0.8, depthWrite: false, fog: false,
      });
      const spr = new THREE.Sprite(sMat);
      spr.position.copy(rp(0.78, f * LAYOUT.towerMaxHeight));
      spr.scale.set(3.9, 0.975, 1);
      spr.center.set(0, 0.5);                                 // anchor at the tick dash
      axis.add(spr);
      S.labelMats.push(sMat);
    }
    setAxisLabels(cap);   // etches the ladder for THIS session's ceiling

    // --- plinth grounding the tower ---
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(4.35, 4.75, 0.62, 6, 1),
      new THREE.MeshStandardMaterial({
        color: PALETTE.coreShell, metalness: 0.25, roughness: 0.75, flatShading: true,
        emissive: PALETTE.cache, emissiveIntensity: 0.22, emissiveMap: S.capTex,
        envMapIntensity: 0.2,
      })
    );
    plinth.position.y = 0.31;
    pickGrp.add(plinth);
    S.trimMat = new THREE.MeshBasicMaterial({
      color: PALETTE.cache, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const trim = new THREE.Mesh(new THREE.CylinderGeometry(4.42, 4.42, 0.07, 6, 1, true), S.trimMat);
    trim.position.y = 0.6;
    group.add(trim);

    // --- interaction: the tower is one pickable surface ---
    ctx.pick.register(pickGrp, {
      kind: 'slab',
      recursive: true,
      debugKey: 'tower',
      card: () => ({
        title: 'CONTEXT WINDOW',
        lines: [
          ['CONTEXT', `${fmtTok(S.cardCtx)} · ${(S.cardCtx / S.cap * 100).toFixed(1)}%`],
          ['HEADROOM', fmtTok(Math.max(0, S.cap - S.cardCtx))],
          ['CACHED', fmtTok(S.cardCached)],
          ['FRESH', fmtTok(S.cardFresh)],
          ['WRITES', fmtTok(S.cardWrites)],
          ['COMPACTIONS', String(S.cardComps)],
        ],
      }),
      onHover: (hit) => { S.hovered = !!hit; },
    });
  },

  // IN-PLACE SESSION SWAP (contract in main.js). ctx.session / ctx.timeline are
  // already the new session when this runs, the frame loop is idled, and nothing
  // is drawn until it returns — so this is the one safe place to dispose.
  //
  // Three jobs. (0) RE-READ THE CEILING. ctx.contextCap is per-session, so a
  // swap can move it (200k Codex → 1M Claude and back). Everything downstream
  // of the cap is re-derived here: the slab metrics (resizeForCap — MAX_SLABS
  // is the mesh's instance count and SLAB_H is baked into its geometry, so this
  // MUST run before buildTower) and the axis label ladder (setAxisLabels).
  // Carrying the old cap would leave the tower and its axis lying about the
  // window the session actually ran in.
  // (1) Rebuild the session-shaped meshes: disposeTower() then
  // buildTower(), which also re-zeroes every instance slot. That matters beyond
  // hygiene — the seam mesh draws all SEAM_MAX + SCAR_MAX instances every frame
  // and update() only zeroes a slot on the frame it goes dark, so the previous
  // session's score-lines and write gaskets would otherwise hang in the air
  // until (and unless) something overwrote them.
  // (2) Clear the eased / cursor state. Everything below is either a smoothed
  // value that must not lerp from the old session (height above all — with
  // first=true the next frame SNAPS to the new session's height instead of
  // sliding down from the old one) or a walked cursor into session data
  // (prevN, the epoch/birth pools, the scar prefix state, the shard pool).
  // Nothing here reads ctx.timeline: heights and epochs are re-derived from the
  // new curve on the next update(), and scarY is resolved lazily as before.
  reset(ctx) {
    if (!S) return;             // init never completed — nothing to swap
    S.ctx = ctx;                // rebind rather than trust the captured ref

    const cap = capOf(ctx);     // per-session ceiling — never the boot-time one
    resizeForCap(cap);          // before buildTower: it reads MAX_SLABS / SLAB_H
    setAxisLabels(cap);

    disposeTower();
    buildTower();

    // eased / smoothed visual state
    S.time = 0; S.h = 0; S.first = true;
    S.glitch = 0; S.collapse = 0; S.flash = 0; S.lastComp = -10;
    S.dim = 1; S.hovered = false; S.hoverF = 0;
    S.uRim.value = 0.55;

    // per-slab pools (birth clock and epoch strata are re-seeded on the first
    // frame's seeded-growth branch; prevN must start at 0 or that never fires)
    S.prevN = 0;
    S.birth.fill(-BIRTH_DUR);
    S.epoch.fill(0);

    // compaction score-lines: the old troughs were resolved against the old
    // ctxCurve and the old compaction list — every one of them is wrong now
    S.scarY.fill(-1); S.scarVt.fill(0); S.scarKnown = 0; S.scarOn.fill(0);

    // debris pool + the upload-gating flags for the freshly zeroed meshes
    S.life.fill(0); S.shardCursor = 0;
    S.seamPrevSi = 0; S.seamsWasLive = true; S.shardsWasLive = true;

    // hover-card numbers (update() refills them on the next frame)
    S.cardCtx = 0; S.cardCached = 0; S.cardFresh = 0; S.cardWrites = 0; S.cardComps = 0;
  },

  update(dt, state) {
    if (!S) return;
    const now = (S.time += dt);
    const { STEP, SLAB_H, maxH } = S;
    const cx = state.context;
    const target = clamp01((cx.ctx || 0) / S.cap) * maxH;

    // Compaction count at the playhead — drives epoch assignment + hover card.
    const comps = S.ctx.timeline.compactions;
    let cc = 0;
    for (let i = 0; i < comps.length; i++) if (comps[i].vt <= state.vt) cc++;

    // Hard seeks (boot / shot-mode catch-up) snap instead of animating.
    if (S.first || state.fired.length > 60) { S.h = target; S.first = false; }

    // Compaction events → glitch flash + collapse window. Events arrive in
    // near-duplicate pairs, so dedupe within 0.3s; on batch seeks only a
    // compaction within 1.5s of the playhead still fires its flourish.
    for (let i = 0; i < state.fired.length; i++) {
      const e = state.fired[i];
      if (e.kind !== 'compaction') continue;
      if (state.vt - S.ctx.timeline.realToVt(e.t) > 1.5) continue;
      if (now - S.lastComp < 0.3) continue;
      S.lastComp = now;
      S.glitch = GLITCH_DUR;
      S.collapse = COLLAPSE_DUR;
      S.flash = 1;
      spawnShards(24, Math.max(0.5, S.h * 0.65), S.h + 1.5);
    }

    // Height follows the interpolated curve: quick on growth, a heavy
    // ~1.5-2s sink while a collapse is active.
    const rate = target >= S.h ? 5.0 : (S.collapse > 0 ? 2.0 : 3.2);
    S.h += (target - S.h) * Math.min(1, dt * rate);
    if (Math.abs(target - S.h) < 0.002) S.h = target;
    const fill = S.h / maxH;

    // --- slab bookkeeping ---
    const n = S.h > 0.02 ? Math.min(S.MAX_SLABS, Math.max(1, Math.ceil(S.h / STEP))) : 0;
    if (n > S.prevN) {
      const seeded = n - S.prevN > 4;                          // seek, not growth
      for (let i = S.prevN; i < n; i++) {
        S.birth[i] = seeded ? now - BIRTH_DUR : now;
        S.epoch[i] = cc;                                       // born into the current epoch
      }
      if (seeded) {                                            // seek: reconstruct strata —
        for (let i = 0; i < n; i++)                            // older content sits lower
          S.epoch[i] = Math.min(cc, ((i / n) * (cc + 1)) | 0);
      }
    } else if (n < S.prevN && S.collapse > 0) {
      for (let i = n; i < S.prevN; i++)                        // each lost slab sheds debris
        spawnShards(3, i * STEP, i * STEP + SLAB_H);
    }
    S.prevN = n;

    // Interaction state: hover brightens, tool filter dims the whole rig.
    S.hoverF += ((S.hovered ? 1 : 0) - S.hoverF) * Math.min(1, dt * 10);
    const dimT = S.ctx.state.filterTool ? 0.4 : 1;
    S.dim += (dimT - S.dim) * Math.min(1, dt * 5);
    const dim = S.dim;
    const hov = 1 + 0.24 * S.hoverF;

    const gn = S.glitch > 0 ? (S.glitch / GLITCH_DUR) * (S.glitch / GLITCH_DUR) : 0;
    // Two coded channels (LEGEND r4): the slab-body hue shift means fresh
    // uncached input ONLY — state.context.fresh, the HUD meter-tip channel.
    // The seam gaskets carry the write span: tokens entering the window this
    // call (fresh + cacheWrite).
    const freshSlab = cx.fresh || 0;
    const writeTok = freshSlab + (cx.cacheWrite || 0);
    const freshStart = S.h - (freshSlab / S.cap) * maxH;
    const writeStart = S.h - (writeTok / S.cap) * maxH;
    const fillBurn = sstep((fill - 0.35) / 0.55);              // fullness → crown burn
    const scanY = ((now * 2.6) % (maxH + 10)) - 5;             // slow refresh sweep

    // hover-card data (read lazily by ctx.pick card fn)
    S.cardCtx = cx.ctx || 0;
    S.cardCached = cx.cacheRead || 0;
    S.cardFresh = freshSlab;
    S.cardWrites = cx.cacheWrite || 0;
    S.cardComps = cc;

    for (let i = 0; i < n; i++) {
      const yBase = i * STEP + (STEP - SLAB_H) * 0.5;
      const isTop = i === n - 1;
      const frac = isTop ? Math.max(0.12, Math.min(1, (S.h - (n - 1) * STEP) / STEP)) : 1;

      // birth: rise + fade-in
      const bf = clamp01((now - S.birth[i]) / BIRTH_DUR);
      const be = 1 - (1 - bf) * (1 - bf) * (1 - bf);
      const sxz = 0.88 + 0.12 * be;
      let px = 0, pz = 0;
      let py = yBase + SLAB_H * frac * 0.5 - (1 - be) * 1.2;

      // fresh crown (LEGEND r4): overlap of this slab with the span of fresh
      // uncached input — state.context.fresh only, matching the HUD legend
      // key. Near-zero in the archive session (fresh peaks at ~1.3k tokens);
      // a live paste of fresh input ignites the crown. The former fill-driven
      // recency blush was an uncoded variable and is removed.
      const slabTop = i * STEP + STEP * frac;
      let mix = clamp01((slabTop - freshStart) / STEP);
      if (isTop) mix = Math.max(mix, 0.55 * sstep(Math.min(1, freshSlab / 8000)));
      mix = sstep(mix);

      // emissive drive: epoch base hue + breathing + scan sweep + micro-flicker
      const yC = yBase + SLAB_H * 0.5;
      const d = yC - scanY;
      const cacheI = 0.58 + 0.22 * S.hash[i]
        + 0.1 * Math.sin(now * 0.8 - yC * 0.5)                 // breathing
        + 0.5 * Math.exp(-d * d * 1.4);                        // scan sweep
      const freshI = 1.35 + 0.18 * Math.sin(now * 7 + i * 2.1) + 0.08 * Math.sin(now * 23 + i * 13.7);
      const mf = 1 + 0.07 * Math.sin(now * (14 + 21 * S.hash[i]) + i * 5.7)
                     * (0.5 + 0.5 * Math.sin(now * 1.7 + S.hash[i] * 9));
      let I = (cacheI + (freshI - cacheI) * mix) * (0.05 + 0.95 * be) * (1 + (1 - bf) * 1.2);
      I *= mf * dim * hov;

      const ep = S.epoch[i] < S.C_EPOCH.length ? S.epoch[i] : S.C_EPOCH.length - 1;
      S.tmpColor.copy(S.C_EPOCH[ep]).lerp(S.C_FRESH, mix);
      if (bf < 1) S.tmpColor.lerp(S.C_FRESH, (1 - bf) * 0.5);  // slabs arrive hot

      if (gn > 0) {                                            // compaction glitch
        px = (S.rng() - 0.5) * 0.6 * gn;
        pz = (S.rng() - 0.5) * 0.6 * gn;
        if (S.rng() < 0.3 * gn) py += (S.rng() - 0.5) * 0.5;
        S.tmpColor.lerp(S.C_HOT, 0.7 * gn);
        I *= 1 + 2.5 * gn * (0.5 + S.rng());
      }

      S.tmpPos.set(px, py, pz);
      S.tmpScale.set(sxz, frac, sxz);
      S.tmpMat.compose(S.tmpPos, S.quatI, S.tmpScale);
      S.slabs.setMatrixAt(i, S.tmpMat);
      S.slabs.setColorAt(i, S.tmpColor.multiplyScalar(I));
    }
    S.slabs.count = n;
    S.slabs.instanceMatrix.needsUpdate = true;
    if (S.slabs.instanceColor) S.slabs.instanceColor.needsUpdate = true;

    // --- seam gaskets, two data channels:
    //  · tokens written this call (fresh + cacheWrite): boundary gasket + one
    //    per gap inside the write span, full boost — no writes, no span seams
    //  · crown burn: below that, the remaining pool marches down from the
    //    summit with an exp falloff, scaled by fill — the crown of a near-full
    //    tower visibly burns while the deep archive stays cold cyan
    const dimHov = dim * hov;
    let si = 0;
    let giTop = n - 1;                                         // crown-burn march start
    if (writeTok > 1500 && S.h > 0.4) {
      const yB = Math.min(Math.max(writeStart, 0.12), S.h - 0.06);
      placeSeam(si++, yB, 1.45, now, gn, dimHov);
      const gi0 = Math.max(1, Math.ceil((yB + 0.1) / STEP));
      for (let gi = gi0; si < SEAM_MAX && gi < n; gi++) {
        const y = gi * STEP;
        if (y >= S.h - 0.05) break;
        placeSeam(si++, y, 1.0, now, gn, dimHov);
      }
      giTop = gi0 - 1;
    }
    if (S.h > 0.4 && fillBurn > 0.02) {
      for (let gi = Math.min(giTop, n - 1); si < SEAM_MAX && gi >= 1; gi--) {
        const y = gi * STEP;
        if (y >= S.h - 0.05) continue;
        const boost = 0.85 * fillBurn * Math.exp((y - S.h) / 5.5);
        if (boost < 0.09) break;
        placeSeam(si++, y, boost, now, gn, dimHov);
      }
    }
    for (let i = si; i < S.seamPrevSi; i++) S.seams.setMatrixAt(i, S.zeroMat);
    S.seamPrevSi = si;

    // --- compaction score-lines (tail slots of the seams mesh): a thin pale
    // ring etched at the token height each cut left the tower. Data marks, not
    // neon: resting intensity sits below the write gaskets; the newest scar
    // ignites magenta-ward at the cut and cools within ~2s (vt-based, so
    // seeks replay honestly). A scar only renders once the playhead has passed
    // its compaction and while it sits on the shaft (y ≤ current height).
    while (S.scarKnown < Math.min(comps.length, SCAR_MAX)) {   // resolve lazily —
      const y = scarTroughY(comps[S.scarKnown].vt);            // live sessions may
      if (y < 0) break;                                        // not have the post-
      S.scarY[S.scarKnown] = y;                                // cut sample yet
      S.scarVt[S.scarKnown] = comps[S.scarKnown].vt;
      S.scarKnown++;
    }
    let anyScar = false;
    for (let i = 0; i < SCAR_MAX; i++) {
      const idx = SEAM_MAX + i;
      const on = i < S.scarKnown && i < cc && S.h > 0.3 && S.scarY[i] <= S.h + 0.02;
      if (!on) {
        if (S.scarOn[i]) { S.seams.setMatrixAt(idx, S.zeroMat); S.scarOn[i] = 0; anyScar = true; }
        continue;
      }
      const ig = Math.exp(-(state.vt - S.scarVt[i]) * 1.15);   // ignite → etch
      const I = (SCAR_REST * (1 + 0.06 * Math.sin(now * 0.9 + i * 2.3)) + 1.1 * ig) * dimHov;
      S.tmpPos.set(0, Math.min(S.scarY[i], S.h - 0.02), 0);
      S.tmpScale.set(1, 0.6, 1);                               // thin horizontal score
      S.tmpMat.compose(S.tmpPos, S.quatI, S.tmpScale);
      S.seams.setMatrixAt(idx, S.tmpMat);
      S.seams.setColorAt(idx, S.tmpColor.copy(S.C_HOT).lerp(S.C_FRESH, ig * 0.6).multiplyScalar(I));
      S.scarOn[i] = 1;
      anyScar = true;
    }

    // upload only when something in the mesh is (or just stopped being) live
    const seamsLive = si > 0 || anyScar;
    if (seamsLive || S.seamsWasLive) {
      S.seams.instanceMatrix.needsUpdate = true;
      if (S.seams.instanceColor) S.seams.instanceColor.needsUpdate = true;
    }
    S.seamsWasLive = seamsLive;

    // --- debris shards --- (dead slots were zeroed at death/init — never
    // rewritten; buffers upload only while any shard is or just was alive)
    let shardsLive = false;
    for (let i = 0; i < SHARD_MAX; i++) {
      let L = S.life[i];
      if (L <= 0) continue;
      S.life[i] = (L -= dt);
      if (L <= 0) { S.shards.setMatrixAt(i, S.zeroMat); S.life[i] = 0; shardsLive = true; continue; }
      shardsLive = true;
      const k = i * 3;
      S.vel[k + 1] += dt * 1.6;                                // accelerate skyward
      S.pos[k] += S.vel[k] * dt;
      S.pos[k + 1] += S.vel[k + 1] * dt;
      S.pos[k + 2] += S.vel[k + 2] * dt;
      const fade = Math.min(1, L / SHARD_LIFE);
      S.tmpEuler.set(now * S.spin[k], now * S.spin[k + 1], S.spin[k + 2]);
      S.tmpQ.setFromEuler(S.tmpEuler);
      S.tmpPos.set(S.pos[k], S.pos[k + 1], S.pos[k + 2]);
      const sc = 0.4 + 0.8 * fade;
      S.tmpScale.set(sc, sc, sc);
      S.tmpMat.compose(S.tmpPos, S.tmpQ, S.tmpScale);
      S.shards.setMatrixAt(i, S.tmpMat);
      S.tmpColor.copy(S.C_CACHE).lerp(S.C_FRESH, S.tint[i]).multiplyScalar(fade * fade * 1.8 * dim);
      S.shards.setColorAt(i, S.tmpColor);
    }
    if (shardsLive || S.shardsWasLive) {
      S.shards.instanceMatrix.needsUpdate = true;
      if (S.shards.instanceColor) S.shards.instanceColor.needsUpdate = true;
    }
    S.shardsWasLive = shardsLive;

    // --- summit rig: rings, beacon, light ---
    const fl = S.flash;
    const warn = clamp01((fill - 0.86) / 0.12);                // near the session's ceiling
    // rim rides vColor (which already carries dim/hover/birth), so the uniform
    // only breathes with ceiling-warn and compaction flash
    S.uRim.value = 0.55 + 0.3 * warn + 0.6 * fl;
    S.follow.position.y = Math.max(S.h + 0.05, 0.95);
    S.ringSpin.rotation.y += dt * 0.35;
    S.tickSpin.rotation.y -= dt * 0.18;
    S.ringMat.opacity = Math.min(0.95, (0.5 + 0.15 * Math.sin(now * 2.1) + 0.45 * fl) * hov) * dim;
    S.ringMat.color.copy(S.C_CACHE).lerp(S.C_FRESH, warn * 0.6).lerp(S.C_HOT, fl * 0.5);
    S.tickMat.opacity = Math.min(0.9, (0.26 + 0.08 * Math.sin(now * 1.3 + 2) + 0.35 * fl) * hov) * dim;
    S.beamMat.opacity = Math.min(1, 0.085 + 0.035 * Math.sin(now * 1.6 + 1) + 0.5 * fl) * dim;
    const bs = 1 + fl * 0.8;
    S.beam.scale.set(bs, 1, bs);
    S.topLight.intensity = (70 + 40 * fill + 520 * fl) * dim;
    S.topLight.color.copy(S.C_CACHE).lerp(S.C_HOT, fl);
    S.trimMat.opacity = (0.42 + 0.1 * Math.sin(now * 1.1) + 0.3 * fl) * dim;

    // --- ceiling holo-frame: faint at rest, ignites cyan → magenta as warn rises ---
    const cp = 0.5 + 0.5 * Math.sin(now * 3.2);
    S.capMat.opacity = (0.09 + warn * (0.26 + 0.09 * cp) + fl * 0.28) * dim;
    S.capMat.color.copy(S.C_CACHE).lerp(S.C_FRESH, warn * 0.9).lerp(S.C_HOT, fl * 0.4);
    S.ceilLineMat.opacity = (0.3 + warn * (0.45 + 0.15 * cp) + fl * 0.3) * dim;
    S.ceilLineMat.color.copy(S.capMat.color);
    S.postMat.opacity = (0.2 + warn * 0.45) * dim;
    S.postMat.color.copy(S.capMat.color);
    S.ceilPlaneMat.opacity = (0.04 + warn * 0.15 * (0.7 + 0.3 * cp)) * dim;
    S.ceilPlaneMat.color.copy(S.capMat.color);
    S.ceilPlane.rotation.z += dt * 0.06;                       // slow holo shimmer

    // --- axis furniture: fixed, dim, precise; the CEILING label (top mark,
    // whatever the cap names it) ignites with warn ---
    S.axisMat.opacity = 0.26 * dim;
    S.railMat.opacity = 0.55 * dim;
    for (let i = 0; i < S.labelMats.length; i++) {
      S.labelMats[i].opacity = 0.8 * dim;
      S.labelMats[i].color.copy(S.C_CACHE);
    }
    S.labelMats[S.labelMats.length - 1]?.color.lerp(S.C_FRESH, warn * 0.85);

    // timers
    if (S.glitch > 0) S.glitch = Math.max(0, S.glitch - dt);
    if (S.collapse > 0) S.collapse = Math.max(0, S.collapse - dt);
    S.flash *= Math.exp(-2.3 * dt);
  },
};
