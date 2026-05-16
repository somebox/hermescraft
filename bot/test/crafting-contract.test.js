/**
 * Phase 2 — contract conformance for actions/crafting.js.
 *
 * Drives each crafting handler through representative failure paths using
 * createMockServices() (no real Mineflayer bot required). Every result must
 * pass validate() and use one of the documented error codes from
 * docs/phase-2/action-contracts.md (plus a few crafting-specific codes
 * declared below).
 *
 * Existing bot/test/crafting.test.js covers the recipe-ingredients pure
 * helpers; this file complements it by exercising the action handlers'
 * return shapes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validate } from '../lib/shared/action-contract.js';
import { createMockServices } from '../lib/server/mock-services.js';
import { createCraftingActions } from '../lib/actions/crafting.js';

/** Codes the migrated crafting.js may return — keep in sync with handler bodies. */
const KNOWN_CODES = new Set([
  'UNKNOWN_ITEM',
  'NO_RECIPE',
  'TABLE_REQUIRED',
  'TABLE_OUT_OF_RANGE',
  'MISSING_INGREDIENTS',
  'INTERRUPTED',
  'PLAN_FAILED',
  'UNKNOWN_CATEGORY',
  'NO_FURNACE',
  'NO_INPUT',
  'NO_FUEL',
  'NOT_SMELTABLE',
  'OPERATION_TIMEOUT',
]);

/** Minimal mineflayer-bot stub that crafting.js's handlers will read from.
 *  Each test customises specific methods; defaults are conservative no-ops. */
function makeMockBot(overrides = {}) {
  const inventory = {
    items: () => overrides.inventoryItems || [],
  };
  const entity = {
    position: { x: 0, y: 64, z: 0, distanceTo: () => 0 },
  };
  const bot = {
    inventory,
    entity,
    heldItem: null,
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    findBlock: () => null,
    recipesFor: () => [],
    recipesAll: () => [],
    craft: async () => {},
    lookAt: async () => {},
    openFurnace: async () => { throw new Error('mock: no furnace'); },
    stopDigging: () => {},
    closeWindow: () => {},
    ...overrides.bot,
  };
  return bot;
}

/** Build crafting actions wired against a mock services container.
 *  `botOverrides` injects bot behaviour for the specific failure being tested. */
function buildCrafting(botOverrides = {}, servicesOverrides = {}) {
  const mockBot = makeMockBot(botOverrides);
  const services = createMockServices({
    state: {
      world: {
        botReady: true,
        mcData: {
          itemsByName: { stick: { id: 280 } },
          blocksByName: { crafting_table: { id: 58 } },
        },
        bot: mockBot,
      },
    },
    ensureBot: () => mockBot,
    craft: {
      // Tests opt-in by overriding these via servicesOverrides.craft.
      resolveCraftItemName: (raw) => raw,
      buildCraftPlan: () => ({ ok: true, missing: [] }),
      bestRecipeForInventory: (recipes) => (recipes && recipes[0]) || null,
    },
    ...servicesOverrides,
  });
  return { services, mockBot, actions: createCraftingActions(services) };
}

/** Assert every result conforms to the action contract AND uses a known code. */
function assertContract(result) {
  const v = validate(result);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  if (result.ok === false) {
    assert.ok(
      KNOWN_CODES.has(result.error.code),
      `error.code "${result.error.code}" is not in KNOWN_CODES — add it or fix the handler`,
    );
  }
}

// ── craft ────────────────────────────────────────────────────────────────

test('craft: UNKNOWN_ITEM when resolveCraftItemName throws', async () => {
  const { actions } = buildCrafting({}, {
    craft: {
      resolveCraftItemName: () => { throw new Error('unknown craft target'); },
      buildCraftPlan: () => ({ ok: true, missing: [] }),
      bestRecipeForInventory: (r) => r[0] || null,
    },
  });
  const r = await actions.craft({ item: 'nether_star' });
  assertContract(r);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UNKNOWN_ITEM');
  assert.equal(r.error.observed_state.requested_item, 'nether_star');
});

