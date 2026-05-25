import test from 'node:test';
import assert from 'node:assert/strict';
import { compareBlocks, normalizeBlockId } from '../../../lib/runtime/blueprints/compare.js';

test('normalizeBlockId strips GrabCraft door suffixes', () => {
  assert.equal(normalizeBlockId('oak_door_facing_north_hinge_left'), 'oak_door');
});

test('compareBlocks matches ladder variants', () => {
  const r = compareBlocks('ladder_facing_north', 'ladder');
  assert.equal(r.match, true);
});

test('compareBlocks bed parts normalize', () => {
  const r = compareBlocks('red_bed_head_of_the_bed', 'red_bed');
  assert.equal(r.match, true);
});

test('compareBlocks detects wrong material', () => {
  const r = compareBlocks('cobblestone', 'stone');
  assert.equal(r.match, false);
});
