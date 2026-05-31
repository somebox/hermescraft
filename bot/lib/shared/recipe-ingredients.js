export function resolveRecipeIngredientName(entry, mcData, depth = 0) {
  if (entry == null || entry === -1 || depth > 4) return null;
  if (typeof entry === 'number') return mcData?.items?.[entry]?.name || `id:${entry}`;
  if (typeof entry === 'string') return entry;
  if (typeof entry !== 'object') return String(entry);
  if (typeof entry.name === 'string' && entry.name.trim()) return entry.name;

  const nested = entry.id ?? entry.type ?? entry.itemId ?? entry.item ?? entry.itemType ?? entry.value;
  if (nested != null) {
    const resolved = resolveRecipeIngredientName(nested, mcData, depth + 1);
    if (resolved) return resolved;
    return null;
  }

  if (typeof entry.block === 'object' || typeof entry.itemstack === 'object') {
    const resolved = resolveRecipeIngredientName(entry.block || entry.itemstack, mcData, depth + 1);
    if (resolved) return resolved;
  }

  try {
    return JSON.stringify(entry);
  } catch {
    return String(entry);
  }
}

export function recipeIngredientQty(entry) {
  if (entry && typeof entry === 'object' && Number.isFinite(entry.count) && entry.count > 0) {
    return entry.count;
  }
  return 1;
}

export function ingredientCountsFromSlots(slots, mcData, multiplier = 1) {
  const counts = {};
  for (const entry of slots || []) {
    const name = resolveRecipeIngredientName(entry, mcData);
    if (!name) continue;
    counts[name] = (counts[name] || 0) + recipeIngredientQty(entry) * multiplier;
  }
  return counts;
}

/**
 * Extract ingredient counts from a single recipe.
 * @param {object} recipe  Mineflayer recipe object
 * @param {object} mcData  minecraft-data instance
 */
export function recipeIngredientMap(recipe, mcData) {
  const slots = recipe.inShape ? recipe.inShape.flat() : recipe.ingredients?.flat() || [];
  return ingredientCountsFromSlots(slots, mcData, 1);
}

const LOG_TO_PLANKS = {
  oak_log: 'oak_planks', birch_log: 'birch_planks', spruce_log: 'spruce_planks',
  dark_oak_log: 'dark_oak_planks', acacia_log: 'acacia_planks', jungle_log: 'jungle_planks',
  mangrove_log: 'mangrove_planks', cherry_log: 'cherry_planks', pale_oak_log: 'pale_oak_planks',
  crimson_stem: 'crimson_planks', warped_stem: 'warped_planks',
};

/**
 * Minecraft 1.21 recipe ingredient tags — mineflayer flattens these to a
 * single canonical ingredient (often the "newest" variant), so a stone tool
 * recipe lists cobbled_deepslate even though the server accepts ANY item
 * from `#minecraft:stone_crafting_materials`. Without this map, a bot
 * with plain cobblestone gets MISSING_INGREDIENTS for stone_pickaxe even
 * though the actual craft would succeed.
 *
 * Map: canonical-ingredient → list of items that satisfy it.
 */
const INGREDIENT_TAG_EQUIVALENTS = {
  // #minecraft:stone_crafting_materials — stone tools, furnace.
  // (We deliberately do NOT include #minecraft:planks here even though
  // it's a real tag in 1.21+ — bestRecipeForInventory relies on plank
  // types being distinct so it can pick the correct plank-specific
  // recipe variant. Adding planks here breaks that tiebreak. The
  // missing-plank case is rare in practice; stone-tools is what hit
  // us in G20.)
  cobbled_deepslate: ['cobblestone', 'cobbled_deepslate', 'blackstone'],
  cobblestone:       ['cobblestone', 'cobbled_deepslate', 'blackstone'],
  blackstone:        ['cobblestone', 'cobbled_deepslate', 'blackstone'],
};

/** Sum inventory counts that satisfy a (possibly tagged) recipe ingredient. */
function countSatisfying(name, invItems) {
  const equivalents = INGREDIENT_TAG_EQUIVALENTS[name] || [name];
  return invItems
    .filter(i => equivalents.includes(i.name))
    .reduce((s, i) => s + i.count, 0);
}

/**
 * For a tagged ingredient, return the variant the agent should prefer to obtain.
 * Surfacing `cobbled_deepslate` to the agent when `cobblestone` would do is
 * misleading — the agent goes mining deepslate when the recipe accepts the
 * overworld block they already know how to get. Use the first entry of the
 * tag-equivalence list as the preferred name (curated by overworld availability).
 */
function preferredVariantName(name) {
  const equivalents = INGREDIENT_TAG_EQUIVALENTS[name];
  if (!equivalents || !equivalents.length) return name;
  return equivalents[0];
}

/**
 * Pick the recipe variant whose ingredients best match what's available.
 * When no variant has direct ingredients, applies a tiebreaker for plank
 * types based on logs in inventory (log → 4 planks).
 *
 * @param {object[]} recipes    Array of Mineflayer recipe objects
 * @param {object[]} invItems   Array of { name, count } from bot.inventory.items()
 * @param {number}   wantCount  Desired craft count
 * @param {object}   mcData     minecraft-data instance
 */