test('craft: UNKNOWN_ITEM when itemsByName has no entry', async () => {
  const { actions } = buildCrafting({}, {
    state: { world: { mcData: { itemsByName: {}, blocksByName: {} } } },
    craft: {
      resolveCraftItemName: (raw) => raw,
      buildCraftPlan: () => ({ ok: true, missing: [] }),
      bestRecipeForInventory: (r) => r[0] || null,
    },
  });
  const r = await actions.craft({ item: 'foobar' });
  assertContract(r);
  assert.equal(r.error.code, 'UNKNOWN_ITEM');
});

test('craft: NO_RECIPE when recipesAll returns empty', async () => {
  const { actions } = buildCrafting({
    bot: {
      recipesFor: () => [],
      recipesAll: () => [],
    },
  });
  const r = await actions.craft({ item: 'stick' });
  assertContract(r);
  assert.equal(r.error.code, 'NO_RECIPE');
});

test('craft: TABLE_REQUIRED when bench needed and no table nearby', async () => {
  const recipe = { requiresTable: true, result: { count: 4 } };
  const { actions } = buildCrafting({
    bot: {
      recipesFor: () => [],
      recipesAll: () => [recipe],
      findBlock: () => null, // no table nearby AND no wide-scan hit
    },
  });
  const r = await actions.craft({ item: 'stick' });
  assertContract(r);
  assert.equal(r.error.code, 'TABLE_REQUIRED');
  assert.equal(r.error.retry_safe, false);
  assert.match(r.error.next_action_hint, /place a crafting_table|mc place/i);
});

test('craft: MISSING_INGREDIENTS surfaces shortfall from buildCraftPlan', async () => {
  const recipe = { requiresTable: false, result: { count: 1 } };
  const { actions } = buildCrafting({
    bot: {
      recipesFor: () => [recipe],
      recipesAll: () => [recipe],
    },
  }, {
    craft: {
      resolveCraftItemName: (raw) => raw,
      buildCraftPlan: () => ({
        ok: true,
        missing: [{ name: 'oak_planks', short: 2 }],
      }),
      bestRecipeForInventory: (r) => r[0],
    },
  });
  const r = await actions.craft({ item: 'stick', count: 4 });
  assertContract(r);
  assert.equal(r.error.code, 'MISSING_INGREDIENTS');
  assert.deepEqual(r.error.observed_state.missing, [{ name: 'oak_planks', short: 2 }]);
});

test('craft: reason= flows through to data._reason on success', async () => {
  // Force a success path: bot.craft succeeds + inventory shows positive delta.
  let inv = [];
  const recipe = { requiresTable: false, result: { count: 4 } };
  const mockBot = makeMockBot({
    bot: {
      recipesFor: () => [recipe],
      recipesAll: () => [recipe],
      craft: async () => { inv = [{ name: 'stick', count: 4 }]; },
      inventory: { items: () => inv.slice() }, // separate snapshot semantics
    },
  });
  // Replace inventory.items with one that returns the live `inv` array each call.
  mockBot.inventory.items = () => inv.slice();
  const services = createMockServices({
    state: {
      world: {
        botReady: true,
        mcData: {
          itemsByName: { stick: { id: 280 } },
          blocksByName: { crafting_table: { id: 58 } },
        },
        bot: mockBot,
      },
    },
    ensureBot: () => mockBot,
    utils: { sleep: async () => {} },
    craft: {
      resolveCraftItemName: (raw) => raw,
      buildCraftPlan: () => ({ ok: true, missing: [] }),
      bestRecipeForInventory: (r) => r[0],
    },
  });
  const actions = createCraftingActions(services);
  const r = await actions.craft({ item: 'stick', count: 4, reason: 'building shelter' });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data._reason, 'building shelter');
  assert.equal(r.data.crafted_count, 4);
});

// ── recipes ──────────────────────────────────────────────────────────────

test('recipes: UNKNOWN_ITEM when resolver throws', async () => {
  const { actions } = buildCrafting({}, {
    craft: {
      resolveCraftItemName: () => { throw new Error('unknown'); },
      buildCraftPlan: () => ({ ok: true, missing: [] }),
      bestRecipeForInventory: (r) => r[0],
    },
  });
  const r = await actions.recipes({ item: 'foo' });
  assertContract(r);
  assert.equal(r.error.code, 'UNKNOWN_ITEM');
});

