import { Vec3 } from 'vec3';
import { gotoWithTimeout } from '../goto-with-timeout.js';
import { AIR_NAMES } from '../../_block-sets.js';

/**
 * Given an item name (e.g. "cobblestone"), return the list of OTHER block
 * names whose drops include that item (e.g. ["stone"] for cobblestone).
 * Used by `mc collect` to fall back to source blocks when no blocks of the
 * requested name are present in the world — in survival the player asks
 * for the drop ("cobblestone") but actually needs to mine the source
 * ("stone"). Returns [] if there's no mcData item or no source blocks.
 */
export function sourceBlocksForItem(mcData, itemName) {
  const item = mcData.itemsByName?.[itemName];
  if (!item) return [];
  const out = [];
  for (const [blockName, blk] of Object.entries(mcData.blocksByName)) {
    if (blockName === itemName) continue; // skip self
    for (const d of (blk.drops || [])) {
      const dropId = (typeof d === 'object') ? (d.drop?.id ?? d.id ?? d) : d;
      if (dropId === item.id) {
        out.push(blockName);
        break;
      }
    }
  }
  return out;
}

/**
 * @typedef {object} DiscoveryDeps
 * @property {import('mineflayer').Bot} b
 * @property {object} ctx
 * @property {object} goals
 * @property {(msg: string) => void} log
 * @property {(block: unknown) => string} resolveMiningBlockName
 * @property {(blockName:string,blockTypeId:number,batchSize:number,b: import('mineflayer').Bot) => Vec3[]} fairPlayHarvestTrunkCandidates
 * @property {(name:string,opts:object) => Promise<{position:{x:number,y:number,z:number}}[]>} findVisibleBlocksByNameWithPhysicalSweep
 *
 * Runs candidate discovery after block type validation and inventory prelude.
 * @returns Terminal success response OR continuation payload with `found`.
 */
