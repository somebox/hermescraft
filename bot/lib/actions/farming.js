/**
 * Farming verbs (Sprint 8): mc till / plant / harvest / bonemeal.
 *
 * Same Paper 1.21+ caveat as buckets — mineflayer's b.activateBlock /
 * b.activateItem against farmland-related blocks silently no-ops on
 * Paper. The action handlers try native first, then fall back to
 * PaperMCP server-side commands (setblock + clear/give) to keep
 * inventory + world state consistent.
 */

import { Vec3 } from 'vec3';
import { executeServerCommand, paperMcpConfig } from '../runtime/paper-mcp.js';
import { columnTopSolid } from '../runtime/dig-tools.js';
import { findAdjustedTarget, botFootCell, findLateralStepOff } from './_nav-helpers.js';
import { AIR_NAMES } from './_block-sets.js';
import { pathfindGotoNear, ACTION_CAPS_MS } from './_helpers.js';
import { runVerifyPlot, runFarmStatus, MAX_VERIFY_CELLS } from './_farming-survey.js';
import { columnsInRect } from '../runtime/regions/terrain-survey.js';

const HOE_NAMES = ['netherite_hoe', 'diamond_hoe', 'iron_hoe', 'stone_hoe', 'golden_hoe', 'wooden_hoe'];
const TILLABLE = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'dirt_path']);

/** Pure predicate: is the block at (x,y,z) tillable by a hoe? */
export function isTillableAt(b, x, y, z) {
  const blk = b?.blockAt && b.blockAt(new Vec3(x, y, z));
  return !!blk && TILLABLE.has(blk.name);
}

/**
 * Surface scan: from (x, y, z) walk DOWN up to `maxDrop` cells looking
 * for the first tillable block (i.e. the actual topmost dirt/grass at
 * this column). Returns the cell's coords + drop distance, or null if
 * nothing tillable within range.
 *
 * Motivating bug t_10ec0479 (2026-05-24): Mason called `mc till` at
 * (363,65,-573) but the plot terrain is uneven — true surface at that
 * column is at y=63 (y=64 and y=65 are air). The previous self-adjust
 * was an isotropic radius-1 spiral which can't reach a surface 2+
 * cells below the requested cell. A directional downward scan handles
 * this directly: tillable terrain only exists IN columns, not above
 * them, so when the requested cell is air the right answer is "look
 * down".
 */
export function findTillableSurfaceBelow(b, x, y, z, maxDrop = 4) {
  if (!b?.blockAt) return null;
  for (let dy = 0; dy <= maxDrop; dy++) {
    const cy = y - dy;
    const blk = b.blockAt(new Vec3(x, cy, z));
    if (!blk) return null;
    if (TILLABLE.has(blk.name)) return { x, y: cy, z, drop: dy };
    // Stop as soon as we hit a non-air solid that's not tillable — there
    // can't be tillable surface below stone/cobble/etc.
    if (!AIR_NAMES.has(blk.name)) return null;
  }
  return null;
}

/** Pure predicate: is the block at (x,y,z) plantable (farmland surface)? */
export function isFarmlandAt(b, x, y, z) {
  const blk = b?.blockAt && b.blockAt(new Vec3(x, y, z));
  return !!blk && blk.name === 'farmland';
}

// Items that go on farmland (top of farmland block).
// Map: item-in-inventory → block-name-placed.
const FARMLAND_CROPS = {
  wheat_seeds: 'wheat',
  beetroot_seeds: 'beetroots',
  carrot: 'carrots',
  potato: 'potatoes',
  melon_seeds: 'melon_stem',
  pumpkin_seeds: 'pumpkin_stem',
};

// Items that go on dirt/grass directly (not farmland).
const SOIL_CROPS = {
  oak_sapling: 'oak_sapling',
  birch_sapling: 'birch_sapling',
  spruce_sapling: 'spruce_sapling',
  jungle_sapling: 'jungle_sapling',
  acacia_sapling: 'acacia_sapling',
  dark_oak_sapling: 'dark_oak_sapling',
  cherry_sapling: 'cherry_sapling',
  mangrove_propagule: 'mangrove_propagule',
  sugar_cane: 'sugar_cane',
};

const ALL_PLANTABLES = { ...FARMLAND_CROPS, ...SOIL_CROPS };

// "Mature" crop ages — vanilla crops are age 7, beetroot is 3.
const MATURE_AGE = {
  wheat: 7,
  carrots: 7,
  potatoes: 7,
  beetroots: 3,
};

