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
 * F50.4 — raised by pathfindWithProgressWatchdog when the bot has stopped
 * making progress (moved <minDelta over a windowMs window) AFTER it has
 * begun moving. Distinct from OperationTimeoutError because it usually
 * means the route picked is bad (wall, edge, lip) rather than just slow.
 */
export class NoProgressError extends Error {
  constructor(opName, info) {
    super(`${opName} stalled — bot stopped moving for ${info?.no_progress_for_ms || '?'}ms`);
    this.code = 'NAV_NO_PROGRESS';
    this.opName = opName;
    this.info = info || {};
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


/**
 * F50.4 — Pathfind with both wallclock cap AND a no-progress watchdog.
 *
 * Why both:
 *   - Wallclock cap (raceWithTimeout) catches outright hangs.
 *   - Watchdog catches "bot is moving but not getting anywhere" — a tighter
 *     and more specific signal: 4 seconds with <0.3 blocks of motion after
 *     the bot has begun walking. mineflayer-pathfinder will sometimes keep
 *     a goal active while the bot is jammed against a 1-block lip or
 *     spinning in a corner; with parkour off the bot won't recover on its
 *     own. The watchdog returns NAV_NO_PROGRESS so the brain knows to
 *     escape / pick a different target rather than retry the same goto.
 *
 * Behavior:
 *   - Starts the pathfinder via `pathfinderGoto()` (caller-supplied — usually
 *     `() => bot.pathfinder.goto(goal)`).
 *   - Concurrently samples bot.entity.position every sampleMs (default 500).
 *   - Tracks the last position where the bot meaningfully moved.
 *   - Grace: the watchdog does not trip until the bot has moved at least
 *     `minTotalMovement` (0.6 blocks) from the start — protects against
 *     false-positives during the pathfinder's initial path-calculation
 *     phase when the bot stands still.
 *   - If `(now - lastMovedTime) > windowMs` AFTER initial motion, calls
 *     `onStall()` (typically `bot.pathfinder.setGoal(null)`) and rejects
 *     with NoProgressError.
 *   - Wallclock cap runs in parallel.
 *
 * @param {object} cfg
 * @param {object} cfg.bot           mineflayer bot
 * @param {() => Promise<any>} cfg.pathfinderGoto   starts the pathfind
 * @param {() => void} [cfg.onStall] called when watchdog trips
 * @param {string} cfg.opName        e.g. "goto", "goto_near", "move"
 * @param {number} cfg.capMs         outer wallclock cap
 * @param {number} [cfg.windowMs=4000]   stall window (no motion)
 * @param {number} [cfg.minDelta=0.3]    distance counted as "moved"
 * @param {number} [cfg.minTotalMovement=0.6]  initial-motion grace
 * @param {number} [cfg.sampleMs=500]    watchdog sample period
 */
export function pathfindWithProgressWatchdog(cfg) {
  const {
    bot, pathfinderGoto, onStall, opName, capMs,
    windowMs = 4000, minDelta = 0.3, minTotalMovement = 0.6, sampleMs = 500,
  } = cfg;
  const startPos = bot?.entity?.position
    ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }
    : null;
  let lastMovedPos = startPos ? { ...startPos } : null;
  let lastMovedTime = Date.now();
  let hasBegunMoving = false;
  let watchdogTimer = null;
  let capTimer = null;
  let settled = false;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      settled = true;
      if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
      if (capTimer) { clearTimeout(capTimer); capTimer = null; }
    };

    // Wallclock cap.
    capTimer = setTimeout(() => {
      if (settled) return;
      cleanup();
      try { if (onStall) onStall(); } catch { /* ignore */ }
      reject(new OperationTimeoutError(opName, capMs));
    }, capMs);

