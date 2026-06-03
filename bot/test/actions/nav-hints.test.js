import test from 'node:test';
import assert from 'node:assert/strict';
import { navBlockedNextActionHint, withNavRetryWarning } from '../../lib/actions/movement/nav-hints.js';

test('navBlockedNextActionHint: downward target suggests tunnel/stair_down', () => {
  const b = { entity: { position: { x: 0, y: 70, z: 0 }, isInWater: false } };
  const hint = navBlockedNextActionHint(b, { x: 10, y: 60, z: 10 }, { x: 0, y: 70, z: 0 });
  assert.match(hint, /tunnel|stair_down/i);
});

test('navBlockedNextActionHint: in water suggests escape', () => {
  const b = { entity: { position: { x: 0, y: 64, z: 0 }, isInWater: true } };
  assert.equal(navBlockedNextActionHint(b, { x: 5, y: 64, z: 5 }, { x: 0, y: 64, z: 0 }, { inWater: true }), 'mc escape');
});

test('withNavRetryWarning: adds warning on 3rd consecutive failure', () => {
  const counts = new Map([['move@1,64,2', { count: 3, lastReason: 'no_door' }]]);
  const base = {
    ok: false,
    error: {
      code: 'NAV_BLOCKED',
      message: 'blocked',
      next_action_hint: 'mc dig_area',
      retry_safe: false,
    },
  };
  const out = withNavRetryWarning(base, 'move@1,64,2', counts, 4);
  assert.equal(out.error.observed_state.consecutive_failures, 3);
  assert.match(out.error.next_action_hint, /3rd consecutive/i);
});

test('withNavRetryWarning: unchanged when count is not 3', () => {
  const counts = new Map([['move@1,64,2', { count: 2, lastReason: 'x' }]]);
  const base = { ok: false, error: { code: 'NAV_BLOCKED', message: 'x', retry_safe: false } };
  assert.deepEqual(withNavRetryWarning(base, 'move@1,64,2', counts), base);
});
