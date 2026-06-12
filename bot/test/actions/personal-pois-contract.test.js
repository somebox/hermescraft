/**
 * Personal POI action contract tests.
 * ADR: docs/reference/bot/handler-contract-adr.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPersonalPoiActions } from '../../lib/actions/personal-pois.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertContract, assertFailure } from '../_helpers/action-harness.js';

function poiDeps(overrides = {}) {
  const store = {};
  const bot = overrides.bot || {
    entity: { position: { x: 1, y: 64, z: 2 } },
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    blockAt: () => ({ name: 'torch', boundingBox: 'empty' }),
  };
  const services = createMockServices({
    ensureBot: () => bot,
    config: { mc: { username: 'Flint' } },
  });
  const addPersonalPoi = (spec) => {
    store[spec.name] = { ...spec, visit_count: spec.visit_count || 0 };
    return store[spec.name];
  };
  return {
    ctx: services.state,
    config: services.config,
    ensureBot: services.ensureBot,
    posObj: () => bot.entity.position,
    loadPersonalPois: () => store,
    savePersonalPois: (next) => {
      for (const k of Object.keys(store)) delete store[k];
      Object.assign(store, next);
    },
    addPersonalPoi,
    flagPoiTorchMissing: () => {},
    clearPoiTorchMissing: () => {},
    buildPersonalPoisListApi: () =>
      Object.entries(store).map(([name, p]) => ({
        name,
        ...p,
        distance_m: 1,
        stale: false,
      })),
    services,
  };
}

test('poi_add: missing name → INVALID_ARGS # spec', async () => {
  const actions = createPersonalPoiActions(poiDeps());
  const r = await actions.poi_add({});
  assertFailure(r, { code: 'INVALID_ARGS', messageIncludes: 'name', retrySafe: false });
});

test('poi_add: ok at bot position', async () => {
  const actions = createPersonalPoiActions(poiDeps());
  const r = await actions.poi_add({ name: 'camp' });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.match(r.result, /camp/);
});

test('go_poi: unknown name → ok with message', async () => {
  const actions = createPersonalPoiActions(poiDeps());
  const r = await actions.go_poi({ name: 'missing' });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.match(r.result, /No POI/);
});

test('unpoi: removes stored POI', async () => {
  const deps = poiDeps();
  const actions = createPersonalPoiActions(deps);
  await actions.poi_add({ name: 'tmp' });
  const r = await actions.unpoi({ name: 'tmp' });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(deps.loadPersonalPois().tmp, undefined);
});

test('poi_update: missing name → INVALID_ARGS', async () => {
  const actions = createPersonalPoiActions(poiDeps());
  const r = await actions.poi_update({});
  assertFailure(r, { code: 'INVALID_ARGS', retrySafe: false });
});

test('poi_check_torch: missing POI → ok no-op message', async () => {
  const actions = createPersonalPoiActions(poiDeps());
  const r = await actions.poi_check_torch({ name: 'nope' });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.match(r.result, /No POI/);
});
