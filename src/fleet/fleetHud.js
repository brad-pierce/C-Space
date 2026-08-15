// fleetHud.js — FLEET VIEW: diegetic HUD chrome. Pure DOM/CSS in the HUD layer,
// same typographic language as the main page (src/modules/hud.js — scrim panels,
// Cascadia mono, uppercase micro-type, corner brackets, glitch entrance).
//
//   · IDENTITY (top-left)   — "THE FLEET" + "<n> SESSIONS // <m> LIVE" + tail source
//   · REGISTER (right rail) — one compact row per roster session:
//       live dot (pulsing cyan) or archive glyph (slate ◇) · project label ·
//       60s event-rate sparkline (live rows) · harness tag on non-Claude rows ·
//       current ctx tokens (live) or library peak ctx (archived; roster sizeMB
//       dim when no library stats), each over THAT SESSION'S OWN context ceiling
//       rather than a global 1M — the register exists to be compared down the
//       column, and a fixed denominator makes cross-harness rows lie.
//       Click: live → /?live=<id> · archived-with-library → /?session=<id> ·
//       archived-without → / (the flagship — its file is /data/session.json).
//   · VITALS (bottom-center) — EVENTS THIS VISIT (SSE arrivals after the
//       snapshot backlog — history is not "streamed this visit"), LIVE TOOL
//       CALLS (tool_call arrivals among them), STREAMS n/4 (the stream cap).
//
// Every rendered quantity is real: dot = roster liveness, spark bar height =
// events/sec over the last 60s, row value = tokens, vitals = monotonic arrival
// counters. No ornament.
//
// Contract-defensive (written while fleetMain.js was still unpublished; shapes
// mirror src/fleet/machines.js adapters so the two modules agree):
//   roster  — ctx.roster | ctx.sessions | ctx.fleet.roster | ctx.fleet.sessions,
//             else self-fetch http://localhost:5198/sessions (5s cadence).
//   streams — ctx.streams (Map or object of id → LiveTimeline-ish: .events[]
//             append-only + .contextAt()). fleetMain owns tick(); we only read
//             growth. If no ctx.streams materialises within the grace window,
//             the HUD opens its OWN EventSources for active sessions, hard-
//             capped at MAX_STREAMS = 4, and closes them if ctx.streams appears.
//   library — ctx.library, else self-fetch /data/library/index.json (404-safe).
// All DOM built in init(); update() only mutates pooled nodes, gated so nothing
// churns when values are unchanged. Import-clean under node (no top-level DOM).

import { PALETTE as LIB_PALETTE, CSS as LIB_CSS } from '../lib/palette.js';
// Namespace import on purpose: contextCapFor is landing in palette.js alongside
// this work, and a named import of an export that is not there yet is a hard
// link error. Read it off the namespace and degrade to the local banding below.
import * as PAL from '../lib/palette.js';

// ---- tunables ---------------------------------------------------------------
const MAX_ROWS = 40;          // server roster caps at 40
const MAX_STREAMS = 4;        // hard cap on concurrent SSE streams (spec)
const LIVE_SERVER = 'http://localhost:5198';
const ROSTER_GRACE = 3;       // s to wait for a ctx roster before self-fetching
const STREAM_GRACE = 4;       // s to wait for ctx.streams before self-streaming
const SELF_POLL = 5;          // s between self roster fetches
const UI_HZ = 4;              // text/spark refresh rate
const SPARK_W = 56, SPARK_H = 12, SPARK_DPR = 2;
const SPARK_SECS = 60;        // sparkline window — one bucket per second
const LABEL_MAX = 15;
// Fallback context-window bands — MUST mirror palette.js's CONTEXT_BANDS /
// CONTEXT_HEADROOM (see capFrom below for why the copy exists).
const CAP_BANDS = [200_000, 500_000, 1_000_000, 2_000_000];
const CAP_HEADROOM = 1.1;
// Harness identity: full name for the identity line, 2-char tag for the rail.
const SOURCE_LABEL = { claude: 'CLAUDE', codex: 'CODEX', hermes: 'HERMES', openclaw: 'OPENCLAW' };
const SOURCE_TAG = { codex: 'CX', hermes: 'HM', openclaw: 'OC' };   // claude = the default, untagged

// ---- pure helpers (module scope stays DOM-free) -----------------------------
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const pad = (n, w) => String(n).padStart(w, '0');

