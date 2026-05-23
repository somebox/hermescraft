/**
 * Diagnostics helpers — `buildActionStats` and `classifyIdleReason`.
 *
 * Extracted from `lib/server/http-app.js` (Phase 6 of docs/archive/refactor-plan-2026.md)
 * so the runtime layer can read these stats without importing up into the
 * HTTP layer (fixes the prior P8 violation in `lib/runtime/observation.js`).
 *
 * These are pure functions over the sliced state object — they read state
 * and return data; they do not mutate or perform IO.
 */

/**
 * Build a 5-minute rolling-window action stats object from
 * `ctx.tasks.actionCounters`. Returns a stable shape even when the window
 * is empty so callers don't need null-guards.
 *
 * @param {{ tasks: { actionCounters: { window_ms: number, events: Array<{ts:number, action:string, status:string, error?:string|null}> } } }} ctx
 */
export function buildActionStats(ctx) {
  const now = Date.now();
  const c = ctx.tasks.actionCounters;
  const cutoff = now - c.window_ms;
  const evts = c.events.filter((e) => e.ts >= cutoff);
  if (!evts.length) {
    return {
      total: 0,
      done: 0,
      failed: 0,
      error_rate_pct: 0,
      actions_per_min: 0,
      top_errors: [],
      window_sec: Math.round(c.window_ms / 1000),
    };
  }
  const done = evts.filter((e) => e.status === 'done').length;
  const failed = evts.length - done;
  const spanMin = Math.max(
    0.05,
    (evts[evts.length - 1].ts - evts[0].ts) / 60000 || c.window_ms / 60000,
  );
  const errMap = {};
  evts
    .filter((e) => e.status !== 'done' && e.error)
    .forEach((e) => {
      const key = `${e.action}: ${(e.error || '').slice(0, 80)}`;
      errMap[key] = (errMap[key] || 0) + 1;
    });
  const topErrors = Object.entries(errMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([msg, n]) => ({ msg, n }));
  return {
    total: evts.length,
    done,
    failed,
    error_rate_pct: Math.round((failed / evts.length) * 1000) / 10,
    actions_per_min: Math.round((evts.length / spanMin) * 100) / 100,
    done_per_min: Math.round((done / spanMin) * 100) / 100,
    top_errors: topErrors,
    window_sec: Math.round(c.window_ms / 1000),
  };
}

/**
 * Classify why the bot is idle right now. Used by /observe and the
 * dashboard to give the agent (and the human watcher) a one-word reason
 * instead of a vague "nothing happening".
 *
 * Possible reasons:
 *   - 'disconnected'      bot not connected or not ready
 *   - 'task_running'      a bg task is in flight
 *   - 'task_stuck'        bg task watchdog tripped
 *   - 'error_loop'        same action errored 3× consecutively
 *   - 'recent_error'      last API error <30s ago
 *   - 'awaiting_agent'    everything's fine; bot is waiting for instructions
 *
 * @param {{ world: { bot:any, botReady:boolean }, tasks: { currentTask:any, actionHistory:any[], lastApiError:any } }} ctx
 */
export function classifyIdleReason(ctx) {
  if (!ctx.world.bot || !ctx.world.botReady) return 'disconnected';
  if (ctx.tasks.currentTask?.status === 'running') return 'task_running';
  if (ctx.tasks.currentTask?.status === 'stuck') return 'task_stuck';
  const recent3 = ctx.tasks.actionHistory.slice(-3);
  if (
    recent3.length === 3 &&
    recent3.every((e) => e.status !== 'done' && e.action === recent3[0].action)
  ) {
    return 'error_loop';
  }
  if (ctx.tasks.lastApiError && Date.now() - ctx.tasks.lastApiError.ts < 30000) {
    return 'recent_error';
  }
  return 'awaiting_agent';
}
