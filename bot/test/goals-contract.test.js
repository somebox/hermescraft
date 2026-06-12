/**
 * Goals HTTP API contract tests (mc goal_* routes).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { createBotHttpListener } from '../lib/server/http-app.js';

function mockReqWithBody(method, urlPath, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = urlPath;
  queueMicrotask(() => {
    if (body) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function mockRes() {
  return {
    statusCode: 0,
    body: '',
    setHeader() {},
    writeHead(status) {
      this.statusCode = status;
    },
    end(chunk) {
      this.body += chunk;
    },
  };
}

test('POST /goals/update: missing id → 400 # spec', async () => {
  const ctx = {
    runtime: {},
    world: { botReady: true, bot: { entity: { position: { x: 0, y: 64, z: 0 } } } },
    tasks: { actionHistory: [] },
    goals: { goalsStore: { goals: [{ id: 'g1', metric: 'logs_total' }] } },
    reactive: {},
    social: { chatLog: [] },
  };
  const listener = createBotHttpListener({
    config: { api: { port: 0 }, behaviors: {} },
    ctx,
    ensureBot: () => ctx.world.bot,
    spatial: {},
    actionRegistry: { has: () => false, get: () => null, names: () => [] },
    briefState: () => ({}),
    getFullState: () => ({}),
    buildMarksListApi: () => [],
    getInventory: () => [],
    getNearby: () => ({}),
    buildSceneSummary: () => ({}),
    summarizeSocialGraph: () => ({}),
    refreshLeaseCheckpoint: () => {},
    taskToApi: (t) => t,
    persistGoalsToDisk: () => {},
    listPresets: () => [],
    getGoalsScoreboard: () => ({ scored: [], context: {} }),
    buildObservePayload: () => ({}),
    buildTypedAlerts: () => [],
    buildLogisticsPayload: () => ({}),
    loadPreset: () => null,
    mergePresetIntoStore: () => {},
    createTaskRecord: () => ({}),
    pushTaskHistoryRecord: () => {},
    renewLease: () => {},
    createBot: () => {},
  });
  const res = mockRes();
  await listener(mockReqWithBody('POST', '/goals/update', { priority: 10 }), res);
  assert.equal(res.statusCode, 400);
  const j = JSON.parse(res.body);
  assert.equal(j.ok, false);
});

test('POST /goals: add goal increments count', async () => {
  const ctx = {
    runtime: {},
    world: { botReady: true, bot: { entity: { position: { x: 0, y: 64, z: 0 } } } },
    tasks: { actionHistory: [] },
    goals: { goalsStore: { goals: [] } },
    reactive: {},
    social: { chatLog: [] },
  };
  let persisted = false;
  const listener = createBotHttpListener({
    config: { api: { port: 0 }, behaviors: {} },
    ctx,
    ensureBot: () => ctx.world.bot,
    spatial: {},
    actionRegistry: { has: () => false, get: () => null, names: () => [] },
    briefState: () => ({}),
    getFullState: () => ({}),
    buildMarksListApi: () => [],
    getInventory: () => [],
    getNearby: () => ({}),
    buildSceneSummary: () => ({}),
    summarizeSocialGraph: () => ({}),
    refreshLeaseCheckpoint: () => {},
    taskToApi: (t) => t,
    persistGoalsToDisk: () => { persisted = true; },
    listPresets: () => [],
    getGoalsScoreboard: () => ({ scored: [], context: {} }),
    buildObservePayload: () => ({}),
    buildTypedAlerts: () => [],
    buildLogisticsPayload: () => ({}),
    loadPreset: () => null,
    mergePresetIntoStore: () => {},
    createTaskRecord: () => ({}),
    pushTaskHistoryRecord: () => {},
    renewLease: () => {},
    createBot: () => {},
  });
  const res = mockRes();
  await listener(
    mockReqWithBody('POST', '/goals', { goal: { id: 'wood', metric: 'logs_total', priority: 50 } }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(ctx.goals.goalsStore.goals.length, 1);
  assert.equal(persisted, true);
});