// Tail label: reflects the base fleetMain actually discovered (ctx.tailBase:
// '' = same-origin runner, string = explicit base, null/undefined = default).
function tailLabel(ctx) {
  const base = ctx?.tailBase;
  if (base === '') return 'TAIL ' + String(location.host).toUpperCase();
  if (typeof base === 'string') return 'TAIL ' + base.replace(/^https?:\/\//i, '').toUpperCase();
  return 'TAIL LOCALHOST:5198';
}

// "C--Users-you-myapp" → "MYAPP" (same rule as machines.js)
function projectLabel(proj) {
  let s = String(proj ?? '')
    .replace(/^[A-Za-z]--/, '')
    .replace(/^Users-[^-]+-?/i, '')
    .replace(/^-+|-+$/g, '');
  if (!s) s = 'HOME';
  return s.toUpperCase().slice(0, LABEL_MAX);
}

function fmtTok(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'K';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

// ---- per-session context ceiling (mirrors machines.js) ----------------------
// A row's readout is only comparable to the row above it if both are measured
// against their own window. Order of preference:
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
// machines.js and fleetInteract.js, which keep their own row bags. If palette's
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
const sourceTag = (s) => (!s || s === 'claude' ? '' : SOURCE_TAG[s] ?? s.toUpperCase().slice(0, 2));

// ---- contract adapters (mirror machines.js exactly) -------------------------
function rosterOf(ctx) {
  const cands = [ctx?.roster, ctx?.sessions, ctx?.fleet?.roster, ctx?.fleet?.sessions];
  for (const c of cands) {
    if (Array.isArray(c)) return c;
    if (Array.isArray(c?.sessions)) return c.sessions;
  }
  return null;
}

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
    map.set(String(id), {
      peak: r.peakContext ?? r.peakCtx ?? r.meta?.peakContext ?? null,
      toolCalls: r.toolCalls ?? r.meta?.toolCalls ?? null,
      cap: firstPositive(r.contextCap, r.cap, r.contextWindow,
        r.meta?.contextCap, r.meta?.contextWindow),
      model: r.model ?? r.meta?.model ?? null,
      source: sourceOf(r), srcName: sourceName(r),
    });
  }
  return map;
}

