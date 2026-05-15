import test from 'node:test';
import assert from 'node:assert/strict';
import { FAIR_PLAY } from '../lib/runtime/fair-play-constants.js';

test('FAIR_PLAY exposes bounded numeric tunables', () => {
  assert.equal(typeof FAIR_PLAY.LOS_ENTITY_RANGE, 'number');
  assert.ok(FAIR_PLAY.LOS_ENTITY_RANGE > FAIR_PLAY.SNEAK_DETECT_RANGE);
  assert.ok(FAIR_PLAY.REACTION_MAX_MS >= FAIR_PLAY.REACTION_MIN_MS);
});
