// @size-exempt: recipe-handling verbs + craft fallback helper
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ingredientCountsFromSlots, recipeIngredientMap, countSatisfyingFromMap, intermediateSourceItem } from '../shared/recipe-ingredients.js';
import { executeServerCommand, paperMcpConfig } from '../runtime/paper-mcp.js';
import { raceWithTimeout, timeoutError, OperationTimeoutError, ACTION_CAPS_MS, pathfindGotoNear } from './_helpers.js';
import { ok, fail } from '../shared/action-contract.js';

const { goals } = pathfinderPkg;

/**
 * Crafting actions — first module migrated to the action contract + services
 * container. Every handler returns ok()/fail() per
 * docs/reference/bot/handler-response-contracts.md. Optional `reason` parameter is surfaced
 * in `data._reason` for the audit trail wired in Phase 7.
 */
export function createCraftingActions(services) {
  const { state: ctx, ensureBot, utils, social, locations, craft, getActions } = services;
  const { sleep, log } = utils;
  const { getMyName } = social;
  const loadLocations = locations.load;
  const saveLocations = locations.save;
  const { resolveCraftItemName, buildCraftPlan, bestRecipeForInventory } = craft;

  // #100: auto-mark a crafting_table the bot just used (or just placed)
  // so future `mc craft` calls find it via the existing /craft/i name
  // regex in the marks fallback (loadLocations branch above). Idempotent:
  // skip if a craft-marked location already exists within 3 blocks. The
  // bot is welcome to rename or delete auto-marks later via `mc mark`.
  const autoMarkCraftingTable = (pos) => {
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return false;
    try {
      // Clone — some locations backends return the live store by reference
      // and clear it on save (mock-services). Cloning makes the helper
      // resilient to either contract.
      const locs = { ...loadLocations() };
      const px = Math.round(pos.x), py = Math.round(pos.y), pz = Math.round(pos.z);
      for (const [n, l] of Object.entries(locs)) {
        if (!l || typeof l.x !== 'number') continue;
        const isCraftMark = /craft/i.test(n) || /craft/i.test(l.note || '');
        if (!isCraftMark) continue;
        const dx = l.x - px, dy = l.y - py, dz = l.z - pz;
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) < 3) return false;
      }
      const name = `craft_table_${px}_${py}_${pz}`;
      if (locs[name]) return false;
      const now = new Date().toISOString();
      locs[name] = {
        x: px, y: py, z: pz,
        note: 'crafting_table (auto-marked)',
        saved: now, updated: now,
        category: 'auto', radius: null, mode: null,
        stale: false, stale_reason: null,
        last_visited: null, visit_count: 0,
      };
      saveLocations(locs);
      try { log?.(`[craft] auto-marked crafting_table at ${px},${py},${pz} as ${name}`); } catch {}
      return true;
    } catch { return false; }
  };
  // Stash on the services bag so building.js (place handler) can call it
  // too when crafting_table is placed but never crafted at.
  if (services && !services.autoMarkCraftingTable) {
    services.autoMarkCraftingTable = autoMarkCraftingTable;
  }

  const handlers = {
    async craft({ item, count = 1, reason }) {
      // ─ Phase-2 action contract (docs/reference/bot/handler-response-contracts.md mc craft) ─
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
        return fail('UNKNOWN_ITEM', /** @type {Error} */ (err).message, {
          observed_state: { requested_item: item },
          retry_safe: false,
        });
      }
      const itemType = ctx.world.mcData.itemsByName[itemName];
      if (!itemType) {
        return fail(
          'UNKNOWN_ITEM',
          `Unknown item "${itemName}" (resolved from "${item}"). Check spelling.`,
          {
            observed_state: { requested_item: item, resolved_to: itemName },
            retry_safe: false,
          },
        );
      }

      // Search for crafting table: nearby, then wider scan, then marks.
      // Task #27: bumped wider scan 32→64 so a table just past the old cap
      // gets found instead of triggering a fresh craft_table placement. The
      // base accumulated 4+ redundant tables in v6/v7 because the agent's
      // perception said "no table" when one was 35 blocks away.
      const tableId = ctx.world.mcData.blocksByName.crafting_table?.id;
      let table = b.findBlock({ matching: tableId, maxDistance: 4 });
      let nearestTableSeen = null;
      if (!table) {
        const wide = b.findBlock({ matching: tableId, maxDistance: 64 });
        if (wide) {
          nearestTableSeen = { x: wide.position.x, y: wide.position.y, z: wide.position.z };
          try {
            await pathfindGotoNear(b, goals, wide.position.x, wide.position.y, wide.position.z, 3, { opName: 'craft_table', capMs: ACTION_CAPS_MS.craft });
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
            await pathfindGotoNear(b, goals, m.x, m.y, m.z, 3, { opName: 'craft_mark', capMs: ACTION_CAPS_MS.craft });
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
          return fail('NO_RECIPE', `No crafting recipe exists for ${itemName}.`, {
            observed_state: { item: itemName, requested_count: count },
            retry_safe: false,
          });
        }
        // Has recipes but recipesFor returned none — table or ingredients gating it.
        // Fall through to the table/ingredient checks below by re-fetching all recipes.
        recipes = b.recipesAll(itemType.id, null, 1);
      }

      const mcData = ctx.world.mcData;
      const invItems = b.inventory.items();
      const picked = craft.pickRecipeFromRecipes
        ? craft.pickRecipeFromRecipes(recipes, invItems, count, mcData)
        : null;
      const recipe = picked?.recipe ?? (bestRecipeForInventory ? bestRecipeForInventory(recipes, b, count) : recipes[0]);
      const requiresBench = recipe.requiresTable !== false;

      // Convert "I want N items" → "how many times to run the recipe".
      // mineflayer's b.craft(recipe, N) runs the recipe N times. For a
      // planks recipe that yields 4 per run, asking for `count = 4` and
      // passing it straight to b.craft produced 16 planks (and consumed
      // 4 logs) — confusing for models that read `crafted_count=16,
      // requested_count=4` as a failure. We now compute invocations =
      // ceil(count / yield), so `craft 4 planks` runs the recipe once
      // (1 log → 4 planks), `craft 5 planks` runs twice (2 logs → 8),
      // and so on. The user gets AT LEAST what they asked for.
      const resultPerCraft = recipe.result?.count || 1;
      const invocations = picked?.invocations ?? Math.max(1, Math.ceil(count / resultPerCraft));

      // ── TABLE_REQUIRED ──
      if (requiresBench && !table) {
        return fail(
          nearestTableSeen ? 'TABLE_OUT_OF_RANGE' : 'TABLE_REQUIRED',
          nearestTableSeen
            ? `${itemName} needs a crafting_table within 4 blocks. Nearest seen at (${nearestTableSeen.x}, ${nearestTableSeen.y}, ${nearestTableSeen.z}); pathfind didn't reach.`
            : `${itemName} needs a crafting_table within 4 blocks; none nearby and no marks reference one.`,
          {
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
        );
      }

      // Pre-flight ingredient check via buildCraftPlan if available.
      // This gives us MISSING_INGREDIENTS *before* attempting the craft, with
      // a clean shortfall list rather than parsing mineflayer's error string.
      // Pass `invocations`, not `count` — the plan multiplies ingredients by
      // its wantCount param, and our wantCount is "recipe runs", not "items".
      let plan = buildCraftPlan ? buildCraftPlan(b, itemName, invocations) : null;

      // High-level contract (task #19): if ingredients are missing but the
      // bot has previously catalogued chests via chest_search snapshots,
      // auto-walk to each chest, withdraw what's needed, then re-plan.
      // Re-plan only — never block on chest discovery; if the answer is
      // still MISSING_INGREDIENTS, fall through to the existing error.
      //
      // Bug t_626cb49a (2026-05-24): without a time budget, this loop could
      // eat the entire 30 s ACTION_CAPS_MS.craft cap pathfinding to one
      // stale chest entry per missing ingredient, then return
      // OPERATION_TIMEOUT instead of the useful MISSING_INGREDIENTS. Flint
      // burned 3 × 90 iterations on this. We now cap the WHOLE auto-fetch
      // loop at 12 s and each per-chest pathfind at 6 s — if we can't
      // recover materials in 12 s, the bot should report the shortfall and
      // a higher-level orchestrator can decide whether to dispatch a
      // gather card.
      const FETCH_LOOP_BUDGET_MS = 12_000;
      const FETCH_PER_CHEST_CAP_MS = 6_000;
      let autoFetched = null;
      if (plan && plan.ok && plan.missing && plan.missing.length > 0) {
        const allActions = getActions ? getActions() : null;
        if (allActions && typeof allActions.chest_search === 'function' && typeof allActions.withdraw === 'function') {
          const fetchedSteps = [];
          const fetchStartMs = Date.now();
          let budgetExhausted = false;
          for (const need of plan.missing) {
            if (Date.now() - fetchStartMs > FETCH_LOOP_BUDGET_MS) {
              budgetExhausted = true;
              fetchedSteps.push({
                item: need.name,
                ok: false,
                error: `auto-fetch budget exhausted (>${FETCH_LOOP_BUDGET_MS}ms across prior needs); falling through to MISSING_INGREDIENTS`,
              });
              break;
            }
            try {
              const res = await allActions.chest_search({ item: need.name, max_results: 3, exact: true });
              const matches = res?.data?.matches || res?.matches || [];
              if (!Array.isArray(matches) || matches.length === 0) continue;
              const best = matches[0];
              if (!best || !Number.isFinite(best.x)) continue;
              const wantCount = Math.max(1, Number(need.short) || 1);
              try {
                await pathfindGotoNear(b, goals, best.x, best.y, best.z, 2, {
                  opName: 'craft_chest_fetch',
                  capMs: FETCH_PER_CHEST_CAP_MS,
                });
              } catch { /* couldn't reach this chest — skip to next ingredient */ continue; }
              const wd = await allActions.withdraw({ x: best.x, y: best.y, z: best.z, items: [{ item: need.name, count: wantCount }] });
              fetchedSteps.push({
                item: need.name,
                requested: wantCount,
                from: { x: best.x, y: best.y, z: best.z },
                ok: !!wd?.ok,
                delta: wd?.data?.inventory_delta || null,
              });
            } catch (e) {
              fetchedSteps.push({ item: need.name, ok: false, error: e?.message || String(e) });
            }
          }
          if (fetchedSteps.length > 0) {
            autoFetched = { attempts: fetchedSteps, budget_exhausted: budgetExhausted };
            // Re-plan now that inventory has changed.
            plan = buildCraftPlan ? buildCraftPlan(b, itemName, invocations) : plan;
          }
        }
      }

      if (plan && plan.ok && plan.missing && plan.missing.length > 0) {
        const craft_diag = await buildCraftDiag({
          origin: 'preflight_plan_missing', item, itemName, recipe, invocations, requiresBench,
          requiredIngs: recipeIngredientMap(recipe, ctx.world.mcData),
          startedInventory, endedInventory: startedInventory, attempted: false,
          declaredShort: plan.missing.map(m => m.recipe_canonical || m.name),
        });
        return fail(
          'MISSING_INGREDIENTS',
          `Can't craft ${itemName} x${count} — need: ${plan.missing.map(m => `${m.short}x ${m.name}`).join(', ')}.`,
          {
            observed_state: {
              item: itemName,
              requested_count: count,
              missing: plan.missing.map(m => ({ name: m.name, short: m.short })),
              started_inventory: startedInventory,
              ...(autoFetched ? { auto_fetched: autoFetched } : {}),
              craft_diag,
            },
            retry_safe: false,
          },
        );
      }

      // ── PaperMCP-first: skip the racy/no-op native window. ──
      // The mineflayer/Paper 1.21 craft no-op (#3399) lands only ~1-in-5 native
      // attempts, so the loop below otherwise burns tries before falling back to the
      // reliable server-side craft. When PaperMCP is configured, do that server-side
      // craft FIRST — one command vs seconds of racing (gv2-2026-06-17-4: ~150 no-op
      // retries starved the colony). This now covers 2x2 recipes too: the assumption
      // "2x2 doesn't hit the race" was false — gv2-2026-06-20-6 had 5 plank no-ops and
      // crafting_table (a 2x2: 4 planks->1 table) consumed planks for 0 result with NO
      // fallback (2x2 got 1 native attempt + no server-side path). Since `ingsIntact`
      // is checked against startedInventory (before any native craft), this fires for
      // crafting_table while the bot still holds its planks -> deterministic clear+give,
      // no native consumption. Bodies WITHOUT PaperMCP fall through to the native loop.
      if (paperMcpConfig()) {
        const requiredIngs = recipeIngredientMap(recipe, ctx.world.mcData);
        const ingsIntact = Object.entries(requiredIngs).every(
          ([n, perCraft]) => (startedInventory[n] || 0) >= perCraft * invocations,
        );
        if (ingsIntact) {
          const fb = await serverSideCraftFallback({
            itemName, count: invocations, recipe, ctx, b,
            getMyName, log, sleep, inventoryAt,
            startedInventory, requiredIngs,
            expectedDelta: invocations * resultPerCraft, reason,
          });
          if (fb) {
            if (requiresBench && table?.position) autoMarkCraftingTable(table.position);
            return fb;
          }
          // server-side craft didn't land — fall through to native attempts.
        }
      }

      // ── Attempt craft, retrying the silent no-op window race. ──
      // For table-required recipes, mineflayer 4.23 + Paper 1.21 has a race
      // where b.craft silently no-ops (returns 0 items, no throw) if the bot
      // isn't oriented + close at the exact moment the open-window packet fires.
      // It's INTERMITTENT — empirically only ~1-in-5 attempts lands — so re-lookAt
      // and retry several times before surrendering. The PaperMCP server-side
      // fallback also covers this, but bodies without PaperMCP configured rely
      // entirely on this in-process retry (which is why a lone attempt made
      // agents see a "broken" craft and give up).
      // 2x2 was 1 attempt on the assumption it never no-ops — false (crafting_table /
      // plank no-ops). Give it a few native retries too (PaperMCP-first already handles
      // the configured case; this covers bodies without PaperMCP).
      const MAX_CRAFT_ATTEMPTS = requiresBench ? 6 : 3;
      let endedInventory = startedInventory;
      let craftedDelta = 0;
      for (let _attempt = 0; _attempt < MAX_CRAFT_ATTEMPTS; _attempt++) {
       if (requiresBench && table) {
        try {
          await b.lookAt(table.position.offset(0.5, 0.5, 0.5), true);
          await sleep(150);
        } catch { /* best-effort */ }
       }
       try {
        await b.craft(recipe, invocations, requiresBench ? table : undefined);
       } catch (err) {
        const msg = /** @type {Error} */ (err).message || String(err);
        // Re-classify mineflayer's raw error string to one of our codes.
        if (/requires crafting.?table|non craftingtable used/i.test(msg)) {
          return fail(
            'TABLE_REQUIRED',
            `mineflayer rejected the craft: ${msg}. Likely block at table position is not actually a crafting_table.`,
            {
              observed_state: { item: itemName, requested_count: count, mineflayer_error: msg },
              retry_safe: false,
            },
          );
        }
        if (/missing/i.test(msg)) {
          // #98: mineflayer occasionally throws "missing ingredients" for
          // 3x3 recipes (fence/bed/etc) even when the bot has plenty —
          // a recipe-slot-layout bug related to the Paper 1.21 click
          // sequence. Before surrendering, check the REAL inventory
          // state: if ingredients ARE present, try the PaperMCP
          // server-side fallback (same path the delta=0 branch uses).
          const requiredIngs = recipeIngredientMap(recipe, ctx.world.mcData);
          const ingsIntact = Object.entries(requiredIngs).every(
            ([n, perCraft]) => (startedInventory[n] || 0) >= perCraft * invocations,
          );
          if (ingsIntact && paperMcpConfig()) {
            const fb = await serverSideCraftFallback({
              itemName, count: invocations, recipe, ctx, b,
              getMyName, log, sleep, inventoryAt,
              startedInventory, requiredIngs, expectedDelta: invocations * resultPerCraft, reason,
            });
            if (fb) {
              // #100: server-side fallback succeeded — the table at
              // `table.position` proved usable; auto-mark it.
              if (requiresBench && table?.position) autoMarkCraftingTable(table.position);
              return fb;
            }
          }
          // Fallback didn't run or didn't help — return the original
          // missing-ingredients diagnostic. ingredientCountsFromSlots
          // computes per-recipe requirements for the agent.
          const slots = recipe.inShape ? recipe.inShape.flat() : recipe.ingredients?.flat() || [];
          const ings = ingredientCountsFromSlots(slots, ctx.world.mcData, count);
          // Equivalence-aware short list. If NONE are short (materials present yet
          // mineflayer threw "missing" — the #98 case), declare all so snapshot_desync trips.
          const shortNames = Object.keys(requiredIngs).filter(
            (n) => countSatisfyingFromMap(n, startedInventory) < requiredIngs[n] * invocations,
          );
          const craft_diag = await buildCraftDiag({
            origin: 'mineflayer_missing_throw', item, itemName, recipe, invocations, requiresBench,
            requiredIngs, startedInventory, endedInventory: inventoryAt(), attempted: true,
            declaredShort: shortNames.length ? shortNames : Object.keys(requiredIngs),
            inventoryAt, sleep,
          });
          return fail(
            'MISSING_INGREDIENTS',
            `Mineflayer reported missing ingredients for ${itemName} x${count}.`,
            {
              observed_state: {
                item: itemName,
                requested_count: count,
                missing: Object.entries(ings).map(([name, short]) => ({ name, short })),
                started_inventory: startedInventory,
                mineflayer_error: msg,
                craft_diag,
              },
              retry_safe: false,
            },
          );
        }
        return fail('INTERRUPTED', `Craft failed mid-flight: ${msg}`, {
          observed_state: { item: itemName, requested_count: count, mineflayer_error: msg },
          retry_safe: true,
        });
       }
       await sleep(250);

       // ── Verify via inventory delta ──
       endedInventory = inventoryAt();
       craftedDelta = (endedInventory[itemName] || 0) - (startedInventory[itemName] || 0);
       if (craftedDelta >= 1) break;            // crafted — stop retrying
       if (_attempt < MAX_CRAFT_ATTEMPTS - 1) {
         try { log?.(`[craft] ${itemName} no-op (mineflayer/Paper window race) — retry ${_attempt + 2}/${MAX_CRAFT_ATTEMPTS}`); } catch {}
         await sleep(300);                       // settle, then re-attempt
       }
      }  // end window-race retry loop
      const expectedDelta = invocations * resultPerCraft;
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
        const requiredIngs = recipeIngredientMap(recipe, ctx.world.mcData);
        const ingsIntact = Object.entries(requiredIngs).every(
          ([n, perCraft]) => (endedInventory[n] || 0) >= perCraft * invocations,
        );
        if (ingsIntact && paperMcpConfig()) {
          const fb = await serverSideCraftFallback({
            itemName, count: invocations, recipe, ctx, b,
            getMyName, log, sleep, inventoryAt,
            startedInventory, requiredIngs, expectedDelta, reason,
          });
          if (fb) {
            // #100: server-side fallback succeeded — auto-mark the table.
            if (requiresBench && table?.position) autoMarkCraftingTable(table.position);
            return fb;
          }
        }
        // #86: turn the cryptic "delta=0" error into something actionable.
        // Compare each ingredient's need vs have. If anything's short, this
        // is really MISSING_INGREDIENTS (the pre-flight may have missed it
        // for an alt-recipe). Otherwise, materials WERE present but the
        // craft no-op'd anyway (Paper bug, no PaperMCP fallback configured).
        const shortfall = Object.entries(requiredIngs).map(([name, perCraft]) => {
          const have = endedInventory[name] || 0;
          const need = perCraft * invocations;
          return { name, have, need, short: Math.max(0, need - have) };
        });
        const missing = shortfall.filter((s) => s.short > 0);
        if (missing.length > 0) {
          const craft_diag = await buildCraftDiag({
            origin: 'delta_noop_missing', item, itemName, recipe, invocations, requiresBench,
            requiredIngs, startedInventory, endedInventory, attempted: true,
            declaredShort: missing.map((s) => s.name), inventoryAt, sleep,
          });
          return fail(
            'MISSING_INGREDIENTS',
            `Can't craft ${itemName} x${count} — missing: ${missing.map((s) => `${s.short}× ${s.name} (have ${s.have}/${s.need})`).join(', ')}.`,
            {
              observed_state: {
                item: itemName,
                requested_count: count,
                expected_delta: expectedDelta,
                observed_delta: craftedDelta,
                missing: missing.map((s) => ({ name: s.name, short: s.short, have: s.have, need: s.need })),
                ingredients_status: shortfall,
                started_inventory: startedInventory,
                craft_diag,
              },
              retry_safe: false,
            },
          );
        }
        // #100: a 3x3 recipe that no-ops with materials intact is almost
        // always a TABLE-RANGE problem, NOT a server fault: mineflayer only
        // crafts a table recipe when a real crafting_table is within ~4 blocks
        // AND the bot is oriented at it. Crafting itself is functional — do not
        // tell the agent the server is broken (that triggers give-up/retry
        // spins). Lead with the concrete fix: stand next to a table and retry.
        let tableDist = null;
        if (requiresBench && table?.position) {
          const bp = b.entity?.position;
          const tp = table.position;
          if (bp && tp && Number.isFinite(bp.x) && Number.isFinite(tp.x)) {
            tableDist = Math.round(Math.hypot(bp.x - (tp.x + 0.5), bp.y - (tp.y + 0.5), bp.z - (tp.z + 0.5)));
          }
        }
        const rangeMsg = !requiresBench
          ? `This is a 2x2 recipe (no table needed); retried up to ${MAX_CRAFT_ATTEMPTS} times.`
          : tableDist == null
            ? `No crafting_table was in range when the craft fired — mineflayer can't craft a table recipe without one within ~4 blocks. Place a crafting_table on solid ground right beside you (mc place crafting_table <x> <y> <z> at an adjacent ground cell) and retry.`
            : tableDist > 4
              ? `A crafting_table was ${tableDist} blocks away — out of the ~4-block working range. Move within 2 blocks of it (or place a fresh one beside you), face it, and retry.`
              : `A crafting_table was in range (${tableDist} block(s)) yet the craft no-op'd — this is the known mineflayer/Paper 1.21 window bug, not a server outage. Retry ONCE; if it persists, place a fresh crafting_table right beside you and retry. Do not declare crafting broken.`;
        const craft_diag = await buildCraftDiag({
          origin: 'delta_noop_materials_present', item, itemName, recipe, invocations, requiresBench,
          requiredIngs, startedInventory, endedInventory, attempted: true,
          declaredShort: [], inventoryAt, sleep,
        });
        return fail(
          'CRAFT_NO_OP',
          `Craft of ${itemName} x${count} produced 0 with materials present (${shortfall.map((s) => `${s.name} ${s.have}/${s.need}`).join(', ')}). Crafting works server-wide — this is a table-range/orientation issue, not a server fault. ${rangeMsg}`,
          {
            observed_state: {
              item: itemName,
              requested_count: count,
              expected_delta: expectedDelta,
              observed_delta: craftedDelta,
              ingredients_status: shortfall,
              table_in_range: requiresBench ? Boolean(table?.position) : null,
              table_distance: tableDist,
              started_inventory: startedInventory,
              ended_inventory: endedInventory,
              craft_diag,
            },
            retry_safe: true,
            next_action_hint: requiresBench
              ? `Place/stand next to a crafting_table (within 2 blocks, on solid ground), then retry ONCE. Do NOT loop-retry or report the server broken — crafting is functional.`
              : `Retry (up to ${MAX_CRAFT_ATTEMPTS} attempts).`,
          },
        );
      }

      // #100: auto-mark a freshly-confirmed crafting_table so future
      // crafts find it via the marks fallback.
      if (requiresBench && table?.position) autoMarkCraftingTable(table.position);

      return ok({
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
          ...(autoFetched ? { auto_fetched: autoFetched } : {}),
          _reason: reason,
        },
        result: `Crafted ${itemName} x${craftedDelta}`,
      });
    },

    async recipes({ item, reason }) {
      const b = ensureBot();
      let itemName;
      try {
        itemName = resolveCraftItemName(item);
      } catch (err) {
        return fail('UNKNOWN_ITEM', /** @type {Error} */ (err).message, {
          observed_state: { requested_item: item },
          retry_safe: false,
        });
      }
      const itemType = ctx.world.mcData.itemsByName[itemName];
      if (!itemType) {
        return fail('UNKNOWN_ITEM', `Unknown item "${itemName}".`, {
          observed_state: { requested_item: item, resolved_to: itemName },
          retry_safe: false,
        });
      }

      // Try multiple recipe lookup methods
      let recipes = b.recipesFor(itemType.id);
      if (!recipes || recipes.length === 0) {
        // Try with crafting table
        const table = b.findBlock({
          matching: ctx.world.mcData.blocksByName.crafting_table?.id,
          maxDistance: 4,
        });
        if (table) recipes = b.recipesFor(itemType.id, null, 1, table);
      }
      if (!recipes || recipes.length === 0) {
        // Try recipesAll
        try { recipes = b.recipesAll(itemType.id, null, 1); } catch {}
      }
      if (!recipes || recipes.length === 0) {
        return ok({
          data: { item: itemName, recipes: [], _reason: reason },
          result: `No crafting recipe for ${itemName}.`,
          recipes: [],
        });
      }

      const formatted = recipes.slice(0, 3).map(r => {
        const slots = r.inShape ? r.inShape.flat() : r.ingredients?.flat() || [];
        const ingredients = ingredientCountsFromSlots(slots, ctx.world.mcData, 1);
        return {
          ingredients,
          needsTable: r.requiresTable !== false,
          makes: r.result?.count || 1,
        };
      });

      return ok({
        data: { item: itemName, recipes: formatted, _reason: reason },
        result: `${formatted.length} recipe(s) for ${itemName}`,
        recipes: formatted,
      });
    },

    async craft_plan({ item, count = 1, reason }) {
      const b = ensureBot();
      let itemName;
      try {
        itemName = resolveCraftItemName(item);
      } catch (err) {
        return fail('UNKNOWN_ITEM', /** @type {Error} */ (err).message, {
          observed_state: { requested_item: item },
          retry_safe: false,
        });
      }
      const plan = buildCraftPlan(b, itemName, Math.max(1, parseInt(count, 10) || 1));
      if (!plan.ok) {
        return fail('PLAN_FAILED', plan.error || 'craft_plan failed', {
          observed_state: { item: itemName, requested_count: count, plan },
          retry_safe: false,
        });
      }
      const parts = [`Plan for ${plan.item} x${plan.count}.`];
      if (plan.missing?.length) {
        const missList = plan.missing.map((m) => {
          let s = `${m.short}x ${m.name}`;
          if (m.in_chests) s += ` (${m.in_chests} in chest @ ${m.chest_locations.join(', ')})`;
          return s;
        });
        parts.push(`Missing: ${missList.join(', ')}`);
      }
      return ok({
        data: { craft_plan: plan, _reason: reason },
        result: parts.join(' '),
        craft_plan: plan,
      });
    },

    async discover({ category, radius = 32, reason }) {
      const b = ensureBot();
      const r = Math.min(64, Math.max(8, parseInt(radius, 10) || 32));
      const cat = String(category || '').toLowerCase();
      const out = { category: cat, blocks: [], entities: [] };

      const ACTIONS = getActions();

      if (cat === 'feathers' || cat === 'chicken') {
        const fe = await ACTIONS.find_entities({ type: 'chicken', radius: r });
        return ok({
          data: { discover: { ...out, entities: fe.entities || [], locations: fe.locations || [] }, _reason: reason },
          result: `Chickens nearby: ${fe.entities?.length || 0}`,
          discover: { ...out, entities: fe.entities || [], locations: fe.locations || [] },
        });
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
        return fail(
          'UNKNOWN_CATEGORY',
          `Unknown discover category "${cat}". Try: logs/wood, food, flint, feathers, stone, coal, iron, copper, gold, diamond, chicken`,
          {
            observed_state: { requested_category: cat, valid_categories: Object.keys(table).concat(['wood', 'feathers', 'chicken']) },
            retry_safe: false,
          },
        );
      }

      for (const blockName of names) {
        try {
          const fb = await ACTIONS.find_blocks({ block: blockName, radius: r, count: 8 });
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

      for (const [markName, snap] of Object.entries(ctx.goals.chestSnapshots)) {
        if (!snap.items?.length) continue;
        for (const ci of snap.items) {
          if (allRelevant.has(ci.name)) {
            chestMatches.push({ name: ci.name, count: ci.count, location: markName, position: snap.position });
          }
        }
      }
      if (chestMatches.length) out.in_chests = chestMatches;

      const chestNote = chestMatches.length ? `, ${chestMatches.length} item(s) in chests` : '';
      return ok({
        data: { discover: out, _reason: reason },
        result: `Discover ${cat}: ${out.blocks.length} block type(s) with sightings${chestNote}`,
        discover: out,
      });
    },
  };

  // ─ F45.2: wallclock cap on craft ─
  // craft pathfind-to-table + opens the crafting window + does the actual
  // recipe — Paper 1.21 can stall inside the inventory window if the
  // server is slow. ACTION_CAPS_MS.craft (30s) is the wallclock backstop.
  const _origCraft = handlers.craft;
  handlers.craft = async function (args) {
    try {
      return await raceWithTimeout(_origCraft(args), ACTION_CAPS_MS.craft, 'craft');
    } catch (err) {
      if (err instanceof OperationTimeoutError || err.code === 'OPERATION_TIMEOUT') {
        const b = ensureBot();
        try { b.pathfinder.setGoal(null); } catch { /* ignore */ }
        try { b.closeWindow?.(b.currentWindow); } catch { /* ignore */ }
        return timeoutError('craft', ACTION_CAPS_MS.craft, {
          requested_item: args?.item,
          requested_count: args?.count,
          bot_position: { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z },
        }, 'Craft was canceled. Inventory may be partially updated; check with mc inventory.');
      }
      throw err;
    }
  };

  return handlers;
}

