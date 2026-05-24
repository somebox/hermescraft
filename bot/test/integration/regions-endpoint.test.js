import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotHttpListener } from '../../lib/server/http-app.js';
import { createRegionStore } from '../../lib/runtime/regions/index.js';

function stubDeps(regions) {
  const noop = () => {};
  return {
    config: {
      api: { port: 0 },
      mc: { username: 'TestBot', host: '127.0.0.1', port: 25565 },
      agent: { profile: 'TestBot', model: '', provider: '', modelsJsonPath: null },
      behaviors: { regionsEnabled: true },
    },
    ctx: {
      world: {
        botReady: true,
        bot: {
          entity: { position: { x: 0, y: 64, z: 0 } },
          username: 'TestBot',
        },
        mcData: null,
        connectPromise: null,
        positionHistory: [],
        bootTime: Date.now(),
      },
      social: { chatLog: [], overheardLog: [], commandQueue: [], socialGraph: {}, socialEvents: [], lastChatTs: 0, MAX_LOG: 100, MAX_QUEUE: 20 },
      tasks: { currentTask: null, taskHistory: [], syncActionInFlight: false, syncActionName: null, syncActionStartedAt: null, actionHistory: [], actionCounters: { window_ms: 300000, events: [] }, lastApiError: null, MAX_ACTION_HISTORY: 24, MAX_TASK_HISTORY: 50 },
      runtime: { lastMoveFailed: null, recentPlaceFailures: [], recentEscapes: [], recentStuckCells: [], recentDigFailures: [], regions, recentPickups: [], soundEvents: [] },
      goals: { goalsStore: { goals: [] }, chestSnapshots: {} },
      team: { teamConfig: {}, combatStats: {}, activeFurnaces: [], isSneaking: false, recentDamagers: {} },
      reminders: { reminders: [], remindersNextId: 1 },
      death: { deathLog: [], lastDeath: null, hardcoreDead: false, lastDamageEvent: null, lastHealth: 20, reconnectAttempts: 0, suppressEndReconnect: false },
      reactive: { fairPlayMode: true, mode: null, autoActionLog: [] },
    },
    spatial: { generateMap: () => ({}), generateLookAround: () => ({}) },
    actionRegistry: { names: () => [], has: () => false, get: () => undefined },
    ensureBot: () => {},
    briefState: () => null,
    getFullState: () => ({}),
    buildMarksListApi: () => [],
    getInventory: () => ({}),
    getNearby: () => ({}),
    buildSceneSummary: () => ({}),
    summarizeSocialGraph: () => ({}),
    refreshLeaseCheckpoint: noop,
    dispatchActionProxy: noop,
    log: noop,
  };
}

test('GET /regions returns registry rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-reg-endpoint-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({
    id: 'mine1',
    profile: 'mine',
    status: 'unanchored',
    anchor: { x: 0, y: 64, z: 0 },
    shape: { kind: 'column', radius: 12 },
  });
  const listener = createBotHttpListener(stubDeps(store));
  const server = http.createServer(listener);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/regions`);
  const body = await res.json();
  server.close();
  assert.equal(body.ok, true);
  assert.equal(body.data.regions.length, 1);
  assert.equal(body.data.regions[0].id, 'mine1');
});
