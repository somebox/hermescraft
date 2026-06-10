/**
 * `dispatchAction` — single entry point used by both `POST /action/<name>`
 * (sync) and `POST /task/<name>` (async background) in `http-app.js`. Before
 * this consolidation the two paths had divergent copies of the start/done/
 * error wrapping; the Phase 7 cleanup unifies them.
 *
 * dispatchAction(services, actionName, body, { mode, ...deps })
 *   → { ok: true, status: 200, response, meta } |
 *     { ok: false, status: number, error: string }
 *
 * `mode === 'sync'` runs the action to completion, applies the full pre/post
 * middleware pipeline, returns the result for the HTTP response.
 *
 * `mode === 'task'` kicks the action off in the background and returns
 * `{ task_id, status: 'started' }` immediately. Pre-middleware is skipped
 * (preserving pre-Phase-7 behaviour where /task didn't fire the F51.2/F53.2
 * guards). Lifecycle bookkeeping (`currentTask`, history records) runs in
 * the background `.then`/`.catch` handlers.
 *
 * `body.reason` is captured into the actionHistory entry for traceability,
 * regardless of mode.
 */

import { validate } from '../../shared/action-contract.js';
import { validateBlockRef } from '../../shared/typed-nouns.js';
import { logNavEvent } from '../../runtime/metrics.js';
import { syncPreMiddleware, syncPostMiddleware } from './pipeline.js';

/** Extract a short (≤80 char) one-liner from an action result for the dashboard. */
function actionSummary(result) {
  if (!result) return '';
  const raw = typeof result === 'string' ? result : result.result || result.message || '';
  if (!raw) return '';
  const first = String(raw).split(/[.\n]/, 1)[0].trim();
  return first.length > 80 ? first.slice(0, 77) + '…' : first;
}

/** Append an entry to `ctx.tasks.actionHistory`. Trims to MAX_ACTION_HISTORY. */
export function pushAction(ctx, action, status, startedAt, result, error, reason) {
  /** @type {Record<string, any>} */
  const entry = {
    action,
    status,
    started_at: startedAt,
    finished_at: Date.now(),
    detail: status === 'done' ? actionSummary(result) : (error || '').slice(0, 80),
  };
  if (reason) entry.reason = reason;
  ctx.tasks.actionHistory.push(entry);
  if (ctx.tasks.actionHistory.length > ctx.tasks.MAX_ACTION_HISTORY) ctx.tasks.actionHistory.shift();
}

/** Append a rolling counter event for buildActionStats(). */
export function recordActionOutcome(ctx, action, status, errorMsg) {
  const now = Date.now();
  const c = ctx.tasks.actionCounters;
  if (!c) return;
  c.events.push({ ts: now, action, status, error: errorMsg || null });
  const cutoff = now - c.window_ms;
  while (c.events.length > 0 && c.events[0].ts < cutoff) c.events.shift();
  if (c.events.length > 600) c.events.splice(0, c.events.length - 600);
}

const TASK_SEG_SKIP = new Set(['start', 'cancel', 'pause', 'resume', 'checkpoint-respond', 'history']);

/** Record last failure for dashboard /observe (server-side; Hermes agents
 *  rarely persist this themselves). */
export function recordLastApiError(ctx, reqMethod, pathname, err, actionHint) {
  const msg = (err && err.message) || String(err || 'error');
  const am = pathname.match(/^\/action\/(\w+)$/);
  const tm = pathname.match(/^\/task\/(\w+)$/);
  let action = actionHint || null;
  if (!action && am) action = am[1];
  if (!action && tm && !TASK_SEG_SKIP.has(tm[1])) action = tm[1];
  ctx.tasks.lastApiError = {
    ts: Date.now(),
    method: reqMethod,
    path: pathname,
    action,
    message: msg.slice(0, 2000),
  };
}

function runDevValidator(actionName, result) {
  if (process.env.HERMES_VALIDATE !== '1') return;
  const v = validate(result);
  if (!v.valid) {
    // eslint-disable-next-line no-console
    console.warn(`[HERMES_VALIDATE] ${actionName} returned non-conformant: ${v.issues.join('; ')}`);
  }
  runTypedNounValidator(actionName, result);
}

const TYPED_NOUN_VALIDATE_ACTIONS = new Set(['find_blocks', 'inspect']);

