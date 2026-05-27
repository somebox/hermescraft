/**
 * Tests for the fair-play hint emitted by mc find_blocks.
 *
 * Pre-fix: scout.js hardcoded "(scout; mc collect needs trunk in sight)"
 * for every block type, including cobblestone/ore. Real trace 2026-05-27:
 *   mc find_blocks cobblestone 48
 *   → "Found 10 cobblestone (scout; mc collect needs trunk in sight)..."
 *
 * Post-fix: the note matches what mc collect's discovery.js actually does
 * for the requested block — trunk-LOS for logs, raycast visibility for
 * solid blocks, no note for non-solid plants (proximity search).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fairPlayCollectNote } from '../../lib/actions/mining/scout.js';

const SOLID = { boundingBox: 'block' };
const PLANT = { boundingBox: 'empty' };

test('trunk-style names → "needs trunk in sight"', () => {
  for (const name of ['oak_log', 'birch_log', 'spruce_log', 'crimson_stem', 'warped_stem']) {
    assert.match(
      fairPlayCollectNote(name, SOLID),
      /needs trunk in sight/,
      `${name} should be flagged as trunk harvest`,
    );
  }
});

test('solid non-trunk blocks → "needs line-of-sight"', () => {
  for (const name of ['cobblestone', 'iron_ore', 'stone', 'dirt', 'diamond_ore']) {
    const note = fairPlayCollectNote(name, SOLID);
    assert.match(note, /line-of-sight/, `${name} should mention line-of-sight, got: ${note}`);
    assert.doesNotMatch(note, /trunk/, `${name} should not mention trunk`);
  }
});

test('non-solid plants → no note (proximity search has no LOS requirement)', () => {
  for (const name of ['grass', 'tall_grass', 'poppy', 'wheat']) {
    assert.equal(
      fairPlayCollectNote(name, PLANT),
      '',
      `${name} (non-solid) should produce empty note`,
    );
  }
});

test('missing blockType → falls back to line-of-sight branch', () => {
  // Defensive: if mcData lookup ever returns undefined, we should pick
  // the safer/more useful branch (line-of-sight) rather than crash.
  assert.match(fairPlayCollectNote('mystery_block', null), /line-of-sight/);
  assert.match(fairPlayCollectNote('mystery_block', undefined), /line-of-sight/);
});
