// library.js — SESSION LIBRARY picker for C-SPACE. Pure DOM/CSS inside #hud.
// A top-center chip (click, or key L) toggles a panel listing every archived
// session from /data/library/index.json: the flagship plus library rows with
// vitals — project (compressed), duration, events, tool calls, subagents,
// compactions, peak context as a thin bar against THAT ROW'S OWN window — and a LIVE
// row (pulsing dot) that tails a running session. ESC closes; fast fade/slide
// on toggle. Registers nothing with ctx.pick (DOM only). Owns its own <style>
// block. Hidden entirely in ?freeze=1 shot mode. No THREE, no canvas, no
// imports. Node-safe: no DOM access at module scope — everything in init().
//
// ROW ACTIVATION — in place when it can be (see SESSION SWAP CONTRACT in
// main.js). An archive row calls ctx.swapSession({ session, attract }): no
// navigation, so the page — and with it the SomaFM <audio> element, the WebGL
// context and the whole audio graph — survives the cut. Only transitions that
// change the DATA SOURCE still navigate: the LIVE TAIL row (?live=1) and the
// tail-derived fallback rows (?live=<id>), which is what the swap contract
// says. If ctx.swapSession is absent (older host), every row falls back to the
// old URL route.
//
// CURRENT-ROW HIGHLIGHT is derived from ctx.playing (mode + sessionId), NOT
// from URL params: a swap never changes location, so ?session= is stale the
// moment one happens. reset(ctx) re-derives it and redraws the row list from
// the cached index — no refetch, no GPU state (this module allocates none).

const INDEX_URL = '/data/library/index.json';

// ---- pure helpers ----------------------------------------------------------
// "C--Users-you-myapp" or "C:\Users\you\myapp" → "myapp"
const compressProject = (p) => {
  if (!p) return '—';
  let s = String(p).replace(/[\\/:]+/g, '-');
  s = s.replace(/^-*[A-Za-z]-+Users-+[^-]+-+/i, '');
  return (s || '—').toLowerCase();
};

const fmtDur = (min) => {
  if (min == null || !isFinite(min)) return '—';
  if (min >= 1440) return (min / 1440).toFixed(1) + 'D';
  if (min >= 60) return (min / 60).toFixed(1) + 'H';
  return Math.round(min) + 'M';
};

const fmtK = (n) => {
  if (n == null || !isFinite(n)) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return String(n);
};

const fmtN = (n) => (n == null || !isFinite(n) ? '—' : String(n));

// ---- per-row context ceilings ----------------------------------------------
// The peak-context bar is a fraction of a WINDOW, and the window is a property
// of the session, not of the build: measuring a 113k-peak Codex session that
// ran on a 200k window against 1M renders it as a sliver next to a Claude row
// and says something false about how context-heavy it was.
//
// A row states its own ceiling when the index carries one (contextCap). When it
// does not, derive the smallest standard window that still contains the peak —
// wrong only in the harmless direction (too generous), and never wrong by the
// 5x that a hardcoded 1M is for a 200k session. Peaks past the ladder fall back
// to the build-wide cap, and past that to the peak itself, so a bar can be full
// but never overflows its track.
const CAP_LADDER = [200_000, 400_000, 1_000_000];

const deriveCap = (peak, fallback) => {
  if (peak == null || !isFinite(peak) || peak <= 0) return fallback;
  for (const c of CAP_LADDER) if (peak <= c) return c;
  return Math.max(fallback, peak);
};

const rowCap = (cap, peak, fallback) =>
  (cap != null && isFinite(cap) && cap > 0 ? cap : deriveCap(peak, fallback));

