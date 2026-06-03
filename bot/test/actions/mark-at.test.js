/**
 * Regression: mc mark with body.at saves target coords, not bot foot position.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { validate } from '../../lib/shared/action-contract.js';
import { createMarksActions } from '../../lib/actions/marks.js';

test('mark: body.at overrides bot position', async () => {
  let saved = null;
  const deps = {
    ensureBot: () => ({
      entity: { position: { x: 0.5, y: 64.5, z: 0.5 } },
      pathfinder: { goto: async () => {}, setGoal: () => {} },
    }),
    goals: { GoalNear: function GoalNear() {} },
    fmt: (n) => String(n),
    posObj: () => ({ x: 0, y: 64, z: 0 }),
    sleep: async () => {},
    log: () => {},
    loadLocations: () => ({}),
    saveLocations: (locs) => {
      saved = { ...locs };
    },
    flagMarkStale: () => {},
    clearMarkStale: () => {},
    resolveMarkPlaceFromBody: (body) => {
      if (body.at && typeof body.at === 'object') {
        return {
          x: Math.round(Number(body.at.x)),
          y: Math.round(Number(body.at.y)),
          z: Math.round(Number(body.at.z)),
        };
      }
      return null;
    },
    resolveContainerCoords: () => ({ ix: 0, iy: 64, iz: 0 }),
    normalizeDepositWithdrawItems: (b) => b,
    buildMarksListApi: () => [],
    isContainerBlock: () => false,
    findNearbyContainer: () => null,
    snapshotChestAtPosition: () => ({}),
    rememberSocialEvent: () => {},
    saveReminders: () => {},
    getMyName: () => 'testbot',
    services: {},
    config: {},
    ctx: { runtime: { navBriefNegativeLegs: {} } },
  };

  const { mark } = createMarksActions(deps);
  const r = await mark({
    name: 'lt_iron_se',
    note: 'iron at 10,64,10',
    at: { x: 10, y: 64, z: 10 },
  });
  assert.equal(r.ok, true);
  const v = validate(r);
  assert.equal(v.valid, true, v.issues?.join('; '));
  assert.ok(saved?.lt_iron_se);
  assert.deepEqual(
    { x: saved.lt_iron_se.x, y: saved.lt_iron_se.y, z: saved.lt_iron_se.z },
    { x: 10, y: 64, z: 10 },
  );
});
