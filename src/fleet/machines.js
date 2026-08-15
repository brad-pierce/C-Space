// machines.js — FLEET VIEW: THE MACHINES. One compact totem per roster session
// placed at ctx.cityLayout.slotFor(i). Three activity states — a live session
// must read as WORKING from across the room:
//   · LIVE (active=true) — cyan orb breathing on an eased ~4s cycle whose
//     AMPLITUDE tracks the smoothed event rate (quiet live whispers, busy live
//     swells); an event flash on the orb + a tick pulse on the activity ring
//     each time the LiveTimeline gains events; column height easing toward
//     contextAt(duration) every frame. Front-row plots (slot < frontRowCount)
//     pulse their pad plinths softly in the same breath phase.
//   · EMBER (active=false, mtime < 1h) — idle-but-recent. Dim warm amber
//     (PALETTE.output) glow on orb, column, ring, and plate; NO breathing,
//     no motion: the residue of recent work, cooling. Column height freezes
//     at the last live height (or library peak). Re-derived each roster
//     resync, so an ember cools into an archive monument by time alone.
//   · ARCHIVE (older) — cool slate monuments, still (unchanged look).
// Totem anatomy:
//   · CORE ORB — session identity (state = hue + motion, see above).
//   · CONTEXT COLUMN — slab-banded stack under the orb, height = live ctx (or
//     frozen/peak ctx) / THAT SESSION'S OWN context ceiling, same cyan-cache /
//     magenta-fresh language as the main tower. Live columns track the stream
//     every frame. The ceiling is per-machine, never a global 1M: the district's
//     whole job is comparison, and a fixed denominator would draw a context-
//     heavy 200k-window Codex session as a permanent stub beside a 1M Claude one.
//   · ACTIVITY RING — thin arc on the plot pad. Live: arc fill = last-30s event
//     rate (1 ev/s sustained = full ring, 12 o'clock start, clockwise, matching
//     the chronogram convention) + a hot tick flash on the leading segment per
//     fired event. Ember/archived: static arc = log-scaled toolCalls magnitude.
//   · NAMEPLATE — uppercase micro-type canvas plate: project label + id8.
//     One shared atlas, one instanced billboard draw.
// Every geometric property encodes a real quantity: orb hue = liveness, orb
// breath amplitude = event rate, column height = tokens, band color =
// cache/fresh split, arc angle = event rate or call volume. Ornament stays
// off the plots. Luminance discipline: event flashes decay well inside 1.5s
// (exp ~3.2/s) and intensity peaks stay below white-out.
//
// Instancing: pads / slabs / orbs / ring segments / nameplates are five
// instanced draws total; geometry + materials shared; all pools allocated in
// init. Live streams are read via ctx.streams (.events length growth and
// contextAt(duration)) — this module NEVER calls tick(); fleetMain owns time.
//
// Contract-defensive: written before fleetMain.js existed, so every ctx access
// (roster / cityLayout.slotFor / streams / library) goes through a small
// adapter that accepts the documented shapes and degrades gracefully.

import * as THREE from 'three';
// Namespace import on purpose: contextCapFor is landing in palette.js alongside
// this work, and a named import of an export that is not there yet is a hard
// link error. Read it off the namespace and degrade to the local banding below.
import * as PAL from '../lib/palette.js';

// ---- tunables ---------------------------------------------------------------
const MAX_MACHINES = 48;      // pool cap (server roster caps at 40)
const SLABS_PER = 24;         // slab pool per machine — cap/24 tokens per slab
const COL_MAX_H = 3.3;        // column height at the machine's own context cap
const STEP = COL_MAX_H / SLABS_PER;
const SLAB_H = STEP * 0.8;    // inter-slab gap = seam room
const COL_R = 0.4;
const PAD_R = 1.05, PAD_H = 0.16;
const ORB_R = 0.27;
const RING_SEG = 28, RING_R = 0.8;
const RATE_WINDOW = 30;       // seconds integrated by the live activity ring
const RATE_FULL = 30;         // events in window for a full arc (1 ev/s)
const EVBUF = 128;            // rolling event-stamp buffer per machine
const ARCH_CALL_NORM = 2500;  // log-norm ceiling for archived toolCalls arcs
const EMBER_MS = 3_600_000;   // idle-but-recent horizon: mtime < 1h → ember
const BREATH_W = Math.PI / 2; // eased breath angular speed — one cycle ≈ 4s
const ATLAS_W = 512, ATLAS_H = 1024, CELL_W = 256, CELL_H = 40;
const PLATE_W = 2.1, PLATE_H = PLATE_W * (CELL_H / CELL_W);
// Fallback context-window bands — MUST mirror palette.js's CONTEXT_BANDS /
// CONTEXT_HEADROOM (see capFrom below for why the copy exists).
const CAP_BANDS = [200_000, 500_000, 1_000_000, 2_000_000];
const CAP_HEADROOM = 1.1;
// Harness display names for the source tag ('claude'|'codex'|'hermes'|'openclaw').
const SOURCE_LABEL = { claude: 'CLAUDE', codex: 'CODEX', hermes: 'HERMES', openclaw: 'OPENCLAW' };

