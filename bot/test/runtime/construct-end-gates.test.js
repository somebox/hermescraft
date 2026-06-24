import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPlanJson, enrichPlan } from '../../lib/runtime/blueprints/loader.js';
import {
  evaluateConstructEndGates,
  gateDoorTraversable,
  gateInteriorAir,
  gateL0Ground,
  findPerimeterGapLocals,
} from '../../lib/runtime/construct-end-gates.js';
import { footprintMins, iterateFootprintLocals, localToWorld } from '../../lib/runtime/blueprints/footprint.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataDir = path.join(repoRoot, 'data');

function worldFromPlanCells(plan, anchor, overrides = {}) {
  const enriched = enrichPlan(plan);
  const map = { ...overrides };
  for (const c of plan.cells || []) {
    const [lx, ly, lz] = c.local;
    const w = localToWorld(anchor, enriched.footprint, lx, ly, lz);
    map[`${w.x},${w.y},${w.z}`] = c.block;
  }
  const getBlockName = (x, y, z) => map[`${x},${y},${z}`] || 'air';
  const ctxPlan = { ...enriched, anchor, planId: plan.plan_id };
  const mins = footprintMins(enriched.footprint);
  for (const [lx, ly, lz] of iterateFootprintLocals(enriched.footprint)) {
    if (ly !== mins.y) continue;
    const w = localToWorld(anchor, enriched.footprint, lx, ly, lz);
    const k = `${w.x},${w.y},${w.z}`;
    if (!map[k] || map[k] === 'air') map[k] = 'cobblestone';
  }
  return { ctxPlan, getBlockName, map };
}

test('findPerimeterGapLocals includes min_z door gaps for starter_shelter', () => {
  const loaded = loadPlanJson(dataDir, 'starter_shelter');
  const enriched = enrichPlan(loaded.plan);
  const gaps = findPerimeterGapLocals(enriched.footprint, enriched.cellsIndex);
  assert.ok(gaps.some((g) => g.face === 'min_z'));
});

test('gateL0Ground fails when floor cell is air', () => {
  const loaded = loadPlanJson(dataDir, 'starter_shelter');
  assert.equal(loaded.ok, true);
  const anchor = loaded.plan.anchor.coords;
  const enriched = enrichPlan(loaded.plan);
  const map = { '0,64,0': 'air' };
  const getBlockName = (x, y, z) => map[`${x},${y},${z}`] || 'cobblestone';
  const ctxPlan = { ...enriched, anchor, planId: loaded.plan.plan_id };
  const r = gateL0Ground(ctxPlan, getBlockName);
  assert.equal(r.ok, false);
  assert.match(r.message, /L0 ground/);
});

test('gateDoorTraversable fails when door gap is filled', () => {
  const loaded = loadPlanJson(dataDir, 'starter_shelter');
  const anchor = loaded.plan.anchor.coords;
  const { ctxPlan, getBlockName, map } = worldFromPlanCells(loaded.plan, anchor);
  map['3,67,0'] = 'cobblestone';
  const getBlock = (x, y, z) => map[`${x},${y},${z}`] || 'air';
  const r = gateDoorTraversable(ctxPlan, getBlock);
  assert.equal(r.ok, false);
});

test('gateInteriorAir fails when interior is solid-filled', () => {
  const loaded = loadPlanJson(dataDir, 'starter_shelter');
  const anchor = loaded.plan.anchor.coords;
  const { ctxPlan, getBlockName, map } = worldFromPlanCells(loaded.plan, anchor);
  map['3,66,3'] = 'cobblestone';
  const getBlock = (x, y, z) => map[`${x},${y},${z}`] || 'air';
  const r = gateInteriorAir(ctxPlan, getBlock);
  assert.equal(r.ok, false);
});

test('evaluateConstructEndGates passes on idealized full plan world', () => {
  const loaded = loadPlanJson(dataDir, 'starter_shelter');
  const anchor = loaded.plan.anchor.coords;
  const { ctxPlan, getBlockName } = worldFromPlanCells(loaded.plan, anchor);
  const r = evaluateConstructEndGates({
    ctxPlan,
    getBlockName,
    gates: loaded.plan.gates,
    phase: { id: 'L4_roof', level: 5 },
    requirePhaseClean: false,
  });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

test('evaluateConstructEndGates: phase_clean fails with missing cells', () => {
  const loaded = loadPlanJson(dataDir, 'starter_shelter');
  const anchor = loaded.plan.anchor.coords;
  const enriched = enrichPlan(loaded.plan);
  const ctxPlan = { ...enriched, anchor, planId: loaded.plan.plan_id };
  const r = evaluateConstructEndGates({
    ctxPlan,
    getBlockName: () => 'air',
    gates: [],
    phase: { level: 1 },
    requirePhaseClean: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.failures[0]?.gate, 'phase_clean');
});
