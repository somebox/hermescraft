import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPlan } from '../../../lib/runtime/blueprints/verify.js';
import { enrichPlan } from '../../../lib/runtime/blueprints/loader.js';

test('verifyPlan classifies ok missing wrong extra', () => {
  const plan = {
    plan_id: 'v',
    footprint: { mode: 'tight', local: { x: [0, 1], y: [0, 0], z: [0, 1] } },
    anchor: { coords: [0, 64, 0] },
    cells: [
      { local: [0, 0, 0], block: 'stone' },
      { local: [1, 0, 0], block: 'cobblestone' },
      { local: [1, 0, 1], block: 'dirt' },
    ],
  };
  const ctx = enrichPlan(plan);
  ctx.anchor = plan.anchor.coords;
  const world = new Map([
    ['0,64,0', 'stone'],
    ['1,64,0', 'air'],
    ['0,64,1', 'gravel'],
    ['1,64,1', 'stone'],
  ]);
  const result = verifyPlan(ctx, (x, y, z) => world.get(`${x},${y},${z}`) || 'air');
  assert.equal(result.summary.ok, 1);
  assert.equal(result.summary.missing, 1);
  assert.equal(result.summary.wrong, 1);
  assert.equal(result.summary.extra, 1);
});
