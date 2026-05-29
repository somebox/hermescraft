import { equipForDig, isDigProtected } from '../../../runtime/dig-tools.js';
import {
  shouldSkipDigAt,
  createRegionSkipTracker,
} from '../../../runtime/regions/policy-guard.js';
import { ok, fail } from '../../../shared/action-contract.js';
import { priorRepeatBlockedAt } from '../../../runtime/dig-failure-ring.js';

import { gotoWithTimeout } from '../goto-with-timeout.js';
import { executePickupSweep } from '../pickup-sweep.js';

// ─ Tuning constants ────────────────────────────────────────────────────
// Pulled from inline literals into a single block. Comments explain each
// magic number's role; tweak here rather than hunting through the loop.

const COLLECT_TUNING = {
  // Outer harvest budget. Intentionally below ACTION_CAPS_MS.collect (40000ms)
  // so we surface a structured response BEFORE the outer wrapper fires
  // its OPERATION_TIMEOUT envelope.
  budgetMs: 35000,
  // How many empty/no-progress rounds before we give up.
  maxStallRounds: 3,
  // Anti-cascade: b.dig throwing "Digging aborted" in <100ms means the bot
  // is in a broken state (pathfinder residual, world transition, server
  // hiccup), not a real block-side failure. Two in a row → bail the
  // round so refreshPool() can reset.
  instantFailThresholdMs: 100,
  maxConsecInstantFails: 2,
  // Mining reach check thresholds (post-path verification).
  digReachMaxDistance: 4.5,   // need to pathfind closer if further than this
  digReachAbsoluteMax: 5.5,   // hard cap — pathfind "succeeded" but still too far
  // Two-stage pathfind: long horizontal jumps use a wider GoalNear first,
  // then a tighter GoalNear at full y precision.
  longApproachHorizDist: 4,
  longApproachTimeoutMs: 8000,
  closeApproachTimeoutMs: 6000,
  // Per-block dig race. Without this an interrupted dig would hang for
  // mineflayer's internal timeout, leaking pending timers.
  digTimeoutMs: 12000,
  // Post-dig settle: lets server-side block updates land before the next
  // candidate's b.blockAt() recheck.
  postDigSleepMs: 200,
  // Extra settle after water flowed into the dug cell (reactive plug path).
  // Gives flowing water 1-3 cells of spread time before refreshPool inspects.
  postDigFloodedSleepMs: 400,
  // refreshPool() x-ray scan parameters.
  refreshScanRange: 12,
  refreshScanCount: 80,
  // Pickup-sweep knobs (consumed by executePickupSweep).
  pickupScanRange: 12,
  pickupBudgetMs: 12000,
  pickupDropsPerPass: 6,
  pickupPostSweepSleepMs: 500,
  pickupPostDropSleepMs: 300,
  pickupInitialSleepMs: 600,
};

const AIR_ABOVE = new Set(['air', 'cave_air', 'void_air']);

// ─ State shape ─────────────────────────────────────────────────────────

/**
 * @typedef {object} HarvestState
 *   The mutable bag threaded through every phase. Phases mutate it in
 *   place rather than returning new objects — simpler than wrapping
 *   ~15 outputs per phase, and the lifecycle is single-call so there's
 *   no sharing risk.
 *
 * @property {import('./index.js').CollectContext} cctx
 * @property {object} phaseInputs
 * @property {number} collected
 * @property {number} attempted
 * @property {string} lastCollectErr
 * @property {boolean} wasCancelled
 * @property {Record<string, number>} causes
 * @property {ReturnType<typeof createRegionSkipTracker>} regionSkips
 * @property {Set<string>} tipSet
 * @property {Set<string>} triedKeys
 * @property {Set<string>} noMineKeys
 * @property {Error|null} preDigRefusal
 * @property {import('vec3').Vec3[]} pool
 * @property {string} lastRefreshCell
 * @property {number} stallRounds
 * @property {number} startMs
 * @property {number[]} acceptedBlockIds
 * @property {Map<string,{ hints: string[], held: string }>} equipHintsCache
 * @property {{ pickedUpPositions: object[] } | null} sweepResult
 */

function posKey(p) {
  return `${p.x},${p.y},${p.z}`;
}

function botCellKey(b) {
  return `${Math.floor(b.entity.position.x)},${Math.floor(b.entity.position.z)}`;
}

// ─ Phase 0: state setup ────────────────────────────────────────────────

