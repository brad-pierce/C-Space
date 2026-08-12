// timeline.test.mjs — hermetic unit tests for src/lib/timeline.js
// Pure imports, synthetic session objects, no I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Timeline } from '../src/lib/timeline.js';

const PLAY_SECONDS = 180;
const MIN_DRONE_LIFE = 12;

function approx(actual, expected, eps = 1e-9, msg = '') {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${msg} expected ${actual} ≈ ${expected} (eps ${eps})`
  );
}

function makeSession({ events, contextCurve = [], subagents = [], compactions = [] }) {
  return { events, contextCurve, subagents, compactions };
}

function ev(t, kind = 'msg', extra = {}) {
  return { t, kind, ...extra };
}

test('vts are monotonic nondecreasing and total duration is exactly 180', () => {
  const tl = new Timeline(makeSession({
    events: [ev(0), ev(1), ev(3), ev(100), ev(101)],
  }));

  assert.equal(tl.duration, PLAY_SECONDS);
  assert.equal(tl.vts.length, 5);
  for (let i = 1; i < tl.vts.length; i++) {
    assert.ok(tl.vts[i] >= tl.vts[i - 1],
      `vts must be nondecreasing: vts[${i}]=${tl.vts[i]} < vts[${i - 1}]=${tl.vts[i - 1]}`);
  }
  approx(tl.vts[0], 0, 1e-9, 'first vt');
  approx(tl.vts[tl.vts.length - 1], PLAY_SECONDS, 1e-9, 'last vt');
});

test('a 10000s real gap contributes the same viz time as a 4s gap (GAP_CAP)', () => {
  // gaps: 4s (at the cap), 10000s (way over), 4s (at the cap)
  const tl = new Timeline(makeSession({
    events: [ev(0), ev(4), ev(10004), ev(10008)],
  }));

  const d1 = tl.vts[1] - tl.vts[0]; // 4s gap
  const d2 = tl.vts[2] - tl.vts[1]; // 10000s gap, capped
  const d3 = tl.vts[3] - tl.vts[2]; // 4s gap
  approx(d2, d1, 1e-9, 'capped huge gap vs 4s gap');
  approx(d3, d1, 1e-9, 'trailing 4s gap');
  approx(tl.vts[3], PLAY_SECONDS, 1e-9, 'total still normalizes to 180');
});

test('compaction events within 1s dedupe to one; farther apart stay two', () => {
  const countComps = tl => tl.events.filter(e => e.kind === 'compaction').length;

  // 0.5s apart -> dedupe to one
  const close = new Timeline(makeSession({
    events: [ev(0), ev(10, 'compaction'), ev(10.5, 'compaction'), ev(20)],
  }));
  assert.equal(countComps(close), 1, 'compactions 0.5s apart should dedupe to one');
  assert.equal(close.events.length, 3);

  // 2s apart -> both kept
  const far = new Timeline(makeSession({
    events: [ev(0), ev(10, 'compaction'), ev(12, 'compaction'), ev(20)],
  }));
  assert.equal(countComps(far), 2, 'compactions 2s apart should both survive');
  assert.equal(far.events.length, 4);

  // exactly 1.0s apart is not "within" the dedupe window -> both kept
  const boundary = new Timeline(makeSession({
    events: [ev(0), ev(10, 'compaction'), ev(11, 'compaction'), ev(20)],
  }));
  assert.equal(countComps(boundary), 2, 'compactions exactly 1s apart should both survive');
});

test('subagent endVt-spawnVt honors MIN_DRONE_LIFE but endVt never exceeds duration', () => {
  // events at t=0..4, gaps of 1 -> vts = [0, 45, 90, 135, 180]
  const tl = new Timeline(makeSession({
    events: [ev(0), ev(1), ev(2), ev(3), ev(4)],
    subagents: [
      { id: 'short', spawnT: 1, endT: 1.01 },  // near-instant real life
      { id: 'long', spawnT: 0, endT: 3 },      // natural life 135s of viz time
      { id: 'late', spawnT: 4, endT: 4 },      // spawned at the very end
    ],
  }));

  for (const s of tl.subagents) {
    assert.ok(s.endVt <= tl.duration, `${s.id}: endVt ${s.endVt} must not exceed duration`);
    assert.ok(s.endVt >= s.spawnVt, `${s.id}: endVt must be >= spawnVt`);
    if (s.spawnVt + MIN_DRONE_LIFE <= tl.duration) {
      assert.ok(s.endVt - s.spawnVt >= MIN_DRONE_LIFE - 1e-9,
        `${s.id}: life ${s.endVt - s.spawnVt} shorter than MIN_DRONE_LIFE`);
    }
  }

  const short = tl.subagents.find(s => s.id === 'short');
  approx(short.endVt - short.spawnVt, MIN_DRONE_LIFE, 1e-9, 'short subagent stretched to min life');

  const long = tl.subagents.find(s => s.id === 'long');
  approx(long.endVt, 135, 1e-9, 'long subagent keeps its natural end');

  const late = tl.subagents.find(s => s.id === 'late');
  approx(late.spawnVt, tl.duration, 1e-9, 'late subagent spawns at duration');
  assert.equal(late.endVt, tl.duration, 'late subagent clamped to duration, not duration+12');
});

test('realToVt is monotonic over real time and inverse-consistent at event points', () => {
  const events = [ev(0), ev(5), ev(7), ev(50), ev(60)];
  const tl = new Timeline(makeSession({ events }));

  // inverse consistency: realToVt(events[i].t) === vts[i]
  for (let i = 0; i < events.length; i++) {
    approx(tl.realToVt(events[i].t), tl.vts[i], 1e-9, `realToVt at event ${i}`);
  }

  // monotonic nondecreasing over a sampled grid spanning before/inside/after
  const samples = [-10, 0, 1, 3, 4.999, 5, 6, 7, 8, 20, 49, 50, 55, 60, 61, 1e6];
  let prev = -Infinity;
  for (const t of samples) {
    const vt = tl.realToVt(t);
    assert.ok(vt >= prev, `realToVt not monotonic at t=${t}: ${vt} < ${prev}`);
    prev = vt;
  }

  // clamps outside the event range
  assert.equal(tl.realToVt(-10), 0);
  assert.equal(tl.realToVt(1e6), tl.duration);
});

test('seek then tick fires exactly the events in (seekVt, tickVt], each once', () => {
  // events at t=0..4, gaps of 1 -> vts = [0, 45, 90, 135, 180]
  const events = [ev(0, 'msg', { id: 0 }), ev(1, 'msg', { id: 1 }), ev(2, 'msg', { id: 2 }),
                  ev(3, 'msg', { id: 3 }), ev(4, 'msg', { id: 4 })];
  const tl = new Timeline(makeSession({ events }));
  approx(tl.vts[1], 45, 1e-9);
  approx(tl.vts[2], 90, 1e-9);

  tl.seek(50); // between vts[1]=45 and vts[2]=90

  const firedIds = [];
  const r1 = tl.tick(45); // vt: 50 -> 95; should fire only id 2 (vt 90)
  assert.deepEqual(r1.fired.map(e => e.id), [2], 'first tick fires exactly the event in (50, 95]');
  firedIds.push(...r1.fired.map(e => e.id));

  const r2 = tl.tick(0); // vt stays 95; nothing new, no double-fire
  assert.deepEqual(r2.fired, [], 'zero-dt tick must not re-fire');

  const r3 = tl.tick(40); // vt: 95 -> 135; fires id 3 (boundary vt 135 inclusive)
  assert.deepEqual(r3.fired.map(e => e.id), [3], 'tick boundary is inclusive at tickVt');
  firedIds.push(...r3.fired.map(e => e.id));

  const r4 = tl.tick(1000); // vt clamps to 180; fires id 4, done
  assert.deepEqual(r4.fired.map(e => e.id), [4]);
  assert.equal(r4.done, true);
  approx(r4.vt, tl.duration, 1e-9);
  firedIds.push(...r4.fired.map(e => e.id));

  // exactly the events after the seek point, each exactly once; ids 0 and 1 never fire
  assert.deepEqual(firedIds, [2, 3, 4]);
  assert.equal(new Set(firedIds).size, firedIds.length, 'no event fired twice');
});

test('contextAt interpolates between curve points and clamps at both ends', () => {
  // events at t=0..4 -> vts [0, 45, 90, 135, 180]; curve points at t=0,2,4 -> vt 0, 90, 180
  const tl = new Timeline(makeSession({
    events: [ev(0), ev(1), ev(2), ev(3), ev(4)],
    contextCurve: [
      { t: 0, ctx: 100, cacheRead: 10, cacheWrite: 1, fresh: 5, out: 2 },
      { t: 2, ctx: 200, cacheRead: 30, cacheWrite: 3, fresh: 15, out: 6 },
      { t: 4, ctx: 150, cacheRead: 50, cacheWrite: 5, fresh: 25, out: 10 },
    ],
  }));

  approx(tl.ctxCurve[0].vt, 0, 1e-9);
  approx(tl.ctxCurve[1].vt, 90, 1e-9);
  approx(tl.ctxCurve[2].vt, 180, 1e-9);

  // midpoint of first segment
  const mid1 = tl.contextAt(45);
  approx(mid1.ctx, 150, 1e-9); approx(mid1.cacheRead, 20, 1e-9);
  approx(mid1.cacheWrite, 2, 1e-9); approx(mid1.fresh, 10, 1e-9); approx(mid1.out, 4, 1e-9);

  // midpoint of second segment (values go down: interpolation, not just monotone lerp)
  const mid2 = tl.contextAt(135);
  approx(mid2.ctx, 175, 1e-9); approx(mid2.cacheRead, 40, 1e-9);
  approx(mid2.cacheWrite, 4, 1e-9); approx(mid2.fresh, 20, 1e-9); approx(mid2.out, 8, 1e-9);

  // quarter point of first segment
  const q = tl.contextAt(22.5);
  approx(q.ctx, 125, 1e-9); approx(q.cacheRead, 15, 1e-9);

  // clamps: below the first point and above the last
  assert.equal(tl.contextAt(-5).ctx, 100, 'clamps to first point below range');
  assert.equal(tl.contextAt(0).ctx, 100, 'exactly at first point');
  assert.equal(tl.contextAt(180).ctx, 150, 'exactly at last point');
  assert.equal(tl.contextAt(9999).ctx, 150, 'clamps to last point above range');
});