// ---- pure helpers (no DOM at module scope — import-clean under node) --------
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };

// Eased breath, -1..1: sine remapped through smoothstep so the cycle dwells at
// the extremes and moves through the middle — an inhale/exhale, not a metronome.
const breath = (t, phase) => sstep(0.5 + 0.5 * Math.sin(t * BREATH_W + phase)) * 2 - 1;

// live > ember (idle-but-recent) > archive. mtime is epoch ms (fs mtimeMs).
function stateFor(sess, nowMs) {
  if (sess.active) return 'live';
  const mt = Number(sess.mtime);
  return Number.isFinite(mt) && nowMs - mt < EMBER_MS ? 'ember' : 'archive';
}

// ---- per-session context ceiling -------------------------------------------
// Every column is measured against ITS OWN window. Order of preference:
//   1. an explicit ceiling the roster row or the library row supplies
//   2. palette.js's contextCapFor — the model table plus its own peak banding
//   3. the local banding below, if this build's palette predates that export
function firstPositive(...cands) {
  for (const c of cands) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// Smallest standard band clearing the peak with headroom — a straight copy of
// palette.js's bandFor. See capFrom for why the copy exists.
function bandCap(peak) {
  const p = Number(peak);
  if (!Number.isFinite(p) || p <= 0) return null;
  const need = p * CAP_HEADROOM;
  for (const b of CAP_BANDS) if (b >= need) return b;
  return Math.max(CAP_BANDS[CAP_BANDS.length - 1], Math.ceil(need / 1_000_000) * 1_000_000);
}

// palette.js owns the real derivation (model table + explicit-cap keys + peak
// banding). The fleet holds roster/library ROWS rather than parsed sessions, so
// it hands contextCapFor a session-shaped {meta} assembled from the row.
// NOTE (duplication): bandCap above mirrors that function's banding purely as a
// fallback for a build where the export is absent. If palette's bands or
// headroom change, change them here too — or delete the fallback outright once
// the export is guaranteed. Same copy lives in fleetHud.js / fleetInteract.js,
// which keep their own row bags.
function capFrom(model, peak) {
  const fn = PAL?.contextCapFor;
  if (typeof fn === 'function') {
    try {
      const v = Number(fn({ meta: { model: model ?? undefined, peakContext: peak || undefined } }));
      if (Number.isFinite(v) && v > 0) return v;
    } catch { /* fall through to the local banding */ }
  }
  return bandCap(peak);
}

// 'codex' → 'CODEX'. Unknown/absent source stays null so nothing is invented.
function sourceOf(row) {
  const s = String(row?.source ?? row?.harness ?? row?.agent ?? row?.meta?.source ?? '')
    .trim().toLowerCase();
  return s || null;
}
// The adapter's own sourceLabel ('Claude Code', 'Codex CLI') wins when the row
// carries one — the harness names itself better than a table here can.
const sourceName = (row) => (row?.sourceLabel ? String(row.sourceLabel) : null);
const sourceLabel = (s, raw) => (raw ? String(raw).toUpperCase().slice(0, 14)
  : s ? SOURCE_LABEL[s] ?? s.toUpperCase().slice(0, 14) : null);

function fmtK(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 2) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(Math.round(n));
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Per-instance emissive drive: multiply totalEmissiveRadiance by instanceColor
// (same patch as the main tower — one instanced draw carries every state).
function patchInstancedEmissive(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n#ifdef USE_INSTANCING_COLOR\n\ttotalEmissiveRadiance *= vColor;\n#endif'
    );
  };
}

// "C--Users-you-myapp" → "MYAPP"
function projectLabel(proj) {
  let s = String(proj ?? '')
    .replace(/^[A-Za-z]--/, '')
    .replace(/^Users-[^-]+-?/i, '')
    .replace(/^-+|-+$/g, '');
  if (!s) s = 'HOME';
  return s.toUpperCase().slice(0, 18);
}

// ---- contract adapters (fleetMain's exact ctx shape was unpublished) --------
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

// Accept a LiveTimeline directly or wrapped ({timeline}/{tl}); need contextAt.
function timelineOf(ctx, id) {
  const s = ctx?.streams;
  if (!s) return null;
  const e = typeof s.get === 'function' ? s.get(id) : s[id];
  for (const t of [e, e?.timeline, e?.tl]) {
    if (t && typeof t.contextAt === 'function' && Array.isArray(t.events)) return t;
  }
  return null;
}

// /data/library/index.json → Map(id → {peak, toolCalls}); shape-tolerant.
function normalizeLibrary(payload) {
  const map = new Map();
  const rows = Array.isArray(payload) ? payload
    : Array.isArray(payload?.sessions) ? payload.sessions
    : payload && typeof payload === 'object'
      ? Object.entries(payload).map(([k, v]) => ({ id: k, ...(v ?? {}) }))
      : [];
  for (const r of rows) {
    if (!r) continue;
    const id = r.id ?? r.session ?? r.sessionId;
    if (!id) continue;
    let toolCalls = r.toolCalls ?? r.meta?.toolCalls ?? null;
    if (toolCalls == null && r.tools && typeof r.tools === 'object') {
      toolCalls = 0;
      for (const v of Object.values(r.tools)) toolCalls += Number.isFinite(v?.count) ? v.count : 0;
    }
    map.set(String(id), {
      peak: r.peakContext ?? r.peakCtx ?? r.meta?.peakContext ?? null,
      toolCalls: Number.isFinite(toolCalls) ? toolCalls : null,
      cap: firstPositive(r.contextCap, r.cap, r.contextWindow,
        r.meta?.contextCap, r.meta?.contextWindow),
      model: r.model ?? r.meta?.model ?? null,
      source: sourceOf(r), srcName: sourceName(r),
    });
  }
  return map;
}

