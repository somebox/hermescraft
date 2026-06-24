/**
 * Region predicates (is_empty / is_filled / is_sheltered walls) — replaces
 * lean arena modules test_region_predicates.py and test_is_sheltered_wall_check.py.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createQueriesActions } from '../../lib/actions/queries.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure } from '../_helpers/action-harness.js';

function makeMcData() {
  return { blocksByName: { cobblestone: { id: 4, boundingBox: 'block' } }, itemsByName: {}, items: {} };
}

function regionBot(blockAtFn) {
  return {
    entity: { position: new Vec3(0.5, 64, 0.5), isInWater: false, yaw: 0, pitch: 0 },
    inventory: { items: () => [] },
    blockAt: (p) => blockAtFn(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    findBlocks: () => [],
    entities: {},
    pathfinder: {
      movements: { canDig: () => false },
      goto: async () => {},
      setGoal: () => {},
    },
  };
}

function makeServices(bot) {
  return createMockServices({
    state: { world: { botReady: true, bot, mcData: makeMcData() } },
    ensureBot: () => bot,
  });
}

test('queries.is_empty: all-air region reports empty=true', async () => {
  const bot = regionBot(() => ({ name: 'air', boundingBox: 'empty' }));
  const actions = createQueriesActions(makeServices(bot));
  const r = await actions.is_empty({ x1: 0, y1: 64, z1: 0, x2: 2, y2: 64, z2: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.data.empty, true);
  assert.equal(r.data.non_empty_blocks.length, 0);
});

test('queries.is_empty: lists non-air cells in non_empty_blocks', async () => {
  const bot = regionBot((x, y, z) => {
    if (x === 1 && y === 64 && z === 1) return { name: 'dirt', boundingBox: 'block' };
    return { name: 'air', boundingBox: 'empty' };
  });
  const actions = createQueriesActions(makeServices(bot));
  const r = await actions.is_empty({ x1: 0, y1: 64, z1: 0, x2: 2, y2: 64, z2: 2 });
  assert.equal(r.data.empty, false);
  assert.equal(r.data.non_empty_blocks[0].name, 'dirt');
});

test('queries.is_empty: REGION_TOO_LARGE when volume exceeds 1000 cells', async () => {
  const bot = regionBot(() => ({ name: 'air', boundingBox: 'empty' }));
  const actions = createQueriesActions(makeServices(bot));
  const r = await actions.is_empty({ x1: 0, y1: 0, z1: 0, x2: 20, y2: 4, z2: 20 });
  assertFailure(r, { code: 'REGION_TOO_LARGE', retrySafe: false });
});

test('queries.is_filled: MISSING_MATERIAL when material omitted', async () => {
  const bot = regionBot(() => ({ name: 'air', boundingBox: 'empty' }));
  const actions = createQueriesActions(makeServices(bot));
  const r = await actions.is_filled({ x1: 0, y1: 64, z1: 0, x2: 1, y2: 64, z2: 1 });
  assertFailure(r, { code: 'MISSING_MATERIAL', retrySafe: false });
});

test('queries.is_filled: reports missing cells when material mismatches', async () => {
  const bot = regionBot((x, y, z) => {
    if (x === 0 && z === 0) return { name: 'cobblestone', boundingBox: 'block' };
    return { name: 'dirt', boundingBox: 'block' };
  });
  const actions = createQueriesActions(makeServices(bot));
  const r = await actions.is_filled({
    x1: 0, y1: 64, z1: 0, x2: 1, y2: 64, z2: 1, material: 'cobblestone',
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.filled, false);
  assert.ok(r.data.missing.length >= 1);
});

test('queries.is_sheltered: WALLS_INCOMPLETE lists perimeter air gaps', async () => {
  const bot = regionBot((x, y, z) => {
    // 3×3×2 box perimeter at y=64..65; one gap at (1,64,0) on south edge z=0
    const onEdge = x === 0 || x === 2 || z === 0 || z === 2;
    if (!onEdge || y < 64 || y > 65) return { name: 'air', boundingBox: 'empty' };
    if (x === 1 && y === 64 && z === 0) return { name: 'air', boundingBox: 'empty' };
    return { name: 'cobblestone', boundingBox: 'block' };
  });
  const actions = createQueriesActions(makeServices(bot));
  const r = await actions.is_sheltered({
    walls: { x1: 0, y1: 64, z1: 0, x2: 2, y2: 65, z2: 2 },
  });
  assertFailure(r, { code: 'WALLS_INCOMPLETE', retrySafe: false });
  assert.ok(r.error.observed_state.missing_cells.length >= 1);
});