function runTypedNounValidator(actionName, result) {
  if (!TYPED_NOUN_VALIDATE_ACTIONS.has(actionName)) return;
  if (!result || result.ok === false) return;
  if (actionName === 'inspect') {
    const ref = result.data?.block_ref;
    const v = validateBlockRef(ref);
    if (!v.valid) {
      // eslint-disable-next-line no-console
      console.warn(`[HERMES_VALIDATE] ${actionName} block_ref: ${v.issues.join('; ')}`);
    }
    return;
  }
  if (actionName === 'find_blocks') {
    const locs = result.locations;
    if (!Array.isArray(locs)) return;
    for (let i = 0; i < locs.length; i++) {
      const v = validateBlockRef(locs[i]?.block_ref);
      if (!v.valid) {
        // eslint-disable-next-line no-console
        console.warn(`[HERMES_VALIDATE] ${actionName} locations[${i}].block_ref: ${v.issues.join('; ')}`);
      }
    }
  }
}

/** Sync POST chokepoint — JSONL nav telemetry (async bg_* omitted v1). */
function emitSyncNavTelemetry(services, actionName, result) {
  const ctx = services.state;
  const profile = String(services.config?.mc?.username || 'unknown').toLowerCase();
  const pc = ctx.runtime?.playbook_context;
  const tc = ctx.runtime?.taskContext;
  const softFailure = result && typeof result === 'object' && result.ok === false;
  logNavEvent({
    profile,
    actionName,
    ok: !softFailure,
    ...(softFailure && result.error?.code ? { error_code: String(result.error.code) } : {}),
    ...(pc?.playbook_id ? { playbook_id: pc.playbook_id } : {}),
    ...(pc?.phase ? { phase: pc.phase } : {}),
    ...(pc?.sub_playbook_id ? { sub_playbook_id: pc.sub_playbook_id } : {}),
    ...(pc?.sub_phase ? { sub_phase: pc.sub_phase } : {}),
    ...(pc?.card_id || tc?.card_id ? { card_id: pc?.card_id || tc?.card_id } : {}),
  });
}

/**
 * GET read-path telemetry during playbook/card work only (keeps JSONL volume down
 * on idle polling). Same v1 row shape as sync POST chokepoint.
 */
export function logReadNavTelemetry(services, actionName) {
  const ctx = services.state;
  const onPlaybookCard =
    ctx.runtime?.playbook_context?.playbook_id || ctx.runtime?.taskContext?.card_id;
  if (!onPlaybookCard) return;
  emitSyncNavTelemetry(services, actionName, { ok: true });
}

/**
 * @param {Record<string, any>} services  services container (has .state, .ensureBot, .utils, …)
 * @param {string} actionName
 * @param {Record<string, any>} body
 * @param {{
 *   mode: 'sync' | 'task',
 *   actionRegistry: { has: (n:string) => boolean, get: (n:string) => Function, names: () => string[] },
 *   briefState: () => any,
 *   createTaskRecord: Function,
 *   pushTaskHistoryRecord: (task: any, status: string) => void,
 * }} opts
 */