export default {
  name: 'library',

  init(ctx) {
    if (ctx.params.get('freeze') === '1') return; // shot mode: no library chrome

    const C = ctx.CSS;
    // Build-wide fallback ceiling, read at CALL time (not captured): after a
    // swap ctx.contextCap is the newly playing session's window, and rows with
    // no ceiling of their own should fall back to something current.
    const fallbackCap = () => Math.max(1, ctx.contextCap ?? ctx.CONTEXT_TOKEN_CAP);

    // WHAT IS PLAYING, read at call time. Derived from ctx.playing, never from
    // ctx.params: an in-place swap replaces ctx.playing and leaves the URL
    // alone, so the params say whatever the page happened to boot with.
    // mode 'live' → the LIVE TAIL row; sessionId null → flagship; else the
    // matching library row. (An intended side effect: a ?live=<id> boot whose
    // stream failed and fell back to archive now highlights the row it is
    // actually playing instead of LIVE TAIL.)
    const playingLive = () => ctx.playing?.mode === 'live';
    const playingId = () => (playingLive() ? null : ctx.playing?.sessionId ?? null);

    // Flagship stats are not in index.json; when the flagship IS the loaded
    // session, fill its row from the live ctx (counts agree with the HUD:
    // timeline arrays are compaction-deduped). Recomputed per render — after a
    // swap the flagship may have become, or stopped being, the playing session.
    const flagshipStats = () => {
      if (playingLive() || playingId() != null) return {};
      const meta = ctx.session?.meta ?? {};
      return {
        project: compressProject(meta.cwd),
        durationMin: meta.durationS != null ? meta.durationS / 60 : null,
        events: ctx.timeline?.events?.length ?? ctx.session?.events?.length,
        toolCalls: meta.toolCalls,
        subagents: ctx.session?.subagents?.length,
        compactions:
          ctx.timeline?.compactions?.length ?? ctx.session?.compactions?.length,
        peakContext: meta.peakContext,
        // the flagship IS the playing session here, so its ceiling is the one
        // the tower and the meter are already using
        contextCap: meta.contextCap ?? ctx.contextCap,
      };
    };

    // ---- style block --------------------------------------------------------
    const st = document.createElement('style');
    st.id = 'libx-style';
    st.textContent = `
.libx{position:absolute;inset:0;pointer-events:none;color:${C.hudText};
 font-family:"Cascadia Code","Cascadia Mono",ui-monospace,Consolas,monospace;
 text-transform:uppercase;line-height:1.35;-webkit-font-smoothing:antialiased;user-select:none;
 --libx-cols:minmax(118px,1.3fr) minmax(74px,1fr) 46px 50px 52px 34px 40px 96px;}

/* shared scrim — same darkness recipe as the HUD blocks */
.libx-chip,.libx-panel{
 background:
  repeating-linear-gradient(0deg,transparent 0 2px,${C.cache}07 2px 3px),
  linear-gradient(168deg,${C.void}d9 0%,${C.void}b3 55%,${C.void}d9 100%);
 -webkit-backdrop-filter:blur(7px) brightness(.62) saturate(1.15);
 backdrop-filter:blur(7px) brightness(.62) saturate(1.15);
 box-shadow:inset 0 0 0 1px ${C.hudDim}3a,0 0 18px ${C.void}99;}

/* --- affordance chip (top-center) --- */
.libx-chip{position:absolute;top:26px;left:50%;transform:translateX(-50%);
 pointer-events:auto;cursor:pointer;padding:8px 18px;
 font-size:9px;letter-spacing:.34em;color:${C.hudText};
 animation:libxIn .7s cubic-bezier(.2,.9,.2,1) .45s both;
 transition:color .15s ease,box-shadow .15s ease,text-shadow .15s ease;}
.libx-chip::before,.libx-chip::after{content:"";position:absolute;width:9px;height:9px;}
.libx-chip::before{top:0;left:0;border-top:1px solid ${C.cache};border-left:1px solid ${C.cache};}
.libx-chip::after{bottom:0;right:0;border-bottom:1px solid ${C.cache};border-right:1px solid ${C.cache};}
.libx-chip:hover,.libx-chip.on{color:${C.coreHot};text-shadow:0 0 8px ${C.cache}88;
 box-shadow:inset 0 0 0 1px ${C.cache}66,0 0 18px ${C.void}99;}
.libx-key{color:${C.hudDim};margin-left:.7em;letter-spacing:.2em;}
.libx-chip:hover .libx-key,.libx-chip.on .libx-key{color:${C.cache};}
@keyframes libxIn{from{opacity:0;transform:translate(-50%,6px);}to{opacity:1;transform:translate(-50%,0);}}

/* --- panel (fast fade/slide) --- */
.libx-panel{position:absolute;top:66px;left:50%;width:min(720px,94vw);
 transform:translate(-50%,-10px);opacity:0;visibility:hidden;pointer-events:none;
 transition:opacity .16s cubic-bezier(.2,.9,.2,1),transform .16s cubic-bezier(.2,.9,.2,1),
  visibility 0s linear .16s;
 box-shadow:inset 0 0 0 1px ${C.cache}40,0 0 30px ${C.void}cc;}
.libx-panel.open{opacity:1;visibility:visible;pointer-events:auto;
 transform:translate(-50%,0);transition-delay:0s;}

.libx-ph{display:flex;justify-content:space-between;align-items:baseline;
 padding:12px 16px 6px;border-bottom:1px solid ${C.cache}2e;}
.libx-title{font-size:9px;letter-spacing:.32em;color:${C.cache};text-shadow:0 0 8px ${C.cache}44;}
.libx-close{pointer-events:auto;cursor:pointer;font-size:8px;letter-spacing:.24em;color:${C.hudDim};}
.libx-close:hover{color:${C.hudText};}

/* --- wall mode selector: what an unattended display does --- */
.libx-wall{display:flex;align-items:center;gap:8px;padding:8px 16px 9px;
 border-bottom:1px solid ${C.cache}2e;font-size:8px;letter-spacing:.24em;color:${C.hudDim};}
.libx-wall-h{margin-right:2px;}
.libx-wm{pointer-events:auto;cursor:pointer;padding:3px 9px;color:${C.hudDim};
 box-shadow:inset 0 0 0 1px ${C.hudDim}3a;transition:color .15s ease,box-shadow .15s ease;}
.libx-wm:hover{color:${C.hudText};box-shadow:inset 0 0 0 1px ${C.cache}66;}
.libx-wm.on{color:${C.coreHot};box-shadow:inset 0 0 0 1px ${C.cache};
 text-shadow:0 0 7px ${C.cache}66;}
.libx-wall-note{margin-left:auto;color:${C.hudDim};opacity:.75;letter-spacing:.16em;}

/* --- rows --- */
.libx-rows{max-height:min(52vh,420px);overflow-y:auto;overflow-x:hidden;padding-bottom:6px;}
.libx-rows::-webkit-scrollbar{width:6px;}
.libx-rows::-webkit-scrollbar-thumb{background:${C.hudDim}66;}
.libx-rows::-webkit-scrollbar-track{background:transparent;}
.libx-row{display:grid;grid-template-columns:var(--libx-cols);gap:0 12px;align-items:center;
 padding:7px 16px;font-size:9.5px;letter-spacing:.14em;color:${C.hudDim};cursor:pointer;
 border-top:1px solid ${C.hudDim}22;transition:background .15s ease,color .15s ease;}
.libx-row:first-child{border-top:none;}
.libx-row:hover{background:${C.cache}12;color:${C.hudText};}
.libx-row.cur{color:${C.hudText};background:${C.cache}0d;box-shadow:inset 2px 0 0 ${C.cache};}
.libx-head,.libx-head:hover{cursor:default;background:none;color:${C.hudDim};
 font-size:8px;letter-spacing:.26em;padding-top:10px;padding-bottom:4px;border-top:none;}
.libx-lab{color:${C.cache};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
 display:flex;align-items:center;}
.libx-row:hover .libx-lab,.libx-row.cur .libx-lab{color:${C.coreHot};text-shadow:0 0 7px ${C.cache}55;}
.libx-head .libx-lab{color:inherit;text-shadow:none;}
.libx-proj{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.libx-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}

/* peak context: thin bar vs that row's own context window */
.libx-peak{display:flex;align-items:center;gap:7px;}
.libx-bar{flex:1;height:3px;background:${C.void}cc;box-shadow:inset 0 0 0 1px ${C.hudDim}55;position:relative;}
.libx-fill{position:absolute;left:0;top:0;bottom:0;
 background:linear-gradient(90deg,${C.cache}77,${C.cache});box-shadow:0 0 5px ${C.cache}66;}
.libx-fill.hot{background:linear-gradient(90deg,${C.cache}77,${C.fresh});box-shadow:0 0 5px ${C.fresh}88;}
.libx-pknum{min-width:4ch;text-align:right;font-variant-numeric:tabular-nums;}

/* live row pulsing dot */
.libx-dot{display:inline-block;width:6px;height:6px;border-radius:50%;flex:none;
 background:${C.fresh};box-shadow:0 0 6px ${C.fresh};margin-right:7px;
 animation:libxPulse 1.2s ease-in-out infinite;}
@keyframes libxPulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.35;transform:scale(.7);}}

.libx-msg{padding:14px 16px;font-size:9px;letter-spacing:.24em;color:${C.hudDim};}
.libx-msg.err{color:${C.error};text-shadow:0 0 6px ${C.error}55;}
`;
    document.head.appendChild(st);

    // ---- DOM ----------------------------------------------------------------
    const el = (tag, cls, parent, text) => {
      const d = document.createElement(tag);
      if (cls) d.className = cls;
      if (text != null) d.textContent = text;
      parent.appendChild(d);
      return d;
    };
    const div = (cls, parent, text) => el('div', cls, parent, text);

    const root = div('libx', document.getElementById('hud'));

    // chip mounts into the shared #chips flex row (index.html) so it can never
    // overlap chips from other modules; falls back to root if the row is absent
    const chip = div('libx-chip', document.getElementById('chips') ?? root, 'LIBRARY');
    el('span', 'libx-key', chip, '[L]');

    const panel = div('libx-panel', root);
    const ph = div('libx-ph', panel);
    div('libx-title', ph, '// SESSION LIBRARY');
    const closeBtn = div('libx-close', ph, '[ESC] CLOSE');
    // ---- wall mode selector -------------------------------------------------
    // The program an unattended display runs. Lives here because the library IS
    // the program surface. Persisted to localStorage; ?wall= overrides a single
    // load without rewriting the stored choice (main.js resolves precedence).
    const WALL = [
      ['live', 'LIVE', 'follows active sessions'],
      ['library', 'LIBRARY', 'archive reel only, never cuts away'],
      ['solo', 'SOLO', 'holds one session'],
    ];
    const wallRow = div('libx-wall', panel);
    div('libx-wall-h', wallRow, '// WALL MODE');
    const wallNote = div('libx-wall-note', wallRow, '');
    const wallChips = {};
    for (const [mode, label, blurb] of WALL) {
      const chip = div('libx-wm', wallRow, label);
      chip.title = blurb;
      wallChips[mode] = chip;
      chip.addEventListener('click', () => setWall(mode));
      wallRow.insertBefore(chip, wallNote);   // note stays right-aligned last
    }
    const paintWall = () => {
      const cur = ctx.state.wallMode ?? 'live';
      for (const [mode] of WALL) {
        const cls = 'libx-wm' + (mode === cur ? ' on' : '');
        if (wallChips[mode].className !== cls) wallChips[mode].className = cls;
      }
      const blurb = (WALL.find((w) => w[0] === cur) ?? WALL[0])[2];
      if (wallNote.textContent !== blurb) wallNote.textContent = blurb;
    };
    const setWall = (mode) => {
      ctx.state.wallMode = mode;
      try { localStorage.setItem('cspace-wall', mode); } catch { /* storage off */ }
      paintWall();
    };
    paintWall();

    const rowsHost = div('libx-rows', panel);

    // ---- navigation — main.js reads these params at boot --------------------
    // Still the route for anything that changes the DATA SOURCE (live/tail
    // rows), and the fallback when no swap is available.
    const go = (patch) => {
      const p = new URLSearchParams(location.search);
      for (const k of ['session', 'live', 't', 'freeze', 'cam']) p.delete(k);
      for (const [k, v] of Object.entries(patch)) p.set(k, v);
      const qs = p.toString();
      location.assign(location.pathname + (qs ? '?' + qs : ''));
    };

    // ---- archive row activation — IN PLACE ----------------------------------
    // id: a library session id, or null for the flagship. A swap keeps the page
    // (and therefore the audio stream) alive, so picking a session is as
    // seamless as an attract advance. attract is carried across: if the cabinet
    // is running the program, a hand-picked session must not silently end it —
    // that is also what the old URL route did, since `go` above preserves
    // ?attract=1. main.js forces it false under ?freeze=1.
    // The panel closes on activation, as it did when the click navigated.
    const activate = (id) => {
      if (typeof ctx.swapSession !== 'function') { go(id ? { session: id } : {}); return; }
      setOpen(false);
      // A pick CONTINUES THE PROGRAM. Picking from the library is an
      // interactive "show me this" — when the session ends, rolling on to the
      // next one is what a display wants, and it is what the panel implies.
      // Previously this inherited the current mode, so on any machine with a
      // running session (boot = live) a pick landed in plain 'archive' and
      // dead-ended on its last frame with no way to resume the reel.
      // Deliberately NOT true for a URL-driven ?session=<id>: that stays a
      // deterministic single-session load (screenshots, inspection), and
      // main.js forces attract off under ?freeze=1 regardless. To hold a picked
      // session on screen indefinitely, press F — freeze outranks the reel.
      const attract = true;
      const done = ctx.swapSession({ session: id, attract });
      // resolves false when a swap is already in flight or the load failed —
      // the session on screen is untouched, so the highlight is still correct.
      done?.then?.((ok) => {
        if (!ok) { console.warn('[c-space] library: swap refused for', id ?? 'flagship'); return; }
        // An explicit pick outranks the program: tell attract to stand its live
        // interrupt down, so a session you chose to watch is not yanked to the
        // tail 90s later. Cleared when the reel advances on its own.
        ctx.state.userPicked = true;
        // Keep the URL honest, exactly as attract's advance does. A swap never
        // navigates, so without this the address bar still names the PREVIOUS
        // session and a manual refresh would reload that one instead of what is
        // actually on screen. Same param grammar `go` would have produced.
        try {
          const p = new URLSearchParams(location.search);
          for (const k of ['session', 'live', 't', 'freeze', 'cam']) p.delete(k);
          if (id) p.set('session', id);
          if (attract) p.set('attract', '1');
          const qs = p.toString();
          history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
        } catch { /* opaque origin — the swap still succeeded */ }
      });
    };

    // ---- row rendering ------------------------------------------------------
    const addRow = (r) => {
      const row = div('libx-row' + (r.head ? ' libx-head' : '') + (r.cur ? ' cur' : ''), rowsHost);
      const lab = div('libx-lab', row);
      if (r.dot) div('libx-dot', lab);
      el('span', null, lab, r.label);
      div('libx-proj', row, r.project ?? '—');
      div('libx-num', row, r.dur ?? '—');
      div('libx-num', row, r.evt ?? '—');
      div('libx-num', row, r.calls ?? '—');
      div('libx-num', row, r.sub ?? '—');
      div('libx-num', row, r.comp ?? '—');
      const pk = div('libx-peak', row);
      if (r.head) {
        el('span', null, pk, r.peakLabel ?? '');
      } else {
        // measured against THIS row's ceiling, so a 113k peak on a 200k Codex
        // window reads as the half-full session it was, not as a sliver beside
        // a 1M Claude row. The denominator is not in the column (it would cost
        // the layout), so the cell states it on hover.
        const cap = rowCap(r.cap, r.peak, fallbackCap());
        const bar = div('libx-bar', pk);
        const frac = r.peak != null && isFinite(r.peak) ? Math.min(r.peak / cap, 1) : 0;
        const fill = div('libx-fill' + (frac > 0.9 ? ' hot' : ''), bar);
        fill.style.width = (frac * 100).toFixed(1) + '%';
        div('libx-pknum', pk, fmtK(r.peak));
        pk.title = r.peak != null && isFinite(r.peak)
          ? `PEAK ${Math.round(r.peak).toLocaleString('en-US')} / ${cap.toLocaleString('en-US')} · ${(frac * 100).toFixed(1)}%`
          : 'PEAK CONTEXT UNKNOWN';
      }
      if (r.onClick) row.addEventListener('click', r.onClick);
      return row;
    };

    // viaLive routes the row through the tail (?live=<id>) instead of the
    // parsed archive (?session=<id>). Used by the fresh-clone fallback below:
    // a clone ships no parsed data, but the tail server replays ANY allowlisted
    // session by id, so the library stays usable with zero parsing.
    const sessionRow = (s, cur, viaLive) => ({
      label: s.label ?? s.id?.slice(0, 8) ?? '—',
      project: compressProject(s.project),
      dur: fmtDur(s.durationMin),
      evt: fmtN(s.events),
      calls: fmtN(s.toolCalls),
      sub: fmtN(s.subagents),
      comp: fmtN(s.compactions),
      peak: s.peakContext,
      // the row's own window when the index states one; addRow derives it from
      // the peak otherwise
      cap: s.contextCap ?? s.meta?.contextCap,
      cur,
      onClick: () => (viaLive ? go({ live: s.id }) : activate(s.id)),
    });

    // ---- shared build step: draw the whole row list from index data ----------
    // Called from init (once the index arrives) and again from reset() after a
    // session swap. Every `cur` flag and the flagship vitals are read from ctx
    // at call time, so the same code path produces the right highlight before
    // and after a swap — no duplicated build logic, no refetch.
    const renderRows = (idx) => {
      const curLive = playingLive();
      const curId = playingId();
      rowsHost.textContent = '';
      addRow({
        head: true, label: 'SESSION', project: 'PROJECT', dur: 'DUR', evt: 'EVT',
        calls: 'CALLS', sub: 'SUB', comp: 'COMP', peakLabel: 'PEAK CTX / CAP',
      });
      // LIVE — tail a running session via the local stream server
      addRow({
        label: 'LIVE TAIL', dot: true, project: 'running session',
        cur: curLive,
        onClick: () => go({ live: '1' }),   // data-source change → navigates
      });
      if (!idx) {
        const m = div('libx-msg err', rowsHost, 'LIBRARY INDEX UNREACHABLE // ' + INDEX_URL);
        return m;
      }
      // TAIL-DERIVED fallback (fresh clone, no parsed index): rows replay
      // through the tail server, and there is no parsed flagship to show.
      if (idx.fromTail) {
        div('libx-msg', rowsHost, '// LIVE TAIL — no parsed archive; stats appear once sessions are parsed');
        for (const s of idx.sessions ?? []) {
          addRow(sessionRow(s, false, true));
        }
        if (!(idx.sessions ?? []).length) div('libx-msg', rowsHost, 'NO SESSIONS ON TAIL');
        return;
      }
      // FLAGSHIP — the default session, no ?session param
      const fl = idx.flagship ?? {};
      addRow({
        ...sessionRow({ ...flagshipStats(), ...fl }, !curLive && curId == null),
        onClick: () => activate(null),
      });
      for (const s of idx.sessions ?? []) {
        addRow(sessionRow(s, !curLive && s.id != null && s.id === curId));
      }
      if (!(idx.sessions ?? []).length) div('libx-msg', rowsHost, 'NO ARCHIVED SESSIONS');
    };

    // Fresh-clone fallback source: the tail roster. Same discovery order as
    // main.js — same-origin first (runner), then the dev tail on :5198. The
    // security guard allows these (loopback origin), and /stream?id= replays
    // any listed session, so every roster entry is viewable via ?live=<id>.
    const discoverRoster = async () => {
      for (const base of ['', 'http://localhost:5198']) {
        try {
          const r = await fetch(base + '/sessions');
          if (!r.ok) continue;
          const roster = await r.json();
          if (Array.isArray(roster) && roster.length) return roster;
        } catch { /* try next base */ }
      }
      return null;
    };

    // ---- index fetch (lazy, cached; errors allow retry on next open) --------
    // The resolved payload is kept in this._idx (undefined = never fetched, so
    // reset has nothing to redraw and the first open renders it correctly
    // anyway) purely so a swap can re-render the highlight off cached data.
    let idxPromise = null;
    const ensureIndex = () => {
      if (idxPromise) return;
      rowsHost.textContent = '';
      div('libx-msg', rowsHost, 'ACCESSING LIBRARY…');
      idxPromise = fetch(INDEX_URL)
        .then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then((idx) => { this._idx = idx; renderRows(idx); })
        .catch(async (err) => {
          // No parsed index (fresh clone has an empty store). Fall back
          // to the tail roster so the library still lists real sessions.
          console.info('[c-space] library index unavailable:', err.message, '— trying tail roster');
          const roster = await discoverRoster();
          idxPromise = null; // retry on next open
          this._idx = roster ? { fromTail: true, sessions: roster } : null;
          renderRows(this._idx);
        });
    };

    // reset() has no DOM locals of its own; it drives the same build step init
    // does. Held on the module so a swap can call it without re-running init.
    this._redraw = () => { if (this._idx !== undefined) renderRows(this._idx); };

    // ---- open/close ---------------------------------------------------------
    let isOpen = false;
    const setOpen = (v) => {
      isOpen = v;
      panel.classList.toggle('open', v);
      chip.classList.toggle('on', v);
      if (v) ensureIndex();
    };
    const toggle = () => setOpen(!isOpen);

    chip.addEventListener('click', toggle);
    closeBtn.addEventListener('click', () => setOpen(false));
    addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if ((e.key === 'l' || e.key === 'L') && !e.repeat) toggle();
      else if (e.key === 'Escape' && isOpen) setOpen(false);
    });
  },

  // SESSION SWAP — the URL did not change, so the highlight this module derived
  // at init is now describing the previous session. Re-derive it from
  // ctx.playing by redrawing the row list through init's own build step.
  //
  // NOTHING TO DISPOSE, deliberately: this module allocates no GPU resources at
  // all — no geometry, material, texture, mesh, render target, nothing added to
  // ctx.scene, and no ctx.pick registration (so it can leak no orphan picks
  // either). Its only footprint is DOM. What it KEEPS across a swap, on purpose:
  // the <style> block, the chip, the panel shell and the window keydown / chip
  // click listeners — session-independent chrome built once, and rebuilding it
  // per swap would double-bind the L key and re-run the chip's entry animation.
  // The row nodes ARE replaced (rowsHost.textContent = '' drops them with their
  // own click listeners attached, so no listener outlives its node), and only
  // when the panel has been opened at least once — an attract run that never
  // opens the library does no DOM work per advance. The cached index payload is
  // reused rather than refetched: the library of sessions is not session-shaped.
  // No timers, no per-frame work, no allocation either way.
  // (no ctx parameter needed: init's closures read the stable ctx object at call
  // time — a swap rebinds ctx.session/timeline/playing, never ctx itself.)
  reset() {
    this._redraw?.();   // absent in ?freeze=1 shot mode — init built no chrome
  },

  // DOM-only module: all motion is CSS; nothing to advance per frame.
  update() {},
};
