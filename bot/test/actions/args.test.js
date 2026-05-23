import test from 'node:test';
import assert from 'node:assert/strict';
import { coord3, box6, boxXZ, itemName, count, bool } from '../../lib/actions/_args.js';

test('coord3 valid', () => {
  const r = coord3({ x: 1, y: 64, z: -2 });
  assert.equal(r.ok, true);
  assert.deepEqual({ x: r.x, y: r.y, z: r.z }, { x: 1, y: 64, z: -2 });
});

test('coord3 invalid', () => {
  const r = coord3({ x: 'nope', y: 1, z: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.response.error.code, 'INVALID_ARGS');
});

test('box6', () => {
  const r = box6({ x1: 0, y1: 60, z1: 0, x2: 5, y2: 70, z2: 5 });
  assert.equal(r.ok, true);
});

test('boxXZ building style', () => {
  const r = boxXZ({ x1: 0, z1: 0, x2: 4, z2: 4, y: 63 });
  assert.equal(r.ok, true);
  assert.equal(r.x2, 4);
});

test('boxXZ pit style', () => {
  const r = boxXZ({ x: 10, z: 20, w: 3, l: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.x2, 12);
  assert.equal(r.z2, 23);
});

test('itemName block alias', () => {
  const r = itemName({ block: 'dirt' }, { keys: ['block', 'item'] });
  assert.equal(r.ok, true);
  assert.equal(r.name, 'dirt');
});

test('count default', () => {
  assert.equal(count({}).count, 1);
  assert.equal(count({ count: 5 }).count, 5);
});

test('bool: tolerant truthy/falsy coercion', () => {
  assert.equal(bool(undefined), false);
  assert.equal(bool(null), false);
  assert.equal(bool(''), false);
  assert.equal(bool(undefined, true), true);
  assert.equal(bool(true), true);
  assert.equal(bool(false), false);
  assert.equal(bool(1), true);
  assert.equal(bool(0), false);
  assert.equal(bool('true'), true);
  assert.equal(bool('false'), false);
  assert.equal(bool('yes'), true);
  assert.equal(bool('no'), false);
  assert.equal(bool('1'), true);
  assert.equal(bool('0'), false);
  assert.equal(bool('on'), true);
  assert.equal(bool('off'), false);
});
