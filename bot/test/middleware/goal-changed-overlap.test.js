/**
 * GoalChanged reproduction ladder (gv2-2026-06-20-3 investigation).
 *
 * Documents how same-body pathfinder preemption surfaces to agents and which
 * server paths intentionally cancel goals. See docs/testing/genesis-v2/goalchanged-evidence-matrix.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { dispatchAction } from '../../lib/server/middleware/task-lifecycle.js';
import { ok } from '../../lib/shared/action-contract.js';
import { describePathfinderError } from '../../lib/actions/movement/nav-hints.js';
import { shouldDeferReaction } from '../../lib/runtime/reactive.js';
import { createBotState } from '../../lib/server/state.js';

function transportErrMsg(r) {
  if (typeof r.error === 'string') return r.error;
  return r.error?.message || '';
}

function fixture({ mockBotOverrides = {} } = {}) {
  const state = createBotState({ behaviors: { fairPlay: true } });
  const mockBot = {
    username: 'TestBot',
    chat: () => {},
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 0 } },
    blockAt: () => ({ name: 'air' }),
    heldItem: null,
    pathfinder: { setGoal: () => {}, goto: async () => {} },
    ...mockBotOverrides,
  };
  state.world.bot = mockBot;
  state.world.botReady = true;
  const services = { state, ensureBot: () => mockBot };
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

function baseOpts(actionRegistry) {
  return {
    actionRegistry,
    briefState: noopBrief,
    createTaskRecord: (rec) => ({ ...rec, started: Date.now(), status: 'running' }),
    pushTaskHistoryRecord: () => {},
  };
}

const GOAL_CHANGED_MSG = 'The goal was changed before it could be completed!';

// ── Level 1: symptom shape agents see ───────────────────────────────────

test('Level 1: describePathfinderError passes through Mineflayer GoalChanged text', () => {
  assert.equal(describePathfinderError(GOAL_CHANGED_MSG), GOAL_CHANGED_MSG);
});

test('Level 1: pathfinder goto after setGoal(null) matches production error class', async () => {
  let generation = 0;
  const bot = {
    pathfinder: {
      setGoal(goal) {
        if (goal === null) generation += 1;
      },
      async goto() {
        throw new Error(GOAL_CHANGED_MSG);
      },
    },
  };
  bot.pathfinder.setGoal({});
  bot.pathfinder.setGoal(null);
  await assert.rejects(() => bot.pathfinder.goto(), (e) => {
    assert.match(e.message, /goal was changed/i);
    return true;
  });
  assert.equal(generation, 1);
});

// ── Level 2: sync over bg task (serialized with 409) ──────────────────

test('Level 2: sync dispatch is rejected while bg task is running (409)', async () => {
  const { state, services } = fixture({
    mockBotOverrides: {
      pathfinder: {
        setGoal() {},
        goto: async () => {},
      },
    },
  });

  let resolveBg;
  const bgPromise = new Promise((resolve) => {
    resolveBg = resolve;
  });

  const reg = buildRegistry({
    slow_bg: () => bgPromise,
    quick_sync: async () => ok({ result: 'sync' }),
  });
  const opts = baseOpts(reg);

  const started = await dispatchAction(services, 'slow_bg', {}, { mode: 'task', ...opts });
  assert.equal(started.response.status, 'started');
  assert.equal(state.tasks.currentTask.status, 'running');

  const blocked = await dispatchAction(services, 'quick_sync', {}, { mode: 'sync', ...opts });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 409);
  assert.match(transportErrMsg(blocked), /already running/i);

  resolveBg(ok({ result: 'bg done' }));
  await new Promise((r) => setImmediate(r));
});

test('Level 2: overlapping sync actions are rejected with 409', async () => {
  const { state, services } = fixture();
  let releaseFirst;
  const reg = buildRegistry({
    slow_sync: async () => {
      await new Promise((resolve) => { releaseFirst = resolve; });
      return ok({ result: 'done' });
    },
  });
  const opts = baseOpts(reg);

  const p1 = dispatchAction(services, 'slow_sync', {}, { mode: 'sync', ...opts });
  await new Promise((r) => setTimeout(r, 10));
  const p2 = await dispatchAction(services, 'slow_sync', {}, { mode: 'sync', ...opts });

  assert.equal(p2.ok, false);
  assert.equal(p2.status, 409);
  assert.match(transportErrMsg(p2), /sync action .* already running/i);

  releaseFirst();
  const r1 = await p1;
  assert.equal(r1.ok, true);
  assert.equal(r1.status, 200);
  assert.equal(r1.response.ok, true);
  assert.equal(r1.response.result, 'done');

  assert.equal(state.tasks.syncActionInFlight, false);
});

// ── Reactive deferral scope (not run-3 primary cause) ───────────────────

test('shouldDeferReaction: flee_step deferred during sync, swim_up not in defer set', () => {
  const tasks = { syncActionInFlight: true, currentTask: null };
  assert.equal(
    shouldDeferReaction({ action: 'flee_step', why: 'hostile_near' }, tasks),
    true,
  );
  assert.equal(
    shouldDeferReaction({ action: 'swim_up', why: 'head_in_water' }, tasks),
    false,
  );
});

// ── Level 4: compound-like overlap harness ──────────────────────────────

test('Level 4: compound-like in-flight sync action blocks follow-on nav sync (409)', async () => {
  let releaseCompound;
  const { services } = fixture();
  const reg = buildRegistry({
    fell_tree: async () => {
      await new Promise((resolve) => { releaseCompound = resolve; });
      return ok({ result: 'fell_tree done' });
    },
    move: async () => ok({ result: 'moved' }),
  });
  const opts = baseOpts(reg);

  const pCompound = dispatchAction(services, 'fell_tree', {}, { mode: 'sync', ...opts });
  await new Promise((r) => setTimeout(r, 10));
  const blockedMove = await dispatchAction(services, 'move', { x: 1, y: 64, z: 1 }, { mode: 'sync', ...opts });

  assert.equal(blockedMove.ok, false);
  assert.equal(blockedMove.status, 409);
  assert.match(transportErrMsg(blockedMove), /sync action .* already running/i);

  releaseCompound();
  const compoundResult = await pCompound;
  assert.equal(compoundResult.ok, true);
  assert.equal(compoundResult.status, 200);
});