/** @returns {HarvestState} */
function buildHarvestState(cctx, phaseInputs) {
  const { b, ctx } = cctx;
  const { acceptedTargetNames, sorted } = phaseInputs;
  return {
    cctx,
    phaseInputs,
    collected: 0,
    attempted: 0,
    lastCollectErr: '',
    wasCancelled: false,
    // Per-cause attempt counters — every `continue` in the loop bumps one.
    causes: {
      not_target_block: 0,      // block changed under us before we got there
      pathfind_failed: 0,       // both pathfind attempts threw
      out_of_range_post_path: 0,// pathfind "succeeded" but distance still > 5.5
      skipped_self_block: 0,    // would dig the block we're standing on
      behind_wall: 0,           // no LOS after pathfind (another block in the way)
      dig_failed: 0,            // b.dig threw (timeout, server reject, etc.)
      region_protected: 0,      // inside a region whose policy denies dig
      building_protected: 0,    // global denylist (recent placements, building marks)
      repeat_blocked: 0,        // mc dig already gave up on this cell in the last 60s
    },
    regionSkips: createRegionSkipTracker(),
    tipSet: new Set(),
    triedKeys: new Set(),
    // Cells where the last dig flooded — refreshPool skips them so we don't
    // re-mine the freshly-plugged spot and start the water cycle again.
    // Distinct from triedKeys: triedKey = "attempted once already";
    // noMineKey = "actively dangerous, do not approach".
    noMineKeys: new Set(),
    preDigRefusal: null,
    pool: sorted.slice(),
    lastRefreshCell: botCellKey(b),
    stallRounds: 0,
    startMs: Date.now(),
    // Block IDs accepted by refreshPool's raw findBlocks scan.
    acceptedBlockIds: Array.from(acceptedTargetNames)
      .map((n) => ctx.world.mcData.blocksByName[n]?.id)
      .filter((id) => typeof id === 'number'),
    // equipForDig cache — block name → hint list. Within one collect call
    // the held tool only changes via equipForDig itself, so per-name
    // caching is safe.
    equipHintsCache: new Map(),
    sweepResult: null,
  };
}

// ─ Phase 1: pool refresh ───────────────────────────────────────────────

/**
 * Re-gather candidate pool from the bot's CURRENT position. Uses raw
 * b.findBlocks (cheap, no physical look-sweep) gated by per-candidate
 * canSeeMinableFace — that's the fair-play LOS check the dig loop would
 * apply anyway. Effect: we get x-ray-style discovery limited to blocks
 * with at least one bot-facing exposed face. After each dig, neighbours
 * that were buried become reachable and re-appear in the next pool.
 * Closes the "1 candidate per call" hole we hit in G20 v25 mining the
 * stone deposit.
 */
function createRefreshPool(state) {
  const { b } = state.cctx;
  const { stripPlaneFloorY, stripSort, isFlooded, isTrunkHarvest } = state.phaseInputs;
  const { canSeeMinableFace } = state.cctx;

  return function refreshPool() {
    if (state.acceptedBlockIds.length === 0) return [];
    const raw = b.findBlocks({
      matching: state.acceptedBlockIds,
      maxDistance: COLLECT_TUNING.refreshScanRange,
      count: COLLECT_TUNING.refreshScanCount,
    });
    const out = [];
    // Surface-bias + water-rejection. The look-sweep-based initial scan
    // already applies surface-bias, but b.findBlocks is x-ray: it'll
    // happily return underwater stone and stones under grass. The LOS
    // guard alone doesn't reject those because water has
    // boundingBox='empty' (raycasts pass through). G20 v27 mined the
    // stone deposit, ran out of LOS-reachable surface candidates, then
    // refreshPool() pulled in (-2,63,8) — stone *under the pond*. Bot
    // walked into water and got stuck for 8s wiggling. Reject upfront.
    for (const p of raw) {
      const k = posKey(p);
      if (state.triedKeys.has(k)) continue;
      if (!canSeeMinableFace(p)) continue;
      // Strip-plane lock: don't auto-dive below the initial scan's
      // deepest Y. Newly-uncovered cells whose ceiling just became air
      // would otherwise turn a flat strip into a downward tunnel.
      // Trunk harvests bypass this above.
      if (p.y < stripPlaneFloorY) continue;
      // Reject candidates with anything-but-air directly above — grass,
      // water, lava, leaves all signal "you can't just walk up and mine
      // this".
      const above = b.blockAt(p.offset(0, 1, 0));
      if (above && !AIR_ABOVE.has(above.name)) continue;
      // Strict water-adjacency: any of the 6 face-neighbours being water
      // (source or flowing) → skip. Matches isFlooded above.
      if (isFlooded(p)) continue;
      if (state.noMineKeys.has(k)) continue;
      out.push(p);
    }
    if (!isTrunkHarvest) {
      // Strip-mine sort keeps the pattern coherent as the bot moves.
      // Plain distance-sort produced star-pattern scatter once
      // refreshPool kicked in.
      return stripSort(out);
    }
    return out;
  };
}

// ─ Phase 2a: equip cache ───────────────────────────────────────────────