// ---- canvas textures (grayscale masks; hue arrives via emissive tint) -------
function makeSlabSideTexture(rng) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 128, 64);
  g.fillStyle = 'rgba(255,255,255,0.05)';                    // faint scanlines
  for (let y = 2; y < 64; y += 4) g.fillRect(0, y, 128, 1);
  g.fillStyle = 'rgba(255,255,255,0.3)';                     // bus lines
  for (const y of [14, 40, 56]) g.fillRect(0, y, 128, 1);
  for (let x = 3; x < 125; x += 8) {                         // memory-cell row
    const a = rng() < 0.65 ? 0.2 + rng() * 0.4 : 0.05;
    g.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
    g.fillRect(x, 24, 5, 4);
  }
  let gr = g.createLinearGradient(0, 0, 0, 9);               // hot top seam
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 9);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping; t.repeat.set(2, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makePadTexture(rng) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 64, 64);
  g.translate(32, 32);
  for (let r = 10; r <= 30; r += 10) {                       // concentric hexes
    g.strokeStyle = `rgba(255,255,255,${r === 30 ? 0.7 : 0.18})`;
    g.lineWidth = r === 30 ? 2 : 1;
    g.beginPath();
    for (let k = 0; k <= 6; k++) {
      const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
      k ? g.lineTo(Math.cos(a) * r, Math.sin(a) * r) : g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.closePath(); g.stroke();
  }
  for (let i = 0; i < 10; i++) {                             // pads
    const a = rng() * Math.PI * 2, r = 8 + rng() * 20;
    g.fillStyle = `rgba(255,255,255,${(0.15 + rng() * 0.3).toFixed(3)})`;
    g.fillRect(Math.cos(a) * r - 1, Math.sin(a) * r - 1, 2, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// nameplate billboard shader — anchored bottom-center, atlas cell per instance
const PLATE_VERT = /* glsl */`
  attribute vec4 uvOff;
  attribute vec3 tint;
  uniform vec2 uScale;
  varying vec2 vUv;
  varying vec3 vTint;
  void main() {
    vUv = uvOff.xy + uv * uvOff.zw;
    vTint = tint;
    #ifdef USE_INSTANCING
      vec4 anchor = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    #else
      vec4 anchor = vec4(0.0, 0.0, 0.0, 1.0);
    #endif
    vec4 mv = modelViewMatrix * anchor;
    mv.xy += vec2(position.x, position.y + 0.5) * uScale;
    gl_Position = projectionMatrix * mv;
  }`;
const PLATE_FRAG = /* glsl */`
  uniform sampler2D uMap;
  varying vec2 vUv;
  varying vec3 vTint;
  void main() {
    vec4 t = texture2D(uMap, vUv);
    gl_FragColor = vec4(vTint * t.rgb, t.a);
    if (gl_FragColor.a < 0.01) discard;
  }`;

// ---------------------------------------------------------------------------
let S = null; // module state bag — filled in init()

function drawPlate(i, label, id8) {
  const g = S.atlasCtx;
  const x0 = (i % 2) * CELL_W, y0 = ((i / 2) | 0) * CELL_H;
  g.clearRect(x0, y0, CELL_W, CELL_H);
  g.fillStyle = 'rgba(255,255,255,0.85)';                    // tick dash — house micro-type
  g.fillRect(x0 + 4, y0 + 12, 10, 2);
  g.font = '600 17px Consolas, "Courier New", monospace';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.fillText(label, x0 + 20, y0 + 13, CELL_W - 26);
  g.font = '600 12px Consolas, "Courier New", monospace';
  g.fillStyle = 'rgba(255,255,255,0.45)';
  g.fillText(id8.toUpperCase(), x0 + 20, y0 + 30, CELL_W - 26);
  S.atlasTex.needsUpdate = true;
  const u = x0 / ATLAS_W, w = CELL_W / ATLAS_W, h = CELL_H / ATLAS_H;
  S.uvOffAttr.setXYZW(i, u, 1 - (y0 + CELL_H) / ATLAS_H, w, h);
  S.uvOffAttr.needsUpdate = true;
}

function ringAngle(f) { return Math.PI - f * Math.PI * 2; }  // 12 o'clock, clockwise

function countRate(m, now) {   // events inside the RATE_WINDOW, newest-first scan
  let n = 0;
  for (let k = 0; k < m.evN; k++) {
    const idx = (m.evHead - 1 - k + EVBUF) % EVBUF;
    if (now - m.evT[idx] > RATE_WINDOW) break;
    n++;
  }
  return n;
}

// Resolve (and ratchet) one machine's context ceiling. Monotonic on the inferred
// path: a live session that grows past a band steps up to the next one and never
// back down, so a column never rescales downward mid-stream (and a compaction
// drops the height, not the ruler). m.cap === 0 means "still unknown".
function refreshCap(m, liveTok) {
  const lib = S.library?.get(m.id);
  const explicit = firstPositive(m.capHint, lib?.cap);
  if (explicit) { m.cap = explicit; return m.cap; }
  const peak = Math.max(m.peak || 0, Number(liveTok) || 0, Number(lib?.peak) || 0);
  m.peak = peak;
  const model = m.model ?? lib?.model ?? null;
  // nothing known at all → leave the ceiling unknown rather than invent one
  const c = (peak > 0 || model) ? capFrom(model, peak) : null;
  if (c && c > m.cap) m.cap = c;
  return m.cap;
}

// Divisor for geometry — never zero. An unknown ceiling only ever applies to a
// machine with no context reading at all, whose column is a stub either way.
const capUnit = (m) => m.cap || S.defaultCap;

// Write one machine's column slabs. Live: cyan cache body + magenta fresh crown
// + per-slab hash shimmer. Ember: warm, dim, still. Archived: cool, dim, still.
function writeColumn(m, cx, liveNow) {
  const { slabs, tmpMat, tmpPos, tmpScale, quatI, tmpColor, C_CACHE, C_FRESH, C_SLATE, C_EMBER } = S;
  const base = m.slot * SLABS_PER;
  const n = m.h > 0.02 ? Math.min(SLABS_PER, Math.max(1, Math.ceil(m.h / STEP))) : 0;
  const freshTok = cx ? (cx.fresh || 0) + (cx.cacheWrite || 0) : 0;
  const freshStart = m.h - (freshTok / capUnit(m)) * COL_MAX_H;
  for (let i = 0; i < SLABS_PER; i++) {
    if (i >= n) { slabs.setMatrixAt(base + i, S.zeroMat); continue; }
    const isTop = i === n - 1;
    const frac = isTop ? Math.max(0.14, Math.min(1, (m.h - (n - 1) * STEP) / STEP)) : 1;
    const yBase = PAD_H + i * STEP + (STEP - SLAB_H) * 0.5;
    tmpPos.set(m.x, m.y + yBase + SLAB_H * frac * 0.5, m.z);
    tmpScale.set(1, frac, 1);
    tmpMat.compose(tmpPos, quatI, tmpScale);
    slabs.setMatrixAt(base + i, tmpMat);
    const hash = S.hash[(base + i) % S.hash.length];
    if (m.state === 'live') {
      let mix = clamp01(((i * STEP + STEP * frac) - freshStart) / STEP);
      if (isTop && freshTok > 0) mix = Math.max(mix, 0.4);
      mix = sstep(mix);
      const breathe = liveNow != null ? 0.08 * Math.sin(liveNow * 1.1 + i * 0.55 + m.phase) : 0;
      const I = (0.55 + 0.25 * hash + breathe) * (1 - mix) + (1.25 + 0.15 * hash) * mix;
      tmpColor.copy(C_CACHE).lerp(C_FRESH, mix).multiplyScalar(I * (0.35 + 0.65 * Math.min(1, m.flare + 0.75)));
    } else if (m.state === 'ember') {
      // dim warm residue of recent work — written once, no motion
      tmpColor.copy(C_EMBER).lerp(C_SLATE, 0.45).multiplyScalar(0.16 + 0.10 * hash);
    } else {
      tmpColor.copy(C_CACHE).lerp(C_SLATE, 0.6).multiplyScalar(0.22 + 0.12 * hash);
    }
    slabs.setColorAt(base + i, tmpColor);
  }
  S.slabsDirty = true;
}

function writeOrb(m, liveNow) {
  const { orbs, tmpMat, tmpPos, tmpScale, quatI, tmpColor, C_ORB, C_HOT, C_SLATE, C_EMBER } = S;
  const y = m.y + Math.max(PAD_H + m.h + 0.38, 0.55);
  let s = 0.85;
  if (m.state === 'live') {
    // eased ~4s breath; smoothed event rate feeds the amplitude — a quiet
    // live session whispers, a busy one visibly swells
    const b = liveNow != null ? breath(liveNow, m.phase) : 0;
    const amp = 0.35 + 0.65 * m.fill;
    s = 1 + 0.075 * amp * b;
    // flash peaks hot but never white: intensity + hot-lerp both capped
    const I = 1.0 + 0.38 * amp * b + 1.8 * m.flare;
    tmpColor.copy(C_ORB).lerp(C_HOT, Math.min(0.7, m.flare * 0.7)).multiplyScalar(I);
  } else if (m.state === 'ember') {
    s = 0.9;
    tmpColor.copy(C_EMBER).multiplyScalar(0.34);             // dim warm glow, still
  } else {
    tmpColor.copy(C_SLATE).multiplyScalar(0.7);              // dim slate, still, cooler
  }
  tmpPos.set(m.x, y, m.z);
  tmpScale.setScalar(s);
  tmpMat.compose(tmpPos, quatI, tmpScale);
  orbs.setMatrixAt(m.slot, tmpMat);
  orbs.setColorAt(m.slot, tmpColor);
  S.orbsDirty = true;
  // nameplate rides the summit
  tmpPos.y = y + ORB_R + 0.18;
  tmpMat.setPosition(tmpPos);
  S.plates.setMatrixAt(m.slot, tmpMat);
  S.platesDirty = true;
}

function writeRing(m, fill, tickF) {
  const { rings, tmpColor, C_CACHE, C_HOT, C_SLATE, C_EMBER } = S;
  const base = m.slot * RING_SEG;
  const lit = fill * RING_SEG;
  const lead = Math.min(RING_SEG - 1, lit | 0);
  for (let sgi = 0; sgi < RING_SEG; sgi++) {
    const on = sgi < lit;
    if (m.state === 'live') {
      tmpColor.copy(C_CACHE).multiplyScalar(on ? 1.5 : 0.07);
      if (sgi === lead && tickF > 0.01) tmpColor.lerp(C_HOT, tickF).multiplyScalar(1 + 2.5 * tickF);
    } else if (m.state === 'ember') {
      tmpColor.copy(C_EMBER).lerp(C_SLATE, 0.35).multiplyScalar(on ? 0.42 : 0.04);
    } else {
      tmpColor.copy(C_CACHE).lerp(C_SLATE, 0.65).multiplyScalar(on ? 0.55 : 0.05);
    }
    rings.setColorAt(base + sgi, tmpColor);
  }
  S.ringsDirty = true;
}

// Pad plinth base emissive per state. Live front-row pads additionally pulse
// per-frame in update() — this writes the resting value.
function writePadBase(m) {
  const c = S.tmpColor;
  if (m.state === 'live') c.copy(S.C_CACHE).multiplyScalar(0.4);
  else if (m.state === 'ember') c.copy(S.C_EMBER).multiplyScalar(0.26);
  else c.copy(S.C_SLATE).multiplyScalar(0.22);
  S.pads.setColorAt(m.slot, c);
  S.padsDirty = true;
}

// Ember and archived machines are written once at each state change (and
// re-written when the library loads) — still by construction, zero frame cost.
function styleArchive(m) {
  const lib = S.library?.get(m.id);
  refreshCap(m);
  m.h = lib?.peak ? clamp01(lib.peak / capUnit(m)) * COL_MAX_H : 0.06;
  writeColumn(m, null, null);
  writeOrb(m, null);
  const tc = lib?.toolCalls;
  writeRing(m, tc ? clamp01(Math.log(tc + 1) / Math.log(ARCH_CALL_NORM + 1)) : 0, 0);
  S.tintAttr.setXYZ(m.slot, S.C_SLATE.r * 1.1, S.C_SLATE.g * 1.1, S.C_SLATE.b * 1.1);
  S.tintAttr.needsUpdate = true;
}

// Ember: same stillness as archive, warm hue. Column height freezes at the
// last live height when we watched it work; falls back to library peak.
function styleEmber(m) {
  const lib = S.library?.get(m.id);
  refreshCap(m);
  if (m.h <= 0.02) m.h = lib?.peak ? clamp01(lib.peak / capUnit(m)) * COL_MAX_H : 0.06;
  writeColumn(m, null, null);
  writeOrb(m, null);
  const tc = lib?.toolCalls;
  writeRing(m, tc ? clamp01(Math.log(tc + 1) / Math.log(ARCH_CALL_NORM + 1)) : 0, 0);
  S.tintAttr.setXYZ(m.slot, S.C_EMBER.r * 0.75, S.C_EMBER.g * 0.75, S.C_EMBER.b * 0.75);
  S.tintAttr.needsUpdate = true;
}

function styleLivePlate(m) {
  S.tintAttr.setXYZ(m.slot, S.C_TEXT.r, S.C_TEXT.g, S.C_TEXT.b);
  S.tintAttr.needsUpdate = true;
}

// Apply the visuals for m.state (call after the state field flips).
function applyState(m) {
  if (m.state === 'live') {
    styleLivePlate(m);
    m.snapped = false;   // next ctx sample snaps the column, then eases
    m.lastEv = -1;       // a fresh stream's backlog is history, not a flare burst
  } else if (m.state === 'ember') styleEmber(m);
  else styleArchive(m);
  writePadBase(m);
}

function addMachine(sess, i, nowMs) {
  const m = {
    id: String(sess.id), id8: String(sess.id).slice(0, 8),
    label: projectLabel(sess.project),
    state: stateFor(sess, nowMs), mtime: Number(sess.mtime) || 0, slot: i,
    x: 0, y: 0, z: 0, phase: S.rng() * Math.PI * 2,
    h: 0, flare: 0, tickF: 0, fill: 0, snapped: false,
    evT: new Float32Array(EVBUF), evHead: 0, evN: 0, lastEv: -1,
    // harness identity + per-session context ceiling (source lands with the
    // multi-harness discovery wiring; absent means "not stated", never "claude")
    source: sourceOf(sess), srcName: sourceName(sess),
    model: sess.model ?? sess.meta?.model ?? null,
    capHint: firstPositive(sess.contextCap, sess.cap, sess.contextWindow, sess.meta?.contextCap),
    cap: 0, peak: 0,
  };
  refreshCap(m);
  slotOf(S.ctx, i, S.tmpPos);
  m.x = S.tmpPos.x; m.y = S.tmpPos.y; m.z = S.tmpPos.z;

  // pad (static transform; base color per state, live front row pulses in update)
  S.tmpMat.compose(S.tmpPos.set(m.x, m.y + PAD_H / 2, m.z), S.quatI, S.tmpScale.set(1, 1, 1));
  S.pads.setMatrixAt(i, S.tmpMat);
  writePadBase(m);

  // ring segment transforms (static; colors carry the data)
  const y = m.y + PAD_H + 0.035;
  for (let sgi = 0; sgi < RING_SEG; sgi++) {
    const a = ringAngle((sgi + 0.5) / RING_SEG);
    S.tmpPos.set(m.x + Math.sin(a) * RING_R, y, m.z + Math.cos(a) * RING_R);
    S.tmpQ.setFromAxisAngle(S.upVec, a + Math.PI / 2);
    S.tmpMat.compose(S.tmpPos, S.tmpQ, S.tmpScale.set(1, 1, 1));
    S.rings.setMatrixAt(i * RING_SEG + sgi, S.tmpMat);
  }

  drawPlate(i, m.label, m.id8);
  if (m.state === 'live') { styleLivePlate(m); writeOrb(m, 0); writeRing(m, 0, 0); }
  else if (m.state === 'ember') styleEmber(m);
  else styleArchive(m);

  S.machines.push(m);
  S.byId.set(m.id, m);
  S.padsDirty = S.ringsDirty = true;
  return m;
}

function buildFromRoster(roster) {
  const nowMs = Date.now();
  const n = Math.min(roster.length, MAX_MACHINES);
  for (let i = 0; i < n; i++) addMachine(roster[i], i, nowMs);
  S.built = true;
  let live = 0, ember = 0;
  const srcs = new Set();
  for (const m of S.machines) {
    if (m.state === 'live') live++; else if (m.state === 'ember') ember++;
    if (m.source) srcs.add(m.source);
  }
  console.log(`[fleet/machines] ${S.machines.length} machine totems (${live} live, ${ember} ember` +
    (srcs.size ? `; ${[...srcs].join('+')}` : '') +
    `) — 5 instanced draws, col ${COL_MAX_H}u at each session's own context ceiling`);
}

function syncRoster(roster) {
  // State is re-derived against wall-clock every pass, so live→ember (stream
  // went quiet) and ember→archive (an hour passed) both happen without any
  // roster field changing shape.
  const nowMs = Date.now();
  for (const sess of roster) {
    const m = S.byId.get(String(sess.id));
    if (m) {
      m.mtime = Number(sess.mtime) || m.mtime;
      // discovery may start tagging harness / window fields after the district
      // is already standing — adopt them, never unset what we already have
      m.source = m.source ?? sourceOf(sess);
      m.srcName = m.srcName ?? sourceName(sess);
      m.model = m.model ?? sess.model ?? sess.meta?.model ?? null;
      m.capHint = m.capHint ??
        firstPositive(sess.contextCap, sess.cap, sess.contextWindow, sess.meta?.contextCap);
      const st = stateFor(sess, nowMs);
      if (st !== m.state) { m.state = st; applyState(m); }
    } else if (S.machines.length < MAX_MACHINES) {
      addMachine(sess, S.machines.length, nowMs);            // late arrival — take next plot
    }
  }
}

export default {
  name: 'machines',

  init(ctx) {
    S = {
      // last-resort divisor only: every machine carries its OWN ceiling (m.cap),
      // and this is used solely for a machine with no context reading at all
      ctx, defaultCap: ctx.CONTEXT_TOKEN_CAP ?? 1_000_000,
      rng: mulberry32(0xF1EE7),
      machines: [], byId: new Map(), built: false,
      library: null, libDirty: false,
      time: 0, rosterTimer: 0,
      // scratch — update loop allocates nothing
      tmpMat: new THREE.Matrix4(), tmpPos: new THREE.Vector3(),
      tmpScale: new THREE.Vector3(), tmpQ: new THREE.Quaternion(),
      tmpColor: new THREE.Color(),
      quatI: new THREE.Quaternion(), upVec: new THREE.Vector3(0, 1, 0),
      zeroMat: new THREE.Matrix4().makeScale(0, 0, 0),
      hash: new Float32Array(257),
      C_CACHE: new THREE.Color(ctx.PALETTE.cache),
      C_FRESH: new THREE.Color(ctx.PALETTE.fresh),
      C_ORB: new THREE.Color(ctx.PALETTE.coreEnergy),
      C_HOT: new THREE.Color(ctx.PALETTE.coreHot),
      C_SLATE: new THREE.Color(ctx.PALETTE.hudDim),
      C_TEXT: new THREE.Color(ctx.PALETTE.hudText),
      C_EMBER: new THREE.Color(ctx.PALETTE.output),   // warm amber — ember state
      frontRow: ctx.cityLayout?.frontRowCount ?? 4,   // live plots that pulse pads
      slabsDirty: false, orbsDirty: false, ringsDirty: false, padsDirty: false, platesDirty: false,
    };
    for (let i = 0; i < S.hash.length; i++) S.hash[i] = S.rng();
    const texRng = mulberry32(0xC17EE);

    const group = new THREE.Group();
    group.name = 'fleet-machines';
    ctx.scene.add(group);
    S.group = group;

    // -- pads: hex plinths, faint circuit emissive --
    const padMat = new THREE.MeshStandardMaterial({
      color: ctx.PALETTE.coreShell, metalness: 0.85, roughness: 0.45, flatShading: true,
      emissive: 0xffffff, emissiveIntensity: 0.5, emissiveMap: makePadTexture(texRng),
    });
    patchInstancedEmissive(padMat);
    S.pads = new THREE.InstancedMesh(new THREE.CylinderGeometry(PAD_R, PAD_R * 1.12, PAD_H, 6), padMat, MAX_MACHINES);

    // -- context columns: pooled hex slabs, one draw for the whole city --
    const slabMat = new THREE.MeshStandardMaterial({
      color: ctx.PALETTE.coreShell, metalness: 0.2, roughness: 0.85, flatShading: true,
      emissive: 0xffffff, emissiveIntensity: 1.1, emissiveMap: makeSlabSideTexture(texRng),
    });
    patchInstancedEmissive(slabMat);
    S.slabs = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(COL_R, COL_R, SLAB_H, 6), slabMat, MAX_MACHINES * SLABS_PER);

    // -- core orbs --
    const orbMat = new THREE.MeshStandardMaterial({
      color: 0x000000, metalness: 0.1, roughness: 0.6,
      emissive: 0xffffff, emissiveIntensity: 1.0,
    });
    patchInstancedEmissive(orbMat);
    S.orbs = new THREE.InstancedMesh(new THREE.SphereGeometry(ORB_R, 16, 12), orbMat, MAX_MACHINES);

    // -- activity rings: tangential segments, arc fill carried by color --
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    S.rings = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.05, 0.04, (2 * Math.PI * RING_R / RING_SEG) * 0.72),
      ringMat, MAX_MACHINES * RING_SEG);
    S.rings.renderOrder = 2;

    // -- nameplates: one atlas, one instanced billboard draw --
    S.atlas = document.createElement('canvas');
    S.atlas.width = ATLAS_W; S.atlas.height = ATLAS_H;
    S.atlasCtx = S.atlas.getContext('2d');
    S.atlasTex = new THREE.CanvasTexture(S.atlas);
    S.atlasTex.colorSpace = THREE.SRGBColorSpace;
    S.atlasTex.minFilter = THREE.LinearFilter;
    S.atlasTex.generateMipmaps = false;
    const plateGeo = new THREE.PlaneGeometry(1, 1);
    S.uvOffAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MACHINES * 4), 4);
    S.tintAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MACHINES * 3), 3);
    plateGeo.setAttribute('uvOff', S.uvOffAttr);
    plateGeo.setAttribute('tint', S.tintAttr);
    const plateMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: S.atlasTex }, uScale: { value: new THREE.Vector2(PLATE_W, PLATE_H) } },
      vertexShader: PLATE_VERT, fragmentShader: PLATE_FRAG,
      transparent: true, depthWrite: false,
    });
    S.plates = new THREE.InstancedMesh(plateGeo, plateMat, MAX_MACHINES);
    S.plates.renderOrder = 3;

    for (const mesh of [S.pads, S.slabs, S.orbs, S.rings, S.plates]) {
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, S.zeroMat);
      group.add(mesh);
    }
    // allocate instanceColor before first render
    for (const mesh of [S.pads, S.slabs, S.orbs, S.rings]) {
      for (let i = 0; i < mesh.count; i++) mesh.setColorAt(i, S.tmpColor.setScalar(0));
    }

    // -- archived-session stats (may 404 on a fresh install — that's fine) --
    if (!ctx.library && typeof fetch === 'function') {
      fetch('/data/library/index.json')
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (j) { S.library = normalizeLibrary(j); S.libDirty = true; } })
        .catch(() => { /* no library yet — archived totems stay minimal */ });
    } else if (ctx.library) {
      S.library = ctx.library instanceof Map ? ctx.library : normalizeLibrary(ctx.library);
    }

    // -- hover cards, if the fleet page runs an interact module --
    if (ctx.pick?.register) {
      const cardFor = (slot) => {
        const m = S.machines[slot];
        if (!m) return { title: 'MACHINE', lines: [] };
        const lib = S.library?.get(m.id);
        const cap = capUnit(m);
        const frac = m.h / COL_MAX_H;
        const lines = [
          ['SESSION', m.id8.toUpperCase()],
          ['STATUS', m.state === 'live' ? 'LIVE' : m.state === 'ember' ? 'EMBER' : 'ARCHIVED'],
          // the ceiling is named, not implied — the % is meaningless without it
          ['CONTEXT', `${fmtK(frac * cap)} / ${fmtK(cap)} · ${(frac * 100).toFixed(0)}%`],
        ];
        const src = sourceLabel(m.source ?? lib?.source, m.srcName ?? lib?.srcName);
        if (src) lines.splice(1, 0, ['HARNESS', src]);
        if (m.state === 'live') lines.push(['RATE', `${countRate(m, S.time)} EV / ${RATE_WINDOW}S`]);
        else if (lib?.toolCalls != null) lines.push(['CALLS', lib.toolCalls.toLocaleString('en-US')]);
        return { title: m.label, lines };
      };
      ctx.pick.register(S.orbs, { kind: 'machine', card: (hit) => cardFor(hit.instanceId ?? 0) });
      ctx.pick.register(S.slabs, { kind: 'machine', card: (hit) => cardFor(((hit.instanceId ?? 0) / SLABS_PER) | 0) });
      ctx.pick.register(S.pads, { kind: 'machine', card: (hit) => cardFor(hit.instanceId ?? 0) });
    }

    const roster = rosterOf(ctx);
    if (roster?.length) buildFromRoster(roster);
  },

  update(dt, a, b) {
    if (!S) return;
    // signature-tolerant: (dt, state, ctx) or (dt, ctx) — find the ctx bag
    const ctx = (b && (b.scene || b.streams || b.THREE)) ? b
      : (a && (a.scene || a.streams || a.THREE)) ? a : S.ctx;
    S.ctx = ctx;
    const now = (S.time += dt);

    if (!S.built) {
      const roster = rosterOf(ctx);
      if (roster?.length) buildFromRoster(roster);
      else return;
    }

    // roster resync ~1 Hz: liveness flips + late arrivals
    if ((S.rosterTimer -= dt) <= 0) {
      S.rosterTimer = 1.0;
      const roster = rosterOf(ctx);
      if (roster) syncRoster(roster);
      if (S.libDirty) {
        S.libDirty = false;
        for (const m of S.machines) {
          if (m.state === 'ember') styleEmber(m);
          else if (m.state === 'archive') styleArchive(m);
        }
      }
    }

    for (const m of S.machines) {
      if (m.state !== 'live') continue;                      // ember/archive: still, written once

      const tl = timelineOf(ctx, m.id);
      let cx = null;
      if (tl) {
        // event deltas — fleetMain owns tick(); we only read growth
        const nEv = tl.events.length;
        if (m.lastEv < 0) m.lastEv = nEv;                    // backlog is history, not a flare
        else if (nEv > m.lastEv) {
          const k = Math.min(nEv - m.lastEv, 16);
          for (let j = 0; j < k; j++) { m.evT[m.evHead] = now; m.evHead = (m.evHead + 1) % EVBUF; m.evN = Math.min(m.evN + 1, EVBUF); }
          m.lastEv = nEv;
          m.flare = 1; m.tickF = 1;                          // event-pulse flare + ring tick
        }
        cx = tl.contextAt(tl.duration);
      }

      // column height chases live context (snap on first sample), scaled against
      // this machine's own ceiling — which ratchets up if the stream outgrows it
      const ctxTok = cx ? (cx.ctx || 0) : (S.library?.get(m.id)?.peak ?? 0);
      refreshCap(m, ctxTok);
      const target = clamp01(ctxTok / capUnit(m)) * COL_MAX_H;
      if (!m.snapped && cx) { m.h = target; m.snapped = true; }
      else m.h += (target - m.h) * Math.min(1, dt * 3.5);

      m.flare *= Math.exp(-3.2 * dt);
      m.tickF *= Math.exp(-6 * dt);

      // activity ring + breath amplitude: last-30s event rate, eased
      const fillT = tl ? clamp01(countRate(m, now) / RATE_FULL) : 0;
      m.fill += (fillT - m.fill) * Math.min(1, dt * 4);

      writeColumn(m, cx, now);
      writeOrb(m, now);
      writeRing(m, m.fill, m.tickF);

      // front-row plots breathe their pad plinth with the machine — soft,
      // same eased phase as the orb, well under bloom threshold
      if (m.slot < S.frontRow) {
        const pb = 0.5 + 0.5 * breath(now, m.phase);
        S.pads.setColorAt(m.slot, S.tmpColor.copy(S.C_CACHE).multiplyScalar(0.34 + 0.16 * pb));
        S.padsDirty = true;
      }
    }

    if (S.slabsDirty) {
      S.slabs.instanceMatrix.needsUpdate = true;
      if (S.slabs.instanceColor) S.slabs.instanceColor.needsUpdate = true;
      S.slabsDirty = false;
    }
    if (S.orbsDirty) {
      S.orbs.instanceMatrix.needsUpdate = true;
      if (S.orbs.instanceColor) S.orbs.instanceColor.needsUpdate = true;
      S.orbsDirty = false;
    }
    if (S.ringsDirty) {
      S.rings.instanceMatrix.needsUpdate = true;
      if (S.rings.instanceColor) S.rings.instanceColor.needsUpdate = true;
      S.ringsDirty = false;
    }
    if (S.padsDirty) {
      S.pads.instanceMatrix.needsUpdate = true;
      if (S.pads.instanceColor) S.pads.instanceColor.needsUpdate = true;
      S.padsDirty = false;
    }
    if (S.platesDirty) {
      S.plates.instanceMatrix.needsUpdate = true;
      S.platesDirty = false;
    }
  },
};
