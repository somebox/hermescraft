/**
 * Movement / marks navigation contract tests.
 * ADR: docs/reference/bot/handler-contract-adr.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMarksActions } from '../../lib/actions/marks.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertContract } from '../_helpers/action-harness.js';

test('go_mark: unknown mark → ok with No mark message # spec', async () => {
  const services = createMockServices({
    ensureBot: () => ({
      entity: { position: { x: 0, y: 64, z: 0 } },
      pathfinder: { setGoal: () => {} },
    }),
  });
  const { go_mark } = createMarksActions({
    ctx: services.state,
    config: services.config,
    ensureBot: services.ensureBot,
    goals: { GoalNear: function GoalNear() {} },
    fmt: services.utils.fmt,
    posObj: services.utils.posObj,
    sleep: services.utils.sleep,
    log: services.utils.log,
    loadLocations: () => ({}),
    saveLocations: () => {},
    flagMarkStale: () => {},
    clearMarkStale: () => {},
    resolveMarkPlaceFromBody: () => null,
    resolveContainerCoords: () => null,
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
  const r = await go_mark({ name: 'phantom' });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.match(r.result, /No location/i);
});
