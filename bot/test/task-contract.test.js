/**
 * Task checkpoint HTTP route contract.
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

test('POST /task/checkpoint-respond: no running task → ok with explanatory result # spec', async () => {
  const ctx = {
    runtime: {},
    world: { botReady: true, bot: { entity: { position: { x: 0, y: 64, z: 0 } } } },
    tasks: { currentTask: null, actionHistory: [] },
    goals: { goalsStore: { goals: [] } },
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
    buildLogisticsPayload: () => ({ ok: true, inventory: {} }),
    loadPreset: () => null,
    mergePresetIntoStore: () => {},
    createTaskRecord: () => ({}),
    pushTaskHistoryRecord: () => {},
    renewLease: () => {},
    createBot: () => {},
  });
  const res = mockRes();
  await listener(
    mockReqWithBody('POST', '/task/checkpoint-respond', { decision: 'continue', lease_seconds: 45 }),
    res,
  );
  const j = JSON.parse(res.body);
  assert.equal(j.ok, true);
  assert.match(j.result, /No running task/i);
});
