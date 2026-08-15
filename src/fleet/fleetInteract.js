// fleetInteract.js — FLEET VIEW: the interaction layer. Owns machine-totem
// picking, the HUD-language hover card, the DIVE handshake (eased fade-to-black
// then navigation into C-SPACE), ctx.fade for every fleet module, and the
// fleet zoom rail (FLEET / ORBIT / RING / STREET) with dive-by-zoom.
//
//   · PICKING — machines.js publishes no pick registry on this page, so the
//     raycaster reads its existing structure: the 'fleet-machines' group's
//     instanced pools. Slot mapping is derived, never imported: the machine
//     count is the smallest instance pool in the group, so
//     slot = instanceId / (mesh.count / base). Only the MeshStandardMaterial
//     pools (pads, slabs, orbs) are pickable — activity rings and nameplates
//     are additive chrome. Zero-scaled spare instances can never be struck.
//   · HOVER — one corner-bracketed card in the main page's .pick-card
//     language: project, id8, the harness it ran on, LIVE / IDLE / ARCHIVE,
//     live ctx tokens or library peak OVER THAT SESSION'S OWN context ceiling
//     (never a global 1M — a 200k-window session read against 1M looks empty
//     when it was in fact context-heavy), active agent count. Cursor turns
//     pointer; the totem
//     brightens via a soft additive glow sprite riding the hovered orb
//     (self-owned, eased, whisper-level — nothing floats above silhouettes).
//   · DIVE — click a totem (or wheel-zoom within ~8u of a live machine for
//     ~400ms): sessionStorage cspaceFade=1, eased ~350ms fade to black, then
//     /?live=<id> for active sessions, /?session=<id> when the id exists in
//     /data/library/index.json (fetched once, cached), else /?live=<id>
//     anyway — the tail can replay any allowlisted session.
//   · ctx.fade — { out(cb[,s]), in([s]) }: the black-overlay handshake any
//     fleet module may call. On init, a set cspaceFade key is cleared and the
//     page fades IN from black (~400ms eased) — the ascend half.
//   · ZOOM RAIL — slim self-owned rail on the right edge (the fleet register
//     yields the band via fleetHud CSS), micro-type bands FLEET / ORBIT /
//     RING / STREET, boundary ticks, a marker eased to the camera's district
//     distance that slides into STREET as a dive fires. Hidden under
//     ?freeze=1 so capture determinism is untouched.
//
// Contract-defensive like every fleet module: roster / slot / stream access
// goes through the same adapters machines.js uses, update is signature-
// tolerant, and a missing machines group just leaves picking dormant. All
// DOM/GL allocated in init(); the update hot path allocates nothing beyond
// the gated ≤10Hz card text writes. Import-clean under plain node.

import * as THREE from 'three';
import { PALETTE as LIB_PALETTE, CSS as LIB_CSS } from '../lib/palette.js';
// Namespace import on purpose: contextCapFor is landing in palette.js alongside
// this work, and a named import of an export that is not there yet is a hard
// link error. Read it off the namespace and degrade to the local banding below.
import * as PAL from '../lib/palette.js';
// The hover card's SESSION row paints a working directory. The rule that takes
// the OS username out of one is src/lib/labels.js and ONLY src/lib/labels.js —
// the copy that used to live here knew Windows slugs and nothing else, so every
// macOS and Linux session put the username under the cursor. Never re-implement
// it here.
import { projectTag } from '../lib/labels.js';

// ---- tunables ---------------------------------------------------------------
const MAX_SLOTS = 48;          // mirror machines.js pool cap
const CLICK_SLOP = 6;          // px — max pointer travel for a click
const CLICK_MS = 400;          // ms — max press duration for a click
const CARD_DX = 18;            // px — cursor → card gap, horizontal
const CARD_DY = 14;            // px — cursor → card gap, vertical
const EDGE = 10;               // px — viewport margin the card never crosses
const SAME_REFRESH_MS = 150;   // same-target live-value refresh cap (~7Hz)
const IDLE_AFTER = 60;         // s without event growth → LIVE decays to IDLE
const RECENT_MS = 3_600_000;   // inactive but mtime < 1h → IDLE (machines' ember)
const FADE_OUT = 0.35;         // s — dive fade to black (spec ~350ms)
const FADE_IN = 0.4;           // s — ascend fade from black (spec ~400ms)
const DIVE_R = 8;              // u — dive-by-zoom proximity threshold (spec)
const DIVE_HOLD = 0.4;         // s inside the threshold before the dive fires
const WHEEL_FRESH = 1.2;       // s a zoom-in wheel tick keeps dive intent alive
const RAIL_BANDS = ['FLEET', 'ORBIT', 'RING', 'STREET'];
const RAIL_D = [95, 60, 26, 10, 4]; // district distance at each band boundary
const RAIL_EASE = 5;           // 1/s marker pursuit
const RAIL_EASE_DIVE = 10;     // 1/s marker pursuit while a dive is firing
const GLOW_MAX = 0.32;         // hover glow opacity ceiling — marks whisper
const GLOW_EASE = 10;          // 1/s glow opacity pursuit
const LOOK_Y = 1.5;            // machine mid-height for distance measures
// Fallback context-window bands — MUST mirror palette.js's CONTEXT_BANDS /
// CONTEXT_HEADROOM (see capFrom below for why the copy exists).
const CAP_BANDS = [200_000, 500_000, 1_000_000, 2_000_000];
const CAP_HEADROOM = 1.1;
const SOURCE_LABEL = { claude: 'CLAUDE', codex: 'CODEX', hermes: 'HERMES', openclaw: 'OPENCLAW' };
const CARD_ROWS = 5;           // SESSION · HARNESS · STATUS · CONTEXT · AGENTS

