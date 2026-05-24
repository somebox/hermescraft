import test from 'node:test';
import assert from 'node:assert/strict';
import { containsPoint, regionsAt } from '../../../lib/runtime/regions/resolver.js';

test('column containment respects Y bounds', () => {
  const shape = { kind: 'column', radius: 8, y_min: 60, y_max: 80 };
  const anchor = { x: 0, y: 64, z: 0 };
  assert.ok(containsPoint(shape, anchor, 3, 70, 3));
  assert.ok(!containsPoint(shape, anchor, 3, 40, 3));
  assert.ok(!containsPoint(shape, anchor, 20, 70, 0));
});

test('sphere containment', () => {
  const shape = { kind: 'sphere', radius: 5 };
  const anchor = { x: 0, y: 64, z: 0 };
  assert.ok(containsPoint(shape, anchor, 0, 64, 4));
  assert.ok(!containsPoint(shape, anchor, 0, 64, 6));
});

test('regionsAt returns all matching regions', () => {
  const regions = [
    {
      id: 'a',
      intent: 'protect',
      profile: 'base',
      anchor: { x: 0, y: 64, z: 0 },
      shape: { kind: 'column', radius: 16 },
    },
    {
      id: 'b',
      intent: 'resource',
      profile: 'mine',
      anchor: { x: 0, y: 30, z: 0 },
      shape: { kind: 'column', radius: 4 },
    },
  ];
  const at = regionsAt(1, 30, 1, regions);
  assert.equal(at.length, 2);
});