function createEquipForDigCached(state) {
  const { b } = state.cctx;
  return async function equipForDigCached(target) {
    const cached = state.equipHintsCache.get(target.name);
    // The cache memoizes the advisory HINTS only — it must NOT short-circuit
    // the equip + slow-dig guard, because a tool can BREAK mid-collect
    // (durability → 0 empties the hand). Re-running equipForDig every
    // candidate would be wasteful, so on a cache hit we cheaply confirm the
    // held item is still what we equipped for this block. If it changed (tool
    // shattered, or the agent swapped hands), fall through and re-validate:
    // equipForDig either re-equips a spare from inventory or throws
    // "Refusing to dig …", which collect treats as a pre-dig refusal and
    // aborts the whole call instead of stabbing stone bare-handed.
    if (cached && (b.heldItem?.name || '') === cached.held) {
      return { hints: cached.hints };
    }
    const result = await equipForDig(b, target);
    state.equipHintsCache.set(target.name, {
      hints: result.hints || [],
      held: b.heldItem?.name || '',
    });
    return result;
  };
}

// ─ Phase 2b: per-candidate harvest step ────────────────────────────────

/**
 * Process a single candidate cell. Mutates state in place. Returns one of:
 *   'continue' — go to next candidate in the round
 *   'break_round' — anti-cascade or task-status-stuck; abort this round
 *   'break_call' — preDigRefusal set; abort the whole call
 *   'done' — collected >= count
 */