    // Progress watchdog.
    watchdogTimer = setInterval(() => {
      if (settled) return;
      const p = bot?.entity?.position;
      if (!p || !startPos || !lastMovedPos) return;
      const dxStart = p.x - startPos.x;
      const dyStart = p.y - startPos.y;
      const dzStart = p.z - startPos.z;
      const distFromStart = Math.sqrt(dxStart * dxStart + dyStart * dyStart + dzStart * dzStart);
      if (!hasBegunMoving && distFromStart >= minTotalMovement) {
        hasBegunMoving = true;
      }
      // Progress is HORIZONTAL distance only. The manager-level stuck
      // wiggle (manager.js sync watchdog) issues 250ms jumps; a jump arc
      // peaks at ~1.25m of pure-Y motion, which under a 3D metric reset
      // this 4s stall window every activation — NoProgressError was
      // suppressed and wedged actions ran to their wallclock cap (then
      // the CLI's 25s HTTP timeout, exit 124). Net |dy| ≥ 1.5 still
      // counts as progress so ladder climbs and falls don't false-trip
      // (a jump returns to its origin Y; sustained climb/descent doesn't).
      const dxLast = p.x - lastMovedPos.x;
      const dzLast = p.z - lastMovedPos.z;
      const horizFromLast = Math.hypot(dxLast, dzLast);
      const vertFromLast = Math.abs(p.y - lastMovedPos.y);
      if (horizFromLast >= minDelta || vertFromLast >= 1.5) {
        lastMovedPos = { x: p.x, y: p.y, z: p.z };
        lastMovedTime = Date.now();
        return;
      }
      if (!hasBegunMoving) return;
      const stalledForMs = Date.now() - lastMovedTime;
      if (stalledForMs >= windowMs) {
        cleanup();
        try { if (onStall) onStall(); } catch { /* ignore */ }
        reject(new NoProgressError(opName, {
          no_progress_for_ms: stalledForMs,
          start_position: startPos,
          stalled_position: { x: p.x, y: p.y, z: p.z },
          window_ms: windowMs,
          min_delta: minDelta,
        }));
      }
    }, sampleMs);

    // Run the pathfinder.
    Promise.resolve()
      .then(() => pathfinderGoto())
      .then((value) => {
        if (settled) return;
        cleanup();
        resolve(value);
      })
      .catch((err) => {
        if (settled) return;
        cleanup();
        reject(err);
      });
  });
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
//
// Round-A expedition: the 5s goto cap was killing legitimate
// long-distance bg_goto. At 4.3 blocks/s walking speed, a 1km leg
// takes ~232s — capping it at 5s meant every long bg_goto returned
// OPERATION_TIMEOUT after ~20 blocks of progress, forcing the brain
// into tiny iterative legs (~9 blocks/min effective rate). The
// pathfindWithProgressWatchdog already catches real hangs at 4s of
// no-motion, so the outer wallclock cap is redundant for stall
// detection — it only needed to be a defense-in-depth backstop.
// goto bumped from 5000 → 300000 (5 min) to permit ~1.3km legs;
// move from 12000 → 30000 to permit longer door-chained legs. The
// 4s progress watchdog (windowMs in pathfindWithProgressWatchdog,
// _helpers.js:166) remains the primary stall signal.
// level / clear_strip / place_fill: server-side caps set BELOW the CLI's
// 120s LONG_ACTION deadline so the partial-completion envelope (counters,
// remaining, next_unfilled) reaches the agent instead of a blind client
// abort. Handlers check the deadline between work units and stop digging/
// placing — the bot does not keep working past the returned envelope.
export const ACTION_CAPS_MS = Object.freeze({
  place: 8000,
  goto: 300000,
  goto_near: 15000,
  go_mark: 15000,
  move: 30000,
  collect: 40000,
  dig: 10000,
  craft: 30000,
  reach: 8000,
  level: 100000,
  clear_strip: 100000,
  place_fill: 100000,
});


/**
 * F55.3 — uniform reach precheck for coord-targeting actions
 * (chest_search, take/deposit/withdraw, interact, inspect, etc.).
 *
 * If the bot is already within `range` of (x,y,z), returns ok immediately.
 * Otherwise runs `bot.pathfinder.goto(GoalNear(x,y,z,range))` under a
 * wallclock cap (default 8s). On any failure (timeout, no-path) returns
 * the same structured OUT_OF_RANGE error so callers can pass it through.
 *
 * @param {object} deps  { bot, goals } — pass the action's bot + goals refs.
 * @param {{x:number,y:number,z:number}} target
 * @param {object} [opts]
 * @param {number} [opts.range=4.5]  reach radius
 * @param {number} [opts.capMs=8000]
 * @param {object} [opts.observed]   extra observed_state fields to merge
 * @returns {Promise<{ok:true, distance:number} | {ok:false, error:object}>}
 */
