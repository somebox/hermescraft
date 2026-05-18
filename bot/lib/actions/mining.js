// @size-exempt: collect + dig oversized; Phase 9 (deferred) extracts helpers
import { Vec3 } from 'vec3';
import { equipForDig, PROTECTED_DIG_BLOCKS, detectDigHazards, isDigProtected, getSupportedDoorAbove } from '../runtime/dig-tools.js';
import { bearingFromDelta, classifySector, angleDiffDegrees } from '../shared/perception.js';
import { raceWithTimeout, timeoutError, OperationTimeoutError, ACTION_CAPS_MS } from './_helpers.js';
import { annotateReachability } from './_nav-helpers.js';

/**
 * Race pathfinder.goto against a hard wall-clock timeout. Without this, the
 * pathfinder can spin indefinitely on unreachable targets (cramped spots,
 * blocks behind other blocks, items at the bottom of holes) — the visible
 * "Flint stuck running in place" failure mode. On timeout, stop the
 * pathfinder and clear control states so the bot is left in a clean state.
 *
 * @param {import('mineflayer').Bot} b
 * @param {object} goal - mineflayer-pathfinder goal
 * @param {number} timeoutMs
 * @throws OperationTimeoutError on timeout, or the underlying pathfinder
 *         error otherwise. Callers can detect timeout via `instanceof
 *         OperationTimeoutError` or `err.code === 'OPERATION_TIMEOUT'`.
 */
async function gotoWithTimeout(b, goal, timeoutMs) {
  try {
    await raceWithTimeout(b.pathfinder.goto(goal), timeoutMs, 'goto');
  } catch (err) {
    if (err instanceof OperationTimeoutError || err.code === 'OPERATION_TIMEOUT') {
      try { b.pathfinder.stop(); } catch { /* ignore */ }
      try { b.clearControlStates?.(); } catch { /* ignore */ }
    }
    throw err;
  }
}

/**
 * Given an item name (e.g. "cobblestone"), return the list of OTHER block
 * names whose drops include that item (e.g. ["stone"] for cobblestone).
 * Used by `mc collect` to fall back to source blocks when no blocks of the
 * requested name are present in the world — in survival the player asks
 * for the drop ("cobblestone") but actually needs to mine the source
 * ("stone"). Returns [] if there's no mcData item or no source blocks.
 */
