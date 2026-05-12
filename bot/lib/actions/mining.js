import { Vec3 } from 'vec3';
import { equipForDig, PROTECTED_DIG_BLOCKS, detectDigHazards } from '../bot/dig-tools.js';
import { bearingFromDelta, classifySector, angleDiffDegrees } from '../shared/perception.js';

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
 * @throws Error("pathfinder_timeout") on timeout, or the underlying
 *         pathfinder error otherwise.
 */
async function gotoWithTimeout(b, goal, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      b.pathfinder.goto(goal),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error('pathfinder_timeout')), timeoutMs);
      }),
    ]);
  } catch (err) {
    if (/** @type {Error} */ (err).message === 'pathfinder_timeout') {
      try { b.pathfinder.stop(); } catch { /* ignore */ }
      try { b.clearControlStates?.(); } catch { /* ignore */ }
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
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
  const { ctx, ensureBot, goals, fmt, posObj, sleep, log, resolveMiningBlockName, fairPlayHarvestTrunkCandidates, findVisibleBlocksByNameWithPhysicalSweep, entitiesMatchingAfterLookSweep, rememberSocialEvent, hasLineOfSight, eyePosition } = deps;

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
      const blockName = resolveMiningBlockName(block);
      const blockType = ctx.mcData.blocksByName[blockName];
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

      /** @type {Vec3[]} */
      let found = [];
      const isTrunkHarvest = /_log$|_stem$|^crimson_stem$|^warped_stem$/i.test(blockName);
      const isNonSolidPlant = blockType.boundingBox !== 'block';
      if (ctx.fairPlayMode) {
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

      // Source-block fallback: user asked for an item (e.g. "cobblestone")
      // but there are no blocks of that name in the world. In survival
      // you have to mine the source block (stone → cobblestone, coal_ore
      // → coal). Look up which block(s) drop the requested item and try
      // mining those instead. We accumulate accepted target names so the
      // dig-loop's `target.name !== blockName` filter doesn't reject the
      // substituted positions. Inventory accounting stays on blockName
      // (the requested item) since that's what gets dropped.
      let resolvedFromSource = null;
      const acceptedTargetNames = new Set([blockName]);
      if (found.length === 0) {
        const sources = sourceBlocksForItem(ctx.mcData, blockName);
        for (const altName of sources) {
          const altType = ctx.mcData.blocksByName[altName];
          if (!altType) continue;
          let altFound = [];
          if (ctx.fairPlayMode && !isNonSolidPlant) {
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
            found = altFound;
            acceptedTargetNames.add(altName);
            resolvedFromSource = altName;
            log(`[collect] No ${blockName} blocks visible; mining ${altName} as source (drops ${blockName}).`);
            break;
          }
        }
      }

      if (found.length === 0) {
        return {
          ok: false,
          error: {
            code: 'NO_VISIBLE_BLOCKS',
            message: ctx.fairPlayMode
              ? isTrunkHarvest
                ? `No ${blockName} with harvest line-of-sight in range (leaves/water between you and the trunk are ok; dirt/stone/other wood are not).`
                : `Can't see any ${blockName} right now. Turn, move, or use mc scene/mc look before collecting.`
              : `No ${blockName} found within 64 blocks.`,
            observed_state: {
              requested_block: blockName,
              requested_count: count,
              mined_count: 0,
              fair_play: ctx.fairPlayMode,
              search_range: ctx.fairPlayMode ? 16 : 64,
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
      // Flag flooded candidates so the order-step can de-prioritize them.
      // Mining a submerged block floods the access path and the bot
      // typically drowns. We don't filter — agent sees the candidate
      // count — but dry blocks try first.
      const isFlooded = (pos) => {
        const above = b.blockAt(pos.offset(0, 1, 0));
        if (above && (above.name === 'water' || above.name === 'flowing_water')) return true;
        let wn = 0;
        for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nb = b.blockAt(pos.offset(dx, 0, dz));
          if (nb && (nb.name === 'water' || nb.name === 'flowing_water')) wn++;
        }
        return wn >= 2;
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
        // 3D distance, nearest first. Flooded blocks sort LAST (they're
        // still attempted but only after dry candidates) since mining
        // them floods the access path. Tiebreak by lower Y so we tend
        // to clear the top surface before reaching higher columns.
        sorted = [...safe].sort((a, c) => {
          const aF = isFlooded(a) ? 1 : 0;
          const cF = isFlooded(c) ? 1 : 0;
          if (aF !== cF) return aF - cF;
          const aD = botPos.distanceTo(a);
          const cD = botPos.distanceTo(c);
          if (Math.abs(aD - cD) > 0.01) return aD - cD;
          return a.y - c.y;
        });
      }

      let collected = 0;
      let lastCollectErr = '';
      let attempted = 0;
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
      const posKey = (p) => `${p.x},${p.y},${p.z}`;

      // Block IDs we'll accept for cheap rediscovery scans (raw b.findBlocks).
      // Built from `acceptedTargetNames` so the source-block fallback (e.g.
      // requesting cobblestone → mining stone) still scans for the right id.
      const acceptedBlockIds = Array.from(acceptedTargetNames)
        .map((n) => ctx.mcData.blocksByName[n]?.id)
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
          // Reject candidates with anything-but-air directly above —
          // grass, water, lava, leaves all signal "you can't just walk
          // up and mine this".
          const above = b.blockAt(p.offset(0, 1, 0));
          if (above && !AIR_ABOVE.has(above.name)) continue;
          // Also reject candidates surrounded by water on 2+ sides —
          // mining them floods the access path.
          let waterNeighbours = 0;
          for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            const nb = b.blockAt(p.offset(dx, 0, dz));
            if (nb && (nb.name === 'water' || nb.name === 'flowing_water')) waterNeighbours++;
          }
          if (waterNeighbours >= 2) continue;
          out.push(p);
        }
        if (!isTrunkHarvest) {
          out.sort((a, c) => botPosNow.distanceTo(a) - botPosNow.distanceTo(c));
        }
        return out;
      };

      // First iteration uses the look-sweep-based `sorted` list (good for
      // initial discovery of which deposit to engage). Subsequent iterations
      // refresh via refreshPool() — newly-exposed neighbours included.
      let pool = sorted.slice();

      // Time + stall caps so collect never spins forever on a stuck deposit.
      // The slow physical sweep is gated behind the time cap too.
      const COLLECT_START_MS = Date.now();
      const COLLECT_BUDGET_MS = 60000;
      const MAX_STALL_ROUNDS = 3;
      let stallRounds = 0;

      while (
        collected < count &&
        Date.now() - COLLECT_START_MS < COLLECT_BUDGET_MS &&
        stallRounds < MAX_STALL_ROUNDS
      ) {
        const beforeRoundMined = collected;
        const remainingNeeded = count - collected;
        const roundBatch = Math.min(remainingNeeded, batchSize);

        for (const pos of pool.slice(0, roundBatch)) {
          if (collected >= count) break;
          const k = posKey(pos);
          if (triedKeys.has(k)) continue;
          triedKeys.add(k);
          attempted++;

          // Cancel-flag handling. The check only applies when collect is
          // RUNNING AS the background task — i.e. ctx.currentTask is this
          // very collect call. If currentTask references an earlier task
          // (e.g. a completed `mc fill` placed via /task/place_fill), its
          // status will be 'done'/'stuck' but UNRELATED to this collect:
          // we must NOT break, otherwise the loop exits silently with
          // attempted=N, collected=0, all causes=0 → "MIXED_FAILURE 0/N".
          // syncActionInFlight is true for /action/collect, so guard there.
          if (
            ctx.currentTask &&
            ctx.currentTask.action === 'collect' &&
            ctx.currentTask.status !== 'running' &&
            !ctx.syncActionInFlight
          ) {
            stallRounds = MAX_STALL_ROUNDS;
            break;
          }
          try {
            const target = b.blockAt(pos);
            if (!target || !acceptedTargetNames.has(target.name)) {
              causes.not_target_block++;
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
                continue;
              }
            }

            const recheck = b.blockAt(pos);
            if (!recheck || !acceptedTargetNames.has(recheck.name)) {
              causes.not_target_block++;
              continue;
            }
            const curPos = b.entity.position;
            if (curPos.distanceTo(pos) > 5.5) {
              causes.out_of_range_post_path++;
              continue;
            }
            const feetY = Math.floor(curPos.y);
            if (pos.y === feetY - 1 &&
                Math.abs(pos.x - Math.floor(curPos.x)) < 1 &&
                Math.abs(pos.z - Math.floor(curPos.z)) < 1) {
              causes.skipped_self_block++;
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
              continue;
            }

            await Promise.race([
              b.dig(recheck, true),
              new Promise((_, rej) => setTimeout(() => rej(new Error('dig_timeout')), 12000)),
            ]);
            collected++;
            await sleep(200);
          } catch (err) {
            const m = /** @type {Error} */ (err).message || String(err);
            if (m === 'dig_timeout') {
              try { b.stopDigging(); } catch {}
            }
            causes.dig_failed++;
            lastCollectErr = m;
            log(`[collect] Error mining ${blockName} at ${pos.x},${pos.y},${pos.z}: ${m}`);
          }
        }

        if (collected === beforeRoundMined) stallRounds++;
        else stallRounds = 0;

        if (collected >= count) break;

        // Refresh pool from current bot position — newly-exposed neighbours
        // around the mines we just made (and any blocks the bot rotated
        // into LOS during pathfinding) get picked up here.
        pool = refreshPool();
        if (pool.length === 0) stallRounds++;
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
      pickedUp = Math.max(0, endedBlockCount - startedBlockCount);

      const tips = [...tipSet];
      const tipsSuffix = tips.length ? ` Tips: ${tips.join(' | ')}` : '';

      // ─ Failure path: collected === 0 ─
      // Pick the best error code based on which cause dominated.
      if (collected === 0) {
        let code;
        let message;
        if (attempted === 0) {
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
      const msg = remaining > 0
        ? `Mined ${collected} ${blockName} (${remaining} more needed). Have ${endedBlockCount} ${blockName} in inventory.${sourceNote}${tipsSuffix}`
        : `Mined ${collected}/${count} ${blockName}. Have ${endedBlockCount} ${blockName} in inventory.${sourceNote}${tipsSuffix}`;

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
          ...(resolvedFromSource ? { mined_source_block: resolvedFromSource } : {}),
        },
        // Legacy fields for goal engine + existing tests.
        result: msg,
        ...(tips.length ? { hints: tips } : {}),
      };
    },

    async dig({ x, y, z }) {
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

      if (PROTECTED_DIG_BLOCKS.has(target.name)) {
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
          await gotoWithTimeout(b, new goals.GoalNear(x, y, z, 3), 10000);
        } catch (err) {
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
      const dropScanMs = Number(process.env.MC_DIG_DROP_SCAN_MS) || 300;
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
          ? (ctx.mcData.items[meta.itemId]?.name || `item:${meta.itemId}`)
          : (e.displayName || 'unknown');
        const count = meta?.itemCount ?? meta?.count ?? 1;
        dropped.push({
          name: itemName,
          count,
          position: posObj(e.position),
        });
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
      const blockType = ctx.mcData.blocksByName[blockName];
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

      const locations = found.map((entry) => ({
        x: entry.position.x,
        y: entry.position.y,
        z: entry.position.z,
        distance: entry.distance,
        bearing: entry.bearing,
        sector: entry.sector,
      }));

      const fpNote = ctx.fairPlayMode ? ` (scout; mc collect needs trunk in sight)` : '';
      return { result: `Found ${found.length} ${blockName}${fpNote}`, locations };
    },

    async find_entities({ type, radius = 32 }) {
      const b = ensureBot();
      const pos = b.entity.position;
      const r = Math.min(96, Math.max(4, parseInt(String(radius), 10) || 32));

      let raw;
      if (ctx.fairPlayMode) {
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
        result: `Found ${entities.length} ${type || 'entities'}${ctx.fairPlayMode ? ' (look sweep)' : ''}`,
        locations: entities.map((e) => ({ ...e.position, distance: e.distance, type: e.type })),
        entities,
      };
    },

    async complete_command({ index = 0, message }) {
      if (ctx.commandQueue.length === 0) return { result: 'No commands in queue.' };
      const pending = ctx.commandQueue.filter(c => c.status === 'pending' || c.status === 'acknowledged');
      if (index >= pending.length) return { result: 'No pending command at that index.' };
      const cmd = pending[index];
      cmd.status = 'completed';
      cmd.completed_at = Date.now();
      rememberSocialEvent({ actor: cmd.from, kind: 'completed_command', channel: cmd.channel || 'direct', message: cmd.command });
      const reply = message || `Done: "${cmd.command}"`;
      return { result: reply };
    },

    async acknowledge_command({ index = 0, plan }) {
      const pending = ctx.commandQueue.filter(c => c.status === 'pending');
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
      const active = ctx.commandQueue.filter(c => c.status === 'pending' || c.status === 'acknowledged');
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
      if (force) return handlers.dig({ x: tx, y: ty, z: tz });

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
  return handlers;
}
