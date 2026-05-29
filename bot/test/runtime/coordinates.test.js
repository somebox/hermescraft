/**
 * Unit tests for block_y / surface_y helpers.
 * See bot/lib/runtime/coordinates.js and docs/conventions/coordinates.md.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  surfaceFromBlock,
  blockFromSurface,
  withYBoth,
  parseYInput,
  normalizeBoxYArgs,
} from '../../lib/runtime/coordinates.js';

test('surfaceFromBlock: surface is always one above block', () => {
  assert.equal(surfaceFromBlock(64), 65);
  assert.equal(surfaceFromBlock(0), 1);
  assert.equal(surfaceFromBlock(-64), -63);
});

test('blockFromSurface: block is always one below surface', () => {
  assert.equal(blockFromSurface(65), 64);
  assert.equal(blockFromSurface(1), 0);
  assert.equal(blockFromSurface(-63), -64);
});

test('round-trip: surfaceFromBlock(blockFromSurface(N)) === N', () => {
  for (const n of [-64, 0, 64, 100, 256, 319]) {
    assert.equal(surfaceFromBlock(blockFromSurface(n)), n, `surface ${n}`);
    assert.equal(blockFromSurface(surfaceFromBlock(n)), n, `block ${n}`);
  }
});

test('surfaceFromBlock + blockFromSurface accept strings and floor', () => {
  assert.equal(surfaceFromBlock('64'), 65);
  assert.equal(surfaceFromBlock(64.7), 65); // floor before +1
  assert.equal(blockFromSurface('65'), 64);
  assert.equal(blockFromSurface(65.9), 64);
});

test('withYBoth adds both fields and preserves the rest', () => {
  const result = withYBoth({ x: 386, z: -601, block_name: 'dirt' }, 64);
  assert.deepEqual(result, {
    x: 386,
    z: -601,
    block_name: 'dirt',
    block_y: 64,
    surface_y: 65,
  });
});

test('withYBoth handles null/empty obj', () => {
  assert.deepEqual(withYBoth(null, 64), { block_y: 64, surface_y: 65 });
  assert.deepEqual(withYBoth(undefined, 64), { block_y: 64, surface_y: 65 });
  assert.deepEqual(withYBoth({}, 64), { block_y: 64, surface_y: 65 });
});

test('withYBoth overwrites any pre-existing block_y/surface_y', () => {
  const result = withYBoth({ block_y: 999, surface_y: 1000, other: 'kept' }, 64);
  assert.equal(result.block_y, 64);
  assert.equal(result.surface_y, 65);
  assert.equal(result.other, 'kept');
});

test('withYBoth floors fractional input', () => {
  assert.deepEqual(withYBoth({}, 64.9), { block_y: 64, surface_y: 65 });
});

test('parseYInput: surface_y wins over y when both present', () => {
  assert.equal(parseYInput({ y: 99, surface_y: 65 }), 64);
});

test('parseYInput: only y → block_y direct', () => {
  assert.equal(parseYInput({ y: 64 }), 64);
});

test('parseYInput: only surface_y → block_y = surface_y - 1', () => {
  assert.equal(parseYInput({ surface_y: 65 }), 64);
});

test('parseYInput: neither → null (caller decides)', () => {
  assert.equal(parseYInput({}), null);
  assert.equal(parseYInput({ x: 1, z: 2 }), null);
  assert.equal(parseYInput(null), null);
  assert.equal(parseYInput(undefined), null);
});

test('parseYInput: handles string inputs', () => {
  assert.equal(parseYInput({ y: '64' }), 64);
  assert.equal(parseYInput({ surface_y: '65' }), 64);
});

test('parseYInput: ignores non-finite values', () => {
  assert.equal(parseYInput({ y: 'abc' }), null);
  assert.equal(parseYInput({ y: NaN }), null);
  assert.equal(parseYInput({ surface_y: Infinity }), null);
  assert.equal(parseYInput({ y: 64, surface_y: 'abc' }), 64); // falls through to y
});

test('parseYInput: surface_y of 0 is valid (gives block_y = -1)', () => {
  assert.equal(parseYInput({ surface_y: 0 }), -1);
});

test('parseYInput: y of 0 is valid', () => {
  assert.equal(parseYInput({ y: 0 }), 0);
});

test('normalizeBoxYArgs: surface_y1/surface_y2 override y1/y2', () => {
  const out = normalizeBoxYArgs({ y1: 99, y2: 100, surface_y1: 65, surface_y2: 66 });
  assert.equal(out.y1, 64);
  assert.equal(out.y2, 65);
});

test('normalizeBoxYArgs: leaves args untouched when aliases are absent/invalid', () => {
  assert.deepEqual(normalizeBoxYArgs({ y1: 1, y2: 2 }), { y1: 1, y2: 2 });
  assert.deepEqual(normalizeBoxYArgs({ y1: 1, y2: 2, surface_y1: 'bogus' }), { y1: 1, y2: 2, surface_y1: 'bogus' });
  assert.equal(normalizeBoxYArgs(null), null);
});
