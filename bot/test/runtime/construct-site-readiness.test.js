import test from 'node:test';
import assert from 'node:assert/strict';

import { enrichPlan } from '../../lib/runtime/blueprints/loader.js';
import { loadPlanJson } from '../../lib/runtime/blueprints/loader.js';
import { evaluateConstructSiteReadiness } from '../../lib/runtime/construct-site-readiness.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataDir = path.join(repoRoot, 'data');

function starterPlan() {
  const loaded = loadPlanJson(dataDir, 'starter_shelter');
  assert.equal(loaded.ok, true);
  const enriched = enrichPlan(loaded.plan);
  return { ...enriched, anchor: loaded.plan.anchor.coords, planId: 'starter_shelter' };
}

test('evaluateConstructSiteReadiness: flat cobble L1 slice is ready', () => {
  const ctxPlan = starterPlan();
  const blocks = new Map();
  for (const c of ctxPlan.plan.cells) {
    const [lx, ly, lz] = c.local;
    if (ly !== 1) continue;
    const wx = ctxPlan.anchor[0] + lx;
    const wy = ctxPlan.anchor[1] + ly;
    const wz = ctxPlan.anchor[2] + lz;
    blocks.set(`${wx},${wy},${wz}`, c.block);
  }
  const r = evaluateConstructSiteReadiness(
    ctxPlan,
    (x, y, z) => blocks.get(`${x},${y},${z}`) || 'air',
    { level: 1 },
  );
  assert.equal(r.status, 'ready');
});

test('evaluateConstructSiteReadiness: water at corner is prep_required', () => {
  const ctxPlan = starterPlan();
  const r = evaluateConstructSiteReadiness(
    ctxPlan,
    () => 'water',
    { level: 1 },
  );
  assert.equal(r.status, 'prep_required');
  assert.match(r.message, /water/i);
});

test('evaluateConstructSiteReadiness: corner surface spread triggers prep_required', () => {
  const ctxPlan = starterPlan();
  const loc = ctxPlan.footprint.local;
  const level = 1;
  const ly = level;
  const corners = [
    [loc.x[0], loc.z[0]],
    [loc.x[1], loc.z[0]],
    [loc.x[0], loc.z[1]],
    [loc.x[1], loc.z[1]],
  ];
  const heights = new Map();
  for (const [lx, lz] of corners) {
    const wx = ctxPlan.anchor[0] + lx;
    const wz = ctxPlan.anchor[2] + lz;
    heights.set(`${wx},${wz}`, lx === loc.x[1] ? ctxPlan.anchor[1] + 3 : ctxPlan.anchor[1] + 1);
  }
  const get = (x, y, z) => {
    const h = heights.get(`${x},${z}`) ?? ctxPlan.anchor[1] + 1;
    if (y === h) return 'stone';
    if (y < h) return 'stone';
    return 'air';
  };
  const r = evaluateConstructSiteReadiness(ctxPlan, get, { level: 1, spreadThreshold: 1 });
  assert.equal(r.status, 'prep_required');
  assert.match(r.message, /spread/i);
});
