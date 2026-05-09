import { Vec3 } from 'vec3';
import { ingredientCountsFromSlots } from '../shared/recipe-ingredients.js';

export function createCraftingActions(deps) {
  const { ctx, ensureBot, goals, sleep, resolveCraftItemName, buildCraftPlan, ACTIONS, loadLocations } = deps;
  return {
    async craft({ item, count = 1 }) {
      const b = ensureBot();
      const itemName = resolveCraftItemName(item);
      const itemType = ctx.mcData.itemsByName[itemName];
      if (!itemType) throw new Error(`Unknown item "${itemName}". Check spelling.`);

      // Search for crafting table: first nearby, then wider scan, then marks
      const tableId = ctx.mcData.blocksByName.crafting_table?.id;
      let table = b.findBlock({ matching: tableId, maxDistance: 4 });

      if (!table) {
        // Wider scan — up to 32 blocks
        table = b.findBlock({ matching: tableId, maxDistance: 32 });
        if (table) {
          await b.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 3));
          table = b.findBlock({ matching: tableId, maxDistance: 4 });
        }
      }

      if (!table) {
        // Check marks for known crafting table location
        try {
          const locs = loadLocations();
          const botPos = b.entity.position;
          const tableMarks = Object.entries(locs)
            .filter(([name, l]) => /craft/i.test(name) || /craft/i.test(l.note || ''))
            .map(([name, l]) => ({ name, x: l.x, y: l.y, z: l.z, dist: botPos.distanceTo(new Vec3(l.x, l.y, l.z)) }))
            .sort((a, c) => a.dist - c.dist);
          if (tableMarks.length > 0 && tableMarks[0].dist < 100) {
            const m = tableMarks[0];
            await b.pathfinder.goto(new goals.GoalNear(m.x, m.y, m.z, 3));
            table = b.findBlock({ matching: tableId, maxDistance: 4 });
          }
        } catch { /* ignore mark lookup failures */ }
      }

      // Try all recipe sources: without table, with table, all recipes
      let recipes = b.recipesFor(itemType.id, null, 1, null);
      if ((!recipes || recipes.length === 0) && table) {
        recipes = b.recipesFor(itemType.id, null, 1, table);
      }
      // Fallback: try getting all recipes regardless
      if (!recipes || recipes.length === 0) {
        try { recipes = b.recipesAll(itemType.id, null, 1); } catch { recipes = null; }
      }
      if (!recipes || recipes.length === 0) {
        throw new Error(`Can't craft ${itemName}. ${table ? 'Missing ingredients.' : 'No crafting table found nearby or in marks. Place one and mark it, or use mc go_mark <name>.'} Use /action/recipes to check.`);
      }

      // Pick the recipe variant whose ingredients best match current inventory
      const recipe = deps.bestRecipeForInventory ? deps.bestRecipeForInventory(recipes, b, count) : recipes[0];
      const requiresBench = recipe.requiresTable !== false;
      const craftTable = requiresBench ? table : null;
      // recipesAll often returns shaped recipes that need a bench even when we're not near one —
      // fail here so the agent gets a directed message instead of Mineflayer's opaque error.
      if (requiresBench && !craftTable) {
        throw new Error(
          `Can't craft ${itemName} — need a crafting table within ~4 blocks. Walk to your bench (` +
            '`mc goto_near`), use `mc mark` on it (note "craft"), or `mc discover` nearby blocks, then retry.',
        );
      }

      try {
        await b.craft(recipe, count, craftTable || undefined);
      } catch (err) {
        const msg = /** @type {Error} */ (err).message || String(err);
        if (/requires crafting.?table|non craftingtable used/i.test(msg)) {
          throw new Error(
            `Can't craft ${itemName} — stand next to an actual minecraft:crafting_table block (~4 blocks) ` +
              'or navigate away from chests/other UIs mistaken for benches.',
          );
        }
        if (/missing/i.test(msg)) {
          // Provide actionable detail about what's missing
          const plan = buildCraftPlan(b, itemName, count);
          if (plan.ok && plan.missing?.length) {
            const need = plan.missing.map(m => `${m.short}x ${m.name}`).join(', ');
            throw new Error(`Can't craft ${itemName} x${count} — missing: ${need}. Craft those first.`);
          }
          // Fallback: show recipe ingredients
          const slots = recipe.inShape ? recipe.inShape.flat() : recipe.ingredients?.flat() || [];
          const ings = ingredientCountsFromSlots(slots, ctx.mcData, count);
          const need = Object.entries(ings).map(([n, c]) => `${c}x ${n}`).join(', ');
          throw new Error(`Can't craft ${itemName} x${count} — need: ${need}. Craft sub-components first.`);
        }
        throw err;
      }
      await sleep(250);
      const resultCount = count * (recipe.result?.count || 1);
      return { result: `Crafted ${itemName} x${resultCount}` };
    },

    async recipes({ item }) {
      const b = ensureBot();
      const itemName = resolveCraftItemName(item);
      const itemType = ctx.mcData.itemsByName[itemName];
      if (!itemType) throw new Error(`Unknown item "${itemName}".`);

      // Try multiple recipe lookup methods
      let recipes = b.recipesFor(itemType.id);
      if (!recipes || recipes.length === 0) {
        // Try with crafting table
        const table = b.findBlock({
          matching: ctx.mcData.blocksByName.crafting_table?.id,
          maxDistance: 4,
        });
        if (table) recipes = b.recipesFor(itemType.id, null, 1, table);
      }
      if (!recipes || recipes.length === 0) {
        // Try recipesAll
        try { recipes = b.recipesAll(itemType.id, null, 1); } catch {}
      }
      if (!recipes || recipes.length === 0) {
        return { result: `No crafting recipe for ${itemName}.`, recipes: [] };
      }

      const formatted = recipes.slice(0, 3).map(r => {
        const slots = r.inShape ? r.inShape.flat() : r.ingredients?.flat() || [];
        const ingredients = ingredientCountsFromSlots(slots, ctx.mcData, 1);
        return {
          ingredients,
          needsTable: r.requiresTable !== false,
          makes: r.result?.count || 1,
        };
      });

      return { result: `${formatted.length} recipe(s) for ${itemName}`, recipes: formatted };
    },

    async craft_plan({ item, count = 1 }) {
      const b = ensureBot();
      const itemName = resolveCraftItemName(item);
      const plan = buildCraftPlan(b, itemName, Math.max(1, parseInt(count, 10) || 1));
      if (!plan.ok) throw new Error(plan.error || 'craft_plan failed');
      const parts = [`Plan for ${plan.item} x${plan.count}.`];
      if (plan.missing?.length) {
        const missList = plan.missing.map((m) => {
          let s = `${m.short}x ${m.name}`;
          if (m.in_chests) s += ` (${m.in_chests} in chest @ ${m.chest_locations.join(', ')})`;
          return s;
        });
        parts.push(`Missing: ${missList.join(', ')}`);
      }
      return {
        result: parts.join(' '),
        craft_plan: plan,
      };
    },

    async discover({ category, radius = 32 }) {
      const b = ensureBot();
      const r = Math.min(64, Math.max(8, parseInt(radius, 10) || 32));
      const cat = String(category || '').toLowerCase();
      const out = { category: cat, blocks: [], entities: [] };

      if (cat === 'feathers' || cat === 'chicken') {
        const fe = await deps.ACTIONS.find_entities({ type: 'chicken', radius: r });
        return {
          result: `Chickens nearby: ${fe.entities?.length || 0}`,
          discover: { ...out, entities: fe.entities || [], locations: fe.locations || [] },
        };
      }

      const table = {
        logs: [
          'oak_log',
          'spruce_log',
          'birch_log',
          'jungle_log',
          'acacia_log',
          'dark_oak_log',
          'cherry_log',
          'mangrove_log',
          'pale_oak_log',
          'crimson_stem',
          'warped_stem',
        ],
        food: ['wheat', 'carrot', 'potato', 'beetroot', 'sweet_berry_bush'],
        flint: ['gravel'],
        stone: ['stone', 'cobblestone', 'granite', 'diorite', 'andesite'],
        coal: ['coal_ore', 'deepslate_coal_ore'],
        iron: ['iron_ore', 'deepslate_iron_ore'],
        copper: ['copper_ore', 'deepslate_copper_ore'],
        gold: ['gold_ore', 'deepslate_gold_ore'],
        diamond: ['diamond_ore', 'deepslate_diamond_ore'],
      };

      const categoryAlias = {
        wood: 'logs',
        woods: 'logs',
        timber: 'logs',
        log: 'logs',
        feather: 'feathers',
      };
      const normalizedCat = categoryAlias[cat] || cat;
      const names = table[normalizedCat];
      if (!names) {
        throw new Error(
          `Unknown discover category "${cat}". Try: logs/wood, food, flint, feathers, stone, coal, iron, copper, gold, diamond, chicken`
        );
      }

      for (const blockName of names) {
        try {
          const fb = await deps.ACTIONS.find_blocks({ block: blockName, radius: r, count: 8 });
          if (fb.locations?.length) {
            out.blocks.push({
              name: blockName,
              count: fb.locations.length,
              locations: fb.locations,
            });
          }
        } catch {
          /* skip block */
        }
      }

      // Check chest snapshots for matching items
      const chestMatches = [];
      const rawItemNames = new Set(names);
      // Also match derived/smelted items (e.g. coal from coal_ore, iron_ingot from iron_ore)
      const derivedMap = {
        coal_ore: ['coal'], deepslate_coal_ore: ['coal'],
        iron_ore: ['iron_ingot', 'raw_iron'], deepslate_iron_ore: ['iron_ingot', 'raw_iron'],
        copper_ore: ['copper_ingot', 'raw_copper'], deepslate_copper_ore: ['copper_ingot', 'raw_copper'],
        gold_ore: ['gold_ingot', 'raw_gold'], deepslate_gold_ore: ['gold_ingot', 'raw_gold'],
        diamond_ore: ['diamond'], deepslate_diamond_ore: ['diamond'],
      };
      const allRelevant = new Set(rawItemNames);
      for (const n of names) {
        if (derivedMap[n]) derivedMap[n].forEach(d => allRelevant.add(d));
        allRelevant.add(n.replace('_ore', '').replace('deepslate_', ''));
      }

      for (const [markName, snap] of Object.entries(ctx.chestSnapshots)) {
        if (!snap.items?.length) continue;
        for (const ci of snap.items) {
          if (allRelevant.has(ci.name)) {
            chestMatches.push({ name: ci.name, count: ci.count, location: markName, position: snap.position });
          }
        }
      }
      if (chestMatches.length) out.in_chests = chestMatches;

      const chestNote = chestMatches.length ? `, ${chestMatches.length} item(s) in chests` : '';
      return {
        result: `Discover ${cat}: ${out.blocks.length} block type(s) with sightings${chestNote}`,
        discover: out,
      };
    },

    async smelt({ input, fuel, count = 1 }) {
      const b = ensureBot();
      const isFurnace = block =>
        block.name === 'furnace' || block.name === 'lit_furnace' ||
        block.name === 'blast_furnace' || block.name === 'smoker';

      let furnaceBlock = b.findBlock({ matching: isFurnace, maxDistance: 4 });
      if (!furnaceBlock) {
        furnaceBlock = b.findBlock({ matching: isFurnace, maxDistance: 32 });
        if (furnaceBlock) {
          const fp = furnaceBlock.position;
          await b.pathfinder.goto(new goals.GoalNear(fp.x, fp.y, fp.z, 3));
          furnaceBlock = b.findBlock({ matching: isFurnace, maxDistance: 4 });
        }
      }
      if (!furnaceBlock) {
        // Check marks for a known furnace
        try {
          const locs = loadLocations();
          const botPos = b.entity.position;
          const furnaceMarks = Object.entries(locs)
            .filter(([name, l]) => /furnace|smelter|smelt/i.test(name) || /furnace|smelter/i.test(l.note || ''))
            .map(([name, l]) => ({ name, x: l.x, y: l.y, z: l.z, dist: botPos.distanceTo(new Vec3(l.x, l.y, l.z)) }))
            .sort((a, c) => a.dist - c.dist);
          if (furnaceMarks.length > 0 && furnaceMarks[0].dist < 100) {
            const m = furnaceMarks[0];
            await b.pathfinder.goto(new goals.GoalNear(m.x, m.y, m.z, 3));
            furnaceBlock = b.findBlock({ matching: isFurnace, maxDistance: 4 });
          }
        } catch { /* ignore */ }
      }
      if (!furnaceBlock) throw new Error('No furnace within 32 blocks or in marks. Place one first (craft furnace from 8 cobblestone).');

      const inputItem = b.inventory.items().find(i => i.name === input);
      if (!inputItem) throw new Error(`No ${input} in inventory. Withdraw it from a chest first.`);

      const furnace = await b.openFurnace(furnaceBlock);

      // Clear any finished output before loading new input (prevents "blocking")
      const existingOutput = furnace.outputItem();
      if (existingOutput) await furnace.takeOutput();

      // Clear stale input if it's a different item type
      const existingInput = furnace.inputItem();
      if (existingInput && existingInput.name !== input) {
        await furnace.takeInput();
      }

      await furnace.putInput(inputItem.type, null, Math.min(count, inputItem.count));

      if (!furnace.fuelItem()) {
        const fuelNames = ['coal', 'charcoal', 'coal_block', 'oak_planks', 'birch_planks', 'spruce_planks', 'oak_log', 'birch_log', 'spruce_log', 'stick'];
        const fuelItem = fuel
          ? b.inventory.items().find(i => i.name === fuel)
          : b.inventory.items().find(i => fuelNames.includes(i.name));
        if (!fuelItem) { furnace.close(); throw new Error('No fuel. Need coal, planks, or logs.'); }
        const fuelPer = fuelItem.name === 'coal_block' ? 80 : fuelItem.name.includes('coal') || fuelItem.name === 'charcoal' ? 8 : 1.5;
        const fuelNeeded = Math.ceil(Math.min(count, inputItem.count) / fuelPer);
        await furnace.putFuel(fuelItem.type, null, Math.min(fuelNeeded, fuelItem.count));
      }

      // Wait for smelting, then collect
      await sleep(Math.min(count * 10000, 30000));
      const output = furnace.outputItem();
      if (output) await furnace.takeOutput();
      furnace.close();

      const collected = existingOutput ? ` (also collected ${existingOutput.count}x ${existingOutput.name} already in furnace)` : '';
      return { result: output ? `Smelted ${output.name} x${output.count}${collected}` : `Smelting in progress. Check furnace later with mc furnace_check.${collected}` };
    },
  };
}
