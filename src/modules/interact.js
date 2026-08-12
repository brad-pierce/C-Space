// interact.js — the interaction layer for C-SPACE. Owns the raycaster, the
// single hover card, the leader line, and click routing over the ctx.pick
// registry. Renders no world geometry; every color is ctx.CSS / ctx.TOOL_COLORS.
//
// hit object passed to spec.card / spec.onHover / spec.onClick:
//   {
//     kind,            — spec.kind of the registered entry
//     spec,            — the registered spec itself
//     object,          — the REGISTERED Object3D (walked up from any descendant)
//     instanceId,      — set when an InstancedMesh instance was struck
//     point,           — world-space hit point (THREE.Vector3)
//     distance,        — camera distance
//     intersect,       — raw three intersection (null for the forced debug hover)
//     forced,          — true only for the ?hover= screenshot hook
//   }
//
// Interaction law (DIRECTION.md) — KILLSCREEN r4 restoration:
//   The card is never a flat rectangle. It carries: cyan corner brackets
//   (coreEnergy, constant — the law's frame), a visible 1px scanline texture,
//   a coreShell-lifted panel so it reads as machined glass rather than black,
//   the full row set the registry supplies (totems: CALLS / % OF CALLS /
//   ERRORS / ERR RATE / OUTPUT / FAMILY), a header rule + kind chip tinted to
//   the hovered totem's family color, error rows warmed to signal red when
//   nonzero, and a thin family-tinted leader line from the card edge to the
//   hovered totem's tip. Response stays <120ms (hover resolves same-frame;
//   only same-target VALUE refreshes are rate-limited); the card never
//   crosses the viewport edge.
//
// Interaction rules:
//   hover  → one .pick-card near the cursor, clamped to viewport;
//            spec.onHover(hit|null) tells the owning module to brighten/restore.
//   click  → pointerdown+up within 6px / 400ms on the same target fires
//            spec.onClick(hit). A clean click on empty space, or ESC anywhere,
//            clears ctx.state.filterTool.
//   debug  → ?hover=<kind>:<key> — after two frames, the entry whose
//            spec.kind===kind && String(spec.debugKey)===key gets its card
//            force-displayed at its projected screen position (persists while
//            ?freeze=1; a real pointer move dismisses it otherwise).
// All handlers stay live in freeze mode; card entrance animations do not.
//
// Perf gates (perf-audit 2026-08-11, interact.js P2s — both taken):
//   • _setCard only re-measures offsetWidth/Height when a content write
//     actually fired, and same-target refreshes are capped at ~10Hz — no
//     per-frame forced reflow while sweeping the chronogram plate.
//   • update() skips the full-registry raycast on static frames (pointer at
//     rest, camera matrices unchanged, registry same size, hover still valid).

const CLICK_SLOP = 6;    // px — max pointer travel for a click
const CLICK_MS = 400;    // ms — max press duration for a click
const CARD_DX = 20;      // px — cursor → card gap, horizontal
const CARD_DY = 14;      // px — cursor → card gap, vertical
const EDGE = 10;         // px — viewport margin the card never crosses
const ROW_POOL = 10;     // label/value rows pre-allocated in init
const SAME_REFRESH_MS = 100; // same-target live-value refresh cap (~10Hz)
const TIP_LIFT = 0.72;   // totem cap apex sits this far above the body bbox top
const LEADER_MIN = 8;    // px — below this the leader reads as noise; hide it

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

