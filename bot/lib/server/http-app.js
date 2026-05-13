/**
 * Mineflayer bot HTTP listener factory — extracted from server.js for readability and testing.
 */
import fs from 'fs';

export function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}

export function respond(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

const TASK_SEG_SKIP = new Set(['start', 'cancel', 'pause', 'resume', 'checkpoint-respond', 'history']);

/** Extract a short (≤80 char) one-liner from an action result for the dashboard. */
function actionSummary(result) {
  if (!result) return '';
  const raw = typeof result === 'string' ? result : result.result || result.message || '';
  if (!raw) return '';
  const first = String(raw).split(/[.\n]/, 1)[0].trim();
  return first.length > 80 ? first.slice(0, 77) + '…' : first;
}

function pushAction(ctx, action, status, startedAt, result, error) {
  ctx.actionHistory.push({
    action,
    status,
    started_at: startedAt,
    finished_at: Date.now(),
    detail: status === 'done' ? actionSummary(result) : (error || '').slice(0, 80),
  });
  if (ctx.actionHistory.length > ctx.MAX_ACTION_HISTORY) ctx.actionHistory.shift();
}

function recordActionOutcome(ctx, action, status, errorMsg) {
  const now = Date.now();
  const c = ctx.actionCounters;
  if (!c) return;
  c.events.push({ ts: now, action, status, error: errorMsg || null });
  const cutoff = now - c.window_ms;
  while (c.events.length > 0 && c.events[0].ts < cutoff) c.events.shift();
  if (c.events.length > 600) c.events.splice(0, c.events.length - 600);
}

function buildActionStats(ctx) {
  const now = Date.now();
  const c = ctx.actionCounters;
  const cutoff = now - c.window_ms;
  const evts = c.events.filter((e) => e.ts >= cutoff);
  if (!evts.length) return { total: 0, done: 0, failed: 0, error_rate_pct: 0, actions_per_min: 0, top_errors: [], window_sec: Math.round(c.window_ms / 1000) };
  const done = evts.filter((e) => e.status === 'done').length;
  const failed = evts.length - done;
  const spanMin = Math.max(0.05, (evts[evts.length - 1].ts - evts[0].ts) / 60000 || c.window_ms / 60000);
  const errMap = {};
  evts.filter((e) => e.status !== 'done' && e.error).forEach((e) => {
    const key = `${e.action}: ${(e.error || '').slice(0, 80)}`;
    errMap[key] = (errMap[key] || 0) + 1;
  });
  const topErrors = Object.entries(errMap).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([msg, n]) => ({ msg, n }));
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

function classifyIdleReason(ctx) {
  if (!ctx.bot || !ctx.botReady) return 'disconnected';
  if (ctx.currentTask?.status === 'running') return 'task_running';
  if (ctx.currentTask?.status === 'stuck') return 'task_stuck';
  const recent3 = ctx.actionHistory.slice(-3);
  if (recent3.length === 3 && recent3.every((e) => e.status !== 'done' && e.action === recent3[0].action)) return 'error_loop';
  if (ctx.lastApiError && Date.now() - ctx.lastApiError.ts < 30000) return 'recent_error';
  return 'awaiting_agent';
}

/** Record last failure for dashboard /observe (Hermes agents rarely persist goals — this stays server-side). */
function recordLastApiError(ctx, reqMethod, pathname, err, actionHint) {
  const msg = (err && err.message) || String(err || 'error');
  const am = pathname.match(/^\/action\/(\w+)$/);
  const tm = pathname.match(/^\/task\/(\w+)$/);
  let action = actionHint || null;
  if (!action && am) action = am[1];
  if (!action && tm && !TASK_SEG_SKIP.has(tm[1])) action = tm[1];
  ctx.lastApiError = {
    ts: Date.now(),
    method: reqMethod,
    path: pathname,
    action,
    message: msg.slice(0, 2000),
  };
}

/** @param {Record<string, any>} deps */
export function createBotHttpListener(deps) {
  const {
    config,
    ctx,
    spatial,
    actionRegistry,
    ensureBot,
    briefState,
    getFullState,
    buildMarksListApi,
    getInventory,
    getNearby,
    buildSceneSummary,
    summarizeSocialGraph,
    refreshLeaseCheckpoint,
    taskToApi,
    persistGoalsToDisk,
    listPresets,
    getGoalsScoreboard,
    buildObservePayload,
    buildTypedAlerts,
    buildLogisticsPayload,
    loadPreset,
    mergePresetIntoStore,
    createTaskRecord,
    pushTaskHistoryRecord,
    renewLease,
    createBot,
    dashboardHtmlPath,
  } = deps;

  return async function botHttpListener(req, res) {

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${config.api.port}`);
  const path = url.pathname;

  try {
    // ── GET endpoints (observation) ──────────────
    if (req.method === 'GET') {
      if (path === '/health' || path === '/') {
        const alive = !ctx.bot || ctx.bot.isAlive !== false;
        const connected = !!(ctx.botReady && alive);
        const pos = connected && ctx.bot?.entity ? ctx.bot.entity.position : null;
        const boot = typeof ctx.bootTime === 'number' ? ctx.bootTime : Date.now();
        const uptimeSec = Math.round((Date.now() - boot) / 1000);
        let moveRate = null;
        const positionHistory = ctx.positionHistory || [];
        if (positionHistory.length >= 2) {
          const recent = positionHistory;
          const first = recent[0];
          const last = recent[recent.length - 1];
          const dt = (last.time - first.time) / 1000;
          if (dt > 2) {
            const dist = Math.sqrt((last.x - first.x) ** 2 + (last.z - first.z) ** 2);
            moveRate = +(dist / dt).toFixed(2);
          }
        }
        return respond(res, 200, {
          ok: true,
          connected,
          username: config.mc.username,
          profile: process.env.AGENT_PROFILE || config.mc.username,
          model: process.env.AGENT_MODEL || null,
          provider: process.env.AGENT_PROVIDER || null,
          server: `${config.mc.host}:${config.mc.port}`,
          uptime_sec: uptimeSec,
          holding: connected && ctx.bot?.heldItem ? ctx.bot.heldItem.name : null,
          position: pos ? { x: +pos.x.toFixed(1), y: +pos.y.toFixed(1), z: +pos.z.toFixed(1) } : null,
          move_rate: moveRate,
        });
      }

      if (path === '/status') {
        const lean = url.searchParams.get('lean') === 'true';
        // F51.2: mc status is the brain's explicit "let me check my
        // position" — clear any lingering lastMoveFailed flag so the
        // next position-dependent verb runs normally.
        if (ctx.lastMoveFailed) ctx.lastMoveFailed = null;
        return respond(res, 200, { ok: true, data: getFullState({ lean }) });
      }

      if (path === '/marks') {
        ensureBot();
        return respond(res, 200, { ok: true, data: { marks: buildMarksListApi() } });
      }

      if (path === '/inventory') {
        return respond(res, 200, { ok: true, data: getInventory() });
      }

      if (path === '/nearby') {
        const radius = parseInt(url.searchParams.get('radius') || '32');
        return respond(res, 200, { ok: true, data: getNearby(radius) });
      }

      // ASCII top-down map of surroundings
      if (path === '/map') {
        const radius = parseInt(url.searchParams.get('radius') || '16');
        return respond(res, 200, { ok: true, data: spatial.generateMap(radius) });
      }

      // Narrative description of what you see (human-readable)
      if (path === '/look') {
        return respond(res, 200, { ok: true, data: spatial.generateLookAround() });
      }

      if (path === '/scene') {
        const range = parseInt(url.searchParams.get('range') || '16');
        const lean = url.searchParams.get('lean') === 'true';
        const data = buildSceneSummary({ range: Math.min(range, 24) });
        if (lean && data) {
          // Drop the heaviest fields: full ray-hit array and detailed entity
          // list. Keep summary (text), aggregate visible_blocks, hazards,
          // looking_at, and short entity preview.
          const { visible_block_hits, visible_entities, ...rest } = data;
          rest.visible_entities = (visible_entities || []).slice(0, 4);
          return respond(res, 200, { ok: true, data: rest });
        }
        return respond(res, 200, { ok: true, data });
      }

      if (path === '/social') {
        return respond(res, 200, { ok: true, data: { summary: summarizeSocialGraph(ctx.socialGraph), recent_events: ctx.socialEvents.slice(-20) } });
      }

      if (path === '/chat') {
        const count = parseInt(url.searchParams.get('count') || '20');
        const clear = url.searchParams.get('clear') === 'true';
        const msgs = ctx.chatLog.slice(-count);
        if (clear) ctx.chatLog.length = 0;
        return respond(res, 200, { ok: true, data: { messages: msgs } });
      }

      if (path === '/overhear') {
        const count = parseInt(url.searchParams.get('count') || '20');
        const msgs = ctx.overheardLog.slice(-count);
        return respond(res, 200, { ok: true, data: { messages: msgs } });
      }

      if (path === '/deaths') {
        return respond(res, 200, { ok: true, data: {
          total: ctx.deathLog.length,
          last_death: ctx.lastDeath ? {
            ...ctx.lastDeath,
            seconds_ago: Math.round((Date.now() - ctx.lastDeath.time) / 1000),
            items_lost: ctx.lastDeath.inventory.map(i => `${i.name}x${i.count}`).join(', ')
          } : null
        }});
      }

      if (path === '/commands') {
        // Get pending commands queued by in-game chat
        const pending = ctx.commandQueue.filter(c => c.status === 'pending');
        return respond(res, 200, { ok: true, data: { commands: pending } });
      }

      if (path === '/sounds') {
        return respond(res, 200, { ok: true, data: { sounds: ctx.soundEvents.slice(-10) } });
      }

      if (path === '/team') {
        return respond(res, 200, { ok: true, data: ctx.teamConfig });
      }

      if (path === '/stats') {
        return respond(res, 200, { ok: true, data: ctx.combatStats });
      }

      if (path === '/furnaces') {
        return respond(res, 200, { ok: true, data: { furnaces: ctx.activeFurnaces.map(f => ({
          ...f,
          eta_seconds: f.estimatedDone ? Math.max(0, Math.round((f.estimatedDone - Date.now()) / 1000)) : null,
        })) } });
      }

      if (path === '/task') {
        // F46: /task now reports three independent slots so the brain
        // can tell "async bg task" from "sync action in flight" from
        // "what just finished":
        //   task — async ctx.currentTask (POST /task/start), null otherwise
        //   sync — currently-running synchronous /action/<name>, null otherwise
        //   last — most recent completed sync OR async action, null if never
        // Pre-F46 callers that only read data.task continue to work; the
        // sync/last fields are additive. The point is to kill the polling
        // spam from G21 v1 where Mason called `mc task` 22× after a
        // synchronous `mc fill` completed and got `{task: null}` every time.
        refreshLeaseCheckpoint(ctx.currentTask);
        const now = Date.now();
        const sync = ctx.syncActionInFlight
          ? {
              action: ctx.syncActionName,
              started_at_ms: ctx.syncActionStartedAt,
              elapsed_s: ctx.syncActionStartedAt
                ? Math.round((now - ctx.syncActionStartedAt) / 1000)
                : 0,
            }
          : null;
        const history = Array.isArray(ctx.actionHistory) ? ctx.actionHistory : [];
        const recent = history.length > 0 ? history[history.length - 1] : null;
        const last = recent
          ? {
              action: recent.action,
              status: recent.status,
              finished_at_ms: recent.finished_at,
              age_s: Math.round((now - recent.finished_at) / 1000),
              detail: recent.detail || null,
            }
          : null;
        return respond(res, 200, {
          ok: true,
          data: {
            task: ctx.currentTask ? taskToApi(ctx.currentTask) : null,
            sync,
            last,
          },
          state: briefState(),
        });
      }

      if (path === '/goals') {
        ensureBot();
        const { scored, context } = getGoalsScoreboard();
        persistGoalsToDisk();
        return respond(res, 200, {
          ok: true,
          data: { goals: scored, context },
        });
      }

      if (path === '/goal-presets' || path === '/goals/presets') {
        return respond(res, 200, { ok: true, data: { presets: listPresets() } });
      }

      const goalIdMatch = path.match(/^\/goals\/([^/]+)$/);
      if (goalIdMatch) {
        ensureBot();
        const gid = decodeURIComponent(goalIdMatch[1]);
        const g = ctx.goalsStore.goals.find((x) => x.id === gid);
        if (!g) return respond(res, 404, { ok: false, error: `Goal not found: ${gid}` });
        const { scored } = getGoalsScoreboard();
        const detail = scored.find((x) => x.id === gid) || g;
        return respond(res, 200, { ok: true, data: { goal: detail } });
      }

      if (path === '/checkpoint') {
        ensureBot();
        return respond(res, 200, buildObservePayload());
      }

      if (path === '/observe') {
        ensureBot();
        const lean = url.searchParams.get('lean') === 'true';
        return respond(res, 200, buildObservePayload({ lean }));
      }

      if (path === '/alerts') {
        ensureBot();
        return respond(res, 200, { ok: true, data: { alerts: buildTypedAlerts() } });
      }

      if (path === '/logistics') {
        ensureBot();
        return respond(res, 200, buildLogisticsPayload());
      }

      if (path === '/dashboard') {
        try {
          const html = fs.readFileSync(dashboardHtmlPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(html);
        } catch (e) {
          return respond(res, 404, { ok: false, error: 'dashboard.html not found' });
        }
      }

      if (path === '/task/history') {
        return respond(res, 200, { ok: true, data: { history: ctx.taskHistory } });
      }
    }

    // ── POST endpoints (actions) ────────────────
    if (req.method === 'POST') {
      const body = await parseBody(req);

      // Cancel current task
      if (path === '/task/cancel') {
        const b = ensureBot();
        b.pathfinder.setGoal(null);
        try { b.stopDigging(); } catch {}
        if (ctx.currentTask && (ctx.currentTask.status === 'running' || ctx.currentTask.status === 'stuck')) {
          ctx.currentTask.status = 'cancelled';
          pushTaskHistoryRecord(ctx.currentTask, 'cancelled');
        }
        return respond(res, 200, { ok: true, result: 'Task cancelled.', state: briefState() });
      }

      // Explicit task start with goal + lease
      if (path === '/task/start') {
        if (ctx.currentTask && ctx.currentTask.status === 'running') {
          return respond(res, 409, {
            ok: false,
            error: `Task "${ctx.currentTask.action}" is already running. POST /task/cancel first.`,
            state: briefState(),
          });
        }
        const actionName = body.action;
        if (!actionName || !actionRegistry.has(actionName)) {
          const available = actionRegistry.names().join(', ');
          return respond(res, 400, {
            ok: false,
            error: `Unknown or missing action. Available: ${available}`,
          });
        }
        const actionFn = actionRegistry.get(actionName);
        const taskBody =
          body.params && typeof body.params === 'object' ? { ...body.params } : { ...body };
        delete taskBody.action;
        delete taskBody.lease_seconds;
        delete taskBody.goal_id;
        delete taskBody.parent_goal_id;
        delete taskBody.contributes_to;
        const taskId = `${actionName}_${Date.now()}`;
        const leaseSec =
          body.lease_seconds != null ? parseFloat(body.lease_seconds) : null;
        ctx.currentTask = createTaskRecord({
          id: taskId,
          action: actionName,
          lease_seconds: leaseSec && leaseSec > 0 ? leaseSec : null,
          parent_goal_id: body.goal_id || body.parent_goal_id || null,
          contributes_to: body.contributes_to || null,
        });
        const actionStartedAt = Date.now();
        actionFn(taskBody)
          .then((result) => {
            if (ctx.currentTask && ctx.currentTask.id === taskId && ctx.currentTask.status === 'running') {
              ctx.currentTask.status = 'done';
              ctx.currentTask.result = result;
              pushTaskHistoryRecord(ctx.currentTask, 'done');
            }
            pushAction(ctx, actionName, 'done', actionStartedAt, result);
            recordActionOutcome(ctx, actionName, 'done');
          })
          .catch((err) => {
            recordLastApiError(ctx, 'POST', '/task/start', err, actionName);
            if (ctx.currentTask && ctx.currentTask.id === taskId && ctx.currentTask.status === 'running') {
              ctx.currentTask.status = 'error';
              ctx.currentTask.error = err.message;
              pushTaskHistoryRecord(ctx.currentTask, 'error');
            }
            pushAction(ctx, actionName, 'error', actionStartedAt, null, err.message);
            recordActionOutcome(ctx, actionName, 'error', err.message);
          });
        return respond(res, 200, {
          ok: true,
          task_id: taskId,
          status: 'started',
          state: briefState(),
        });
      }

      if (path === '/task/checkpoint-respond') {
        refreshLeaseCheckpoint(ctx.currentTask);
        const decision = String(body.decision || 'continue').toLowerCase();
        const leaseSeconds =
          body.lease_seconds != null ? parseFloat(body.lease_seconds) : 45;
        if (!ctx.currentTask || ctx.currentTask.status !== 'running') {
          return respond(res, 200, {
            ok: true,
            result: 'No running task to checkpoint.',
            state: briefState(),
          });
        }
        if (decision === 'cancel' || decision === 'abort') {
          try {
            const b = ensureBot();
            b.pathfinder.setGoal(null);
            try {
              b.stopDigging();
            } catch {}
          } catch {}
          ctx.currentTask.status = 'cancelled';
          pushTaskHistoryRecord(ctx.currentTask, 'cancelled');
          ctx.currentTask = null;
          return respond(res, 200, { ok: true, result: 'Task cancelled at checkpoint.', state: briefState() });
        }
        if (decision === 'continue' || decision === 'renew') {
          renewLease(ctx.currentTask, leaseSeconds > 0 ? leaseSeconds : 45);
          return respond(res, 200, {
            ok: true,
            result: `Lease renewed (${leaseSeconds}s).`,
            state: briefState(),
          });
        }
        renewLease(ctx.currentTask, leaseSeconds > 0 ? leaseSeconds : 45);
        return respond(res, 200, {
          ok: true,
          result: `Checkpoint noted (${decision}). Lease renewed.`,
          state: briefState(),
        });
      }

      if (path === '/task/pause') {
        ensureBot();
        if (ctx.currentTask && ctx.currentTask.status === 'running') {
          ctx.currentTask.checkpoint_status = 'pending';
        }
        return respond(res, 200, {
          ok: true,
          result: 'Checkpoint forced (pending).',
          state: briefState(),
        });
      }

      if (path === '/task/resume') {
        ensureBot();
        const ls = body.lease_seconds != null ? parseFloat(body.lease_seconds) : 45;
        if (ctx.currentTask && ctx.currentTask.status === 'running') {
          renewLease(ctx.currentTask, ls > 0 ? ls : 45);
          return respond(res, 200, {
            ok: true,
            result: 'Lease renewed.',
            state: briefState(),
          });
        }
        return respond(res, 200, {
          ok: true,
          result: 'No active task.',
          state: briefState(),
        });
      }

      // Goals API
      if (path === '/goals' && req.method === 'POST') {
        ensureBot();
        if (Array.isArray(body.goals)) {
          ctx.goalsStore.goals = body.goals;
        } else if (body.goal) {
          const g = body.goal;
          const idx = ctx.goalsStore.goals.findIndex((x) => x.id === g.id);
          if (idx >= 0) ctx.goalsStore.goals[idx] = { ...ctx.goalsStore.goals[idx], ...g };
          else ctx.goalsStore.goals.push(g);
        }
        persistGoalsToDisk();
        return respond(res, 200, { ok: true, data: { count: ctx.goalsStore.goals.length }, state: briefState() });
      }

      if (path === '/goals/update') {
        ensureBot();
        const id = body.id;
        if (!id) return respond(res, 400, { ok: false, error: 'Missing goal id' });
        const idx = ctx.goalsStore.goals.findIndex((x) => x.id === id);
        if (idx < 0) return respond(res, 404, { ok: false, error: `Goal not found: ${id}` });
        const { id: _id, ...rest } = body;
        ctx.goalsStore.goals[idx] = { ...ctx.goalsStore.goals[idx], ...rest };
        persistGoalsToDisk();
        return respond(res, 200, { ok: true, data: { goal: ctx.goalsStore.goals[idx] }, state: briefState() });
      }

      if (path === '/goals/load-preset') {
        ensureBot();
        const name = body.preset || body.name;
        if (!name) return respond(res, 400, { ok: false, error: 'Missing preset name' });
        const preset = loadPreset(name);
        if (!preset) return respond(res, 404, { ok: false, error: `Preset not found: ${name}` });
        ctx.goalsStore = mergePresetIntoStore(ctx.goalsStore, preset);
        persistGoalsToDisk();
        return respond(res, 200, {
          ok: true,
          result: `Loaded preset '${name}'`,
          data: { goals: ctx.goalsStore.goals.length },
          state: briefState(),
        });
      }

      // Background task system: POST /task/ACTION runs async, returns task_id
      const taskMatch = path.match(/^\/task\/(\w+)$/);
      if (taskMatch) {
        const actionName = taskMatch[1];
        const actionFn = actionRegistry.get(actionName);
        if (!actionFn) {
          const available = actionRegistry.names().join(', ');
          return respond(res, 400, { ok: false, error: `Unknown action "${actionName}". Available: ${available}` });
        }
        if (ctx.currentTask && ctx.currentTask.status === 'running') {
          return respond(res, 409, { ok: false, error: `Task "${ctx.currentTask.action}" is already running (${Math.round((Date.now() - ctx.currentTask.started) / 1000)}s). POST /task/cancel first.`, state: briefState() });
        }
        const taskId = `${actionName}_${Date.now()}`;
        const leaseSec = body.lease_seconds != null ? parseFloat(body.lease_seconds) : null;
        ctx.currentTask = createTaskRecord({
          id: taskId,
          action: actionName,
          lease_seconds: leaseSec && leaseSec > 0 ? leaseSec : null,
          parent_goal_id: body.goal_id || body.parent_goal_id || null,
          contributes_to: body.contributes_to || null,
        });
        const taskStartedAt = Date.now();
        actionFn(body).then(result => {
          if (ctx.currentTask && ctx.currentTask.id === taskId && ctx.currentTask.status === 'running') {
            ctx.currentTask.status = 'done';
            ctx.currentTask.result = result;
            pushTaskHistoryRecord(ctx.currentTask, 'done');
          }
          pushAction(ctx, actionName, 'done', taskStartedAt, result);
          recordActionOutcome(ctx, actionName, 'done');
        }).catch(err => {
          recordLastApiError(ctx, 'POST', path, err, actionName);
          if (ctx.currentTask && ctx.currentTask.id === taskId && ctx.currentTask.status === 'running') {
            ctx.currentTask.status = 'error';
            ctx.currentTask.error = err.message;
            pushTaskHistoryRecord(ctx.currentTask, 'error');
          }
          pushAction(ctx, actionName, 'error', taskStartedAt, null, err.message);
          recordActionOutcome(ctx, actionName, 'error', err.message);
        });
        return respond(res, 200, { ok: true, task_id: taskId, status: 'started', state: briefState() });
      }

      // Synchronous action: POST /action/ACTION (still supported for quick stuff)
      const actionMatch = path.match(/^\/action\/(\w+)$/);
      if (!actionMatch) {
        // Special: /connect — idempotent unless body.force=true (HermesCraft: avoid resetting TCP during handshake).
        if (path === '/connect') {
          const force = body?.force === true || body?.reconnect === true;
          try {
            await createBot(force ? { force: true } : {});
            const note =
              ctx.botReady && ctx.bot?.entity
                ? force
                  ? 'Reconnected (forced)'
                  : 'Connected'
                : 'Connecting';
            return respond(res, 200, {
              ok: true,
              connected: !!ctx.botReady,
              force: !!force,
              result: note,
              state: briefState(),
            });
          } catch (e) {
            const msg = (e && e.message) || String(e);
            return respond(res, 503, {
              ok: false,
              error: msg,
              state: briefState(),
            });
          }
        }
        return respond(res, 404, { ok: false, error: `Unknown endpoint: ${path}` });
      }

      const actionName = actionMatch[1];
      const actionFn = actionRegistry.get(actionName);
      if (!actionFn) {
        const available = actionRegistry.names().join(', ');
        return respond(res, 400, { ok: false, error: `Unknown action "${actionName}". Available: ${available}` });
      }

      // F51.2: Position-dependent verb guard. After a failed mc move/goto/
      // goto_near, the bot's position model is unreliable. Subsequent verbs
      // that target a coordinate near the failed-move target are highly
      // likely to fail — and in prior G21 runs they cascaded into 5–10
      // wasted commands per failure. Short-circuit them with a structured
      // diagnostic. Passives (chat, status, inventory, scene, nearby,
      // standing, look, craft, smelt, equip, wait, marks, memory, task,
      // cancel, stop) are always allowed so the brain can recover.
      //
      // Flag clears on: next successful move, mc status call (explicit
      // acknowledgement), or 30s decay.
      const POSITION_DEPENDENT_VERBS = new Set([
        'place', 'dig', 'safe_dig', 'fill',
        'interact', 'through',
        'deposit', 'withdraw', 'chest_search',
        'place_at_mark',
        'fence', 'tunnel', 'stair_up', 'stair_down',
      ]);
      // mc status clears the flag (explicit acknowledgement that brain
      // checked its position).
      if (actionName === 'status' && ctx.lastMoveFailed) {
        ctx.lastMoveFailed = null;
      }
      // 30s decay: if the last failure is old, drop it.
      if (ctx.lastMoveFailed && (Date.now() - ctx.lastMoveFailed.ts) > 30_000) {
        ctx.lastMoveFailed = null;
      }
      if (POSITION_DEPENDENT_VERBS.has(actionName) && ctx.lastMoveFailed) {
        const lmf = ctx.lastMoveFailed;
        // Extract primary target coord from body. Most verbs use {x, y, z};
        // chest_search may include them; fill uses x1/y1/z1.
        const tx = Number.isFinite(Number(body?.x)) ? Number(body.x) : (Number.isFinite(Number(body?.x1)) ? Number(body.x1) : null);
        const ty = Number.isFinite(Number(body?.y)) ? Number(body.y) : (Number.isFinite(Number(body?.y1)) ? Number(body.y1) : null);
        const tz = Number.isFinite(Number(body?.z)) ? Number(body.z) : (Number.isFinite(Number(body?.z1)) ? Number(body.z1) : null);
        let nearFailedTarget = false;
        if (tx !== null && ty !== null && tz !== null) {
          const dx = tx - lmf.intended_target.x;
          const dy = ty - lmf.intended_target.y;
          const dz = tz - lmf.intended_target.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          nearFailedTarget = dist <= 5;
        }
        if (nearFailedTarget) {
          const ageS = Math.round((Date.now() - lmf.ts) / 100) / 10;
          return respond(res, 200, {
            ok: false,
            error: {
              code: 'MOVEMENT_PRECONDITION_FAILED',
              message: `Can't run mc ${actionName} at ${tx},${ty},${tz} — your previous mc ${lmf.verb} to ${lmf.intended_target.x},${lmf.intended_target.y},${lmf.intended_target.z} failed ${ageS}s ago (${lmf.reason}). You're at ${lmf.actual_pos?.x ?? '?'},${lmf.actual_pos?.y ?? '?'},${lmf.actual_pos?.z ?? '?'}, not where you intended. Run \`mc status\` to recheck your position, or retry \`mc move\` first. (Flag clears on next successful move OR mc status OR 30s.)`,
              observed_state: {
                attempted_verb: actionName,
                attempted_target: { x: tx, y: ty, z: tz },
                last_failed_move: lmf,
              },
              retry_safe: false,
            },
            state: briefState(),
          });
        }
      }

      ctx.lastApiError = null;
      ctx.syncActionInFlight = true;
      ctx.syncActionName = actionName;
      ctx.syncActionStartedAt = Date.now();

      // Clear any running bg task's pathfinder goal so sync action can use pathfinder
      // without triggering "goal was changed" on the sync action.
      if (ctx.currentTask && ctx.currentTask.status === 'running') {
        try { ensureBot().pathfinder.setGoal(null); } catch {}
      }

      const syncStart = Date.now();
      try {
        const result = await actionFn(body);
        // Phase-2 action contract: handlers may return { ok: false, error: {...} }
        // for soft failures. Record those as 'error' so observe.action_loop fires
        // and so action_stats_5m counts them correctly.
        const softFailure = result && typeof result === 'object' && result.ok === false;
        const status = softFailure ? 'error' : 'done';
        const errorMsg = softFailure ? (result.error?.message || result.error?.code || 'soft failure') : null;
        pushAction(ctx, actionName, status, syncStart, result, errorMsg);
        recordActionOutcome(ctx, actionName, status, errorMsg);
        return respond(res, 200, { ok: true, ...result, state: briefState() });
      } finally {
        ctx.syncActionInFlight = false;
        ctx.syncActionName = null;
        ctx.syncActionStartedAt = null;
        ctx._lastSyncStuckLogAt = null;
      }
    }

    if (req.method === 'DELETE') {
      const gm = path.match(/^\/goals\/([^/]+)$/);
      if (gm) {
        ensureBot();
        const gid = decodeURIComponent(gm[1]);
        const before = ctx.goalsStore.goals.length;
        ctx.goalsStore.goals = ctx.goalsStore.goals.filter((x) => x.id !== gid);
        if (ctx.goalsStore.goals.length === before) {
          return respond(res, 404, { ok: false, error: `Goal not found: ${gid}` });
        }
        persistGoalsToDisk();
        return respond(res, 200, { ok: true, result: `Removed goal ${gid}` });
      }
      return respond(res, 404, { ok: false, error: `Not found: DELETE ${path}` });
    }

    respond(res, 404, { ok: false, error: `Not found: ${req.method} ${path}` });

  } catch (err) {
    recordLastApiError(ctx, req.method, path, err);
    const am = path.match(/^\/action\/(\w+)$/);
    if (am) {
      pushAction(ctx, am[1], 'error', Date.now(), null, err.message);
      recordActionOutcome(ctx, am[1], 'error', err.message);
    }
    const msg = String(err.message || '');
    const status =
      /not connected|respawn in progress|dead —/i.test(msg) ? 503 : 400;
    respond(res, status, { ok: false, error: err.message, state: briefState() });
  }
  };
}

export { buildActionStats, classifyIdleReason };

