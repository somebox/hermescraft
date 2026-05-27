/**
 * Unit tests for materials.js — tier lookup, cascades, region palettes.
 * Validates against data/materials.json at the repo root.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tierOf,
  cascadeFor,
  paletteForRegion,
  isStructural,
  isTier1,
  getVersion,
} from '../../lib/runtime/materials.js';

test('schema: version is set', () => {
  assert.ok(getVersion() >= 1, 'version must be ≥ 1');
});

test('tierOf: known blocks map to expected tiers', () => {
  assert.equal(tierOf('dirt'), 1);
  assert.equal(tierOf('cobblestone'), 1);
  assert.equal(tierOf('oak_planks'), 2);
  assert.equal(tierOf('oak_log'), 3);
  assert.equal(tierOf('oak_fence'), 3);
  assert.equal(tierOf('diamond_block'), 4);
});

test('tierOf: unknown / falsy returns null', () => {
  assert.equal(tierOf('unknown_block'), null);
  assert.equal(tierOf(''), null);
  assert.equal(tierOf(null), null);
  assert.equal(tierOf(undefined), null);
});

test('isTier1: only tier_1 blocks return true', () => {
  assert.equal(isTier1('dirt'), true);
  assert.equal(isTier1('sand'), true);
  assert.equal(isTier1('cobblestone'), true);
  assert.equal(isTier1('oak_planks'), false);
  assert.equal(isTier1('oak_log'), false);
  assert.equal(isTier1('unknown_block'), false);
});

test('isStructural: tier >= 2 returns true; tier 1 + unknown return false', () => {
  // tier_1 → not structural
  assert.equal(isStructural('dirt'), false);
  assert.equal(isStructural('cobblestone'), false);
  assert.equal(isStructural('stone'), false);
  // tier_2 → structural (cheap craft, but still infrastructure)
  assert.equal(isStructural('oak_planks'), true);
  assert.equal(isStructural('stone_bricks'), true);
  // tier_3 → structural
  assert.equal(isStructural('oak_log'), true);
  assert.equal(isStructural('oak_fence'), true);
  assert.equal(isStructural('oak_door'), true);
  assert.equal(isStructural('glass'), true);
  // tier_4 → structural
  assert.equal(isStructural('diamond_block'), true);
  // unknown → not structural (defaults safe: unknowns get protect-via-region anyway)
  assert.equal(isStructural('unknown_block'), false);
});

test('isStructural is a strict superset of today STRUCTURAL_BY_PROFILE.base', () => {
  // Migration safety check for phase C6. Every block in today's hardcoded set
  // (bot/lib/runtime/regions/profiles.js:STRUCTURAL_BY_PROFILE.base as of
  // commit a57f232) must still be classified structural by the new lookup.
  const todaysStructural = [
    'oak_planks', 'birch_planks', 'spruce_planks', 'dark_oak_planks',
    'oak_log', 'birch_log', 'spruce_log',
    'oak_fence', 'birch_fence', 'oak_door',
    'glass', 'glass_pane',
    'oak_stairs', 'cobblestone_stairs',
    'oak_slab', 'cobblestone_slab',
  ];
  for (const block of todaysStructural) {
    assert.equal(
      isStructural(block),
      true,
      `${block} must remain structural after C6 migration`,
    );
  }
});

test('cascadeFor: known cascades return non-empty arrays', () => {
  const fill = cascadeFor('fill_default');
  assert.ok(Array.isArray(fill));
  assert.ok(fill.length > 0);
  assert.ok(fill.includes('dirt'));
  assert.ok(fill.includes('cobblestone'));

  const pillar = cascadeFor('pillar_rescue');
  assert.ok(Array.isArray(pillar));
  assert.ok(pillar.length > 0);
  assert.ok(pillar.includes('dirt'));
});

test('cascadeFor: all cascade blocks are tier_1', () => {
  // Cascades are fill / recovery options — they should never include
  // structural materials.
  for (const name of ['fill_default', 'pillar_rescue', 'bridge_default']) {
    const cascade = cascadeFor(name);
    for (const block of cascade) {
      assert.equal(
        isTier1(block),
        true,
        `cascade ${name} contains non-tier_1 block: ${block}`,
      );
    }
  }
});

test('cascadeFor: unknown cascade returns empty array', () => {
  assert.deepEqual(cascadeFor('nonexistent'), []);
  assert.deepEqual(cascadeFor(''), []);
});

test('cascadeFor: returned array is a copy (caller mutations safe)', () => {
  const a = cascadeFor('fill_default');
  const b = cascadeFor('fill_default');
  a.push('mutation');
  assert.notEqual(a.length, b.length, 'returned arrays must be independent');
});

test('paletteForRegion: known profiles return their palette', () => {
  assert.deepEqual(paletteForRegion({ profile: 'base' }), ['cobblestone']);
  assert.deepEqual(paletteForRegion({ profile: 'farm' }), ['dirt']);
  assert.deepEqual(paletteForRegion({ profile: 'dock' }), ['oak_planks']);
});

test('paletteForRegion: unknown / missing profile returns []', () => {
  assert.deepEqual(paletteForRegion({ profile: 'unknown' }), []);
  assert.deepEqual(paletteForRegion({}), []);
  assert.deepEqual(paletteForRegion(null), []);
  assert.deepEqual(paletteForRegion(undefined), []);
});

test('paletteForRegion: returned array is a copy', () => {
  const a = paletteForRegion({ profile: 'base' });
  const b = paletteForRegion({ profile: 'base' });
  a.push('mutation');
  assert.notEqual(a.length, b.length);
});
