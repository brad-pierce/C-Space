// zoomRail.js — session-page altitude rail + ascend-to-fleet threshold UI.
// A slim vertical instrument on the right edge mapping camera distance from
// origin to four bands, top-to-bottom STREET (<30) / RING (30–55) /
// ORBIT (55–80) / FLEET (beyond), with an eased marker riding the current
// altitude. Indicator + threshold UI ONLY: cameraRig owns the camera, so no
// band-click camera moves exist here. The FLEET band is the single
// interactive surface — clicking it, or sustaining outward wheel at max
// manual radius (camera distance >= 78 held 500ms with fresh outward wheel
// events), runs an eased ~350ms fade-to-black, sets sessionStorage
// cspaceFade=1, and hands off to /fleet.html. On init the same flag (set by
// the other page on the way over) fades this page in from black (~400ms).
// Hidden entirely under ?freeze=1.
//
// Discipline: pure DOM/CSS inside #hud (root is pointer-events:none; only
// the FLEET band opts in). Colors come from ctx.CSS — palette only. All
// motion eased (exponential marker pursuit, cubic-bezier fades). The wheel
// listener is passive and NEVER calls preventDefault — cameraRig's zoom
// handling is untouched; this module only observes intent. DOM writes are
// gated on value change, hud.js-style. Import-clean under plain node: no
// top-level DOM/GL access.

