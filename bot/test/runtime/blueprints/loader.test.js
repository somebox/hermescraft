import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildCellsIndex,
  enrichPlan,
  loadPlanJson,
  parsePlanIdFromTarget,
  resolvePlanContext,
} from '../../../lib/runtime/blueprints/loader.js';

test('parsePlanIdFromTarget region and plan_id', () => {
  assert.deepEqual(parsePlanIdFromTarget(':hut3:'), { kind: 'region', regionId: 'hut3' });
  assert.deepEqual(parsePlanIdFromTarget('dystopian-hut-3'), {
    kind: 'plan_id',
    planId: 'dystopian-hut-3',
  });
});

test('enrichPlan builds cells index and tight footprint fallback', () => {
  const plan = {
    plan_id: 't',
    cells: [{ local: [1, 2, 3], block: 'stone' }],
  };
  const e = enrichPlan(plan);
  assert.equal(e.cellsIndex.get('1,2,3').block, 'stone');
  assert.equal(e.footprint.mode, 'tight');
});

test('resolvePlanContext loads plan by region.plan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-'));
  const plans = path.join(dir, 'ops', 'plans');
  fs.mkdirSync(plans, { recursive: true });
  const planId = 'test-hut';
  fs.writeFileSync(
    path.join(plans, `${planId}-plan.json`),
    JSON.stringify({
      plan_id: planId,
      footprint: { mode: 'tight', local: { x: [0, 1], y: [0, 1], z: [0, 1] } },
      anchor: { coords: [10, 64, 20] },
      cells: [{ local: [0, 0, 0], block: 'cobblestone' }],
    }),
  );
  const regions = [
    {
      id: 'hut3',
      plan: planId,
      anchor: { x: 10, y: 64, z: 20 },
      shape: { kind: 'column', radius: 8 },
      sites: { anchor: { x: 10, y: 64, z: 20 } },
    },
  ];
  const ctx = resolvePlanContext({
    dataDir: dir,
    target: parsePlanIdFromTarget(':hut3:'),
    regions,
  });
  assert.equal(ctx.ok, true);
  assert.equal(ctx.planId, planId);
  assert.deepEqual(ctx.anchor, [10, 64, 20]);
});

test('loadPlanJson missing file', () => {
  const r = loadPlanJson('/nonexistent', 'nope');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PLAN_NOT_FOUND');
});