/**
 * Resolve the harvest Y level when the caller omitted Y.
 *
 * Round-A hyd2: bot at `entity.position.y = 63.999...` (just settled
 * on farmland), `Math.floor` returns 63 — but the wheat blocks are
 * at y=64. The 4-arg form `mc harvest X1 Z1 X2 Z2` then searched the
 * farmland row, found 0 crops, returned NOTHING_TO_HARVEST. Bot
 * burned ~2 minutes guessing argument forms before stumbling onto
 * the 5-arg form with explicit Y=64.
 *
 * Strategy: probe footY-1, footY, footY+1 with `getBlock` and pick
 * the Y level containing the most crop blocks in the rect. This
 * handles:
 *   - Float-noise just-below-the-block-boundary (footY-1 catches it
 *     when bot is slightly above the wheat row).
 *   - Standing-on-farmland-with-crops (footY catches it).
 *   - Bot one block above the patch (footY+1 catches it — e.g. brain
 *     pillared up and forgot to come down).
 *
 * Pure function for testing — caller supplies a `blockAt(pos)` probe.
 *
 * @param {{minX:number, maxX:number, minZ:number, maxZ:number, footY:number, blockAt:(p:{x:number,y:number,z:number})=>{name:string}|null}} args
 * @returns {{y:number, count:number}}
 */
export function resolveHarvestY({ minX, maxX, minZ, maxZ, footY, blockAt }) {
  const candidates = [footY - 1, footY, footY + 1];
  let bestY = footY;
  // Init to 0 so a "no crops anywhere" search returns footY (the
  // handler then reports NOTHING_TO_HARVEST), and ties between
  // candidates resolve to whichever Y was scanned FIRST that hit a
  // non-zero count — i.e. footY-1 wins ties with footY.
  let bestCount = 0;
  for (const y of candidates) {
    let cnt = 0;
    for (let xi = minX; xi <= maxX; xi++) {
      for (let zi = minZ; zi <= maxZ; zi++) {
        const blk = blockAt({ x: xi, y, z: zi });
        if (blk && MATURE_AGE[blk.name] !== undefined) cnt++;
      }
    }
    if (cnt > bestCount) { bestCount = cnt; bestY = y; }
  }
  return { y: bestY, count: bestCount };
}

