// attract.js — ATTRACT MODE: the machine dreams when the fleet sleeps.
// SEAMLESS by design ruling: no title cards, no "NOW
// SHOWING" chrome, no attract-branded UI of any kind. Attract is invisible
// curation — the current session plays through the ordinary archive pipeline
// (main.js loads it; every module renders it exactly as if the user had picked it
// from the library) while this module quietly rotates the program.
//
// ACTIVE only when ctx.playing.mode === 'attract' (main.js sets that on the
// live-first ARCHIVE FALLBACK and on ?session=<id>&attract=1 — see the URL
// PARAM SEMANTICS block in main.js's header). Fully inert otherwise, and
// fully inert under ?freeze=1 (main.js also refuses to mint attract mode in
// shot mode — belt and suspenders).
//
//   · PLAYLIST — /data/library/index.json: flagship first, then sessions by
//     toolCalls desc. Held IN MEMORY (this._list) with a pointer (this._i) into
//     it. The pointer is seeded from ctx.playing.sessionId at init (null =
//     flagship; an unknown id leaves it at -1 so the next entry is the
//     flagship). Wraps at the end.
//   · ADVANCE — IN PLACE, no navigation. Timeline done for ~DONE_HOLD_MS, or
//     DWELL_MAX_MS wall-clock on one entry, whichever first:
//       eased ~450ms fade to black (self-owned overlay, same recipe as
//       zoomRail's fade plate) → await ctx.swapSession({ session, attract:true })
//       → eased ~450ms fade back in.
//     WHY: advance used to be location.replace(), i.e. a full page reload per
//     playlist entry — visible stutter, and the SomaFM <audio> element was
//     destroyed and had to re-buffer from scratch every time. A swap keeps the
//     page alive, so the radio plays continuously ACROSS the cut and audio.js
//     needs no involvement whatsoever (it is never touched here, and it has no
//     reset hook by construction — see main.js's SESSION SWAP CONTRACT).
//     · The pointer then moves to the entry we just swapped in — recomputed
//       from memory, never re-read from the URL, which no longer changes on
//       advance.
//     · The URL is kept honest with history.replaceState — ?attract=1 for the
//       flagship, ?session=<id>&attract=1 otherwise — so a manual refresh
//       resumes the reel where it actually is (the same URLs the old navigation
//       used, so refresh behaviour is unchanged).
//     · FALLBACK: if ctx.swapSession is missing (older host) or resolves false
//       (load failed / a swap already in flight), we take the OLD navigation
//       path to the same URL rather than leaving the reel stuck on one entry.
//       Rare and loud — the reload cost is the price of not stalling.
//   · LIVE INTERRUPT — a light roster poll every 15s (same-origin first, then
//     the dev tail on :5198; the answering base is remembered, re-discovered
//     on failure; roster published on window.__CSPACE_ROSTER like main.js's
//     paths do). Any active session → fade out → /?live=<id>. The arcade
//     cabinet noticing a player. This one still NAVIGATES, deliberately: going
//     live changes the DATA SOURCE, not just the session, and swapSession is
//     archive-only. It is rare, so the reload is honest there. It is also
//     skipped while an advance swap is mid-flight; the next sweep picks it up.
//   · INPUT COURTESY — any pointerdown/keydown holds ALL switching (advance
//     AND live interrupt) for 90s; the current session just keeps playing.
//     Someone is at the cabinet — don't yank the view. ESC never exits
//     attract; it already has other duties (library panel close).
//   · reset(ctx) — main.js calls this after ANY swap, including one the library
//     panel started. Re-derives the pointer from ctx.playing.sessionId and
//     restarts the dwell clock, so a hand-picked session becomes the new place
//     in the reel instead of leaving the pointer where the program was.
//
// Init order: registered last in main.js MODULES, after hud — the identity
// normalization below depends on hud's DOM existing.
// DOM/CSS only: no THREE, registers nothing with ctx.pick, owns its own
// <style>. Import-clean under plain node — no top-level DOM/GL access.