async function processCandidate(state, pos, equipForDigCached, instantFailState) {
  const { cctx } = state;
  const { b, ctx, config, goals, sleep, log, force, canSeeMinableFace, count, blockName } = cctx;
  const { acceptedTargetNames } = state.phaseInputs;

  const k = posKey(pos);
  if (state.triedKeys.has(k)) return 'continue';

  // Background-task cancel handling. The check only applies when collect
  // is RUNNING AS the background task. If currentTask references an
  // earlier task (e.g. a completed `mc fill`), its status is 'done'/'stuck'
  // but UNRELATED to this collect — we must NOT break, or the loop exits
  // silently with attempted=N, collected=0 → "MIXED_FAILURE 0/N".
  // syncActionInFlight is true for /action/collect, so guard there.
  if (
    ctx.tasks.currentTask
    && ctx.tasks.currentTask.action === 'collect'
    && ctx.tasks.currentTask.status !== 'running'
    && !ctx.tasks.syncActionInFlight
  ) {
    state.stallRounds = COLLECT_TUNING.maxStallRounds;
    return 'break_round';
  }

  // triedKeys marking happens per-outcome below — instant-fail dig aborts
  // (cascade) intentionally do NOT mark the candidate tried, so a
  // recovered bot can retry it next round via refreshPool().
  state.attempted++;

  // Cross-call: if mc dig already exhausted its retry budget on this cell
  // in the last 60s, don't replay the same failure here. Read-only — we
  // don't write into the ring from collect because positional causes
  // (pathfind_failed, behind_wall) would block legitimate reposition+retry.
  if (priorRepeatBlockedAt(ctx, pos.x, pos.y, pos.z)) {
    state.causes.repeat_blocked++;
    state.triedKeys.add(k);
    instantFailState.consec = 0;
    return 'continue';
  }

  let digStartedAt = 0;

  try {
    const target = b.blockAt(pos);
    if (!target || !acceptedTargetNames.has(target.name)) {
      state.causes.not_target_block++;
      state.triedKeys.add(k);
      instantFailState.consec = 0;
      return 'continue';
    }
    const { hints } = await equipForDigCached(target);
    for (const h of hints) state.tipSet.add(h);

    const dist = b.entity.position.distanceTo(pos);
    if (dist > COLLECT_TUNING.digReachMaxDistance) {
      const curPos = b.entity.position;
      const horizDist = Math.abs(pos.x - curPos.x) + Math.abs(pos.z - curPos.z);
      let pathOk = false;
      if (horizDist > COLLECT_TUNING.longApproachHorizDist) {
        const navY = Math.floor(curPos.y);
        try {
          await gotoWithTimeout(b, new goals.GoalNear(pos.x, navY, pos.z, 2), COLLECT_TUNING.longApproachTimeoutMs);
          pathOk = true;
        } catch {
          try {
            await gotoWithTimeout(b, new goals.GoalNear(pos.x, pos.y, pos.z, 3), COLLECT_TUNING.closeApproachTimeoutMs);
            pathOk = true;
          } catch { /* both attempts failed */ }
        }
      } else {
        try {
          await gotoWithTimeout(b, new goals.GoalNear(pos.x, pos.y, pos.z, 2), COLLECT_TUNING.closeApproachTimeoutMs);
          pathOk = true;
        } catch { /* close pathfind failed */ }
      }
      if (!pathOk) {
        state.causes.pathfind_failed++;
        state.triedKeys.add(k);
        instantFailState.consec = 0;
        return 'continue';
      }
    }

    const recheck = b.blockAt(pos);
    if (!recheck || !acceptedTargetNames.has(recheck.name)) {
      state.causes.not_target_block++;
      state.triedKeys.add(k);
      instantFailState.consec = 0;
      return 'continue';
    }
    const curPos = b.entity.position;
    if (curPos.distanceTo(pos) > COLLECT_TUNING.digReachAbsoluteMax) {
      state.causes.out_of_range_post_path++;
      state.triedKeys.add(k);
      instantFailState.consec = 0;
      return 'continue';
    }
    const feetY = Math.floor(curPos.y);
    if (pos.y === feetY - 1
        && Math.abs(pos.x - Math.floor(curPos.x)) < 1
        && Math.abs(pos.z - Math.floor(curPos.z)) < 1) {
      state.causes.skipped_self_block++;
      state.triedKeys.add(k);
      instantFailState.consec = 0;
      return 'continue';
    }

    // Post-pathfind LOS check. mineflayer.dig sends a server packet that
    // Paper accepts as long as the block is within reach — it does NOT
    // verify there's no other block in the way. So candidates that passed
    // the initial visibility scan but are now BEHIND a freshly-exposed
    // wall (or were always visible only by their top face from a viewing
    // angle the bot no longer has) would otherwise still get a dig packet
    // and produce an unfair "stab through stone" mine. Refuse here.
    if (!canSeeMinableFace(pos)) {
      state.causes.behind_wall++;
      state.triedKeys.add(k);
      instantFailState.consec = 0;
      return 'continue';
    }

    // Protection parity with mc dig: refuse region-policy denies and
    // global-denylist hits (recent placements, building marks). The
    // initial scan can return a cliff-of-dirt that happens to be a
    // building floor, or stone that's part of a region wall — without
    // this check, collect would happily eat them. Force flag mirrors
    // mc dig --force for power users.
    if (!force) {
      const skip = shouldSkipDigAt(ctx, config, recheck.name, pos.x, pos.y, pos.z, isDigProtected);
      if (skip.skip) {
        if (skip.regionId) {
          state.causes.region_protected++;
          state.regionSkips.noteSkip(skip.regionId);
        } else {
          state.causes.building_protected++;
        }
        state.triedKeys.add(k);
        instantFailState.consec = 0;
        return 'continue';
      }
    }

    digStartedAt = Date.now();
    // Race b.dig against the dig-timeout. Capture the timer handle so we
    // can clear it on dig success/failure — otherwise each dig leaks a
    // pending setTimeout that keeps Node's event loop alive for 12s after
    // the call returns. Cumulative across a long collect, that's seconds
    // of phantom tail latency.
    let digTimer;
    const digTimeoutP = new Promise((_, rej) => {
      digTimer = setTimeout(() => rej(new Error('dig_timeout')), COLLECT_TUNING.digTimeoutMs);
    });
    try {
      await Promise.race([b.dig(recheck, true), digTimeoutP]);
    } finally {
      clearTimeout(digTimer);
    }
    state.collected++;
    state.triedKeys.add(k);
    instantFailState.consec = 0;
    await sleep(COLLECT_TUNING.postDigSleepMs);

    // Reactive water guard: if water flowed into the just-dug cell (a
    // hidden source we couldn't see pre-dig), mark the cell + its 4
    // horizontal neighbours as no-mine so the next refreshPool() doesn't
    // return them. We don't try to place a plug block here (that needs
    // equip + face-targeting) — we just stop digging into the wet zone
    // and rely on the agent / next call to recover. Extra settle so
    // flowing water has time to spread before refreshPool inspects.
    const postDig = b.blockAt(pos);
    if (postDig && (postDig.name === 'water' || postDig.name === 'flowing_water')) {
      log(`[collect] dig at ${pos.x},${pos.y},${pos.z} produced water — adding cell + neighbours to no-mine list`);
      state.noMineKeys.add(k);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        state.noMineKeys.add(`${pos.x + dx},${pos.y},${pos.z + dz}`);
      }
      await sleep(COLLECT_TUNING.postDigFloodedSleepMs);
    }
    if (state.collected >= count) return 'done';
    return 'continue';
  } catch (err) {
    const m = /** @type {Error} */ (err).message || String(err);
    const digElapsed = digStartedAt ? Date.now() - digStartedAt : 0;
    const isInstantAbort = digStartedAt > 0
      && digElapsed < COLLECT_TUNING.instantFailThresholdMs
      && /aborted/i.test(m);
    // Pre-dig refusal from equipForDig/assertCanDig — thrown BEFORE
    // digStartedAt was set. "Refusing to dig X with empty hand" or "Wrong
    // hand for X". Same outcome for every candidate of this block, so
    // bail the call.
    const isPreDigRefusal = digStartedAt === 0
      && (/^Refusing to dig/i.test(m) || /^Wrong hand for/i.test(m));
    if (isPreDigRefusal) {
      state.preDigRefusal = /** @type {Error} */ (err);
      log(`[collect] ${m} — bailing (no point retrying ${state.pool.length - 1} more ${blockName} blocks with the same hand)`);
      return 'break_call';
    }
    if (m === 'dig_timeout') {
      try { b.stopDigging(); } catch {}
    }
    state.causes.dig_failed++;
    state.lastCollectErr = m;
    log(`[collect] Error mining ${blockName} at ${pos.x},${pos.y},${pos.z}: ${m}${isInstantAbort ? ' (instant — not marking tried)' : ''}`);
    if (isInstantAbort) {
      // Don't burn the candidate; refreshPool can re-discover it.
      instantFailState.consec++;
      if (instantFailState.consec >= COLLECT_TUNING.maxConsecInstantFails) {
        log(`[collect] ${instantFailState.consec} consecutive instant aborts — bailing this round so the bot can recover state.`);
        // Try to clear any residual pathfinder/dig state before next round.
        try { b.pathfinder.stop(); } catch {}
        try { b.clearControlStates?.(); } catch {}
        try { b.stopDigging(); } catch {}
        return 'break_round';
      }
    } else {
      // Real dig failure (timeout or server reject). Burn the candidate.
      state.triedKeys.add(k);
      instantFailState.consec = 0;
    }
    return 'continue';
  }
}

