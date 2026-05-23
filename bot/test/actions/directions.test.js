import test from 'node:test';
import assert from 'node:assert/strict';
import { cardinalDelta, oppositeDir, dirFromDelta, DIR_VEC_4 } from '../../lib/actions/_directions.js';

test('cardinalDelta aliases', () => {
  assert.deepEqual(cardinalDelta('north'), { dx: 0, dz: -1, key: 'N' });
  assert.deepEqual(cardinalDelta('e'), { dx: 1, dz: 0, key: 'E' });
  assert.equal(cardinalDelta('bogus'), null);
});

test('oppositeDir', () => {
  assert.equal(oppositeDir('N'), 'S');
  assert.equal(oppositeDir('NE'), 'SW');
});

test('dirFromDelta', () => {
  assert.equal(dirFromDelta(1, 0), 'E');
  assert.equal(dirFromDelta(0, -1), 'N');
});

test('DIR_VEC_4 has four cardinals', () => {
  assert.equal(Object.keys(DIR_VEC_4).length, 4);
});
