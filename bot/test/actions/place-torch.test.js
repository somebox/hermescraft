/**
 * place_torch action — refusal paths + variant auto-pick + delegation.
 *
 * The action is a thin wrapper around `mc place` that knows how to pick
 * floor vs wall torch variant based on adjacency, and that returns a
 * precise NO_SOLID_FACE error before mineflayer's 5s placeBlock timeout
 * kicks in. These tests pin the wrapper's behaviour without touching
 * the underlying `place` implementation (which has its own test suite).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createInteractionActions } from '../../lib/actions/interaction.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure } from '../_helpers/action-harness.js';

/**
 * Build a bot stub with configurable inventory + blockAt behaviour.
 *
 * @param {object} opts
 * @param {string[]} opts.inventory  — list of item names the bot holds (count 1 each)
 * @param {Record<string, {name:string, boundingBox?:string}>} opts.blocks
 *        Map keyed by "x,y,z" → { name, boundingBox?: 'block' | 'empty' }.
 *        Cells not in the map resolve to air.
 */
function makeBot({ inventory = [], blocks = {} } = {}) {
  return {
    entity: {
      position: { x: 0.5, y: 64, z: 0.5 },
    },
    inventory: {
      items: () => inventory.map((name, i) => ({ name, count: 1, slot: 36 + i })),
    },
    blockAt: (vec) => {
      const k = `${Math.floor(vec.x)},${Math.floor(vec.y)},${Math.floor(vec.z)}`;
      const blk = blocks[k];
      if (!blk) return { name: 'air', boundingBox: 'empty' };
      return { name: blk.name, boundingBox: blk.boundingBox ?? 'block' };
    },
    lookAt: async () => {},
    placeBlock: async () => {},
    pathfinder: { goto: async () => {}, setGoal: () => {} },
  };
}

/**
 * Stub `getActions().place` to return a canned response. Lets us test
 * the wrapper without exercising the real place pipeline.
 */
function withPlaceStub(placeResponse) {
  return createMockServices({
    state: { world: { botReady: true } },
    fairPlay: { hasLineOfSight: () => true, eyePosition: () => ({ x: 0, y: 64, z: 0 }) },
    getActions: () => ({ place: async () => placeResponse }),
  });
}

test('place_torch: missing coords → MISSING_ARGS', async () => {
  const bot = makeBot();
  const services = createMockServices({
    state: { world: { botReady: true } },
    ensureBot: () => bot,
    getActions: () => ({}),
  });
  const actions = createInteractionActions(services);
  const r = await actions.place_torch({ y: 64 });
  assertFailure(r, { code: 'MISSING_ARGS', observedKeys: ['received'], retrySafe: false });
});

test('place_torch: empty inventory → NO_TORCH_IN_INVENTORY', async () => {
  const bot = makeBot({ inventory: [], blocks: { '0,63,0': { name: 'stone' } } });
  const services = createMockServices({
    state: { world: { botReady: true } },
    ensureBot: () => bot,
    getActions: () => ({}),
  });
  const actions = createInteractionActions(services);
  const r = await actions.place_torch({ x: 0, y: 64, z: 0 });
  assertFailure(r, {
    code: 'NO_TORCH_IN_INVENTORY',
    observedKeys: ['requested_coord', 'inventory_summary'],
    retrySafe: false,
  });
});

test('place_torch: prefer floor + no solid below → NO_SOLID_FACE', async () => {
  // Block below is air; no walls anywhere. --prefer floor explicitly.
  const bot = makeBot({ inventory: ['torch'], blocks: {} });
  const services = withPlaceStub({ ok: true });
  services.ensureBot = () => bot;
  const actions = createInteractionActions(services);
  const r = await actions.place_torch({ x: 0, y: 64, z: 0, prefer: 'floor' });
  assertFailure(r, {
    code: 'NO_SOLID_FACE',
    messageIncludes: 'block below',
    retrySafe: false,
  });
});

test('place_torch: prefer wall + no wall sides → NO_SOLID_FACE', async () => {
  // Floor IS supported, but caller asked for wall and no walls available.
  const bot = makeBot({
    inventory: ['torch'],
    blocks: { '0,63,0': { name: 'stone' } },
  });
  const services = withPlaceStub({ ok: true });
  services.ensureBot = () => bot;
  const actions = createInteractionActions(services);
  const r = await actions.place_torch({ x: 0, y: 64, z: 0, prefer: 'wall' });
  assertFailure(r, {
    code: 'NO_SOLID_FACE',
    messageIncludes: 'wall',
    retrySafe: false,
  });
});