export function createFarmingActions(deps) {
  const { ctx, ensureBot, goals, sleep, posObj, log, getMyName, ACTIONS, loadLocations } = deps;

  const inventoryAt = (b) =>
    b.inventory.items().reduce((acc, it) => {
      acc[it.name] = (acc[it.name] || 0) + it.count;
      return acc;
    }, /** @type {Record<string, number>} */ ({}));

  function findFirstHoe(b) {
    for (const name of HOE_NAMES) {
      const it = b.inventory.items().find((i) => i.name === name);
      if (it) return it;
    }
    return null;
  }

  const actions = {
    /**
     * Till a single dirt/grass block at (x, y, z) → farmland.
     * Action contract: NO_HOE, NOT_TILLABLE, OUT_OF_RANGE, UNCHANGED.
     */
    async till({ x, y, z }) {
      const b = ensureBot();
      const targetPos = new Vec3(Number(x), Number(y), Number(z));

      const hoe = findFirstHoe(b);
      if (!hoe) {
        return { ok: false, error: {
          code: 'NO_HOE',
          message: 'No hoe in inventory. Craft one (mc craft wooden_hoe) first.',
          observed_state: { inventory_hoes: [] },
          retry_safe: false,
        }};
      }

      let target = b.blockAt(targetPos);
      let adjustedTarget = null;
      if (!target || !TILLABLE.has(target.name)) {
        // Two-stage adjust (t_10ec0479, 2026-05-24):
        //
        // 1. If the requested cell is air (agent guessed too high for
        //    uneven terrain), scan DOWN up to 4 cells for the true
        //    surface. This is the dominant farm-plot failure mode:
        //    Mason called `mc till` at (363,65,-573) but the actual
        //    grass was 2 cells below at y=63.
        //
        // 2. Otherwise (or if the down-scan finds nothing) fall back
        //    to a radius-3 isotropic spiral. Old radius was 1, which
        //    couldn't catch off-by-2-or-more guesses in any axis;
        //    bumped to 3 so the till action is forgiving of minor
        //    coord drift in the agent's plot mental model.
        const TILL_SCAN_DROP = 4;
        const TILL_SPIRAL_RADIUS = 3;
        let adj = null;
        if (target && AIR_NAMES.has(target.name)) {
          const surf = findTillableSurfaceBelow(b, Number(x), Number(y), Number(z), TILL_SCAN_DROP);
          if (surf) {
            adj = { x: surf.x, y: surf.y, z: surf.z, distance: surf.drop };
          }
        }
        if (!adj) {
          adj = findAdjustedTarget(b, isTillableAt, Number(x), Number(y), Number(z), TILL_SPIRAL_RADIUS);
        }
        if (!adj) {
          const targetName = target?.name ?? 'unloaded';
          const hint = targetName === 'air' || (target && AIR_NAMES.has(target.name))
            ? `mc farm verify_plot … or mc inspect ${x} ${y - 1} ${z} — surface may be below requested Y.`
            : `mc farm verify_plot … — no tillable block within ${TILL_SPIRAL_RADIUS} horizontally or ${TILL_SCAN_DROP} below.`;
          return { ok: false, error: {
            code: 'NOT_TILLABLE',
            message: `Block at (${x},${y},${z}) is ${targetName} and no tillable cell within ${TILL_SPIRAL_RADIUS} blocks or ${TILL_SCAN_DROP} below — only dirt/grass/coarse_dirt can be tilled. Not a region permission issue.`,
            observed_state: { target_block: targetName, requested_coord: { x, y, z }, tillable: [...TILLABLE], searched_radius: TILL_SPIRAL_RADIUS, searched_drop: TILL_SCAN_DROP },
            next_action_hint: hint,
            retry_safe: false,
          }};
        }
        adjustedTarget = adj;
        targetPos.x = adj.x; targetPos.y = adj.y; targetPos.z = adj.z;
        target = b.blockAt(targetPos);
        log(`[till] adjusted target from (${x},${y},${z}) to (${adj.x},${adj.y},${adj.z}) — distance ${adj.distance}`);
      }

      if (b.entity.position.distanceTo(targetPos) > 4.5) {
        try {
          await pathfindGotoNear(b, goals, Number(x), Number(y), Number(z), 3, { opName: 'farm_reach', capMs: ACTION_CAPS_MS.reach });
        } catch {
          return { ok: false, error: {
            code: 'OUT_OF_RANGE',
            message: `Target at (${x},${y},${z}) is ${Math.round(b.entity.position.distanceTo(targetPos) * 10) / 10} blocks away and pathfind failed.`,
            observed_state: { distance: b.entity.position.distanceTo(targetPos), bot_position: posObj(b.entity.position) },
            retry_safe: false,
          }};
        }
      }

      // If the bot is standing ON the target (foot cell directly above it),
      // the bot's hitbox occludes the top face — native activateBlock
      // silently no-ops and we always fall through to the PaperMCP setblock
      // path. Step laterally onto a walkable neighbor first so the till
      // happens via the normal interaction route. The lateral step also
      // avoids the cosmetic foot-drop when grass→farmland (farmland height
      // 0.9375 vs full block 1.0).
      let stepOff = null;
      const foot = botFootCell(b);
      if (foot.x === targetPos.x && foot.z === targetPos.z && foot.y === targetPos.y + 1) {
        const step = findLateralStepOff(b, targetPos.x, foot.y, targetPos.z);
        if (step) {
          try {
            await pathfindGotoNear(b, goals, step.x, step.y, step.z, 1, { opName: 'till_step_off', capMs: ACTION_CAPS_MS.reach });
            stepOff = step;
            log(`[till] stepped off target column (${targetPos.x},${targetPos.z}) → standing at (${step.x},${step.y},${step.z})`);
          } catch { /* couldn't step off; proceed and let PaperMCP fallback handle it */ }
        }
      }

      try { await b.equip(hoe, 'hand'); } catch (err) {
        return { ok: false, error: { code: 'INTERRUPTED', message: `equip ${hoe.name} failed: ${err.message}`, retry_safe: true }};
      }

      // Try native first. Same Paper-1.21+ activate-block silent no-op as buckets.
      try {
        await b.lookAt(targetPos.offset(0.5, 0.5, 0.5), true);
        await sleep(100);
        await b.activateBlock(target);
        await sleep(400);
      } catch { /* fall through */ }
      let after = b.blockAt(targetPos);
      let fallback = null;
      let papermcpError = null;
      if (after?.name !== 'farmland') {
        const pmcp = paperMcpConfig();
        if (pmcp) {
          log(`[till] native no-op (block still ${after?.name}) — using PaperMCP fallback`);
          const r = await executeServerCommand(pmcp, `setblock ${targetPos.x} ${targetPos.y} ${targetPos.z} minecraft:farmland`);
          if (r.ok) {
            for (let i = 0; i < 6; i++) {
              await sleep(150);
              after = b.blockAt(targetPos);
              if (after?.name === 'farmland') break;
            }
            fallback = 'papermcp_server_side';
          } else {
            papermcpError = r.error || 'PaperMCP setblock failed';
            log(`[till] PaperMCP fallback failed: ${papermcpError}`);
          }
        }
      }
      if (after?.name !== 'farmland') {
        const below = b.blockAt(targetPos.offset(0, -1, 0));
        const floating = below && AIR_NAMES.has(below.name) && TILLABLE.has(after?.name ?? '');
        return { ok: false, error: {
          code: 'UNCHANGED',
          message: `Tilled (${targetPos.x},${targetPos.y},${targetPos.z}) but block is still ${after?.name ?? 'unloaded'}, expected farmland. Not a region permission issue — Paper native hoe often no-ops; server-side fallback may have failed or chunk did not sync.`,
          observed_state: {
            target_block_after: after?.name,
            fallback_attempted: !!paperMcpConfig(),
            papermcp_error: papermcpError,
            adjusted_target: adjustedTarget ?? undefined,
            requested_coord: { x, y, z },
            floating_surface: floating || undefined,
          },
          next_action_hint: floating
            ? 'mc farm verify_plot … — floating tillable top; fill column below before till.'
            : (papermcpError ? 'help-needed:till_unchanged:papermcp' : 'help-needed:till_unchanged — retry once or mc farm verify_plot'),
          retry_safe: true,
        }};
      }
      return {
        ok: true,
        data: {
          tilled_coord: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
          hoe: hoe.name,
          ...(adjustedTarget ? { adjusted_target: adjustedTarget } : {}),
          ...(stepOff ? { stepped_off_target: stepOff } : {}),
          ...(fallback ? { fallback } : {}),
        },
        result: `Tilled ${target.name} → farmland at ${targetPos.x},${targetPos.y},${targetPos.z}${adjustedTarget ? ` (adjusted from ${x},${y},${z})` : ''}${stepOff ? ` (stepped off target)` : ''}${fallback ? ' (server-side fallback)' : ''}.`,
      };
    },

    /**
     * Plant a seed/sapling at (x, y, z). For farmland crops (wheat,
     * beetroot, carrot, potato), the soil at (x, y-1, z) must be farmland
     * and we place the crop block AT (x, y, z). For saplings/sugar_cane,
     * the soil at (x, y-1, z) must be dirt/grass.
     * Action contract: NO_SEEDS, NOT_FARMLAND, BLOCKED, UNCHANGED.
     */
    async plant({ item, x, y, z }) {
      const b = ensureBot();
      const itemName = String(item);
      const targetPos = new Vec3(Number(x), Number(y), Number(z));
      const soilPos = targetPos.offset(0, -1, 0);

      const wantsFarmland = itemName in FARMLAND_CROPS;
      const wantsSoil = itemName in SOIL_CROPS;
      if (!wantsFarmland && !wantsSoil) {
        return { ok: false, error: {
          code: 'UNKNOWN_PLANTABLE',
          message: `"${itemName}" isn't a known plantable. Try one of: ${Object.keys(ALL_PLANTABLES).join(', ')}.`,
          observed_state: { requested: itemName },
          retry_safe: false,
        }};
      }

      const seed = b.inventory.items().find((i) => i.name === itemName);
      if (!seed) {
        return { ok: false, error: {
          code: 'NO_SEEDS',
          message: `No ${itemName} in inventory.`,
          observed_state: { requested: itemName, have: b.inventory.items().map((i) => i.name) },
          retry_safe: false,
        }};
      }

      // Task #7 self-adjust: if exact target isn't plantable, scan within
      // 1 block for a cell where (a) the cell ITSELF is air-like and
      // (b) the cell BELOW it is the correct soil type. circuit-v[3-4]
      // hits: agent off by 1 Y (plant row vs soil row) — the adjust
      // converts a NOT_FARMLAND/BLOCKED error into a successful plant
      // at the right Y.
      let adjustedTarget = null;
      const SOIL_NAMES = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol']);
      const isPlantableHere = (bot, px, py, pz) => {
        const here = bot?.blockAt && bot.blockAt(new Vec3(px, py, pz));
        const below = bot?.blockAt && bot.blockAt(new Vec3(px, py - 1, pz));
        if (!here || !below) return false;
        if (!AIR_NAMES.has(here.name)) return false;
        if (wantsFarmland) return below.name === 'farmland';
        if (wantsSoil) return SOIL_NAMES.has(below.name);
        return false;
      };

      let soil = b.blockAt(soilPos);
      let existing = b.blockAt(targetPos);
      const needsAdjust = !isPlantableHere(b, Number(x), Number(y), Number(z));
      if (needsAdjust) {
        const adj = findAdjustedTarget(b, isPlantableHere, Number(x), Number(y), Number(z), 1);
        if (adj) {
          adjustedTarget = adj;
          targetPos.x = adj.x; targetPos.y = adj.y; targetPos.z = adj.z;
          soilPos.x = adj.x; soilPos.y = adj.y - 1; soilPos.z = adj.z;
          soil = b.blockAt(soilPos);
          existing = b.blockAt(targetPos);
          log(`[plant] adjusted target from (${x},${y},${z}) to (${adj.x},${adj.y},${adj.z}) — distance ${adj.distance}`);
        }
      }

      if (wantsFarmland && soil?.name !== 'farmland') {
        return { ok: false, error: {
          code: 'NOT_FARMLAND',
          message: `Soil at (${targetPos.x},${targetPos.y - 1},${targetPos.z}) is ${soil?.name ?? 'unloaded'} and no farmland within 1 block, expected farmland. Till it first.`,
          observed_state: { target_soil: soil?.name, requested: itemName, requested_coord: { x, y, z }, searched_radius: 1 },
          next_action_hint: `mc till ${x} ${y - 1} ${z}`,
          retry_safe: false,
        }};
      }
      if (wantsSoil && !SOIL_NAMES.has(soil?.name)) {
        return { ok: false, error: {
          code: 'WRONG_SOIL',
          message: `Soil at (${targetPos.x},${targetPos.y - 1},${targetPos.z}) is ${soil?.name} and no dirt/grass within 1 block, this plantable needs dirt/grass.`,
          observed_state: { target_soil: soil?.name, requested: itemName, requested_coord: { x, y, z }, searched_radius: 1 },
          retry_safe: false,
        }};
      }

      if (existing && existing.name !== 'air' && existing.name !== 'cave_air') {
        return { ok: false, error: {
          code: 'BLOCKED',
          message: `Target (${targetPos.x},${targetPos.y},${targetPos.z}) is ${existing.name}, not air.`,
          observed_state: { target_block: existing.name, requested_coord: { x, y, z } },
          retry_safe: false,
        }};
      }

      if (b.entity.position.distanceTo(targetPos) > 4.5) {
        try { await pathfindGotoNear(b, goals, Number(x), Number(y), Number(z), 3, { opName: 'farm_reach', capMs: ACTION_CAPS_MS.reach }); }
        catch {
          return { ok: false, error: { code: 'OUT_OF_RANGE', message: `pathfind failed to (${x},${y},${z})`, retry_safe: false }};
        }
      }

      // If the bot's foot cell IS the crop's target cell (bot is standing
      // on the soil/farmland this crop should sit on), placeBlock fails —
      // the crop wants the cell the bot occupies. Step laterally so the
      // crop cell is free, then plant from the side. Bot's foot cell could
      // also be the soil cell (foot.y == targetPos.y - 1 == soilPos.y),
      // which is a separate case: bot standing ON the soil but with feet
      // INSIDE the crop cell — same fix.
      let stepOff = null;
      const foot = botFootCell(b);
      const occupiesTarget = foot.x === targetPos.x && foot.z === targetPos.z &&
        (foot.y === targetPos.y || foot.y === soilPos.y);
      if (occupiesTarget) {
        const step = findLateralStepOff(b, targetPos.x, foot.y, targetPos.z);
        if (step) {
          try {
            await pathfindGotoNear(b, goals, step.x, step.y, step.z, 1, { opName: 'plant_step_off', capMs: ACTION_CAPS_MS.reach });
            stepOff = step;
            log(`[plant] stepped off target column (${targetPos.x},${targetPos.z}) → standing at (${step.x},${step.y},${step.z})`);
          } catch { /* couldn't step off; proceed and let PaperMCP fallback handle it */ }
        }
      }

      try { await b.equip(seed, 'hand'); } catch (err) {
        return { ok: false, error: { code: 'INTERRUPTED', message: `equip ${itemName} failed: ${err.message}`, retry_safe: true }};
      }

      const before = inventoryAt(b);
      // Try native — placeBlock on the soil with face up.
      try {
        await b.lookAt(soilPos.offset(0.5, 1, 0.5), true);
        await sleep(100);
        await b.placeBlock(soil, new Vec3(0, 1, 0));
        await sleep(300);
      } catch { /* fall through */ }
      let placed = b.blockAt(targetPos);
      let fallback = null;
      const cropBlockName = ALL_PLANTABLES[itemName];
      if (placed?.name !== cropBlockName) {
        const pmcp = paperMcpConfig();
        const username = getMyName?.();
        if (pmcp && username) {
          log(`[plant] native no-op (block ${placed?.name}) — using PaperMCP fallback for ${itemName}`);
          const r1 = await executeServerCommand(pmcp, `clear ${username} minecraft:${itemName} 1`);
          // Bug fix: drop `execute in landfolk-test` hardcoded test-world
          // wrapper (same class as commit 631dbb5). Use targetPos coords
          // (post-adjust), not original x,y,z.
          const r2 = await executeServerCommand(pmcp, `setblock ${targetPos.x} ${targetPos.y} ${targetPos.z} minecraft:${cropBlockName}`);
          if (r1.ok && r2.ok) {
            for (let i = 0; i < 6; i++) {
              await sleep(150);
              placed = b.blockAt(targetPos);
              if (placed?.name === cropBlockName) break;
            }
            fallback = 'papermcp_server_side';
          }
        }
      }
      const after = inventoryAt(b);
      if (placed?.name !== cropBlockName) {
        return { ok: false, error: {
          code: 'UNCHANGED',
          message: `Planted ${itemName} at (${targetPos.x},${targetPos.y},${targetPos.z}) but block is ${placed?.name ?? 'unloaded'}, expected ${cropBlockName}.`,
          observed_state: { target_block_after: placed?.name, started_inventory: before, ended_inventory: after },
          retry_safe: true,
        }};
      }
      return {
        ok: true,
        data: {
          planted: itemName,
          crop_block: cropBlockName,
          target_coord: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
          ...(adjustedTarget ? { adjusted_target: adjustedTarget } : {}),
          ...(stepOff ? { stepped_off_target: stepOff } : {}),
          ...(fallback ? { fallback } : {}),
        },
        result: `Planted ${itemName} at ${targetPos.x},${targetPos.y},${targetPos.z}${adjustedTarget ? ` (adjusted from ${x},${y},${z})` : ''}${stepOff ? ` (stepped off target)` : ''}${fallback ? ' (server-side fallback)' : ''}.`,
      };
    },

    /**
     * Apply bone meal to a crop. Native: equip bone_meal, activate block.
     * Fallback: server-side increment of the block's age property until
     * mature, plus clear bone_meal from inventory.
     */
    async bonemeal({ x, y, z }) {
      const b = ensureBot();
      const targetPos = new Vec3(Number(x), Number(y), Number(z));

      const meal = b.inventory.items().find((i) => i.name === 'bone_meal');
      if (!meal) {
        return { ok: false, error: {
          code: 'NO_BONEMEAL',
          message: 'No bone_meal in inventory.',
          observed_state: { inventory: b.inventory.items().filter((i) => i.name.includes('bone')).map((i) => i.name) },
          retry_safe: false,
        }};
      }

      const target = b.blockAt(targetPos);
      if (!target) {
        return { ok: false, error: { code: 'NOT_GROWABLE', message: `No block at (${x},${y},${z}).`, retry_safe: false }};
      }
      const matureAge = MATURE_AGE[target.name];
      const isCrop = matureAge !== undefined;

      if (b.entity.position.distanceTo(targetPos) > 4.5) {
        try { await pathfindGotoNear(b, goals, Number(x), Number(y), Number(z), 3, { opName: 'farm_reach', capMs: ACTION_CAPS_MS.reach }); }
        catch {
          return { ok: false, error: { code: 'OUT_OF_RANGE', message: `pathfind failed to (${x},${y},${z})`, retry_safe: false }};
        }
      }

      try { await b.equip(meal, 'hand'); } catch (err) {
        return { ok: false, error: { code: 'INTERRUPTED', message: `equip bone_meal failed: ${err.message}`, retry_safe: true }};
      }

      const before = inventoryAt(b);
      try {
        await b.lookAt(targetPos.offset(0.5, 0.5, 0.5), true);
        await sleep(100);
        await b.activateBlock(target);
        await sleep(300);
      } catch { /* fall through */ }
      // Fallback: setblock the crop with age=mature (or +1 step).
      let placed = b.blockAt(targetPos);
      let fallback = null;
      if (isCrop) {
        const props = placed?.getProperties?.() || {};
        const curAge = Number(props.age ?? 0);
        if (curAge < matureAge) {
          const pmcp = paperMcpConfig();
          const username = getMyName?.();
          if (pmcp && username) {
            log(`[bonemeal] native didn't advance age (${curAge}) — PaperMCP fallback to mature`);
            const r1 = await executeServerCommand(pmcp, `clear ${username} minecraft:bone_meal 1`);
            const r2 = await executeServerCommand(pmcp, `setblock ${x} ${y} ${z} minecraft:${target.name}[age=${matureAge}]`);
            if (r1.ok && r2.ok) {
              for (let i = 0; i < 6; i++) {
                await sleep(150);
                placed = b.blockAt(targetPos);
                if (placed?.name === target.name) break;
              }
              fallback = 'papermcp_server_side';
            }
          }
        }
      }
      const after = inventoryAt(b);
      const finalProps = placed?.getProperties?.() || {};
      const finalAge = Number(finalProps.age ?? 0);
      const mealConsumed = (before.bone_meal || 0) - (after.bone_meal || 0);
      if (mealConsumed < 1 && fallback === null) {
        return { ok: false, error: {
          code: 'BONEMEAL_FAILED',
          message: `bone_meal didn't do anything to ${target.name} at (${x},${y},${z}).`,
          observed_state: { target_block: target.name, age: finalAge, started_inventory: before, ended_inventory: after },
          retry_safe: true,
        }};
      }
      return {
        ok: true,
        data: {
          target_block: target.name,
          age_before: isCrop ? Number((target.getProperties?.() || {}).age ?? 0) : null,
          age_after: isCrop ? finalAge : null,
          is_mature: isCrop ? finalAge >= matureAge : null,
          bone_meal_consumed: mealConsumed,
          ...(fallback ? { fallback } : {}),
        },
        result: `Bonemealed ${target.name} at ${x},${y},${z}${fallback ? ' (server-side fallback)' : ''}.`,
      };
    },

    /**
     * Harvest mature crops in an axis-aligned rectangle at the given Y.
     * If Y is omitted, defaults to the bot's foot Y. Skips immature
     * crops (returns their count). Picks up drops.
     */
    async harvest({ x1, z1, x2, z2, y }) {
      const b = ensureBot();
      const minX = Math.min(Number(x1), Number(x2));
      const maxX = Math.max(Number(x1), Number(x2));
      const minZ = Math.min(Number(z1), Number(z2));
      const maxZ = Math.max(Number(z1), Number(z2));
      const yWasProvided = y !== undefined;
      let harvestY;
      if (yWasProvided) {
        harvestY = Number(y);
      } else {
        const footY = Math.floor(b.entity.position.y);
        const resolved = resolveHarvestY({
          minX, maxX, minZ, maxZ, footY,
          blockAt: (p) => b.blockAt(new Vec3(p.x, p.y, p.z)),
        });
        harvestY = resolved.y;
      }

      const before = inventoryAt(b);
      let mature = 0;
      let immatureCount = 0;
      const immature = [];

      for (let xi = minX; xi <= maxX; xi++) {
        for (let zi = minZ; zi <= maxZ; zi++) {
          const pos = new Vec3(xi, harvestY, zi);
          const blk = b.blockAt(pos);
          if (!blk) continue;
          const matureAge = MATURE_AGE[blk.name];
          if (matureAge === undefined) continue; // not a crop
          const age = Number((blk.getProperties?.() || {}).age ?? 0);
          if (age < matureAge) {
            immatureCount++;
            immature.push({ x: xi, y: harvestY, z: zi, name: blk.name, age });
            continue;
          }
          if (b.entity.position.distanceTo(pos) > 4.5) {
            try { await pathfindGotoNear(b, goals, xi, harvestY, zi, 3, { opName: 'farm_harvest', capMs: ACTION_CAPS_MS.reach }); }
            catch { continue; }
          }
          try {
            await b.dig(blk, true);
            mature++;
            await sleep(150);
          } catch { /* skip */ }
        }
      }

      // Pickup pass
      await sleep(500);
      try { await ACTIONS.pickup({}); } catch { /* best-effort */ }

      const after = inventoryAt(b);
      if (mature === 0 && immatureCount === 0) {
        const yHint = !yWasProvided
          ? ` Y was auto-detected as ${harvestY} from your foot position; if crops sit at a different Y (raised platform, you pillared up), pass Y explicitly: mc harvest ${minX} ${minZ} ${maxX} ${maxZ} <Y>. Y is the LAST argument, not interleaved with coords.`
          : '';
        return { ok: false, error: {
          code: 'NOTHING_TO_HARVEST',
          message: `No crops found in rectangle (${minX},${harvestY},${minZ})-(${maxX},${harvestY},${maxZ}).${yHint}`,
          observed_state: {
            searched_blocks: (maxX - minX + 1) * (maxZ - minZ + 1),
            searched_y: harvestY,
            y_was_provided: yWasProvided,
            bot_foot_y: Math.floor(b.entity.position.y),
          },
          next_action_hint: !yWasProvided
            ? `mc harvest ${minX} ${minZ} ${maxX} ${maxZ} ${Math.floor(b.entity.position.y) + 1}`
            : undefined,
          retry_safe: false,
        }};
      }

      const gained = {};
      for (const [n, c] of Object.entries(after)) {
        const diff = c - (before[n] || 0);
        if (diff > 0) gained[n] = diff;
      }
      return {
        ok: true,
        data: {
          harvested_count: mature,
          skipped_immature: immatureCount,
          immature_blocks: immature.slice(0, 8),
          inventory_gained: gained,
          bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ, y: harvestY },
        },
        result: `Harvested ${mature} mature crops${immatureCount ? ` (${immatureCount} immature skipped)` : ''}. Gained: ${Object.entries(gained).map(([n, c]) => `${c}x ${n}`).join(', ') || 'nothing'}.`,
      };
    },

    /**
     * Dry-run a construct plot: worksite coverage, flatness, till readiness.
     */
    async verify_plot(body) {
      return runVerifyPlot({ ctx, ensureBot }, body || {});
    },

    /**
     * Per-cell plot categorization: counts of harvestable / planted /
     * tilled / empty_soil + sample coords + next-action hint. The "what's
     * the state of this plot, what should I do next?" verb.
     */
    async farm_status(body) {
      let req = body || {};
      if (req.mark) {
        const locs = loadLocations ? loadLocations() : {};
        const m = locs[String(req.mark)];
        if (!m) {
          return {
            ok: false,
            error: {
              code: 'UNKNOWN_MARK',
              message: `Unknown mark '${req.mark}'`,
              retry_safe: false,
            },
          };
        }
        const size = Number(req.size) || 9;
        const half = Math.floor(size / 2);
        req = {
          ...req,
          x1: m.x - half,
          z1: m.z - half,
          x2: m.x + half,
          z2: m.z + half,
        };
        delete req.mark;
        delete req.size;
      }
      return runFarmStatus({ ctx, ensureBot }, req);
    },
  };

  actions.till_area = async function till_area({ x1, z1, x2, z2, y }) {
      const b = ensureBot();
      const minX = Math.min(Number(x1), Number(x2));
      const maxX = Math.max(Number(x1), Number(x2));
      const minZ = Math.min(Number(z1), Number(z2));
      const maxZ = Math.max(Number(z1), Number(z2));
      const cols = columnsInRect(minX, minZ, maxX, maxZ);
      if (cols.length > MAX_VERIFY_CELLS) {
        return { ok: false, error: {
          code: 'RECT_TOO_LARGE',
          message: `till_area has ${cols.length} columns; max ${MAX_VERIFY_CELLS}.`,
          retry_safe: false,
        }};
      }

      const hintY = y !== undefined ? Number(y) : Math.floor(b.entity.position.y) - 1;
      let tilled = 0;
      let skipped_farmland = 0;
      let failed = 0;
      /** @type {object[]} */
      const failures_sample = [];

      for (const { x, z } of cols) {
        const top = columnTopSolid(b, x, z);
        if (!top) {
          failed++;
          if (failures_sample.length < 8) failures_sample.push({ x, z, code: 'NO_SOLID' });
          continue;
        }
        if (top.blockName === 'farmland') {
          skipped_farmland++;
          continue;
        }
        let ty = top.topY;
        if (y !== undefined) {
          const surf = findTillableSurfaceBelow(b, x, Number(y), z, 4);
          if (surf) ty = surf.y;
          else if (!TILLABLE.has(top.blockName)) {
            failed++;
            if (failures_sample.length < 8) failures_sample.push({ x, z, code: 'NOT_TILLABLE', topY: top.topY });
            continue;
          }
        }
        const res = await actions.till({ x, y: ty, z });
        if (res.ok) tilled++;
        else {
          failed++;
          if (failures_sample.length < 8) {
            failures_sample.push({
              x, z, y: ty,
              code: res.error?.code ?? 'FAIL',
              message: res.error?.message,
            });
          }
        }
      }

      const ok = failed === 0 || tilled > 0;
      return {
        ok,
        data: {
          tilled,
          skipped_farmland,
          failed,
          bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ, y_hint: hintY },
          failures_sample,
        },
        result: `till_area: ${tilled} tilled, ${skipped_farmland} already farmland, ${failed} failed.`,
        ...(failed > 0 && tilled === 0 ? {
          error: {
            code: 'TILL_AREA_FAILED',
            message: `All ${failed} columns failed to till.`,
            observed_state: { failures_sample },
            next_action_hint: 'mc farm verify_plot … before retry',
            retry_safe: true,
          },
        } : {}),
    };
  };

  return actions;
}