export async function collectDiscoveryPhase(deps, {
  b,
  blockName,
  blockType,
  batchSize,
  count,
  inventoryAt,
  startedInventory,
  startedBlockCount,
}) {
  const {
    ctx,
    goals,
    log,
    fairPlayHarvestTrunkCandidates,
    findVisibleBlocksByNameWithPhysicalSweep,
  } = deps;

  // F72: short-circuit when the bot just auto-picked up the requested
  // item from a recent dig. Previously this path returned
  // NO_VISIBLE_BLOCKS because there were no drops left on the ground
  // — the brain misread it as "dig failed" and went into recovery
  // (often wall-digging). Consult ctx.runtime.recentPickups within a 30s
  // window: if the bot picked up enough of the item via auto-magnet
  // after a dig, mark this collect as done and consume the entries.
  if (Array.isArray(ctx.runtime.recentPickups) && ctx.runtime.recentPickups.length > 0) {
    const now = Date.now();
    ctx.runtime.recentPickups = ctx.runtime.recentPickups.filter((p) => (now - p.ts) < 30_000);
    let available = 0;
    for (const p of ctx.runtime.recentPickups) {
      if (p.item === blockName) available += p.count;
    }
    if (available >= count && (startedInventory[blockName] || 0) >= count) {
      // Consume `count` from the matching entries (oldest-first).
      let remaining = count;
      for (const p of ctx.runtime.recentPickups) {
        if (remaining <= 0) break;
        if (p.item !== blockName) continue;
        const take = Math.min(p.count, remaining);
        p.count -= take;
        remaining -= take;
      }
      ctx.runtime.recentPickups = ctx.runtime.recentPickups.filter((p) => p.count > 0);
      return {
        terminal: true,
        response: {
          ok: true,
          data: {
            block_name: blockName,
            mined_count: 0,
            dropped_items_collected: count,
            source: 'recent_pickup',
          },
          result: `Already have ${count} ${blockName} in inventory — auto-picked up from a recent dig.`,
        },
      };
    }
  }

  /** @type {Vec3[]} */
  let found = [];
  const isTrunkHarvest = /_log$|_stem$|^crimson_stem$|^warped_stem$/i.test(blockName);
  const isNonSolidPlant = blockType.boundingBox !== 'block';
  if (ctx.reactive.fairPlayMode) {
    if (isTrunkHarvest) {
      found = fairPlayHarvestTrunkCandidates(blockName, blockType.id, batchSize, b);
    }
    if (found.length === 0 && !isNonSolidPlant) {
      const visible = await findVisibleBlocksByNameWithPhysicalSweep(blockName, {
        range: 16,
        count: batchSize * 3,
      });
      found = visible.map(
        (entry) => new Vec3(entry.position.x, entry.position.y, entry.position.z),
      );
      // Surface-bias: prefer candidates with air above them. The
      // visibility scan can stride-alias rays past a thin grass/dirt
      // layer and "see" underground stone — surface-bias rejects
      // those so the bot doesn't waste a dig-attempt on a block it
      // would have to tunnel down to reach. Fallback to the full
      // list if nothing has clear sky (e.g. mining inside a cave).
      if (found.length > 0) {
        const surface = found.filter((pos) => {
          const above = b.blockAt(pos.offset(0, 1, 0));
          if (!above) return true;
          return AIR_NAMES.has(above.name);
        });
        if (surface.length > 0) found = surface;
      }
    }
    if (found.length === 0 && isNonSolidPlant) {
      // Non-solid blocks (grass, flowers, crops) can't be raycast-detected;
      // use proximity search with a short range since they're visible at ground level
      found = b.findBlocks({
        matching: blockType.id,
        maxDistance: 12,
        count: batchSize * 3,
      });
    }
    if (found.length === 0 && !isNonSolidPlant) {
      // Fair-play fallback: scout nearby ore coordinates and use short-range
      // assist to avoid repeated "look/check" loops in tight caves.
      const scout = b.findBlocks({
        matching: blockType.id,
        maxDistance: 10,
        count: Math.max(batchSize * 2, 8),
      });
      if (scout.length > 0) {
        const nearest = scout.sort(
          (a, c) => b.entity.position.distanceTo(a) - b.entity.position.distanceTo(c),
        )[0];
        try {
          await gotoWithTimeout(b, new goals.GoalNear(nearest.x, nearest.y, nearest.z, 2), 8000);
        } catch {
          // Keep graceful failure path below with an actionable hint.
        }
        const reVisible = await findVisibleBlocksByNameWithPhysicalSweep(blockName, {
          range: 16,
          count: batchSize * 3,
        });
        found = reVisible.map(
          (entry) => new Vec3(entry.position.x, entry.position.y, entry.position.z),
        );
        if (found.length === 0) {
          // Last-resort short-range scout-assist: harvest only very nearby
          // coordinates to keep behavior practical without long-range xray.
          found = scout
            .filter((p) => b.entity.position.distanceTo(p) <= 10)
            .map((p) => new Vec3(p.x, p.y, p.z));
          if (found.length === 0) {
            return {
              terminal: true,
              response: {
                ok: false,
                error: {
                  code: 'NO_VISIBLE_BLOCKS',
                  message: `Can't see any ${blockName} right now. Nearest scout hit at ${nearest.x}, ${nearest.y}, ${nearest.z}.`,
                  observed_state: {
                    requested_block: blockName,
                    requested_count: count,
                    mined_count: 0,
                    nearest_scout: { x: nearest.x, y: nearest.y, z: nearest.z },
                    fair_play: true,
                  },
                  next_action_hint: `mc goto_near ${nearest.x} ${nearest.y} ${nearest.z} 2, then mc scene and mc collect ${blockName} 2`,
                  retry_safe: false,
                },
              },
            };
          }
        }
      }
    }
  } else {
    found = b.findBlocks({
      matching: blockType.id,
      maxDistance: 64,
      count: batchSize * 3,
    });
  }

  // Source-block fallback: user asked for an item (e.g. "cobblestone",
  // "dirt") but the world has few/no visible blocks of that name. In
  // survival you have to mine the source block (stone → cobblestone,
  // grass_block → dirt, coal_ore → coal). We *append* source-block
  // candidates whenever the primary pool is smaller than a full batch,
  // so the bot has options when the cliff-face/cave dirt all turns out
  // to be behind a wall and we'd otherwise return MIXED_FAILURE.
  // `acceptedTargetNames` lets the dig-loop accept either type;
  // inventory accounting tracks the *requested* item name (what
  // actually lands in inventory after each break).
  let resolvedFromSource = null;
  const acceptedTargetNames = new Set([blockName]);
  if (found.length < batchSize) {
    const sources = sourceBlocksForItem(ctx.world.mcData, blockName);
    const initialFoundCount = found.length;
    for (const altName of sources) {
      const altType = ctx.world.mcData.blocksByName[altName];
      if (!altType) continue;
      let altFound = [];
      if (ctx.reactive.fairPlayMode && !isNonSolidPlant) {
        // Fair-play: only consider blocks the bot can actually SEE
        // (raycast line-of-sight). No fallback to plain findBlocks —
        // that would expose underground worldgen stone the bot has
        // no real perception of. If the visible scan returns 0, the
        // bot should turn / move / `mc scene` first, just like a
        // real player would.
        const visible = await findVisibleBlocksByNameWithPhysicalSweep(altName, {
          range: 16, count: batchSize * 3,
        });
        altFound = visible.map(e => new Vec3(e.position.x, e.position.y, e.position.z));
      } else {
        // Non-fair-play (X-ray): plain findBlocks.
        altFound = b.findBlocks({
          matching: altType.id,
          maxDistance: 64,
          count: 500,
        });
      }
      // Surface-bias: prefer candidates whose ceiling is true air
      // (cave_air/void_air also count). Stops the bot from picking
      // underground stone the visibility scan accidentally reaches
      // via stride-aliased rays through the grass layer. We keep
      // the original list as fallback if NO surface candidates
      // exist — better to try buried stone than fail outright.
      const surface = altFound.filter(pos => {
        const above = b.blockAt(pos.offset(0, 1, 0));
        if (!above) return true;
        return AIR_NAMES.has(above.name);
      });
      if (surface.length > 0) altFound = surface;
      if (altFound.length > 0) {
        // Append, don't replace. Original-block candidates (if any)
        // stay in the pool and still get tried first by distance.
        for (const p of altFound) found.push(p);
        acceptedTargetNames.add(altName);
        if (resolvedFromSource === null) resolvedFromSource = altName;
        if (initialFoundCount === 0) {
          log(`[collect] No ${blockName} visible; mining ${altName} as source (drops ${blockName}).`);
        } else {
          log(`[collect] Only ${initialFoundCount} ${blockName} visible; augmenting with ${altFound.length} ${altName} (drops ${blockName}).`);
        }
        // One source-block type is enough — the dig-loop has plenty
        // of options now. Avoid stacking multiple alt types so the
        // pool doesn't blow past its sort/sweep budget.
        break;
      }
    }
  }

  if (found.length === 0) {
    return {
      terminal: true,
      response: {
        ok: false,
        error: {
          code: 'NO_VISIBLE_BLOCKS',
          message: ctx.reactive.fairPlayMode
            ? isTrunkHarvest
              ? `No ${blockName} with harvest line-of-sight in range (leaves/water between you and the trunk are ok; dirt/stone/other wood are not).`
              : `Can't see any ${blockName} right now. Turn, move, or use mc scene/mc look before collecting.`
            : `No ${blockName} found within 64 blocks.`,
          observed_state: {
            requested_block: blockName,
            requested_count: count,
            mined_count: 0,
            fair_play: ctx.reactive.fairPlayMode,
            search_range: ctx.reactive.fairPlayMode ? 16 : 64,
          },
          retry_safe: false,
        },
      },
    };
  }

  return {
    terminal: false,
    value: {
      found,
      resolvedFromSource,
      acceptedTargetNames,
      isTrunkHarvest,
      isNonSolidPlant,
    },
  };
}
