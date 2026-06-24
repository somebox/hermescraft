import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRetraceStepCell,
  ascentTargetsFromSteps,
  resolveRetraceTrail,
} from '../../lib/actions/movement/retrace.js';
import { navTrailCrumbsNewestFirst } from '../../lib/runtime/nav-trail.js';

function mockBot(blocks) {
  return {
    blockAt(pos) {
      const k = `${pos.x},${pos.y},${pos.z}`;
      return blocks[k] || { name: 'air', boundingBox: 'empty' };
    },
  };
}

test('ascentTargetsFromSteps reverses descent order', () => {
  const steps = [
    { x: 0, y: 65, z: 0 },
    { x: 0, y: 64, z: -1 },
    { x: 0, y: 63, z: -2 },
  ];
  assert.deepEqual(ascentTargetsFromSteps(steps), [
    { x: 0, y: 63, z: -2 },
    { x: 0, y: 64, z: -1 },
    { x: 0, y: 65, z: 0 },
  ]);
});

test('ascentTargetsFromSteps: fewer than 2 steps → empty', () => {
  assert.deepEqual(ascentTargetsFromSteps([{ x: 0, y: 65, z: 0 }]), []);
  assert.deepEqual(ascentTargetsFromSteps(null), []);
});

test('validateRetraceStepCell: clear stair tread', () => {
  const b = mockBot({
    '0,62,-2': { name: 'stone', boundingBox: 'block' },
    '0,63,-2': { name: 'air', boundingBox: 'empty' },
    '0,64,-2': { name: 'air', boundingBox: 'empty' },
  });
  const r = validateRetraceStepCell(b, { x: 0, y: 63, z: -2 });
  assert.equal(r.ok, true);
});

test('validateRetraceStepCell: gap below', () => {
  const b = mockBot({
    '0,62,-2': { name: 'air', boundingBox: 'empty' },
    '0,63,-2': { name: 'air', boundingBox: 'empty' },
    '0,64,-2': { name: 'air', boundingBox: 'empty' },
  });
  const r = validateRetraceStepCell(b, { x: 0, y: 63, z: -2 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'gap');
});

test('validateRetraceStepCell: obstruction at feet', () => {
  const b = mockBot({
    '0,62,-2': { name: 'stone', boundingBox: 'block' },
    '0,63,-2': { name: 'cobblestone', boundingBox: 'block' },
    '0,64,-2': { name: 'air', boundingBox: 'empty' },
  });
  const r = validateRetraceStepCell(b, { x: 0, y: 63, z: -2 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'obstruction');
});

test('resolveRetraceTrail: use_trail with crumbs', () => {
  const ctx = {
    runtime: {
      navTrail: {
        crumbs: [
          { x: 0, y: 65, z: 0, ts: Date.now() },
          { x: 3, y: 65, z: 0, ts: Date.now() },
        ],
      },
    },
  };
  const trail = resolveRetraceTrail(ctx, () => ({}), { use_trail: true });
  assert.equal(trail.source, 'nav_trail');
  assert.ok(trail.steps.length >= 2);
});

test('resolveRetraceTrail: use_trail falls back to stair_down', () => {
  const ctx = {
    runtime: {
      navTrail: { crumbs: [{ x: 0, y: 65, z: 0, ts: Date.now() }] },
      lastDugSteps: { steps: [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }] },
    },
  };
  const trail = resolveRetraceTrail(ctx, () => ({}), { use_trail: true });
  assert.equal(trail.source, 'stair_down');
  assert.equal(trail.fallback, true);
});

test('retrace handler: no trail → RETRACE_NO_TRAIL', async () => {
  const { createRetrace } = await import('../../lib/actions/movement/retrace.js');
  const retrace = createRetrace({
    ctx: { runtime: {} },
    ensureBot: () => ({ entity: { position: { x: 0, y: 64, z: 0 } }, blockAt: () => ({ name: 'air' }) }),
    posObj: () => ({ x: 0, y: 64, z: 0 }),
    fmt: String,
    loadLocations: () => ({}),
    ACTIONS: {},
    sleep: () => Promise.resolve(),
  });
  const r = await retrace({});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'RETRACE_NO_TRAIL');
});

test('retrace handler: use_trail with empty crumbs → RETRACE_NO_TRAIL (nav_trail)', async () => {
  const { createRetrace } = await import('../../lib/actions/movement/retrace.js');
  const retrace = createRetrace({
    ctx: { runtime: { navTrail: { crumbs: [] } } },
    ensureBot: () => ({ entity: { position: { x: 0, y: 64, z: 0 } }, blockAt: () => ({ name: 'air' }) }),
    posObj: () => ({ x: 0, y: 64, z: 0 }),
    fmt: String,
    loadLocations: () => ({}),
    ACTIONS: {},
    sleep: () => Promise.resolve(),
  });
  const r = await retrace({ use_trail: true });
  assert.equal(r.error.code, 'RETRACE_NO_TRAIL');
  assert.match(r.error.message, /nav-trail crumbs/i);
});
