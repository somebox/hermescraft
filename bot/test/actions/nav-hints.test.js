import test from 'node:test';
import assert from 'node:assert/strict';
import { navBlockedNextActionHint, withNavRetryWarning, describePathfinderError, protectRegionNavHint, isDestructiveNavHint, navTargetUnstandableNextActionHint } from '../../lib/actions/movement/nav-hints.js';

test('describePathfinderError maps recorded tokens to readable reasons', () => {
  assert.match(describePathfinderError('no_progress:4200ms'), /stalled.*4200ms/);
  assert.match(describePathfinderError('no_progress:?ms'), /stalled/);
  assert.match(describePathfinderError('timeout'), /time cap.*no route/);
  assert.match(describePathfinderError('No path to the goal!'), /searched and found no route/);
  // Unrecognized mineflayer messages pass through verbatim.
  assert.equal(describePathfinderError('GoalChanged'), 'GoalChanged');
  assert.equal(describePathfinderError(null), null);
  assert.equal(describePathfinderError(''), null);
});

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

test('navBlockedNextActionHint: non-standable target prefers reachable + goto_near', () => {
  const b = { entity: { position: { x: 0, y: 64, z: 0 }, isInWater: false } };
  const hint = navBlockedNextActionHint(
    b,
    { x: 4, y: 77, z: 26 },
    { x: 0, y: 64, z: 0 },
    {
      observedState: {
        target_standable: false,
        closest_standable: { x: 4, y: 76, z: 26, distance: 1 },
      },
    },
  );
  assert.match(hint, /mc reachable/);
  assert.match(hint, /mc goto_near 4 76 26/);
});

test('navBlockedNextActionHint: standable small dy prefers mc move over dig fallback', () => {
  const b = { entity: { position: { x: 0, y: 64, z: 0 }, isInWater: false }, blockAt: () => ({ name: 'air', boundingBox: 'empty' }) };
  const hint = navBlockedNextActionHint(
    b,
    { x: 3, y: 65, z: 2 },
    { x: 0, y: 64, z: 0 },
    { observedState: { target_standable: true } },
  );
  assert.match(hint, /^mc move 3 65 2/);
});

test('protectRegionNavHint avoids destructive fallback copy', () => {
  const hint = protectRegionNavHint(
    { nav_in_protect_region: true, target_standable: true, region_nav_exit_hint: 'mc go_site :base1:/gate' },
    { x: 1, y: 64, z: 1 },
    1,
    64,
    1,
    0,
  );
  assert.match(hint, /^mc move 1 64 1/);
});

test('isDestructiveNavHint identifies sculpt strings', () => {
  assert.equal(isDestructiveNavHint('mc dig_area to clear terrain'), true);
  assert.equal(isDestructiveNavHint('mc goto_near 1 2 3 range=1'), false);
});

test('navTargetUnstandableNextActionHint suggests reachable or goto_near', () => {
  const b = { entity: { position: { x: 0, y: 64, z: 0 } }, blockAt: () => ({ name: 'stone', boundingBox: 'block' }) };
  const hint = navTargetUnstandableNextActionHint(b, 5, 64, 5, {
    closest_standable: { x: 5, y: 63, z: 5 },
  });
  assert.match(hint, /mc goto_near 5 63 5/);
});

test('navTargetUnstandableNextActionHint: inside a protect region never suggests mc dig', () => {
  const b = { entity: { position: { x: 0, y: 64, z: 0 } }, blockAt: () => ({ name: 'stone', boundingBox: 'block' }) };
  // No closest_standable + in a protect region → must NOT recommend digging the
  // (protected) target; prefer a policy check or the region exit.
  const hint = navTargetUnstandableNextActionHint(b, 5, 64, 5, { nav_in_protect_region: true });
  assert.doesNotMatch(hint, /or mc dig to clear/);
  assert.match(hint, /check dig|go_site|protect region/);
  // Prefers an explicit region exit hint when one is available.
  const withExit = navTargetUnstandableNextActionHint(b, 5, 64, 5, {
    nav_in_protect_region: true,
    region_nav_exit_hint: 'mc go_site :base1:/gate   # leave protect region first',
  });
  assert.match(withExit, /go_site :base1:\/gate/);
  // Regression: outside a protect region the dig fallback is unchanged.
  assert.match(navTargetUnstandableNextActionHint(b, 5, 64, 5, {}), /or mc dig to clear/);
});