function sourceBlocksForItem(mcData, itemName) {
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

export function createMiningActions(deps) {
  const { ctx, config, ensureBot, goals, fmt, posObj, sleep, log, resolveMiningBlockName, fairPlayHarvestTrunkCandidates, findVisibleBlocksByNameWithPhysicalSweep, entitiesMatchingAfterLookSweep, rememberSocialEvent, hasLineOfSight, eyePosition } = deps;

  // Raycast from bot eye to a point just OUTSIDE the target block on the
  // bot-facing face. Returns true if the ray reaches that face with no
  // intervening solid block. Aims at the nearest face center pulled back
  // by 0.02 so the endpoint sits in air, not inside the target — avoids
  // false negatives where the ray ends inside its own target block.
  function canSeeMinableFace(targetPos) {
    if (!hasLineOfSight || !eyePosition) return true; // pre-wire safety
    const eye = eyePosition();
    if (!eye) return true;
    const cx = targetPos.x + 0.5;
    const cy = targetPos.y + 0.5;
    const cz = targetPos.z + 0.5;
    const dx = eye.x - cx;
    const dy = eye.y - cy;
    const dz = eye.z - cz;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    const adz = Math.abs(dz);
    // Try each face whose normal points toward the bot — accept if ANY
    // is visible. Mining the block is legal as long as at least one
    // bot-facing face has a clear ray; we don't care which specific
    // face mineflayer's dig packet will click against.
    const candidates = [];
    if (adx > 0.001) candidates.push({ x: cx + Math.sign(dx) * 0.48, y: cy, z: cz });
    if (ady > 0.001) candidates.push({ x: cx, y: cy + Math.sign(dy) * 0.48, z: cz });
    if (adz > 0.001) candidates.push({ x: cx, y: cy, z: cz + Math.sign(dz) * 0.48 });
    for (const f of candidates) {
      if (hasLineOfSight(eye, f)) return true;
    }
    return false;
  }
  const handlers = {
    async collect({ block, count = 1 }) {
      // ─ Phase-2 action contract (see docs/phase-2/action-contracts.md mc collect) ─
      // Soft failures return { ok: false, error: { code, message, observed_state, ... } }.
      // ok=true requires mined_count > 0; mined_count==0 is a contract violation.
      // The HTTP wrapper spreads result over { ok: true, ... }, so ok=false propagates.

      const b = ensureBot();
      // Fresh entry — clear any stale cancel flag from a previous mc stop.
      // Without this, a stop ran 10 minutes ago would abort this brand-new
      // collect before it tried anything. The flag exists for THIS run.
      ctx.tasks.cancelRequested = false;
      const blockName = resolveMiningBlockName(block);
      const blockType = ctx.world.mcData.blocksByName[blockName];
      if (!blockType) {
        return {
          ok: false,
          error: {
            code: 'UNKNOWN_BLOCK',
            message: `Unknown block "${blockName}". Check spelling (e.g. oak_log, iron_ore, cobblestone).`,
            observed_state: { requested_block: blockName },
            retry_safe: false,
          },
        };
      }

      const batchSize = Math.min(count, 20);
      const inventoryAt = () =>
        b.inventory.items().reduce((acc, it) => {
          acc[it.name] = (acc[it.name] || 0) + it.count;
          return acc;
        }, /** @type {Record<string, number>} */ ({}));
      const startedInventory = inventoryAt();
      const startedBlockCount = startedInventory[blockName] || 0;

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
            ok: true,
            data: {
              block_name: blockName,
              mined_count: 0,
              dropped_items_collected: count,
              source: 'recent_pickup',
            },
            result: `Already have ${count} ${blockName} in inventory — auto-picked up from a recent dig.`,
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
            const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
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
          const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
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
        };
      }

      const botPos = b.entity.position;
      // Only skip the bot's own foot block (digging it would drop the bot
      // into the hole on the same tick — useless). Everything else stays
      // visible: the agent decides.
      const safe = found.filter(pos => {
        if (Math.abs(pos.x - Math.floor(botPos.x)) < 1 &&
            Math.abs(pos.z - Math.floor(botPos.z)) < 1 &&
            pos.y < Math.floor(botPos.y)) return false;
        return true;
      });
      // Strict water-adjacency: a block is "flooded" if ANY of the 6
      // adjacent cells (up, down, N/S/E/W) is water — source OR flowing.
      // The previous "2+ sources" loosening was empirically too lax:
      // a single water source touching one face is enough to flood the
      // newly-dug cell within a few ticks once the supporting wall is
      // broken. Per the user's session-#2 brief: never mine into water;
      // refuse the candidate entirely (don't just de-prioritize).
      const isFlooded = (pos) => {
        const NEIGHBOURS = [
          [0, 1, 0], [0, -1, 0],
          [1, 0, 0], [-1, 0, 0],
          [0, 0, 1], [0, 0, -1],
        ];
        for (const [dx, dy, dz] of NEIGHBOURS) {
          const nb = b.blockAt(pos.offset(dx, dy, dz));
          if (nb && (nb.name === 'water' || nb.name === 'flowing_water')) return true;
        }
        return false;
      };

      if (safe.length === 0) {
        return {
          ok: false,
          error: {
            code: 'NO_VISIBLE_BLOCKS',
            message: `No safely reachable ${blockName} found (all candidates were below the bot).`,
            observed_state: {
              requested_block: blockName,
              requested_count: count,
              mined_count: 0,
              candidates_found: found.length,
              candidates_safely_reachable: 0,
            },
            retry_safe: false,
          },
        };
      }

      // Strip-plane lock: anchor the dig to the Y level of the deepest
      // initially-visible candidate. As cells get mined and refreshPool
      // exposes newly-uncovered blocks BELOW the strip plane (their
      // ceilings just became air), we reject them — otherwise the bot
      // dives down through the deposit instead of mining laterally.
      // The lock is the entire reason re44 saw "you're mining too
      // close to the base, making holes" in session #1: top layer of
      // a pit got cleared, refreshPool found the next layer's cells
      // (now LOS-visible), bot dug down. With this lock the bot will
      // surface as MIXED_FAILURE / partial count when the strip plane
      // is exhausted, and the agent can reposition + recall to mine
      // a deeper layer deliberately.
      //
      // Trunk harvests (trees) span multiple Y by design — skip the
      // lock for those.
      const stripPlaneFloorY = isTrunkHarvest
        ? -Infinity
        : Math.min(...safe.map((p) => p.y));

      // Strip-mine axis selection. Hoisted to outer scope so refreshPool
      // can use the same sort logic — without this, refreshPool sorted
      // by raw distance-from-bot, producing star-shape scatter as the
      // bot moved around. Anchored on the BOT's CURRENT position each
      // call so the row-march advances naturally with the bot.
      let stripAxis = 'x';
      let perpAxis = 'z';
      // Anchor + direction. The perp anchor stays LOCKED at the bot's
      // initial integer-block position so refreshPool doesn't drift the
      // sort each call (which produces scatter). The perp direction
      // (+1 or -1) is chosen once based on which side of the anchor has
      // more candidates — without a signed direction, |z - anchor|
      // treats z=1 and z=3 equally, producing chaotic zig-zag instead
      // of monotonic row-by-row marching.
      // perpAxis, initialPerpAnchor, and perpDirection are finalized
      // a few lines below after stripAxis is picked from the cloud
      // spread.
      let initialPerpAnchor = Math.floor(b.entity.position[perpAxis]);
      let perpDirection = 1;
      const initialYAnchor = Math.floor(b.entity.position.y);
      const stripSort = (list) => {
        const botStrip = Math.floor(b.entity.position[stripAxis]);
        return list.slice().sort((a, c) => {
          // 1. Y plane: nearest to initial Y first.
          const ay = Math.abs(a.y - initialYAnchor);
          const cy = Math.abs(c.y - initialYAnchor);
          if (ay !== cy) return ay - cy;
          // 2. Row: SIGNED perp-axis offset in the chosen direction.
          //    Cells in the bot's row (offset 0) come first, then
          //    perp+1, perp+2, ... or perp-1, perp-2, ... depending
          //    on perpDirection. Cells in the opposite direction get
          //    a large penalty so they're mined last (only if the
          //    primary side is fully exhausted).
          const apRaw = (a[perpAxis] - initialPerpAnchor) * perpDirection;
          const cpRaw = (c[perpAxis] - initialPerpAnchor) * perpDirection;
          const ap = apRaw >= 0 ? apRaw : 1000 - apRaw;
          const cp = cpRaw >= 0 ? cpRaw : 1000 - cpRaw;
          if (ap !== cp) return ap - cp;
          // 3. March: along the strip axis, nearest first (follows bot).
          const as = Math.abs(a[stripAxis] - botStrip);
          const cs = Math.abs(c[stripAxis] - botStrip);
          if (as !== cs) return as - cs;
          // 4. Final tiebreak: lower Y first.
          return a.y - c.y;
        });
      };

      // F54.4: if EVERY candidate is in/under water, refuse upfront. The
      // bot drowns trying to dig submerged blocks (sand-in-pond was the
      // G21 v5 Mason-stuck case). isFlooded is the same predicate the
      // existing sort uses; this just elevates "all flooded" to a hard
      // failure with an actionable hint instead of letting the bot walk
      // into the pond.
      const dryCandidates = safe.filter((pos) => !isFlooded(pos));
      if (dryCandidates.length === 0) {
        return {
          ok: false,
          error: {
            code: 'TARGET_IN_WATER',
            message: `All ${safe.length} ${blockName} candidates are in/under water — bot would drown trying to mine them. Drain the pond first, approach from a dry side, or look for a drier deposit.`,
            observed_state: {
              requested_block: blockName,
              requested_count: count,
              mined_count: 0,
              candidates_dry: 0,
              candidates_flooded: safe.length,
              suggested_dry_search_radius: 32,
            },
            retry_safe: false,
          },
        };
      }

      // Ordering: tree-trunk harvests want cluster grouping (mine ONE
      // tree fully before walking to the next, bottom-up so the trunk
      // base goes first). Non-trunk harvests (ores, stone, deposits,
      // saplings, leaves) just want pure nearest-first 3D distance from
      // the bot — avoids the "weird order leaves complex geometry"
      // failure mode where mining hops around a deposit and produces
      // jagged residual blocks that are hard to reach next pass.
      let sorted;
      if (isTrunkHarvest) {
        const clusters = [];
        const assigned = new Set();
        for (let i = 0; i < safe.length; i++) {
          if (assigned.has(i)) continue;
          const cluster = [safe[i]];
          assigned.add(i);
          for (let j = i + 1; j < safe.length; j++) {
            if (assigned.has(j)) continue;
            const dx = Math.abs(safe[j].x - safe[i].x);
            const dz = Math.abs(safe[j].z - safe[i].z);
            if (dx <= 1 && dz <= 1) {
              cluster.push(safe[j]);
              assigned.add(j);
            }
          }
          cluster.sort((a, c) => a.y - c.y);
          clusters.push(cluster);
        }
        clusters.sort((a, c) => {
          const aBase = a[0];
          const cBase = c[0];
          const aD = Math.abs(aBase.x - botPos.x) + Math.abs(aBase.z - botPos.z);
          const cD = Math.abs(cBase.x - botPos.x) + Math.abs(cBase.z - botPos.z);
          return aD - cD;
        });
        sorted = clusters.flat();
      } else {
        // Strip-mine ordering for non-trunk harvests. Pure 3D-distance
        // sort (the previous behavior) produced a "star pattern" —
        // bot mines one east, one west, one north, one south, etc. —
        // because half a dozen candidates around the bot tie on
        // distance. The result is jagged holes scattered around the bot,
        // exactly the failure mode re44 called out in session #1
        // ("you're mining too close to the base, making holes").
        //
        // New order: by Y proximity to bot, then row (perpendicular
        // axis nearest to bot), then march along the strip axis. Strip
        // axis is the one with greater spread in the candidate cloud —
        // gives a long row instead of a 1-block strip. The bot stays on
        // a row until it's exhausted before stepping to the next,
        // producing a tidy horizontal slice through the deposit.
        // Flooded candidates are DROPPED, not sorted last: the previous
        // "try wet after dry" path eventually flooded the work area
        // once dry candidates ran out. The TARGET_IN_WATER refusal
        // upstream already catches the "all flooded" case.
        const dryCands = safe.filter((p) => !isFlooded(p));

        if (dryCands.length >= 2) {
          let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
          for (const p of dryCands) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.z < minZ) minZ = p.z;
            if (p.z > maxZ) maxZ = p.z;
          }
          stripAxis = (maxX - minX) >= (maxZ - minZ) ? 'x' : 'z';
        }
        perpAxis = stripAxis === 'x' ? 'z' : 'x';
        // Re-anchor now that perpAxis is finalized.
        initialPerpAnchor = Math.floor(b.entity.position[perpAxis]);
        // Pick the perp march direction by counting candidates on each
        // side of the anchor. The bot will march toward whichever side
        // has more material, mining contiguous rows. With only +1/-1
        // possible and an even split, default to +1.
        let posCount = 0;
        let negCount = 0;
        for (const p of dryCands) {
          const d = p[perpAxis] - initialPerpAnchor;
          if (d > 0) posCount += 1;
          else if (d < 0) negCount += 1;
        }
        perpDirection = negCount > posCount ? -1 : 1;

        sorted = stripSort(dryCands);
      }

      let collected = 0;
      let lastCollectErr = '';
      let attempted = 0;
      let wasCancelled = false;
      // Per-cause attempt counters — these are why ok=true with mined_count=0
      // used to slip through. Now every `continue` in the loop bumps a counter.
      const causes = {
        not_target_block: 0,    // block changed under us before we got there
        pathfind_failed: 0,     // both pathfind attempts threw
        out_of_range_post_path: 0, // pathfind "succeeded" but distance still > 5.5
        skipped_self_block: 0,  // would dig the block we're standing on
        behind_wall: 0,         // no line of sight after pathfind (another block in the way)
        dig_failed: 0,          // b.dig threw (timeout, server reject, etc.)
      };
      /** @type {Set<string>} */
      const tipSet = new Set();
      /** @type {Set<string>} */
      const triedKeys = new Set();
      // Cells where the last dig flooded — refreshPool skips them so we
      // don't re-mine the freshly-plugged spot and start the water cycle
      // again. Distinct from triedKeys: a triedKey is "attempted once
      // already"; a noMineKey is "actively dangerous, do not approach".
      const noMineKeys = new Set();
      const posKey = (p) => `${p.x},${p.y},${p.z}`;

      // Block IDs we'll accept for cheap rediscovery scans (raw b.findBlocks).
      // Built from `acceptedTargetNames` so the source-block fallback (e.g.
      // requesting cobblestone → mining stone) still scans for the right id.
      const acceptedBlockIds = Array.from(acceptedTargetNames)
        .map((n) => ctx.world.mcData.blocksByName[n]?.id)
        .filter((id) => typeof id === 'number');

      // Re-gather candidate pool from the bot's CURRENT position. Uses raw
      // b.findBlocks (cheap, no physical look-sweep) gated by per-candidate
      // canSeeMinableFace — that's the fair-play LOS check the dig loop
      // would apply anyway. Effect: we get x-ray-style discovery limited
      // to blocks with at least one bot-facing exposed face. After each
      // dig, neighbours that were buried become reachable and re-appear in
      // the next pool. This is what closes the "1 candidate per call" hole
      // we hit in G20 v25 mining the stone deposit.
      const refreshPool = () => {
        if (acceptedBlockIds.length === 0) return [];
        const raw = b.findBlocks({
          matching: acceptedBlockIds,
          maxDistance: 12,
          count: 80,
        });
        const botPosNow = b.entity.position;
        const AIR_ABOVE = new Set(['air', 'cave_air', 'void_air']);
        const out = [];
        // Surface-bias + water-rejection. The look-sweep-based initial
        // scan already applies surface-bias, but b.findBlocks is x-ray:
        // it'll happily return underwater stone and stones under grass.
        // The LOS guard alone doesn't reject those because water has
        // boundingBox='empty' (raycasts pass through). G20 v27 mined the
        // stone deposit, ran out of LOS-reachable surface candidates,
        // then refreshPool() pulled in (-2, 63, 8) — stone *under the
        // pond*. Bot walked into the water and got stuck for 8s wiggling
        // before giving up. Reject upfront here.
        for (const p of raw) {
          const k = posKey(p);
          if (triedKeys.has(k)) continue;
          if (!canSeeMinableFace(p)) continue;
          // Strip-plane lock: don't auto-dive below the initial scan's
          // deepest Y. Newly-uncovered cells whose ceiling just became
          // air would otherwise turn a flat strip into a downward
          // tunnel. Trunk harvests bypass this above.
          if (p.y < stripPlaneFloorY) continue;
          // Reject candidates with anything-but-air directly above —
          // grass, water, lava, leaves all signal "you can't just walk
          // up and mine this".
          const above = b.blockAt(p.offset(0, 1, 0));
          if (above && !AIR_ABOVE.has(above.name)) continue;
          // Strict water-adjacency: any of the 6 face-neighbours being
          // water (source or flowing) → skip. Matches isFlooded above.
          if (isFlooded(p)) continue;
          // Defensively skip cells we marked no-mine after a previous
          // dig flooded (reactive plug path).
          if (noMineKeys.has(k)) continue;
          out.push(p);
        }
        if (!isTrunkHarvest) {
          // Use the same strip-mine sort as the initial pool so the
          // pattern stays a strip as the bot moves. The earlier plain
          // distance-sort produced star-pattern scatter once
          // refreshPool kicked in.
          return stripSort(out);
        }
        return out;
      };

      // First iteration uses the look-sweep-based `sorted` list (good for
      // initial discovery of which deposit to engage). Subsequent iterations
      // refresh via refreshPool() — newly-exposed neighbours included.
      let pool = sorted.slice();

      // Time + stall caps so collect never spins forever on a stuck deposit.
      // Inner budget intentionally below the outer ACTION_CAPS_MS.collect
      // (40000ms) so we get a graceful exit + structured response BEFORE
      // the outer wrapper fires its OPERATION_TIMEOUT envelope.
      const COLLECT_START_MS = Date.now();
      const COLLECT_BUDGET_MS = 35000;
      const MAX_STALL_ROUNDS = 3;
      // Anti-cascade: if b.dig throws "Digging aborted" in <100ms it's
      // not the block's fault — the bot is in a broken state (pathfinder
      // residual, world transition, server hiccup). Two in a row means we
      // bail this round so refreshPool() can reset.
      const INSTANT_FAIL_THRESHOLD_MS = 100;
      const MAX_CONSEC_INSTANT_FAILS = 2;
      let stallRounds = 0;
      // Set by the per-candidate catch when equipForDig refuses (no
      // suitable tool in inventory + dig would exceed maxTicks). This is
      // a per-CALL problem, not per-candidate — every block of the same
      // type will fail the same way. We bail the whole collect with a
      // structured TOOL_INADEQUATE rather than silently churning the pool
      // (which previously produced the "Refusing to dig … (~Ns break time)"
      // cascade — 21 same-second log entries against bare-hand stone).
      /** @type {Error | null} */
      let preDigRefusal = null;

      while (
        collected < count &&
        Date.now() - COLLECT_START_MS < COLLECT_BUDGET_MS &&
        stallRounds < MAX_STALL_ROUNDS &&
        !ctx.tasks.cancelRequested
      ) {
        const beforeRoundMined = collected;
        const remainingNeeded = count - collected;
        const roundBatch = Math.min(remainingNeeded, batchSize);
        // Anti-cascade tracker — reset per round.
        let consecInstantFails = 0;

        for (const pos of pool.slice(0, roundBatch)) {
          if (collected >= count) break;
          // mc stop sets ctx.tasks.cancelRequested. Works for both sync and
          // background paths — unlike the legacy background-task check below
          // which is gated on !syncActionInFlight.
          if (ctx.tasks.cancelRequested) {
            wasCancelled = true;
            break;
          }
          const k = posKey(pos);
          if (triedKeys.has(k)) continue;

          // Background-task cancel handling. The check only applies when
          // collect is RUNNING AS the background task — i.e. ctx.tasks.currentTask
          // is this very collect call. If currentTask references an earlier
          // task (e.g. a completed `mc fill` placed via /task/place_fill),
          // its status will be 'done'/'stuck' but UNRELATED to this collect:
          // we must NOT break, otherwise the loop exits silently with
          // attempted=N, collected=0, all causes=0 → "MIXED_FAILURE 0/N".
          // syncActionInFlight is true for /action/collect, so guard there.
          if (
            ctx.tasks.currentTask &&
            ctx.tasks.currentTask.action === 'collect' &&
            ctx.tasks.currentTask.status !== 'running' &&
            !ctx.tasks.syncActionInFlight
          ) {
            stallRounds = MAX_STALL_ROUNDS;
            break;
          }
          // triedKeys marking happens per-outcome below — instant-fail dig
          // aborts (cascade) intentionally do NOT mark the candidate tried,
          // so a recovered bot can retry it next round via refreshPool().
          attempted++;
          let digStartedAt = 0;
          try {
            const target = b.blockAt(pos);
            if (!target || !acceptedTargetNames.has(target.name)) {
              causes.not_target_block++;
              triedKeys.add(k);
              consecInstantFails = 0;
              continue;
            }
            const { hints } = await equipForDig(b, target);
            for (const h of hints) tipSet.add(h);

            const dist = b.entity.position.distanceTo(pos);
            if (dist > 4.5) {
              const curPos = b.entity.position;
              const horizDist = Math.abs(pos.x - curPos.x) + Math.abs(pos.z - curPos.z);
              let pathOk = false;
              if (horizDist > 4) {
                const navY = Math.floor(curPos.y);
                try {
                  await gotoWithTimeout(b, new goals.GoalNear(pos.x, navY, pos.z, 2), 8000);
                  pathOk = true;
                } catch {
                  try {
                    await gotoWithTimeout(b, new goals.GoalNear(pos.x, pos.y, pos.z, 3), 6000);
                    pathOk = true;
                  } catch { /* both attempts failed */ }
                }
              } else {
                try {
                  await gotoWithTimeout(b, new goals.GoalNear(pos.x, pos.y, pos.z, 2), 6000);
                  pathOk = true;
                } catch { /* close pathfind failed */ }
              }
              if (!pathOk) {
                causes.pathfind_failed++;
                triedKeys.add(k);
                consecInstantFails = 0;
                continue;
              }
            }

            const recheck = b.blockAt(pos);
            if (!recheck || !acceptedTargetNames.has(recheck.name)) {
              causes.not_target_block++;
              triedKeys.add(k);
              consecInstantFails = 0;
              continue;
            }
            const curPos = b.entity.position;
            if (curPos.distanceTo(pos) > 5.5) {
              causes.out_of_range_post_path++;
              triedKeys.add(k);
              consecInstantFails = 0;
              continue;
            }
            const feetY = Math.floor(curPos.y);
            if (pos.y === feetY - 1 &&
                Math.abs(pos.x - Math.floor(curPos.x)) < 1 &&
                Math.abs(pos.z - Math.floor(curPos.z)) < 1) {
              causes.skipped_self_block++;
              triedKeys.add(k);
              consecInstantFails = 0;
              continue;
            }

            // Post-pathfind LOS check. mineflayer.dig sends a server packet
            // that Paper accepts as long as the block is within reach —
            // it does NOT verify there's no other block in the way. So
            // candidates that passed the initial visibility scan but are
            // now BEHIND a freshly-exposed wall (or were always visible
            // only by their top face from a viewing angle the bot no
            // longer has) would otherwise still get a dig packet and
            // produce an unfair "stab through stone" mine. Refuse here.
            if (!canSeeMinableFace(pos)) {
              causes.behind_wall++;
              triedKeys.add(k);
              consecInstantFails = 0;
              continue;
            }

            digStartedAt = Date.now();
            // Race b.dig against a 12s timeout. Capture the timer handle so
            // we can clear it on dig success/failure — otherwise each dig
            // leaks a pending setTimeout that keeps Node's event loop
            // alive for 12s after the call returns. Cumulative across a
            // long collect, that's many seconds of phantom tail latency.
            let digTimer;
            const digTimeoutP = new Promise((_, rej) => {
              digTimer = setTimeout(() => rej(new Error('dig_timeout')), 12000);
            });
            try {
              await Promise.race([b.dig(recheck, true), digTimeoutP]);
            } finally {
              clearTimeout(digTimer);
            }
            collected++;
            triedKeys.add(k);
            consecInstantFails = 0;
            await sleep(200);
            // Reactive water guard: if water flowed into the just-dug
            // cell (a hidden source we couldn't see pre-dig), mark the
            // cell + its 4 horizontal neighbours as no-mine so the next
            // refreshPool() doesn't return them. We don't try to place
            // a plug block here (that needs equip + face-targeting
            // logic) — we just stop digging into the wet zone and rely
            // on the agent / next call to recover. Sleep an extra
            // 400ms after detection so flowing water has time to spread
            // to its final shape before refreshPool inspects neighbours.
            const postDig = b.blockAt(pos);
            if (postDig && (postDig.name === 'water' || postDig.name === 'flowing_water')) {
              log(`[collect] dig at ${pos.x},${pos.y},${pos.z} produced water — adding cell + neighbours to no-mine list`);
              noMineKeys.add(k);
              for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                noMineKeys.add(`${pos.x + dx},${pos.y},${pos.z + dz}`);
              }
              await sleep(400);
            }
          } catch (err) {
            const m = /** @type {Error} */ (err).message || String(err);
            const digElapsed = digStartedAt ? Date.now() - digStartedAt : 0;
            const isInstantAbort = digStartedAt > 0
              && digElapsed < INSTANT_FAIL_THRESHOLD_MS
              && /aborted/i.test(m);
            // Pre-dig refusal from equipForDig/assertCanDig — thrown
            // BEFORE digStartedAt was set. "Refusing to dig X with empty
            // hand" or "Wrong hand for X". Same outcome for every
            // candidate of this block, so bail the call.
            const isPreDigRefusal = digStartedAt === 0
              && (/^Refusing to dig/i.test(m) || /^Wrong hand for/i.test(m));
            if (isPreDigRefusal) {
              preDigRefusal = /** @type {Error} */ (err);
              log(`[collect] ${m} — bailing (no point retrying ${pool.length - 1} more ${blockName} blocks with the same hand)`);
              break;  // exit per-candidate loop; while loop will detect preDigRefusal and break
            }
            if (m === 'dig_timeout') {
              try { b.stopDigging(); } catch {}
            }
            causes.dig_failed++;
            lastCollectErr = m;
            log(`[collect] Error mining ${blockName} at ${pos.x},${pos.y},${pos.z}: ${m}${isInstantAbort ? ' (instant — not marking tried)' : ''}`);
            if (isInstantAbort) {
              // Don't burn the candidate; refreshPool can re-discover it.
              consecInstantFails++;
              if (consecInstantFails >= MAX_CONSEC_INSTANT_FAILS) {
                log(`[collect] ${consecInstantFails} consecutive instant aborts — bailing this round so the bot can recover state.`);
                // Try to clear any residual pathfinder/dig state before
                // the next round starts.
                try { b.pathfinder.stop(); } catch {}
                try { b.clearControlStates?.(); } catch {}
                try { b.stopDigging(); } catch {}
                break;
              }
            } else {
              // Real dig failure (timeout or server reject). Burn the
              // candidate so we don't retry forever.
              triedKeys.add(k);
              consecInstantFails = 0;
            }
          }
        }

        if (preDigRefusal) break;  // bail the while loop too

        if (collected === beforeRoundMined) stallRounds++;
        else stallRounds = 0;

        if (collected >= count) break;

        // Refresh pool from current bot position — newly-exposed neighbours
        // around the mines we just made (and any blocks the bot rotated
        // into LOS during pathfinding) get picked up here.
        pool = refreshPool();
        if (pool.length === 0) stallRounds++;
      }

      // If we bailed because of a pre-dig refusal (no suitable tool),
      // surface that to the brain as TOOL_INADEQUATE — same code that
      // mc dig uses for the equivalent failure. Critical that this comes
      // BEFORE the pickup pass: there are no drops to collect, and we
      // want the brain to act on the equip problem, not the empty pickup.
      if (preDigRefusal) {
        return {
          ok: false,
          error: {
            code: 'TOOL_INADEQUATE',
            message: preDigRefusal.message,
            observed_state: {
              block_name: blockName,
              requested_count: count,
              mined_count: collected,
              attempted,
              held: b.heldItem?.name || null,
              candidates_remaining: pool.length,
            },
            next_action_hint: preDigRefusal.message,
            retry_safe: false,
          },
        };
      }

      // Pickup pass — collect drops the digs created.
      // Strategy: Minecraft auto-magnets items within ~1.5 blocks of the
      // player, so we DON'T need to pathfind to each drop's exact cell —
      // getting within magnet range is enough. After mining a deposit,
      // drops tend to cluster around the dig site, often blocked from
      // direct LOS by other dropped/placed blocks. A "broom" sweep
      // through the cluster centroid with a wider GoalNear lets the
      // magnet hoover up many at once while pathfinder picks the
      // friendliest route.
      let pickedUp = 0;
      const pickedUpPositions = [];
      const unreachableDropIds = new Set();
      // Per-attempt timeout is short because a successful pickup completes
      // in <500ms most of the time; spending 3.5s on a blocked drop is
      // pure waste when the user is racing sunset.
      const PICKUP_PER_ITEM_MS = 1500;
      const PICKUP_SWEEP_MS = 3500;
      const PICKUP_BUDGET_MS = 12000;
      const PICKUP_MAGNET_RANGE = 1.5; // Minecraft's auto-pickup radius
      const pickupStart = Date.now();
      await sleep(600);
      let prevInvCount = (inventoryAt()[blockName] || 0);
      for (let attempt = 0; attempt < 3; attempt++) {
        if (Date.now() - pickupStart > PICKUP_BUDGET_MS) break;
        const drops = Object.values(b.entities)
          .filter(e => (e.name === 'item' || e.displayName === 'Item') &&
                       !unreachableDropIds.has(e.id) &&
                       e.position.distanceTo(b.entity.position) < 12)
          .sort((a, c) => a.position.distanceTo(b.entity.position) - c.position.distanceTo(b.entity.position));
        if (drops.length === 0) break;

        // Step 1: broom sweep — pathfind to the cluster centroid with a
        // wider GoalNear. If pathfinder picks a route that crosses any
        // drop's magnet radius, those drops vanish automatically. Wider
        // radius = pathfinder has more route options to dodge blocks.
        if (drops.length >= 2) {
          let cx = 0, cy = 0, cz = 0;
          for (const d of drops) { cx += d.position.x; cy += d.position.y; cz += d.position.z; }
          cx /= drops.length; cy /= drops.length; cz /= drops.length;
          try {
            await gotoWithTimeout(
              b,
              new goals.GoalNear(cx, cy, cz, Math.max(2, PICKUP_MAGNET_RANGE)),
              PICKUP_SWEEP_MS,
            );
            await sleep(500);
          } catch { /* sweep failed — fall through to per-drop */ }
        }

        // Step 2: per-drop pickup for whatever the sweep missed. Use the
        // magnet radius as the goto target so we don't try to stand on
        // top of the drop's cell (often a tighter route than needed).
        const remaining = drops.filter((d) => d.isValid);
        for (const drop of remaining.slice(0, 6)) {
          if (Date.now() - pickupStart > PICKUP_BUDGET_MS) break;
          if (!drop.isValid) continue; // magnet already grabbed it
          // Snap to magnet-radius before the goto so a tiny pos delta
          // doesn't make pathfinder try to step ONTO the drop cell.
          try {
            const dropPos = drop.position.clone();
            await gotoWithTimeout(
              b,
              new goals.GoalNear(dropPos.x, dropPos.y, dropPos.z, PICKUP_MAGNET_RANGE),
              PICKUP_PER_ITEM_MS,
            );
            await sleep(300);
            pickedUpPositions.push({ x: Math.round(dropPos.x * 10) / 10, y: Math.round(dropPos.y * 10) / 10, z: Math.round(dropPos.z * 10) / 10 });
          } catch (err) {
            unreachableDropIds.add(drop.id);
          }
        }

        // If no inventory progress this attempt, give up early — same drops
        // will fail the same way.
        const nowInvCount = (inventoryAt()[blockName] || 0);
        if (nowInvCount === prevInvCount) break;
        prevInvCount = nowInvCount;
      }

      const endedInventory = inventoryAt();
      const endedBlockCount = endedInventory[blockName] || 0;
      // pickedUp tracks the *requested* item's inventory gain. That's the
      // right answer for `mc collect dirt` (mined via grass_block source —
      // blockName='dirt' matches the drop). It's WRONG for `mc collect
      // grass_block` because grass_block drops dirt (bare hands / shovel,
      // no silk-touch), so endedBlockCount stays 0 even though 16 dirt
      // entered the inventory. Compute the inventory-wide delta too so
      // callers can see what actually got picked up.
      pickedUp = Math.max(0, endedBlockCount - startedBlockCount);
      const inventoryGains = {};
      for (const [name, endCount] of Object.entries(endedInventory)) {
        const startCount = startedInventory[name] || 0;
        const delta = endCount - startCount;
        if (delta > 0) inventoryGains[name] = delta;
      }
      const totalGain = Object.values(inventoryGains).reduce((s, n) => s + n, 0);

      const tips = [...tipSet];
      const tipsSuffix = tips.length ? ` Tips: ${tips.join(' | ')}` : '';

      // ─ Failure path: collected === 0 ─
      // Pick the best error code based on which cause dominated.
      if (collected === 0) {
        let code;
        let message;
        // `wasCancelled` is set inside the inner for-loop; but if
        // cancelRequested was already true at entry to the outer while
        // (e.g. set during the initial visibility scan), the loop never
        // iterates and the local flag stays false. Trust the source flag
        // too so the response code matches the actual reason for failure.
        if (wasCancelled || ctx.tasks.cancelRequested) {
          code = 'CANCELLED';
          message = `Collect cancelled by mc stop before any ${blockName} was mined.`;
        } else if (attempted === 0) {
          // Should be impossible — `safe.length === 0` already returned NO_VISIBLE_BLOCKS.
          code = 'NO_VISIBLE_BLOCKS';
          message = `Found candidates but none made it into the harvest queue.`;
        } else if (causes.pathfind_failed === attempted) {
          code = 'ALL_PATHFIND_FAILED';
          message = `Found ${attempted} ${blockName} candidates but pathfinding failed on every attempt.`;
        } else if (causes.dig_failed >= attempted - causes.not_target_block - causes.skipped_self_block) {
          code = 'ALL_DIG_FAILED';
          message = `Reached ${attempted - causes.pathfind_failed - causes.not_target_block - causes.skipped_self_block} ${blockName} but every dig failed (${lastCollectErr || 'unknown reason'}).`;
        } else {
          // Mixed cause distribution; prefer the highest counter as the code root.
          const top = Object.entries(causes).sort((a, c) => c[1] - a[1])[0];
          code = top[0] === 'pathfind_failed' ? 'ALL_PATHFIND_FAILED'
               : top[0] === 'dig_failed'      ? 'ALL_DIG_FAILED'
               : 'MIXED_FAILURE';
          message = `Could not mine any ${blockName} (${attempted} attempts). Dominant cause: ${top[0]} (${top[1]}/${attempted}).`;
        }
        return {
          ok: false,
          error: {
            code,
            message,
            observed_state: {
              requested_block: blockName,
              requested_count: count,
              mined_count: 0,
              attempted,
              causes,
              candidates_found: found.length,
              last_inner_error: lastCollectErr || null,
            },
            retry_safe: code !== 'ALL_PATHFIND_FAILED', // pathfinding rarely improves on retry without the bot moving
          },
          // Preserve hints for callers that surface tips.
          ...(tips.length ? { hints: tips } : {}),
        };
      }

      // ─ Success path (full or partial) ─
      const remaining = count - collected;
      const partialFailure = remaining > 0;
      const sourceNote = resolvedFromSource
        ? ` [mined ${resolvedFromSource} as source]`
        : '';
      const cancelNote = wasCancelled ? ' [cancelled mid-task]' : '';
      const msg = remaining > 0
        ? `Mined ${collected} ${blockName} (${remaining} more needed). Have ${endedBlockCount} ${blockName} in inventory.${sourceNote}${cancelNote}${tipsSuffix}`
        : `Mined ${collected}/${count} ${blockName}. Have ${endedBlockCount} ${blockName} in inventory.${sourceNote}${cancelNote}${tipsSuffix}`;

      return {
        ok: true,
        data: {
          mined_count: collected,
          requested_count: count,
          attempted,
          causes,
          partial_failure: partialFailure,
          started_inventory: startedInventory,
          ended_inventory: endedInventory,
          dropped_items_collected: pickedUp,
          dropped_item_positions: pickedUpPositions,
          // C: inventory-wide gain — catches the case where blockName ≠
          // drop name (e.g. `mc collect grass_block` drops dirt). Empty
          // object only when nothing was picked up. total_inventory_gain
          // is the scalar sum for quick "did anything land?" checks.
          inventory_gain: inventoryGains,
          total_inventory_gain: totalGain,
          ...(resolvedFromSource ? { mined_source_block: resolvedFromSource } : {}),
          ...(wasCancelled ? { cancelled: true } : {}),
        },
        // Legacy fields for goal engine + existing tests.
        result: msg,
        ...(tips.length ? { hints: tips } : {}),
      };
    },

    async dig({ x, y, z, force }) {
      const b = ensureBot();
      const target = b.blockAt(new Vec3(x, y, z));

      // ─ Phase-2 action contract (see docs/phase-2/action-contracts.md mc dig) ─
      // Soft failures return { ok: false, error: { code, message, observed_state, ... } }.
      // The HTTP wrapper spreads result over { ok: true, ... }, so ok=false propagates.

      if (!target || target.name === 'air' || target.name === 'cave_air' || target.name === 'void_air') {
        return {
          ok: false,
          error: {
            code: 'NO_BLOCK_AT_COORD',
            message: `No block at ${x}, ${y}, ${z} — target is ${target?.name || 'unknown'}`,
            observed_state: { block_at_target: target?.name || null, requested_coord: { x, y, z } },
            retry_safe: false,
          },
        };
      }

      if (isDigProtected(target.name, { x, y, z }, ctx)) {
        return {
          ok: false,
          error: {
            code: 'PROTECTED_BLOCK',
            message: `Cannot dig ${target.name} — it is part of a building. Use doors to enter buildings.`,
            observed_state: { block_at_target: target.name, requested_coord: { x, y, z } },
            retry_safe: false,
          },
        };
      }

      // F54.4: refuse to dig while the bot is submerged. mineflayer's
      // b.dig with the bot's head/feet in water either silently times
      // out (G21 v5 Mason in pond) or drowns the bot mid-swing. Force
      // flag overrides for power-users who know they have breathing room.
      if (!force && b.entity?.isInWater === true) {
        return {
          ok: false,
          error: {
            code: 'SUBMERGED',
            message: `Cannot dig at (${x}, ${y}, ${z}) — bot is submerged in water. Swim to the surface (mc escape, or place a block under your feet to pillar up) before digging. Re-run with --force if you have breathing room.`,
            observed_state: {
              block_at_target: target.name,
              bot_in_water: true,
              requested_coord: { x, y, z },
            },
            next_action_hint: 'mc escape',
            retry_safe: false,
          },
        };
      }

      // F54.1: refuse to dig a block that supports a door/fence_gate above —
      // doing so drops the door as a loose item, an expensive recovery the
      // brain rarely realizes happened. Honors force flag.
      if (!force) {
        const supported = getSupportedDoorAbove(b, x, y, z);
        if (supported) {
          return {
            ok: false,
            error: {
              code: 'SUPPORT_BLOCK',
              message: `Cannot dig ${target.name} at (${x}, ${y}, ${z}) — it supports ${supported.name} at (${supported.x}, ${supported.y}, ${supported.z}). Digging will drop the door/gate as a loose item. Re-run with --force if intentional.`,
              observed_state: {
                block_at_target: target.name,
                supported_block: supported,
                requested_coord: { x, y, z },
              },
              next_action_hint: `mc dig ${x} ${y} ${z} --force`,
              retry_safe: false,
            },
          };
        }
      }

      const distance = b.entity.position.distanceTo(target.position);

      let hints = [];
      try {
        const ed = await equipForDig(b, target);
        hints = ed.hints || [];
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'TOOL_INADEQUATE',
            message: err.message,
            observed_state: {
              block_at_target: target.name,
              held: b.tool?.itemInHand()?.name ?? null,
              distance: Math.round(distance * 10) / 10,
            },
            next_action_hint: err.message,
            retry_safe: false,
          },
        };
      }

      if (distance > 4.5) {
        try {
          await gotoWithTimeout(b, new goals.GoalNear(x, y, z, 3), ACTION_CAPS_MS.dig);
        } catch (err) {
          if (err instanceof OperationTimeoutError || err.code === 'OPERATION_TIMEOUT') {
            return timeoutError('dig', ACTION_CAPS_MS.dig, {
              block_at_target: target.name,
              requested_coord: { x, y, z },
              distance: Math.round(distance * 10) / 10,
              bot_position: posObj(b.entity.position),
            }, 'Pathfind to dig target was canceled. Move closer manually or try a different cell.');
          }
          return {
            ok: false,
            error: {
              code: 'OUT_OF_RANGE',
              message: `Target at (${x}, ${y}, ${z}) is ${Math.round(distance * 10) / 10} blocks away and pathfind failed: ${err.message}`,
              observed_state: {
                block_at_target: target.name,
                distance: Math.round(distance * 10) / 10,
                bot_position: posObj(b.entity.position),
              },
              retry_safe: false,
            },
          };
        }
      }

      const targetPos = target.position;

      // F67: LOS raycast guard. Mirrors F45.3 / F64 / F65 — bot can't dig
      // a block it can't see (no mining through walls / through its own
      // body / through floors). Uses the same 7-face raycast pattern.
      if (typeof hasLineOfSight === 'function' && typeof eyePosition === 'function') {
        const eye = eyePosition();
        if (eye) {
          const cx = x + 0.5, cy = y + 0.5, cz = z + 0.5;
          const faces = [
            { x: cx, y: cy, z: cz - 0.48 },
            { x: cx, y: cy, z: cz + 0.48 },
            { x: cx - 0.48, y: cy, z: cz },
            { x: cx + 0.48, y: cy, z: cz },
            { x: cx, y: cy - 0.48, z: cz },
            { x: cx, y: cy + 0.48, z: cz },
            { x: cx, y: cy, z: cz },
          ];
          if (!faces.some((p) => hasLineOfSight(eye, p))) {
            return {
              ok: false,
              error: {
                code: 'NO_LINE_OF_SIGHT',
                message: `Cannot see ${target.name} at ${x},${y},${z} — a block is between you and the target.`,
                observed_state: {
                  block_at_target: target.name,
                  requested_coord: { x, y, z },
                  bot_position: posObj(b.entity.position),
                  distance: Math.round(b.entity.position.distanceTo(target.position) * 10) / 10,
                },
                next_action_hint: `Navigate around the obstruction; try mc goto_near ${x} ${y} ${z} range=2`,
                retry_safe: false,
              },
            };
          }
        }
      }

      const beforeDropIds = new Set(
        Object.values(b.entities)
          .filter((e) => e.name === 'item' || e.displayName === 'Item')
          .map((e) => e.id),
      );

      try {
        await b.dig(target, true);
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'INTERRUPTED',
            message: `Dig interrupted: ${err.message}`,
            observed_state: { block_at_target: target.name, requested_coord: { x, y, z } },
            retry_safe: true,
          },
        };
      }

      // ─ Success: scan for drop entities at/near the target for data.dropped_items ─
      // Drops appear ~1-3 server ticks after the block break packet. Wait briefly
      // (default 300ms; tunable via MC_DIG_DROP_SCAN_MS) then collect any item
      // entities that weren't there before, restricted to ≤2.5 blocks of the
      // broken coord (drops can scatter slightly with falling-block physics).
      const dropScanMs = config.behaviors.digDropScanMs;
      await sleep(dropScanMs);
      const dropped = [];
      for (const e of Object.values(b.entities)) {
        if (e.name !== 'item' && e.displayName !== 'Item') continue;
        if (beforeDropIds.has(e.id)) continue;
        if (!e.position || e.position.distanceTo(targetPos) > 2.5) continue;
        // mineflayer exposes the held item via metadata index 8 (1.16+) or 7 (older).
        // Both shapes carry { itemId, itemCount } as the slot data.
        const meta = e.metadata?.[8] || e.metadata?.[7];
        const itemName = meta?.itemId
          ? (ctx.world.mcData.items[meta.itemId]?.name || `item:${meta.itemId}`)
          : (e.displayName || 'unknown');
        const count = meta?.itemCount ?? meta?.count ?? 1;
        dropped.push({
          name: itemName,
          count,
          position: posObj(e.position),
        });
      }

      // F72: push the dig's drops to ctx.runtime.recentPickups. The auto-pickup
      // magnet (1.5-block radius) typically grabs these within a tick
      // or two after the drop appears — earlier than this handler can
      // reliably snapshot inventory. The collect-side handler will
      // double-check that the bot's current inventory actually has the
      // item before short-circuiting, so a drop that lands outside
      // pickup range won't lead to a false success.
      const _now = Date.now();
      if (Array.isArray(ctx.runtime.recentPickups)) {
        ctx.runtime.recentPickups = ctx.runtime.recentPickups
          .filter((p) => (_now - p.ts) < 30_000)
          .slice(-11);
      } else {
        ctx.runtime.recentPickups = [];
      }
      for (const d of dropped) {
        if (!d?.name || !(d.count > 0)) continue;
        ctx.runtime.recentPickups.push({ ts: _now, item: d.name, count: d.count, source: 'dig' });
      }

      const tips = [...new Set(hints)];

      return {
        ok: true,
        data: {
          block_name: target.name,
          dropped_items: dropped,
          position_after: posObj(b.entity.position),
        },
        // Preserve legacy fields so existing callers (goal engine, older tests) still see them.
        result: `Mined ${target.name} at ${x}, ${y}, ${z}${tips.length ? ` Tips: ${tips.join(' | ')}` : ''}`,
        ...(tips.length ? { hints: tips } : {}),
      };
    },

    async pickup() {
      const b = ensureBot();
      const invBefore = b.inventory.items().reduce((s, i) => s + i.count, 0);
      // Minecraft auto-magnets items within ~1.5 blocks. We use that radius
      // as the pathfinder goal so we don't try to stand precisely ON the
      // drop cell, which fails when there's a block in the way and burns
      // 3-4s of timeout per blocked drop. With the broom-sweep step first,
      // most drops in a cluster vanish on a single goto.
      const PICKUP_MAGNET_RANGE = 1.5;
      const PER_ITEM_TIMEOUT_MS = 1500;
      const SWEEP_TIMEOUT_MS = 3500;
      const OVERALL_BUDGET_MS = 18000;
      const start = Date.now();
      let skipped_unreachable = 0;
      const unreachableDropIds = new Set();
      let prevInv = invBefore;

      for (let attempt = 0; attempt < 3; attempt++) {
        if (Date.now() - start > OVERALL_BUDGET_MS) break;
        const pos = b.entity.position;
        const drops = Object.values(b.entities)
          .filter(e => (e.name === 'item' || e.displayName === 'Item') &&
                       !unreachableDropIds.has(e.id) &&
                       e.position.distanceTo(pos) < 16)
          .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos));

        if (drops.length === 0) break;

        // Broom sweep: pathfind through the cluster centroid with a wide
        // GoalNear so pathfinder has route flexibility and the auto-magnet
        // hoovers up everything it passes within 1.5m.
        if (drops.length >= 2) {
          let cx = 0, cy = 0, cz = 0;
          for (const d of drops) { cx += d.position.x; cy += d.position.y; cz += d.position.z; }
          cx /= drops.length; cy /= drops.length; cz /= drops.length;
          try {
            await gotoWithTimeout(
              b,
              new goals.GoalNear(cx, cy, cz, Math.max(2, PICKUP_MAGNET_RANGE)),
              SWEEP_TIMEOUT_MS,
            );
            await sleep(400);
          } catch { /* sweep failed — fall through to per-drop */ }
        }

        // Per-drop pickup for whatever the sweep missed.
        const remaining = drops.filter((d) => d.isValid);
        for (const drop of remaining.slice(0, 8)) {
          if (Date.now() - start > OVERALL_BUDGET_MS) break;
          if (!drop.isValid) continue; // magnet grabbed it already
          try {
            await gotoWithTimeout(
              b,
              new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, PICKUP_MAGNET_RANGE),
              PER_ITEM_TIMEOUT_MS,
            );
            await sleep(250);
          } catch (err) {
            // Memoize failures so the same wedged drop doesn't burn another
            // PER_ITEM_TIMEOUT_MS on each retry attempt.
            unreachableDropIds.add(drop.id);
            if (/** @type {Error} */ (err).message === 'pathfinder_timeout') {
              skipped_unreachable++;
            }
          }
        }
        // Inventory stuck → remaining drops are also unreachable, give up.
        const nowInv = b.inventory.items().reduce((s, i) => s + i.count, 0);
        if (nowInv === prevInv) break;
        prevInv = nowInv;
      }

      const invAfter = b.inventory.items().reduce((s, i) => s + i.count, 0);
      const gained = invAfter - invBefore;
      const note = skipped_unreachable > 0 ? ` (${skipped_unreachable} unreachable, skipped)` : '';
      return { result: gained > 0 ? `Picked up ${gained} items${note}.` : `No items picked up${note}.` };
    },

    async find_blocks({ block, radius = 32, count = 10 }) {
      const b = ensureBot();
      const blockName = resolveMiningBlockName(block);
      const blockType = ctx.world.mcData.blocksByName[blockName];
      if (!blockType) throw new Error(`Unknown block "${blockName}".`);

      const r = Math.min(Math.max(parseInt(String(radius), 10) || 32, 1), 96);
      const n = Math.min(Math.max(parseInt(String(count), 10) || 10, 1), 64);
      const baseYawDeg = (b.entity.yaw * 180) / Math.PI;

      const found = b
        .findBlocks({
          matching: blockType.id,
          maxDistance: r,
          count: n,
        })
        .map((p) => {
          const dx = p.x - b.entity.position.x;
          const dz = p.z - b.entity.position.z;
          const relDeg = (Math.atan2(dx, -dz) * 180) / Math.PI;
          return {
            position: { x: p.x, y: p.y, z: p.z },
            distance: fmt(b.entity.position.distanceTo(p)),
            bearing: bearingFromDelta(dx, dz),
            sector: classifySector(angleDiffDegrees(baseYawDeg, relDeg)),
          };
        });

      if (found.length === 0) {
        return { result: `No ${blockName} found within ${r} blocks.`, locations: [] };
      }

      const rawLocations = found.map((entry) => ({
        x: entry.position.x,
        y: entry.position.y,
        z: entry.position.z,
        distance: entry.distance,
        bearing: entry.bearing,
        sector: entry.sector,
      }));
      // #92: enrich with reachability + approach_cell so the agent
      // doesn't burn 30s walking toward a buried/floating candidate.
      // Sorted reachable-first by annotateReachability. maxVisit=512
      // gives the BFS ~D=8-15 coverage in typical terrain — enough for
      // 32-block scan_range while keeping latency under ~200ms total.
      const locations = annotateReachability(b, rawLocations, 512);
      const nReachable = locations.filter((l) => l.reachable).length;

      const fpNote = ctx.reactive.fairPlayMode ? ` (scout; mc collect needs trunk in sight)` : '';
      const reachNote = nReachable === locations.length
        ? ''
        : ` — ${nReachable}/${locations.length} reachable`;
      return { result: `Found ${found.length} ${blockName}${fpNote}${reachNote}`, locations };
    },

    async find_entities({ type, radius = 32 }) {
      const b = ensureBot();
      const pos = b.entity.position;
      const r = Math.min(96, Math.max(4, parseInt(String(radius), 10) || 32));

      let raw;
      if (ctx.reactive.fairPlayMode) {
        raw = await entitiesMatchingAfterLookSweep(b, pos, r, type);
      } else {
        raw = Object.values(b.entities).filter((e) => e !== b.entity && e.position.distanceTo(pos) < r);
        if (type) {
          const tl = String(type).toLowerCase();
          raw = raw.filter(
            (e) =>
              (e.name || '').toLowerCase().includes(tl) ||
              (e.username || '').toLowerCase().includes(tl) ||
              (e.displayName || '').toLowerCase().includes(tl),
          );
        }
      }

      let entities = raw
        .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos))
        .slice(0, 20)
        .map((e) => ({
          type: e.username || e.name || e.displayName || 'unknown',
          distance: fmt(e.position.distanceTo(pos)),
          position: posObj(e.position),
          health: e.health ?? undefined,
        }));

      return {
        result: `Found ${entities.length} ${type || 'entities'}${ctx.reactive.fairPlayMode ? ' (look sweep)' : ''}`,
        locations: entities.map((e) => ({ ...e.position, distance: e.distance, type: e.type })),
        entities,
      };
    },

    async complete_command({ index = 0, message }) {
      if (ctx.social.commandQueue.length === 0) return { result: 'No commands in queue.' };
      const pending = ctx.social.commandQueue.filter(c => c.status === 'pending' || c.status === 'acknowledged');
      if (index >= pending.length) return { result: 'No pending command at that index.' };
      const cmd = pending[index];
      cmd.status = 'completed';
      cmd.completed_at = Date.now();
      rememberSocialEvent({ actor: cmd.from, kind: 'completed_command', channel: cmd.channel || 'direct', message: cmd.command });
      const reply = message || `Done: "${cmd.command}"`;
      return { result: reply };
    },

    async acknowledge_command({ index = 0, plan }) {
      const pending = ctx.social.commandQueue.filter(c => c.status === 'pending');
      if (pending.length === 0) return { result: 'No pending commands to acknowledge.' };
      if (index >= pending.length) return { result: 'No pending command at that index.' };
      const cmd = pending[index];
      cmd.status = 'acknowledged';
      cmd.acknowledged_at = Date.now();
      if (plan) cmd.plan = plan;
      rememberSocialEvent({ actor: cmd.from, kind: 'acknowledged_command', channel: cmd.channel || 'direct', message: cmd.command });
      return { result: `Acknowledged: "${cmd.command}"${plan ? ` — plan: ${plan}` : ''}` };
    },

    async cancel_command({ index = 0, reason }) {
      const active = ctx.social.commandQueue.filter(c => c.status === 'pending' || c.status === 'acknowledged');
      if (active.length === 0) return { result: 'No active commands to cancel.' };
      if (index >= active.length) return { result: 'No command at that index.' };
      const cmd = active[index];
      cmd.status = 'cancelled';
      cmd.cancelled_at = Date.now();
      cmd.cancel_reason = reason || 'cancelled by bot';
      rememberSocialEvent({ actor: cmd.from, kind: 'cancelled_command', channel: cmd.channel || 'direct', message: cmd.command });
      return { result: `Cancelled: "${cmd.command}"${reason ? ` — ${reason}` : ''}` };
    },

    /**
     * Hazard-aware dig. Pre-checks for HAZARD_LAVA (adjacent lava), HAZARD_FALL
     * (digging the floor under the bot), and HAZARD_SUFFOCATE (falling-block
     * column above target in bot's vertical column). On hazard, returns
     * ok:false with structured error and DOES NOT swing. With force=true,
     * skips checks and delegates to mc dig (power-user override).
     */
    async safe_dig({ x, y, z, force }) {
      const b = ensureBot();
      if (![x, y, z].every((v) => Number.isFinite(Number(v)))) {
        return { ok: false, error: { code: 'INVALID_COORD', message: 'mc safe_dig requires numeric x, y, z', retry_safe: false } };
      }
      const tx = Math.floor(Number(x)), ty = Math.floor(Number(y)), tz = Math.floor(Number(z));
      if (force) return handlers.dig({ x: tx, y: ty, z: tz, force: true });

      const target = b.blockAt(new Vec3(tx, ty, tz));
      if (!target || target.name === 'air' || target.name === 'cave_air' || target.name === 'void_air') {
        return {
          ok: false,
          error: {
            code: 'NO_BLOCK_AT_COORD',
            message: `No block at ${tx}, ${ty}, ${tz} — target is ${target?.name || 'unknown'}`,
            observed_state: { block_at_target: target?.name || null, requested_coord: { x: tx, y: ty, z: tz } },
            retry_safe: false,
          },
        };
      }

      const hazard = detectDigHazards(b, tx, ty, tz);
      if (hazard) {
        const code =
          hazard.kind === 'lava' ? 'HAZARD_LAVA' :
          hazard.kind === 'fall' ? 'HAZARD_FALL' :
          'HAZARD_SUFFOCATE';
        const messages = {
          HAZARD_LAVA: `Lava at ${hazard.at?.x},${hazard.at?.y},${hazard.at?.z} would flow on the bot if ${target.name} at ${tx},${ty},${tz} is broken. Use mc seal to wall it off, or mc safe_dig --force to override.`,
          HAZARD_FALL: `Block at ${tx},${ty},${tz} is the floor under the bot — digging it would drop the bot ${hazard.drop} blocks. Step away first, or mc safe_dig --force to override.`,
          HAZARD_SUFFOCATE: `Falling-block column (${hazard.falling_block} × ${hazard.column_height}) above ${tx},${ty},${tz} would fall on the bot if dug. Approach from a side, or mc safe_dig --force to override.`,
        };
        return {
          ok: false,
          error: {
            code,
            message: messages[code],
            observed_state: { block_at_target: target.name, requested_coord: { x: tx, y: ty, z: tz }, hazard },
            retry_safe: false,
          },
        };
      }

      return handlers.dig({ x: tx, y: ty, z: tz });
    },
  };

  // ─ F45.2: wrap long-running actions with a wallclock cap ─
  // collect can run many pathfind+dig cycles; dig has the dig step itself.
  // Each inner pathfind has its own cap via gotoWithTimeout, but the outer
  // cap below is a defense-in-depth backstop so the brain never blocks on
  // a runaway. On timeout we stop pathfinder/dig and return a structured
  // OPERATION_TIMEOUT action-result.
  const _origCollect = handlers.collect;
  handlers.collect = async function (args) {
    try {
      return await raceWithTimeout(_origCollect(args), ACTION_CAPS_MS.collect, 'collect');
    } catch (err) {
      if (err instanceof OperationTimeoutError || err.code === 'OPERATION_TIMEOUT') {
        const b = ensureBot();
        try { b.pathfinder.setGoal(null); } catch { /* ignore */ }
        try { b.stopDigging(); } catch { /* ignore */ }
        return timeoutError('collect', ACTION_CAPS_MS.collect, {
          requested_block: args?.block,
          requested_count: args?.count,
          bot_position: posObj(b.entity.position),
        }, 'Collect was canceled. Inventory may be partially updated; check with mc inventory.');
      }
      throw err;
    }
  };

  const _origDig = handlers.dig;
  handlers.dig = async function (args) {
    try {
      return await raceWithTimeout(_origDig(args), ACTION_CAPS_MS.dig, 'dig');
    } catch (err) {
      if (err instanceof OperationTimeoutError || err.code === 'OPERATION_TIMEOUT') {
        const b = ensureBot();
        try { b.pathfinder.setGoal(null); } catch { /* ignore */ }
        try { b.stopDigging(); } catch { /* ignore */ }
        return timeoutError('dig', ACTION_CAPS_MS.dig, {
          requested_coord: { x: args?.x, y: args?.y, z: args?.z },
          bot_position: posObj(b.entity.position),
        }, 'Dig was canceled.');
      }
      throw err;
    }
  };

  return handlers;
}
