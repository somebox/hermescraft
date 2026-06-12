/**
 * GET perceive route envelope smoke tests.
 * ADR: docs/reference/bot/handler-contract-adr.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { createBotHttpListener } from '../lib/server/http-app.js';

function mockReq(method, urlPath) {
  const req = new EventEmitter();
  req.method = method;
  req.url = urlPath;
  queueMicrotask(() => req.emit('end'));
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

function baseListener(overrides = {}) {
  const ctx = {
    runtime: { regions: null, taskContext: null },
    world: { botReady: false },
    tasks: { lastApiError: null, currentTask: null, actionHistory: [] },
    goals: { goalsStore: { goals: [] } },
    reactive: {},
    social: { chatLog: [] },
  };
  return createBotHttpListener({
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
    buildObservePayload: () => ({ ok: true, goals: [] }),
    buildTypedAlerts: () => [{ type: 'test', message: 'ok' }],
    buildLogisticsPayload: () => ({ ok: true, inventory: {}, goals_deficits: [], chest_snapshots: {}, marks: {} }),
    loadPreset: () => null,
    mergePresetIntoStore: () => {},
    createTaskRecord: () => ({}),
    pushTaskHistoryRecord: () => {},
    renewLease: () => {},
    createBot: () => {},
    ...overrides,
  });
}

test('GET /alerts returns ok envelope with alerts array # spec', async () => {
  const listener = baseListener();
  const res = mockRes();
  await listener(mockReq('GET', '/alerts'), res);
  assert.equal(res.statusCode, 200);
  const j = JSON.parse(res.body);
  assert.equal(j.ok, true);
  assert.ok(Array.isArray(j.data.alerts));
});

test('GET /logistics returns ok envelope', async () => {
  const listener = baseListener();
  const res = mockRes();
  await listener(mockReq('GET', '/logistics'), res);
  assert.equal(res.statusCode, 200);
  const j = JSON.parse(res.body);
  assert.equal(j.ok, true);
  assert.ok('inventory' in j);
});
