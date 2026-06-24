import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPlanJson, enrichPlan } from '../../lib/runtime/blueprints/loader.js';
import { verifyPlan } from '../../lib/runtime/blueprints/verify.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataDir = path.join(repoRoot, 'data');

test('starter_shelter plan loads and has door gap on south face', () => {
  const loaded = loadPlanJson(dataDir, 'starter_shelter');
  assert.equal(loaded.ok, true);
  const enriched = enrichPlan(loaded.plan);
  assert.equal(loaded.plan.plan_id, 'starter_shelter');
  assert.ok(loaded.plan.gates?.includes('door_traversable'));
  assert.ok(loaded.plan.phases?.some((p) => p.id === 'L1_slab'));

  const doorLocals = new Set(
    (loaded.plan.cells || [])
      .filter((c) => c.local[2] === 0 && c.local[1] >= 3)
      .map((c) => c.local.join(',')),
  );
  assert.equal(doorLocals.has('3,3,0'), false);
  assert.equal(doorLocals.has('4,3,0'), false);

  const ctx = { ...enriched, anchor: loaded.plan.anchor.coords, planId: 'starter_shelter' };
  const world = new Map();
  for (const c of loaded.plan.cells) {
    const [lx, ly, lz] = c.local;
    const wx = ctx.anchor[0] + lx;
    const wy = ctx.anchor[1] + ly;
    const wz = ctx.anchor[2] + lz;
    world.set(`${wx},${wy},${wz}`, 'air');
  }
  const result = verifyPlan(ctx, (x, y, z) => world.get(`${x},${y},${z}`) || 'air', { level: 1 });
  assert.ok(result.summary.missing > 0);
  assert.equal(result.summary.wrong, 0);
});

test('starter_shelter plan file is committed JSON', () => {
  const fp = path.join(dataDir, 'ops/plans/starter_shelter-plan.json');
  assert.ok(fs.existsSync(fp));
  const plan = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert.equal(plan.stats?.cells, plan.cells?.length);
});

test('parsePlanIdFromTarget accepts starter_shelter plan_id', async () => {
  const { parsePlanIdFromTarget } = await import('../../lib/runtime/blueprints/loader.js');
  const t = parsePlanIdFromTarget('starter_shelter');
  assert.equal(t.kind, 'plan_id');
  assert.equal(t.planId, 'starter_shelter');
});