export async function ensureWithinReach({ bot, goals }, target, opts = {}) {
  const { range = 4.5, capMs = ACTION_CAPS_MS.reach, observed = {} } = opts;
  const tx = Math.floor(Number(target.x));
  const ty = Math.floor(Number(target.y));
  const tz = Math.floor(Number(target.z));
  const dx = bot.entity.position.x - (tx + 0.5);
  const dy = bot.entity.position.y - (ty + 0.5);
  const dz = bot.entity.position.z - (tz + 0.5);
  const realDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (realDist <= range) {
    return { ok: true, distance: Math.round(realDist * 10) / 10 };
  }
  try {
    await raceWithTimeout(
      bot.pathfinder.goto(new goals.GoalNear(tx, ty, tz, Math.max(2, Math.floor(range)))),
      capMs,
      'reach',
    );
  } catch (err) {
    try { bot.pathfinder.setGoal(null); } catch { /* ignore */ }
    const finalDx = bot.entity.position.x - (tx + 0.5);
    const finalDy = bot.entity.position.y - (ty + 0.5);
    const finalDz = bot.entity.position.z - (tz + 0.5);
    const finalDist = Math.sqrt(finalDx * finalDx + finalDy * finalDy + finalDz * finalDz);
    const timedOut = err instanceof OperationTimeoutError || err.code === 'OPERATION_TIMEOUT';
    return {
      ok: false,
      error: {
        code: 'OUT_OF_RANGE',
        message: timedOut
          ? `Pathfind to ${tx},${ty},${tz} hit ${capMs}ms cap before reaching range ${range}. Current distance: ${Math.round(finalDist * 10) / 10}.`
          : `Couldn't approach ${tx},${ty},${tz}: ${err?.message || err}. Distance: ${Math.round(finalDist * 10) / 10}, needed ≤${range}.`,
        observed_state: {
          target: { x: tx, y: ty, z: tz },
          range,
          distance_before: Math.round(realDist * 10) / 10,
          distance_after: Math.round(finalDist * 10) / 10,
          bot_position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
          timed_out: timedOut,
          ...observed,
        },
        next_action_hint: `mc goto_near ${tx} ${ty} ${tz} range=${Math.max(2, Math.floor(range))}`,
        retry_safe: false,
      },
    };
  }
  // Post-pathfind distance check — pathfinder occasionally returns ok
  // but lands the bot just outside reach (G21 v2 finding).
  const postDx = bot.entity.position.x - (tx + 0.5);
  const postDy = bot.entity.position.y - (ty + 0.5);
  const postDz = bot.entity.position.z - (tz + 0.5);
  const postDist = Math.sqrt(postDx * postDx + postDy * postDy + postDz * postDz);
  if (postDist > range + 0.5) {
    return {
      ok: false,
      error: {
        code: 'OUT_OF_RANGE',
        message: `Pathfind finished but bot landed ${Math.round(postDist * 10) / 10} from target — outside reach (${range}).`,
        observed_state: {
          target: { x: tx, y: ty, z: tz },
          range,
          distance_after: Math.round(postDist * 10) / 10,
          bot_position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
          ...observed,
        },
        next_action_hint: `mc move ${tx} ${ty} ${tz}`,
        retry_safe: false,
      },
    };
  }
  return { ok: true, distance: Math.round(postDist * 10) / 10 };
}

/**
 * Pathfind to GoalNear under progress watchdog + wallclock cap.
 * Shared action helpers also include `_block-sets`, `_directions`, `_los`, `_args` (see docs/reference/bot/handlers-directory.md).
 */
export async function pathfindGotoNear(bot, goals, x, y, z, range, {
  opName = 'goto',
  capMs = ACTION_CAPS_MS.reach,
} = {}) {
  await pathfindWithProgressWatchdog({
    bot,
    opName,
    capMs,
    pathfinderGoto: () => bot.pathfinder.goto(new goals.GoalNear(x, y, z, range)),
    onStall: () => {
      try { bot.pathfinder.setGoal(null); } catch { /* ignore */ }
    },
  });
}

/**
 * Single pathfinder goal under a hard wall-clock cap (no progress watchdog).
 * Used by mc escape sidesteps / step-up attempts (~1–1.5s). Always clears the
 * goal afterward so the next attempt or control-state burst starts clean.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {() => Promise<unknown>} pathfinderGoto
 * @param {number} capMs
 * @param {string} [opName]
 */
export async function pathfindGoalCapped(bot, pathfinderGoto, capMs, opName = 'pathfind_capped') {
  try {
    await raceWithTimeout(pathfinderGoto(), capMs, opName);
  } catch {
    // timeout or pathfinder error — escape callers inspect standing state next
  } finally {
    try { bot.pathfinder.setGoal(null); } catch { /* ignore */ }
  }
}
