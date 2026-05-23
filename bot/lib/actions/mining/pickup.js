// @size-exempt: pickup oversized; inherited from legacy mining.js
import { gotoWithTimeout } from './goto-with-timeout.js';
import { ok } from '../../shared/action-contract.js';

export function createPickupHandler(deps) {
  const { ensureBot, goals, sleep } = deps;

  return async function pickup() {
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
        return ok({ result: gained > 0 ? `Picked up ${gained} items${note}.` : `No items picked up${note}.` });
  };
}
