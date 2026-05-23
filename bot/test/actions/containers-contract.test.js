/**
 * Containers action contract tests (refusal paths).
 * ADR: docs/design/action-contract.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createContainerActions } from '../../lib/actions/containers.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure } from '../_helpers/action-harness.js';

function containerDeps(overrides = {}) {
  const services = createMockServices();
  const bot = overrides.bot || {
    entity: { position: { x: 1.5, y: 64, z: 1.5 } },
    inventory: { items: () => [] },
    blockAt: () => ({ name: 'chest', boundingBox: 'block', position: { x: 1, y: 64, z: 1 } }),
    openContainer: async () => ({
      containerItems: () => [],
      deposit: async () => {},
      withdraw: async () => {},
      close: async () => {},
    }),
    pathfinder: { goto: async () => {} },
  };
  return {
    ctx: services.state,
    config: services.config,
    ensureBot: () => bot,
    goals: { GoalNear: function () {} },
    fmt: services.utils.fmt,
    posObj: services.utils.posObj,
    sleep: services.utils.sleep,
    log: services.utils.log,
    loadLocations: () => ({}),
    saveLocations: () => {},
    flagMarkStale: () => {},
    clearMarkStale: () => {},
    resolveMarkPlaceFromBody: () => null,
    resolveContainerCoords: overrides.resolveContainerCoords || (() => { throw new Error('need coords'); }),
    normalizeDepositWithdrawItems: (body) => {
      if (Array.isArray(body.items)) return body.items;
      if (!body.item) throw new Error('Missing item — pass item + count or an items array');
      return [{ item: String(body.item), count: Number(body.count ?? 0) }];
    },
    buildMarksListApi: () => [],
    isContainerBlock: overrides.isContainerBlock || (() => false),
    findNearbyContainer: (_b, ix, iy, iz) => ({
      name: 'chest',
      boundingBox: 'block',
      position: { x: ix, y: iy, z: iz },
    }),
    snapshotChestAtPosition: () => {},
    rememberSocialEvent: () => {},
    saveReminders: () => {},
    getMyName: () => 'TestBot',
    hasLineOfSight: () => true,
    eyePosition: () => ({ x: 0, y: 65, z: 0 }),
  };
}

test('containers.deposit: missing item in body → MISSING_ITEMS', async () => {
  const bot = {
    entity: { position: { x: 1.5, y: 64, z: 1.5 } },
    inventory: { items: () => [] },
    blockAt: () => ({ name: 'chest', boundingBox: 'block', position: { x: 1, y: 64, z: 1 } }),
    openContainer: async () => ({
      containerItems: () => [],
      deposit: async () => {},
      close: async () => {},
    }),
    pathfinder: { goto: async () => {} },
  };
  const actions = createContainerActions(containerDeps({
    resolveContainerCoords: () => ({ ix: 1, iy: 64, iz: 1 }),
    isContainerBlock: () => true,
    bot,
  }));
  const r = await actions.deposit({ count: 1 });
  assertFailure(r, { code: 'MISSING_ITEMS', retrySafe: false });
});

test('containers.withdraw: missing item in body → MISSING_ITEMS', async () => {
  const actions = createContainerActions(containerDeps({
    resolveContainerCoords: () => ({ ix: 0, iy: 64, iz: 0 }),
    isContainerBlock: () => true,
  }));
  const r = await actions.withdraw({ count: 1 });
  assertFailure(r, { code: 'MISSING_ITEMS', retrySafe: false });
});

test('containers.chest_search: missing item → MISSING_ITEM', async () => {
  const actions = createContainerActions(containerDeps({
    resolveContainerCoords: () => ({ ix: 0, iy: 64, iz: 0 }),
  }));
  const r = await actions.chest_search({});
  assertFailure(r, { code: 'MISSING_ITEM', retrySafe: false });
});
