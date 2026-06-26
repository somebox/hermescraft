/**
 * gv2-11 failure class: slice verify clean but full-plan phase gate would fail;
 * L3 range 2..4 vs stale 3..4; completion blocked without construct end.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPlanJson, enrichPlan } from '../../lib/runtime/blueprints/loader.js';
import { evaluatePhaseClean } from '../../lib/runtime/construct-end-gates.js';
import { normalizeSessionPhase, phaseVerifyArgs } from '../../lib/runtime/construct-lifecycle.js';
import {
  footprintMins,
  iterateFootprintLocals,
  localToWorld,
} from '../../lib/runtime/blueprints/footprint.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataDir = path.join(repoRoot, 'data');
const ANCHOR = [0, 64, 0];

function buildIdealMap(plan, anchor, patch = {}) {
  const enriched = enrichPlan(plan);
  const map = { ...patch };
  for (const c of plan.cells || []) {
    const [lx, ly, lz] = c.local;
    map[`${anchor[0] + lx},${anchor[1] + ly},${anchor[2] + lz}`] = c.block;
  }
  const mins = footprintMins(enriched.footprint);
  for (const [lx, ly, lz] of iterateFootprintLocals(enriched.footprint)) {
    if (ly !== mins.y) continue;
    const w = localToWorld(anchor, enriched.footprint, lx, ly, lz);
    const k = `${w.x},${w.y},${w.z}`;
    if (!map[k] || map[k] === 'air') map[k] = 'cobblestone';
  }
  const getBlockName = (x, y, z) => map[`${x},${y},${z}`] || 'air';
  const ctxPlan = { ...enriched, anchor, planId: plan.plan_id };
  return { ctxPlan, getBlockName, map };
}

test('gv2-11: L1 level clean does not imply full plan clean', () => {
  const loaded = loadPlanJson(dataDir, 'starter_shelter');
  assert.equal(loaded.ok, true);
  const { ctxPlan } = buildIdealMap(loaded.plan, ANCHOR);
  // Partial: only L1 slab, walls/roof missing
  const partialMap = {};
  for (const c of loaded.plan.cells || []) {
    const [lx, ly, lz] = c.local;
    if (ly === 1) {
      const w = localToWorld(ANCHOR, ctxPlan.footprint, lx, ly, lz);
      partialMap[`${w.x},${w.y},${w.z}`] = c.block;
    }
  }
  const mins = footprintMins(ctxPlan.footprint);
  for (const [lx, ly, lz] of iterateFootprintLocals(ctxPlan.footprint)) {
    if (ly !== mins.y) continue;
    const w = localToWorld(ANCHOR, ctxPlan.footprint, lx, ly, lz);
    partialMap[`${w.x},${w.y},${w.z}`] = 'cobblestone';
  }
  const getPartial = (x, y, z) => partialMap[`${x},${y},${z}`] || 'air';
  const l1Only = evaluatePhaseClean(ctxPlan, getPartial, { level: 1 });
  assert.equal(l1Only.clean, true);
  const fullPartial = evaluatePhaseClean(ctxPlan, getPartial, {});
  assert.equal(fullPartial.clean, false);
});

test('gv2-11: L3 3..4 verify can pass while 2..4 walls incomplete', () => {
  const loaded = loadPlanJson(dataDir, 'starter_shelter');
  const { ctxPlan, map } = buildIdealMap(loaded.plan, ANCHOR);
  for (const c of loaded.plan.cells || []) {
    const [lx, ly, lz] = c.local;
    if (ly >= 2 && ly <= 3) {
      const w = localToWorld(ANCHOR, ctxPlan.footprint, lx, ly, lz);
      delete map[`${w.x},${w.y},${w.z}`];
    }
  }
  const getBlock = (x, y, z) => map[`${x},${y},${z}`] || 'air';
  const narrow = evaluatePhaseClean(ctxPlan, getBlock, { range: [3, 4] });
  const planSlice = evaluatePhaseClean(ctxPlan, getBlock, { range: [2, 4] });
  assert.equal(narrow.clean, false);
  assert.equal(planSlice.clean, false);
  // Fill only dy=3..4 wall ring
  for (const c of loaded.plan.cells || []) {
    const [lx, ly, lz] = c.local;
    if (ly >= 3 && ly <= 4) {
      const w = localToWorld(ANCHOR, ctxPlan.footprint, lx, ly, lz);
      map[`${w.x},${w.y},${w.z}`] = c.block;
    }
  }
  const getBlock2 = (x, y, z) => map[`${x},${y},${z}`] || 'air';
  assert.equal(evaluatePhaseClean(ctxPlan, getBlock2, { range: [3, 4] }).clean, true);
  assert.equal(evaluatePhaseClean(ctxPlan, getBlock2, { range: [2, 4] }).clean, false);
});

test('gv2 card shape stores verify args with range not string spread', () => {
  const phase = normalizeSessionPhase({ phase: 'L3_walls', range: '2..4' }, {});
  assert.deepEqual(phaseVerifyArgs(phase), { range: '2..4' });
  const bad = 'L3_walls';
  assert.deepEqual(phaseVerifyArgs(bad), {});
});