export async function dispatchAction(services, actionName, body, opts) {
  const { mode, actionRegistry, briefState, createTaskRecord, pushTaskHistoryRecord } = opts;
  const { state: ctx, ensureBot } = services;

  // Unknown-action check is identical in both modes.
  const actionFn = actionRegistry.get(actionName);
  if (typeof actionFn !== 'function') {
    const available = actionRegistry.names().join(', ');
    return {
      ok: false,
      status: 400,
      error: `Unknown action "${actionName}". Available: ${available}`,
    };
  }

  if (mode === 'task') {
    // Conflict: an existing bg task is still running.
    if (ctx.tasks.currentTask && ctx.tasks.currentTask.status === 'running') {
      const elapsedS = Math.round((Date.now() - ctx.tasks.currentTask.started) / 1000);
      return {
        ok: false,
        status: 409,
        error: `Task "${ctx.tasks.currentTask.action}" is already running (${elapsedS}s). POST /task/cancel first.`,
      };
    }

    // Strip control-plane fields from the body when caller routed via
    // explicit /task/start (signaled by body.action being present).
    const taskBody = body && typeof body.params === 'object' && body.params != null
      ? { ...body.params }
      : { ...body };
    delete taskBody.action;
    delete taskBody.lease_seconds;
    delete taskBody.goal_id;
    delete taskBody.parent_goal_id;
    delete taskBody.contributes_to;

    const startedAt = Date.now();
    const taskId = `${actionName}_${startedAt}`;
    const leaseSec = body.lease_seconds != null ? parseFloat(body.lease_seconds) : null;
    ctx.tasks.currentTask = createTaskRecord({
      id: taskId,
      action: actionName,
      lease_seconds: leaseSec && leaseSec > 0 ? leaseSec : null,
      parent_goal_id: body.goal_id || body.parent_goal_id || null,
      contributes_to: body.contributes_to || null,
    });
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 120) : null;

    const actionPromise = actionFn(taskBody);
    actionPromise
      .then((result) => {
        if (ctx.tasks.currentTask && ctx.tasks.currentTask.id === taskId && ctx.tasks.currentTask.status === 'running') {
          ctx.tasks.currentTask.status = 'done';
          ctx.tasks.currentTask.result = result;
          pushTaskHistoryRecord(ctx.tasks.currentTask, 'done');
        }
        pushAction(ctx, actionName, 'done', startedAt, result, null, reason);
        recordActionOutcome(ctx, actionName, 'done');
        runDevValidator(actionName, result);
      })
      .catch((err) => {
        recordLastApiError(ctx, 'POST', `/task/${actionName}`, err, actionName);
        if (ctx.tasks.currentTask && ctx.tasks.currentTask.id === taskId && ctx.tasks.currentTask.status === 'running') {
          ctx.tasks.currentTask.status = 'error';
          ctx.tasks.currentTask.error = err.message;
          pushTaskHistoryRecord(ctx.tasks.currentTask, 'error');
        }
        pushAction(ctx, actionName, 'error', startedAt, null, err.message, reason);
        recordActionOutcome(ctx, actionName, 'error', err.message);
      });

    // task #21 — surface immediate-refusal preflight errors (BOAT_REQUIRED,
    // BOT_TRAPPED, NAV_RECURRING_STUCK, etc.) in the HTTP response, so the
    // agent doesn't get "started" and walk off when the task actually failed
    // synchronously. Race actionFn against a 250ms timeout — handlers that
    // refuse via preflight resolve in <10ms (pure JS, no network); real
    // navigation work blocks far longer.
    const earlyResult = await Promise.race([
      actionPromise.then((r) => ({ kind: 'resolved', result: r })).catch((e) => ({ kind: 'rejected', error: e })),
      new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 250)),
    ]);
    if (earlyResult.kind === 'resolved' && earlyResult.result && earlyResult.result.ok === false) {
      // Synchronous refusal — return it as the HTTP response so the agent
      // sees the error code + next_action_hint without needing to poll.
      return {
        ok: true,
        status: 200,
        response: {
          ...earlyResult.result,
          task_id: taskId,
          status: 'refused',
          state: briefState(),
        },
      };
    }

    return {
      ok: true,
      status: 200,
      response: { ok: true, task_id: taskId, status: 'started', state: briefState() },
    };
  }

  // ── Sync mode ──
  const startedAt = Date.now();
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 120) : null;
  /** @type {Record<string, any>} */
  const meta = { mode: 'sync', startedAt, briefState };

  // Pre-middleware (intercept-or-continue).
  for (const mw of syncPreMiddleware) {
    const r = mw.check(services, body, actionName, meta);
    if (r && r.intercept) {
      return {
        ok: true,
        status: 200,
        response: { ...r.response, state: briefState() },
      };
    }
  }

  ctx.tasks.lastApiError = null;
  ctx.tasks.syncActionInFlight = true;
  ctx.tasks.syncActionName = actionName;
  ctx.tasks.syncActionStartedAt = startedAt;

  // Clear any running bg task's pathfinder goal so sync action can use pathfinder
  // without triggering "goal was changed" on the sync action.
  if (ctx.tasks.currentTask && ctx.tasks.currentTask.status === 'running') {
    try { ensureBot().pathfinder.setGoal(null); } catch { /* ignore */ }
  }

  try {
    let result = await actionFn(body);
    const softFailure = result && typeof result === 'object' && result.ok === false;
    const status = softFailure ? 'error' : 'done';
    const errorMsg = softFailure ? (result.error?.message || result.error?.code || 'soft failure') : null;

    // Post-middleware: each may return a replacement result or undefined.
    for (const mw of syncPostMiddleware) {
      const next = mw.apply(services, body, actionName, result, meta);
      if (next !== undefined) result = next;
    }

    pushAction(ctx, actionName, status, startedAt, result, errorMsg, reason);
    recordActionOutcome(ctx, actionName, status, errorMsg);
    emitSyncNavTelemetry(services, actionName, result);
    runDevValidator(actionName, result);

    return {
      ok: true,
      status: 200,
      response: { ok: true, ...result, state: briefState() },
    };
  } finally {
    ctx.tasks.syncActionInFlight = false;
    ctx.tasks.syncActionName = null;
    ctx.tasks.syncActionStartedAt = null;
    ctx.runtime._lastSyncStuckLogAt = null;
  }
}
