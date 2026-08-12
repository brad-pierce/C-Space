// timeline.js — warps a multi-day session onto a ~180s playback axis and
// streams events to modules frame by frame.
//
// Real time (t, seconds since session start) is piecewise-compressed: any gap
// between consecutive events longer than GAP_CAP seconds contributes exactly
// GAP_CAP to viz time. The result is then normalized so the whole session
// plays in PLAY_SECONDS.

const GAP_CAP = 4;
const PLAY_SECONDS = 180;

const MIN_DRONE_LIFE = 12;   // visual license: a spawned mind stays visible ≥12s of viz time
const COMPACT_DEDUPE = 1.0;  // the log records each compaction twice (summary + flag)

export class Timeline {
  constructor(session) {
    this.session = session;
    // drop duplicate compaction events (recorded twice per real compaction)
    let lastComp = -Infinity;
    this.events = session.events.filter(e => {
      if (e.kind !== 'compaction') return true;
      if (e.t - lastComp < COMPACT_DEDUPE) return false;
      lastComp = e.t; return true;
    });

    // Build vt (viz-time) for every event.
    let acc = 0, prev = null;
    this.vts = new Float64Array(this.events.length);
    for (let i = 0; i < this.events.length; i++) {
      const t = this.events[i].t;
      if (prev !== null) acc += Math.min(Math.max(t - prev, 0.016), GAP_CAP);
      this.vts[i] = acc;
      prev = t;
    }
    const total = acc || 1;
    this.scale = PLAY_SECONDS / total;
    for (let i = 0; i < this.vts.length; i++) this.vts[i] *= this.scale;
    this.duration = PLAY_SECONDS;

    // Context curve indexed for fast interpolation on the same warped axis.
    // Map each curve point's real t → vt via the event timeline.
    this.ctxCurve = session.contextCurve.map(c => ({ ...c, vt: this.realToVt(c.t) }));

    this.subagents = session.subagents.map(s => {
      const spawnVt = this.realToVt(s.spawnT);
      return {
        ...s, spawnVt,
        endVt: Math.min(this.duration, Math.max(this.realToVt(s.endT), spawnVt + MIN_DRONE_LIFE)),
      };
    });
    this.compactions = [];
    for (const c of session.compactions) {
      const vt = this.realToVt(c.t);
      if (!this.compactions.length || vt - this.compactions[this.compactions.length - 1].vt > 0.3) {
        this.compactions.push({ vt });
      }
    }

    this.vt = 0;
    this.cursor = 0;      // index of next un-fired event
    this.playing = true;
    this.speed = 1;
  }

  realToVt(t) {
    // binary search events for t, lerp between neighbors
    const ev = this.events, vts = this.vts;
    if (!ev.length) return 0;
    if (t <= ev[0].t) return 0;
    if (t >= ev[ev.length - 1].t) return this.duration;
    let lo = 0, hi = ev.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ev[mid].t <= t) lo = mid; else hi = mid;
    }
    const span = ev[hi].t - ev[lo].t;
    const f = span > 0 ? (t - ev[lo].t) / span : 0;
    return vts[lo] + f * (vts[hi] - vts[lo]);
  }

  seek(vt) {
    this.vt = Math.max(0, Math.min(vt, this.duration));
    this.cursor = 0;
    while (this.cursor < this.events.length && this.vts[this.cursor] < this.vt) this.cursor++;
  }

  /** advance by dt (wall seconds); returns frame state for modules */
  tick(dt) {
    if (this.playing) this.vt = Math.min(this.vt + dt * this.speed, this.duration);
    const fired = [];
    while (this.cursor < this.events.length && this.vts[this.cursor] <= this.vt) {
      fired.push(this.events[this.cursor]);
      this.cursor++;
    }
    return {
      vt: this.vt,
      progress: this.vt / this.duration,
      done: this.vt >= this.duration,
      fired,
      context: this.contextAt(this.vt),
      activeSubagents: this.subagents.filter(s => s.spawnVt <= this.vt && s.endVt > this.vt),
    };
  }

  contextAt(vt) {
    const c = this.ctxCurve;
    if (!c.length) return { ctx: 0, cacheRead: 0, cacheWrite: 0, fresh: 0, out: 0 };
    if (vt <= c[0].vt) return c[0];
    if (vt >= c[c.length - 1].vt) return c[c.length - 1];
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid].vt <= vt) lo = mid; else hi = mid;
    }
    const a = c[lo], b = c[hi];
    const f = b.vt > a.vt ? (vt - a.vt) / (b.vt - a.vt) : 0;
    const L = (x, y) => x + (y - x) * f;
    return {
      ctx: L(a.ctx, b.ctx), cacheRead: L(a.cacheRead, b.cacheRead),
      cacheWrite: L(a.cacheWrite, b.cacheWrite), fresh: L(a.fresh, b.fresh), out: L(a.out, b.out),
    };
  }
}