const BANDS = [
  { label: 'STREET', lo: 0,  hi: 30 },
  { label: 'RING',   lo: 30, hi: 55 },
  { label: 'ORBIT',  lo: 55, hi: 80 },
  { label: 'FLEET',  lo: 80, hi: 100 },   // hi only shapes marker travel
];
const ASCEND_DIST = 78;      // cameraRig ZOOM_MAX is 80 — the last wheel notch
const ASCEND_HOLD_MS = 500;  // outward-wheel intent must persist this long
const WHEEL_FRESH_MS = 350;  // an outward wheel notch stays "fresh" this long
const MARKER_SMOOTH = 9;     // 1/s exponential pursuit rate
const RAIL_H = 224;          // px — 4 × 56px bands
const FADE_OUT_MS = 350;
const FADE_IN_MS = 400;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export default {
  name: 'zoomRail',

  init(ctx) {
    this._root = null;
    this._ascending = false;
    if (ctx.params.get('freeze') === '1') return;   // hidden entirely in shot mode

    const C = ctx.CSS;

    // ---- style ---------------------------------------------------------------
    const st = document.createElement('style');
    st.id = 'zrx-style';
    st.textContent = `
#hud .zrx{position:absolute;top:50%;right:14px;transform:translateY(-50%);
 width:78px;height:${RAIL_H}px;pointer-events:none;color:${C.hudDim};
 font-family:"Cascadia Code","Cascadia Mono",ui-monospace,Consolas,monospace;
 text-transform:uppercase;user-select:none;-webkit-font-smoothing:antialiased;
 animation:zrxEnter .7s cubic-bezier(.2,.9,.2,1) both;animation-delay:.65s;}
@keyframes zrxEnter{from{opacity:0;}to{opacity:1;}}
.zrx-track{position:absolute;top:0;bottom:0;right:4px;width:1px;
 background:linear-gradient(180deg,${C.hudDim}44,${C.hudDim}77 50%,${C.hudDim}44);}
.zrx-band{position:relative;height:25%;}
.zrx-band::before{content:"";position:absolute;top:0;right:1px;width:7px;height:1px;background:${C.hudDim}77;}
.zrx-cap{position:absolute;bottom:0;right:1px;width:7px;height:1px;background:${C.hudDim}77;}
.zrx-label{position:absolute;top:50%;right:17px;transform:translateY(-50%);
 font-size:8px;letter-spacing:.3em;line-height:1;
 transition:color .25s ease,text-shadow .25s ease;}
.zrx-band.on .zrx-label{color:${C.hudText};text-shadow:0 0 6px ${C.cache}44;}
/* FLEET — the one interactive band: hover/charge brighten (affordance law) */
.zrx-fleet{pointer-events:auto;cursor:pointer;}
.zrx-fleet:hover .zrx-label,.zrx-fleet.charge .zrx-label{
 color:${C.coreHot};text-shadow:0 0 8px ${C.cache}88;}
.zrx-marker{position:absolute;top:-1px;right:0;width:9px;height:2px;
 background:${C.cache};box-shadow:0 0 6px ${C.cache}aa;will-change:transform;}
/* fade plate — shared by ascend (transition out) and arrival (animation in) */
.zrx-fade{position:fixed;inset:0;z-index:30;background:${C.void};opacity:0;
 pointer-events:none;transition:opacity ${FADE_OUT_MS}ms cubic-bezier(.4,0,.2,1);}
.zrx-fade.in{animation:zrxIn ${FADE_IN_MS}ms cubic-bezier(.3,0,.4,1) both;}
@keyframes zrxIn{from{opacity:1;}to{opacity:0;}}
`;
    document.head.appendChild(st);

    // ---- DOM -----------------------------------------------------------------
    const root = document.createElement('div');
    root.className = 'zrx';
    this._root = root;

    const track = document.createElement('div');
    track.className = 'zrx-track';
    root.appendChild(track);

    this._bandEls = [];
    for (let i = 0; i < BANDS.length; i++) {
      const band = document.createElement('div');
      const fleet = i === BANDS.length - 1;
      band.className = 'zrx-band' + (fleet ? ' zrx-fleet' : '');
      const label = document.createElement('div');
      label.className = 'zrx-label';
      label.textContent = BANDS[i].label;
      band.appendChild(label);
      root.appendChild(band);
      this._bandEls.push(band);
      if (fleet) {
        this._fleetEl = band;
        band.addEventListener('click', () => this._ascend());
      }
    }
    const cap = document.createElement('div');
    cap.className = 'zrx-cap';
    root.appendChild(cap);

    const marker = document.createElement('div');
    marker.className = 'zrx-marker';
    root.appendChild(marker);
    this._marker = marker;

    document.getElementById('hud').appendChild(root);

    // ---- ascend intent: outward wheel observed passively ----------------------
    // cameraRig owns zoom (its own preventDefault handler); this listener only
    // timestamps outward notches and never touches the event.
    this._lastOutWheel = -1e9;
    ctx.renderer.domElement.addEventListener('wheel', (e) => {
      if (e.deltaY > 0) this._lastOutWheel = performance.now();
    }, { passive: true });

    // gating state
    this._y = -1;          // marker px (sentinel: snap on first frame)
    this._xf = '';
    this._band = -1;
    this._chargeT = -1;    // charge window start (ms), -1 = idle
    this._charging = false;

    // ---- arrival: fade in from black when the other page set the flag ---------
    let flagged = false;
    try { flagged = sessionStorage.getItem('cspaceFade') != null; } catch {}
    if (flagged) {
      try { sessionStorage.removeItem('cspaceFade'); } catch {}
      const o = document.createElement('div');
      o.className = 'zrx-fade in';
      document.body.appendChild(o);
      const done = () => o.remove();
      o.addEventListener('animationend', done);
      setTimeout(done, FADE_IN_MS + 400);   // fallback if the animation never fires
    }
  },

  // eased fade-to-black, then hand off to the fleet page. Idempotent.
  _ascend() {
    if (this._ascending || !this._root) return;
    this._ascending = true;
    if (this._fleetEl) this._fleetEl.classList.add('charge');
    const o = document.createElement('div');
    o.className = 'zrx-fade';
    o.style.pointerEvents = 'auto';         // swallow input during the handoff
    document.body.appendChild(o);
    let gone = false;
    const go = () => {
      if (gone) return;
      gone = true;
      try { sessionStorage.setItem('cspaceFade', '1'); } catch {}
      location.href = '/fleet.html';
    };
    o.addEventListener('transitionend', go);
    setTimeout(go, FADE_OUT_MS + 150);      // fallback if transitionend never fires
    // double-rAF so the transition start style is committed before the flip
    requestAnimationFrame(() => requestAnimationFrame(() => { o.style.opacity = '1'; }));
  },

  update(dt, state, ctx) {
    if (!this._root) return;                // freeze mode — module inert
    const dist = ctx.camera.position.length();

    // band + marker target: distance interpolated within its band's span
    let bi = BANDS.length - 1;
    for (let i = 0; i < BANDS.length; i++) {
      if (dist < BANDS[i].hi) { bi = i; break; }
    }
    const b = BANDS[bi];
    const f = clamp01((dist - b.lo) / (b.hi - b.lo));
    const target = (bi + f) * (RAIL_H / BANDS.length);

    // eased pursuit (expo); first frame snaps so the marker never flies in
    if (this._y < 0) this._y = target;
    else this._y += (target - this._y) * (1 - Math.exp(-dt * MARKER_SMOOTH));
    const xf = `translateY(${this._y.toFixed(1)}px)`;
    if (xf !== this._xf) { this._xf = xf; this._marker.style.transform = xf; }

    if (bi !== this._band) {
      this._band = bi;
      for (let i = 0; i < this._bandEls.length; i++) {
        const cls = 'zrx-band' + (i === BANDS.length - 1 ? ' zrx-fleet' : '') + (i === bi ? ' on' : '');
        if (this._bandEls[i].className !== cls) this._bandEls[i].className = cls;
      }
      // a band swap during charge must not strip the charge highlight
      if (this._charging || this._ascending) this._fleetEl.classList.add('charge');
    }

    // ascend charge: distance holds >= threshold while outward notches stay
    // fresh; 500ms of sustained intent triggers the handoff
    if (!this._ascending) {
      const now = performance.now();
      const fresh = now - this._lastOutWheel < WHEEL_FRESH_MS;
      if (dist >= ASCEND_DIST && fresh) {
        if (this._chargeT < 0) this._chargeT = now;
        else if (now - this._chargeT >= ASCEND_HOLD_MS) this._ascend();
      } else {
        this._chargeT = -1;
      }
      const charging = this._chargeT >= 0;
      if (charging !== this._charging) {
        this._charging = charging;
        this._fleetEl.classList.toggle('charge', charging);
      }
    }
  },
};
