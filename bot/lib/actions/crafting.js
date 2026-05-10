import { Vec3 } from 'vec3';
import { ingredientCountsFromSlots, recipeIngredientMap } from '../shared/recipe-ingredients.js';
import { executeServerCommand, paperMcpConfig } from '../bot/paper-mcp.js';

export function createCraftingActions(deps) {
  const { ctx, ensureBot, goals, sleep, resolveCraftItemName, buildCraftPlan, ACTIONS, loadLocations, getMyName, log } = deps;
  return {
    async craft({ item, count = 1 }) {
      // ─ Phase-2 action contract (see docs/phase-2/action-contracts.md mc craft) ─
      // Soft failures return { ok: false, error: { code, message, observed_state, ... } }.
      // ok=true requires crafted_count >= 1; verified via inventory delta.

      const b = ensureBot();
      const inventoryAt = () =>
        b.inventory.items().reduce((acc, it) => {
          acc[it.name] = (acc[it.name] || 0) + it.count;
          return acc;
        }, /** @type {Record<string, number>} */ ({}));
      const startedInventory = inventoryAt();

      // ── UNKNOWN_ITEM (resolveCraftItemName throws) ──
      let itemName;
      try {
        itemName = resolveCraftItemName(item);
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'UNKNOWN_ITEM',
            message: /** @type {Error} */ (err).message,
            observed_state: { requested_item: item },
            retry_safe: false,
          },
        };
      }
      const itemType = ctx.mcData.itemsByName[itemName];
      if (!itemType) {
        return {
          ok: false,
          error: {
            code: 'UNKNOWN_ITEM',
            message: `Unknown item "${itemName}" (resolved from "${item}"). Check spelling.`,
            observed_state: { requested_item: item, resolved_to: itemName },
            retry_safe: false,
          },
        };
      }

      // Search for crafting table: nearby, then wider scan, then marks.
      const tableId = ctx.mcData.blocksByName.crafting_table?.id;
      let table = b.findBlock({ matching: tableId, maxDistance: 4 });
      let nearestTableSeen = null;
      if (!table) {
        const wide = b.findBlock({ matching: tableId, maxDistance: 32 });
        if (wide) {
          nearestTableSeen = { x: wide.position.x, y: wide.position.y, z: wide.position.z };
          try {
            await b.pathfinder.goto(new goals.GoalNear(wide.position.x, wide.position.y, wide.position.z, 3));
            table = b.findBlock({ matching: tableId, maxDistance: 4 });
          } catch { /* leave table null; nearestTableSeen captured */ }
        }
      }
      if (!table) {
        try {
          const locs = loadLocations();
          const botPos = b.entity.position;
          const tableMarks = Object.entries(locs)
            .filter(([name, l]) => /craft/i.test(name) || /craft/i.test(l.note || ''))
            .map(([name, l]) => ({ name, x: l.x, y: l.y, z: l.z, dist: botPos.distanceTo(new Vec3(l.x, l.y, l.z)) }))
            .sort((a, c) => a.dist - c.dist);
          if (tableMarks.length > 0 && tableMarks[0].dist < 100) {
            const m = tableMarks[0];
            nearestTableSeen = nearestTableSeen || { x: m.x, y: m.y, z: m.z };
            await b.pathfinder.goto(new goals.GoalNear(m.x, m.y, m.z, 3));
            table = b.findBlock({ matching: tableId, maxDistance: 4 });
          }
        } catch { /* ignore */ }
      }

      // ── Recipe lookup ──
      let recipes = b.recipesFor(itemType.id, null, 1, null);
      if ((!recipes || recipes.length === 0) && table) {
        recipes = b.recipesFor(itemType.id, null, 1, table);
      }
      if (!recipes || recipes.length === 0) {
        try { recipes = b.recipesAll(itemType.id, null, 1); } catch { recipes = null; }
      }
      if (!recipes || recipes.length === 0) {
        // Distinguish NO_RECIPE (item genuinely uncraftable) from
        // MISSING_INGREDIENTS-by-way-of-empty-recipes (recipesFor returns
        // [] when the player lacks materials). recipesAll returning empty
        // is the strong signal — no recipe at any inventory state.
        let hasAnyRecipe = false;
        try {
          const all = b.recipesAll(itemType.id, null, 1);
          hasAnyRecipe = Array.isArray(all) && all.length > 0;
        } catch { hasAnyRecipe = false; }

        if (!hasAnyRecipe) {
          return {
            ok: false,
            error: {
              code: 'NO_RECIPE',
              message: `No crafting recipe exists for ${itemName}.`,
              observed_state: { item: itemName, requested_count: count },
              retry_safe: false,
            },
          };
        }
        // Has recipes but recipesFor returned none — table or ingredients gating it.
        // Fall through to the table/ingredient checks below by re-fetching all recipes.
        recipes = b.recipesAll(itemType.id, null, 1);
      }

      const recipe = deps.bestRecipeForInventory ? deps.bestRecipeForInventory(recipes, b, count) : recipes[0];
      const requiresBench = recipe.requiresTable !== false;

      // ── TABLE_REQUIRED ──
      if (requiresBench && !table) {
        return {
          ok: false,
          error: {
            code: nearestTableSeen ? 'TABLE_OUT_OF_RANGE' : 'TABLE_REQUIRED',
            message: nearestTableSeen
              ? `${itemName} needs a crafting_table within 4 blocks. Nearest seen at (${nearestTableSeen.x}, ${nearestTableSeen.y}, ${nearestTableSeen.z}); pathfind didn't reach.`
              : `${itemName} needs a crafting_table within 4 blocks; none nearby and no marks reference one.`,
            observed_state: {
              item: itemName,
              requested_count: count,
              nearest_table: nearestTableSeen,
            },
            next_action_hint: nearestTableSeen
              ? `mc goto_near ${nearestTableSeen.x} ${nearestTableSeen.y} ${nearestTableSeen.z} 2 then retry`
              : `Place a crafting_table (mc place crafting_table X Y Z) then retry, or mc mark @craft on an existing one.`,
            retry_safe: false,
          },
        };
      }

      // Pre-flight ingredient check via buildCraftPlan if available.
      // This gives us MISSING_INGREDIENTS *before* attempting the craft, with
      // a clean shortfall list rather than parsing mineflayer's error string.
      const plan = buildCraftPlan ? buildCraftPlan(b, itemName, count) : null;
      if (plan && plan.ok && plan.missing && plan.missing.length > 0) {
        return {
          ok: false,
          error: {
            code: 'MISSING_INGREDIENTS',
            message: `Can't craft ${itemName} x${count} — need: ${plan.missing.map(m => `${m.short}x ${m.name}`).join(', ')}.`,
            observed_state: {
              item: itemName,
              requested_count: count,
              missing: plan.missing.map(m => ({ name: m.name, short: m.short })),
              started_inventory: startedInventory,
            },
            retry_safe: false,
          },
        };
      }

      // ── Attempt craft. Failures here are catch-all INTERRUPTED-ish. ──
      // For table-required recipes, mineflayer 4.23 + Paper 1.21 has a race
      // where b.craft silently no-ops if the bot isn't oriented + close
      // enough at the exact moment the open-window packet fires. Explicitly
      // lookAt the table and brief settle before crafting.
      if (requiresBench && table) {
        try {
          await b.lookAt(table.position.offset(0.5, 0.5, 0.5), true);
          await sleep(150);
        } catch { /* best-effort */ }
      }
      try {
        await b.craft(recipe, count, requiresBench ? table : undefined);
      } catch (err) {
        const msg = /** @type {Error} */ (err).message || String(err);
        // Re-classify mineflayer's raw error string to one of our codes.
        if (/requires crafting.?table|non craftingtable used/i.test(msg)) {
          return {
            ok: false,
            error: {
              code: 'TABLE_REQUIRED',
              message: `mineflayer rejected the craft: ${msg}. Likely block at table position is not actually a crafting_table.`,
              observed_state: { item: itemName, requested_count: count, mineflayer_error: msg },
              retry_safe: false,
            },
          };
        }
        if (/missing/i.test(msg)) {
          const slots = recipe.inShape ? recipe.inShape.flat() : recipe.ingredients?.flat() || [];
          const ings = ingredientCountsFromSlots(slots, ctx.mcData, count);
          return {
            ok: false,
            error: {
              code: 'MISSING_INGREDIENTS',
              message: `Mineflayer reported missing ingredients for ${itemName} x${count}.`,
              observed_state: {
                item: itemName,
                requested_count: count,
                missing: Object.entries(ings).map(([name, short]) => ({ name, short })),
                started_inventory: startedInventory,
                mineflayer_error: msg,
              },
              retry_safe: false,
            },
          };
        }
        return {
          ok: false,
          error: {
            code: 'INTERRUPTED',
            message: `Craft failed mid-flight: ${msg}`,
            observed_state: { item: itemName, requested_count: count, mineflayer_error: msg },
            retry_safe: true,
          },
        };
      }
      await sleep(250);

      // ── Verify via inventory delta ──
      const endedInventory = inventoryAt();
      const craftedDelta = (endedInventory[itemName] || 0) - (startedInventory[itemName] || 0);
      const expectedDelta = count * (recipe.result?.count || 1);
      const ingredientsConsumed = {};
      for (const [name, before] of Object.entries(startedInventory)) {
        const after = endedInventory[name] || 0;
        if (after < before) ingredientsConsumed[name] = before - after;
      }

      if (craftedDelta < 1) {
        // Mineflayer's craft() against Paper 1.21+ has a long-standing bug
        // where 3x3 table-required recipes complete the click sequence but
        // the server doesn't materialize the result (see mineflayer issue
        // #3399 and friends). Ingredients are placed in the grid then
        // returned to inventory unchanged. When this happens, fall back to
        // a server-side craft via PaperMCP: clear ingredients, give result.
        // Only attempt fallback when ingredients are still in inventory
        // (i.e. mineflayer didn't half-consume them).
        const requiredIngs = recipeIngredientMap(recipe, ctx.mcData);
        const ingsIntact = Object.entries(requiredIngs).every(
          ([n, perCraft]) => (endedInventory[n] || 0) >= perCraft * count,
        );
        if (requiresBench && ingsIntact && paperMcpConfig()) {
          const fb = await serverSideCraftFallback({
            itemName, count, recipe, ctx, b,
            getMyName, log, sleep, inventoryAt,
            startedInventory, requiredIngs, expectedDelta,
          });
          if (fb) return fb;
        }
        return {
          ok: false,
          error: {
            code: 'INTERRUPTED',
            message: `mineflayer.craft returned but inventory shows no new ${itemName} (delta=${craftedDelta}).`,
            observed_state: {
              item: itemName,
              requested_count: count,
              expected_delta: expectedDelta,
              observed_delta: craftedDelta,
              started_inventory: startedInventory,
              ended_inventory: endedInventory,
            },
            retry_safe: true,
          },
        };
      }

      return {
        ok: true,
        data: {
          crafted_count: craftedDelta,
          requested_count: count,
          expected_per_craft: recipe.result?.count || 1,
          recipe_used: {
            requires_table: requiresBench,
            result_per_craft: recipe.result?.count || 1,
          },
          ingredients_consumed: ingredientsConsumed,
          started_inventory: startedInventory,
          ended_inventory: endedInventory,
        },
        result: `Crafted ${itemName} x${craftedDelta}`,
      };
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
      // ─ Phase-2 action contract (see docs/phase-2/action-contracts.md mc smelt) ─
      // Soft failures return { ok: false, error: { code, message, observed_state, ... } }.
      // ok=true requires smelted_count >= 1; verified via inventory delta on output item.

      const b = ensureBot();
      const inventoryAt = () =>
        b.inventory.items().reduce((acc, it) => {
          acc[it.name] = (acc[it.name] || 0) + it.count;
          return acc;
        }, /** @type {Record<string, number>} */ ({}));
      const startedInventory = inventoryAt();

      const isFurnace = block =>
        block.name === 'furnace' || block.name === 'lit_furnace' ||
        block.name === 'blast_furnace' || block.name === 'smoker';

      // ── Locate furnace ──
      let furnaceBlock = b.findBlock({ matching: isFurnace, maxDistance: 4 });
      let nearestFurnaceSeen = null;
      if (!furnaceBlock) {
        const wide = b.findBlock({ matching: isFurnace, maxDistance: 32 });
        if (wide) {
          nearestFurnaceSeen = { x: wide.position.x, y: wide.position.y, z: wide.position.z, kind: wide.name };
          try {
            await b.pathfinder.goto(new goals.GoalNear(wide.position.x, wide.position.y, wide.position.z, 3));
            furnaceBlock = b.findBlock({ matching: isFurnace, maxDistance: 4 });
          } catch { /* leave null */ }
        }
      }
      if (!furnaceBlock) {
        try {
          const locs = loadLocations();
          const botPos = b.entity.position;
          const furnaceMarks = Object.entries(locs)
            .filter(([name, l]) => /furnace|smelter|smelt/i.test(name) || /furnace|smelter/i.test(l.note || ''))
            .map(([name, l]) => ({ name, x: l.x, y: l.y, z: l.z, dist: botPos.distanceTo(new Vec3(l.x, l.y, l.z)) }))
            .sort((a, c) => a.dist - c.dist);
          if (furnaceMarks.length > 0 && furnaceMarks[0].dist < 100) {
            const m = furnaceMarks[0];
            nearestFurnaceSeen = nearestFurnaceSeen || { x: m.x, y: m.y, z: m.z, kind: 'furnace_mark' };
            await b.pathfinder.goto(new goals.GoalNear(m.x, m.y, m.z, 3));
            furnaceBlock = b.findBlock({ matching: isFurnace, maxDistance: 4 });
          }
        } catch { /* ignore */ }
      }
      if (!furnaceBlock) {
        return {
          ok: false,
          error: {
            code: 'NO_FURNACE',
            message: nearestFurnaceSeen
              ? `Furnace at (${nearestFurnaceSeen.x}, ${nearestFurnaceSeen.y}, ${nearestFurnaceSeen.z}) seen but pathfind didn't reach within 4 blocks.`
              : `No furnace within 32 blocks or in marks. Place one (mc place furnace X Y Z) and retry.`,
            observed_state: {
              requested_input: input,
              requested_count: count,
              nearest_furnace: nearestFurnaceSeen,
            },
            next_action_hint: nearestFurnaceSeen
              ? `mc goto_near ${nearestFurnaceSeen.x} ${nearestFurnaceSeen.y} ${nearestFurnaceSeen.z} 2 then retry`
              : 'mc craft furnace then mc place furnace X Y Z near you',
            retry_safe: false,
          },
        };
      }

      // ── NO_INPUT ──
      const inputItem = b.inventory.items().find(i => i.name === input);
      if (!inputItem) {
        return {
          ok: false,
          error: {
            code: 'NO_INPUT',
            message: `No ${input} in inventory. Get some first (mc collect / mc chest withdraw).`,
            observed_state: {
              requested_input: input,
              requested_count: count,
              started_inventory: startedInventory,
            },
            retry_safe: false,
          },
        };
      }

      const furnaceCoord = { x: furnaceBlock.position.x, y: furnaceBlock.position.y, z: furnaceBlock.position.z, kind: furnaceBlock.name };
      let furnace;
      try {
        furnace = await b.openFurnace(furnaceBlock);
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'INTERRUPTED',
            message: `Failed to open furnace at ${furnaceCoord.x},${furnaceCoord.y},${furnaceCoord.z}: ${/** @type {Error} */(err).message}`,
            observed_state: { furnace: furnaceCoord, requested_input: input, mineflayer_error: /** @type {Error} */(err).message },
            retry_safe: true,
          },
        };
      }

      const existingOutput = furnace.outputItem();
      if (existingOutput) await furnace.takeOutput();
      const existingInput = furnace.inputItem();
      if (existingInput && existingInput.name !== input) {
        await furnace.takeInput();
      }

      const inputAmount = Math.min(count, inputItem.count);
      await furnace.putInput(inputItem.type, null, inputAmount);

      // ── NO_FUEL ──
      let fuelUsed = null;
      if (!furnace.fuelItem()) {
        const fuelNames = ['coal', 'charcoal', 'coal_block', 'oak_planks', 'birch_planks', 'spruce_planks', 'oak_log', 'birch_log', 'spruce_log', 'stick'];
        const fuelItem = fuel
          ? b.inventory.items().find(i => i.name === fuel)
          : b.inventory.items().find(i => fuelNames.includes(i.name));
        if (!fuelItem) {
          // Restore the input to the player so they can retry without losing it.
          try { await furnace.takeInput(); } catch { /* best-effort */ }
          try { furnace.close(); } catch {}
          return {
            ok: false,
            error: {
              code: 'NO_FUEL',
              message: `No fuel in inventory (need coal/charcoal/planks/logs).${fuel ? ` Requested fuel "${fuel}" not found.` : ''}`,
              observed_state: {
                furnace: furnaceCoord,
                requested_input: input,
                requested_count: count,
                requested_fuel: fuel || null,
                accepted_fuels: fuelNames,
                started_inventory: startedInventory,
              },
              next_action_hint: 'mc collect coal_ore + smelt; or mc craft charcoal from logs',
              retry_safe: false,
            },
          };
        }
        const fuelPer = fuelItem.name === 'coal_block' ? 80 : fuelItem.name.includes('coal') || fuelItem.name === 'charcoal' ? 8 : 1.5;
        const fuelNeeded = Math.ceil(inputAmount / fuelPer);
        const fuelToPut = Math.min(fuelNeeded, fuelItem.count);
        await furnace.putFuel(fuelItem.type, null, fuelToPut);
        fuelUsed = { name: fuelItem.name, amount: fuelToPut, smelts_per_unit: fuelPer };
      }

      // Wait for smelting. Vanilla smelt is exactly 10s per item; we add 2s
      // slack for server lag + fuel-ignition delay. Capped at 60s for the
      // test loop.
      await sleep(Math.min(inputAmount * 10000 + 2000, 60000));
      const output = furnace.outputItem();
      const outputName = output ? output.name : null;
      const outputCount = output ? output.count : 0;
      if (output) await furnace.takeOutput();
      try { furnace.close(); } catch {}

      const endedInventory = inventoryAt();
      // Inventory delta includes BOTH the auto-collected pre-existing output
      // (if it matches outputName) AND the freshly-smelted items. Subtract
      // the existing-output count so smelted_count reflects the actual smelt.
      const existingOutputCount =
        existingOutput && existingOutput.name === outputName ? existingOutput.count : 0;
      const smeltedCount = outputName
        ? Math.max(0, (endedInventory[outputName] || 0) - (startedInventory[outputName] || 0) - existingOutputCount)
        : 0;

      // ── NOT_SMELTABLE / partial / interrupted ──
      if (!outputName || smeltedCount < 1) {
        return {
          ok: false,
          error: {
            code: outputName ? 'INTERRUPTED' : 'NOT_SMELTABLE',
            message: outputName
              ? `Furnace output present (${outputName} x${outputCount}) but inventory delta is ${smeltedCount}.`
              : `${input} produced no output after ${Math.min(inputAmount * 10, 30)}s — likely not a smeltable item.`,
            observed_state: {
              furnace: furnaceCoord,
              requested_input: input,
              requested_count: count,
              fuel_used: fuelUsed,
              started_inventory: startedInventory,
              ended_inventory: endedInventory,
              output_in_furnace: outputName ? { name: outputName, count: outputCount } : null,
            },
            retry_safe: !outputName,
          },
        };
      }

      return {
        ok: true,
        data: {
          smelted_count: smeltedCount,
          requested_count: count,
          input_item: input,
          output_item: outputName,
          fuel_used: fuelUsed,
          existing_output_collected: existingOutput ? { name: existingOutput.name, count: existingOutput.count } : null,
          furnace: furnaceCoord,
          started_inventory: startedInventory,
          ended_inventory: endedInventory,
        },
        result: `Smelted ${outputName} x${smeltedCount}${existingOutput ? ` (+ ${existingOutput.count}x ${existingOutput.name} already in furnace)` : ''}`,
      };
    },
  };
}

