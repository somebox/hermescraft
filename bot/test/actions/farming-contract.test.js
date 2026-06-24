/**
 * Farming handler contract tests (refusal paths).
 * ADR: docs/reference/bot/handler-contract-adr.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createFarmingActions } from '../../lib/actions/farming.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure } from '../_helpers/action-harness.js';

  const farmingDeps = (bot) => {
    const services = createMockServices({
      state: { world: { botReady: true, bot, mcData: { blocksByName: {} } } },
      ensureBot: () => bot,
    });
    return {
      ctx: services.state,
      ensureBot: () => bot,
      goals: { GoalNear: function () {} },
      fmt: services.utils.fmt,
      posObj: services.utils.posObj,
      sleep: services.utils.sleep,
      log: services.utils.log,
      getMyName: () => 'TestBot',
      ACTIONS: { pickup: async () => ({}) },
    };
  };

function baseBot(blockAtFn) {
  return {
    entity: { position: new Vec3(0.5, 64, 0.5), distanceTo: () => 1 },
    inventory: { items: () => [] },
    blockAt: blockAtFn || (() => ({ name: 'air' })),
    pathfinder: { goto: async () => {} },
    equip: async () => {},
    activateBlock: async () => {},
    activateItem: async () => {},
    dig: async () => {},
  };
}

test('farming.till: no hoe → NO_HOE', async () => {
  const actions = createFarmingActions(farmingDeps(baseBot()));
  const r = await actions.till({ x: 0, y: 63, z: 0 });
  assertFailure(r, { code: 'NO_HOE', messageIncludes: 'hoe', retrySafe: false });
});

test('farming.plant: no seeds → NO_SEEDS', async () => {
  const bot = baseBot(() => ({ name: 'farmland', boundingBox: 'block' }));
  const actions = createFarmingActions(farmingDeps(bot));
  const r = await actions.plant({ item: 'wheat_seeds', x: 0, y: 63, z: 0 });
  assertFailure(r, { code: 'NO_SEEDS', retrySafe: false });
});

test('farming.bonemeal: no block at coord → NOT_GROWABLE', async () => {
  const bot = baseBot(() => null);
  bot.inventory.items = () => [{ name: 'bone_meal', count: 1 }];
  const actions = createFarmingActions(farmingDeps(bot));
  const r = await actions.bonemeal({ x: 0, y: 64, z: 0 });
  assertFailure(r, { code: 'NOT_GROWABLE', retrySafe: false });
});

test('farming.bonemeal: no bone meal → NO_BONEMEAL', async () => {
  const bot = baseBot(() => ({ name: 'wheat', getProperties: () => ({ age: 0 }) }));
  const actions = createFarmingActions(farmingDeps(bot));
  const r = await actions.bonemeal({ x: 0, y: 64, z: 0 });
  assertFailure(r, { code: 'NO_BONEMEAL', retrySafe: false });
});

test('farming.harvest: nothing to harvest → NOTHING_TO_HARVEST', async () => {
  const bot = baseBot(() => ({ name: 'air', boundingBox: 'empty' }));
  const actions = createFarmingActions(farmingDeps(bot));
  const r = await actions.harvest({ x1: 0, z1: 0, x2: 0, z2: 0, y: 64 });
  assertFailure(r, { code: 'NOTHING_TO_HARVEST', retrySafe: false });
});

test('farming.farm_status: categorizes harvestable wheat and till hint', async () => {
  const blockAt = (p) => {
    const { x, y, z } = p;
    if (y === 63 && x >= 0 && x <= 1 && z >= 0 && z <= 1) {
      return { name: 'farmland', boundingBox: 'block', getProperties: () => ({ moisture: 7 }) };
    }
    if (y === 64 && x === 0 && z === 0) {
      return { name: 'wheat', boundingBox: 'block', getProperties: () => ({ age: 7 }) };
    }
    if (y === 64 && x === 1 && z === 0) {
      return { name: 'wheat', boundingBox: 'block', getProperties: () => ({ age: 3 }) };
    }
    return { name: 'air', boundingBox: 'empty' };
  };
  const bot = baseBot(blockAt);
  const actions = createFarmingActions(farmingDeps(bot));
  const r = await actions.farm_status({ x1: 0, z1: 0, x2: 1, z2: 1, y: 63 });
  assert.equal(r.ok, true);
  assert.equal(r.data.counts.harvestable, 1);
  assert.equal(r.data.counts.planted_growing, 1);
  assert.match(r.next_action_hint || '', /mc harvest/i);
});