/**
 * Structured craft diagnostics for the action JSONL (lands in observed_state, not just
 * bot logs). Makes the "craft desync" classes PROVABLE rather than inferred:
 *   failure_origin ∈ { preflight_plan_missing, mineflayer_missing_throw,
 *                      delta_noop_missing, delta_noop_materials_present }
 *   intermediate_available — a declared-short ingredient is itself craftable from a raw
 *                            material on hand (spruce_planks short, spruce_log present) → NOT desync
 *   snapshot_desync (narrow) — the branch declared an ingredient unsatisfiable yet the SAME
 *                            snapshot (equivalence-counted, like recipe selection) has have >= need
 * `declaredShort` is the set of ingredient names the calling branch couldn't satisfy.
 * The settle re-read (inventory_after_settle) only runs when a craft was attempted —
 * catching a result the server materialized a beat after our delta check.
 */
export async function buildCraftDiag({
  origin, item, itemName, recipe, invocations, requiresBench,
  requiredIngs, startedInventory, endedInventory,
  declaredShort = [], attempted = false, inventoryAt = null, sleep = null,
}) {
  const before = startedInventory || {};
  const after = endedInventory || before;
  let settled = after;
  if (attempted && typeof inventoryAt === 'function' && typeof sleep === 'function') {
    try { await sleep(400); settled = inventoryAt(); } catch { /* best-effort */ }
  }
  const need = (n) => (requiredIngs?.[n] || 0) * invocations;
  const ingredients = Object.keys(requiredIngs || {}).map((name) => ({
    name,
    need: need(name),
    have_before: countSatisfyingFromMap(name, before),
    have_after: countSatisfyingFromMap(name, after),
    have_settled: countSatisfyingFromMap(name, settled),
  }));
  const snapshot_desync = declaredShort.some(
    (n) => need(n) > 0 && countSatisfyingFromMap(n, before) >= need(n),
  );
  const intermediate_available = declaredShort.some((n) => {
    const src = intermediateSourceItem(n);
    return !!src && (before[src] || 0) > 0;
  });
  return {
    failure_origin: origin,
    requested_item: item,
    resolved_item: itemName,
    recipe_result: recipe?.result ? { name: recipe.result.name, count: recipe.result.count } : null,
    invocations,
    requires_table: requiresBench,
    selected_recipe_ingredients: requiredIngs || {},
    inventory_before: before,
    inventory_after_attempt: after,
    inventory_after_settle: settled,
    ingredients,
    declared_short: declaredShort,
    intermediate_available,
    snapshot_desync,
  };
}

