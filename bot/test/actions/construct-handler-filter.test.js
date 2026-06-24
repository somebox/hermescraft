/**
 * F3 — construct mutation filters at handler boundaries (mock bot, no world).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { ok } from '../../lib/shared/action-contract.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { createBuildingActions } from '../../lib/actions/building/index.js';
import { createExcavationActions } from '../../lib/actions/excavation.js';
import { createMiningActions } from '../../lib/actions/mining.js';
import { makeStubBot, makeDeps } from './_mining-test-helpers.js';
import {
  buildWorksetIndex,
  setConstructContext,
} from '../../lib/runtime/construct-context.js';
import { clearConstructSession } from '../../lib/runtime/construct-lifecycle.js';
import { assertFailure } from '../_helpers/action-harness.js';

const FOOTPRINT = { local: { x: [0, 4], y: [0, 4], z: [0, 4] } };
const ANCHOR = [10, 64, 10];

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

function seedConstructSession(ctx, worksetEntries = []) {
  setConstructContext(ctx, {
    kind: 'construct',
    plan_id: 'starter_shelter',
    anchor: ANCHOR,
    footprint: FOOTPRINT,
    mutation_policy: ['missing', 'wrong', 'extra'],
  });
  ctx.runtime._constructWorkset = buildWorksetIndex(worksetEntries);
}

function solidBot(blocks, opts = {}) {
  const map = { ...blocks };
  return {
    entity: {
      position: opts.pos || new Vec3(10.5, 65, 10.5),
      distanceTo: () => 1,
    },
    inventory: {
      items: () => opts.inventory || [{ name: 'cobblestone', count: 64 }],
    },
    blockAt: (p) => {
      const k = `${p.x},${p.y},${p.z}`;
      const name = map[k] ?? 'air';
      return {
        name,
        boundingBox: name === 'air' || name === 'cave_air' ? 'empty' : 'block',
        position: p,
        digTime: 1,
      };
    },
    equip: async () => {},
    placeBlock: async (ref, vec) => {
      const t = ref.position.offset(vec.x, vec.y, vec.z);
      map[`${t.x},${t.y},${t.z}`] = opts.placeAs || 'cobblestone';
    },
    dig: async (blk) => {
      const p = blk.position;
      map[`${p.x},${p.y},${p.z}`] = 'air';
    },
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    mcData: { toolsByMaterial: { iron: ['pickaxe'] } },
    tool: {
      itemInHand: () => ({ name: 'iron_pickaxe' }),
      equipForBlock: async () => {},
    },
  };
}

test('wall: BLUEPRINT_WALL_DISABLED when construct session active', async () => {
  await withConstructFlag(async () => {
    const ctx = { runtime: {} };
    seedConstructSession(ctx, []);
    const bot = solidBot({});
    const services = createMockServices({ state: ctx, ensureBot: () => bot });
    const building = createBuildingActions(services);
    const r = await building.wall({
      block: 'cobblestone', x1: 10, y1: 64, z1: 10, x2: 10, y2: 66, z2: 10,
    });
    assertFailure(r, { code: 'BLUEPRINT_WALL_DISABLED', retrySafe: false });
    clearConstructSession(ctx);
  });
});

test('level: CONSTRUCT_LEVEL_DISABLED when construct session active', async () => {
  await withConstructFlag(async () => {
    const ctx = { runtime: {} };
    seedConstructSession(ctx, []);
    const bot = solidBot({});
    const services = createMockServices({ state: ctx, ensureBot: () => bot });
    const building = createBuildingActions(services);
    const r = await building.level({ x1: 10, z1: 10, x2: 12, z2: 12, y: 64 });
    assertFailure(r, { code: 'CONSTRUCT_LEVEL_DISABLED', retrySafe: false });
    clearConstructSession(ctx);
  });
});

test('clear_strip: CONSTRUCT_CLEAR_STRIP_DISABLED when construct session active', async () => {
  await withConstructFlag(async () => {
    const ctx = { runtime: {} };
    seedConstructSession(ctx, []);
    const bot = solidBot({});
    const services = createMockServices({ state: ctx, ensureBot: () => bot });
    const building = createBuildingActions(services);
    const r = await building.clear_strip({ x1: 10, z1: 10, x2: 12, z2: 12, y: 64 });
    assertFailure(r, { code: 'CONSTRUCT_CLEAR_STRIP_DISABLED', retrySafe: false });
    clearConstructSession(ctx);
  });
});

test('place_fill: large box allowed when construct clip leaves ≤32 workset cells', async () => {
  await withConstructFlag(async () => {
    const ctx = { runtime: {} };
    seedConstructSession(ctx, [
      { x: 11, y: 64, z: 11, category: 'missing', expected_block: 'cobblestone' },
    ]);
    const blocks = { '11,64,11': 'air', '10,64,10': 'stone', '11,63,11': 'stone' };
    const bot = solidBot(blocks);
    const services = createMockServices({
      state: ctx,
      ensureBot: () => bot,
      utils: { sleep: async () => {}, fmt: String, posObj: (p) => p, log: () => {} },
    });
    const building = createBuildingActions(services);
    const r = await building.place_fill({
      block: 'cobblestone',
      x1: 10, y1: 64, z1: 10, x2: 20, y2: 64, z2: 20,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.data?.placed, 1);
    clearConstructSession(ctx);
  });
});

test('place_fill: CONSTRUCT_SCOPE_EMPTY when every cell is construct-denied', async () => {
  await withConstructFlag(async () => {
    const ctx = { runtime: {} };
    seedConstructSession(ctx, []);
    const bot = solidBot({});
    const services = createMockServices({ state: ctx, ensureBot: () => bot });
    const building = createBuildingActions(services);
    const r = await building.place_fill({
      block: 'cobblestone',
      x1: 10, y1: 64, z1: 10, x2: 10, y2: 64, z2: 10,
    });
    assertFailure(r, { code: 'CONSTRUCT_SCOPE_EMPTY', retrySafe: false });
    clearConstructSession(ctx);
  });
});

test('place_fill: construct kernel places on missing workset cell', async () => {
  await withConstructFlag(async () => {
    const ctx = { runtime: {} };
    seedConstructSession(ctx, [
      { x: 11, y: 64, z: 11, category: 'missing', expected_block: 'cobblestone' },
    ]);
    const blocks = { '11,64,11': 'air', '11,63,11': 'stone', '10,64,10': 'stone' };
    const bot = solidBot(blocks);
    const services = createMockServices({
      state: ctx,
      ensureBot: () => bot,
      utils: { sleep: async () => {}, fmt: String, posObj: (p) => p, log: () => {} },
    });
    const building = createBuildingActions(services);
    const r = await building.place_fill({
      block: 'cobblestone',
      x1: 11, y1: 64, z1: 11, x2: 11, y2: 64, z2: 11,
    });
    assert.equal(r.ok, true);
    assert.equal(r.data?.placed, 1);
    assert.ok(r.data?.guided_edit_progress);
    clearConstructSession(ctx);
  });
});

test('dig: CONSTRUCT_ALREADY_OK inside footprint on ok category', async () => {
  await withConstructFlag(async () => {
    const deps = makeDeps({
      hasLineOfSight: () => true,
      eyePosition: () => new Vec3(10, 65.6, 10),
      bot: makeStubBot({
        position: new Vec3(10.5, 65, 10.5),
        blockAtByPos: (pos) => ({
          name: 'cobblestone',
          position: pos,
          boundingBox: 'block',
          getProperties: () => ({}),
        }),
      }),
    });
    seedConstructSession(deps.ctx, []);
    const mining = createMiningActions(deps);
    const r = await mining.dig({ x: 11, y: 64, z: 11 });
    assertFailure(r, { code: 'CONSTRUCT_ALREADY_OK', retrySafe: false });
    clearConstructSession(deps.ctx);
  });
});

test('dig: allows remove on wrong-category cell', async () => {
  await withConstructFlag(async () => {
    const deps = makeDeps({
      hasLineOfSight: () => true,
      eyePosition: () => new Vec3(10, 65.6, 10),
      bot: makeStubBot({
        position: new Vec3(10.5, 65, 10.5),
        blockAtByPos: (pos) => ({
          name: 'dirt',
          position: pos,
          boundingBox: 'block',
          getProperties: () => ({}),
        }),
        dig: async () => {},
      }),
    });
    seedConstructSession(deps.ctx, [
      { x: 11, y: 64, z: 11, category: 'wrong', expected_block: 'cobblestone' },
    ]);
    const mining = createMiningActions(deps);
    const r = await mining.dig({ x: 11, y: 64, z: 11, force: true });
    assert.equal(r.ok, true);
    assert.ok(r.data?.guided_edit_progress, 'dig success should attach C7 envelope');
    clearConstructSession(deps.ctx);
  });
});

test('dig_area: construct kernel skips non-diggable workset cells', async () => {
  await withConstructFlag(async () => {
    const ctx = { runtime: {} };
    seedConstructSession(ctx, [
      { x: 10, y: 64, z: 10, category: 'wrong' },
      { x: 11, y: 64, z: 10, category: 'missing' },
    ]);
    const blocks = {
      '10,64,10': 'dirt',
      '11,64,10': 'dirt',
    };
    const bot = solidBot(blocks, { pos: new Vec3(9.5, 65, 9.5) });
    const services = createMockServices({
      state: ctx,
      ensureBot: () => bot,
      getActions: () => ({ pickup: async () => ok({}) }),
    });
    const excavation = createExcavationActions(services);
    const r = await excavation.dig_area({
      x1: 10, y1: 64, z1: 10, x2: 11, y2: 64, z2: 10,
      safe: false,
      clear_stand: false,
    });
    assert.equal(r.dug, 1, 'only wrong cell is removable under construct policy');
    assert.ok(r.scope_denied_construct >= 1);
    assert.ok(
      r.data?.guided_edit_progress || r.guided_edit_progress,
      'dig_area should attach guided_edit_progress when construct active',
    );
    clearConstructSession(ctx);
  });
});

test('place: outside footprint is not construct-filtered', async () => {
  await withConstructFlag(async () => {
    const ctx = { runtime: {} };
    seedConstructSession(ctx, []);
    const blocks = { '99,64,99': 'air', '99,63,99': 'stone' };
    const bot = solidBot(blocks, { pos: new Vec3(98.5, 65, 98.5) });
    const services = createMockServices({
      state: ctx,
      ensureBot: () => bot,
      fairPlay: { hasLineOfSight: () => true, eyePosition: () => ({ x: 0, y: 0, z: 0 }) },
    });
    const building = createBuildingActions(services);
    const r = await building.place({ block: 'cobblestone', x: 99, y: 64, z: 99 });
    assert.notEqual(r?.error?.code, 'CONSTRUCT_ALREADY_OK');
    assert.notEqual(r?.error?.code, 'CONSTRUCT_NOT_STARTED');
    clearConstructSession(ctx);
  });
});
