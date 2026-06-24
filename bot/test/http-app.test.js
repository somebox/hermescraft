import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { parseBody, createBotHttpListener } from '../lib/server/http-app.js';
import { setConstructContext } from '../lib/runtime/construct-context.js';

function mockReq(chunks) {
  const req = new EventEmitter();
  queueMicrotask(async () => {
    for (const c of chunks) {
      req.emit('data', typeof c === 'string' ? Buffer.from(c) : c);
    }
    req.emit('end');
  });
  return req;
}

test('parseBody parses JSON object', async () => {
  const req = mockReq(['{"a":1}']);
  const body = await parseBody(req);
  assert.deepEqual(body, { a: 1 });
});

test('parseBody rejects invalid JSON', async () => {
  const req = mockReq(['{not json']);
  await assert.rejects(parseBody(req), /Invalid JSON body/);
});

// ─────────────────────────────────────────────────────────────────────────
// Mixed-method routing — /task-context exposes GET/POST/DELETE on one path.
//
// 2026-05-27 regression: the handler had been wrapped inside the
// `if (req.method === 'GET')` branch of the request dispatcher, so
// non-GET requests fell through to the catch-all 404. Mason's
// `mc task_context set hut1` (POST) hit "Unknown endpoint: /task-context"
// and blocked his entire hut1 build card. These tests pin the handler
// at top-level so the regression can't recur silently.
// ─────────────────────────────────────────────────────────────────────────

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
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; };
  res.end = (data) => { res.body = data; res.ended = true; };
  return res;
}

function makeListenerWithTaskContext() {
  // Minimal deps bag — only fields the /task-context handler reaches.
  const ctx = { runtime: { taskContext: null } };
  const config = { api: { port: 0 }, behaviors: {} };
  const listener = createBotHttpListener({
    config, ctx,
    ensureBot: () => { throw new Error('not used by /task-context'); },
    // Stub the rest so listener construction doesn't crash on missing keys.
    spatial: {}, actionRegistry: { has: () => false, get: () => null, names: () => [] },
    briefState: () => ({}), getFullState: () => ({}), buildMarksListApi: () => [],
    getInventory: () => [], getNearby: () => ({}), buildSceneSummary: () => ({}),
    summarizeSocialGraph: () => ({}), refreshLeaseCheckpoint: () => {},
    taskToApi: (t) => t, persistGoalsToDisk: () => {}, listPresets: () => [],
    getGoalsScoreboard: () => ({}), buildObservePayload: () => ({}),
    buildTypedAlerts: () => [], buildLogisticsPayload: () => ({}),
    loadPreset: () => null, mergePresetIntoStore: () => {},
    createTaskRecord: () => ({}), pushTaskHistoryRecord: () => {},
    renewLease: () => {}, createBot: () => {},
  });
  return { listener, ctx };
}

test('POST /task-context sets the grant (the 2026-05-27 regression)', async () => {
  const { listener, ctx } = makeListenerWithTaskContext();
  const req = mockReqWithBody('POST', '/task-context',
    JSON.stringify({ card_id: 't_test', worksite_region: 'hut1', source: 'test' }));
  const res = mockRes();
  await listener(req, res);
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.data.task_context.card_id, 't_test');
  assert.equal(body.data.task_context.worksite_region, 'hut1');
  assert.equal(ctx.runtime.taskContext.card_id, 't_test');
});

test('GET /task-context reads the current grant', async () => {
  const { listener, ctx } = makeListenerWithTaskContext();
  ctx.runtime.taskContext = { card_id: 't_xyz', worksite_region: 'base', expires_at: 1, source: 'fixture' };
  const req = mockReqWithBody('GET', '/task-context', null);
  const res = mockRes();
  await listener(req, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.data.task_context.card_id, 't_xyz');
});

