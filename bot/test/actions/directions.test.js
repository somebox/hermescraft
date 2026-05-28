import test from 'node:test';
import assert from 'node:assert/strict';
import { cardinalDelta, oppositeDir, dirFromDelta, DIR_VEC_4 } from '../../lib/actions/_directions.js';

test('cardinalDelta aliases', () => {
  assert.deepEqual(cardinalDelta('north'), { dx: 0, dz: -1, key: 'N' });
  assert.deepEqual(cardinalDelta('e'), { dx: 1, dz: 0, key: 'E' });
  assert.equal(cardinalDelta('bogus'), null);
});

test('cardinalDelta engineering-shorthand axis form (+x/-x/+z/-z)', () => {
  // Minecraft axis conventions: +x → east, -x → west, +z → south, -z → north.
  // Agents reasoning from coord deltas (e.g. target - bot.position) reach
  // for these axis forms instead of named cardinals; accepting them is a
  // cheap win.
  assert.deepEqual(cardinalDelta('+x'), { dx: 1, dz: 0, key: 'E' });
  assert.deepEqual(cardinalDelta('-x'), { dx: -1, dz: 0, key: 'W' });
  assert.deepEqual(cardinalDelta('+z'), { dx: 0, dz: 1, key: 'S' });
  assert.deepEqual(cardinalDelta('-z'), { dx: 0, dz: -1, key: 'N' });
  // Uppercase axis letter still resolves (toLowerCase normalisation).
  assert.deepEqual(cardinalDelta('+X'), { dx: 1, dz: 0, key: 'E' });
  assert.deepEqual(cardinalDelta('-Z'), { dx: 0, dz: -1, key: 'N' });
});

test('cardinalDelta engineering-shorthand word form (plus_x / minus_z)', () => {
  // For agents that emit identifier-safe form (no leading + or - sign).
  assert.deepEqual(cardinalDelta('plus_x'), { dx: 1, dz: 0, key: 'E' });
  assert.deepEqual(cardinalDelta('minus_x'), { dx: -1, dz: 0, key: 'W' });
  assert.deepEqual(cardinalDelta('plus_z'), { dx: 0, dz: 1, key: 'S' });
  assert.deepEqual(cardinalDelta('minus_z'), { dx: 0, dz: -1, key: 'N' });
});

test('cardinalDelta rejects bogus axis shorthand (+y / +foo)', () => {
  // Only the horizontal axes have cardinal mappings — vertical (+y/-y)
  // is meaningless for cardinal direction.
  assert.equal(cardinalDelta('+y'), null);
  assert.equal(cardinalDelta('+foo'), null);
  assert.equal(cardinalDelta('plus_y'), null);
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