// ─ Phase 2c: one outer-while round ─────────────────────────────────────

/**
 * Runs one round of the harvest loop: walks pool[0..roundBatch], processes
 * each candidate, then advances/refreshes the pool. Returns true when the
 * outer loop should break.
 */
async function runHarvestRound(state, equipForDigCached, refreshPool) {
  const { cctx } = state;
  const { b, ctx, count, batchSize } = cctx;

  const beforeRoundMined = state.collected;
  const remainingNeeded = count - state.collected;
  const roundBatch = Math.min(remainingNeeded, batchSize);
  const instantFailState = { consec: 0 };

  // Per-candidate loop.
  for (const pos of state.pool.slice(0, roundBatch)) {
    if (state.collected >= count) break;
    // mc stop sets ctx.tasks.cancelRequested. Works for both sync and
    // background paths.
    if (ctx.tasks.cancelRequested) {
      state.wasCancelled = true;
      break;
    }
    const verdict = await processCandidate(state, pos, equipForDigCached, instantFailState);
    if (verdict === 'break_round') break;
    if (verdict === 'break_call') break;
    if (verdict === 'done') break;
    // 'continue' falls through to next iteration.
  }

  if (state.preDigRefusal) return true;

  if (state.collected === beforeRoundMined) state.stallRounds++;
  else state.stallRounds = 0;

  if (state.collected >= count) return true;

  // Advance the pool past what we just walked. Cells that succeeded or
  // failed are in triedKeys; instant-abort cells aren't, but they sit
  // earlier in `pool` so refreshPool would also include them after a
  // re-scan. Slicing here keeps the strip ordering intact between
  // refreshes.
  state.pool = state.pool.slice(roundBatch);

  // Refresh conditions — refreshPool is moderately expensive (b.findBlocks
  // + per-candidate face raycast + above/water filters on up to 80 hits),
  // so only re-scan when there's a real reason to:
  //   - pool is depleted (no pre-discovered candidates left for next round),
  //   - the bot moved cells (new candidates may now be in LOS),
  //   - we stalled this round (newly-exposed neighbours might unblock).
  const cellNow = botCellKey(b);
  const botMoved = cellNow !== state.lastRefreshCell;
  const stalledThisRound = state.collected === beforeRoundMined;
  if (state.pool.length < Math.min(remainingNeeded, batchSize) || botMoved || stalledThisRound) {
    state.pool = refreshPool();
    state.lastRefreshCell = cellNow;
    if (state.pool.length === 0) state.stallRounds++;
  }
  return false;
}

// ─ Phase 2: full harvest loop ──────────────────────────────────────────

async function runHarvestLoop(state, equipForDigCached, refreshPool) {
  const { cctx } = state;
  const { count, ctx } = cctx;
  while (
    state.collected < count
    && Date.now() - state.startMs < COLLECT_TUNING.budgetMs
    && state.stallRounds < COLLECT_TUNING.maxStallRounds
    && !ctx.tasks.cancelRequested
  ) {
    const shouldBreak = await runHarvestRound(state, equipForDigCached, refreshPool);
    if (shouldBreak) break;
  }
}

// ─ Phase 3: pickup pass ────────────────────────────────────────────────

async function runPickupPass(state) {
  const { b, goals, sleep, blockName, inventoryAt } = state.cctx;
  state.sweepResult = await executePickupSweep(b, goals, sleep, {
    scanRange: COLLECT_TUNING.pickupScanRange,
    overallBudgetMs: COLLECT_TUNING.pickupBudgetMs,
    dropsPerPass: COLLECT_TUNING.pickupDropsPerPass,
    postSweepSleepMs: COLLECT_TUNING.pickupPostSweepSleepMs,
    postDropSleepMs: COLLECT_TUNING.pickupPostDropSleepMs,
    initialSleepMs: COLLECT_TUNING.pickupInitialSleepMs,
    recordPositions: true,
    stallCheck: () => (inventoryAt()[blockName] || 0),
  });
}

// ─ Phase 4: inventory accounting ───────────────────────────────────────

