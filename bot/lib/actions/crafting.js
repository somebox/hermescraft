import { Vec3 } from 'vec3';

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
        recipes = b.recipesAll(itemType.id, null, 1);
      }
      if (!recipes || recipes.length === 0) {
        throw new Error(`Can't craft ${itemName}. ${table ? 'Missing ingredients.' : 'No crafting table found nearby or in marks. Place one and mark it, or use mc go_mark <name>.'} Use /action/recipes to check.`);
      }

      const recipe = recipes[0];
      const craftTable = (recipe.requiresTable !== false) ? table : null;

      try {
        await b.craft(recipe, count, craftTable || undefined);
      } catch (err) {
        const msg = /** @type {Error} */ (err).message || String(err);
        if (/missing/i.test(msg)) {
          // Provide actionable detail about what's missing
          const plan = buildCraftPlan(b, itemName, count);
          if (plan.ok && plan.missing?.length) {
            const need = plan.missing.map(m => `${m.short}x ${m.name}`).join(', ');
            throw new Error(`Can't craft ${itemName} x${count} — missing: ${need}. Craft those first.`);
          }
          // Fallback: show recipe ingredients
          const slots = recipe.inShape ? recipe.inShape.flat() : recipe.ingredients?.flat() || [];
          const ings = {};
          for (const id of slots) {
            if (!id || id === -1) continue;
            const name = ctx.mcData.items[id]?.name || `id:${id}`;
            ings[name] = (ings[name] || 0) + count;
          }
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
        const ingredients = {};
        const slots = r.inShape ? r.inShape.flat() : r.ingredients?.flat() || [];
        slots.filter(id => id && id !== -1).forEach(id => {
          const name = ctx.mcData.items[id]?.name || `id:${id}`;
          ingredients[name] = (ingredients[name] || 0) + 1;
        });
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
      const miss = plan.missing?.length ? ` Missing: ${plan.missing.map((m) => `${m.short}x ${m.name}`).join(', ')}` : '';
      return {
        result: `Plan for ${plan.item} x${plan.count}.${miss}`,
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
          `Unknown discover category "${cat}". Try: logs/wood, food, flint, feathers, stone, coal, iron, chicken`
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
      return {
        result: `Discover ${cat}: ${out.blocks.length} block type(s) with sightings`,
        discover: out,
      };
    },

    async smelt({ input, fuel, count = 1 }) {
      const b = ensureBot();
      const furnaceBlock = b.findBlock({
        matching: block => block.name === 'furnace' || block.name === 'lit_furnace',
        maxDistance: 4,
      });
      if (!furnaceBlock) throw new Error('No furnace within 4 blocks. Place one first.');

      const furnace = await b.openFurnace(furnaceBlock);
      const inputItem = b.inventory.items().find(i => i.name === input);
      if (!inputItem) { furnace.close(); throw new Error(`No ${input} in inventory.`); }

      await furnace.putInput(inputItem.type, null, Math.min(count, inputItem.count));

      if (!furnace.fuelItem()) {
        const fuelNames = ['coal', 'charcoal', 'oak_planks', 'birch_planks', 'spruce_planks', 'oak_log', 'birch_log', 'spruce_log', 'stick'];
        const fuelItem = fuel
          ? b.inventory.items().find(i => i.name === fuel)
          : b.inventory.items().find(i => fuelNames.includes(i.name));
        if (!fuelItem) { furnace.close(); throw new Error('No fuel. Need coal, planks, or logs.'); }
        await furnace.putFuel(fuelItem.type, null, Math.min(8, fuelItem.count));
      }

      // Wait briefly then check
      await sleep(Math.min(count * 10000, 30000));
      const output = furnace.outputItem();
      if (output) await furnace.takeOutput();
      furnace.close();

      return { result: output ? `Smelted ${output.name} x${output.count}` : `Smelting in progress. Check furnace later.` };
    },
  };
}
