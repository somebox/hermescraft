/**
 * mc corridor_sample — batch terrain_top over a rectangle.
 *
 * Both navigators in trial proc-nav-1780994801 requested this verb to
 * collapse the 9-call cross-section measurement into 1 round-trip.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createQueriesActions } from '../../lib/actions/queries.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure, assertContract } from '../_helpers/action-harness.js';

function makeBot(terrain) {
  const PASSABLE = new Set(['air', 'cave_air', 'void_air']);
  const FLUID = new Set(['water', 'lava', 'flowing_water', 'flowing_lava']);
  return {
    entity: { position: { x: 0, y: 70, z: 0, distanceTo: () => 0 } },
    game: { minY: -64, height: 384 },
    inventory: { items: () => [] },
    blockAt({ x, y, z }) {
      const k = `${x},${y},${z}`;
      const t = terrain.get(k);
      if (!t) return { name: 'air', boundingBox: 'empty', position: { x, y, z } };
      const isAir = PASSABLE.has(t) || FLUID.has(t);
      return { name: t, boundingBox: isAir ? 'empty' : 'block', position: { x, y, z } };
    },
  };
}

function makeQueries(bot) {
  const services = createMockServices({
    state: { world: { botReady: true, bot } },
    ensureBot: () => bot,
  });
  return createQueriesActions(services);
}

function buildFlatGround(x1, x2, z1, z2, y, name = 'grass_block') {
  const t = new Map();
  for (let x = x1; x <= x2; x++) {
    for (let z = z1; z <= z2; z++) {
      // stone subsurface so anything that probes below y still finds something
      for (let dy = 1; dy <= 4; dy++) t.set(`${x},${y - dy},${z}`, 'stone');
      t.set(`${x},${y},${z}`, name);
    }
  }
  return t;
}

test('corridor_sample: missing x1 → INVALID_COORD', async () => {
  const q = makeQueries(makeBot(new Map()));
  const r = await q.corridor_sample({ z1: 0, x2: 0, z2: 0 });
  assertFailure(r, { code: 'INVALID_COORD', messageIncludes: 'x1', retrySafe: false });
});

test('corridor_sample: 3×3 flat ground returns 9 samples + median', async () => {
  const t = buildFlatGround(0, 2, 0, 2, 64);
  const q = makeQueries(makeBot(t));
  const r = await q.corridor_sample({ x1: 0, z1: 0, x2: 2, z2: 2, full: true });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.columns_n, 9);
  assert.equal(r.data.known_n, 9);
  assert.equal(r.data.elevation_median, 64);
  assert.equal(r.data.elevation_min, 64);
  assert.equal(r.data.elevation_max, 64);
  assert.equal(r.data.elevation_delta, 0);
  assert.equal(r.data.samples.length, 9);
  // Every sample at y=64 grass_block:
  for (const s of r.data.samples) {
    assert.equal(s.block_y, 64);
    assert.equal(s.surface_y, 65);
    assert.equal(s.block_name, 'grass_block');
  }
});

test('corridor_sample: step=2 halves z-sampling', async () => {
  const t = buildFlatGround(0, 2, 0, 5, 64);
  const q = makeQueries(makeBot(t));
  const r = await q.corridor_sample({ x1: 0, z1: 0, x2: 2, z2: 5, step: 2 });
  assertContract(r);
  // 3 x cells × ceil(6/2)=3 z cells = 9.
  assert.equal(r.data.columns_n, 9);
  assert.equal(r.data.step, 2);
});

test('corridor_sample: full=false omits samples (compact response)', async () => {
  const t = buildFlatGround(0, 2, 0, 2, 64);
  const q = makeQueries(makeBot(t));
  const r = await q.corridor_sample({ x1: 0, z1: 0, x2: 2, z2: 2 });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.samples, undefined);
  assert.equal(r.data.elevation_median, 64);
});

test('corridor_sample: oversize > 512 samples → OUT_OF_RANGE', async () => {
  // 23 × 23 = 529 samples > 512 cap.
  const t = buildFlatGround(0, 22, 0, 22, 64);
  const q = makeQueries(makeBot(t));
  const r = await q.corridor_sample({ x1: 0, z1: 0, x2: 22, z2: 22 });
  assertFailure(r, {
    code: 'OUT_OF_RANGE',
    messageIncludes: '> 512',
    observedKeys: ['requested_samples', 'max_samples', 'bounds'],
    retrySafe: false,
  });
});

test('corridor_sample: 3×96 = 288 samples is under the 512 cap (proc-nav-road second-trial size)', async () => {
  const t = buildFlatGround(-1, 1, 0, 95, 64);
  const q = makeQueries(makeBot(t));
  const r = await q.corridor_sample({ x1: -1, z1: 0, x2: 1, z2: 95 });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.columns_n, 288);
  assert.equal(r.data.elevation_median, 64);
});

test('corridor_sample: exclude_foliage skips canopy + snow_layer', async () => {
  // Flat ground at y=64. A spruce log + canopy at y=78. Snow on canopy top.
  const t = buildFlatGround(0, 2, 0, 2, 64);
  for (let dx = 0; dx <= 2; dx++) {
    for (let dz = 0; dz <= 2; dz++) {
      t.set(`${dx},78,${dz}`, 'spruce_leaves');
      t.set(`${dx},79,${dz}`, 'snow'); // snow_layer
    }
  }

  const q = makeQueries(makeBot(t));
  // Without exclude_foliage: top reads as snow_layer at y=79.
  const rDefault = await q.corridor_sample({ x1: 0, z1: 0, x2: 2, z2: 2 });
  assertContract(rDefault);
  assert.equal(rDefault.data.elevation_median, 79);

  // With exclude_foliage: leaves + snow_layer skipped, ground at y=64.
  const rOpt = await q.corridor_sample({
    x1: 0, z1: 0, x2: 2, z2: 2, exclude_foliage: true,
  });
  assertContract(rOpt);
  assert.equal(rOpt.data.elevation_median, 64);
  assert.equal(rOpt.data.exclude_foliage, true);
});

test('corridor_sample: order-independent bounds (x1>x2 OK)', async () => {
  const t = buildFlatGround(0, 2, 0, 2, 64);
  const q = makeQueries(makeBot(t));
  const r = await q.corridor_sample({ x1: 2, z1: 2, x2: 0, z2: 0 });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.bounds.x1, 0);
  assert.equal(r.data.bounds.x2, 2);
  assert.equal(r.data.elevation_median, 64);
});

test('corridor_sample: completely unloaded chunks → NO_SURFACE', async () => {
  const t = new Map(); // empty terrain
  const q = makeQueries(makeBot(t));
  const r = await q.corridor_sample({ x1: 0, z1: 0, x2: 1, z2: 1 });
  assertFailure(r, {
    code: 'NO_SURFACE',
    messageIncludes: 'no solid block',
    retrySafe: true,
  });
});

test('corridor_sample: result string includes median + delta', async () => {
  const t = buildFlatGround(0, 2, 0, 2, 64);
  // Inject one cell at y=66 so delta > 0.
  t.delete(`1,64,1`);
  t.set(`1,66,1`, 'grass_block');
  for (let dy = 1; dy <= 4; dy++) t.set(`1,66-dy,1`.replace('66-dy', `${66 - dy}`), 'stone');
  const q = makeQueries(makeBot(t));
  const r = await q.corridor_sample({ x1: 0, z1: 0, x2: 2, z2: 2 });
  assertContract(r);
  assert.match(r.result, /corridor_sample 3×3/);
  assert.match(r.result, /median=/);
  assert.match(r.result, /delta=/);
});