export default {
  name: 'fleetHud',

  init(ctx) {
    const C = ctx?.CSS ?? LIB_CSS;
    const PAL = ctx?.PALETTE ?? LIB_PALETTE;
    void PAL; // palette numerics unused — the HUD is pure CSS-string territory
    this._ctx = ctx ?? {};
    this._nofx = ctx?.params?.get?.('freeze') === '1';

    // ---- state --------------------------------------------------------------
    this._t = 0;                 // wall clock (s since init)
    this._uiAcc = 0;             // UI refresh accumulator
    this._rosterAcc = 1e9;       // roster resync timer (first pass immediate)
    this._esAcc = 1e9;           // self-stream resync timer
    this._rows = new Map();      // id → row record
    this._order = [];            // ids in display order
    this._orderKey = '';
    this._lib = null;            // Map(id → {peak, toolCalls, cap, model, source})
    this._srcSuffix = '~/.CLAUDE/PROJECTS';   // replaced once discovery names sources
    this._agg = { events: 0, tools: 0 };
    this._aggEvStr = ''; this._aggToolStr = ''; this._aggStrStr = '';
    this._idStr = '';
    this._selfRoster = null;     // self-fetched roster (fallback mode)
    this._selfMode = false;
    this._selfTimer = 0;
    this._offline = false;
    this._fetching = false;
    this._es = new Map();        // id → EventSource (self-stream mode only)
    this._streamMode = null;     // null (undecided) | 'ctx' | 'self'
    this._destroyed = false;

    // ---- style --------------------------------------------------------------
    const st = document.createElement('style');
    st.id = 'fleet-hud-style';
    st.textContent = `
.fhud{position:absolute;inset:0;pointer-events:none;color:${C.hudText};
 font-family:"Cascadia Code","Cascadia Mono",ui-monospace,Consolas,monospace;
 text-transform:uppercase;line-height:1.35;-webkit-font-smoothing:antialiased;user-select:none;}
.fhud-h{font-size:9px;letter-spacing:.32em;color:${C.hudDim};margin-bottom:6px;}

/* scrim — identical recipe to the main page: scanlines over near-void gradient,
   backdrop darken so scene bloom never washes the type out */
.fhud-id,.fhud-rail,.fhud-vitals{
 background:
  repeating-linear-gradient(0deg,transparent 0 2px,${C.cache}07 2px 3px),
  linear-gradient(168deg,${C.void}d9 0%,${C.void}b3 55%,${C.void}d9 100%);
 -webkit-backdrop-filter:blur(7px) brightness(.62) saturate(1.15);
 backdrop-filter:blur(7px) brightness(.62) saturate(1.15);
 box-shadow:inset 0 0 0 1px ${C.hudDim}3a,0 0 18px ${C.void}99;}

/* --- identity (top-left) --- */
.fhud-id{position:absolute;top:26px;left:30px;padding:11px 16px;animation:fhudGlitch .95s step-end both;}
.fhud-id::before,.fhud-id::after,.fhud-corners::before,.fhud-corners::after{content:"";position:absolute;width:9px;height:9px;}
.fhud-id::before{top:0;left:0;border-top:1px solid ${C.cache};border-left:1px solid ${C.cache};}
.fhud-id::after{bottom:0;right:0;border-bottom:1px solid ${C.cache};border-right:1px solid ${C.cache};}
.fhud-corners{position:absolute;inset:0;}
.fhud-corners::before{top:0;right:0;border-top:1px solid ${C.hudDim};border-right:1px solid ${C.hudDim};}
.fhud-corners::after{bottom:0;left:0;border-bottom:1px solid ${C.hudDim};border-left:1px solid ${C.hudDim};}
.fhud-title{font-size:14px;letter-spacing:.46em;color:${C.hudText};margin-bottom:7px;
 text-shadow:0 0 8px ${C.cache}55,0 0 22px ${C.cache}22;animation:fhudBreathe 6s ease-in-out infinite alternate;}
.fhud-cursor{display:inline-block;margin-left:.3em;color:${C.cache};animation:fhudBlink 1.1s step-end infinite;}
.fhud-sub{font-size:10px;letter-spacing:.3em;color:${C.cache};opacity:.85;margin-bottom:4px;}
.fhud-sub2{font-size:9px;letter-spacing:.26em;color:${C.hudDim};}
.fhud-sub2.err{color:${C.error};text-shadow:0 0 6px ${C.error}55;}
@keyframes fhudGlitch{
 0%{opacity:0;clip-path:inset(45% 0 45% 0);transform:translateX(-7px);}
 8%{opacity:.9;clip-path:inset(8% 0 64% 0);transform:translateX(4px);text-shadow:-2px 0 ${C.fresh},2px 0 ${C.cache};}
 16%{opacity:.25;clip-path:inset(62% 0 6% 0);transform:translateX(-3px);}
 26%{opacity:1;clip-path:inset(0 0 0 0);transform:translateX(2px);text-shadow:2px 0 ${C.fresh},-2px 0 ${C.cache};}
 42%{opacity:1;transform:translateX(0);text-shadow:none;}
 55%{opacity:.85;clip-path:inset(30% 0 30% 0);}
 62%{opacity:1;clip-path:inset(0 0 0 0);}
 100%{opacity:1;transform:none;text-shadow:none;}}
@keyframes fhudBlink{50%{opacity:0;}}
@keyframes fhudBreathe{from{opacity:.88;}to{opacity:1;}}

/* --- entrance stagger --- */
.fhud-rail,.fhud-vitals{animation:fhudIn .7s cubic-bezier(.2,.9,.2,1) both;}
.fhud-rail{animation-delay:.35s}.fhud-vitals{animation-delay:.55s}
@keyframes fhudIn{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}
.fhud.nofx *{animation:none !important;}

/* --- session register (right rail) --- */
/* right:72px yields the screen edge to fleetInteract's zoom rail (rail band
   plus its widest band label); the rail is hidden under ?freeze=1 (nofx), so
   frozen captures reclaim the band below. */
.fhud-rail{position:absolute;top:16px;right:72px;width:272px;padding:10px 10px 8px;
 pointer-events:auto;max-height:calc(100vh - 130px);display:flex;flex-direction:column;}
.fhud.nofx .fhud-rail{right:18px;}
.fhud-rail .fhud-h{margin-left:2px;}
.fhud-list{min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;
 scrollbar-color:${C.hudDim}66 transparent;}
.fhud-list::-webkit-scrollbar{width:4px;}
.fhud-list::-webkit-scrollbar-thumb{background:${C.hudDim}66;}
.fhud-row{display:flex;align-items:center;gap:7px;height:19px;padding:0 5px;cursor:pointer;
 font-size:8.5px;letter-spacing:.16em;color:${C.hudDim};
 transition:background .15s ease,color .15s ease;}
.fhud-row:hover{background:${C.cache}14;color:${C.hudText};}
.fhud-row:hover .fhud-lab{color:${C.coreHot};text-shadow:0 0 6px ${C.cache}66;}
.fhud-dot{flex:none;width:10px;text-align:center;font-size:8px;color:${C.hudDim};}
.fhud-row.live .fhud-dot{color:${C.cache};text-shadow:0 0 6px ${C.cache}aa;animation:fhudPulse 2.2s ease-in-out infinite;}
.fhud-row.live .fhud-dot.hot{animation:fhudHot .6s cubic-bezier(.16,1,.3,1) both;}
@keyframes fhudPulse{0%,100%{opacity:.55;}50%{opacity:1;}}
@keyframes fhudHot{0%{color:${C.coreHot};text-shadow:0 0 10px ${C.cache};}100%{color:${C.cache};text-shadow:0 0 6px ${C.cache}aa;}}
.fhud-lab{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;
 color:${C.hudText};transition:color .15s ease;}
.fhud-row:not(.live) .fhud-lab{color:${C.hudDim};}
.fhud-spark{flex:none;width:${SPARK_W}px;height:${SPARK_H}px;display:none;}
.fhud-row.live .fhud-spark{display:block;}
/* harness tag — non-Claude rows only, amber so a mixed fleet is readable at a
   glance without a legend; empty tag collapses to nothing (no reserved gap) */
.fhud-src{flex:none;font-size:7px;letter-spacing:.1em;color:${C.output};opacity:.8;}
.fhud-src:empty{display:none;}
/* value carries tokens OVER the row's own ceiling — the denominator is the
   whole point, so it gets width rather than a tooltip */
.fhud-val{flex:none;min-width:9ch;text-align:right;font-size:8.5px;color:${C.cache};
 white-space:nowrap;text-shadow:0 0 5px ${C.cache}44;}
.fhud-row:not(.live) .fhud-val{color:${C.hudDim};text-shadow:none;}
.fhud-more{height:17px;padding:2px 5px 0;font-size:7.5px;letter-spacing:.24em;color:${C.hudDim};display:none;}
.fhud-empty{padding:4px 5px;font-size:8.5px;letter-spacing:.2em;color:${C.hudDim};}
.fhud-empty.err{color:${C.error};text-shadow:0 0 6px ${C.error}44;}

/* --- aggregate vitals (bottom-center) — centered via auto margins so the
   entrance animation's transform fill can't knock it off axis --- */
.fhud-vitals{position:absolute;bottom:16px;left:0;right:0;margin:0 auto;width:max-content;
 padding:8px 16px;display:flex;align-items:baseline;gap:20px;white-space:nowrap;}
.fhud-pair{display:flex;align-items:baseline;gap:8px;font-size:9px;letter-spacing:.22em;}
.fhud-k{color:${C.hudDim};}
.fhud-v{color:${C.hudText};text-shadow:0 0 6px ${C.cache}44;}
.fhud-v.tools{color:${C.output};text-shadow:0 0 6px ${C.output}44;}
`;
    document.head.appendChild(st);
    this._styleEl = st;

    // ---- DOM ----------------------------------------------------------------
    const div = (cls, parent, text) => {
      const d = document.createElement('div');
      if (cls) d.className = cls;
      if (text != null) d.textContent = text;
      parent.appendChild(d);
      return d;
    };
    const span = (cls, parent, text) => {
      const s = document.createElement('span');
      if (cls) s.className = cls;
      if (text != null) s.textContent = text;
      parent.appendChild(s);
      return s;
    };

    const host = document.getElementById('hud') ?? document.body;
    const root = div('fhud' + (this._nofx ? ' nofx' : ''), host);
    this._root = root;

    // (1) identity
    const idBox = div('fhud-id', root);
    div('fhud-corners', idBox);
    const title = div('fhud-title', idBox, 'THE FLEET');
    span('fhud-cursor', title, '_');
    this._idSub = div('fhud-sub', idBox, '— SESSIONS // — LIVE');
    this._idSrc = div('fhud-sub2', idBox, tailLabel(ctx) + ' // ' + this._srcSuffix);

    // (2) session register — pooled rows, delegated click
    const rail = div('fhud-rail', root);
    div('fhud-h', rail, '// FLEET REGISTER');
    const list = div('fhud-list', rail);
    this._listEl = list;
    this._emptyEl = div('fhud-empty', list, 'SCANNING FOR SESSIONS…');
    this._pool = [];
    for (let i = 0; i < MAX_ROWS; i++) {
      const row = document.createElement('div');
      row.className = 'fhud-row';
      row.style.display = 'none';
      const dot = span('fhud-dot', row, '◇');
      const lab = span('fhud-lab', row, '');
      const spark = document.createElement('canvas');
      spark.className = 'fhud-spark';
      spark.width = SPARK_W * SPARK_DPR;
      spark.height = SPARK_H * SPARK_DPR;
      row.appendChild(spark);
      const src = span('fhud-src', row, '');
      const val = span('fhud-val', row, '—');
      list.appendChild(row);
      this._pool.push({ row, dot, lab, spark, sctx: spark.getContext('2d'), src, val });
    }
    this._moreEl = div('fhud-more', rail, '');
    list.addEventListener('click', (e) => {
      const el = e.target.closest('.fhud-row');
      const id = el?.dataset.id;
      if (id) this._navigate(id);
    });

    // (3) aggregate vitals
    const vit = div('fhud-vitals', root);
    const pair = (key, cls) => {
      const p = div('fhud-pair', vit);
      span('fhud-k', p, key);
      return span('fhud-v' + (cls ? ' ' + cls : ''), p, '00000');
    };
    this._vEvents = pair('EVENTS THIS VISIT');
    this._vTools = pair('LIVE TOOL CALLS', 'tools');
    this._vTools.textContent = '0000';
    this._vStreams = pair('STREAMS');
    this._vStreams.textContent = '0/' + MAX_STREAMS;

    // ---- archived-session stats (may 404 on a fresh install — fine) --------
    if (ctx?.library) {
      this._lib = ctx.library instanceof Map ? ctx.library : normalizeLibrary(ctx.library);
    } else if (typeof fetch === 'function') {
      fetch('/data/library/index.json')
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (j && !this._destroyed) this._lib = normalizeLibrary(j); })
        .catch(() => { /* no library yet — archived rows fall back to sizeMB */ });
    }
  },

  // ---- navigation: the register is the fleet's index into C-SPACE -------
  _navigate(id) {
    const r = this._rows.get(id);
    if (!r) return;
    if (r.active) location.assign('/?live=' + encodeURIComponent(id));
    else if (this._lib?.has(id)) location.assign('/?session=' + encodeURIComponent(id));
    else location.assign('/');
  },

  // Resolve (and ratchet) one row's context ceiling. Monotonic on the inferred
  // path: a live row that grows past a band steps up and never back down, so a
  // readout never rescales downward mid-stream. 0 means "still unknown".
  _capOf(r) {
    const lib = this._lib?.get(r.id);
    const explicit = firstPositive(r.capHint, lib?.cap);
    if (explicit) { r.cap = explicit; return r.cap; }
    const peak = Math.max(r.peak || 0, r.ctxTok || 0, Number(lib?.peak) || 0);
    r.peak = peak;
    const model = r.model ?? lib?.model ?? null;
    // nothing known at all → leave the ceiling unknown rather than invent one
    const c = (peak > 0 || model) ? capFrom(model, peak) : null;
    if (c && c > r.cap) r.cap = c;
    return r.cap;
  },

  // Identity line's second half: the stores actually feeding the roster. Stays
  // the Claude path until discovery reports something else, so a single-harness
  // machine reads exactly as before.
  _setSources(srcs) {
    const known = [...srcs].filter(Boolean).sort();
    const suffix = known.length && !(known.length === 1 && known[0] === 'claude')
      ? known.map((s) => sourceLabel(s)).join(' + ')
      : '~/.CLAUDE/PROJECTS';
    if (suffix === this._srcSuffix) return;
    this._srcSuffix = suffix;
    if (!this._offline) this._idSrc.textContent = tailLabel(this._ctx) + ' // ' + suffix;
  },

  // ---- roster ---------------------------------------------------------------
  _syncRoster(roster) {
    const n = Math.min(roster.length, MAX_ROWS);
    const order = [];
    const srcs = new Set();
    let live = 0;
    for (let i = 0; i < n; i++) {
      const sess = roster[i];
      const id = String(sess.id);
      order.push(id);
      let r = this._rows.get(id);
      if (!r) {
        r = {
          id, label: projectLabel(sess.project),
          active: false, sizeMB: sess.sizeMB ?? null,
          // harness identity + this row's own context ceiling (source arrives
          // with the multi-harness discovery wiring; null means "not stated")
          source: sourceOf(sess), srcName: sourceName(sess),
          model: sess.model ?? sess.meta?.model ?? null,
          capHint: firstPositive(sess.contextCap, sess.cap, sess.contextWindow, sess.meta?.contextCap),
          cap: 0, peak: 0, srcStr: '', titleStr: '',
          ctxTok: 0, valStr: '', clsStr: '',
          lastLen: -1,                        // ctx-stream growth cursor
          buckets: new Float32Array(SPARK_SECS), bHead: 0, lastSec: this._t | 0,
          sparkDirty: true, lastKick: 0,
          ui: null,
        };
        this._rows.set(id, r);
      }
      r.sizeMB = sess.sizeMB ?? r.sizeMB;
      // discovery may start tagging harness / window fields mid-flight — adopt
      // them, never unset what is already known
      r.source = r.source ?? sourceOf(sess);
      r.srcName = r.srcName ?? sourceName(sess);
      r.model = r.model ?? sess.model ?? sess.meta?.model ?? null;
      r.capHint = r.capHint ??
        firstPositive(sess.contextCap, sess.cap, sess.contextWindow, sess.meta?.contextCap);
      if (r.source) srcs.add(r.source);
      const wasActive = r.active;
      r.active = !!sess.active;
      if (r.active) live++;
      if (wasActive !== r.active) { r.valStr = ''; r.sparkDirty = true; }
    }
    this._setSources(srcs);

    // bind pool slots in display order (server order: mtime desc, live on top)
    const key = order.join('|');
    if (key !== this._orderKey) {
      this._orderKey = key;
      this._order = order;
      this._emptyEl.style.display = order.length ? 'none' : '';
      for (let i = 0; i < this._pool.length; i++) {
        const slot = this._pool[i];
        const id = order[i];
        if (!id) {
          if (slot.row.style.display !== 'none') slot.row.style.display = 'none';
          continue;
        }
        const r = this._rows.get(id);
        r.ui = slot;
        slot.row.style.display = '';
        slot.row.dataset.id = id;
        if (slot.lab.textContent !== r.label) slot.lab.textContent = r.label;
        r.valStr = ''; r.clsStr = ''; r.srcStr = ''; r.titleStr = ''; r.sparkDirty = true;
      }
      const over = roster.length - n;
      this._moreEl.style.display = over > 0 ? 'block' : 'none';
      if (over > 0) this._moreEl.textContent = '+' + over + ' OLDER — TAIL CAP';
    }

    // identity line
    const idStr = `${order.length} SESSIONS // ${live} LIVE`;
    if (idStr !== this._idStr) { this._idStr = idStr; this._idSub.textContent = idStr; }
  },

  _selfFetchRoster() {
    if (this._fetching || typeof fetch !== 'function') return;
    this._fetching = true;
    fetch(LIVE_SERVER + '/sessions')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then((j) => {
        if (this._destroyed) return;
        this._selfRoster = Array.isArray(j) ? j : null;
        this._setOffline(false);
      })
      .catch(() => { if (!this._destroyed) this._setOffline(true); })
      .finally(() => { this._fetching = false; });
  },

  _setOffline(off) {
    if (off === this._offline) return;
    this._offline = off;
    this._idSrc.className = 'fhud-sub2' + (off ? ' err' : '');
    this._idSrc.textContent = off
      ? tailLabel(this._ctx) + ' // OFFLINE — RETRY ' + SELF_POLL + 'S'
      : tailLabel(this._ctx) + ' // ' + this._srcSuffix;
    if (off && !this._order.length) {
      this._emptyEl.style.display = '';
      this._emptyEl.className = 'fhud-empty err';
      this._emptyEl.textContent = 'TAIL SERVER OFFLINE';
    } else if (!off && this._emptyEl.className !== 'fhud-empty') {
      this._emptyEl.className = 'fhud-empty';
      this._emptyEl.textContent = 'SCANNING FOR SESSIONS…';
    }
  },

  // ---- live arrivals --------------------------------------------------------
  _bucketAdvance(r, sec) {
    let d = sec - r.lastSec;
    if (d <= 0) return;
    if (d > SPARK_SECS) d = SPARK_SECS;
    for (let k = 1; k <= d; k++) r.buckets[(r.bHead + k) % SPARK_SECS] = 0;
    r.bHead = (r.bHead + d) % SPARK_SECS;
    r.lastSec = sec;
    r.sparkDirty = true;
  },

  _arrivals(r, count, toolCount) {
    if (count <= 0) return;
    this._agg.events += count;
    this._agg.tools += toolCount;
    this._bucketAdvance(r, this._t | 0);
    r.buckets[r.bHead] += count;
    r.sparkDirty = true;
    // dot flash — affordance that the machine just did something
    const now = this._t;
    if (r.ui && now - r.lastKick > 0.15) {
      r.lastKick = now;
      const dot = r.ui.dot;
      dot.classList.remove('hot');
      void dot.offsetWidth;
      dot.classList.add('hot');
    }
  },

  // read growth off fleetMain-owned timelines (never tick(), never mutate)
  _pollCtxStreams(ctx) {
    let bound = 0;
    for (const id of this._order) {
      const r = this._rows.get(id);
      if (!r?.active) continue;
      const tl = timelineOf(ctx, id);
      if (!tl) continue;
      bound++;
      const len = tl.events.length;
      if (r.lastLen < 0) r.lastLen = len;      // backlog is history, not a visit arrival
      else if (len > r.lastLen) {
        let tools = 0;
        for (let i = r.lastLen; i < len; i++) if (tl.events[i]?.kind === 'tool_call') tools++;
        this._arrivals(r, len - r.lastLen, tools);
        r.lastLen = len;
      }
      const cx = tl.contextAt(tl.duration);
      if (cx) r.ctxTok = cx.ctx || 0;
    }
    return bound;
  },

  // fallback: own EventSources, hard-capped, closed the moment ctx.streams shows
  _syncSelfStreams() {
    if (typeof EventSource === 'undefined') return;
    const want = [];
    for (const id of this._order) {
      const r = this._rows.get(id);
      if (r?.active && want.length < MAX_STREAMS) want.push(id);
    }
    for (const [id, es] of this._es) {
      if (!want.includes(id)) { es.close(); this._es.delete(id); }
    }
    for (const id of want) {
      if (this._es.has(id)) continue;
      const r = this._rows.get(id);
      const es = new EventSource(LIVE_SERVER + '/stream?id=' + encodeURIComponent(id));
      es.addEventListener('snapshot', (e) => {
        try {
          const snap = JSON.parse(e.data);
          for (let i = (snap.items?.length ?? 0) - 1; i >= 0; i--) {
            if (snap.items[i].kind === 'ctx') { r.ctxTok = snap.items[i].ctx || 0; break; }
          }
        } catch { /* malformed snapshot — counters just start at zero */ }
      });
      es.addEventListener('items', (e) => {
        try {
          const d = JSON.parse(e.data);
          let ev = 0, tools = 0;
          for (const it of d.items ?? []) {
            if (it.kind === 'ctx') { r.ctxTok = it.ctx || 0; continue; }
            ev++;
            if (it.kind === 'tool_call') tools++;
          }
          this._arrivals(r, ev, tools);
        } catch { /* skip malformed frame */ }
      });
      this._es.set(id, es);
    }
  },

  _closeSelfStreams() {
    for (const es of this._es.values()) es.close();
    this._es.clear();
  },

  // ---- sparkline: 60 one-second buckets, height = events/sec ---------------
  _drawSpark(r) {
    const g = r.ui.sctx;
    const W = SPARK_W * SPARK_DPR, H = SPARK_H * SPARK_DPR;
    g.clearRect(0, 0, W, H);
    const C = this._ctx?.CSS ?? LIB_CSS;
    g.fillStyle = C.hudDim + '55';                      // baseline — the axis is real
    g.fillRect(0, H - SPARK_DPR, W, SPARK_DPR);
    let peak = 0;
    for (let k = 0; k < SPARK_SECS; k++) peak = Math.max(peak, r.buckets[k]);
    if (peak <= 0) return;
    const norm = Math.max(4, peak);                     // floor so idle stays visibly idle
    const bw = W / SPARK_SECS;
    for (let k = 0; k < SPARK_SECS; k++) {
      const v = r.buckets[(r.bHead + 1 + k) % SPARK_SECS];
      if (v <= 0) continue;
      const h = Math.max(SPARK_DPR, clamp01(v / norm) * (H - 2 * SPARK_DPR));
      const isNow = k === SPARK_SECS - 1;
      g.fillStyle = isNow ? C.fresh : C.cache;
      g.globalAlpha = isNow ? 0.95 : 0.4 + 0.6 * (k / SPARK_SECS);  // past fades, now burns
      g.fillRect(k * bw, H - SPARK_DPR - h, Math.max(SPARK_DPR, bw * 0.7), h);
    }
    g.globalAlpha = 1;
  },

  // ---- per-frame ------------------------------------------------------------
  update(a, b, c) {
    if (!this._root) return;
    const dt = typeof a === 'number' ? Math.min(a, 0.1) : 0.016;
    const rest = typeof a === 'number' ? [b, c] : [a, b];
    // signature-tolerant ctx discovery — same trick as machines.js
    let ctx = this._ctx;
    for (const bag of rest) {
      if (bag && (bag.scene || bag.streams || bag.THREE || bag.PALETTE)) { ctx = bag; break; }
    }
    this._ctx = ctx;
    this._t += dt;

    // -- roster: prefer fleetMain's; self-fetch only past the grace window.
    //    Sync gated to 2 Hz so no arrays are built in the per-frame hot path.
    if ((this._rosterAcc += dt) >= 0.5) {
      this._rosterAcc = 0;
      // tail base may be discovered after init — keep the source line honest
      const lbl = tailLabel(ctx);
      if (!this._offline && this._tailLbl !== lbl) {
        this._tailLbl = lbl;
        this._idSrc.textContent = lbl + ' // ' + this._srcSuffix;
      }
      let roster = rosterOf(ctx);
      if (roster) {
        if (this._selfMode) { this._selfMode = false; this._setOffline(false); }
      } else if (this._t > ROSTER_GRACE) {
        this._selfMode = true;
        if ((this._selfTimer -= 0.5) <= 0) { this._selfTimer = SELF_POLL; this._selfFetchRoster(); }
        roster = this._selfRoster;
      }
      if (roster) this._syncRoster(roster);
    }

    // -- live streams: ctx-owned wins; self-streams only if ctx never provides.
    //    ctx growth is read every frame (allocation-free); self-stream lifecycle
    //    (open/close EventSources) reconciles at 1 Hz.
    let streams = this._es.size;
    if (ctx?.streams) {
      if (this._streamMode !== 'ctx') { this._streamMode = 'ctx'; this._closeSelfStreams(); }
      streams = this._pollCtxStreams(ctx);
    } else if (this._t > STREAM_GRACE && this._order.length) {
      this._streamMode = 'self';
      if ((this._esAcc += dt) >= 1) { this._esAcc = 0; this._syncSelfStreams(); }
      streams = this._es.size;
    }

    // -- second-boundary bucket rotation for every live row -------------------
    const sec = this._t | 0;
    for (const id of this._order) {
      const r = this._rows.get(id);
      if (r?.active) this._bucketAdvance(r, sec);
    }

    // -- gated UI refresh (~4 Hz): row values, sparks, vitals -----------------
    if ((this._uiAcc += dt) < 1 / UI_HZ) return;
    this._uiAcc = 0;

    for (const id of this._order) {
      const r = this._rows.get(id);
      if (!r?.ui) continue;
      const cls = 'fhud-row' + (r.active ? ' live' : '');
      if (cls !== r.clsStr) {
        r.clsStr = cls;
        r.ui.row.className = cls;
        r.ui.dot.textContent = r.active ? '●' : '◇';
      }
      // tokens over this row's OWN ceiling. The sizeMB fallback is transcript
      // mass, not context — it never gets a denominator dressed onto it.
      const cap = this._capOf(r);
      const lib = this._lib?.get(id);
      const tok = r.active ? r.ctxTok : (lib?.peak ?? null);
      let val, pct = null;
      if (Number.isFinite(tok) && tok > 0) {
        val = cap > 0 ? fmtTok(tok) + '/' + fmtTok(cap) : fmtTok(tok);
        if (cap > 0) pct = Math.round(clamp01(tok / cap) * 100);
      } else if (r.active) {
        val = '—';
      } else {
        val = r.sizeMB != null ? r.sizeMB.toFixed(1) + 'MB' : '—';
      }
      if (val !== r.valStr) { r.valStr = val; r.ui.val.textContent = val; }

      const src = r.source ?? lib?.source ?? null;
      const tag = sourceTag(src);
      if (tag !== r.srcStr) { r.srcStr = tag; r.ui.src.textContent = tag; }

      // the tooltip carries what the 19px row cannot: full label, id, harness,
      // and the percentage of the ceiling the value is measured against
      const title = r.label + ' · ' + id +
        (src ? ' · ' + sourceLabel(src, r.srcName ?? lib?.srcName) : '') +
        (pct != null ? ` · ${val} (${pct}%)` : '');
      if (title !== r.titleStr) { r.titleStr = title; r.ui.row.title = title; }

      if (r.active && r.sparkDirty) { r.sparkDirty = false; this._drawSpark(r); }
    }

    const ev = pad(Math.min(this._agg.events, 99999), 5);
    if (ev !== this._aggEvStr) { this._aggEvStr = ev; this._vEvents.textContent = ev; }
    const tc = pad(Math.min(this._agg.tools, 9999), 4);
    if (tc !== this._aggToolStr) { this._aggToolStr = tc; this._vTools.textContent = tc; }
    const ss = streams + '/' + MAX_STREAMS;
    if (ss !== this._aggStrStr) { this._aggStrStr = ss; this._vStreams.textContent = ss; }
  },

  resize() { /* rail + vitals are viewport-relative; nothing cached to remeasure */ },

  dispose() {
    this._destroyed = true;
    this._closeSelfStreams();
    this._root?.remove();
    this._styleEl?.remove();
  },
};