// ---- pure helpers (no DOM at module scope — import-clean under node) --------
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const easeIO = (x) => {
  const c = clamp(x, 0, 1);
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
};

function fmtTok(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'K';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

// ---- per-session context ceiling (mirrors machines.js) ----------------------
// The card must name the ruler it measured against, and the ruler is the
// session's own window. Order of preference:
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

// palette.js owns the real derivation; the fleet holds roster/library ROWS
// rather than parsed sessions, so it hands contextCapFor a session-shaped
// {meta} assembled from the row.
// NOTE (duplication): bandCap mirrors that function's banding purely as a
// fallback for a build where the export is absent — the same copy lives in
// machines.js and fleetHud.js, which keep their own row bags. If palette's
// bands or headroom change, change them in all three (or drop the fallback).
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

// Resolve (and ratchet) a record's ceiling. Monotonic on the inferred path so
// the card's denominator never shrinks mid-stream. 0 means "still unknown".
function capOf(rec, liveTok) {
  const lib = S.lib?.get(rec.id);
  const explicit = firstPositive(rec.capHint, lib?.cap);
  if (explicit) { rec.cap = explicit; return rec.cap; }
  const peak = Math.max(rec.peak || 0, Number(liveTok) || 0, Number(lib?.peak) || 0);
  rec.peak = peak;
  const model = rec.model ?? lib?.model ?? null;
  // nothing known at all → leave the ceiling unknown rather than invent one
  const c = (peak > 0 || model) ? capFrom(model, peak) : null;
  if (c && c > rec.cap) rec.cap = c;
  return rec.cap;
}

// 'codex' → 'CODEX'. Absent source stays null so nothing is invented.
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

// tokens over the ceiling, with the percentage that only means something once
// the denominator is on screen beside it
function fmtCtx(tok, cap) {
  if (!Number.isFinite(tok) || tok <= 0) return '—';
  if (!(cap > 0)) return fmtTok(tok);
  return `${fmtTok(tok)} / ${fmtTok(cap)} · ${Math.round(clamp(tok / cap, 0, 1) * 100)}%`;
}

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

// Accept a LiveTimeline directly or wrapped ({timeline}/{tl}).
function timelineOf(ctx, id) {
  const s = ctx?.streams;
  if (!s) return null;
  const e = typeof s.get === 'function' ? s.get(id) : s[id];
  for (const t of [e, e?.timeline, e?.tl]) {
    if (t && typeof t.contextAt === 'function' && Array.isArray(t.events)) return t;
  }
  return null;
}

// /data/library/index.json → Map(id → {peak, cap, model, source}). Presence
// keys dive routing; the rest feeds the card's ceiling and harness rows.
function normLib(payload) {
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
    map.set(String(id), {
      peak: r.peakContext ?? r.peakCtx ?? r.meta?.peakContext ?? null,
      cap: firstPositive(r.contextCap, r.cap, r.contextWindow,
        r.meta?.contextCap, r.meta?.contextWindow),
      model: r.model ?? r.meta?.model ?? null,
      source: sourceOf(r), srcName: sourceName(r),
    });
  }
  return map;
}

// Camera distance → rail position 0..1 (log-interpolated inside each band).
function railPosFor(d) {
  const n = RAIL_D.length - 1;
  if (!(d > 0)) return 1;
  if (d >= RAIL_D[0]) return 0;
  if (d <= RAIL_D[n]) return 1;
  for (let i = 0; i < n; i++) {
    const hi = RAIL_D[i], lo = RAIL_D[i + 1];
    if (d <= hi && d > lo) {
      return (i + (Math.log(hi) - Math.log(d)) / (Math.log(hi) - Math.log(lo))) / n;
    }
  }
  return 1;
}

// ---------------------------------------------------------------------------
let S = null; // module state bag — filled in init()

