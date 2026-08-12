// hud.js — diegetic HUD chrome for C-SPACE. Pure DOM/CSS inside #hud.
// Elements: identity block (top-left; line 2 is honest about the playing
// source via ctx.playing — LIVE tail with pulsing dot, ARCHIVE label, legacy
// flagship line when absent), session vitals (top-right), context
// meter (bottom-right) plus a percent annotation projected onto the tower fill
// line, bottom-left column (filter indicator chip + key block + event ticker),
// timeline scrubber (bottom-center).
// Every block sits on a dark scrim panel — near-opaque gradient + scanlines,
// NO backdrop-filter (the per-frame compositor re-blur over the WebGL canvas
// was perf-audit P1 hud.js:82; opacity does the legibility work instead).
// Counts and ticker index against ctx.timeline.events (compaction-deduped) so
// vitals agree with the world: COMPACTIONS reads the deduped total.
// The filter chip is read-only off ctx.state.filterTool (interact.js owns
// setting/clearing it). The key block (LEGEND r4) sits at the SESSION VITALS
// size/contrast tier and stacks three keyed sections:
//   · TOOL FAMILIES — toggle bank (filled square = family lit, hollow = dimmed
//     by the active filter) in a fixed 4-column grid whose row-major order
//     interleaves hues so the three teal/green swatches (shell cyan, search
//     teal, browser mint) never sit adjacent, horizontally or vertically;
//     closed by a unit line stating what totem geometry measures.
//   · CONTEXT TOWER — two-swatch hue key for the stack (cyan committed /
//     magenta fresh since compaction). Never dims with the tool filter.
//   · CHRONOGRAM MARKS — the mark grammar keyed in miniature. The compaction
//     entry keys the SCRUBBER's red tick (UR-6 removed the ring's marks).
// State display only: clicks stay on the totems (interact.js).
// Owns its own <style> block. No canvas; ctx.THREE is used only for Vector3
// projection math (tower fill-line annotation), never for scene objects.
// All allocation happens in init(); update() only mutates text/transform/class
// on pooled nodes, gated so nothing churns when values are unchanged; one-shot
// animations restart by alternating identical keyframe names (enter-a/enter-b,
// flash-a/flash-b), never via the void-offsetWidth forced-reflow idiom.
//
// SESSION SWAP (see SESSION SWAP CONTRACT in main.js) ------------------------
// reset(ctx) re-points this module at the newly playing session without a page
// load. THIS MODULE HOLDS NO GPU RESOURCES AT ALL: no geometry, no material, no
// texture, nothing added to ctx.scene, nothing registered with ctx.pick — so
// there is nothing to .dispose(). ctx.THREE is used only for two preallocated
// Vector3 scratch vectors (projection math for the tower annotation); those are
// plain CPU objects with no GPU handle and no dispose(), and they are
// deliberately KEPT and reused so update() stays allocation-free.
// What reset MUST rebuild, because it is session-shaped:
//   · _evs + the prefix-sum arrays + _spawnLabels (new events array, cursor
//     restarts at 0 — a carried prefix indexes the wrong session, and the label
//     map would otherwise accumulate every past session's subagents forever)
//   · the event ticker (lines + _procIdx cursor) and every value-gate cache, or
//     update() would skip the write that corrects a stale number on screen
//   · the scrubber's compaction ticks / subagent diamonds — the only per-session
//     DOM this module creates. The old nodes are REMOVED, not left in place: an
//     hours-long attract run would otherwise stack every past session's marks
//     on the bar and hold their nodes alive (this module's equivalent of a GPU
//     leak, and the reason the mark nodes are tracked in _marks).
//   · the identity lines, from ctx.playing + the new session's meta.
// What reset deliberately KEEPS, built once and session-independent: the <style>
// block, the whole DOM skeleton and corner layout, the ticker node pool, the
// legend chips (keyed off the stable TOOL_COLORS ring), the scratch vectors,
// and the entrance animations — re-running the identity glitch or the hudxIn
// stagger on every attract advance would be exactly the visible "now showing"
// cue the seamless ruling forbids, so no animation is retriggered by a swap.

const SPEEDS = [1, 2, 4];
const TICKER_LINES = 5;
const SEEK_JUMP = 50; // fired-event batches bigger than this are seeks, not playback

// legend chip order — 4-column grid, row-major:
//   SHELL  OTHER   SEARCH AGENTS
//   MUTATE BROWSER WEB    META
// interleaved so the teal/green family swatches (shell #37e6ff, search
// #2affc4, browser #3fffa8) are never horizontal or vertical neighbors.
const LEGEND_ORDER = ['shell', 'other', 'search', 'agents', 'mutate', 'browser', 'web', 'meta'];

const shortTool = (t) => (!t ? 'TOOL' : t.startsWith('mcp__') ? t.split('__').pop() : t);
// identity-line project label — "C--Users-you-myapp" or
// "C:\Users\you\myapp" → "MYAPP". Same compression
// grammar as library.js rows so the two chromes agree; falls back through
// (project dir, cwd), then to the path basename when the Users-prefix strip
// empties the string (home-dir sessions). Uppercase, capped for block width.
const projectLabel = (proj, cwd) => {
  for (const src of [proj, cwd]) {
    if (!src) continue;
    const flat = String(src).replace(/[\\/:]+/g, '-').replace(/^-+|-+$/g, '');
    const label = (flat.replace(/^[A-Za-z]-+Users-+[^-]+-*/i, '') || flat.split('-').pop() || '')
      .toUpperCase();
    if (label) return label.length > 20 ? label.slice(0, 19) + '…' : label;
  }
  return null;
};
const kb = (n) => (n == null ? '' : n >= 1024 ? (n / 1024).toFixed(1) + 'KB' : (n | 0) + 'B');
const trunc = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const pad = (n, w) => String(n).padStart(w, '0');

