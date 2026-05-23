import { equipForDig } from '../../../runtime/dig-tools.js';

import { gotoWithTimeout } from '../goto-with-timeout.js';

// @size-exempt: collect execute loop oversized; inherited from legacy mining.js

/** Harvest loop, pickup pass, structured collect responses. */
export async function executeCollectHarvest({
  b,
  ctx,
  goals,
  sleep,
  log,
  blockName,
  count,
  batchSize,
  found,
  acceptedTargetNames,
  resolvedFromSource,
  isTrunkHarvest,
  sorted,
  stripPlaneFloorY,
  stripSort,
  isFlooded,
  inventoryAt,
  startedInventory,
  startedBlockCount,
  canSeeMinableFace,
}) {
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

// Task #33 — derive the expected drop item name for this block, so
// the success message can report the ACTUAL inventory item the
// agent got (e.g. iron_ore mined with iron_pickaxe drops raw_iron,
// not iron_ore). Without this, `mc collect iron_ore 4` reports
// "Have 0 iron_ore in inventory" even when 4 raw_iron landed —
// the agent reads that as a failure and re-tries.
//
// mcData.blocksByName[blockName].drops is the canonical source.
// First drop entry wins (most blocks have one canonical drop).
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
const dropNote = dropItemName !== blockName
  ? ` (drops as ${dropItemName})`
  : '';
const inventoryHave = Math.max(0, droppedItemDelta);

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

  // T3 reposition hint: when `behind_wall` dominates the failure
  // distribution, the bot can probably see SOMETHING but not the
  // face it needs — another block (typically a sibling trunk in a
  // dense forest) sits between the bot and the candidate's bot-
  // facing face. Suggest moving to a different cardinal of the
  // first candidate, then re-calling collect.
  //
  // Round-2/3 in-game QA: Steve called `mc collect oak_log` from
  // 1.5m off a trunk and got `behind_wall (4/4)` every time because
  // the candidates' faces were occluded by neighbouring logs. The
  // error gave him nothing to act on and he walked off in the
  // wrong direction asking re44 for help. With this hint he gets
  // a concrete cell to walk to before the retry.
  let nextActionHint = null;
  let firstCandidate = null;
  const topCause = Object.entries(causes).sort((a, c) => c[1] - a[1])[0]?.[0];
  if (topCause === 'behind_wall' && found.length > 0 && b?.entity?.position) {
    const cand = found[0];
    firstCandidate = { x: cand.x, y: cand.y, z: cand.z };
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
    nextActionHint =
      `Another block is blocking the line-of-sight to ${cand.x},${cand.y},${cand.z}. ` +
      `mc move to a different cardinal then re-call mc collect. Suggested cells: ` +
      cardinals.map((c) => `${c.name} (${c.cell.x},${c.cell.y},${c.cell.z})`).join(', ') + '.';
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
        ...(firstCandidate ? { first_candidate: firstCandidate } : {}),
      },
      retry_safe: code !== 'ALL_PATHFIND_FAILED', // pathfinding rarely improves on retry without the bot moving
      ...(nextActionHint ? { next_action_hint: nextActionHint } : {}),
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
  ? `Mined ${collected} ${blockName}${dropNote} (${remaining} more needed). Have ${inventoryHave} ${dropItemName} in inventory.${sourceNote}${cancelNote}${tipsSuffix}`
  : `Mined ${collected}/${count} ${blockName}${dropNote}. Have ${inventoryHave} ${dropItemName} in inventory.${sourceNote}${cancelNote}${tipsSuffix}`;

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
    // Task #33: surface the actual drop item name. iron_ore → raw_iron,
    // coal_ore → coal, etc. Agents can check inventory[expected_drop_item]
    // not inventory[block_name] to verify the loot.
    expected_drop_item: dropItemName,
    drop_item_gained: inventoryHave,
    ...(resolvedFromSource ? { mined_source_block: resolvedFromSource } : {}),
    ...(wasCancelled ? { cancelled: true } : {}),
  },
  // Legacy fields for goal engine + existing tests.
  result: msg,
  ...(tips.length ? { hints: tips } : {}),
};
}