/**
 * Snapshot inventory after the pickup pass. Computes the per-name gains,
 * the requested-block delta, and the expected drop-item name (e.g.
 * iron_ore → raw_iron when mined with iron_pickaxe).
 */
function buildAccountingSnapshot(state) {
  const { ctx, blockName, inventoryAt, startedInventory, startedBlockCount } = state.cctx;
  const endedInventory = inventoryAt();
  const endedBlockCount = endedInventory[blockName] || 0;

  // pickedUp tracks the *requested* item's inventory gain. Right for
  // `mc collect dirt` (mined via grass_block source — blockName='dirt'
  // matches the drop). Wrong for `mc collect grass_block` because
  // grass_block drops dirt, so endedBlockCount stays 0 even though dirt
  // entered the inventory. Compute the inventory-wide delta too.
  const pickedUp = Math.max(0, endedBlockCount - startedBlockCount);
  const inventoryGains = {};
  for (const [name, endCount] of Object.entries(endedInventory)) {
    const startCount = startedInventory[name] || 0;
    const delta = endCount - startCount;
    if (delta > 0) inventoryGains[name] = delta;
  }
  const totalGain = Object.values(inventoryGains).reduce((s, n) => s + n, 0);

  // Task #33 — derive the expected drop item name so the success message
  // can report the ACTUAL item the agent got (iron_ore → raw_iron,
  // coal_ore → coal). mcData.blocksByName[blockName].drops is the
  // canonical source; first drop entry wins.
  const blockMeta = ctx.world.mcData.blocksByName?.[blockName];
  let dropItemName = blockName;
  if (blockMeta && Array.isArray(blockMeta.drops) && blockMeta.drops.length > 0) {
    const first = blockMeta.drops[0];
    const dropId = (typeof first === 'object') ? (first.drop?.id ?? first.id ?? first) : first;
    const dropItem = ctx.world.mcData.items?.[dropId];
    if (dropItem?.name) dropItemName = dropItem.name;
  }
  const droppedItemDelta = dropItemName === blockName
    ? endedBlockCount - startedBlockCount
    : (endedInventory[dropItemName] || 0) - (startedInventory[dropItemName] || 0);
  const inventoryHave = Math.max(0, droppedItemDelta);
  const dropNote = dropItemName !== blockName ? ` (drops as ${dropItemName})` : '';

  return {
    endedInventory,
    pickedUp,
    inventoryGains,
    totalGain,
    dropItemName,
    dropNote,
    inventoryHave,
  };
}

// ─ Phase 5a: TOOL_INADEQUATE early return ─────────────────────────────

function buildToolInadequateEnvelope(state) {
  const { b, count, blockName } = state.cctx;
  return fail('TOOL_INADEQUATE', state.preDigRefusal.message, {
    observed_state: {
      block_name: blockName,
      requested_count: count,
      mined_count: state.collected,
      attempted: state.attempted,
      held: b.heldItem?.name || null,
      candidates_remaining: state.pool.length,
    },
    next_action_hint: state.preDigRefusal.message,
    retry_safe: false,
  });
}

// ─ Phase 5b: failure-code dispatch ─────────────────────────────────────

/**
 * Sorted-by-specificity rule table. First match wins. Adding a new cause
 * is a one-rule append — no nested if/else cascade to thread through.
 */