export function bestRecipeForInventory(recipes, invItems, wantCount, mcData) {
  if (!recipes || recipes.length <= 1) return recipes?.[0] || null;
  // countSatisfying expands the ingredient name through INGREDIENT_TAG_EQUIVALENTS
  // so cobblestone counts toward a cobbled_deepslate requirement (stone tools).
  const countHave = (n) => countSatisfying(n, invItems);

  const plankFromLog = {};
  for (const [log, plank] of Object.entries(LOG_TO_PLANKS)) {
    const logCount = invItems
      .filter(i => i.name === log)
      .reduce((s, i) => s + i.count, 0);
    if (logCount > 0) plankFromLog[plank] = logCount * 4;
  }

  let best = recipes[0];
  let bestScore = -Infinity;
  for (const r of recipes) {
    const ings = recipeIngredientMap(r, mcData);
    let score = 0;
    for (const [name, perCraft] of Object.entries(ings)) {
      const need = perCraft * wantCount;
      const have = countHave(name);
      const craftable = plankFromLog[name] || 0;
      const available = have + craftable;
      score += Math.min(available, need);
      if (available >= need) score += 1000;
    }
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
}

export function pickRecipeFromRecipes(recipes, invItems, count, mcData) {
  if (!recipes?.length) {
    return { recipe: null, invocations: 0 };
  }
  let best = recipes[0];
  let bestScore = -Infinity;
  for (const r of recipes) {
    const yieldEach = r.result?.count || 1;
    const invocations = Math.max(1, Math.ceil(count / yieldEach));
    const ings = recipeIngredientMap(r, mcData);
    let score = 0;
    for (const [name, perCraft] of Object.entries(ings)) {
      const need = perCraft * invocations;
      const have = countSatisfying(name, invItems);
      score += Math.min(have, need);
      if (have >= need) score += 1000;
    }
    if (score > bestScore) {
      bestScore = score;
      best = r;
    } else if (score === bestScore) {
      const canon = Object.keys(recipeIngredientMap(best, mcData))[0];
      const alt = Object.keys(ings)[0];
      const held = new Set(invItems.map((i) => i.name));
      if (alt && held.has(alt) && canon && !held.has(canon)) {
        best = r;
      }
    }
  }
  const resultPerCraft = best.result?.count || 1;
  const invocations = Math.max(1, Math.ceil(count / resultPerCraft));
  return { recipe: best, invocations };
}

/**
 * Shared craft recipe pick: scores variants using recipe invocations for `count` items.
 * @param {import('mineflayer').Bot} b
 * @param {string} itemName resolved item id
 * @param {number} count desired item count
 * @param {object} mcData
 * @returns {{ recipe: object|null, invocations: number, plan: null }}
 */
export function pickRecipeForCraft(b, itemName, count, mcData) {
  const itemType = mcData.itemsByName[itemName];
  if (!itemType) {
    return { recipe: null, invocations: 0, plan: null };
  }
  let recipes = b.recipesFor(itemType.id, null, 1, null);
  if (!recipes?.length) {
    try {
      recipes = b.recipesAll(itemType.id, null, 1);
    } catch {
      recipes = [];
    }
  }
  if (!recipes?.length) {
    return { recipe: null, invocations: 0, plan: null };
  }
  const picked = pickRecipeFromRecipes(recipes, b.inventory.items(), count, mcData);
  return { ...picked, plan: null };
}

/**
 * Build a craft plan: check which ingredients are available, which are missing,
 * and what's in known chests.
 *
 * @param {object}   opts
 * @param {object[]} opts.recipes        Mineflayer recipe array for the target item
 * @param {object[]} opts.invItems       bot.inventory.items()
 * @param {object}   opts.mcData         minecraft-data instance
 * @param {object}   opts.chestSnapshots ctx.goals.chestSnapshots (mark → { items })
 * @param {string}   opts.itemName       Target item name
 * @param {number}   opts.wantCount      Desired quantity
 */
export function buildCraftPlanFromRecipes({ recipes, invItems, mcData, chestSnapshots, itemName, wantCount }) {
  if (!recipes || !recipes.length) {
    return { ok: false, error: `No recipe for ${itemName}` };
  }
  const r = bestRecipeForInventory(recipes, invItems, wantCount, mcData);
  const ingCounts = recipeIngredientMap(r, mcData);
  // Use tag-equivalence: cobblestone satisfies a cobbled_deepslate
  // requirement (and similar tagged ingredients) so the pre-flight check
  // doesn't reject crafts the server would accept.
  const countHave = (n) => countSatisfying(n, invItems);

  const chestTotals = {};
  for (const [markName, snap] of Object.entries(chestSnapshots || {})) {
    if (!snap.items?.length) continue;
    for (const ci of snap.items) {
      if (!chestTotals[ci.name]) chestTotals[ci.name] = { count: 0, locations: [] };
      chestTotals[ci.name].count += ci.count;
      chestTotals[ci.name].locations.push(markName);
    }
  }

  const missing = [];
  const have = {};
  const in_chests = {};
  for (const [n, c] of Object.entries(ingCounts)) {
    const need = c * wantCount;
    const h = countHave(n);
    have[n] = h;
    if (h < need) {
      const preferred = preferredVariantName(n);
      const equivalents = INGREDIENT_TAG_EQUIVALENTS[n];
      const chestInfo = chestTotals[preferred] || chestTotals[n];
      const inChest = chestInfo ? chestInfo.count : 0;
      const entry = { name: preferred, need, have: h, short: need - h };
      if (equivalents && preferred !== n) {
        entry.recipe_canonical = n;
        entry.equivalents = equivalents;
      }
      if (inChest > 0) {
        entry.in_chests = inChest;
        entry.chest_locations = [...new Set(chestInfo.locations)];
      }
      missing.push(entry);
    }
    if (chestTotals[n]) {
      in_chests[n] = { count: chestTotals[n].count, locations: [...new Set(chestTotals[n].locations)] };
    }
  }
  return {
    ok: true,
    item: itemName,
    count: wantCount,
    ingredients: ingCounts,
    have,
    missing,
    in_chests: Object.keys(in_chests).length ? in_chests : undefined,
    needs_table: r.requiresTable !== false,
  };
}
