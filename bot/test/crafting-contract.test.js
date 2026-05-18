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
  'CRAFT_NO_OP',
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

test('craft: #86 delta=0 with missing ingredients → MISSING_INGREDIENTS with shortfall', async () => {
  // Setup: bot.craft "succeeds" (no throw) but inventory stays empty.
  // Materials are missing — the new #86 branch should report what's short.
  const recipe = {
    requiresTable: true,
    result: { count: 1 },
    // 3 cobblestone in top row of crafting grid, 2 sticks in column
    inShape: [
      [{ id: 4 }, { id: 4 }, { id: 4 }],
      [null, { id: 280 }, null],
      [null, { id: 280 }, null],
    ],
  };
  const mockBot = makeMockBot({
    inventoryItems: [], // empty — nothing to consume
    bot: {
      recipesFor: () => [recipe],
      recipesAll: () => [recipe],
      craft: async () => {}, // no-op; doesn't throw, doesn't modify inventory
      findBlock: () => ({ position: { x: 0, y: 64, z: 0 }, name: 'crafting_table' }),
    },
  });
  const services = createMockServices({
    state: {
      world: {
        botReady: true,
        mcData: {
          itemsByName: { stone_pickaxe: { id: 274 } },
          blocksByName: {
            crafting_table: { id: 58 },
            cobblestone: { id: 4 },
            stick: { id: 280 },
          },
          // resolveRecipeIngredientName reads items[id].name to resolve numeric ids in recipe.inShape
          items: { 4: { name: 'cobblestone' }, 280: { name: 'stick' } },
        },
        bot: mockBot,
      },
    },
    ensureBot: () => mockBot,
    utils: { sleep: async () => {} },
    craft: {
      resolveCraftItemName: (raw) => raw,
      // buildCraftPlan stub passes pre-flight (so we reach the delta=0 branch)
      buildCraftPlan: () => ({ ok: true, missing: [] }),
      bestRecipeForInventory: (r) => r[0],
    },
  });
  const actions = createCraftingActions(services);
  const r = await actions.craft({ item: 'stone_pickaxe', count: 1 });
  assertContract(r);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'MISSING_INGREDIENTS');
  assert.match(r.error.message, /missing.*cobblestone.*stick|stick.*cobblestone/);
  // Shortfall struct present
  const m = r.error.observed_state.missing;
  assert.equal(m.length, 2);
  assert.deepEqual(m.map((x) => x.name).sort(), ['cobblestone', 'stick']);
  assert.equal(m.find((x) => x.name === 'cobblestone').short, 3);
  assert.equal(m.find((x) => x.name === 'stick').short, 2);
});

test('craft: #86 delta=0 with materials intact (no fallback) → CRAFT_NO_OP', async () => {
  // Setup: materials ARE present, bot.craft "succeeds" but inventory doesn't change.
  // No PaperMCP configured, so server-side fallback is skipped.
  // Classic Paper-1.21 craft race condition.
  const recipe = {
    requiresTable: true,
    result: { count: 1 },
    inShape: [[{ id: 4 }]],
  };
  const inv = [{ name: 'cobblestone', count: 8, type: 4 }];
  const mockBot = makeMockBot({
    inventoryItems: inv,
    bot: {
      recipesFor: () => [recipe],
      recipesAll: () => [recipe],
      craft: async () => {}, // no-op
      findBlock: () => ({ position: { x: 0, y: 64, z: 0 }, name: 'crafting_table' }),
    },
  });
  mockBot.inventory.items = () => inv.slice();
  const services = createMockServices({
    state: {
      world: {
        botReady: true,
        mcData: {
          itemsByName: { stone: { id: 1 } },
          blocksByName: { crafting_table: { id: 58 }, cobblestone: { id: 4 } },
          items: { 4: { name: 'cobblestone' } },
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
  const r = await actions.craft({ item: 'stone', count: 1 });
  assertContract(r);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'CRAFT_NO_OP');
  assert.match(r.error.message, /materials present.*mineflayer.craft did not deliver/);
  assert.equal(r.error.retry_safe, true);
  // ingredients_status carries the diagnostic
  const status = r.error.observed_state.ingredients_status;
  assert.equal(status.length, 1);
  assert.equal(status[0].have, 8);
  assert.equal(status[0].need, 1);
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

// #100: auto-mark crafting table — exposed via services.autoMarkCraftingTable.

test('createCraftingActions wires services.autoMarkCraftingTable', () => {
  const services = createMockServices();
  createCraftingActions(services);
  assert.equal(typeof services.autoMarkCraftingTable, 'function');
});

test('autoMarkCraftingTable: saves a craft_table_<X>_<Y>_<Z> mark', () => {
  const services = createMockServices();
  createCraftingActions(services);
  const ok = services.autoMarkCraftingTable({ x: 100, y: 64, z: -50 });
  assert.equal(ok, true);
  const locs = services.locations.load();
  const expected = 'craft_table_100_64_-50';
  assert.ok(locs[expected], `expected mark ${expected} in locs`);
  assert.equal(locs[expected].note, 'crafting_table (auto-marked)');
  assert.equal(locs[expected].category, 'auto');
});

test('autoMarkCraftingTable: idempotent within 3 blocks of an existing craft mark', () => {
  const services = createMockServices();
  createCraftingActions(services);
  services.autoMarkCraftingTable({ x: 100, y: 64, z: -50 });
  // Second call within 3 blocks should not create a new mark.
  const ok = services.autoMarkCraftingTable({ x: 101, y: 64, z: -50 });
  assert.equal(ok, false);
  const locs = services.locations.load();
  const craftMarks = Object.keys(locs).filter(n => /craft/i.test(n));
  assert.equal(craftMarks.length, 1);
});

test('autoMarkCraftingTable: separate table >3 blocks away IS marked', () => {
  const services = createMockServices();
  createCraftingActions(services);
  services.autoMarkCraftingTable({ x: 100, y: 64, z: -50 });
  const ok = services.autoMarkCraftingTable({ x: 200, y: 64, z: 200 });
  assert.equal(ok, true);
  const locs = services.locations.load();
  const craftMarks = Object.keys(locs).filter(n => /craft/i.test(n));
  assert.equal(craftMarks.length, 2);
});