function pickFailureCode(state) {
  const { ctx, blockName } = state.cctx;
  const { causes, attempted, wasCancelled, lastCollectErr } = state;
  const dominant = () => Object.entries(causes).sort((a, c) => c[1] - a[1])[0];
  // reachedBy = "cells we actually attempted to dig". Subtract every cause
  // that short-circuits BEFORE the b.dig() call. All current causes except
  // `dig_failed` itself fall into that bucket — and `dig_failed` is the
  // numerator the ALL_DIG_FAILED rule compares against. Adding a new cause
  // counter means appending it to this list (or all callers under-trigger
  // the dedicated rule and fall through to the generic catch-all).
  const reachedBy = () =>
    attempted
    - causes.pathfind_failed
    - causes.not_target_block
    - causes.skipped_self_block
    - causes.out_of_range_post_path
    - causes.behind_wall
    - causes.region_protected
    - causes.building_protected
    - causes.repeat_blocked;
  const mixedCodeFromDominant = (key) =>
    key === 'pathfind_failed'    ? 'ALL_PATHFIND_FAILED' :
    key === 'dig_failed'         ? 'ALL_DIG_FAILED' :
    key === 'region_protected'   ? 'REGION_PROTECTED' :
    key === 'building_protected' ? 'PROTECTED_BLOCK' :
    key === 'repeat_blocked'     ? 'DIG_BLOCKED_REPEAT' :
                                   'MIXED_FAILURE';

  const rules = [
    {
      // `wasCancelled` is set inside the inner for-loop; but if
      // cancelRequested was already true at entry to the outer while (e.g.
      // set during the initial visibility scan), the loop never iterates
      // and the local flag stays false. Trust the source flag too so the
      // response code matches the actual reason.
      when: () => wasCancelled || ctx.tasks.cancelRequested,
      code: () => 'CANCELLED',
      message: () => `Collect cancelled by mc stop before any ${blockName} was mined.`,
    },
    {
      // Defensive — `safe.length === 0` already returns NO_VISIBLE_BLOCKS
      // upstream, so this should be unreachable.
      when: () => attempted === 0,
      code: () => 'NO_VISIBLE_BLOCKS',
      message: () => `Found candidates but none made it into the harvest queue.`,
    },
    {
      when: () => causes.pathfind_failed === attempted,
      code: () => 'ALL_PATHFIND_FAILED',
      message: () => `Found ${attempted} ${blockName} candidates but pathfinding failed on every attempt.`,
    },
    {
      // Every cell that reached the dig step failed there. Guard `> 0` so
      // we don't fire when reachedBy() is 0 (all-cells-skipped-by-some-
      // other-cause — those have their own dedicated rules below).
      when: () => causes.dig_failed > 0 && causes.dig_failed >= reachedBy(),
      code: () => 'ALL_DIG_FAILED',
      message: () => `Reached ${reachedBy()} ${blockName} but every dig failed (${lastCollectErr || 'unknown reason'}).`,
    },
    {
      when: () => causes.region_protected + causes.building_protected === attempted,
      code: () => causes.region_protected >= causes.building_protected ? 'REGION_PROTECTED' : 'PROTECTED_BLOCK',
      message: function () {
        return this.code() === 'REGION_PROTECTED'
          ? `All ${attempted} ${blockName} candidates are inside protected region(s). Move to an unprotected deposit or get permission to dig here.`
          : `All ${attempted} ${blockName} candidates are part of a building (recent placements / building marks). Move to a wilder deposit, or pass --force if you know they're yours to take.`;
      },
    },
    {
      // mc dig already gave up on every cell in our pool in the last 60s.
      // Mirrors mc dig's DIG_BLOCKED_REPEAT — the user should reposition.
      when: () => causes.repeat_blocked === attempted,
      code: () => 'DIG_BLOCKED_REPEAT',
      message: () => `Every ${attempted} ${blockName} candidate is in the recent-dig-failure ring. mc dig couldn't break them in the last 60s — pillar away, approach from a different side, or call mc advise.`,
    },
    {
      // Catch-all — mixed cause distribution. Pick the dominant counter.
      when: () => true,
      code: () => mixedCodeFromDominant(dominant()[0]),
      message: () => {
        const top = dominant();
        return `Could not mine any ${blockName} (${attempted} attempts). Dominant cause: ${top[0]} (${top[1]}/${attempted}).`;
      },
    },
  ];
  const winner = rules.find((r) => r.when());
  return { code: winner.code(), message: winner.message() };
}

/**
 * T3 reposition hint. When `behind_wall` dominates the failure distribution,
 * the bot can see SOMETHING but not the face it needs — another block
 * sits between the bot and the candidate's bot-facing face. Suggest moving
 * to a different cardinal of the first candidate. Returns null when not
 * applicable.
 *
 * Round-2/3 in-game QA: Steve called `mc collect oak_log` from 1.5m off a
 * trunk and got `behind_wall (4/4)` every time because the candidates'
 * faces were occluded by neighbouring logs. With this hint he gets a
 * concrete cell to walk to before the retry.
 */
function maybeBuildBehindWallHint(state) {
  const { b } = state.cctx;
  const { found } = state.phaseInputs;
  const topCause = Object.entries(state.causes).sort((a, c) => c[1] - a[1])[0]?.[0];
  if (topCause !== 'behind_wall' || found.length === 0 || !b?.entity?.position) return null;
  const cand = found[0];
  const firstCandidate = { x: cand.x, y: cand.y, z: cand.z };
  const bx = Math.floor(b.entity.position.x);
  const bz = Math.floor(b.entity.position.z);
  const dxToCand = cand.x - bx;
  const dzToCand = cand.z - bz;
  const skipDir = Math.abs(dxToCand) >= Math.abs(dzToCand)
    ? (dxToCand > 0 ? 'east' : 'west')
    : (dzToCand > 0 ? 'south' : 'north');
  const cardinals = [
    { name: 'north', cell: { x: cand.x, y: cand.y, z: cand.z - 1 } },
    { name: 'south', cell: { x: cand.x, y: cand.y, z: cand.z + 1 } },
    { name: 'east',  cell: { x: cand.x + 1, y: cand.y, z: cand.z } },
    { name: 'west',  cell: { x: cand.x - 1, y: cand.y, z: cand.z } },
  ].filter((c) => c.name !== skipDir);
  const nextActionHint =
    `Another block is blocking the line-of-sight to ${cand.x},${cand.y},${cand.z}. ` +
    `mc move to a different cardinal then re-call mc collect. Suggested cells: ` +
    cardinals.map((c) => `${c.name} (${c.cell.x},${c.cell.y},${c.cell.z})`).join(', ') + '.';
  return { firstCandidate, nextActionHint };
}

