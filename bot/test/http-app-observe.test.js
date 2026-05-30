import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { createBotHttpListener } from '../lib/server/http-app.js';

function mockReqWithBody(method, urlPath, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = urlPath;
  queueMicrotask(() => {
    if (body) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

function mockRes() {
  const res = {
    statusCode: 0,
    body: '',
    headers: {},
    setHeader() {},
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk) {
      this.body += chunk;
    },
  };
  return res;
}

test('GET /observe returns buildObservePayload result (not empty stub)', async () => {
  const payload = {
    ok: true,
    nav_mode: 'open',
    nav_frame: { nav_mode: 'open' },
    goals: [],
  };
  const ctx = {
    runtime: { regions: null, taskContext: null },
    world: { botReady: false },
    tasks: { lastApiError: null, currentTask: null, actionHistory: [] },
    goals: { goalsStore: { goals: [] } },
    reactive: {},
    social: { chatLog: [] },
  };
  const listener = createBotHttpListener({
    config: { api: { port: 0 }, behaviors: {} },
    ctx,
    ensureBot: () => ({ entity: { position: { x: 0, y: 64, z: 0 } } }),
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
    buildObservePayload: () => payload,
    buildTypedAlerts: () => [],
    buildLogisticsPayload: () => ({}),
    loadPreset: () => null,
    mergePresetIntoStore: () => {},
    createTaskRecord: () => ({}),
    pushTaskHistoryRecord: () => {},
    renewLease: () => {},
    createBot: () => {},
  });

  const req = mockReqWithBody('GET', '/observe?lean=true', null);
  const res = mockRes();
  await listener(req, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.nav_mode, 'open');
  assert.ok(body.nav_frame);
});
