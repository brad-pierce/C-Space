// liveTimeline.js — Timeline-compatible driver fed by the live SSE tail server.
// Same interface as Timeline (vt, duration, events, vts, subagents, compactions,
// ctxCurve, seek, tick, contextAt, playing, speed) so every module works
// unchanged. Differences:
//   - duration GROWS as real events arrive (warped: gaps cap at 4s of vt)
//   - by default the playhead is pinned to the live edge (vt = duration);
//     seeking back enters REVIEW; seek(duration) or resume() re-pins
//   - state gains { live: true, atEdge } for the HUD
//
// Feed it parsed viz items via ingest(items): 'ctx' items extend the context
// curve; spawn/despawn maintain subagents (endVt = Infinity while working);
// everything else is a timeline event.

const GAP_CAP = 4;

export class LiveTimeline {
  constructor(snapshot) {
    this.session = {
      meta: snapshot.meta ?? {}, tools: snapshot.tools ?? {},
      contextCurve: [], subagents: [], compactions: [], events: [],
    };
    this.live = true;
    this.events = [];
    this.vts = [];               // plain array — grows in place
    this.ctxCurve = [];
    this.subagents = [];
    this.compactions = [];
    this._lastRealT = null;
    this._lastVt = 0;
    this.duration = 0.001;
    this.vt = 0;
    this.cursor = 0;
    this.playing = true;
    this.speed = 1;
    this._pinned = true;         // follow the live edge
    if (snapshot.items?.length) this.ingest(snapshot.items);
    this.vt = this.duration;
    this.cursor = this.events.length; // backlog does not re-fire on arrival
  }

  _vtOf(t) {
    if (this._lastRealT === null) { this._lastRealT = t; return 0; }
    const dv = Math.min(Math.max(t - this._lastRealT, 0.016), GAP_CAP);
    this._lastRealT = Math.max(t, this._lastRealT);
    return this._lastVt + dv;
  }

  ingest(items) {
    for (const it of items) {
      const vt = this._vtOf(it.t);
      this._lastVt = vt;
      this.duration = Math.max(this.duration, vt);
      if (it.kind === 'ctx') {
        this.ctxCurve.push({ ...it, vt });
        continue;
      }
      if (it.kind === 'spawn') {
        this.subagents.push({ id: it.id, label: it.label, type: it.type ?? 'general', spawnT: it.t, endT: null, spawnVt: vt, endVt: Infinity });
      } else if (it.kind === 'despawn') {
        const sa = this.subagents.find(s => s.id === it.id);
        if (sa) { sa.endT = it.t; sa.endVt = vt; }
      } else if (it.kind === 'compaction') {
        const last = this.compactions[this.compactions.length - 1];
        if (!last || vt - last.vt > 0.3) this.compactions.push({ vt });
        else continue;
      }
      this.events.push(it);
      this.vts.push(vt);
    }
    // meta/tools refresh arrives alongside items
  }

  updateAggregates(tools, meta) {
    if (tools) this.session.tools = tools;
    if (meta) this.session.meta = { ...this.session.meta, ...meta };
  }

  seek(vt) {
    this.vt = Math.max(0, Math.min(vt, this.duration));
    this._pinned = this.vt >= this.duration - 0.5;
    this.cursor = 0;
    while (this.cursor < this.events.length && this.vts[this.cursor] < this.vt) this.cursor++;
  }

  resume() { this._pinned = true; this.playing = true; }

  tick(dt) {
    if (this._pinned) {
      this.vt = this.duration;
    } else if (this.playing) {
      this.vt = Math.min(this.vt + dt * this.speed, this.duration);
      if (this.vt >= this.duration - 0.01) this._pinned = true;
    }
    const fired = [];
    while (this.cursor < this.events.length && this.vts[this.cursor] <= this.vt) {
      fired.push(this.events[this.cursor]);
      this.cursor++;
    }
    return {
      vt: this.vt,
      progress: this.duration > 0 ? this.vt / this.duration : 0,
      done: false,
      live: true,
      atEdge: this._pinned,
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

  realToVt() { return this.vt; } // legacy compat; live vts are already materialized
}
