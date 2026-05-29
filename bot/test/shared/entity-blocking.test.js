import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isNonBlockingEntity,
  entityOccupiesCell,
  entitiesAtBlockingCell,
} from '../../lib/shared/entity-blocking.js';

test('isNonBlockingEntity: dropped item and xp orb', () => {
  assert.equal(isNonBlockingEntity({ name: 'item' }), true);
  assert.equal(isNonBlockingEntity({ name: 'experience_orb' }), true);
  assert.equal(isNonBlockingEntity({ name: 'zombie' }), false);
});

test('entitiesAtBlockingCell: item in cell is ignored, player is not', () => {
  const entities = {
    drop: { name: 'item', position: { x: 1.5, y: 64.1, z: 2.5 } },
    p: { type: 'player', username: 'A', name: 'player', position: { x: 1.5, y: 64, z: 2.5 } },
  };
  const at = entitiesAtBlockingCell(entities, 1, 64, 2);
  assert.equal(at.length, 1);
  assert.equal(at[0].username, 'A');
});

test('entityOccupiesCell: head cell match', () => {
  const e = { position: { x: 1.5, y: 63, z: 2.5 } };
  assert.equal(entityOccupiesCell(e, 1, 64, 2), true);
});
