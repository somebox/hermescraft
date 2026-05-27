// Shared pickup-sweep loop used by `mc pickup` and the post-harvest pickup
// pass inside `mc collect`. Both used to inline the same 3-pass centroid
// sweep + per-drop fallback; they drifted on every tuning knob (scan range,
// budget, drops-per-pass, sleeps). Single implementation here, options
// object captures the per-call differences.
import { gotoWithTimeout } from './goto-with-timeout.js';
import { OperationTimeoutError } from '../_helpers.js';

const DEFAULTS = {
  scanRange: 16,           // entity distance cap when collecting drop candidates
  overallBudgetMs: 12000,  // wall-clock cap for the whole sweep
  attempts: 3,             // outer-loop iterations
  dropsPerPass: 8,         // max per-drop pathfinds per attempt
  magnetRange: 1.5,        // Minecraft's auto-pickup radius — also the goto range
  sweepTimeoutMs: 3500,    // per-attempt centroid-sweep timeout
  perItemTimeoutMs: 1500,  // per-drop pathfind timeout
  postSweepSleepMs: 400,   // settle time after the centroid sweep
  postDropSleepMs: 250,    // settle time after each per-drop pickup
  initialSleepMs: 0,       // wait before the first attempt (lets drops spawn)
  recordPositions: false,  // when true, returns rounded {x,y,z} per pickup
};

const isItemEntity = (e) => e.name === 'item' || e.displayName === 'Item';

/**
 * Run the pickup sweep against the bot. Stalls (no inventory progress
 * between attempts) end the loop early. The stallCheck callback returns
 * a numeric inventory count for the relevant item(s); the default uses
 * the total inventory count so any pickup counts as progress.
 *
 * Returns { pickedUpPositions, unreachableDropIds, skippedUnreachable,
 * attemptsCompleted }.
 *
 * @param {import('mineflayer').Bot} b
 * @param {object} goals  mineflayer-pathfinder goals namespace
 * @param {(ms:number)=>Promise<void>} sleep
 * @param {object} [opts]
 * @param {() => number} [opts.stallCheck]  per-attempt inventory probe
 */
export async function executePickupSweep(b, goals, sleep, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const stallCheck = cfg.stallCheck
    || (() => b.inventory.items().reduce((s, i) => s + i.count, 0));

  /** @type {Set<number>} */
  const unreachableDropIds = new Set();
  /** @type {{x:number,y:number,z:number}[]} */
  const pickedUpPositions = [];
  let skippedUnreachable = 0;
  let attemptsCompleted = 0;

  if (cfg.initialSleepMs > 0) await sleep(cfg.initialSleepMs);

  const start = Date.now();
  let prevInv = stallCheck();

  for (let attempt = 0; attempt < cfg.attempts; attempt++) {
    if (Date.now() - start > cfg.overallBudgetMs) break;
    const here = b.entity.position;
    const drops = Object.values(b.entities)
      .filter((e) => isItemEntity(e)
        && !unreachableDropIds.has(e.id)
        && e.position.distanceTo(here) < cfg.scanRange)
      .sort((a, c) => a.position.distanceTo(here) - c.position.distanceTo(here));

    if (drops.length === 0) break;

    // Centroid sweep — pathfind through the middle of the cluster with a
    // wide GoalNear so the auto-magnet (1.5 block radius) hoovers up
    // anything the route passes within range.
    if (drops.length >= 2) {
      let cx = 0, cy = 0, cz = 0;
      for (const d of drops) { cx += d.position.x; cy += d.position.y; cz += d.position.z; }
      cx /= drops.length; cy /= drops.length; cz /= drops.length;
      try {
        await gotoWithTimeout(
          b,
          new goals.GoalNear(cx, cy, cz, Math.max(2, cfg.magnetRange)),
          cfg.sweepTimeoutMs,
        );
        await sleep(cfg.postSweepSleepMs);
      } catch { /* sweep failed — fall through to per-drop */ }
    }

    // Per-drop pickup for whatever the sweep missed. Snap to magnet radius
    // so pathfinder isn't asked to stand exactly on the drop cell.
    const remaining = drops.filter((d) => d.isValid);
    for (const drop of remaining.slice(0, cfg.dropsPerPass)) {
      if (Date.now() - start > cfg.overallBudgetMs) break;
      if (!drop.isValid) continue;
      try {
        const dropPos = drop.position.clone();
        await gotoWithTimeout(
          b,
          new goals.GoalNear(dropPos.x, dropPos.y, dropPos.z, cfg.magnetRange),
          cfg.perItemTimeoutMs,
        );
        await sleep(cfg.postDropSleepMs);
        if (cfg.recordPositions) {
          pickedUpPositions.push({
            x: Math.round(dropPos.x * 10) / 10,
            y: Math.round(dropPos.y * 10) / 10,
            z: Math.round(dropPos.z * 10) / 10,
          });
        }
      } catch (err) {
        unreachableDropIds.add(drop.id);
        // gotoWithTimeout throws OperationTimeoutError (code='OPERATION_TIMEOUT')
        // on timeout; its message is the human-readable "goto exceeded Nms
        // wallclock cap" string, NOT the code, so a previous message-equals
        // check here was dead code.
        if (err instanceof OperationTimeoutError || err?.code === 'OPERATION_TIMEOUT') {
          skippedUnreachable++;
        }
      }
    }

    attemptsCompleted++;
    const nowInv = stallCheck();
    if (nowInv === prevInv) break;
    prevInv = nowInv;
  }

  return { pickedUpPositions, unreachableDropIds, skippedUnreachable, attemptsCompleted };
}
