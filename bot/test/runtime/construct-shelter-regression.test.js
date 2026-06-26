/**
 * F5 — gv2 starter_shelter regression scenarios (deterministic, no live world).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPlanJson, enrichPlan } from '../../lib/runtime/blueprints/loader.js';
import { evaluateConstructEndGates, evaluatePhaseClean } from '../../lib/runtime/construct-end-gates.js';
import { evaluateConstructMutation, setConstructContext, buildWorksetIndex } from '../../lib/runtime/construct-context.js';
import { computeMaterialsMissing } from '../../lib/runtime/construct-materials.js';
import { createBuildingActions } from '../../lib/actions/building/index.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure } from '../_helpers/action-harness.js';
import { clearConstructSession } from '../../lib/runtime/construct-lifecycle.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataDir = path.join(repoRoot, 'data');
import {
  footprintMins,
  iterateFootprintLocals,
  localToWorld,
} from '../../lib/runtime/blueprints/footprint.js';

const ANCHOR = [0, 64, 0];

function withConstructFlag(fn) {
  const prev = process.env.HERMES_CONSTRUCT_CONTEXT;
  process.env.HERMES_CONSTRUCT_CONTEXT = '1';
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.HERMES_CONSTRUCT_CONTEXT;
    else process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
}

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
  return { ctxPlan, getBlockName, map, enriched };
}

/** gv2-11: only some local-y layers placed (deterministic slice probes). */
function buildMapWithLocalY(plan, anchor, includeLocalY) {
  const enriched = enrichPlan(plan);
  const allowed = new Set(includeLocalY);
  const map = {};
  for (const c of plan.cells || []) {
    const [lx, ly, lz] = c.local;
    if (!allowed.has(ly)) continue;
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
  return { ctxPlan, getBlockName };
}

test('F5: filled door gap fails door_traversable end gate', () => {
  const loaded = loadPlanJson(dataDir, 'starter_shelter');
  assert.equal(loaded.ok, true);
  const { ctxPlan, getBlockName } = buildIdealMap(loaded.plan, ANCHOR, {
    '3,67,0': 'cobblestone',
    '4,67,0': 'cobblestone',
  });
  const r = evaluateConstructEndGates({
    ctxPlan,
    getBlockName,
    gates: ['door_traversable'],
    requirePhaseClean: false,
  });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.gate === 'door_traversable'));
});

