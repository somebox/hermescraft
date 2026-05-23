import { OperationTimeoutError, raceWithTimeout } from '../_helpers.js';

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
export async function gotoWithTimeout(b, goal, timeoutMs) {
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
