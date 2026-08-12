// tests/liveTimeline.test.mjs — hermetic unit tests for LiveTimeline.
// No browser, no network, no servers; pure import of the module under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveTimeline } from '../src/lib/liveTimeline.js';

// --- helpers -----------------------------------------------------------------

const ev = (t, id) => ({ t, kind: 'tool', id, name: `tool-${id}` });

const ctx = (t, base) => ({
  t, kind: 'ctx',
  ctx: base, cacheRead: base / 10, cacheWrite: base / 20, fresh: base / 50, out: base / 100,
});

function snapshot(items) {
  return { meta: { title: 'test' }, tools: {}, items };
}

// --- (1) constructor: backlog does not re-fire; vt pinned to duration --------

test('constructor with snapshot items: backlog does not re-fire, vt pinned to duration', () => {
  const tl = new LiveTimeline(snapshot([ev(0, 'a'), ev(1, 'b'), ev(2, 'c')]));

  assert.equal(tl.events.length, 3);
  assert.equal(tl.duration, 2);          // vts 0, 1, 2
  assert.equal(tl.vt, tl.duration);      // pinned to the live edge
  assert.equal(tl.cursor, tl.events.length);

  const res = tl.tick(0.1);              // first tick at the edge
  assert.equal(res.fired.length, 0);     // backlog must not re-fire
  assert.equal(res.atEdge, true);
  assert.equal(res.live, true);
  assert.equal(res.done, false);
  assert.equal(tl.vt, tl.duration);      // still pinned
});

// --- (2) ingest grows duration; next tick fires exactly the new items --------

test('ingest of new items grows duration and next tick fires exactly those', () => {
  const tl = new LiveTimeline(snapshot([ev(0, 'a'), ev(1, 'b')]));
  assert.equal(tl.duration, 1);
  tl.tick(0.1); // drain at edge, fires nothing

  const n1 = ev(2, 'new1');
  const n2 = ev(3, 'new2');
  tl.ingest([n1, n2]);

  assert.equal(tl.duration, 3);          // grew: vts 2 and 3
  const res = tl.tick(0.1);              // pinned tick jumps to new edge
  assert.equal(res.fired.length, 2);
  assert.deepEqual(res.fired.map(f => f.id), ['new1', 'new2']);

  const res2 = tl.tick(0.1);             // nothing left, nothing re-fires
  assert.equal(res2.fired.length, 0);
});

// --- (3) gap cap -------------------------------------------------------------

test('gap cap: two items 1000s apart in real t are <= 4 vt apart', () => {
  const tl = new LiveTimeline(snapshot([ev(0, 'a'), ev(1000, 'b')]));
  assert.equal(tl.vts.length, 2);
  const gap = tl.vts[1] - tl.vts[0];
  assert.ok(gap <= 4, `vt gap ${gap} exceeds cap of 4`);
  assert.equal(gap, 4);                  // 1000s real gap clamps exactly to the cap
  assert.equal(tl.duration, tl.vts[1]);
});

// --- (4) spawn/despawn and activeSubagents -----------------------------------

test('spawn keeps endVt Infinity while open, despawn closes it; activeSubagents reflects it', () => {
  const tl = new LiveTimeline(snapshot([
    { t: 0, kind: 'spawn', id: 'sub1', label: 'worker', type: 'general' },
    ev(1, 'a'), // extends duration past the spawn point
  ]));

  assert.equal(tl.subagents.length, 1);
  const sa = tl.subagents[0];
  assert.equal(sa.id, 'sub1');
  assert.equal(sa.endVt, Infinity);      // open while working
  assert.equal(sa.endT, null);

  let res = tl.tick(0.1);                // at edge, vt = 1
  assert.equal(res.activeSubagents.length, 1);
  assert.equal(res.activeSubagents[0].id, 'sub1');

  tl.ingest([{ t: 2, kind: 'despawn', id: 'sub1' }]);
  assert.equal(sa.endT, 2);
  assert.notEqual(sa.endVt, Infinity);   // closed
  assert.equal(sa.endVt, 2);             // vts: 0, 1, 2

  res = tl.tick(0.1);                    // edge is now vt 2; endVt > vt is false
  assert.equal(res.activeSubagents.length, 0);
});