// Roster mirror — the exact slot discipline machines.js uses (first roster in
// order, late arrivals append), so slot i here is machine i over there.
function syncRoster(ctx) {
  const roster = rosterOf(ctx);
  if (!roster) return;
  for (const sess of roster) {
    const id = String(sess.id);
    let rec = S.byId.get(id);
    if (!rec) {
      if (S.order.length >= MAX_SLOTS) continue;
      rec = {
        id, id8: id.slice(0, 8), slot: S.order.length,
        label: projectTag(sess.project),
        active: !!sess.active,
        mtime: Number(sess.mtime) || 0,
        sizeMB: Number.isFinite(sess.sizeMB) ? sess.sizeMB : null,
        lastLen: -1,         // stream growth cursor (backlog primes silently)
        lastGrow: -1e9,      // s — last observed live arrival (IDLE until one)
        // harness identity + this session's own context ceiling (source lands
        // with the multi-harness discovery wiring; null = not stated)
        source: sourceOf(sess), srcName: sourceName(sess),
        model: sess.model ?? sess.meta?.model ?? null,
        capHint: firstPositive(sess.contextCap, sess.cap, sess.contextWindow, sess.meta?.contextCap),
        cap: 0, peak: 0,
      };
      S.order.push(rec);
      S.byId.set(id, rec);
    } else {
      rec.active = !!sess.active;
      rec.mtime = Number(sess.mtime) || rec.mtime;
      if (Number.isFinite(sess.sizeMB)) rec.sizeMB = sess.sizeMB;
      // adopt harness / window fields if discovery starts sending them later
      rec.source = rec.source ?? sourceOf(sess);
      rec.srcName = rec.srcName ?? sourceName(sess);
      rec.model = rec.model ?? sess.model ?? sess.meta?.model ?? null;
      rec.capHint = rec.capHint ??
        firstPositive(sess.contextCap, sess.cap, sess.contextWindow, sess.meta?.contextCap);
    }
  }
}

// Resolve machines.js's instanced pools from its published scene structure.
function resolvePicks(ctx) {
  const g = ctx?.scene?.getObjectByName?.('fleet-machines');
  if (!g) return;
  let base = Infinity, any = false;
  for (const o of g.children) {
    if (o.isInstancedMesh) { any = true; if (o.count < base) base = o.count; }
  }
  if (!any || !Number.isFinite(base) || base <= 0) return;
  const picks = [];
  let orb = null;
  for (const o of g.children) {
    if (!o.isInstancedMesh) continue;
    if (o.geometry?.type === 'SphereGeometry') orb = o;   // the core orbs
    if (o.material?.isMeshStandardMaterial) {
      picks.push({ mesh: o, div: Math.max(1, Math.round(o.count / base)) });
    }
  }
  if (!picks.length) return;
  S.picks = picks;
  S.orbMesh = orb;
  console.log(`[fleet/interact] picking online — ${picks.length} instanced pools, base ${base}`);
}

// Nearest-hit raycast over the pickable pools → rec (S.rcSlot carries the slot).
function doRaycast(ctx, x, y) {
  const cam = ctx?.camera;
  if (!cam || !S.picks) return null;
  S.ndc.set((x / S.vw) * 2 - 1, -(y / S.vh) * 2 + 1);
  S.ray.setFromCamera(S.ndc, cam);
  S.hits.length = 0;
  for (const p of S.picks) {
    try { S.ray.intersectObject(p.mesh, false, S.hits); }
    catch (e) { console.error('[fleet/interact] raycast failed', e); }
  }
  if (!S.hits.length) return null;
  const it = S.hits[0];   // intersectObject keeps the target array sorted
  let div = 1;
  for (const p of S.picks) if (p.mesh === it.object) { div = p.div; break; }
  const slot = ((it.instanceId ?? 0) / div) | 0;
  const rec = S.order[slot];
  if (!rec) return null;
  S.rcSlot = slot;
  return rec;
}

// Aligned with machines.js's state ladder: live > ember (recent) > archive.
function statusOf(rec) {
  if (rec.active) return (S.time - rec.lastGrow) < IDLE_AFTER ? 'LIVE' : 'IDLE';
  return (Date.now() - rec.mtime) < RECENT_MS ? 'IDLE' : 'ARCHIVE';
}

// ---- the card ---------------------------------------------------------------
function setRow(i, k, v, cls) {
  const r = S.rowPool[i];
  if (k == null) {
    if (!r.hidden) { r.hidden = true; r.k.style.display = r.v.style.display = 'none'; S.cardDirty = true; }
    return;
  }
  if (r.hidden) { r.hidden = false; r.k.style.display = r.v.style.display = ''; S.cardDirty = true; }
  if (r.k.textContent !== k) { r.k.textContent = k; S.cardDirty = true; }
  if (r.v.textContent !== v) { r.v.textContent = v; S.cardDirty = true; }
  const c = 'fzi-v' + (cls ? ' ' + cls : '');
  if (r.cls !== c) { r.cls = c; r.v.className = c; }
}