test('place_torch: auto downgrade — no floor support, walls exist → uses wall', async () => {
  // Block below is air. East side is stone wall. prefer=auto picks wall.
  const placedAtCalls = [];
  const bot = makeBot({
    inventory: ['torch'],
    blocks: { '1,64,0': { name: 'stone' } },  // east wall (x+1)
  });
  // Mutate blockAt so the post-place readback returns wall_torch.
  const origBlockAt = bot.blockAt;
  bot.blockAt = (vec) => {
    const k = `${Math.floor(vec.x)},${Math.floor(vec.y)},${Math.floor(vec.z)}`;
    if (k === '0,64,0' && placedAtCalls.length > 0) return { name: 'wall_torch', boundingBox: 'empty' };
    return origBlockAt(vec);
  };
  const services = withPlaceStub({ ok: true });
  services.ensureBot = () => bot;
  // Inject placement-tracking into the place stub.
  services.getActions = () => ({
    place: async (args) => {
      placedAtCalls.push(args);
      return { ok: true, result: 'placed' };
    },
  });
  const actions = createInteractionActions(services);
  const r = await actions.place_torch({ x: 0, y: 64, z: 0, prefer: 'auto' });
  assert.equal(r.ok, true);
  assert.equal(r.data.variant, 'wall_torch');
  assert.deepEqual(r.data.wall_sides_available, ['east']);
  assert.deepEqual(placedAtCalls[0], { block: 'torch', x: 0, y: 64, z: 0 });
});

test('place_torch: happy path floor — variant detected from post-place readback', async () => {
  let placeCalled = false;
  const bot = makeBot({
    inventory: ['torch'],
    blocks: { '0,63,0': { name: 'dirt' } },  // solid below
  });
  // After place, the target cell has a torch block.
  const origBlockAt = bot.blockAt;
  bot.blockAt = (vec) => {
    const k = `${Math.floor(vec.x)},${Math.floor(vec.y)},${Math.floor(vec.z)}`;
    if (k === '0,64,0' && placeCalled) return { name: 'torch', boundingBox: 'empty' };
    return origBlockAt(vec);
  };
  const services = createMockServices({
    state: { world: { botReady: true } },
    ensureBot: () => bot,
    getActions: () => ({
      place: async () => {
        placeCalled = true;
        return { ok: true, result: 'placed' };
      },
    }),
  });
  const actions = createInteractionActions(services);
  const r = await actions.place_torch({ x: 0, y: 64, z: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.data.variant, 'torch');
  assert.equal(r.data.floor_supported, true);
  assert.equal(r.data.prefer, 'auto');
  assert.equal(placeCalled, true);
});

test('place_torch: place delegation failure propagates', async () => {
  const bot = makeBot({
    inventory: ['torch'],
    blocks: { '0,63,0': { name: 'stone' } },
  });
  const services = createMockServices({
    state: { world: { botReady: true } },
    ensureBot: () => bot,
    getActions: () => ({
      place: async () => ({
        ok: false,
        error: {
          code: 'TARGET_OCCUPIED',
          message: 'cell already has something',
          retry_safe: false,
        },
      }),
    }),
  });
  const actions = createInteractionActions(services);
  const r = await actions.place_torch({ x: 0, y: 64, z: 0 });
  // The wrapper passes the underlying error envelope back unchanged.
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'TARGET_OCCUPIED');
});

test('place_torch: getActions().place not registered → PLACE_NOT_AVAILABLE', async () => {
  const bot = makeBot({
    inventory: ['torch'],
    blocks: { '0,63,0': { name: 'stone' } },
  });
  const services = createMockServices({
    state: { world: { botReady: true } },
    ensureBot: () => bot,
    getActions: () => ({}),  // no place
  });
  const actions = createInteractionActions(services);
  const r = await actions.place_torch({ x: 0, y: 64, z: 0 });
  assertFailure(r, {
    code: 'PLACE_NOT_AVAILABLE',
    retrySafe: true,
  });
});