/**
 * Server-side craft fallback for table-required (3x3) recipes that mineflayer's
 * b.craft cannot complete on Paper 1.21+ (open mineflayer issue #3399). Consumes
 * ingredients via /clear and gives the result via /give through PaperMCP. Verifies
 * via inventory delta. Returns null if PaperMCP is unavailable or the fallback
 * itself fails — caller falls through to the original INTERRUPTED error.
 */
async function serverSideCraftFallback({
  itemName, count, recipe, ctx, b,
  getMyName, log, sleep, inventoryAt,
  startedInventory, requiredIngs, expectedDelta,
}) {
  const pmcpCfg = paperMcpConfig();
  if (!pmcpCfg) return null;
  const username = getMyName();
  if (!username) return null;
  if (log) log(`[craft] server-side fallback for ${itemName} x${count} (mineflayer delta=0 bug)`);

  const totalIngs = {};
  for (const [n, perCraft] of Object.entries(requiredIngs)) {
    totalIngs[n] = perCraft * count;
  }

  try {
    for (const [name, qty] of Object.entries(totalIngs)) {
      const r = await executeServerCommand(pmcpCfg, `clear ${username} minecraft:${name} ${qty}`);
      if (!r.ok) {
        if (log) log(`[craft] fallback clear ${name}x${qty} failed: ${r.error}`);
        return null;
      }
    }
    const outName = recipe.result?.name || itemName;
    const outCount = (recipe.result?.count || 1) * count;
    const r = await executeServerCommand(pmcpCfg, `give ${username} minecraft:${outName} ${outCount}`);
    if (!r.ok) {
      if (log) log(`[craft] fallback give ${outName}x${outCount} failed: ${r.error}`);
      return null;
    }
  } catch (err) {
    if (log) log(`[craft] fallback threw: ${err?.message || err}`);
    return null;
  }

  // Wait for inventory packets to settle.
  for (let i = 0; i < 10; i++) {
    await sleep(100);
    const inv = inventoryAt();
    if ((inv[itemName] || 0) - (startedInventory[itemName] || 0) >= 1) break;
  }
  const endedInventory = inventoryAt();
  const craftedDelta = (endedInventory[itemName] || 0) - (startedInventory[itemName] || 0);
  const ingredientsConsumed = {};
  for (const [n, before] of Object.entries(startedInventory)) {
    const after = endedInventory[n] || 0;
    if (after < before) ingredientsConsumed[n] = before - after;
  }
  if (craftedDelta < 1) {
    if (log) log(`[craft] fallback ran but inventory delta still 0; bailing`);
    return null;
  }
  return {
    ok: true,
    data: {
      crafted_count: craftedDelta,
      requested_count: count,
      expected_per_craft: recipe.result?.count || 1,
      recipe_used: {
        requires_table: true,
        result_per_craft: recipe.result?.count || 1,
        fallback: 'papermcp_server_side',
      },
      ingredients_consumed: ingredientsConsumed,
      started_inventory: startedInventory,
      ended_inventory: endedInventory,
    },
    result: `Crafted ${itemName} x${craftedDelta} (server-side fallback)`,
  };
}