function fillCard(ctx, rec) {
  const st = statusOf(rec);
  if (S.titleEl.textContent !== rec.label) { S.titleEl.textContent = rec.label; S.cardDirty = true; }
  setRow(0, 'SESSION', rec.id8.toUpperCase(), '');
  // harness row appears only once a source is actually known — a fleet of
  // Claude-only rows that predate discovery wiring shows the card as before
  const libRow = S.lib?.get(rec.id);
  const src = sourceLabel(rec.source ?? libRow?.source, rec.srcName ?? libRow?.srcName);
  setRow(1, src ? 'HARNESS' : null, src, 'dim');
  setRow(2, 'STATUS', st, st === 'LIVE' ? 'live' : 'dim');
  if (rec.active) {
    const tl = timelineOf(ctx, rec.id);
    const cx = tl ? tl.contextAt(tl.duration) : null;
    const tok = cx ? (cx.ctx || 0) : 0;
    setRow(3, 'CONTEXT', fmtCtx(tok, capOf(rec, tok)), '');
    let agents = 0;
    if (tl) for (const sa of tl.subagents) if (sa.endVt > tl.duration) agents++;
    setRow(4, 'AGENTS', String(agents), agents > 0 ? 'live' : '');
  } else {
    // label stays honest: library peak is context tokens measured against that
    // session's own window; the fallback is transcript mass off the roster,
    // never dressed up as a token count and never given a denominator
    const peak = S.lib?.get(rec.id)?.peak;
    if (peak != null) setRow(3, 'PEAK CTX', fmtCtx(peak, capOf(rec)), 'dim');
    else setRow(3, 'TRANSCRIPT', rec.sizeMB != null ? rec.sizeMB.toFixed(1) + 'MB' : '—', 'dim');
    setRow(4, null);
  }
  // re-measure only when a content write actually fired (no per-frame reflow)
  if (S.cardDirty || !S.cw) {
    S.cardDirty = false;
    S.cw = S.card.offsetWidth;
    S.ch = S.card.offsetHeight;
  }
}

function placeCard(px, py) {
  let x = px + CARD_DX;
  if (x + S.cw + EDGE > S.vw) x = px - S.cw - CARD_DX;
  x = clamp(x, EDGE, Math.max(EDGE, S.vw - S.cw - EDGE));
  let y = py + CARD_DY;
  if (y + S.ch + EDGE > S.vh) y = py - S.ch - CARD_DY;
  y = clamp(y, EDGE, Math.max(EDGE, S.vh - S.ch - EDGE));
  S.card.style.transform = `translate3d(${x | 0}px,${y | 0}px,0)`;
}

function slideIn() {
  if (S.freeze) return;
  const b = S.bodyEl;
  b.classList.remove('slide');
  void b.offsetWidth;   // restart the entrance animation (hover change only)
  b.classList.add('slide');
}

// New-target response is same-frame (<120ms law); same-target live values
// refresh at ≤~7Hz. Cursor and glow track the hover.
function applyHover(ctx, rec, slot) {
  const same = S.hoverRec === rec;
  const ms = performance.now();
  if (!same) {
    S.hoverRec = rec;
    S.hoverSlot = slot;
    if (rec) {
      fillCard(ctx, rec);
      S.card.classList.add('show');
      slideIn();
      S.hoverAt = ms;
      S.glowT = 1;
    } else {
      S.card.classList.remove('show');
      S.glowT = 0;
    }
  } else if (rec) {
    S.hoverSlot = slot;
    if (ms - S.hoverAt >= SAME_REFRESH_MS) { fillCard(ctx, rec); S.hoverAt = ms; }
  }
  const cursor = rec ? 'pointer' : '';
  if (cursor !== S.cursor) {
    S.cursor = cursor;
    if (S.canvas) S.canvas.style.cursor = cursor;
  }
}

// ---- DIVE -------------------------------------------------------------------
function diveUrl(rec) {
  const id = encodeURIComponent(rec.id);
  if (rec.active) return '/?live=' + id;
  if (S.lib?.has(rec.id)) return '/?session=' + id;
  return '/?live=' + id;   // the tail can replay any allowlisted session
}

function startDive(rec) {
  if (S.diving) return;
  S.diving = true;                       // rail marker slides into STREET
  applyHover(S.ctx, null, -1);           // card off, glow decays, cursor resets
  try { sessionStorage.setItem('cspaceFade', '1'); } catch { /* private mode */ }
  const url = diveUrl(rec);
  S.ctx.fade.out(() => { try { location.assign(url); } catch { /* unloading */ } });
}

// ---- DOM builders (init-only) ------------------------------------------------
function buildFade(ctx) {
  const C = ctx?.CSS ?? LIB_CSS;
  const el = document.createElement('div');
  el.id = 'fleet-fade';
  el.style.cssText =
    `position:fixed;inset:0;z-index:90;background:${C.void};opacity:0;pointer-events:none;`;
  document.body.appendChild(el);
  S.fadeEl = el;
}

