import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarksActions } from '../../lib/actions/marks.js';
import { createMockServices } from '../../lib/server/mock-services.js';

test('go_mark uses navigateToTarget when HERMES_MOVE_RESOLVE is on', async () => {
  const calls = [];
  const locs = { base_anchor: { x: 10, y: 64, z: 5, visit_count: 0 } };
  const services = createMockServices({
    ensureBot: () => ({
      entity: { position: { x: 0, y: 64, z: 0 } },
      pathfinder: { setGoal: () => {} },
    }),
    getActions: () => ({
      _navigateToTarget: async (args) => {
        calls.push(args);
        return { ok: true, result: 'ok', data: {} };
      },
    }),
  });
  services.config.behaviors.navMoveResolve = true;

  const { go_mark } = createMarksActions({
    ctx: services.state,
    config: services.config,
    ensureBot: services.ensureBot,
    goals: { GoalNear: function GoalNear() {} },
    fmt: services.utils.fmt,
    posObj: services.utils.posObj,
    sleep: services.utils.sleep,
    log: services.utils.log,
    loadLocations: () => locs,
    saveLocations: () => {},
    flagMarkStale: () => {},
    clearMarkStale: () => {},
    resolveMarkPlaceFromBody: () => null,
    resolveContainerCoords: () => ({ ix: 0, iy: 64, iz: 0 }),
    normalizeDepositWithdrawItems: (b) => b,
    buildMarksListApi: () => [],
    isContainerBlock: () => false,
    findNearbyContainer: () => null,
    snapshotChestAtPosition: () => {},
    rememberSocialEvent: () => {},
    saveReminders: () => {},
    getMyName: () => 'TestBot',
    services,
  });

  const r = await go_mark({ name: 'base_anchor' });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { x: 10, y: 64, z: 5, near: 2, mark: 'base_anchor' });
  assert.equal(r.data.via, 'navigateToTarget');
});
