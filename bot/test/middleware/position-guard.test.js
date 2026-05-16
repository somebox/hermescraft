/**
 * Phase 6 — position-guard middleware tests.
 *
 * F51.2 position-dependent verb guard. Four intercept/pass-through cases:
 *   1. intercept when verb is in POSITION_DEPENDENT_VERBS + lastMoveFailed set
 *      + target near failed-move target
 *   2. pass-through when verb not in the set (passives always allowed)
 *   3. pass-through when failure is >30s old (decay) — and the flag clears as
 *      a side effect
 *   4. pass-through when target is far from failed-move target
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as positionGuard from '../../lib/server/middleware/position-guard.js';
import { validate } from '../../lib/shared/action-contract.js';
import { createBotState } from '../../lib/server/state.js';

function fixtureServices(overrides = {}) {
  const state = createBotState({ behaviors: { fairPlay: true } });
  return { state, ...overrides };
}

function setFailedMove(state, target = { x: 10, y: 64, z: 5 }, reason = 'NAV_NO_PROGRESS') {
  state.runtime.lastMoveFailed = {
    ts: Date.now(),
    intended_target: target,
    actual_pos: { x: 7, y: 64, z: 5 },
    reason,
    verb: 'goto',
  };
}

test('intercept when verb is position-dependent + lastMoveFailed near target', () => {
  const services = fixtureServices();
  setFailedMove(services.state, { x: 10, y: 64, z: 5 });

  const r = positionGuard.check(services, { x: 11, y: 64, z: 5 }, 'place');
  assert.equal(r.intercept, true);
  assert.equal(r.response.ok, false);
  assert.equal(r.response.error.code, 'MOVEMENT_PRECONDITION_FAILED');
  assert.equal(r.response.error.retry_safe, false);
  assert.equal(r.response.error.observed_state.attempted_verb, 'place');
  // The result must conform to the action contract.
  const v = validate(r.response);
  assert.equal(v.valid, true, `validate() issues: ${v.issues.join('; ')}`);
});

test('pass-through when verb is not position-dependent (passives always allowed)', () => {
  const services = fixtureServices();
  setFailedMove(services.state);
  for (const passive of ['status', 'chat', 'inventory', 'scene', 'nearby', 'craft']) {
    const r = positionGuard.check(services, { x: 11, y: 64, z: 5 }, passive);
    assert.equal(r.intercept, false, `${passive} should not be intercepted`);
  }
});

test('pass-through when failure is >30s old AND mutates state to clear it', () => {
  const services = fixtureServices();
  setFailedMove(services.state);
  // Backdate the failure to >30s ago.
  services.state.runtime.lastMoveFailed.ts = Date.now() - 60_000;

  const r = positionGuard.check(services, { x: 11, y: 64, z: 5 }, 'place');
  assert.equal(r.intercept, false);
  // Side effect: stale failure cleared.
  assert.equal(services.state.runtime.lastMoveFailed, null);
});

test('pass-through when target is far from failed-move target (>5 blocks)', () => {
  const services = fixtureServices();
  setFailedMove(services.state, { x: 0, y: 64, z: 0 });
  // Target at distance ≈ 10.4 from the failed-move target.
  const r = positionGuard.check(services, { x: 10, y: 64, z: 3 }, 'place');
  assert.equal(r.intercept, false);
});

test('pass-through when there is no lastMoveFailed flag set', () => {
  const services = fixtureServices();
  // lastMoveFailed defaults to null (verified by state-slices.test.js).
  const r = positionGuard.check(services, { x: 11, y: 64, z: 5 }, 'place');
  assert.equal(r.intercept, false);
});

test('pass-through when verb is position-dependent but body has no coords', () => {
  const services = fixtureServices();
  setFailedMove(services.state);
  // place without x/y/z — the guard can't compare distance, so it lets it through.
  const r = positionGuard.check(services, { block: 'cobblestone' }, 'place');
  assert.equal(r.intercept, false);
});

test('intercept honors x1/y1/z1 coords (fill/place_fill variant)', () => {
  const services = fixtureServices();
  setFailedMove(services.state, { x: 10, y: 64, z: 5 });
  const r = positionGuard.check(services, { x1: 11, y1: 64, z1: 5 }, 'fill');
  assert.equal(r.intercept, true);
  assert.equal(r.response.error.code, 'MOVEMENT_PRECONDITION_FAILED');
});

test('POSITION_DEPENDENT_VERBS is the documented set', () => {
  const got = [...positionGuard.POSITION_DEPENDENT_VERBS].sort();
  const want = [
    'chest_search', 'deposit', 'dig', 'fence', 'fill',
    'interact', 'place', 'place_at_mark', 'safe_dig', 'stair_down',
    'stair_up', 'through', 'tunnel', 'withdraw',
  ].sort();
  assert.deepEqual(got, want);
});