function buildCard(ctx) {
  const C = ctx?.CSS ?? LIB_CSS;
  const st = document.createElement('style');
  st.id = 'fzi-style';
  st.textContent = `
.fzi-card{position:fixed;left:0;top:0;z-index:40;pointer-events:none;
 min-width:190px;max-width:300px;padding:10px 13px 9px;
 color:${C.hudText};
 font-family:"Cascadia Code","Cascadia Mono",ui-monospace,Consolas,monospace;
 font-size:10px;line-height:1.4;text-transform:uppercase;
 -webkit-font-smoothing:antialiased;user-select:none;
 background:
  repeating-linear-gradient(0deg,${C.cache}14 0 1px,transparent 1px 3px),
  linear-gradient(168deg,${C.coreShell}f5 0%,${C.void}e8 48%,${C.coreShell}ef 100%);
 -webkit-backdrop-filter:blur(8px) brightness(.65) saturate(1.25);
 backdrop-filter:blur(8px) brightness(.65) saturate(1.25);
 box-shadow:inset 0 0 0 1px ${C.cache}3a,0 0 24px ${C.void}d0,0 0 12px ${C.cache}1c;
 opacity:0;transition:opacity .09s ease-out;will-change:transform;}
.fzi-card.show{opacity:1;}
.fzi-card::before,.fzi-card::after,.fzi-card .fzi-x::before,.fzi-card .fzi-x::after{
 content:"";position:absolute;width:12px;height:12px;pointer-events:none;
 filter:drop-shadow(0 0 3px ${C.coreEnergy}59);}
.fzi-card::before{top:-1px;left:-1px;border-top:1px solid ${C.coreEnergy};border-left:1px solid ${C.coreEnergy};}
.fzi-card::after{bottom:-1px;right:-1px;border-bottom:1px solid ${C.coreEnergy};border-right:1px solid ${C.coreEnergy};}
.fzi-card .fzi-x{position:absolute;inset:0;}
.fzi-card .fzi-x::before{top:-1px;right:-1px;border-top:1px solid ${C.coreEnergy};border-right:1px solid ${C.coreEnergy};}
.fzi-card .fzi-x::after{bottom:-1px;left:-1px;border-bottom:1px solid ${C.coreEnergy};border-left:1px solid ${C.coreEnergy};}
.fzi-head{display:flex;justify-content:space-between;align-items:baseline;gap:14px;
 padding-bottom:6px;margin-bottom:6px;border-bottom:1px solid ${C.cache}66;}
.fzi-title{font-size:10.5px;letter-spacing:.24em;color:${C.hudText};white-space:nowrap;
 overflow:hidden;text-overflow:ellipsis;text-shadow:0 0 8px ${C.cache}55,0 0 18px ${C.cache}22;}
.fzi-kind{font-size:8px;letter-spacing:.3em;color:${C.cache};opacity:.85;flex:none;}
.fzi-rows{display:grid;grid-template-columns:max-content minmax(0,1fr);
 column-gap:16px;row-gap:3px;}
.fzi-k{font-size:8.5px;letter-spacing:.22em;color:${C.hudDim};align-self:baseline;}
.fzi-v{font-size:9.5px;letter-spacing:.12em;color:${C.hudText};text-align:right;
 white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 0 6px ${C.cache}33;}
.fzi-v.live{color:${C.cache};text-shadow:0 0 6px ${C.cache}55;}
.fzi-v.dim{color:${C.hudDim};text-shadow:none;}
.fzi-card.show .fzi-body.slide{animation:fziSlide .12s cubic-bezier(.2,.9,.3,1) both;}
@keyframes fziSlide{from{opacity:0;transform:translateY(5px);}to{opacity:1;transform:none;}}

/* --- fleet zoom rail: right edge, micro-type, pointer-transparent --- */
.fzr{position:fixed;right:10px;top:50%;transform:translateY(-50%);
 height:min(300px,42vh);width:46px;z-index:12;pointer-events:none;user-select:none;
 font-family:"Cascadia Code","Cascadia Mono",ui-monospace,Consolas,monospace;
 text-transform:uppercase;animation:fzrIn .7s cubic-bezier(.2,.9,.2,1) .55s both;}
@keyframes fzrIn{from{opacity:0;transform:translateY(-50%) translateX(8px);}
 to{opacity:1;transform:translateY(-50%);}}
.fzr-line{position:absolute;right:13px;top:0;bottom:0;width:1px;
 background:linear-gradient(180deg,transparent,${C.hudDim}aa 10%,${C.hudDim}aa 90%,transparent);}
.fzr-tick{position:absolute;right:11px;width:5px;height:1px;background:${C.hudDim}88;}
.fzr-lab{position:absolute;right:23px;transform:translateY(-50%);font-size:7px;
 letter-spacing:.24em;color:${C.hudDim};white-space:nowrap;
 transition:color .3s ease,text-shadow .3s ease;}
.fzr-lab.on{color:${C.hudText};text-shadow:0 0 6px ${C.cache}55;}
.fzr-mk{position:absolute;right:9px;top:-1px;width:9px;height:2px;
 background:${C.cache};box-shadow:0 0 6px ${C.cache}99;will-change:transform;}
`;
  document.head.appendChild(st);
  S.styleEl = st;

  const card = document.createElement('div');
  card.className = 'fzi-card';
  const x = document.createElement('div');
  x.className = 'fzi-x';
  card.appendChild(x);
  const body = document.createElement('div');
  body.className = 'fzi-body';
  card.appendChild(body);
  const head = document.createElement('div');
  head.className = 'fzi-head';
  body.appendChild(head);
  const title = document.createElement('div');
  title.className = 'fzi-title';
  head.appendChild(title);
  const kind = document.createElement('div');
  kind.className = 'fzi-kind';
  kind.textContent = 'MACHINE';
  head.appendChild(kind);
  const rows = document.createElement('div');
  rows.className = 'fzi-rows';
  body.appendChild(rows);
  S.rowPool = [];
  for (let i = 0; i < CARD_ROWS; i++) {
    const k = document.createElement('div');
    k.className = 'fzi-k';
    const v = document.createElement('div');
    v.className = 'fzi-v';
    rows.appendChild(k);
    rows.appendChild(v);
    S.rowPool.push({ k, v, hidden: false, cls: 'fzi-v' });
  }
  document.body.appendChild(card);
  S.card = card;
  S.bodyEl = body;
  S.titleEl = title;
}