function buildFailureEnvelope(state) {
  const { count, blockName } = state.cctx;
  const { found } = state.phaseInputs;
  const { code, message } = pickFailureCode(state);
  const repositionHint = maybeBuildBehindWallHint(state);
  const tips = [...state.tipSet];

  const failResult = fail(code, message, {
    observed_state: {
      requested_block: blockName,
      requested_count: count,
      mined_count: 0,
      attempted: state.attempted,
      causes: state.causes,
      candidates_found: found.length,
      last_inner_error: state.lastCollectErr || null,
      ...state.regionSkips.dataFields(),
      ...(repositionHint ? { first_candidate: repositionHint.firstCandidate } : {}),
    },
    // pathfinding rarely improves on retry without the bot moving
    retry_safe: code !== 'ALL_PATHFIND_FAILED',
    ...(repositionHint ? { next_action_hint: repositionHint.nextActionHint } : {}),
  });
  if (tips.length) failResult.hints = tips;
  return failResult;
}

// ─ Phase 5c: success envelope ──────────────────────────────────────────

function buildSuccessEnvelope(state, accounting) {
  const { count, blockName, startedInventory } = state.cctx;
  const { resolvedFromSource } = state.phaseInputs;
  const tips = [...state.tipSet];
  const tipsSuffix = tips.length ? ` Tips: ${tips.join(' | ')}` : '';

  const remaining = count - state.collected;
  const partialFailure = remaining > 0;
  const sourceNote = resolvedFromSource ? ` [mined ${resolvedFromSource} as source]` : '';
  const cancelNote = state.wasCancelled ? ' [cancelled mid-task]' : '';
  const { endedInventory, pickedUp, inventoryGains, totalGain, dropItemName, dropNote, inventoryHave } = accounting;
  const msg = remaining > 0
    ? `Mined ${state.collected} ${blockName}${dropNote} (${remaining} more needed). Have ${inventoryHave} ${dropItemName} in inventory.${sourceNote}${cancelNote}${tipsSuffix}`
    : `Mined ${state.collected}/${count} ${blockName}${dropNote}. Have ${inventoryHave} ${dropItemName} in inventory.${sourceNote}${cancelNote}${tipsSuffix}`;

  return ok({
    data: {
      mined_count: state.collected,
      requested_count: count,
      attempted: state.attempted,
      causes: state.causes,
      ...state.regionSkips.dataFields(),
      partial_failure: partialFailure,
      started_inventory: startedInventory,
      ended_inventory: endedInventory,
      dropped_items_collected: pickedUp,
      dropped_item_positions: state.sweepResult?.pickedUpPositions || [],
      // Inventory-wide gain — catches blockName ≠ drop name (e.g. collect
      // grass_block drops dirt). Empty object only when nothing landed.
      inventory_gain: inventoryGains,
      total_inventory_gain: totalGain,
      // Surface the actual drop item name (iron_ore → raw_iron). Agents
      // check inventory[expected_drop_item] not inventory[block_name].
      expected_drop_item: dropItemName,
      drop_item_gained: inventoryHave,
      ...(resolvedFromSource ? { mined_source_block: resolvedFromSource } : {}),
      ...(state.wasCancelled ? { cancelled: true } : {}),
    },
    // Legacy field for goal engine + existing tests.
    result: msg,
    ...(tips.length ? { hints: tips } : {}),
  });
}

// ─ Orchestrator ────────────────────────────────────────────────────────

/**
 * Harvest loop, pickup pass, structured collect responses.
 *
 * @param {import('./index.js').CollectContext} cctx
 * @param {{
 *   found: import('vec3').Vec3[],
 *   acceptedTargetNames: Set<string>,
 *   resolvedFromSource: string | null,
 *   isTrunkHarvest: boolean,
 *   sorted: import('vec3').Vec3[],
 *   stripPlaneFloorY: number,
 *   stripSort: (list: any[]) => any[],
 *   isFlooded: (pos: import('vec3').Vec3) => boolean,
 * }} phaseInputs
 */
export async function executeCollectHarvest(cctx, phaseInputs) {
  const state = buildHarvestState(cctx, phaseInputs);
  const equipForDigCached = createEquipForDigCached(state);
  const refreshPool = createRefreshPool(state);

  await runHarvestLoop(state, equipForDigCached, refreshPool);

  // Pre-dig refusal short-circuits BEFORE the pickup pass: there are no
  // drops to collect, and we want the brain to act on the equip problem,
  // not the empty pickup.
  if (state.preDigRefusal) return buildToolInadequateEnvelope(state);

  await runPickupPass(state);
  const accounting = buildAccountingSnapshot(state);

  if (state.collected === 0) return buildFailureEnvelope(state);
  return buildSuccessEnvelope(state, accounting);
}
