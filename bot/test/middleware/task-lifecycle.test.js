/**
 * Phase 7 — dispatchAction tests.
 *
 * dispatchAction is the single entry point shared by both POST /action/<name>
 * (sync) and POST /task/<name> (async). It runs the pre/post middleware
 * pipelines in sync mode, threads `body.reason` into actionHistory, and
 * supports a HERMES_VALIDATE=1 dev validator.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dispatchAction,
  pushAction,
  recordActionOutcome,
  recordLastApiError,
} from '../../lib/server/middleware/task-lifecycle.js';
import { ok, fail } from '../../lib/shared/action-contract.js';
import { createBotState } from '../../lib/server/state.js';

function fixture({ mockBotOverrides = {} } = {}) {
  const state = createBotState({ behaviors: { fairPlay: true } });
  const mockBot = {
    username: 'TestBot',
    chat: () => {},
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 0 } },
    blockAt: () => ({ name: 'air' }),
    heldItem: null,
    pathfinder: { setGoal: () => {} },
    ...mockBotOverrides,
  };
  state.world.bot = mockBot;
  state.world.botReady = true;
  const services = {
    state,
    ensureBot: () => mockBot,
  };
  return { state, services, mockBot };
}

function buildRegistry(handlers) {
  return {
    has: (n) => Object.prototype.hasOwnProperty.call(handlers, n),
    get: (n) => handlers[n],
    names: () => Object.keys(handlers).sort(),
  };
}

const noopBrief = () => ({ new_chat: [] });

function baseOpts(actionRegistry, briefState = noopBrief) {
  return {
    actionRegistry,
    briefState,
    createTaskRecord: (rec) => ({ ...rec, started: Date.now(), status: 'running' }),
    pushTaskHistoryRecord: () => {},
  };
}

// ── Unknown action ───────────────────────────────────────────────────────

test('returns 400 on unknown action in sync mode', async () => {
  const { services } = fixture();
  const reg = buildRegistry({});
  const r = await dispatchAction(services, 'nope', {}, { mode: 'sync', ...baseOpts(reg) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /Unknown action/);
});

test('returns 400 on unknown action in task mode', async () => {
  const { services } = fixture();
  const reg = buildRegistry({});
  const r = await dispatchAction(services, 'nope', {}, { mode: 'task', ...baseOpts(reg) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

// ── Sync mode ────────────────────────────────────────────────────────────

test('sync: returns the handler result with state attached', async () => {
  const { services } = fixture();
  const handler = async () => ok({ data: { hello: 'world' }, result: 'hi' });
  const reg = buildRegistry({ greet: handler });

  const r = await dispatchAction(services, 'greet', {}, { mode: 'sync', ...baseOpts(reg) });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.response.result, 'hi');
  assert.deepEqual(r.response.data, { hello: 'world' });
});

test('sync: records "done" entry in actionHistory with reason threaded', async () => {
  const { state, services } = fixture();
  const reg = buildRegistry({ act: async () => ok({ result: 'fine' }) });

  await dispatchAction(services, 'act', { reason: 'why not' }, { mode: 'sync', ...baseOpts(reg) });
  assert.equal(state.tasks.actionHistory.length, 1);
  assert.equal(state.tasks.actionHistory[0].action, 'act');
  assert.equal(state.tasks.actionHistory[0].status, 'done');
  assert.equal(state.tasks.actionHistory[0].reason, 'why not');
});

test('sync: soft-failure result records "error" status + errorMsg', async () => {
  const { state, services } = fixture();
  const reg = buildRegistry({
    flake: async () => fail('FLAKED', 'something went wrong'),
  });
  const r = await dispatchAction(services, 'flake', {}, { mode: 'sync', ...baseOpts(reg) });
  assert.equal(r.ok, true);
  assert.equal(r.response.ok, false);
  assert.equal(state.tasks.actionHistory[0].status, 'error');
  // actionCounters records the error too.
  assert.equal(state.tasks.actionCounters.events[0].status, 'error');
  assert.match(state.tasks.actionCounters.events[0].error, /something went wrong/);
});

test('sync: pre-middleware intercept short-circuits the action', async () => {
  const { services, state } = fixture();
  // Trigger the position-guard intercept by setting a recent failed move.
  // actual_pos must match the mock bot's entity.position (0, 64, 0) so the
  // drift-clear branch doesn't fire and consume the flag.
  state.runtime.lastMoveFailed = {
    ts: Date.now(),
    intended_target: { x: 10, y: 64, z: 5 },
    actual_pos: { x: 0, y: 64, z: 0 },
    reason: 'NAV_NO_PROGRESS',
    verb: 'goto',
  };
  let called = 0;
  const reg = buildRegistry({ place: async () => { called++; return ok(); } });
  const r = await dispatchAction(services, 'place', { x: 11, y: 64, z: 5, block: 'cobblestone' },
    { mode: 'sync', ...baseOpts(reg) });
  assert.equal(r.ok, true);
  assert.equal(r.response.ok, false);
  assert.equal(r.response.error.code, 'MOVEMENT_PRECONDITION_FAILED');
  assert.equal(called, 0, 'handler should not have been called');
});

test('sync: clears syncActionInFlight state when handler throws', async () => {
  const { state, services } = fixture();
  const reg = buildRegistry({
    boom: async () => { throw new Error('kaboom'); },
  });
  await assert.rejects(
    () => dispatchAction(services, 'boom', {}, { mode: 'sync', ...baseOpts(reg) }),
    /kaboom/,
  );
  assert.equal(state.tasks.syncActionInFlight, false);
  assert.equal(state.tasks.syncActionName, null);
});

// ── Task mode ────────────────────────────────────────────────────────────

test('task: returns task_id immediately; result lands in actionHistory async', async () => {
  const { state, services } = fixture();
  let resolved;
  const handler = () => new Promise((r) => { resolved = r; });
  const reg = buildRegistry({ slow: handler });

  const r = await dispatchAction(services, 'slow', { reason: 'bg work' }, {
    mode: 'task', ...baseOpts(reg),
  });
  assert.equal(r.ok, true);
  assert.match(r.response.task_id, /^slow_\d+/);
  assert.equal(r.response.status, 'started');
  assert.equal(state.tasks.currentTask.status, 'running');

  // Let the bg task resolve.
  resolved(ok({ result: 'finished' }));
  // Wait one microtask tick.
  await new Promise((r) => setImmediate(r));

  assert.equal(state.tasks.currentTask.status, 'done');
  assert.equal(state.tasks.actionHistory.length, 1);
  assert.equal(state.tasks.actionHistory[0].reason, 'bg work');
});

test('task: returns 409 conflict when a task is already running', async () => {
  const { state, services } = fixture();
  state.tasks.currentTask = { action: 'prior', status: 'running', started: Date.now() - 5000 };
  const reg = buildRegistry({ act: async () => ok() });
  const r = await dispatchAction(services, 'act', {}, { mode: 'task', ...baseOpts(reg) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.match(r.error, /already running/i);
});

// ── pushAction / recordActionOutcome / recordLastApiError ───────────────

test('pushAction trims actionHistory to MAX_ACTION_HISTORY', () => {
  const state = createBotState({ behaviors: { fairPlay: true } });
  state.tasks.MAX_ACTION_HISTORY = 3;
  for (let i = 0; i < 5; i++) {
    pushAction(state, `verb${i}`, 'done', Date.now(), { result: `r${i}` });
  }
  assert.equal(state.tasks.actionHistory.length, 3);
  // Oldest dropped first.
  assert.equal(state.tasks.actionHistory[0].action, 'verb2');
});

test('pushAction omits reason field when reason not supplied', () => {
  const state = createBotState({ behaviors: { fairPlay: true } });
  pushAction(state, 'verb', 'done', Date.now(), { result: 'r' });
  assert.equal(state.tasks.actionHistory[0].reason, undefined);
});

test('recordActionOutcome stores event with error msg', () => {
  const state = createBotState({ behaviors: { fairPlay: true } });
  recordActionOutcome(state, 'verb', 'error', 'BAD_THING');
  assert.equal(state.tasks.actionCounters.events.length, 1);
  assert.equal(state.tasks.actionCounters.events[0].error, 'BAD_THING');
});

test('recordLastApiError writes ctx.tasks.lastApiError with action inferred from path', () => {
  const state = createBotState({ behaviors: { fairPlay: true } });
  recordLastApiError(state, 'POST', '/action/place', new Error('oops'));
  assert.equal(state.tasks.lastApiError.action, 'place');
  assert.equal(state.tasks.lastApiError.message, 'oops');
});

test('recordLastApiError skips reserved /task/ segments when inferring action', () => {
  const state = createBotState({ behaviors: { fairPlay: true } });
  recordLastApiError(state, 'POST', '/task/start', new Error('oops'), 'mining');
  // actionHint wins because /task/start is a control-plane path, not an action verb.
  assert.equal(state.tasks.lastApiError.action, 'mining');
});

// ── Task-mode synchronous refusal (task #21) ─────────────────────────────
// bg_goto/bg_collect/etc. now surface preflight refusals (BOAT_REQUIRED,
// BOT_TRAPPED, ...) directly in the HTTP response instead of returning
// "started" and forcing the agent to poll mc task. Race the handler
// against a 250ms window; if it resolves with ok:false, the response is
// the error envelope with status='refused'.

test("task mode: ok:false within 250ms surfaces 'refused' in response", async () => {
  const { services } = fixture();
  const handler = async () => fail('BOAT_REQUIRED', 'route crosses water', {
    observed_state: { distance: 800 },
    retry_safe: false,
  });
  const reg = buildRegistry({ goto: handler });

  const r = await dispatchAction(services, 'goto', { x: -300, y: 63, z: -100 },
    { mode: 'task', ...baseOpts(reg) });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.response.ok, false);
  assert.equal(r.response.status, 'refused');
  assert.equal(r.response.error.code, 'BOAT_REQUIRED');
  assert.match(r.response.task_id, /^goto_\d+$/);
});

test("task mode: ok:true within 250ms still returns the result (early-success)", async () => {
  // A handler that resolves quickly with ok:true should also surface
  // synchronously — the agent shouldn't have to poll for trivial actions.
  // Just verify the early-resolve path doesn't choke on success envelopes.
  const { services } = fixture();
  const handler = async () => ok({ data: { instant: true }, result: 'done' });
  const reg = buildRegistry({ quick: handler });

  const r = await dispatchAction(services, 'quick', {}, { mode: 'task', ...baseOpts(reg) });
  assert.equal(r.ok, true);
  // ok:true within the window keeps the legacy "started" semantics (it's
  // a backgrounded task — we don't second-guess the success contract,
  // only the refusal contract).
  assert.equal(r.response.status, 'started');
});

test("task mode: slow handler returns 'started' immediately", async () => {
  const { services } = fixture();
  const handler = () => new Promise((resolve) => {
    setTimeout(() => resolve(ok({ data: {} })), 600);
  });
  const reg = buildRegistry({ slow: handler });

  const t0 = Date.now();
  const r = await dispatchAction(services, 'slow', {}, { mode: 'task', ...baseOpts(reg) });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 240 && elapsed < 400, `expected ~250ms timeout, got ${elapsed}ms`);
  assert.equal(r.response.status, 'started');
});
