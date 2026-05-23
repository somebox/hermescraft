import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AIR_NAMES, isAirBlock, isBoatEntity, isWaterBlock, BOAT_ITEM_NAMES,
} from '../../lib/actions/_block-sets.js';

test('isAirBlock recognizes air variants', () => {
  assert.equal(isAirBlock({ name: 'air' }), true);
  assert.equal(isAirBlock({ name: 'stone' }), false);
});

test('isWaterBlock', () => {
  assert.equal(isWaterBlock({ name: 'water' }), true);
  assert.equal(isWaterBlock({ name: 'flowing_water' }), true);
});

test('isBoatEntity Paper 1.21 type-only', () => {
  assert.equal(isBoatEntity({ name: null, type: 'oak_boat' }), true);
  assert.equal(isBoatEntity({ name: 'oak_boat' }), true);
});

test('BOAT_ITEM_NAMES includes oak_boat', () => {
  assert.ok(BOAT_ITEM_NAMES.has('oak_boat'));
  assert.ok(AIR_NAMES.has('cave_air'));
});