test('F5: partial roof fails phase_clean on end', () => {
  const loaded = loadPlanJson(dataDir, 'starter_shelter');
  const { ctxPlan, getBlockName, map } = buildIdealMap(loaded.plan, ANCHOR);
  for (const k of Object.keys(map)) {
    const parts = k.split(',');
    if (parts[1] === '69') delete map[k];
  }
  const getBlock = (x, y, z) => map[`${x},${y},${z}`] || 'air';
  const r = evaluateConstructEndGates({
    ctxPlan,
    getBlockName: getBlock,
    gates: [],
    phase: { level: 5 },
    requirePhaseClean: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.failures[0]?.gate, 'phase_clean');
});

test('F5: place_fill cannot patch door gap (ok cells clipped)', async () => {
  await withConstructFlag(async () => {
    const ctx = { runtime: {} };
    setConstructContext(ctx, {
      kind: 'construct',
      plan_id: 'starter_shelter',
      anchor: ANCHOR,
      footprint: { local: { x: [0, 6], y: [0, 5], z: [0, 6] } },
      mutation_policy: ['missing', 'wrong'],
    });
    ctx.runtime._constructWorkset = buildWorksetIndex([
      { x: 1, y: 65, z: 1, category: 'missing', expected_block: 'cobblestone' },
    ]);
    const bot = {
      entity: { position: { x: 0.5, y: 66, z: 0.5 }, distanceTo: () => 1 },
      inventory: { items: () => [{ name: 'cobblestone', count: 64 }] },
      blockAt: () => ({ name: 'air', boundingBox: 'empty', position: { x: 0, y: 0, z: 0 } }),
      equip: async () => {},
      placeBlock: async () => {},
    };
    const services = createMockServices({ state: ctx, ensureBot: () => bot });
    const building = createBuildingActions(services);
    const r = await building.place_fill({
      block: 'cobblestone',
      x1: 3, y1: 67, z1: 0, x2: 4, y2: 67, z2: 0,
    });
    assertFailure(r, { code: 'CONSTRUCT_SCOPE_EMPTY', retrySafe: false });
    clearConstructSession(ctx);
  });
});

test('F5: evaluateConstructMutation blocks place on ok door gap cell', () => {
  withConstructFlag(() => {
    const ctx = { runtime: {} };
    setConstructContext(ctx, {
      kind: 'construct',
      plan_id: 'starter_shelter',
      anchor: ANCHOR,
      footprint: { local: { x: [0, 6], y: [0, 5], z: [0, 6] } },
      mutation_policy: ['missing', 'wrong'],
    });
    ctx.runtime._constructWorkset = buildWorksetIndex([]);
    const r = evaluateConstructMutation(ctx, 3, 67, 0, 'add', { blockName: 'cobblestone' });
    assert.equal(r?.error?.code, 'CONSTRUCT_ALREADY_OK');
  });
});

test('F5: L3 range 2..4 phase end does not require level 5 roof cells', () => {
  const loaded = loadPlanJson(dataDir, 'starter_shelter');
  assert.equal(loaded.ok, true);
  const { ctxPlan, getBlockName, map } = buildIdealMap(loaded.plan, ANCHOR);
  for (const k of Object.keys(map)) {
    const parts = k.split(',');
    const worldY = Number(parts[1]);
    if (worldY >= 69) delete map[k];
  }
  const getBlock = (x, y, z) => map[`${x},${y},${z}`] || 'air';
  const r = evaluateConstructEndGates({
    ctxPlan,
    getBlockName: getBlock,
    gates: [],
    phase: { id: 'L3_walls', range: [2, 4] },
    requirePhaseClean: true,
  });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

test('computeMaterialsMissing subtracts inventory counts', () => {
  const missing = computeMaterialsMissing(
    [{ name: 'cobblestone', count: 49 }, { name: 'oak_log', count: 40 }],
    [{ name: 'cobblestone', count: 10 }],
  );
  assert.equal(missing.length, 2);
  assert.equal(missing.find((m) => m.name === 'cobblestone')?.count, 39);
  assert.equal(missing.find((m) => m.name === 'oak_log')?.count, 40);
});

test('gv2-11: L1 slice clean does not imply full-plan phase_clean on end', () => {
  const loaded = loadPlanJson(dataDir, 'starter_shelter');
  assert.equal(loaded.ok, true);
  const { ctxPlan, getBlockName } = buildMapWithLocalY(loaded.plan, ANCHOR, [1]);
  const l1 = evaluatePhaseClean(ctxPlan, getBlockName, { level: 1 });
  assert.equal(l1.clean, true, 'L1 slab slice should be clean when only dy=1 built');
  const full = evaluatePhaseClean(ctxPlan, getBlockName, {});
  assert.equal(full.clean, false, 'full footprint must stay dirty when walls/roof missing');
  const endL1 = evaluateConstructEndGates({
    ctxPlan,
    getBlockName,
    gates: [],
    phase: { level: 1 },
    requirePhaseClean: true,
  });
  assert.equal(endL1.ok, true);
  const endFull = evaluateConstructEndGates({
    ctxPlan,
    getBlockName,
    gates: [],
    phase: {},
    requirePhaseClean: true,
  });
  assert.equal(endFull.ok, false);
  assert.equal(endFull.failures[0]?.gate, 'phase_clean');
});

test('gv2-11: L3 VERIFY 3..4 passing while 2..4 incomplete (slice mismatch class)', () => {
  const loaded = loadPlanJson(dataDir, 'starter_shelter');
  assert.equal(loaded.ok, true);
  const { ctxPlan, getBlockName } = buildMapWithLocalY(loaded.plan, ANCHOR, [1, 3, 4, 5]);
  const narrow = evaluatePhaseClean(ctxPlan, getBlockName, { range: [3, 4] });
  const planSlice = evaluatePhaseClean(ctxPlan, getBlockName, { range: [2, 4] });
  assert.equal(narrow.clean, true, 'dy 3..4 only can look clean when dy=2 ring missing');
  assert.equal(planSlice.clean, false, 'plan L3_walls 2..4 must fail until dy=2 wall ring placed');
});