function buildRail() {
  const host = document.getElementById('hud') ?? document.body;
  const rail = document.createElement('div');
  rail.className = 'fzr';
  const line = document.createElement('div');
  line.className = 'fzr-line';
  rail.appendChild(line);
  for (let i = 0; i <= 4; i++) {          // band boundary ticks
    const t = document.createElement('div');
    t.className = 'fzr-tick';
    t.style.top = `calc(${i * 25}% - ${i === 4 ? 1 : 0}px)`;
    rail.appendChild(t);
  }
  S.railLabs = [];
  for (let i = 0; i < 4; i++) {           // band labels at band centers
    const l = document.createElement('div');
    l.className = 'fzr-lab';
    l.style.top = `${(i + 0.5) * 25}%`;
    l.textContent = RAIL_BANDS[i];
    rail.appendChild(l);
    S.railLabs.push(l);
  }
  const mk = document.createElement('div');
  mk.className = 'fzr-mk';
  rail.appendChild(mk);
  host.appendChild(rail);
  S.railEl = rail;
  S.railMk = mk;
  S.railH = rail.clientHeight || 280;
}

function buildGlow(ctx) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  gr.addColorStop(0, 'rgba(255,255,255,0.9)');
  gr.addColorStop(0.35, 'rgba(255,255,255,0.28)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({
    map: tex, color: (ctx?.PALETTE ?? LIB_PALETTE).coreEnergy,
    transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  S.glow = new THREE.Sprite(mat);
  S.glow.visible = false;
  S.glow.renderOrder = 4;
  ctx?.scene?.add?.(S.glow);
}

function bindInput(ctx) {
  const el = ctx?.renderer?.domElement;
  if (!el) return;
  S.canvas = el;
  el.addEventListener('pointerenter', (e) => {
    S.inside = true;
    S.px = e.clientX; S.py = e.clientY;
  });
  el.addEventListener('pointerleave', () => { S.inside = false; });
  el.addEventListener('pointermove', (e) => {
    S.px = e.clientX; S.py = e.clientY;
    S.inside = true;
    if (S.down && !S.suppress &&
        Math.hypot(e.clientX - S.down.x, e.clientY - S.down.y) > CLICK_SLOP) {
      S.suppress = true;   // it's an orbit drag — mute hover until release
    }
  });
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    S.px = e.clientX; S.py = e.clientY;
    const rec = S.diving ? null : doRaycast(ctx, e.clientX, e.clientY);
    S.down = { x: e.clientX, y: e.clientY, t: performance.now(), rec };
  });
  el.addEventListener('pointerup', (e) => {
    const d = S.down, dragged = S.suppress;
    S.down = null;
    S.suppress = false;
    if (!d || dragged || e.button !== 0 || S.diving) return;
    if (performance.now() - d.t > CLICK_MS) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP) return;
    const rec = doRaycast(S.ctx, e.clientX, e.clientY);
    if (rec && rec === d.rec) startDive(rec);
  });
  el.addEventListener('pointercancel', () => { S.down = null; S.suppress = false; });
  // dive intent only — fleetCamera owns the zoom itself (deltaY<0 = zooming in)
  el.addEventListener('wheel', (e) => {
    if (e.deltaY < 0) S.lastZoomIn = S.time;
  }, { passive: true });
}