test('recipes: ok with empty list when no recipe found', async () => {
  const { actions } = buildCrafting();
  const r = await actions.recipes({ item: 'stick', reason: 'curious' });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.deepEqual(r.recipes, []);
  assert.equal(r.data._reason, 'curious');
});

test('recipes: ok with formatted list when recipes exist', async () => {
  const recipe = {
    requiresTable: false,
    result: { count: 4 },
    inShape: [[{ id: 17 }]],
  };
  const { actions } = buildCrafting({
    bot: {
      recipesFor: () => [recipe],
      recipesAll: () => [recipe],
    },
  });
  const r = await actions.recipes({ item: 'stick' });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.recipes.length, 1);
  assert.equal(r.recipes[0].makes, 4);
});

// ── craft_plan ───────────────────────────────────────────────────────────

test('craft_plan: UNKNOWN_ITEM when resolver throws', async () => {
  const { actions } = buildCrafting({}, {
    craft: {
      resolveCraftItemName: () => { throw new Error('bad'); },
      buildCraftPlan: () => ({ ok: true }),
      bestRecipeForInventory: (r) => r[0],
    },
  });
  const r = await actions.craft_plan({ item: 'foo' });
  assertContract(r);
  assert.equal(r.error.code, 'UNKNOWN_ITEM');
});

test('craft_plan: PLAN_FAILED when buildCraftPlan returns ok=false', async () => {
  const { actions } = buildCrafting({}, {
    craft: {
      resolveCraftItemName: (raw) => raw,
      buildCraftPlan: () => ({ ok: false, error: 'no such recipe' }),
      bestRecipeForInventory: (r) => r[0],
    },
  });
  const r = await actions.craft_plan({ item: 'foo' });
  assertContract(r);
  assert.equal(r.error.code, 'PLAN_FAILED');
});

test('craft_plan: ok with plan summary on success', async () => {
  const { actions } = buildCrafting({}, {
    craft: {
      resolveCraftItemName: (raw) => raw,
      buildCraftPlan: () => ({
        ok: true,
        item: 'stick',
        count: 4,
        missing: [{ name: 'oak_planks', short: 2 }],
      }),
      bestRecipeForInventory: (r) => r[0],
    },
  });
  const r = await actions.craft_plan({ item: 'stick', count: 4, reason: 'inventory plan' });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.craft_plan.item, 'stick');
  assert.equal(r.data._reason, 'inventory plan');
});

// ── discover ─────────────────────────────────────────────────────────────

test('discover: UNKNOWN_CATEGORY for an unknown category', async () => {
  const { actions } = buildCrafting();
  const r = await actions.discover({ category: 'unobtainium' });
  assertContract(r);
  assert.equal(r.error.code, 'UNKNOWN_CATEGORY');
  assert.ok(Array.isArray(r.error.observed_state.valid_categories));
});

test('discover: ok with empty blocks when find_blocks returns nothing', async () => {
  // Need to inject a getActions that exposes find_blocks/find_entities stubs.
  const services = createMockServices({
    state: {
      world: {
        botReady: true,
        mcData: { itemsByName: {}, blocksByName: {} },
        bot: makeMockBot(),
      },
      goals: { chestSnapshots: {} },
    },
    ensureBot: () => makeMockBot(),
    getActions: () => ({
      find_blocks: async () => ({ locations: [] }),
      find_entities: async () => ({ entities: [], locations: [] }),
    }),
    craft: {
      resolveCraftItemName: (raw) => raw,
      buildCraftPlan: () => ({ ok: true, missing: [] }),
      bestRecipeForInventory: (r) => r[0],
    },
  });
  const actions = createCraftingActions(services);
  const r = await actions.discover({ category: 'logs', reason: 'wood scout' });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.discover.blocks.length, 0);
  assert.equal(r.data._reason, 'wood scout');
});

// smelt was moved out of crafting.js into furnace.js in Phase 5.
// See bot/test/furnace-contract.test.js for the smelt contract tests.
