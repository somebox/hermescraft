/**
 * Tests for the till surface-scan helper added for bug t_10ec0479
 * (2026-05-24). Mason called `mc till (363,65,-573)` on a plot with
 * uneven terrain — the true surface at that column was at y=63, but
 * the old radius-1 self-adjust could only reach y=64. The downward
 * scan handles the dominant failure mode: agent guesses too-high Y
 * over a depressed plot cell.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findTillableSurfaceBelow, isTillableAt } from '../lib/actions/farming.js';

/** Build a minimal bot stub with `blockAt(vec3) → {name}` driven by a map. */
function fakeBot(blocks /* { 'x,y,z': name } */) {
  return {
    blockAt(v) {
      const k = `${v.x},${v.y},${v.z}`;
      return blocks[k] ? { name: blocks[k] } : { name: 'air' };
    },
  };
}

test('findTillableSurfaceBelow: returns the request cell when it is already tillable', () => {
  const b = fakeBot({ '363,65,-573': 'grass_block' });
  assert.deepEqual(findTillableSurfaceBelow(b, 363, 65, -573), { x: 363, y: 65, z: -573, drop: 0 });
});

test('findTillableSurfaceBelow: scans through air to the topmost tillable below', () => {
  // Mason's actual scenario: grass at y=63, air at y=64..65
  const b = fakeBot({ '363,63,-573': 'grass_block', '363,62,-573': 'dirt' });
  assert.deepEqual(findTillableSurfaceBelow(b, 363, 65, -573), { x: 363, y: 63, z: -573, drop: 2 });
});

test('findTillableSurfaceBelow: returns dirt when grass is missing', () => {
  const b = fakeBot({ '363,63,-573': 'dirt' });
  assert.deepEqual(findTillableSurfaceBelow(b, 363, 65, -573), { x: 363, y: 63, z: -573, drop: 2 });
});

test('findTillableSurfaceBelow: stops at non-air non-tillable solid (no tillable through stone)', () => {
  // Stone at y=64 blocks the scan; the dirt below at y=63 should NOT be found.
  const b = fakeBot({ '363,64,-573': 'stone', '363,63,-573': 'dirt' });
  assert.equal(findTillableSurfaceBelow(b, 363, 65, -573), null);
});

test('findTillableSurfaceBelow: returns null when nothing tillable within maxDrop', () => {
  const b = fakeBot({});
  assert.equal(findTillableSurfaceBelow(b, 363, 65, -573, 4), null);
});

test('findTillableSurfaceBelow: respects custom maxDrop', () => {
  // Tillable 5 below, default maxDrop=4 should miss; maxDrop=5 should find.
  const b = fakeBot({ '363,60,-573': 'grass_block' });
  assert.equal(findTillableSurfaceBelow(b, 363, 65, -573, 4), null);
  assert.deepEqual(findTillableSurfaceBelow(b, 363, 65, -573, 5), { x: 363, y: 60, z: -573, drop: 5 });
});

test('findTillableSurfaceBelow: cave_air and void_air are also passable', () => {
  const b = fakeBot({
    '363,65,-573': 'cave_air',
    '363,64,-573': 'void_air',
    '363,63,-573': 'grass_block',
  });
  assert.deepEqual(findTillableSurfaceBelow(b, 363, 65, -573), { x: 363, y: 63, z: -573, drop: 2 });
});

test('findTillableSurfaceBelow: defensive — null bot returns null', () => {
  assert.equal(findTillableSurfaceBelow(null, 363, 65, -573), null);
});

test('isTillableAt: recognises every block in the TILLABLE set', () => {
  for (const name of ['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'dirt_path']) {
    const b = fakeBot({ '0,0,0': name });
    assert.equal(isTillableAt(b, 0, 0, 0), true, name);
  }
});

test('isTillableAt: false for non-tillable blocks', () => {
  for (const name of ['stone', 'air', 'farmland', 'cobblestone', 'sand']) {
    const b = fakeBot({ '0,0,0': name });
    assert.equal(isTillableAt(b, 0, 0, 0), false, name);
  }
});
