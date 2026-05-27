import { ok } from '../../shared/action-contract.js';
import { executePickupSweep } from './pickup-sweep.js';

export function createPickupHandler(deps) {
  const { ensureBot, goals, sleep } = deps;

  return async function pickup() {
    const b = ensureBot();
    const invBefore = b.inventory.items().reduce((s, i) => s + i.count, 0);

    const { skippedUnreachable } = await executePickupSweep(b, goals, sleep, {
      scanRange: 16,
      overallBudgetMs: 18000,
      dropsPerPass: 8,
      postSweepSleepMs: 400,
      postDropSleepMs: 250,
    });

    const invAfter = b.inventory.items().reduce((s, i) => s + i.count, 0);
    const gained = invAfter - invBefore;
    const note = skippedUnreachable > 0 ? ` (${skippedUnreachable} unreachable, skipped)` : '';
    return ok({ result: gained > 0 ? `Picked up ${gained} items${note}.` : `No items picked up${note}.` });
  };
}