test('DELETE /task-context clears the grant', async () => {
  const { listener, ctx } = makeListenerWithTaskContext();
  ctx.runtime.taskContext = { card_id: 't_xyz', worksite_region: 'base', expires_at: 1, source: 'fixture' };
  const req = mockReqWithBody('DELETE', '/task-context', null);
  const res = mockRes();
  await listener(req, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.data.cleared, true);
  assert.equal(ctx.runtime.taskContext, null);
});

test('DELETE /task-context clears construct session (F2 lifecycle)', async () => {
  const prev = process.env.HERMES_CONSTRUCT_CONTEXT;
  process.env.HERMES_CONSTRUCT_CONTEXT = '1';
  try {
    const { listener, ctx } = makeListenerWithTaskContext();
    ctx.runtime.taskContext = { card_id: 't_xyz', worksite_region: 'base', expires_at: Date.now() + 99999, source: 'fixture' };
    setConstructContext(ctx, {
      kind: 'construct',
      plan_id: 'starter_shelter',
      mutation_policy: ['missing'],
    });
    ctx.runtime._constructWorkset = new Map([['1,1,1', { category: 'missing' }]]);
    const req = mockReqWithBody('DELETE', '/task-context', null);
    const res = mockRes();
    await listener(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(ctx.runtime.taskContext, null);
    assert.equal(ctx.runtime.construct_context, null);
    assert.equal(ctx.runtime._constructWorkset, undefined);
  } finally {
    if (prev === undefined) delete process.env.HERMES_CONSTRUCT_CONTEXT;
    else process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});

test('GET /task-context exposes construct_complete_blocked when session active', async () => {
  const prev = process.env.HERMES_CONSTRUCT_CONTEXT;
  process.env.HERMES_CONSTRUCT_CONTEXT = '1';
  try {
    const { listener, ctx } = makeListenerWithTaskContext();
    ctx.runtime.taskContext = { card_id: 't_xyz', worksite_region: 'base', expires_at: Date.now() + 99999, source: 'fixture' };
    setConstructContext(ctx, {
      kind: 'construct',
      plan_id: 'starter_shelter',
      mutation_policy: ['missing'],
    });
    const req = mockReqWithBody('GET', '/task-context', null);
    const res = mockRes();
    await listener(req, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.construct_complete_blocked?.code, 'CONSTRUCT_SESSION_ACTIVE');
  } finally {
    if (prev === undefined) delete process.env.HERMES_CONSTRUCT_CONTEXT;
    else process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});

test('POST /task-context with missing card_id returns 400 (not 404)', async () => {
  const { listener } = makeListenerWithTaskContext();
  const req = mockReqWithBody('POST', '/task-context', '{}');
  const res = mockRes();
  await listener(req, res);
  // Pre-fix this would have returned 404 "Unknown endpoint"; post-fix the
  // handler is reached and validates body shape, returning 400.
  assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
  const body = JSON.parse(res.body);
  assert.equal(body.error.code, 'MISSING_CARD_ID');
});

test('POST /task-context CONSTRUCT grant returns FEATURE_DISABLED auto-begin when env off', async () => {
  const prev = process.env.HERMES_CONSTRUCT_CONTEXT;
  delete process.env.HERMES_CONSTRUCT_CONTEXT;
  try {
    const { listener } = makeListenerWithTaskContext();
    const req = mockReqWithBody('POST', '/task-context',
      JSON.stringify({
        card_id: 't_construct_off',
        worksite_region: 'base',
        plan: 'starter_shelter',
        level: 1,
        card_kind: 'CONSTRUCT',
        source: 'test',
      }));
    const res = mockRes();
    await listener(req, res);
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);
    const auto = body.data.construct_auto_begin;
    assert.ok(auto);
    assert.equal(auto.ok, false);
    assert.equal(auto.error.code, 'FEATURE_DISABLED');
  } finally {
    if (prev !== undefined) process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});

test('POST /task-context with construct_auto_begin false omits auto-begin payload', async () => {
  const prev = process.env.HERMES_CONSTRUCT_CONTEXT;
  process.env.HERMES_CONSTRUCT_CONTEXT = '1';
  try {
    const { listener } = makeListenerWithTaskContext();
    const req = mockReqWithBody('POST', '/task-context',
      JSON.stringify({
        card_id: 't_no_auto',
        worksite_region: 'base',
        plan: 'starter_shelter',
        level: 1,
        card_kind: 'CONSTRUCT',
        construct_auto_begin: false,
        source: 'test',
      }));
    const res = mockRes();
    await listener(req, res);
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);
    assert.equal(body.data.construct_auto_begin, undefined);
  } finally {
    if (prev === undefined) delete process.env.HERMES_CONSTRUCT_CONTEXT;
    else process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});

test('POST /task-context new card_id clears construct session (F2 lifecycle)', async () => {
  const prev = process.env.HERMES_CONSTRUCT_CONTEXT;
  process.env.HERMES_CONSTRUCT_CONTEXT = '1';
  try {
    const { listener, ctx } = makeListenerWithTaskContext();
    ctx.runtime.taskContext = {
      card_id: 't_old',
      worksite_region: 'base',
      expires_at: Date.now() + 99999,
      source: 'fixture',
    };
    setConstructContext(ctx, {
      kind: 'construct',
      plan_id: 'starter_shelter',
      card_id: 't_old',
      mutation_policy: ['missing'],
    });
    const req = mockReqWithBody('POST', '/task-context',
      JSON.stringify({ card_id: 't_new', worksite_region: 'base', source: 'test' }));
    const res = mockRes();
    await listener(req, res);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(ctx.runtime.construct_context, null);
    assert.equal(ctx.runtime.taskContext.card_id, 't_new');
  } finally {
    if (prev === undefined) delete process.env.HERMES_CONSTRUCT_CONTEXT;
    else process.env.HERMES_CONSTRUCT_CONTEXT = prev;
  }
});

test('POST /regions/reload calls store.reload() and returns the updated region list', async () => {
  // Tracks: did the handler actually call reload() on the store?
  let reloadCalled = 0;
  const fakeStore = {
    world: 'testworld',
    reload() { reloadCalled++; },
    list() {
      return [
        { id: 'base', intent: 'protect', profile: 'base',
          capabilities: { allow_ad_hoc_dig: false, allow_ad_hoc_place: false } },
        { id: 'hut1', intent: 'protect', profile: 'base',
          capabilities: { allow_ad_hoc_dig: true, allow_ad_hoc_place: true } },
      ];
    },
  };
  const ctx = { runtime: { taskContext: null, regions: fakeStore } };
  const config = { api: { port: 0 }, behaviors: {} };
  const listener = createBotHttpListener({
    config, ctx,
    ensureBot: () => ({ entity: { position: { x: 0, y: 0, z: 0 } } }),
    spatial: {}, actionRegistry: { has: () => false, get: () => null, names: () => [] },
    briefState: () => ({}), getFullState: () => ({}), buildMarksListApi: () => [],
    getInventory: () => [], getNearby: () => ({}), buildSceneSummary: () => ({}),
    summarizeSocialGraph: () => ({}), refreshLeaseCheckpoint: () => {},
    taskToApi: (t) => t, persistGoalsToDisk: () => {}, listPresets: () => [],
    getGoalsScoreboard: () => ({}), buildObservePayload: () => ({}),
    buildTypedAlerts: () => [], buildLogisticsPayload: () => ({}),
    loadPreset: () => null, mergePresetIntoStore: () => {},
    createTaskRecord: () => ({}), pushTaskHistoryRecord: () => {},
    renewLease: () => {}, createBot: () => {},
  });

  const req = mockReqWithBody('POST', '/regions/reload', '{}');
  const res = mockRes();
  await listener(req, res);
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
  assert.equal(reloadCalled, 1, 'store.reload() should fire exactly once');
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.data.world, 'testworld');
  assert.equal(body.data.region_count, 2);
  assert.equal(body.data.regions[1].id, 'hut1');
  assert.equal(body.data.regions[1].capabilities.allow_ad_hoc_dig, true);
});
