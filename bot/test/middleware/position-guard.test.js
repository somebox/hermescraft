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

// ─────────────────────────────────────────────────────────────────────────
// Position-drift invalidation. Pre-fix: BOT_ON_PILLAR refusal recommended
// `mc pillar_down`, the bot dropped 2 blocks, and the next `mc dig` was
// still rejected because the lmf record's actual_pos didn't match where
// the bot actually was. Mason hit this 2026-05-27 04:14: pillar_down at
// (333,66,-575) → bot at (333.5, 64, -574.5) → mc dig blocked by stale
// (333.6, 66, -575.5). The agent burned cycles calling mc status just
// to clear the flag.
// ─────────────────────────────────────────────────────────────────────────

function botAt(x, y, z) {
  return { entity: { position: { x, y, z } } };
}

test('clears stale lmf when bot has drifted >1.5 blocks (e.g. after pillar_down)', () => {
  const services = fixtureServices();
  setFailedMove(services.state, { x: 334, y: 66, z: -574 });
  // Lmf records bot at (7, 64, 5); simulate bot has fallen / been
  // displaced to (7, 60, 5) — 4 blocks down, well past the threshold.
  services.ensureBot = () => botAt(7, 60, 5);

  const r = positionGuard.check(services, { x: 335, y: 65, z: -574 }, 'dig');
  assert.equal(r.intercept, false, 'guard should pass through after drift');
  assert.equal(services.state.runtime.lastMoveFailed, null, 'flag should be cleared');
});

test('keeps lmf when bot has barely moved (<1.5 blocks — just settling)', () => {
  const services = fixtureServices();
  setFailedMove(services.state, { x: 10, y: 64, z: 5 });
  // Bot drifted 0.3 blocks (within stored 7,64,5 ± a tick of physics).
  services.ensureBot = () => botAt(7.2, 64, 5.1);

  const r = positionGuard.check(services, { x: 11, y: 64, z: 5 }, 'place');
  assert.equal(r.intercept, true, 'small drift should not clear lmf');
  assert.equal(r.response.error.code, 'MOVEMENT_PRECONDITION_FAILED');
});

test('ensureBot throwing does not crash the guard (bot dead / not ready)', () => {
  const services = fixtureServices();
  setFailedMove(services.state, { x: 10, y: 64, z: 5 });
  services.ensureBot = () => { throw new Error('Bot dead — respawn in progress'); };

  const r = positionGuard.check(services, { x: 11, y: 64, z: 5 }, 'place');
  // Falls through to normal radius check — should still intercept.
  assert.equal(r.intercept, true);
  assert.equal(r.response.error.code, 'MOVEMENT_PRECONDITION_FAILED');
});

test('drift check is a no-op when services has no ensureBot (legacy callers)', () => {
  const services = fixtureServices(); // no ensureBot
  setFailedMove(services.state, { x: 10, y: 64, z: 5 });

  const r = positionGuard.check(services, { x: 11, y: 64, z: 5 }, 'place');
  assert.equal(r.intercept, true, 'still intercepts via radius when drift cannot be measured');
});

test('drift check is a no-op when lmf has no actual_pos', () => {
  const services = fixtureServices();
  services.state.runtime.lastMoveFailed = {
    ts: Date.now(),
    intended_target: { x: 10, y: 64, z: 5 },
    actual_pos: null,
    reason: 'NAV_NO_PROGRESS',
    verb: 'goto',
  };
  // Provide an ensureBot that would otherwise trigger the drift clear —
  // but since actual_pos is null, the drift branch should not run.
  services.ensureBot = () => botAt(100, 200, 300);

  const r = positionGuard.check(services, { x: 11, y: 64, z: 5 }, 'place');
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