const INDEX_URL = '/data/library/index.json';
// WALL CLOCK, deliberately. This used to accumulate the render loop's clamped
// dt, which made the hold a function of FRAME RATE: an occluded or backgrounded
// window is throttled to ~1fps by Chrome, where dt clamps to 0.1 and a 3s hold
// needed 30 frames = ~30s of real time (measured: 50s total advance latency).
// A display that loses focus must not silently stop advancing, so the dwell is
// timed against performance.now() and only needs A frame to notice.
const DONE_HOLD_MS = 3_000;         // timeline must sit finished this long
const DWELL_MAX_MS = 6 * 60_000;    // hard cap on one entry
const COURTESY_MS = 90_000;         // input holds switching this long
const ROSTER_POLL_MS = 15_000;
const ROSTER_TIMEOUT_MS = 1500;
const TAIL_BASES = ['', 'http://localhost:5198'];  // same order as main.js discoverTail
const FADE_MS = 600;                // departure fade (live interrupt / fallback nav)
const SWAP_MS = 450;                // in-place advance fade, each direction
const FADE_GRACE_MS = 150;          // transitionend watchdog slack

export default {
  name: 'attract',

  init(ctx) {
    this._leaving = false;
    this._swapping = false;   // an in-place advance is mid-flight (fade/swap/fade)
    this._doneSince = null;   // wall-clock ms when the timeline went done
    this._armed = false;      // listeners/DOM/playlist built (once per page)
    this._frozen = ctx.params.get('freeze') === '1';
    this._on = ctx.playing?.mode === 'attract' && !this._frozen;
    this._ctx = ctx;          // stable object — only its fields rebind on a swap
    if (!this._on) return;    // inert for now — a later swap may still arm us
    this._arm(ctx);
  },

  // Build the listeners, style, poll and playlist. Split out of init because a
  // page that did NOT boot into attract can still ENTER it via a swap — a
  // library pick is the common case (boot is 'live' whenever a session is
  // running, so picks used to land in plain 'archive' and dead-end at the end of
  // the timeline with no way to continue the reel). Idempotent: arming twice
  // would double the listeners and the poll.
  _arm(ctx) {
    if (this._armed) return;
    this._armed = true;
    this._t0 = performance.now();
    this._holdUntil = 0;      // input courtesy: no switching before this
    this._list = null;        // playlist, resolved when the index arrives
    this._i = -1;             // pointer into _list (-1 → next entry is flagship)
    this._plateEl = null;     // shared fade plate, created on first use
    this._base = null;        // remembered tail base that answered /sessions

    // ---- fade plate style (zoomRail's recipe, slower; self-owned class) ----
    // One plate serves both jobs: .atx-swap shortens it for the in-place
    // advance (which fades both directions), plain for a departure.
    const st = document.createElement('style');
    st.id = 'atx-style';
    st.textContent = `
.atx-fade{position:fixed;inset:0;z-index:32;background:${ctx.CSS.void};opacity:0;
 pointer-events:none;transition:opacity ${FADE_MS}ms cubic-bezier(.4,0,.2,1);}
.atx-fade.atx-swap{transition-duration:${SWAP_MS}ms;}`;
    document.head.appendChild(st);

    // Identity normalization used to live here: hud.js once fell back to a
    // hardcoded flagship label for attract mode, so this module rewrote the
    // node. hud now derives the label from the loaded session in every mode,
    // so attract needs no DOM surgery — playback is indistinguishable from
    // normal viewing by construction.

    // ---- playlist ------------------------------------------------------------
    fetch(INDEX_URL)
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((idx) => {
        this._list = [
          { id: idx.flagship?.id ?? null, flagship: true },
          ...(idx.sessions ?? []).slice().sort((a, b) => (b.toolCalls ?? 0) - (a.toolCalls ?? 0)),
        ];
        // Seed the pointer from what is on screen NOW — a swap may already have
        // happened (library pick) while the index was in flight.
        this._i = this._indexOf(this._ctx.playing?.sessionId ?? null);
      })
      .catch((err) => console.warn(
        '[c-space] attract: library index unavailable — no advance, interrupt only:', err.message));

    // ---- input courtesy ------------------------------------------------------
    // capture so HUD handlers that stopPropagation still register presence.
    const bump = () => { this._holdUntil = performance.now() + COURTESY_MS; };
    addEventListener('pointerdown', bump, { passive: true, capture: true });
    addEventListener('keydown', bump, { passive: true, capture: true });

    // ---- live interrupt poll -------------------------------------------------
    this._pollBusy = false;
    this._iv = setInterval(() => { this._poll(); }, ROSTER_POLL_MS);
  },

  // Called by main.js after every in-place swap — ours, or one the library
  // panel started. The playlist pointer follows what is actually on screen
  // (from ctx.playing, i.e. memory — never the URL, which no longer changes on
  // advance), and the dwell clock restarts for the new entry.
  reset(ctx) {
    this._ctx = ctx;
    const wantOn = ctx.playing?.mode === 'attract' && !this._frozen;

    // ENTERING attract via a swap (library pick on a page that booted live or
    // archive). Arm on first entry, or just resume if we were armed and stopped.
    if (wantOn && !this._on) {
      this._on = true;
      this._arm(ctx);                       // no-op if already armed
      if (this._armed && !this._iv) {
        this._pollBusy = false;
        this._iv = setInterval(() => { this._poll(); }, ROSTER_POLL_MS);
      }
      console.info('[c-space] attract: program rotation started');
    }

    // LEAVING attract on a swap that asked for attract:false (main.js forces
    // that under ?freeze=1). Rotation has no business continuing then. Never
    // during our own advance — that one always requests attract:true.
    if (!wantOn && this._on && !this._swapping) {
      this._on = false;
      clearInterval(this._iv);
      this._iv = null;
      console.info('[c-space] attract: mode left attract on a swap — rotation stopped');
    }

    if (!this._on) return;
    this._doneSince = null;
    this._t0 = performance.now();
    this._i = this._indexOf(ctx.playing?.sessionId ?? null);
  },

  // playlist index of a session id. null = flagship (entry 0). An id that is
  // not in the index returns -1, which _nextIndex turns into the flagship —
  // "unknown ids restart at the flagship", as before.
  _indexOf(id) {
    if (!this._list) return -1;
    if (id == null) return 0;
    return this._list.findIndex((e) => e.id === id);
  },

  _nextIndex() {
    const n = this._list.length;
    return (this._i + 1 + n) % n;
  },

  // The URL an entry corresponds to — used both for history.replaceState after
  // a swap and for the navigation fallback, so the two can never disagree.
  // /?attract=1 re-runs main.js's live-first discovery on arrival, so a
  // refresh at the flagship is also a fresh chance to notice the fleet waking.
  _urlFor(entry) {
    return entry.flagship
      ? '/?attract=1'
      : `/?session=${encodeURIComponent(entry.id)}&attract=1`;
  },

  // one roster sweep: first answering base wins (remembered; forgotten on
  // failure so the next sweep re-discovers). Any active session interrupts —
  // unless input courtesy is holding or an advance swap is mid-flight, in
  // which case the next sweep picks it up.
  async _poll() {
    if (this._leaving || this._pollBusy || this._swapping) return;
    this._pollBusy = true;
    try {
      const bases = this._base != null ? [this._base] : TAIL_BASES;
      for (const base of bases) {
        let roster;
        try { roster = await this._roster(base); } catch { this._base = null; continue; }
        this._base = base;
        window.__CSPACE_ROSTER = roster;
        const live = roster.find((s) => s.active);  // roster is mtime-desc
        if (live && performance.now() >= this._holdUntil && !this._swapping) {
          this._depart(`/?live=${encodeURIComponent(live.id)}`);
        }
        break;
      }
    } finally { this._pollBusy = false; }
  },

  // fetch a roster from one base; throws on timeout, HTTP error, or non-list
  // payload (the vite dev server answers /sessions with the SPA index page).
  async _roster(base) {
    const ac = new AbortController();
    const bail = setTimeout(() => ac.abort(), ROSTER_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/sessions`, { signal: ac.signal });
      if (!res.ok) throw new Error(`roster HTTP ${res.status}`);
      const roster = await res.json();
      if (!Array.isArray(roster)) throw new Error('roster payload is not a list');
      return roster;
    } finally { clearTimeout(bail); }
  },

  // The one fade plate, created on first use and then reused (it lives at
  // opacity 0 / pointer-events none between advances — inert).
  _plate() {
    if (!this._plateEl) {
      const o = document.createElement('div');
      o.className = 'atx-fade';
      document.body.appendChild(o);
      this._plateEl = o;
    }
    return this._plateEl;
  },

  // Eased fade of the plate, resolved when it has landed. to=1 black (and the
  // plate swallows input while it is up), to=0 back to the scene. Watchdog in
  // case transitionend never fires (interrupted transition, hidden tab).
  _fade(to) {
    const o = this._plate();
    o.classList.add('atx-swap');
    o.style.pointerEvents = to ? 'auto' : 'none';
    return new Promise((resolve) => {
      let settled = false;
      const fin = () => {
        if (settled) return;
        settled = true;
        clearTimeout(bail);
        o.removeEventListener('transitionend', fin);
        resolve();
      };
      const bail = setTimeout(fin, SWAP_MS + FADE_GRACE_MS);
      o.addEventListener('transitionend', fin);
      // double-rAF so the transition start style commits before the flip
      requestAnimationFrame(() => requestAnimationFrame(() => { o.style.opacity = to ? '1' : '0'; }));
    });
  },

  // ADVANCE — in place. Fade out, swap the session under the live page, fade
  // back in. No navigation, so the WebGL context, the renderer and (the whole
  // point) the SomaFM <audio> element all survive: the radio never re-buffers.
  async _advance() {
    if (this._leaving || this._swapping || !this._list || !this._list.length) return;
    const j = this._nextIndex();
    const entry = this._list[j];
    const url = this._urlFor(entry);
    const swap = this._ctx?.swapSession;

    // No swap available (older host): the old navigation path, unchanged.
    if (typeof swap !== 'function') { this._depart(url); return; }

    this._swapping = true;            // latched before the first await: update()
    try {                             // and _poll() both stand down until we're done
      await this._fade(1);
      if (this._leaving) return;      // a departure won the race — it owns the plate

      let ok = false;
      try {
        ok = await swap({ session: entry.flagship ? null : entry.id, attract: true });
      } catch (err) {
        console.warn('[c-space] attract: swapSession threw:', err?.message ?? err);
      }
      if (this._leaving) return;

      if (!ok) {
        // Refused (one already in flight) or the load failed — main.js left the
        // current session untouched. Rather than stall the reel on one entry,
        // fall back to the old navigation. We are already black, so _depart
        // navigates immediately instead of fading twice.
        console.warn('[c-space] attract: swap refused for',
          entry.flagship ? 'flagship' : entry.id, '— falling back to navigation');
        this._depart(url);
        return;
      }

      // Pointer moves from memory, not from the URL (which no longer changes).
      // reset() already derived the same index from ctx.playing during the
      // swap; this is the authoritative statement of it either way.
      this._i = j;
      this._t0 = performance.now();
      this._doneSince = null;
      // Keep the URL honest so a manual refresh resumes where the reel is.
      try { history.replaceState(null, '', url); } catch { /* opaque origin */ }

      await this._fade(0);
    } finally {
      this._swapping = false;
    }
  },

  // eased fade to black, then teardown-free navigation. Used by the live
  // interrupt and by the advance fallback. Idempotent — the first departure
  // wins; the overlay swallows input. When the plate is already black (advance
  // fallback) it goes immediately instead of fading a second time.
  _depart(url) {
    if (this._leaving) return;
    this._leaving = true;
    clearInterval(this._iv);
    const o = this._plate();
    const black = o.style.opacity === '1';
    o.classList.remove('atx-swap');     // full-length departure fade
    o.style.pointerEvents = 'auto';
    let gone = false;
    const go = () => {
      if (gone) return;
      gone = true;
      try { sessionStorage.setItem('cspaceFade', '1'); } catch { /* private mode */ }
      location.replace(url);
    };
    if (black) { go(); return; }        // already faded out — don't stall on black
    o.addEventListener('transitionend', go);
    setTimeout(go, FADE_MS + FADE_GRACE_MS);   // fallback if transitionend never fires
    // double-rAF so the transition start style commits before the flip
    requestAnimationFrame(() => requestAnimationFrame(() => { o.style.opacity = '1'; }));
  },

  update(dt, state, ctx) {
    if (!this._on || this._leaving || this._swapping) return;
    // F-freeze is an explicit "hold this frame" — the study gesture. It must
    // outrank the reel: parking on the last frame of a session (where done is
    // true) would otherwise advance the moment input courtesy lapsed, yanking
    // away the very thing being studied. Hold the dwell clocks too, so
    // unfreezing gives a full DONE_HOLD_MS rather than an instant cut.
    if (ctx?.state?.frozen) { this._doneSince = null; this._t0 = performance.now(); return; }
    // done-hold accumulates even during courtesy — once the hold expires an
    // already-finished timeline advances on the next frame.
    const now = performance.now();
    if (!state.done) this._doneSince = null;
    else if (this._doneSince == null) this._doneSince = now;
    if (now < this._holdUntil) return;   // someone is at the cabinet
    if (!this._list) return;             // index unreachable — nowhere to go
    const held = this._doneSince != null && now - this._doneSince >= DONE_HOLD_MS;
    if (held || now - this._t0 >= DWELL_MAX_MS) {
      this._advance();                   // async; the latch inside blocks re-entry
    }
  },
};
