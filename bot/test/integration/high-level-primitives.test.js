/**
 * Functional tests for Phase C "high-level primitive contracts" (task #19).
 *
 * These exercise the body's auto-orchestration: mc disembark chains
 * mc escape when it lands the bot in water; mc craft walks to known
 * chests and withdraws missing ingredients before crafting; mc board
 * (no-args) wraps place_boat + mount.
 *
 * Together with bot/test/integration/boat-workflow.test.js these locks
 * down the behaviors that turn long-distance navigation from "agent
 * orchestrates 17 primitives" to "agent picks goals, body handles
 * tactical detail."
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createWaterActions } from '../../lib/actions/water.js';
import { createCraftingActions } from '../../lib/actions/crafting.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { ok } from '../../lib/shared/action-contract.js';

// ─────────────────────────────────────────────────────────────────────────
// mc disembark — chains ACTIONS.escape() if bot ends in water (eaf0c5c)
// ─────────────────────────────────────────────────────────────────────────

test('mc disembark: dismount in water → calls ACTIONS.escape, surfaces auto_escape', async () => {
  // Bot is mounted on a real boat entity. Below the boat is water; after
  // dismount the bot's foot block is water → auto-escape should fire.
  const boat = {
    id: 1,
    name: 'oak_boat',
    type: 'oak_boat',
    position: new Vec3(0, 63, 0),
  };
  let escapeCallCount = 0;
  const bot = {
    entity: {
      position: new Vec3(0.5, 62, 0.5),
      isInWater: true,
    },
    inventory: { items: () => [] },
    entities: { 1: boat },
    vehicle: boat,
    blockAt(p) {
      // Boat sits over water; the cell below the boat (y=62) is water.
      const y = Math.floor(p.y);
      if (y <= 62) return { name: 'water', boundingBox: 'empty', position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)), getProperties: () => ({ level: 0 }) };
      return { name: 'air', boundingBox: 'empty', position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)), getProperties: () => ({ level: 0 }) };
    },
    dismount() { bot.vehicle = null; },
    setControlState: () => {},
  };
  const ACTIONS = {
    sail: async () => ok({ data: {} }),
    escape: async () => {
      escapeCallCount++;
      return ok({ data: { action_taken: 'water_swim_to_shore', success: true } });
    },
  };
  const services = createMockServices();
  const water = createWaterActions({
    ctx: services.state,
    ensureBot: () => bot,
    sleep: () => Promise.resolve(),
    log: () => {},
    getMyName: () => 'TestSteve',
    ACTIONS,
    goals: { GoalNear: function () {}, GoalBlock: function () {} },
  });
  const r = await water.disembark();
  assert.equal(r.ok, true);
  assert.equal(r.command, 'disembark');
  assert.equal(escapeCallCount, 1, 'ACTIONS.escape should be called exactly once');
  assert.ok(r.data.auto_escape, 'envelope must include data.auto_escape');
  assert.equal(r.data.auto_escape.ok, true);
});

test('mc disembark: dismount on dry land → does NOT call ACTIONS.escape', async () => {
  // Boat is over dry land (block below = grass). Dismount lands the bot
  // on grass; no auto-escape needed.
  const boat = {
    id: 1,
    name: 'oak_boat',
    type: 'oak_boat',
    position: new Vec3(0, 64, 0),
  };
  let escapeCallCount = 0;
  const bot = {
    entity: { position: new Vec3(0.5, 63, 0.5), isInWater: false },
    inventory: { items: () => [] },
    entities: { 1: boat },
    vehicle: boat,
    blockAt(p) {
      const y = Math.floor(p.y);
      if (y === 62) return { name: 'grass_block', boundingBox: 'block', position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)), getProperties: () => ({}) };
      return { name: 'air', boundingBox: 'empty', position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)), getProperties: () => ({}) };
    },
    dismount() { bot.vehicle = null; },
    setControlState: () => {},
  };
  const ACTIONS = {
    sail: async () => ok({ data: {} }),
    escape: async () => { escapeCallCount++; return ok({ data: {} }); },
  };
  const services = createMockServices();
  const water = createWaterActions({
    ctx: services.state,
    ensureBot: () => bot,
    sleep: () => Promise.resolve(),
    log: () => {},
    getMyName: () => 'TestSteve',
    ACTIONS,
    goals: { GoalNear: function () {}, GoalBlock: function () {} },
  });
  const r = await water.disembark();
  assert.equal(r.ok, true);
  assert.equal(escapeCallCount, 0, 'ACTIONS.escape must not be called on dry-land dismount');
  assert.equal(r.data.auto_escape, undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// mc craft — auto-fetch missing ingredients from chests (13af777)
// ─────────────────────────────────────────────────────────────────────────

test('mc craft: missing ingredients → calls chest_search + withdraw', async () => {
  // Build a fake item id table + recipe that requires 2 sticks. Bot has
  // a crafting_table 1 block away but ZERO sticks. The auto-fetch logic
  // should call chest_search('stick') → walk to chest → withdraw.
  let chestSearchCalls = [];
  let withdrawCalls = [];
  const fakeRecipe = {
    result: { id: 100, count: 1 },
    inShape: [[null, { id: 50, metadata: 0 }, null]], // 1 stick
    ingredients: null,
    requiresTable: false,
  };
  const stickItemType = { id: 50, displayName: 'Stick', name: 'stick' };
  const tableBlockType = { id: 200, name: 'crafting_table' };
  const mcData = {
    itemsByName: { stick: stickItemType, iron_sword: { id: 100, name: 'iron_sword', displayName: 'Iron Sword' } },
    blocksByName: { crafting_table: tableBlockType },
    items: { 50: stickItemType },
    blocks: { 200: tableBlockType },
  };
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] }, // no sticks, no ingredients
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    findBlock: () => null, // no crafting_table nearby
    recipesFor: () => [fakeRecipe],
    recipesAll: () => [fakeRecipe],
    craft: async () => {},
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    lookAt: async () => {},
  };
  const services = createMockServices();
  // services.state.world needs mcData + bot for the craft handler.
  services.state.world.mcData = mcData;
  services.state.world.bot = bot;
  services.state.world.botReady = true;

  // Stub the actions accessor: chest_search returns a known chest at
  // (5,64,0); withdraw moves a stick to inventory.
  const allActions = {
    chest_search: async ({ item }) => {
      chestSearchCalls.push(item);
      return ok({ data: { matches: [{ x: 5, y: 64, z: 0, item: 'stick', count: 10 }] } });
    },
    withdraw: async (body) => {
      withdrawCalls.push(body);
      // Pretend the withdraw worked: bot now has 1 stick.
      bot.inventory.items = () => [{ name: 'stick', count: 4 }];
      return ok({ data: { inventory_delta: { stick: 4 } } });
    },
  };
  const crafting = createCraftingActions({
    state: services.state,
    ensureBot: () => bot,
    utils: { sleep: () => Promise.resolve(), log: () => {} },
    social: { getMyName: () => 'TestSteve' },
    locations: { load: () => ({}), save: () => {} },
    craft: {
      resolveCraftItemName: (raw) => raw,
      buildCraftPlan: (b, itemName, invocations) => {
        // Plan reports stick missing if bot has none.
        const items = bot.inventory.items();
        const sticks = items.find((i) => i.name === 'stick');
        if (!sticks || sticks.count < 2 * invocations) {
          return {
            ok: true,
            missing: [{ name: 'stick', short: 2 * invocations - (sticks?.count || 0) }],
          };
        }
        return { ok: true, missing: [] };
      },
      bestRecipeForInventory: (recipes) => recipes[0],
    },
    getActions: () => allActions,
  });
  const r = await crafting.craft({ item: 'iron_sword', count: 1 });
  // The auto-fetch should fire; after withdraw the re-planned check
  // should pass and craft should proceed. Final ok is contract-dependent;
  // what matters is that chest_search + withdraw were called.
  assert.equal(chestSearchCalls.length, 1, 'chest_search must be called once');
  assert.equal(chestSearchCalls[0], 'stick');
  assert.equal(withdrawCalls.length, 1, 'withdraw must be called once');
  assert.equal(withdrawCalls[0].x, 5);
  assert.deepEqual(withdrawCalls[0].items, [{ item: 'stick', count: 2 }]);
});

test('mc craft: ingredients sufficient → does NOT call chest_search', async () => {
  // Bot already has plenty of sticks; the auto-fetch path must short-circuit.
  let chestSearchCalls = 0;
  const fakeRecipe = {
    result: { id: 100, count: 1 },
    inShape: [[null, { id: 50, metadata: 0 }, null]],
    ingredients: null,
    requiresTable: false,
  };
  const mcData = {
    itemsByName: { stick: { id: 50, name: 'stick' }, iron_sword: { id: 100, name: 'iron_sword' } },
    blocksByName: { crafting_table: { id: 200, name: 'crafting_table' } },
  };
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [{ name: 'stick', count: 64 }] },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    findBlock: () => null,
    recipesFor: () => [fakeRecipe],
    recipesAll: () => [fakeRecipe],
    craft: async () => {},
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    lookAt: async () => {},
  };
  const services = createMockServices();
  services.state.world.mcData = mcData;
  services.state.world.bot = bot;
  services.state.world.botReady = true;
  const allActions = {
    chest_search: async () => { chestSearchCalls++; return ok({ data: { matches: [] } }); },
    withdraw: async () => ok({ data: {} }),
  };
  const crafting = createCraftingActions({
    state: services.state,
    ensureBot: () => bot,
    utils: { sleep: () => Promise.resolve(), log: () => {} },
    social: { getMyName: () => 'TestSteve' },
    locations: { load: () => ({}), save: () => {} },
    craft: {
      resolveCraftItemName: (raw) => raw,
      buildCraftPlan: () => ({ ok: true, missing: [] }), // nothing missing
      bestRecipeForInventory: (recipes) => recipes[0],
    },
    getActions: () => allActions,
  });
  await crafting.craft({ item: 'iron_sword', count: 1 });
  assert.equal(chestSearchCalls, 0, 'chest_search must not fire when ingredients are sufficient');
});
