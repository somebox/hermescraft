import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotHttpListener } from '../../lib/http-app.js';

/** Minimal deps so GET /health and OPTIONS succeed without a Mineflayer bot. */
function stubDeps() {
  const noop = () => {};
  return {
    config: {
      api: { port: 0 },
      mc: { username: 'TestBot', host: '127.0.0.1', port: 25565 },
    },
    ctx: {
      botReady: false,
      chatLog: [],
      overheardLog: [],
      deathLog: [],
      commandQueue: [],
      soundEvents: [],
      teamConfig: {},
      combatStats: {},
      activeFurnaces: [],
      socialGraph: {},
      socialEvents: [],
      goalsStore: { goals: [] },
      currentTask: null,
      taskHistory: [],
      actionHistory: [],
      lastApiError: null,
    },
    spatial: {
      generateMap: () => ({ map: '', legend: '', entities_on_map: [], center: null }),
      generateLookAround: () => ({ description: '', position: null }),
    },
    actionRegistry: {
      names: () => [],
      has: () => false,
      get: () => undefined,
    },
    ensureBot: () => {
      throw new Error('Bot not connected. POST /connect to retry.');
    },
    briefState: () => null,
    getFullState: () => ({ stub: true }),
    buildMarksListApi: () => [],
    getInventory: () => ({}),
    getNearby: () => ({}),
    buildSceneSummary: () => ({ summary: '' }),
    summarizeSocialGraph: () => ({}),
    refreshLeaseCheckpoint: noop,
    taskToApi: () => null,
    persistGoalsToDisk: noop,
    listPresets: () => [],
    getGoalsScoreboard: () => ({ scored: [], context: {} }),
    buildObservePayload: () => ({ ok: true }),
    buildTypedAlerts: () => [],
    buildLogisticsPayload: () => ({ ok: true }),
    loadPreset: () => null,
    mergePresetIntoStore: (s) => s,
    createTaskRecord: () => ({}),
    pushTaskHistoryRecord: noop,
    renewLease: noop,
    createBot: async () => {},
    dashboardHtmlPath: '/nonexistent-dashboard-path-for-test',
  };
}

function request(port, path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const payload =
      body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    /** @type {http.RequestOptions} */
    const opt = { hostname: '127.0.0.1', port, path, method };
    if (payload != null) {
      opt.headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      };
    }
    const req = http.request(opt, (res) => {
      let raw = '';
      res.on('data', (c) => {
        raw += c;
      });
      res.on('end', () => {
        let json = {};
        if (raw.trim()) {
          try {
            json = JSON.parse(raw);
          } catch {
            json = { _raw: raw };
          }
        }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

test('createBotHttpListener GET /health returns JSON envelope', async () => {
  const listener = createBotHttpListener(stubDeps());
  const server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const r = await request(port, '/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.username, 'TestBot');
    assert.equal(r.json.connected, false);
    assert.match(String(r.json.server || ''), /127\.0\.0\.1:25565/);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('createBotHttpListener POST unknown path returns 404 JSON', async () => {
  const listener = createBotHttpListener(stubDeps());
  const server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const r = await request(port, '/absolutely/not/a/route', 'POST', {});
    assert.equal(r.status, 404);
    assert.equal(r.json.ok, false);
    assert.match(String(r.json.error || ''), /unknown endpoint/i);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('createBotHttpListener POST /action/x with empty registry returns 400', async () => {
  const listener = createBotHttpListener(stubDeps());
  const server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const r = await request(port, '/action/chat', 'POST', {});
    assert.equal(r.status, 400);
    assert.equal(r.json.ok, false);
    assert.match(String(r.json.error || ''), /Unknown action/);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('createBotHttpListener POST invalid JSON returns 400', async () => {
  const listener = createBotHttpListener(stubDeps());
  const server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const r = await request(port, '/action/chat', 'POST', '{not json');
    assert.equal(r.status, 400);
    assert.equal(r.json.ok, false);
    assert.match(String(r.json.error || ''), /Invalid JSON/);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('createBotHttpListener OPTIONS returns CORS headers', async () => {
  const listener = createBotHttpListener(stubDeps());
  const server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/action/chat', method: 'OPTIONS' },
        (res) => resolve({ status: res.statusCode, headers: res.headers }),
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(r.status, 200);
    assert.ok(String(r.headers['access-control-allow-origin'] || '').includes('*'));
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