// ---------------------------------------------------------------------------
export default {
  name: 'fleetInteract',

  init(ctx) {
    let params = ctx?.params;
    if (!params) {
      try { params = new URLSearchParams(typeof location !== 'undefined' ? location.search : ''); }
      catch { params = new URLSearchParams(''); }
    }
    const dom = typeof document !== 'undefined' && typeof window !== 'undefined';
    S = {
      ctx, dom,
      freeze: params.get('freeze') === '1',
      time: 0, rosterTimer: 0,
      order: [], byId: new Map(),
      lib: null,
      picks: null, orbMesh: null, rcSlot: -1,
      ray: new THREE.Raycaster(), ndc: new THREE.Vector2(), hits: [],
      tmpMat: new THREE.Matrix4(), tmpPos: new THREE.Vector3(),
      px: 0, py: 0, inside: false, suppress: false, down: null,
      vw: dom ? innerWidth : 1920, vh: dom ? innerHeight : 1080,
      canvas: null, cursor: '',
      card: null, bodyEl: null, titleEl: null, rowPool: [],
      cardDirty: false, cw: 0, ch: 0,
      hoverRec: null, hoverSlot: -1, hoverAt: 0,
      glow: null, glowA: 0, glowT: 0, glowSlot: -1,
      fadeEl: null, fadeA: 0,
      fade: { mode: null, from: 0, t: 0, dur: 0, cb: null },
      diving: false, lastZoomIn: -1e9, diveAcc: 0,
      railEl: null, railMk: null, railLabs: null, railH: 280,
      railPos: 0, railBand: -1,
      styleEl: null,
    };

    // ---- ctx.fade — the dive/ascend handshake, published for every module --
    if (dom) buildFade(ctx);
    ctx.fade = {
      // eased fade to black (~350ms), then cb — the DIVE half
      out: (cb, dur = FADE_OUT) => {
        if (!S?.fadeEl) { if (cb) cb(); return; }
        S.fadeEl.style.pointerEvents = 'auto';   // world stops receiving input
        S.fade = { mode: 'out', from: S.fadeA, t: 0, dur, cb: cb ?? null };
      },
      // eased fade in from black (~400ms) — the ASCEND half
      in: (dur = FADE_IN) => {
        if (!S?.fadeEl) return;
        S.fade = { mode: 'in', from: S.fadeA, t: 0, dur, cb: null };
      },
    };

    // arriving from a dive/ascend elsewhere? clear the key and fade in
    let arrived = false;
    try {
      if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('cspaceFade') === '1') {
        sessionStorage.removeItem('cspaceFade');
        arrived = true;
      }
    } catch { /* storage unavailable — no handshake */ }
    if (arrived && dom && !S.freeze) {
      S.fadeA = 1;
      S.fadeEl.style.opacity = '1';
      ctx.fade.in();
    }

    if (!dom) return;   // headless: fade contract exposed, nothing else to build

    buildCard(ctx);
    if (!S.freeze) buildRail();   // rail is hidden under ?freeze=1 (spec)
    buildGlow(ctx);
    bindInput(ctx);

    // library index — dive routing (?session) + archived peaks for the card
    if (ctx.library) {
      S.lib = ctx.library instanceof Map ? ctx.library : normLib(ctx.library);
    } else if (typeof fetch === 'function') {
      fetch('/data/library/index.json')
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (j && S) S.lib = normLib(j); })
        .catch(() => { /* no library yet — dives fall through to ?live */ });
    }

    syncRoster(ctx);
  },

  update(dt, a, b) {
    if (!S) return;
    // signature-tolerant: (dt, state, ctx) or (dt, ctx) — find the ctx bag
    const ctx = (b && (b.scene || b.streams || b.THREE)) ? b
      : (a && (a.scene || a.streams || a.THREE)) ? a : S.ctx;
    S.ctx = ctx;
    const now = (S.time += dt);

    // ---- fade drive (always first — dives depend on it even mid-teardown) ---
    const f = S.fade;
    if (f.mode && S.fadeEl) {
      f.t += dt;
      const p = Math.min(f.t / f.dur, 1);
      const e = easeIO(p);
      S.fadeA = f.mode === 'out' ? f.from + (1 - f.from) * e : f.from * (1 - e);
      S.fadeEl.style.opacity = S.fadeA.toFixed(3);
      if (p >= 1) {
        const cb = f.cb;
        f.mode = null;
        f.cb = null;
        if (S.fadeA < 0.01) S.fadeEl.style.pointerEvents = 'none';
        if (cb) {
          try { cb(); }
          catch (err) { console.error('[fleet/interact] fade callback threw', err); }
        }
      }
    }

    if (!S.dom) return;

    // ---- roster mirror ~1 Hz (first pass immediate) --------------------------
    if ((S.rosterTimer -= dt) <= 0) {
      S.rosterTimer = 1.0;
      syncRoster(ctx);
    }

    // ---- stream growth stamps (≤4 live streams; drives LIVE vs IDLE) ---------
    const streams = ctx?.streams;
    if (streams && typeof streams.forEach === 'function') {
      streams.forEach((entry, id) => {
        const rec = S.byId.get(String(id));
        if (!rec) return;
        let tl = null;
        for (const t of [entry, entry?.timeline, entry?.tl]) {
          if (t && Array.isArray(t.events)) { tl = t; break; }
        }
        if (!tl) return;
        const n = tl.events.length;
        if (rec.lastLen < 0 || n < rec.lastLen) rec.lastLen = n;  // backlog/reopen primes silently
        else if (n > rec.lastLen) { rec.lastLen = n; rec.lastGrow = now; }
      });
    }

    if (!S.picks) resolvePicks(ctx);

    // ---- hover (raycast every frame the pointer is in play — the drift
    //      camera moves constantly, so a parked cursor still tracks truth) ----
    if (!S.diving && S.picks && S.inside && !S.suppress) {
      const rec = doRaycast(ctx, S.px, S.py);
      applyHover(ctx, rec, rec ? S.rcSlot : -1);
      if (S.hoverRec) placeCard(S.px, S.py);
    } else if (S.hoverRec) {
      applyHover(ctx, null, -1);
    }

    // ---- hover glow: eased pursuit, breathes, rides the hovered orb ----------
    if (S.glow) {
      const gk = 1 - Math.exp(-dt * GLOW_EASE);
      S.glowA += (S.glowT - S.glowA) * gk;
      if (S.hoverRec) S.glowSlot = S.hoverSlot;
      if (S.glowA < 0.005 && S.glowT === 0) {
        if (S.glow.visible) S.glow.visible = false;
      } else {
        let ok = false;
        if (S.orbMesh && S.glowSlot >= 0 && S.glowSlot < S.orbMesh.count) {
          S.orbMesh.getMatrixAt(S.glowSlot, S.tmpMat);
          const te = S.tmpMat.elements;
          if (Math.abs(te[0]) + Math.abs(te[5]) + Math.abs(te[10]) > 1e-3) {
            S.glow.position.set(te[12], te[13], te[14]);
            ok = true;
          }
        }
        S.glow.visible = ok;
        if (ok) {
          S.glow.material.opacity = GLOW_MAX * S.glowA * (0.9 + 0.1 * Math.sin(now * 1.7));
          S.glow.scale.setScalar(1.7 * (1 + 0.05 * Math.sin(now * 2.1)) * (0.8 + 0.2 * S.glowA));
        }
      }
    }

    // ---- dive-by-zoom: wheel intent + sustained proximity to a live machine --
    if (!S.freeze && !S.diving && S.order.length && ctx?.camera) {
      const cam = ctx.camera;
      let cand = null, cd = Infinity;
      if (S.hoverRec?.active) {
        cand = S.hoverRec;
        slotOf(ctx, cand.slot, S.tmpPos);
        cd = Math.hypot(cam.position.x - S.tmpPos.x,
          cam.position.y - (S.tmpPos.y + LOOK_Y), cam.position.z - S.tmpPos.z);
      } else {
        for (const rec of S.order) {
          if (!rec.active) continue;
          slotOf(ctx, rec.slot, S.tmpPos);
          const d = Math.hypot(cam.position.x - S.tmpPos.x,
            cam.position.y - (S.tmpPos.y + LOOK_Y), cam.position.z - S.tmpPos.z);
          if (d < cd) { cd = d; cand = rec; }
        }
      }
      if (cand && cd < DIVE_R && now - S.lastZoomIn < WHEEL_FRESH) {
        if ((S.diveAcc += dt) >= DIVE_HOLD) startDive(cand);
      } else {
        S.diveAcc = 0;
      }
    }

    // ---- zoom rail: marker eased to the camera's district distance -----------
    if (S.railEl && ctx?.camera) {
      // a zero-height boot viewport (collapsed pane) leaves the one-shot
      // measure useless — re-measure until the rail has real extent
      if (S.railH < 40) S.railH = S.railEl.clientHeight || S.railH;
      let target;
      if (S.diving) {
        target = 1;   // the marker slides into STREET as the fade fires
      } else {
        const cam = ctx.camera;
        const bb = ctx?.cityLayout?.bounds;
        const cx = bb ? (bb.minX + bb.maxX) / 2 : 0;
        const cz = bb ? (bb.minZ + bb.maxZ) / 2 : -2;
        // district distance = min(center distance, nearest machine distance)
        let d = Math.hypot(cam.position.x - cx, cam.position.y - LOOK_Y, cam.position.z - cz);
        for (const rec of S.order) {
          slotOf(ctx, rec.slot, S.tmpPos);
          const dd = Math.hypot(cam.position.x - S.tmpPos.x,
            cam.position.y - (S.tmpPos.y + LOOK_Y), cam.position.z - S.tmpPos.z);
          if (dd < d) d = dd;
        }
        target = railPosFor(d);
      }
      const k = 1 - Math.exp(-dt * (S.diving ? RAIL_EASE_DIVE : RAIL_EASE));
      S.railPos += (target - S.railPos) * k;
      S.railMk.style.transform = `translate3d(0,${(S.railPos * S.railH).toFixed(1)}px,0)`;
      const bi = clamp((S.railPos * 4) | 0, 0, 3);
      if (bi !== S.railBand) {
        S.railBand = bi;
        for (let i = 0; i < 4; i++) S.railLabs[i].classList.toggle('on', i === bi);
      }
    }
  },

  resize(w, h) {
    if (!S) return;
    S.vw = w;
    S.vh = h;
    if (S.railEl) S.railH = S.railEl.clientHeight || S.railH;
  },

  dispose() {
    if (!S) return;
    S.card?.remove();
    S.styleEl?.remove();
    S.railEl?.remove();
    S.fadeEl?.remove();
    if (S.glow) S.ctx?.scene?.remove?.(S.glow);
    S = null;
  },
};
