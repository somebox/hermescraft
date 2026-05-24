import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recipeIngredientMap,
  bestRecipeForInventory,
  buildCraftPlanFromRecipes,
} from '../lib/shared/recipe-ingredients.js';

// --- Helpers ---

const mcData = {
  items: {
    1: { name: 'oak_planks' },
    2: { name: 'stick' },
    3: { name: 'iron_ingot' },
    4: { name: 'pale_oak_planks' },
    5: { name: 'birch_planks' },
    6: { name: 'cobblestone' },
  },
};

function slot(id) {
  return { id: { id, metadata: null, count: 1 } };
}

function shapedRecipe(inShape, opts = {}) {
  return { inShape, requiresTable: true, result: { count: opts.resultCount || 1 }, ...opts };
}

function shapelessRecipe(ingredients, opts = {}) {
  return { ingredients, requiresTable: false, result: { count: opts.resultCount || 4 }, ...opts };
}

function inv(...entries) {
  return entries.map(([name, count]) => ({ name, count }));
}

// --- recipeIngredientMap ---

test('recipeIngredientMap: shaped recipe extracts correct counts', () => {
  const recipe = shapedRecipe([
    [slot(1), slot(1)],
    [slot(1), slot(1)],
  ]);
  const ings = recipeIngredientMap(recipe, mcData);
  assert.deepEqual(ings, { oak_planks: 4 });
});

test('recipeIngredientMap: shapeless recipe', () => {
  const recipe = shapelessRecipe([[slot(1), slot(2)]]);
  const ings = recipeIngredientMap(recipe, mcData);
  assert.deepEqual(ings, { oak_planks: 1, stick: 1 });
});

test('recipeIngredientMap: mixed ingredients are counted correctly', () => {
  const recipe = shapedRecipe([
    [slot(3), slot(3), slot(3)],
    [null, slot(2), null],
    [null, slot(2), null],
  ]);
  const ings = recipeIngredientMap(recipe, mcData);
  assert.deepEqual(ings, { iron_ingot: 3, stick: 2 });
});

test('recipeIngredientMap: empty recipe returns empty map', () => {
  const recipe = { inShape: [], result: { count: 1 } };
  const ings = recipeIngredientMap(recipe, mcData);
  assert.deepEqual(ings, {});
});

// --- bestRecipeForInventory ---

test('bestRecipeForInventory: returns null for empty array', () => {
  assert.equal(bestRecipeForInventory([], [], 1, mcData), null);
});

test('bestRecipeForInventory: returns sole recipe for single-element array', () => {
  const r = shapedRecipe([[slot(1)]]);
  assert.equal(bestRecipeForInventory([r], [], 1, mcData), r);
});

test('bestRecipeForInventory: picks recipe matching inventory', () => {
  const oakRecipe = shapedRecipe([[slot(1), slot(1)]]);
  const paleRecipe = shapedRecipe([[slot(4), slot(4)]]);

  const items = inv(['oak_planks', 10]);
  const result = bestRecipeForInventory([paleRecipe, oakRecipe], items, 1, mcData);
  assert.equal(result, oakRecipe);
});

test('bestRecipeForInventory: picks pale_oak recipe when pale_oak_planks available', () => {
  const oakRecipe = shapedRecipe([[slot(1), slot(1)]]);
  const paleRecipe = shapedRecipe([[slot(4), slot(4)]]);

  const items = inv(['pale_oak_planks', 10]);
  const result = bestRecipeForInventory([oakRecipe, paleRecipe], items, 1, mcData);
  assert.equal(result, paleRecipe);
});

test('bestRecipeForInventory: log-to-plank inference favors craftable variant', () => {
  const oakRecipe = shapedRecipe([[slot(1), slot(1)]]);
  const paleRecipe = shapedRecipe([[slot(4), slot(4)]]);

  const items = inv(['oak_log', 3]);
  const result = bestRecipeForInventory([paleRecipe, oakRecipe], items, 1, mcData);
  assert.equal(result, oakRecipe, 'should pick oak variant since oak_log is available');
});

test('bestRecipeForInventory: considers wantCount when scoring', () => {
  const oakRecipe = shapedRecipe([[slot(1), slot(1)]]);
  const paleRecipe = shapedRecipe([[slot(4), slot(4)]]);

  const items = inv(['oak_planks', 2], ['pale_oak_planks', 20]);
  const result = bestRecipeForInventory([oakRecipe, paleRecipe], items, 5, mcData);
  assert.equal(result, paleRecipe, 'should prefer pale_oak because oak_planks are insufficient for 5 crafts');
});