// --- (5) seek back / replay / re-pin -----------------------------------------

test('seek back unpins; tick at speed re-fires crossed events exactly once; end re-pins', () => {
  const tl = new LiveTimeline(snapshot([0, 1, 2, 3, 4, 5].map(t => ev(t, `e${t}`))));
  assert.equal(tl.duration, 5);

  tl.seek(0.2);
  assert.equal(tl.vt, 0.2);
  let res = tl.tick(0);                  // zero-dt tick to observe state
  assert.equal(res.atEdge, false);       // unpinned: we are in review

  const firedIds = [];
  tl.speed = 2;
  res = tl.tick(0.9);                    // vt: 0.2 + 0.9*2 = 2.0
  assert.equal(tl.vt, 2);                // speed multiplies dt
  firedIds.push(...res.fired.map(f => f.id));
  assert.deepEqual(res.fired.map(f => f.id), ['e1', 'e2']);
  assert.equal(res.atEdge, false);

  res = tl.tick(0.5);                    // vt: 3.0 -> fires e3
  firedIds.push(...res.fired.map(f => f.id));
  assert.deepEqual(res.fired.map(f => f.id), ['e3']);

  res = tl.tick(1.5);                    // vt clamps to duration 5 -> re-pins
  firedIds.push(...res.fired.map(f => f.id));
  assert.deepEqual(res.fired.map(f => f.id), ['e4', 'e5']);
  assert.equal(res.atEdge, true);
  assert.equal(tl.vt, tl.duration);

  // each crossed event fired exactly once during the replay
  const counts = firedIds.reduce((m, id) => (m[id] = (m[id] ?? 0) + 1, m), {});
  for (const id of ['e1', 'e2', 'e3', 'e4', 'e5']) assert.equal(counts[id], 1, `${id} fired ${counts[id]} times`);

  res = tl.tick(0.1);                    // pinned again: nothing re-fires
  assert.equal(res.fired.length, 0);
});

// --- (6) compaction dedupe ---------------------------------------------------

test('compactions within 0.3 vt are deduped', () => {
  const tl = new LiveTimeline(snapshot([
    { t: 0, kind: 'compaction' },
    { t: 0.1, kind: 'compaction' },      // 0.1 vt after the first -> deduped
    { t: 100, kind: 'compaction' },      // capped to +4 vt -> kept
  ]));

  assert.equal(tl.compactions.length, 2);
  assert.equal(tl.compactions[0].vt, 0);
  assert.ok(tl.compactions[1].vt - tl.compactions[0].vt > 0.3);
  // the deduped item is dropped entirely: not in events either
  assert.equal(tl.events.filter(e => e.kind === 'compaction').length, 2);
});

// --- (7) ctx items -> ctxCurve, contextAt interpolation ----------------------

test("'ctx' items land in ctxCurve not events, contextAt interpolates", () => {
  const a = ctx(0, 100);   // vt 0
  const b = ctx(2, 200);   // vt 2
  const tl = new LiveTimeline(snapshot([a, b]));

  assert.equal(tl.events.length, 0);     // ctx items are not timeline events
  assert.equal(tl.ctxCurve.length, 2);

  const mid = tl.contextAt(1);           // halfway between vt 0 and vt 2
  assert.equal(mid.ctx, 150);
  assert.equal(mid.cacheRead, 15);
  assert.equal(mid.cacheWrite, 7.5);
  assert.equal(mid.fresh, 3);
  assert.equal(mid.out, 1.5);

  // clamping at the ends
  assert.equal(tl.contextAt(-5).ctx, 100);
  assert.equal(tl.contextAt(99).ctx, 200);

  // empty curve yields zeros
  const empty = new LiveTimeline(snapshot([]));
  assert.deepEqual(empty.contextAt(0), { ctx: 0, cacheRead: 0, cacheWrite: 0, fresh: 0, out: 0 });
});
