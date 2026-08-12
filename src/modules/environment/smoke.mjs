// smoke.mjs — headless validation of ../environment.js (critique round 3).
// Run:  node src/modules/environment/smoke.mjs   (exit 0 = pass)
//
// Mocks the ctx contract (renderer stubbed: only getPixelRatio/getSize are
// touched; freeze mode left OFF so the GL-dependent luma probe is skipped).
// Runs init + a burst of update ticks (compaction event, long idle run, a
// shot-style seek flood, a resize), then walks the scene validating that
// every BufferGeometry position attribute is finite and that every
// computeBoundingSphere() radius is finite — the exact failure class that
// silently culls objects for a whole session when it slips through.

import * as THREE from 'three';
import env from '../environment.js';
import { PALETTE, LAYOUT, CONTEXT_TOKEN_CAP } from '../../lib/palette.js';

const scene = new THREE.Scene();
const ctx = {
  THREE, scene,
  camera: new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 900),
  renderer: {
    getPixelRatio: () => 1.5,
    getSize: (v) => v.set(1280, 720),
  },
  PALETTE, LAYOUT, CONTEXT_TOKEN_CAP,
  params: new URLSearchParams(''),
  quality: 'high',
};

env.init(ctx);

const mkState = (fired) => ({
  vt: 0, progress: 0, done: false, fired,
  context: { ctx: 0, cacheRead: 0, cacheWrite: 0, fresh: 0, out: 0 },
  activeSubagents: [],
});
env.update(0.016, mkState([]));
env.update(0.016, mkState([{ kind: 'compaction', t: 0 }]));
for (let i = 0; i < 120; i++) env.update(0.016, mkState([]));
env.update(0, mkState(new Array(400).fill({ kind: 'say', t: 0 }))); // seek flood
env.resize(1080, 1920);

let checked = 0, failures = 0;
scene.traverse((o) => {
  if (!o.geometry) return;
  const g = o.geometry;
  const p = g.attributes.position;
  if (p) {
    for (let i = 0; i < p.array.length; i++) {
      if (!Number.isFinite(p.array[i])) {
        failures++;
        console.error(`NON-FINITE position float in ${o.type} at [${i}]`);
        break;
      }
    }
  }
  g.computeBoundingSphere();
  const r = g.boundingSphere ? g.boundingSphere.radius : NaN;
  if (!Number.isFinite(r)) {
    failures++;
    console.error(`NaN boundingSphere radius in ${o.type} (${o.name || 'anon'})`);
  }
  checked++;
});

if (!Number.isFinite(scene.fog.density)) { failures++; console.error('fog density non-finite'); }

console.log(`geometries checked: ${checked}, failures: ${failures}`);
if (failures > 0) process.exit(1);
console.log('SMOKE OK — all position attributes finite, all bounding spheres finite');