/**
 * Server-side craft fallback for recipes that mineflayer's b.craft cannot
 * complete on Paper 1.21+ (open mineflayer issue #3399; also some 2x2 cases).
 * Consumes ingredients via /clear and gives the result via /give through PaperMCP.
 * Verifies via inventory delta. Returns null if PaperMCP is unavailable or the
 * fallback itself fails — caller falls through to the original path.
 */
async function serverSideCraftFallback({
  itemName, count, recipe, ctx, b,
  getMyName, log, sleep, inventoryAt,
  startedInventory, requiredIngs, expectedDelta, reason,
}) {
  const pmcpCfg = paperMcpConfig();
  if (!pmcpCfg) return null;
  const username = getMyName();
  if (!username) return null;
  if (log) log(`[craft] server-side craft for ${itemName} x${count} (PaperMCP — avoids native no-op/window race)`);

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
  return ok({
    data: {
      crafted_count: craftedDelta,
      requested_count: count,
      expected_per_craft: recipe.result?.count || 1,
      recipe_used: {
        requires_table: recipe.requiresTable !== false,
        result_per_craft: recipe.result?.count || 1,
        fallback: 'papermcp_server_side',
      },
      ingredients_consumed: ingredientsConsumed,
      started_inventory: startedInventory,
      ended_inventory: endedInventory,
      _reason: reason,
    },
    result: `Crafted ${itemName} x${craftedDelta} (server-side fallback)`,
  });
}

// Exported for contract tests to exercise the 2x2 + PaperMCP fallback path
// without network (by stubbing executeServerCommand on the module namespace).
export { serverSideCraftFallback as __testOnly_serverSideCraftFallback };