test('bestRecipeForInventory: empty inventory falls back to first recipe', () => {
  const r1 = shapedRecipe([[slot(1)]]);
  const r2 = shapedRecipe([[slot(4)]]);
  const result = bestRecipeForInventory([r1, r2], [], 1, mcData);
  assert.equal(result, r1, 'with no inventory all recipes score equally, first wins');
});

test('bestRecipeForInventory: multiple log types, picks best match', () => {
  const oakRecipe = shapedRecipe([[slot(1), slot(1)]]);
  const birchRecipe = shapedRecipe([[slot(5), slot(5)]]);

  const items = inv(['birch_log', 5]);
  const result = bestRecipeForInventory([oakRecipe, birchRecipe], items, 1, mcData);
  assert.equal(result, birchRecipe, 'should pick birch variant from birch_log');
});

// --- buildCraftPlanFromRecipes ---

test('buildCraftPlanFromRecipes: returns error for null recipes', () => {
  const plan = buildCraftPlanFromRecipes({
    recipes: null, invItems: [], mcData, chestSnapshots: {},
    itemName: 'stick', wantCount: 1,
  });
  assert.equal(plan.ok, false);
  assert.match(plan.error, /No recipe/);
});

test('buildCraftPlanFromRecipes: all ingredients available => no missing', () => {
  const recipe = shapedRecipe([[slot(1), slot(1)]]);
  const items = inv(['oak_planks', 10]);

  const plan = buildCraftPlanFromRecipes({
    recipes: [recipe], invItems: items, mcData, chestSnapshots: {},
    itemName: 'stick', wantCount: 1,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.missing.length, 0);
  assert.deepEqual(plan.have, { oak_planks: 10 });
});

test('buildCraftPlanFromRecipes: missing ingredients reported with counts', () => {
  const recipe = shapedRecipe([
    [slot(3), slot(3), slot(3)],
    [null, slot(2), null],
    [null, slot(2), null],
  ]);
  const items = inv(['iron_ingot', 1]);

  const plan = buildCraftPlanFromRecipes({
    recipes: [recipe], invItems: items, mcData, chestSnapshots: {},
    itemName: 'iron_pickaxe', wantCount: 1,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.missing.length, 2);

  const ironMissing = plan.missing.find(m => m.name === 'iron_ingot');
  assert.ok(ironMissing);
  assert.equal(ironMissing.need, 3);
  assert.equal(ironMissing.have, 1);
  assert.equal(ironMissing.short, 2);

  const stickMissing = plan.missing.find(m => m.name === 'stick');
  assert.ok(stickMissing);
  assert.equal(stickMissing.need, 2);
  assert.equal(stickMissing.have, 0);
  assert.equal(stickMissing.short, 2);
});

test('buildCraftPlanFromRecipes: wantCount multiplies requirements', () => {
  const recipe = shapedRecipe([[slot(1), slot(1)]]);
  const items = inv(['oak_planks', 3]);

  const plan = buildCraftPlanFromRecipes({
    recipes: [recipe], invItems: items, mcData, chestSnapshots: {},
    itemName: 'stick', wantCount: 4,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.count, 4);

  const m = plan.missing.find(e => e.name === 'oak_planks');
  assert.ok(m);
  assert.equal(m.need, 8);
  assert.equal(m.have, 3);
  assert.equal(m.short, 5);
});

test('buildCraftPlanFromRecipes: chest contents appear in missing entries', () => {
  const recipe = shapedRecipe([[slot(3), slot(3), slot(3)]]);
  const items = inv(['iron_ingot', 1]);
  const chestSnapshots = {
    'storage-1': { items: [{ name: 'iron_ingot', count: 5 }] },
    'storage-2': { items: [{ name: 'iron_ingot', count: 3 }, { name: 'gold_ingot', count: 2 }] },
  };

  const plan = buildCraftPlanFromRecipes({
    recipes: [recipe], invItems: items, mcData, chestSnapshots,
    itemName: 'iron_pickaxe', wantCount: 1,
  });
  assert.equal(plan.ok, true);
  const ironMissing = plan.missing.find(m => m.name === 'iron_ingot');
  assert.ok(ironMissing);
  assert.equal(ironMissing.in_chests, 8);
  assert.deepEqual(ironMissing.chest_locations.sort(), ['storage-1', 'storage-2']);
});

test('buildCraftPlanFromRecipes: in_chests summary included for relevant ingredients', () => {
  const recipe = shapedRecipe([[slot(6)]]);
  const items = inv(['cobblestone', 10]);
  const chestSnapshots = {
    'base': { items: [{ name: 'cobblestone', count: 50 }] },
  };

  const plan = buildCraftPlanFromRecipes({
    recipes: [recipe], invItems: items, mcData, chestSnapshots,
    itemName: 'stone_slab', wantCount: 1,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.missing.length, 0);
  assert.ok(plan.in_chests);
  assert.equal(plan.in_chests.cobblestone.count, 50);
});

test('buildCraftPlanFromRecipes: selects best recipe variant automatically', () => {
  const oakRecipe = shapedRecipe([[slot(1), slot(1)]]);
  const paleRecipe = shapedRecipe([[slot(4), slot(4)]]);
  const items = inv(['oak_planks', 4]);

  const plan = buildCraftPlanFromRecipes({
    recipes: [paleRecipe, oakRecipe], invItems: items, mcData, chestSnapshots: {},
    itemName: 'stick', wantCount: 1,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.missing.length, 0);
  assert.ok(plan.ingredients.oak_planks, 'should pick the oak_planks recipe variant');
});

test('buildCraftPlanFromRecipes: needs_table reflects recipe', () => {
  const tableRecipe = shapedRecipe([[slot(1)]], { requiresTable: true });
  const handRecipe = shapelessRecipe([[slot(1)]], { requiresTable: false });

  const plan1 = buildCraftPlanFromRecipes({
    recipes: [tableRecipe], invItems: inv(['oak_planks', 5]), mcData,
    chestSnapshots: {}, itemName: 'x', wantCount: 1,
  });
  assert.equal(plan1.needs_table, true);

  const plan2 = buildCraftPlanFromRecipes({
    recipes: [handRecipe], invItems: inv(['oak_planks', 5]), mcData,
    chestSnapshots: {}, itemName: 'x', wantCount: 1,
  });
  assert.equal(plan2.needs_table, false);
});

// A stone-tool recipe canonically lists `cobbled_deepslate` (mineflayer's
// flattened representation of `#minecraft:stone_crafting_materials`), but
// cobblestone satisfies it. Missing entries should surface the friendlier
// `cobblestone` to the agent, with `recipe_canonical` + `equivalents` for
// callers that need the canonical form.
test('buildCraftPlanFromRecipes: tagged ingredient surfaces preferred variant in missing', () => {
  const mcDataStone = {
    items: {
      ...mcData.items,
      7: { name: 'cobbled_deepslate' },
      8: { name: 'stick' },
    },
  };
  // Stone pickaxe shape: 3 stone in top row, sticks vertical
  const stoneRecipe = shapedRecipe([
    [slot(7), slot(7), slot(7)],
    [null, slot(8), null],
    [null, slot(8), null],
  ]);
  // Bot has 2 cobblestone (overworld variant), no sticks, no deepslate
  const items = inv(['cobblestone', 2]);

  const plan = buildCraftPlanFromRecipes({
    recipes: [stoneRecipe], invItems: items, mcData: mcDataStone,
    chestSnapshots: {}, itemName: 'stone_pickaxe', wantCount: 1,
  });
  assert.equal(plan.ok, true);

  const stoneMissing = plan.missing.find(m => m.name === 'cobblestone');
  assert.ok(stoneMissing, 'missing entry should use cobblestone, not cobbled_deepslate');
  assert.equal(stoneMissing.need, 3);
  assert.equal(stoneMissing.have, 2, 'cobblestone in inventory counts toward the tag');
  assert.equal(stoneMissing.short, 1);
  assert.equal(stoneMissing.recipe_canonical, 'cobbled_deepslate');
  assert.deepEqual(stoneMissing.equivalents, ['cobblestone', 'cobbled_deepslate', 'blackstone']);

  // No stale cobbled_deepslate entry — that would re-introduce the bug
  assert.equal(
    plan.missing.find(m => m.name === 'cobbled_deepslate'),
    undefined,
    'should not surface cobbled_deepslate as the missing name',
  );
});