export default {
  name: 'hud',

  init(ctx) {
    const C = ctx.CSS;
    const tl = ctx.timeline;
    const freeze = ctx.params.get('freeze') === '1';
    this._cap = ctx.CONTEXT_TOKEN_CAP;
    this._nofx = freeze;

    // ---- prefix sums: O(1) vitals at any timeline cursor, seek-proof --------
    // Live mode grows tl.events past the boot-time count, so the arrays are
    // growable: _extendPrefix() doubles capacity and continues the running
    // sums from the old tail. Reallocation happens only on growth past
    // capacity — steady-state frames stay allocation-free.
    this._spawnLabels = new Map();
    this._prefix = {
      tool: new Int32Array(1), comp: new Int32Array(1),
      hook: new Int32Array(1), spawn: new Int32Array(1),
    };
    this._prefixLen = 0;   // events summed so far (arrays valid on [0.._prefixLen])
    this._syncSession(ctx); // binds _evs and fills the prefix (shared with reset)

    // ---- style block --------------------------------------------------------
    const st = document.createElement('style');
    st.id = 'hudx-style';
    st.textContent = `
#hud .hudx{position:absolute;inset:0;pointer-events:none;color:${C.hudText};
 font-family:"Cascadia Code","Cascadia Mono",ui-monospace,Consolas,monospace;
 text-transform:uppercase;line-height:1.35;-webkit-font-smoothing:antialiased;user-select:none;}
.hudx-h{font-size:9px;letter-spacing:.32em;color:${C.hudDim};margin-bottom:6px;}

/* --- scrim: every text block owns its local darkness, whatever the scene ---
   layered: faint scanlines over a near-opaque void gradient. NO backdrop-filter
   (perf-audit P1 hud.js:82 — the compositor re-blurred ~15-20% of the screen
   every frame); the raised gradient alpha carries legibility instead. */
.hudx-id,.hudx-vitals,.hudx-meter,.hudx-ticker,.hudx-scrub,.hudx-legend,.hudx-filter{
 background:
  repeating-linear-gradient(0deg,transparent 0 2px,${C.cache}07 2px 3px),
  linear-gradient(168deg,${C.void}f0 0%,${C.void}e0 55%,${C.void}f0 100%);
 box-shadow:inset 0 0 0 1px ${C.hudDim}3a,0 0 18px ${C.void}99;}

/* --- identity (top-left) --- */
.hudx-id{position:absolute;top:26px;left:30px;padding:11px 16px;animation:hudxGlitch .95s step-end both;}
.hudx-id::before,.hudx-id::after,.hudx-corners::before,.hudx-corners::after{content:"";position:absolute;width:9px;height:9px;}
.hudx-id::before{top:0;left:0;border-top:1px solid ${C.cache};border-left:1px solid ${C.cache};}
.hudx-id::after{bottom:0;right:0;border-bottom:1px solid ${C.cache};border-right:1px solid ${C.cache};}
.hudx-corners{position:absolute;inset:0;}
.hudx-corners::before{top:0;right:0;border-top:1px solid ${C.hudDim};border-right:1px solid ${C.hudDim};}
.hudx-corners::after{bottom:0;left:0;border-bottom:1px solid ${C.hudDim};border-left:1px solid ${C.hudDim};}
.hudx-title{font-size:14px;letter-spacing:.46em;color:${C.hudText};margin-bottom:7px;
 text-shadow:0 0 8px ${C.cache}55,0 0 22px ${C.cache}22;animation:hudxBreathe 6s ease-in-out infinite alternate;}
.hudx-cursor{display:inline-block;margin-left:.3em;color:${C.cache};animation:hudxBlink 1.1s step-end infinite;}
.hudx-sub{font-size:10px;letter-spacing:.3em;color:${C.cache};opacity:.85;margin-bottom:4px;}
.hudx-sub2{font-size:9px;letter-spacing:.26em;color:${C.hudDim};margin-bottom:3px;}
/* LIVE dot — rides identity line 2 in live mode; subtle cyan↔hot pulse.
   Freeze shots inherit .nofx animation:none, so stills stay deterministic. */
.hudx-live{display:inline-block;width:6px;height:6px;border-radius:50%;
 margin-left:.7em;vertical-align:1px;background:${C.cache};
 box-shadow:0 0 5px ${C.cache}88;animation:hudxLive 1.6s ease-in-out infinite;}
@keyframes hudxLive{0%,100%{background:${C.cache};box-shadow:0 0 4px ${C.cache}66;opacity:.7;}
 50%{background:${C.coreHot};box-shadow:0 0 8px ${C.cache}cc;opacity:1;}}
@keyframes hudxGlitch{
 0%{opacity:0;clip-path:inset(45% 0 45% 0);transform:translateX(-7px);}
 8%{opacity:.9;clip-path:inset(8% 0 64% 0);transform:translateX(4px);text-shadow:-2px 0 ${C.fresh},2px 0 ${C.cache};}
 16%{opacity:.25;clip-path:inset(62% 0 6% 0);transform:translateX(-3px);}
 26%{opacity:1;clip-path:inset(0 0 0 0);transform:translateX(2px);text-shadow:2px 0 ${C.fresh},-2px 0 ${C.cache};}
 34%{opacity:.45;}
 42%{opacity:1;transform:translateX(0);text-shadow:none;}
 55%{opacity:.85;clip-path:inset(30% 0 30% 0);}
 62%{opacity:1;clip-path:inset(0 0 0 0);}
 100%{opacity:1;transform:none;text-shadow:none;}}
@keyframes hudxBlink{50%{opacity:0;}}
@keyframes hudxBreathe{from{opacity:.88;}to{opacity:1;}}

/* --- entrance stagger --- */
.hudx-vitals,.hudx-meter,.hudx-ticker,.hudx-scrub,.hudx-legend{animation:hudxIn .7s cubic-bezier(.2,.9,.2,1) both;}
.hudx-vitals{animation-delay:.35s}.hudx-meter{animation-delay:.5s}
.hudx-ticker{animation-delay:.6s}.hudx-legend{animation-delay:.55s}.hudx-scrub{animation-delay:.7s}
@keyframes hudxIn{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}
.hudx.nofx *{animation:none !important;}

/* --- vitals (top-right) --- */
.hudx-vitals{position:absolute;top:16px;right:18px;padding:10px 12px;text-align:right;font-size:10px;letter-spacing:.22em;}
.hudx-row{display:flex;justify-content:flex-end;gap:12px;margin-bottom:4px;}
.hudx-k{color:${C.hudDim};}
.hudx-v{color:${C.hudText};min-width:5ch;text-align:right;text-shadow:0 0 6px ${C.cache}44;}
.hudx-v.sub{color:${C.subagent};text-shadow:0 0 6px ${C.subagent}44;}

/* --- context meter (bottom-right) --- */
.hudx-meter{position:absolute;bottom:16px;right:18px;width:250px;padding:10px 12px;text-align:right;}
.hudx-pct{color:${C.cache};margin-left:.6em;}
.hudx-mnum{font-size:11px;letter-spacing:.14em;margin-bottom:6px;}
.hudx-mv{color:${C.cache};text-shadow:0 0 7px ${C.cache}55;}
.hudx-mdim{color:${C.hudDim};font-size:9px;}
.hudx-mbar{position:relative;height:5px;border:1px solid ${C.hudDim}88;background:${C.void}cc;overflow:hidden;}
.hudx-mfill{position:absolute;inset:0;transform-origin:left;transform:scaleX(0);
 background:linear-gradient(90deg,${C.cache}66,${C.cache});box-shadow:0 0 8px ${C.cache}66;}
.hudx-mtip{position:absolute;inset:0;transform-origin:left;transform:scaleX(0);
 background:${C.fresh};box-shadow:0 0 8px ${C.fresh}aa;}
.hudx-mseg{position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0 5px,${C.void} 5px 7px);}
/* compaction flash — a/b pairs are identical; alternating the animation-name
   restarts the one-shot without a forced reflow (perf-audit hud.js:459) */
.hudx-meter.flash-a .hudx-mbar{animation:hudxFlashA .7s ease-out both;}
.hudx-meter.flash-a .hudx-mv{animation:hudxFlashTxtA .7s ease-out both;}
.hudx-meter.flash-b .hudx-mbar{animation:hudxFlashB .7s ease-out both;}
.hudx-meter.flash-b .hudx-mv{animation:hudxFlashTxtB .7s ease-out both;}
@keyframes hudxFlashA{0%{border-color:${C.error};box-shadow:0 0 16px ${C.error}cc;}100%{border-color:${C.hudDim}88;box-shadow:none;}}
@keyframes hudxFlashB{0%{border-color:${C.error};box-shadow:0 0 16px ${C.error}cc;}100%{border-color:${C.hudDim}88;box-shadow:none;}}
@keyframes hudxFlashTxtA{0%{color:${C.error};text-shadow:0 0 10px ${C.error};}100%{color:${C.cache};text-shadow:0 0 7px ${C.cache}55;}}
@keyframes hudxFlashTxtB{0%{color:${C.error};text-shadow:0 0 10px ${C.error};}100%{color:${C.cache};text-shadow:0 0 7px ${C.cache}55;}}

/* percent annotation riding the tower fill line — quantity co-locates with the
   graphic. Positioned per-frame by projecting the LAYOUT fill height; kept out
   of the entrance-stagger set because hudxIn would fight its transform. */
.hudx-tpct{position:absolute;left:0;top:0;padding:2px 6px 2px 7px;font-size:9px;letter-spacing:.22em;
 color:${C.cache};text-shadow:0 0 7px ${C.cache}66;white-space:nowrap;will-change:transform;
 background:linear-gradient(90deg,${C.void}c9,${C.void}77);
 box-shadow:inset 0 0 0 1px ${C.hudDim}44;visibility:hidden;}
.hudx-tpct::before{content:"";position:absolute;left:-10px;top:50%;width:10px;height:1px;
 background:linear-gradient(90deg,${C.cache}22,${C.cache});box-shadow:0 0 4px ${C.cache}66;}

/* --- bottom-left column: filter chip / legend / event ticker --- */
.hudx-bl{position:absolute;bottom:16px;left:18px;display:flex;flex-direction:column;align-items:flex-start;gap:7px;}

/* filter indicator — hidden until ctx.state.filterTool is set; accent color
   is applied inline per tool family */
.hudx-filter{display:none;padding:5px 10px;font-size:8.5px;letter-spacing:.26em;}
.hudx-filter.show{display:block;animation:hudxIn .25s cubic-bezier(.2,.9,.2,1) both;}

/* key block (LEGEND r4) — raised to the SESSION VITALS size/contrast tier:
   10px/.22em hudText entries under 9px/.32em hudDim headers. The family
   section is a toggle bank, not a caption: filled square = family lit in the
   world, hollow square = dimmed by the active filter. Header carries the key
   hint that makes the totem-click filter discoverable. Per-chip family color
   rides CSS vars (--fc solid, --fg glow) set once at init. Chips sit in a
   fixed 4-column grid (LEGEND_ORDER) so hue adjacency is deterministic. */
.hudx-legend{width:min(420px,34vw);padding:9px 12px 10px;display:flex;flex-direction:column;gap:5px;}
.hudx-lhead{display:flex;justify-content:space-between;align-items:baseline;gap:12px;
 font-size:9px;letter-spacing:.32em;color:${C.hudDim};margin-bottom:1px;}
.hudx-lhint{opacity:.7;letter-spacing:.18em;white-space:nowrap;}
.hudx-lgrid{display:grid;grid-template-columns:repeat(4,auto);justify-content:space-between;gap:5px 14px;}
.hudx-lrow{display:flex;flex-wrap:wrap;gap:5px 16px;}
.hudx-lg{display:flex;align-items:center;gap:6px;font-size:10px;letter-spacing:.22em;color:${C.hudText};transition:opacity .25s ease,color .25s ease;}
.hudx-lg.on{text-shadow:0 0 6px var(--fg);}
.hudx-lg.off{opacity:.4;color:${C.hudDim};}
.hudx-lsw{width:9px;height:9px;flex:none;box-sizing:border-box;border:1px solid var(--fc);
 background:var(--fc);box-shadow:0 0 5px var(--fg);transition:background .2s ease,box-shadow .2s ease;}
.hudx-lg.off .hudx-lsw{background:transparent;box-shadow:none;}
/* unit line — what totem geometry measures; small, precise, never decorative */
.hudx-lunit{font-size:8.5px;letter-spacing:.2em;color:${C.hudDim};}

/* chronogram mark key — glyphs echo the mark grammar 1:1: red compaction
   hairline (now the SCRUBBER's tick — UR-6 removed the ring's marks), violet
   subagent gantt arc, hot playhead wedge. Same reds/violets/hots as the
   scrubber ticks, so one grammar keys both graphics. */
.hudx-ldiv{width:100%;height:1px;flex:none;margin:3px 0 2px;
 background:linear-gradient(90deg,${C.hudDim}55,${C.hudDim}22 70%,transparent);}
.hudx-mk{display:flex;align-items:center;gap:6px;font-size:10px;letter-spacing:.22em;color:${C.hudText};}
.hudx-mkg{position:relative;flex:none;width:12px;height:10px;}
.hudx-mkg::before{content:"";position:absolute;}
.mkg-scar::before{left:5px;top:0;width:2px;height:10px;background:${C.error};box-shadow:0 0 4px ${C.error}aa;}
.mkg-arc::before{left:1px;top:2px;width:10px;height:10px;border:2px solid transparent;
 border-top-color:${C.subagent};border-radius:50%;filter:drop-shadow(0 0 2px ${C.subagent}aa);}
.mkg-wedge::before{left:2px;top:1px;width:0;height:0;border-left:8px solid ${C.coreHot};
 border-top:4px solid transparent;border-bottom:4px solid transparent;filter:drop-shadow(0 0 3px ${C.cache}cc);}

/* --- event ticker (inside bottom-left column) --- */
.hudx-ticker{width:min(420px,34vw);padding:10px 12px;font-size:9.5px;letter-spacing:.14em;}
.hudx-tl{white-space:nowrap;overflow:hidden;margin-bottom:3px;min-height:13px;color:${C.hudDim};transition:opacity .25s ease;}
.hudx-tl.p0{opacity:1}.hudx-tl.p1{opacity:.72}.hudx-tl.p2{opacity:.52}.hudx-tl.p3{opacity:.36}.hudx-tl.p4{opacity:.22}
/* enter-a/enter-b are identical; alternating the name restarts the one-shot
   without the void-offsetWidth forced reflow (perf-audit hud.js:450) */
.hudx-tl.enter-a{animation:hudxTickA .28s cubic-bezier(.2,.9,.3,1) both;}
.hudx-tl.enter-b{animation:hudxTickB .28s cubic-bezier(.2,.9,.3,1) both;}
@keyframes hudxTickA{from{opacity:0;transform:translateX(-10px) skewX(-8deg);}to{transform:none;}}
@keyframes hudxTickB{from{opacity:0;transform:translateX(-10px) skewX(-8deg);}to{transform:none;}}
.hudx-tl.k-call{color:${C.cache};}
.hudx-tl.k-res{color:${C.hudDim};}
.hudx-tl.k-err{color:${C.error};text-shadow:0 0 6px ${C.error}55;}
.hudx-tl.k-spawn{color:${C.subagent};}
.hudx-tl.k-comp{color:${C.error};}
.hudx-tl.k-hook{color:${C.hook};}
.hudx-tl.k-user{color:${C.fresh};}
.hudx-tl.k-say{color:${C.output};}
.hudx-tl.k-think{color:${C.hudDim};}

/* --- scrubber (bottom-center) --- */
.hudx-scrub{position:absolute;bottom:15px;left:0;right:0;margin:0 auto;width:max-content;
 padding:7px 12px;display:flex;align-items:center;gap:10px;pointer-events:auto;}
.hudx-btn{pointer-events:auto;cursor:pointer;background:${C.void}b3;border:1px solid ${C.hudDim}aa;
 color:${C.cache};font-family:inherit;font-size:9px;letter-spacing:.18em;text-transform:uppercase;
 padding:3px 8px;line-height:1.2;}
.hudx-btn:hover{border-color:${C.cache};color:${C.coreHot};text-shadow:0 0 6px ${C.cache}88;}
.hudx-sbar{position:relative;width:min(460px,38vw);height:16px;cursor:pointer;touch-action:none;}
.hudx-strack{position:absolute;left:0;right:0;top:7px;height:3px;background:${C.gridLine};opacity:.8;}
.hudx-sfill{position:absolute;left:0;right:0;top:7px;height:3px;transform-origin:left;transform:scaleX(0);
 background:linear-gradient(90deg,${C.cache}88,${C.cache});box-shadow:0 0 6px ${C.cache}55;}
.hudx-stick{position:absolute;top:4px;width:2px;height:9px;margin-left:-1px;background:${C.error};box-shadow:0 0 4px ${C.error}88;}
.hudx-sdia{position:absolute;top:2px;width:5px;height:5px;margin-left:-2.5px;background:${C.subagent};
 transform:rotate(45deg);box-shadow:0 0 4px ${C.subagent}aa;}
.hudx-shead{position:absolute;left:-1px;top:3px;width:2px;height:11px;background:${C.coreHot};box-shadow:0 0 6px ${C.cache};}
.hudx-stime{font-size:9px;letter-spacing:.18em;color:${C.hudDim};min-width:7ch;}
`;
    document.head.appendChild(st);

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

    const root = div('hudx' + (freeze ? ' nofx' : ''), document.getElementById('hud'));
    this._root = root;

    // (1) identity block — line 2 is honest about the playing source.
    // ctx.playing (main.js: {mode, sessionId, project}) drives it: LIVE →
    // project + id8 + pulsing dot; ARCHIVE → project label + id8 + suffix.
    // Absent or unrecognized mode → the legacy flagship line, unchanged.
    const idBox = div('hudx-id', root);
    div('hudx-corners', idBox);
    const title = div('hudx-title', idBox, 'C-SPACE');
    span('hudx-cursor', title, '_');
    // The three lines under the title are the only session-dependent part of the
    // block: created empty here in their final order, filled by _renderIdentity
    // (shared with reset). Corner rules, title and cursor are session chrome.
    this._idSub = div('hudx-sub', idBox);
    this._idModel = div('hudx-sub2', idBox);
    this._idStarted = div('hudx-sub2', idBox);
    this._idLive = null;         // pulsing LIVE dot, present in live mode only
    this._renderIdentity(ctx);

    // (2) session vitals
    const vit = div('hudx-vitals', root);
    div('hudx-h', vit, 'SESSION VITALS');
    const row = (label, cls) => {
      const r = div('hudx-row', vit);
      div('hudx-k', r, label);
      return div('hudx-v' + (cls ? ' ' + cls : ''), r, '—');
    };
    this._vTools = row('TOOL CALLS');
    this._vSub = row('SUBAGENTS', 'sub');
    this._vComp = row('COMPACTIONS');
    this._vHook = row('HOOKS');

    // (3) context meter
    const met = div('hudx-meter', root);
    this._meterEl = met;
    const mh = div('hudx-h', met, 'CONTEXT WINDOW');
    this._pct = span('hudx-pct', mh, '0.0%');
    const mnum = div('hudx-mnum', met);
    this._num = span('hudx-mv', mnum, '0');
    span('hudx-mdim', mnum, ` / ${this._cap.toLocaleString('en-US')}`);
    const mbar = div('hudx-mbar', met);
    this._mFill = div('hudx-mfill', mbar);
    this._mTip = div('hudx-mtip', mbar);
    div('hudx-mseg', mbar);

    // (3b) tower fill-line annotation — the same percent as the meter, pinned
    // each frame to the projected top of the context stack (LAYOUT contract:
    // fill height = total × towerMaxHeight above towerPos). Vectors are
    // preallocated here; update() only mutates them.
    this._tp = div('hudx-tpct', root, '0.0%');
    this._tpXf = '';
    this._tpVis = false;
    this._v3a = new ctx.THREE.Vector3();
    this._v3b = new ctx.THREE.Vector3();

    // (4) bottom-left column — filter chip, tool-family legend, event ticker
    const bl = div('hudx-bl', root);

    this._filterEl = div('hudx-filter', bl, '');
    this._filterCur = null;
    this._famCSS = Object.fromEntries(
      Object.entries(ctx.TOOL_COLORS).map(([k, v]) => [k, '#' + v.toString(16).padStart(6, '0')])
    );

    const leg = div('hudx-legend', bl);
    const lhead = div('hudx-lhead', leg);
    span(null, lhead, '// TOOL FAMILIES');
    span('hudx-lhint', lhead, 'CLICK TOTEM TO FILTER');
    // swatch+label chip factory — shared by the family grid and the tower key
    const key = (parent, col, label) => {
      const chip = div('hudx-lg', parent);
      chip.style.setProperty('--fc', col);
      chip.style.setProperty('--fg', col + 'aa');
      div('hudx-lsw', chip);
      span(null, chip, label);
      return chip;
    };
    // family chips in LEGEND_ORDER (4-col grid, teal/greens never adjacent);
    // any family missing from the order still renders, appended at the end
    const lgrid = div('hudx-lgrid', leg);
    this._legChips = {};
    const fams = [
      ...LEGEND_ORDER.filter((f) => f in this._famCSS),
      ...Object.keys(this._famCSS).filter((f) => !LEGEND_ORDER.includes(f)),
    ];
    for (const fam of fams) {
      this._legChips[fam] = key(lgrid, this._famCSS[fam], fam.toUpperCase());
    }
    // unit line for the totem key — what monolith geometry measures
    div('hudx-lunit', leg, 'TOTEM HEIGHT · CONDUIT WIDTH ∝ LOG CALL VOLUME');

    // context-tower key — the stack's hue shift, two swatches (cyan committed /
    // magenta fresh since compaction). Not in _legChips: the tower is not
    // filterable, so these never dim with the tool filter.
    div('hudx-ldiv', leg);
    const chead = div('hudx-lhead', leg);
    span(null, chead, '// CONTEXT TOWER');
    const crow = div('hudx-lrow', leg);
    key(crow, C.cache, 'COMMITTED');
    key(crow, C.fresh, 'FRESH SINCE COMPACTION');

    // chronogram mark key — the mark grammar keyed in miniature. These never
    // dim with the filter: the grammar holds whatever is filtered. UR-6
    // removed the ring's compaction marks; compactions still tick the
    // SCRUBBER (same red hairline as this glyph), so the key points there —
    // relabeled, never deleted.
    div('hudx-ldiv', leg);
    const khead = div('hudx-lhead', leg);
    span(null, khead, '// CHRONOGRAM MARKS');
    span('hudx-lhint', khead, 'CLICK RING TO SEEK');
    const krow = div('hudx-lrow', leg);
    const mark = (glyph, label) => {
      const m = div('hudx-mk', krow);
      span('hudx-mkg ' + glyph, m);
      span(null, m, label);
    };
    mark('mkg-scar', 'COMPACTION (SCRUBBER)');
    mark('mkg-arc', 'SUBAGENT');
    mark('mkg-wedge', 'PLAYHEAD');

    // event ticker — fixed pool, content shifts through slots
    const tick = div('hudx-ticker', bl);
    div('hudx-h', tick, '// EVENT STREAM');
    this._tickPool = [];
    for (let i = 0; i < TICKER_LINES; i++) this._tickPool.push(div('hudx-tl p' + i, tick, ''));
    this._lines = [];

    // (5) timeline scrubber — hidden entirely in freeze mode
    this._sFill = null;
    this._sBarEl = null;
    this._marks = [];      // per-session tick/diamond nodes (see _buildScrubMarks)
    if (!freeze) {
      const sc = div('hudx-scrub', root);
      const playBtn = document.createElement('button');
      playBtn.className = 'hudx-btn';
      playBtn.textContent = '❚❚';
      sc.appendChild(playBtn);
      this._playBtn = playBtn;
      const speedBtn = document.createElement('button');
      speedBtn.className = 'hudx-btn';
      speedBtn.textContent = tl.speed + '×';
      sc.appendChild(speedBtn);
      this._speedBtn = speedBtn;

      const bar = div('hudx-sbar', sc);
      this._sBarEl = bar;
      div('hudx-strack', bar);
      this._sFill = div('hudx-sfill', bar);
      // marks BEFORE the playhead so the head keeps painting over them
      this._buildScrubMarks(ctx);
      this._sHead = div('hudx-shead', bar);
      this._timeEl = div('hudx-stime', sc, 'T+000.0');

      // Transport handlers read ctx.timeline at CLICK time, never a timeline
      // captured here: a swap rebinds ctx.timeline, and a captured local would
      // leave these buttons driving the session that is no longer on screen.
      playBtn.addEventListener('click', () => {
        const t = ctx.timeline;
        if (!t.playing && t.vt >= t.duration - 1e-6) t.seek(0);
        t.playing = !t.playing;
      });
      speedBtn.addEventListener('click', () => {
        const t = ctx.timeline;
        const i = SPEEDS.indexOf(t.speed);
        t.speed = SPEEDS[(i + 1) % SPEEDS.length];
        speedBtn.textContent = t.speed + '×';
      });

      const seekFrom = (e) => {
        const t = ctx.timeline;
        const r = bar.getBoundingClientRect();
        if (r.width > 0) t.seek(clamp01((e.clientX - r.left) / r.width) * t.duration);
      };
      this._drag = false;
      bar.addEventListener('pointerdown', (e) => {
        this._drag = true;
        bar.setPointerCapture(e.pointerId);
        seekFrom(e);
      });
      bar.addEventListener('pointermove', (e) => { if (this._drag) seekFrom(e); });
      const end = () => { this._drag = false; };
      bar.addEventListener('pointerup', end);
      bar.addEventListener('pointercancel', end);

      this._barW = bar.clientWidth;
    }

    // gating state
    this._procIdx = 0;
    this._statCur = -1;
    this._lastActive = -1;
    this._numStr = '';
    this._pctStr = '';
    this._timeStr = '';
    this._playGlyph = '';
    this._lastEnter = 0;
    // last-value caches for per-frame transforms (perf-audit hud.js:536) and
    // a/b flips for reflow-free one-shot animation restarts
    this._mFillXf = '';
    this._mTipXf = '';
    this._sFillXf = '';
    this._sHeadXf = '';
    this._enterFlip = false;
    this._flashFlip = false;
  },

  // ---- per-event ticker line -----------------------------------------------
  _makeLine(e) {
    switch (e.kind) {
      case 'tool_call':
        return { c: 'k-call', t: `▸ ${shortTool(e.tool)}  ${trunc(e.label, 34)}` };
      case 'tool_result':
        return e.err
          ? { c: 'k-err', t: `◂ ERR ${shortTool(e.tool)}  ${kb(e.chars)}` }
          : { c: 'k-res', t: `◂ RESULT ${kb(e.chars)}` };
      case 'spawn':
        return { c: 'k-spawn', t: `✚ SPAWN ${trunc(e.label, 30)}` };
      case 'despawn':
        return { c: 'k-spawn', t: `⊖ RETURN ${trunc(this._spawnLabels.get(e.id) ?? 'subagent', 28)}` };
      case 'compaction':
        return { c: 'k-comp', t: '⧉ COMPACTION // CONTEXT COLLAPSE' };
      case 'hook':
        return { c: e.err ? 'k-err' : 'k-hook', t: `◆ HOOK ${trunc(e.name, 30)}` };
      case 'user':
        return { c: 'k-user', t: `» USER  ${trunc(e.preview, 32)}` };
      case 'say':
        return { c: 'k-say', t: `« MODEL ${trunc(e.preview, 32)}` };
      case 'thinking':
        return { c: 'k-think', t: `∴ THINKING ${kb(e.chars)}` };
      default:
        return null; // 'queued' duplicates the user line — skip
    }
  },

  _renderTicker(animate) {
    const pool = this._tickPool;
    for (let i = 0; i < pool.length; i++) {
      const L = this._lines[i];
      const el = pool[i];
      const txt = L ? L.t : '';
      if (el.textContent !== txt) el.textContent = txt;
      const cls = 'hudx-tl p' + i + (L ? ' ' + L.c : '');
      if (el.className !== cls) el.className = cls;
    }
    if (animate && !this._nofx) {
      const now = performance.now();
      if (now - this._lastEnter > 90) {
        this._lastEnter = now;
        const top = pool[0];
        // alternating identical keyframe names restarts the animation with a
        // pure style change — no forced reflow (perf-audit hud.js:450)
        this._enterFlip = !this._enterFlip;
        top.classList.remove(this._enterFlip ? 'enter-b' : 'enter-a');
        top.classList.add(this._enterFlip ? 'enter-a' : 'enter-b');
      }
    }
  },

  _flashMeter() {
    const m = this._meterEl;
    this._flashFlip = !this._flashFlip;
    m.classList.remove(this._flashFlip ? 'flash-b' : 'flash-a');
    m.classList.add(this._flashFlip ? 'flash-a' : 'flash-b');
  },

  _setVal(el, s) {
    if (el.textContent !== s) el.textContent = s;
  },

  // Grow the prefix arrays to cover events [0..upto) — live mode appends past
  // the boot-time count. Doubles capacity on reallocation; continues running
  // sums from the previous tail, so already-summed events are never rescanned.
  _extendPrefix(upto) {
    const P = this._prefix;
    if (upto + 1 > P.tool.length) {
      const cap = Math.max(upto + 1, P.tool.length * 2, 1024);
      for (const k of ['tool', 'comp', 'hook', 'spawn']) {
        const next = new Int32Array(cap);
        next.set(P[k]);
        P[k] = next;
      }
    }
    for (let i = this._prefixLen; i < upto; i++) {
      const e = this._evs[i], k = e.kind;
      P.tool[i + 1] = P.tool[i] + (k === 'tool_call' ? 1 : 0);
      P.comp[i + 1] = P.comp[i] + (k === 'compaction' ? 1 : 0);
      P.hook[i + 1] = P.hook[i] + (k === 'hook' ? 1 : 0);
      P.spawn[i + 1] = P.spawn[i] + (k === 'spawn' ? 1 : 0);
      if (k === 'spawn') this._spawnLabels.set(e.id, e.label);
    }
    this._prefixLen = Math.max(this._prefixLen, upto);
  },

  // ---- shared build steps (init + reset) -----------------------------------

  // Bind to the PLAYING session's event array and rebuild the derived indices.
  // Timeline's array, NOT session.events: tl.cursor indexes into the
  // compaction-deduped list, and vitals must agree with it (COMP total = 5, not
  // the raw doubled log count). After a swap this is a different array whose
  // cursor restarts at 0, so the prefix is refilled from index 0 and the
  // spawn-label map is cleared (its ids belong to the old session, and keeping
  // them would grow the map for the whole attract run). The Int32Array capacity
  // is REUSED across swaps — plain CPU memory, no GPU handle, no dispose; a new
  // session at or below the high-water mark reallocates nothing.
  _syncSession(ctx) {
    this._evs = ctx.timeline.events;
    this._spawnLabels.clear();
    this._prefixLen = 0;
    this._extendPrefix(this._evs.length);
  },

  // Identity lines from ctx.playing + the new session's meta. Text only: the
  // corner rules, title, cursor and the one-shot entrance glitch are session
  // chrome and are never rebuilt or retriggered (a glitch on every attract
  // advance would be the "now showing" cue the seamless ruling forbids).
  _renderIdentity(ctx) {
    const meta = ctx.session?.meta ?? {};
    const playing = ctx.playing;
    const id8 = String(playing?.sessionId ?? meta.sessionId ?? '').slice(0, 8);
    const projLabel = projectLabel(playing?.project, meta.cwd) ?? 'SESSION';
    // the dot is a child of line 2, so it must be re-parented after the text
    // write that would otherwise wipe it
    if (this._idLive) { this._idLive.remove(); this._idLive = null; }
    if (playing?.mode === 'live') {
      this._idSub.textContent = `${projLabel} // ${id8}`;
      const dot = document.createElement('span');
      dot.className = 'hudx-live';
      this._idSub.appendChild(dot);
      this._idLive = dot;
    } else if (playing?.mode === 'archive') {
      this._idSub.textContent = `${projLabel} // ${id8} · ARCHIVE`;
    } else {
      // attract (and any unrecognized mode) keeps the plain flagship-style line
      this._idSub.textContent = `${projLabel} // ${String(meta.sessionId ?? '').slice(0, 8)}`;
    }
    this._idModel.textContent = `${meta.model} · V${meta.version}`;
    const started = new Date(meta.startedAt);
    this._idStarted.textContent =
      'STARTED ' + (Number.isNaN(started.valueOf()) ? '—' : started.toISOString().slice(0, 10));
  },

  // Scrubber compaction ticks + subagent diamonds. Marks derive from timeline
  // vts (tl.compactions deduped, tl.subagents spawnVt) — the same arrays the
  // chronogram maps to angle, so a tick at x% here and a scar at x% of the
  // annulus arc are the same instant. Per-session DOM: the previous session's
  // nodes are removed first, or an hours-long attract run would stack every
  // played session's marks on one bar and never release the nodes.
  _buildScrubMarks(ctx) {
    const bar = this._sBarEl;
    if (!bar) return;                    // freeze mode: no scrubber exists
    for (const el of this._marks) el.remove();
    this._marks.length = 0;
    const tl = ctx.timeline;
    const mark = (cls, vt) => {
      const el = document.createElement('div');
      el.className = cls;
      el.style.left = ((vt / tl.duration) * 100).toFixed(2) + '%';
      bar.insertBefore(el, this._sHead ?? null);   // stay under the playhead
      this._marks.push(el);
    };
    for (const c of tl.compactions) mark('hudx-stick', c.vt);
    for (const s of tl.subagents) mark('hudx-sdia', s.spawnVt);
  },

  // ---- session swap (see the header + main.js's SESSION SWAP CONTRACT) ------
  // Nothing to dispose: this module owns no geometry/material/texture, adds
  // nothing to ctx.scene and registers nothing with ctx.pick. The only owned
  // resources are DOM nodes and typed arrays; the per-session nodes (scrubber
  // marks) are removed in _buildScrubMarks, and the typed arrays are reused.
  reset(ctx) {
    this._syncSession(ctx);
    this._renderIdentity(ctx);
    this._buildScrubMarks(ctx);

    // event ticker — the new timeline starts at cursor 0, so the walk cursor
    // and the visible lines both restart or update() would replay the old
    // session's tail (or, worse, index _evs with the old cursor).
    this._lines.length = 0;
    this._procIdx = 0;
    this._lastEnter = 0;
    this._renderTicker(false);           // clears the pool, no enter animation

    // vitals gate — force a recompute on the first frame of the new session
    this._statCur = -1;
    this._lastActive = -1;

    // meter: drop the value caches so update() rewrites, and kill any compaction
    // flash left mid-animation by the outgoing session
    this._numStr = '';
    this._pctStr = '';
    this._mFillXf = '';
    this._mTipXf = '';
    this._meterEl.classList.remove('flash-a', 'flash-b');
    this._tpXf = '';                     // tower annotation re-pins next frame

    // filter chip + legend bank: main.js clears ctx.state.filterTool on a swap
    // (the old session's tool may not exist in the new ring), so return the
    // bank to all-lit now rather than one frame late
    this._filterCur = null;
    this._filterEl.classList.remove('show');
    for (const chip of Object.values(this._legChips)) {
      if (chip.className !== 'hudx-lg') chip.className = 'hudx-lg';
    }

    // scrubber transport: speed and playing are carried across the cut by
    // main.js, so the label is re-read rather than reset
    if (this._sFill) {
      this._sFillXf = '';
      this._sHeadXf = '';
      this._playGlyph = '';
      this._timeStr = '';
      this._speedBtn.textContent = ctx.timeline.speed + '×';
      this._drag = false;                // a pointer capture cannot survive a cut
      this._barW = this._sBarEl.clientWidth || this._barW;
    }
  },

  update(dt, state, ctx) {
    const tl = ctx.timeline;
    const cur = tl.cursor;
    if (this._evs.length > this._prefixLen) this._extendPrefix(this._evs.length);
    const P = this._prefix;

    // (6) filter indicator + legend dim — read-only off shared UI state
    const f = ctx.state.filterTool;
    if (f !== this._filterCur) {
      this._filterCur = f;
      if (f) {
        const fam = ctx.toolFamily(f);
        const col = this._famCSS[fam] ?? ctx.CSS.hudText;
        this._filterEl.textContent = `FILTER // ${shortTool(f).toUpperCase()} — ESC TO CLEAR`;
        this._filterEl.style.color = col;
        this._filterEl.style.textShadow = `0 0 7px ${col}66`;
        this._filterEl.style.boxShadow = `inset 0 0 0 1px ${col}77,0 0 18px ${ctx.CSS.void}99`;
        this._filterEl.classList.add('show');
        for (const [k, chip] of Object.entries(this._legChips)) {
          const cls = 'hudx-lg ' + (k === fam ? 'on' : 'off');
          if (chip.className !== cls) chip.className = cls;
        }
      } else {
        this._filterEl.classList.remove('show');
        for (const chip of Object.values(this._legChips)) {
          if (chip.className !== 'hudx-lg') chip.className = 'hudx-lg';
        }
      }
    }

    // (2) vitals — prefix sums make counts exact even across seeks
    const active = state.activeSubagents.length;
    if (cur !== this._statCur || active !== this._lastActive) {
      this._statCur = cur;
      this._lastActive = active;
      this._setVal(this._vTools, pad(P.tool[cur], 4));
      // explicit notation: done = spawned-so-far minus still-active (clamped —
      // spawnVt interpolation can lead the spawn event by a frame at seeks)
      this._setVal(this._vSub, active + ' ACTIVE / ' + Math.max(P.spawn[cur] - active, 0) + ' DONE');
      this._setVal(this._vComp, pad(P.comp[cur], 2));
      this._setVal(this._vHook, pad(P.hook[cur], 2));
    }

    // (4) ticker + compaction flash
    const prev = this._procIdx;
    if (cur < prev) {
      // backward seek — rebuild the tail from history
      this._lines.length = 0;
      for (let i = cur - 1; i >= 0 && this._lines.length < TICKER_LINES; i--) {
        const L = this._makeLine(this._evs[i]);
        if (L) this._lines.push(L);
      }
      this._renderTicker(false);
    } else if (cur > prev) {
      const jump = cur - prev;
      let added = 0;
      for (let i = Math.max(prev, cur - 12); i < cur; i++) {
        const L = this._makeLine(this._evs[i]);
        if (L) { this._lines.unshift(L); added++; }
      }
      if (this._lines.length > TICKER_LINES) this._lines.length = TICKER_LINES;
      if (added) this._renderTicker(jump < SEEK_JUMP);
      if (jump < SEEK_JUMP && P.comp[cur] > P.comp[prev]) this._flashMeter();
    }
    this._procIdx = cur;

    // (3) context meter — composited transforms, strings only when changed
    const c = state.context;
    const total = clamp01(c.ctx / this._cap);
    const freshF = clamp01(Math.min(c.fresh, c.ctx) / this._cap);
    const base = Math.max(total - freshF, 0);
    const fillXf = `scaleX(${total.toFixed(5)})`;
    if (fillXf !== this._mFillXf) { this._mFillXf = fillXf; this._mFill.style.transform = fillXf; }
    const tipXf =
      `translateX(${(base * 100).toFixed(3)}%) scaleX(${Math.max(freshF, total > 0.002 ? 0.003 : 0).toFixed(5)})`;
    if (tipXf !== this._mTipXf) { this._mTipXf = tipXf; this._mTip.style.transform = tipXf; }
    const numStr = Math.round(c.ctx).toLocaleString('en-US');
    if (numStr !== this._numStr) { this._numStr = numStr; this._num.textContent = numStr; }
    const pctStr = (total * 100).toFixed(1) + '%';
    if (pctStr !== this._pctStr) {
      this._pctStr = pctStr;
      this._pct.textContent = pctStr;
      this._tp.textContent = pctStr; // tower annotation mirrors the meter exactly
    }

    // (3b) tower fill-line annotation — project the stack's current fill height
    // to screen and pin the percent beside it. Anchor sits one tower radius
    // along camera-right so the label clears the slab silhouette from any rig
    // preset; hidden when the tower leaves frame or falls behind the camera.
    {
      const cam = ctx.camera, L = ctx.LAYOUT;
      cam.updateWorldMatrix(true, false);
      const v = this._v3a.set(
        L.towerPos[0],
        L.towerPos[1] + total * L.towerMaxHeight,
        L.towerPos[2]
      );
      v.addScaledVector(this._v3b.setFromMatrixColumn(cam.matrixWorld, 0), L.towerRadius + 0.8);
      v.project(cam);
      const vis = v.z < 1 && Math.abs(v.x) < 1.08 && Math.abs(v.y) < 1.08;
      if (vis !== this._tpVis) {
        this._tpVis = vis;
        this._tp.style.visibility = vis ? 'visible' : 'hidden';
      }
      if (vis) {
        const xf = `translate3d(${((v.x * 0.5 + 0.5) * innerWidth).toFixed(1)}px,${((-v.y * 0.5 + 0.5) * innerHeight).toFixed(1)}px,0) translateY(-50%)`;
        if (xf !== this._tpXf) { this._tpXf = xf; this._tp.style.transform = xf; }
      }
    }

    // (5) scrubber
    if (this._sFill) {
      const sfXf = `scaleX(${state.progress.toFixed(5)})`;
      if (sfXf !== this._sFillXf) { this._sFillXf = sfXf; this._sFill.style.transform = sfXf; }
      if (!this._barW) this._barW = this._sBarEl.clientWidth;
      const shXf = `translateX(${(state.progress * this._barW).toFixed(1)}px)`;
      if (shXf !== this._sHeadXf) { this._sHeadXf = shXf; this._sHead.style.transform = shXf; }
      const g = tl.playing && !state.done ? '❚❚' : '▶';
      if (g !== this._playGlyph) { this._playGlyph = g; this._playBtn.textContent = g; }
      const ts = 'T+' + state.vt.toFixed(1).padStart(5, '0');
      if (ts !== this._timeStr) { this._timeStr = ts; this._timeEl.textContent = ts; }
    }
  },

  resize() {
    if (this._sBarEl) this._barW = this._sBarEl.clientWidth;
  },
};
