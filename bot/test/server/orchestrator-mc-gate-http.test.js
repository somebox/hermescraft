import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { createBotHttpListener } from '../../lib/server/http-app.js';

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
  const res = { statusCode: null, headers: null, body: null, ended: false };
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers;
  };
  res.end = (data) => {
    res.body = data;
    res.ended = true;
  };
  return res;
}

function makeListener(profile) {
  const ctx = {
    runtime: {
      taskContext: null,
      lastMoveFailed: null,
      lastFailedGotoTarget: null,
      recentEscapes: [],
      recentStuckCells: [],
    },
    tasks: {
      currentTask: null,
      syncActionInFlight: false,
      actionHistory: [],
    },
    world: { botReady: false, bot: null },
    social: { chatLog: [], commandQueue: [] },
    reactive: { fairPlayMode: true },
  };
  const config = {
    api: { port: 0 },
    behaviors: {},
    agent: { profile },
    mc: { username: 'TestBot' },
  };
  const dispatch = async () => ({ ok: true, status: 200, response: { ok: true } });
  return createBotHttpListener({
    config,
    ctx,
    ensureBot: () => {
      throw new Error('not used when gate denies');
    },
    spatial: {},
    actionRegistry: {
      names: () => ['tunnel'],
      has: (n) => n === 'tunnel',
      get: () => ({ handler: dispatch }),
    },
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
    getGoalsScoreboard: () => ({}),
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
}

test('POST /action/tunnel returns 403 for steward profile before dispatch', async () => {
  const listener = makeListener('steward');
  const req = mockReqWithBody('POST', '/action/tunnel', '{}');
  const res = mockRes();
  await listener(req, res);
  assert.equal(res.statusCode, 403);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /mc tunnel is denied/);
});

test('POST /action/tunnel is not steward-blocked for worker profile', async () => {
  const listener = makeListener('mason');
  const req = mockReqWithBody('POST', '/action/tunnel', '{}');
  const res = mockRes();
  await listener(req, res);
  assert.notEqual(res.statusCode, 403, `body: ${res.body}`);
});
