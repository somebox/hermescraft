/**
 * F53.2 — place-repeat-guard middleware tests.
 *
 * check() is pre-action: returns intercept on 3rd identical failure within
 * 30s, otherwise pass-through (and applies decay as a side effect).
 *
 * recordOutcome() is post-action: pushes into recentPlaceFailures on
 * soft-failure result; clears matching entries on success.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as placeRepeatGuard from '../../lib/server/middleware/place-repeat-guard.js';
import { validate, fail, ok } from '../../lib/shared/action-contract.js';
import { createBotState } from '../../lib/server/state.js';

function fixture() {
  const state = createBotState({ behaviors: { fairPlay: true } });
  const mockBot = {
    blockAt: () => ({ name: 'air' }),
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 0 } },
    heldItem: { name: 'cobblestone' },
  };
  return {
    state,
    services: {
      state,
      ensureBot: () => mockBot,
    },
    mockBot,
  };
}

function pushFailure(state, target, block, n = 1, ageMs = 0) {
  for (let i = 0; i < n; i++) {
    state.runtime.recentPlaceFailures.push({
      ts: Date.now() - ageMs,
      target,
      block,
      error_code: 'NO_SOLID_NEIGHBOR',
    });
  }
}

test('check pass-through when actionName is not "place"', () => {
  const { services } = fixture();
  const r = placeRepeatGuard.check(services, { x: 0, y: 64, z: 0, block: 'cobblestone' }, 'dig');
  assert.equal(r.intercept, false);
});

test('check pass-through when fewer than 2 prior identical failures', () => {
  const { services, state } = fixture();
  pushFailure(state, { x: 1, y: 64, z: 1 }, 'cobblestone', 1);
  const r = placeRepeatGuard.check(services, { x: 1, y: 64, z: 1, block: 'cobblestone' }, 'place');
  assert.equal(r.intercept, false);
});

test('check intercepts on the 3rd identical failed place (contract-validated)', () => {
  const { services, state } = fixture();
  pushFailure(state, { x: 1, y: 64, z: 1 }, 'cobblestone', 2);
  const r = placeRepeatGuard.check(services, { x: 1, y: 64, z: 1, block: 'cobblestone' }, 'place');
  assert.equal(r.intercept, true);
  assert.equal(r.response.error.code, 'PLACEMENT_REPEATED_FAILURE');
  assert.equal(r.response.error.observed_state.attempted_block, 'cobblestone');
  const v = validate(r.response);
  assert.equal(v.valid, true, `validate issues: ${v.issues.join('; ')}`);
});

test('check applies 30s decay before counting failures', () => {
  const { services, state } = fixture();
  pushFailure(state, { x: 1, y: 64, z: 1 }, 'cobblestone', 2, 60_000); // 60s old
  const r = placeRepeatGuard.check(services, { x: 1, y: 64, z: 1, block: 'cobblestone' }, 'place');
  assert.equal(r.intercept, false);
  // Side effect: stale entries cleared.
  assert.equal(state.runtime.recentPlaceFailures.length, 0);
});

test('check suggested action reflects block-already-present case', () => {
  const { services, state, mockBot } = fixture();
  mockBot.blockAt = () => ({ name: 'cobblestone' }); // target already has the block
  pushFailure(state, { x: 1, y: 64, z: 1 }, 'cobblestone', 2);
  const r = placeRepeatGuard.check(services, { x: 1, y: 64, z: 1, block: 'cobblestone' }, 'place');
  assert.match(r.response.error.message, /already at|placement is complete/i);
});

test('check suggested action reflects wrong-block-equipped case', () => {
  const { services, state, mockBot } = fixture();
  mockBot.heldItem = { name: 'dirt' };
  pushFailure(state, { x: 1, y: 64, z: 1 }, 'cobblestone', 2);
  const r = placeRepeatGuard.check(services, { x: 1, y: 64, z: 1, block: 'cobblestone' }, 'place');
  assert.match(r.response.error.message, /holding dirt.*equip cobblestone/i);
});

test('recordOutcome pushes failure on soft-fail result', () => {
  const { services, state } = fixture();
  const result = fail('NO_SOLID_NEIGHBOR', 'no neighbor', { retry_safe: false });
  placeRepeatGuard.recordOutcome(services, { x: 2, y: 64, z: 2, block: 'oak_planks' }, 'place', result);
  assert.equal(state.runtime.recentPlaceFailures.length, 1);
  assert.equal(state.runtime.recentPlaceFailures[0].block, 'oak_planks');
  assert.equal(state.runtime.recentPlaceFailures[0].error_code, 'NO_SOLID_NEIGHBOR');
});

test('recordOutcome clears matching entries on success', () => {
  const { services, state } = fixture();
  pushFailure(state, { x: 3, y: 64, z: 3 }, 'cobblestone', 2);
  pushFailure(state, { x: 5, y: 64, z: 5 }, 'cobblestone', 1); // a different target
  placeRepeatGuard.recordOutcome(services, { x: 3, y: 64, z: 3, block: 'cobblestone' }, 'place', ok());
  // The 2 entries for (3,64,3) cleared; the (5,64,5) one remains.
  assert.equal(state.runtime.recentPlaceFailures.length, 1);
  assert.equal(state.runtime.recentPlaceFailures[0].target.x, 5);
});

test('recordOutcome no-op when actionName is not "place"', () => {
  const { services, state } = fixture();
  placeRepeatGuard.recordOutcome(services, { x: 1, y: 64, z: 1, block: 'x' }, 'dig', fail('X', 'y'));
  assert.equal(state.runtime.recentPlaceFailures.length, 0);
});

test('recordOutcome ring buffer caps at 8 entries', () => {
  const { services, state } = fixture();
  for (let i = 0; i < 12; i++) {
    placeRepeatGuard.recordOutcome(
      services,
      { x: i, y: 64, z: 0, block: 'x' },
      'place',
      fail('CODE', 'm'),
    );
  }
  assert.equal(state.runtime.recentPlaceFailures.length, 8);
  // The earliest entries were shifted out; the most recent is at i=11.
  assert.equal(state.runtime.recentPlaceFailures[7].target.x, 11);
});
