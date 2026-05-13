/**
 * Shared helpers for action handlers.
 *
 * The big one is `raceWithTimeout` — every long-running action (place, goto,
 * collect, dig, craft) needs an absolute wallclock cap. Before F45 each
 * action managed its own timeout inline; some had no cap at all and would
 * hang for 5-25s inside the pathfinder. Centralising the race + a
 * structured `OPERATION_TIMEOUT` error gives the brain a predictable
 * fail-and-recover loop instead of a stale-state grind.
 */


/** Marker error class so callers can distinguish timeout from inner errors. */
export class OperationTimeoutError extends Error {
  constructor(opName, capMs) {
    super(`${opName} exceeded ${capMs}ms wallclock cap`);
    this.code = 'OPERATION_TIMEOUT';
    this.opName = opName;
    this.capMs = capMs;
  }
}


/**
 * Race a promise against a wallclock timeout. Resolves with the promise's
 * value if it wins; throws `OperationTimeoutError` if the timer wins.
 *
 * Note: this does NOT cancel the underlying work (pathfinder.goto etc.
 * will keep running). Callers should explicitly cancel via
 * `bot.pathfinder.setGoal(null)` / `bot.stopDigging()` after a timeout.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} capMs
 * @param {string} opName  short opname used in error messages, e.g. "goto"
 * @returns {Promise<T>}
 */
export function raceWithTimeout(promise, capMs, opName) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new OperationTimeoutError(opName, capMs)),
      capMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}


/**
 * Build a uniform OPERATION_TIMEOUT action-result error. Pair with the
 * phase-2 action contract: returns `{ok:false, error:{code, message,
 * observed_state, retry_safe}}`.
 *
 * @param {string} opName
 * @param {number} capMs
 * @param {object} [observedState]   merged into error.observed_state
 * @param {string} [hint]            optional cancel/retry hint for the brain
 */
export function timeoutError(opName, capMs, observedState = {}, hint = '') {
  const base = `${opName} exceeded ${capMs}ms wallclock cap — operation was canceled.`;
  const message = hint ? `${base} ${hint}` : base;
  return {
    ok: false,
    error: {
      code: 'OPERATION_TIMEOUT',
      message,
      observed_state: { op: opName, cap_ms: capMs, ...observedState },
      retry_safe: true,
    },
  };
}


/**
 * Convenience: run `promise` with a `capMs` wallclock cap. If the cap fires,
 * runs `onTimeout()` (typically a cleanup like `setGoal(null)`) and returns
 * the OPERATION_TIMEOUT action-result. If the inner promise rejects with
 * any OTHER error, re-throws so the caller's existing catch handles it.
 *
 * @template T
 * @param {object} cfg
 * @param {Promise<T>} cfg.promise
 * @param {number} cfg.capMs
 * @param {string} cfg.opName
 * @param {() => void|Promise<void>} [cfg.onTimeout]   cleanup hook
 * @param {() => object} [cfg.observedState]            evaluated lazily on timeout
 * @param {string} [cfg.hint]
 * @returns {Promise<T | {ok:false, error:object}>}
 */
export async function withWallclockCap({
  promise, capMs, opName, onTimeout, observedState, hint,
}) {
  try {
    return await raceWithTimeout(promise, capMs, opName);
  } catch (err) {
    if (err instanceof OperationTimeoutError || err.code === 'OPERATION_TIMEOUT') {
      if (onTimeout) {
        try { await onTimeout(); } catch { /* swallow cleanup errors */ }
      }
      const obs = (typeof observedState === 'function') ? observedState() : (observedState || {});
      return timeoutError(opName, capMs, obs, hint);
    }
    throw err;
  }
}


/** Default wallclock caps for the long-running actions. Sized from the
 *  G21 v1 data where: place legitimate <5s, goto legitimate <12s, collect
 *  legitimate <15s for small batches, craft (with pathfind-to-table) <25s.
 *
 *  collect=40000 is generous on purpose: a single `mc collect cobblestone 18`
 *  legitimately walks to 18 blocks (test-mine-collect-grid scenario C took
 *  ~25s for a 3x3x2 grid). The cap is defense-in-depth against a runaway
 *  pathfinder, NOT a hard limit on legitimate batches — the action's
 *  internal `gotoWithTimeout` already caps each pathfind at 6-10s, so
 *  the outer cap only fires if every batch element legitimately exhausted
 *  its inner budget AND the bot still has more to do. */
// F50.3: pathfinder caps tightened. Empirically (G21 v2 logs), a real
// goto/goto_near either succeeds in <2s or hangs to the cap due to
// mineflayer-pathfinder issue #273 (partial-path stuck). Lower caps
// catch those hangs ~3× sooner. `go_mark` stays at 15s because it
// allows long-haul travel by design.
export const ACTION_CAPS_MS = Object.freeze({
  place: 8000,
  goto: 5000,
  goto_near: 8000,
  go_mark: 15000,
  move: 12000,
  collect: 40000,
  dig: 10000,
  craft: 30000,
});