export default {
  name: 'interact',

  init(ctx) {
    const T = ctx.THREE;
    this._freeze = ctx.params.get('freeze') === '1';
    this._canvas = ctx.renderer.domElement;
    this._C = ctx.CSS;
    this._toolFamily = ctx.toolFamily;
    this._TOOL_COLORS = ctx.TOOL_COLORS;

    // ---- picking state (all allocation here, never per-frame) ---------------
    this._ray = new T.Raycaster();
    this._ndc = new T.Vector2();
    this._wp = new T.Vector3();      // scratch: forced-hover world position
    this._hits = [];                 // reusable intersection target array
    this._hover = null;              // current hit (identity: object+instanceId)
    this._px = 0;
    this._py = 0;
    this._inside = false;            // pointer over the canvas
    this._moved = false;             // pointer moved since last card refresh
    this._suppress = false;          // orbit-drag in progress — hover muted
    this._down = null;               // pointerdown snapshot for click detection
    this._cursor = '';
    this._vw = innerWidth;
    this._vh = innerHeight;
    this._cw = 0;                    // measured card size
    this._ch = 0;
    this._cx = 0;                    // last placed card position (leader anchor)
    this._cy = 0;
    this._sameAt = 0;                // last same-target content refresh (ms)

    // static-frame raycast gate
    this._camMW = new T.Matrix4();
    this._camPr = new T.Matrix4();
    this._camPrimed = false;         // matrices captured at least once
    this._regSize = -1;

    // leader-line state
    this._box = new T.Box3();        // scratch: hovered totem bounds
    this._tipW = new T.Vector3();    // world-space totem tip
    this._tipS = new T.Vector3();    // scratch: projected tip
    this._tip = false;               // tip valid this hover
    this._leaderOn = false;
    this._cardOn = false;
    this._accent = '';               // current accent CSS color

    // ---- forced debug hover: ?hover=<kind>:<key> ----------------------------
    const hp = ctx.params.get('hover');
    if (hp) {
      const i = hp.indexOf(':');
      this._forced = {
        kind: i < 0 ? hp : hp.slice(0, i),
        key: i < 0 ? '' : hp.slice(i + 1),
        obj: null, spec: null, hit: null, frames: 0, shown: false,
      };
    } else {
      this._forced = null;
    }

    this._buildCard(ctx);
    this._bind(ctx);
  },

  // ---- DOM: the one card + its leader line ----------------------------------
  _buildCard(ctx) {
    const C = ctx.CSS;
    const st = document.createElement('style');
    st.id = 'pick-card-style';
    st.textContent = `
.pick-card{position:fixed;left:0;top:0;z-index:40;pointer-events:none;
 min-width:200px;max-width:320px;padding:10px 13px 9px;
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
.pick-card.show{opacity:1;}
.pick-card::before,.pick-card::after,.pick-card .pc-x::before,.pick-card .pc-x::after{
 content:"";position:absolute;width:12px;height:12px;pointer-events:none;
 filter:drop-shadow(0 0 3px ${C.coreEnergy}59);}
.pick-card::before{top:-1px;left:-1px;border-top:1px solid ${C.coreEnergy};border-left:1px solid ${C.coreEnergy};}
.pick-card::after{bottom:-1px;right:-1px;border-bottom:1px solid ${C.coreEnergy};border-right:1px solid ${C.coreEnergy};}
.pick-card .pc-x{position:absolute;inset:0;}
.pick-card .pc-x::before{top:-1px;right:-1px;border-top:1px solid ${C.coreEnergy};border-right:1px solid ${C.coreEnergy};}
.pick-card .pc-x::after{bottom:-1px;left:-1px;border-bottom:1px solid ${C.coreEnergy};border-left:1px solid ${C.coreEnergy};}
.pick-card .pc-head{display:flex;justify-content:space-between;align-items:baseline;gap:14px;
 padding-bottom:6px;margin-bottom:6px;border-bottom:1px solid ${C.cache}66;}
.pick-card .pc-title{font-size:10.5px;letter-spacing:.24em;color:${C.hudText};white-space:nowrap;
 overflow:hidden;text-overflow:ellipsis;text-shadow:0 0 8px ${C.cache}55,0 0 18px ${C.cache}22;}
.pick-card .pc-kind{font-size:8px;letter-spacing:.3em;color:${C.cache};opacity:.85;flex:none;}
.pick-card .pc-rows{display:grid;grid-template-columns:max-content minmax(0,1fr);
 column-gap:16px;row-gap:3px;}
.pick-card .pc-k{font-size:8.5px;letter-spacing:.22em;color:${C.hudDim};align-self:baseline;}
.pick-card .pc-v{font-size:9.5px;letter-spacing:.12em;color:${C.hudText};text-align:right;
 white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 0 6px ${C.cache}33;}
.pick-card.show .pc-body.slide{animation:pcSlide .12s cubic-bezier(.2,.9,.3,1) both;}
@keyframes pcSlide{from{opacity:0;transform:translateY(5px);}to{opacity:1;transform:none;}}
.pick-leader{position:fixed;left:0;top:0;height:1px;z-index:39;pointer-events:none;
 transform-origin:0 50%;opacity:0;transition:opacity .09s ease-out;will-change:transform;}
.pick-leader.show{opacity:.8;}
.pick-leader-dot{position:fixed;left:0;top:0;width:5px;height:5px;margin:-2.5px 0 0 -2.5px;
 border-radius:50%;z-index:39;pointer-events:none;opacity:0;transition:opacity .09s ease-out;
 will-change:transform;}
.pick-leader-dot.show{opacity:.9;}
.pick-card.noanim,.pick-card.noanim *,.pick-leader.noanim,.pick-leader-dot.noanim{
 animation:none !important;transition:none !important;}
`;
    document.head.appendChild(st);

    const noanim = this._freeze ? ' noanim' : '';
    const card = document.createElement('div');
    card.className = 'pick-card' + noanim;
    const x = document.createElement('div');
    x.className = 'pc-x';
    card.appendChild(x);
    const body = document.createElement('div');
    body.className = 'pc-body';
    card.appendChild(body);
    const head = document.createElement('div');
    head.className = 'pc-head';
    body.appendChild(head);
    const title = document.createElement('div');
    title.className = 'pc-title';
    head.appendChild(title);
    const kind = document.createElement('div');
    kind.className = 'pc-kind';
    head.appendChild(kind);
    const rows = document.createElement('div');
    rows.className = 'pc-rows';
    body.appendChild(rows);

    // leader line: card edge → hovered totem tip. Two fixed elements, colored
    // per family at hover time, transformed per frame — no layout beyond width.
    const leader = document.createElement('div');
    leader.className = 'pick-leader' + noanim;
    const dot = document.createElement('div');
    dot.className = 'pick-leader-dot' + noanim;

    this._card = card;
    this._body = body;
    this._headEl = head;
    this._titleEl = title;
    this._kindEl = kind;
    this._rowsEl = rows;
    this._leader = leader;
    this._dot = dot;
    this._rowPool = [];
    for (let i = 0; i < ROW_POOL; i++) this._addRow();
    document.body.appendChild(leader);
    document.body.appendChild(dot);
    document.body.appendChild(card);
    this._applyAccent(this._C.cache);
  },

  _addRow() {
    const k = document.createElement('div');
    k.className = 'pc-k';
    const v = document.createElement('div');
    v.className = 'pc-v';
    k.style.display = v.style.display = 'none';
    this._rowsEl.appendChild(k);
    this._rowsEl.appendChild(v);
    this._rowPool.push({ k, v, hot: false });
  },

  // Accent = the hovered totem's family color (interaction law: header rule +
  // kind chip + leader line carry the family; corner brackets stay cyan).
  _accentFor(spec, data) {
    if (data && typeof data.accent === 'string') return data.accent;
    if (spec.kind === 'totem' && spec.debugKey != null) {
      const col = this._TOOL_COLORS[this._toolFamily(String(spec.debugKey))];
      if (col != null) return '#' + col.toString(16).padStart(6, '0');
    }
    return this._C.cache;
  },

  _applyAccent(a) {
    if (a === this._accent) return;
    this._accent = a;
    this._headEl.style.borderBottomColor = a + '99';
    this._kindEl.style.color = a;
    this._titleEl.style.textShadow = `0 0 8px ${a}55,0 0 18px ${a}22`;
    this._leader.style.background = `linear-gradient(90deg,${a}26 0%,${a}b3 55%,${a} 100%)`;
    this._leader.style.boxShadow = `0 0 4px ${a}40`;
    this._dot.style.background = a;
    this._dot.style.boxShadow = `0 0 6px ${a}88`;
  },

  // Fill the card from spec.card(hit). Returns true if the card is showing.
  // Re-measures ONLY when a content write fired (perf audit: no per-frame
  // forced reflow) — card size is content-determined.
  _setCard(spec, hit) {
    let data = null;
    if (spec.card) {
      try { data = spec.card(hit); }
      catch (e) { console.error('[interact] card() threw for kind', spec.kind, e); }
    }
    if (!data) { this._hideCard(); return false; }

    let changed = false;
    const title = String(data.title ?? spec.kind ?? '');
    if (this._titleEl.textContent !== title) { this._titleEl.textContent = title; changed = true; }
    const kind = String(spec.kind ?? '');
    if (this._kindEl.textContent !== kind) { this._kindEl.textContent = kind; changed = true; }

    const C = this._C;
    const lines = Array.isArray(data.lines) ? data.lines : [];
    while (this._rowPool.length < lines.length) { this._addRow(); changed = true; } // rare growth path
    for (let i = 0; i < this._rowPool.length; i++) {
      const r = this._rowPool[i];
      const L = lines[i];
      if (L) {
        const ks = String(L[0] ?? ''), vs = String(L[1] ?? '');
        if (r.k.textContent !== ks) { r.k.textContent = ks; changed = true; }
        if (r.v.textContent !== vs) { r.v.textContent = vs; changed = true; }
        // red = errors only (palette law): warm the value when it is nonzero
        const hot = (ks === 'ERRORS' || ks === 'ERR RATE') &&
          parseFloat(vs.replace(/[^0-9.]/g, '')) > 0;
        if (r.hot !== hot) {
          r.hot = hot;
          r.v.style.color = hot ? C.error : '';
          r.v.style.textShadow = hot ? `0 0 6px ${C.error}55` : '';
        }
        if (r.k.style.display) { r.k.style.display = r.v.style.display = ''; changed = true; }
      } else if (!r.k.style.display) {
        r.k.style.display = r.v.style.display = 'none';
        changed = true;
      }
    }

    this._applyAccent(this._accentFor(spec, data));
    this._card.classList.add('show');
    this._cardOn = true;
    if (changed || !this._cw) {
      this._cw = this._card.offsetWidth;
      this._ch = this._card.offsetHeight;
    }
    return true;
  },

  _hideCard() {
    this._card.classList.remove('show');
    this._cardOn = false;
    this._hideLeader();
  },

  _hideLeader() {
    if (!this._leaderOn) return;
    this._leaderOn = false;
    this._leader.classList.remove('show');
    this._dot.classList.remove('show');
  },

  _slideIn() {
    if (this._freeze) return;
    const b = this._body;
    b.classList.remove('slide');
    void b.offsetWidth; // restart the entrance animation (hover change only)
    b.classList.add('slide');
  },

  _placeCard(px, py) {
    let x = px + CARD_DX;
    if (x + this._cw + EDGE > this._vw) x = px - this._cw - CARD_DX;
    x = clamp(x, EDGE, Math.max(EDGE, this._vw - this._cw - EDGE));
    let y = py + CARD_DY;
    if (y + this._ch + EDGE > this._vh) y = py - this._ch - CARD_DY;
    y = clamp(y, EDGE, Math.max(EDGE, this._vh - this._ch - EDGE));
    this._cx = x;
    this._cy = y;
    this._card.style.transform = `translate3d(${x | 0}px,${y | 0}px,0)`;
  },

  // ---- leader line ------------------------------------------------------------
  // Resolve the world-space anchor once per hover change. Totems register their
  // body mesh with geometry translated so bbox-top = shoulder; the cap apex
  // rides TIP_LIFT above it (totems.js construction).
  _setAnchor(hit) {
    this._tip = false;
    if (!hit || hit.kind !== 'totem' || !hit.object) { this._hideLeader(); return; }
    this._box.setFromObject(hit.object);
    if (this._box.isEmpty()) { this._hideLeader(); return; }
    this._box.getCenter(this._tipW);
    this._tipW.y = this._box.max.y + TIP_LIFT;
    this._tip = true;
  },

  // Per-frame: project the tip, run a thin line from the nearest point on the
  // card's border to the tip. Hidden when the tip is behind the camera, under
  // the card, or too close to read.
  _updateLeader(ctx) {
    if (!this._tip || !this._cardOn) { this._hideLeader(); return; }
    const v = this._tipS.copy(this._tipW).project(ctx.camera);
    if (!(v.z < 1) || !Number.isFinite(v.x) || !Number.isFinite(v.y)) { this._hideLeader(); return; }
    const tx = (v.x * 0.5 + 0.5) * this._vw;
    const ty = (-v.y * 0.5 + 0.5) * this._vh;
    const ax = clamp(tx, this._cx, this._cx + this._cw);
    const ay = clamp(ty, this._cy, this._cy + this._ch);
    const dx = tx - ax, dy = ty - ay;
    const len = Math.hypot(dx, dy);
    if (len < LEADER_MIN) { this._hideLeader(); return; }
    this._leader.style.width = `${(len + 0.5) | 0}px`;
    this._leader.style.transform =
      `translate3d(${ax | 0}px,${ay | 0}px,0) rotate(${Math.atan2(dy, dx)}rad)`;
    this._dot.style.transform = `translate3d(${tx | 0}px,${ty | 0}px,0)`;
    if (!this._leaderOn) {
      this._leaderOn = true;
      this._leader.classList.add('show');
      this._dot.classList.add('show');
    }
  },

  // ---- picking --------------------------------------------------------------
  // One evaluation walks every registered entry (honoring spec.recursive) and
  // returns the nearest hit mapped back to its REGISTERED root, or null.
  _raycast(ctx, cx, cy) {
    const entries = ctx.pick.entries;
    if (!entries.size) return null;
    this._ndc.set((cx / this._vw) * 2 - 1, -(cy / this._vh) * 2 + 1);
    this._ray.setFromCamera(this._ndc, ctx.camera);
    const hits = this._hits;
    hits.length = 0;
    for (const [obj, spec] of entries) {
      if (!obj.visible) continue;
      try { this._ray.intersectObject(obj, spec.recursive === true, hits); }
      catch (e) { console.error('[interact] raycast failed for kind', spec.kind, e); }
    }
    if (!hits.length) return null;
    const it = hits[0]; // intersectObject keeps the target array distance-sorted
    let root = it.object;
    while (root && !entries.has(root)) root = root.parent;
    if (!root) return null;
    const spec = entries.get(root);
    return {
      kind: spec.kind, spec, object: root, instanceId: it.instanceId,
      point: it.point, distance: it.distance, intersect: it, forced: false,
    };
  },

  // Transition hover state; drives onHover, the card, the leader, the cursor.
  // New-target response is same-frame (<120ms law); only same-target VALUE
  // refreshes are capped at ~10Hz (perf audit).
  _applyHover(hit, ctx) {
    const prev = this._hover;
    const same = !!(prev && hit &&
      prev.object === hit.object && prev.instanceId === hit.instanceId);
    const now = performance.now();

    if (!same) {
      if (prev && prev.spec.onHover) {
        try { prev.spec.onHover(null); }
        catch (e) { console.error('[interact] onHover(null) threw', e); }
      }
      if (hit) {
        if (hit.spec.onHover) {
          try { hit.spec.onHover(hit); }
          catch (e) { console.error('[interact] onHover threw', e); }
        }
        this._setAnchor(hit);
        if (this._setCard(hit.spec, hit)) this._slideIn();
        this._sameAt = now;
      } else {
        this._setAnchor(null);
        this._hideCard();
      }
      this._moved = false;
    } else if (hit && this._moved && now - this._sameAt >= SAME_REFRESH_MS) {
      // same target, pointer moved — refresh live values (e.g. chronogram time)
      this._setCard(hit.spec, hit);
      this._sameAt = now;
      this._moved = false;
    } else if (!hit) {
      this._moved = false;
    }
    // note: when rate-limited, _moved stays true so the refresh lands within
    // SAME_REFRESH_MS — the card is never left stale at rest.

    this._hover = hit;
    const cursor = hit && hit.spec.onClick ? 'pointer' : '';
    if (cursor !== this._cursor) {
      this._cursor = cursor;
      this._canvas.style.cursor = cursor;
    }
  },

  // ---- input ----------------------------------------------------------------
  _bind(ctx) {
    const el = this._canvas;

    el.addEventListener('pointerenter', (e) => {
      this._inside = true;
      this._px = e.clientX; this._py = e.clientY;
      this._moved = true;
    });
    el.addEventListener('pointerleave', () => { this._inside = false; });

    el.addEventListener('pointermove', (e) => {
      this._px = e.clientX; this._py = e.clientY;
      this._inside = true;
      this._moved = true;
      if (this._down && !this._suppress &&
          Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y) > CLICK_SLOP) {
        this._suppress = true; // it's an orbit drag — mute hover until release
      }
      if (this._forced && this._forced.shown && !this._freeze) this._cancelForced();
    });

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this._px = e.clientX; this._py = e.clientY;
      const hit = this._raycast(ctx, e.clientX, e.clientY);
      this._down = {
        x: e.clientX, y: e.clientY, t: performance.now(),
        object: hit ? hit.object : null,
        instanceId: hit ? hit.instanceId : undefined,
      };
    });

    el.addEventListener('pointerup', (e) => {
      const d = this._down;
      const dragged = this._suppress;
      this._down = null;
      this._suppress = false;
      if (!d || dragged || e.button !== 0) return;
      if (performance.now() - d.t > CLICK_MS) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP) return;
      const hit = this._raycast(ctx, e.clientX, e.clientY);
      if (!hit && !d.object) {                     // clean click on empty space
        ctx.state.filterTool = null;
        return;
      }
      if (hit && hit.object === d.object && hit.instanceId === d.instanceId &&
          hit.spec.onClick) {
        try { hit.spec.onClick(hit); }
        catch (err) { console.error('[interact] onClick threw', err); }
      }
    });

    el.addEventListener('pointercancel', () => {
      this._down = null;
      this._suppress = false;
    });

    addEventListener('keydown', (e) => {
      if (e.key === 'Escape') ctx.state.filterTool = null;
    });
  },

  // ---- forced debug hover ---------------------------------------------------
  // Returns true while it owns the card (searching or showing).
  _updateForced(ctx) {
    const f = this._forced;
    if (++f.frames < 2) return true;               // spec: resolve after two frames
    if (!f.obj) {
      for (const [obj, spec] of ctx.pick.entries) {
        if (spec.kind === f.kind && String(spec.debugKey) === f.key) {
          f.obj = obj; f.spec = spec;
          break;
        }
      }
      if (!f.obj) return true;                     // keep retrying (late registration)
    }
    if (!f.shown) {
      f.shown = true;
      f.hit = {
        kind: f.spec.kind, spec: f.spec, object: f.obj, instanceId: undefined,
        point: f.obj.getWorldPosition(new ctx.THREE.Vector3()),
        distance: 0, intersect: null, forced: true,
      };
      f.hit.distance = ctx.camera.position.distanceTo(f.hit.point);
      if (f.spec.onHover) {
        try { f.spec.onHover(f.hit); }
        catch (e) { console.error('[interact] forced onHover threw', e); }
      }
      this._setAnchor(f.hit);
      this._setCard(f.spec, f.hit);
    }
    const v = this._wp;
    f.obj.getWorldPosition(v).project(ctx.camera);
    if (v.z < 1) {
      this._placeCard((v.x * 0.5 + 0.5) * this._vw, (-v.y * 0.5 + 0.5) * this._vh);
    }
    this._updateLeader(ctx);
    return true;
  },

  _cancelForced() {
    const f = this._forced;
    this._forced = null;
    if (f && f.shown && f.spec && f.spec.onHover) {
      try { f.spec.onHover(null); }
      catch (e) { console.error('[interact] forced onHover(null) threw', e); }
    }
    this._hideCard();
  },

  // ---- frame ----------------------------------------------------------------
  update(dt, state, ctx) {
    if (this._forced && this._updateForced(ctx)) return;

    if (!this._inside || this._suppress) {
      if (this._hover || this._cursor) this._applyHover(null, ctx);
      return;
    }

    // Static-frame gate (perf audit interact.js:403): with the pointer at
    // rest, the camera parked, the registry unchanged, and the hovered object
    // still live, last frame's answer holds — skip the full-registry raycast.
    // Any drift of the director camera re-arms it, so hover stays honest.
    const cam = ctx.camera;
    const camMoved = !this._camPrimed ||
      !this._camMW.equals(cam.matrixWorld) || !this._camPr.equals(cam.projectionMatrix);
    if (camMoved) {
      this._camMW.copy(cam.matrixWorld);
      this._camPr.copy(cam.projectionMatrix);
      this._camPrimed = true;
    }
    const entries = ctx.pick.entries;
    const regChanged = entries.size !== this._regSize;
    this._regSize = entries.size;
    const hoverStale = !!this._hover &&
      (!entries.has(this._hover.object) || this._hover.object.visible === false);
    if (!this._moved && !camMoved && !regChanged && !hoverStale) return;

    const hit = this._raycast(ctx, this._px, this._py);
    this._applyHover(hit, ctx);
    if (hit) this._placeCard(this._px, this._py);
    this._updateLeader(ctx);
  },

  resize(w, h) {
    this._vw = w;
    this._vh = h;
  },
};
