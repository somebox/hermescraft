import { describe, it } from 'node:test';
import assert from 'node:assert';
import minecraftData from 'minecraft-data';
import {
  resolveInventoryItem,
  resolveBlockQuery,
  resolveCraftTarget,
  resolveResourceGroup,
  isKnownBlock,
  isKnownItem,
} from '../lib/resolver.js';

const mcData = minecraftData('1.20');

describe('resolver exact IDs', () => {
  it('recognizes oak_log as block', () => {
    assert.strictEqual(isKnownBlock(mcData, 'oak_log'), true);
    const r = resolveBlockQuery({ mcData, query: 'oak_log', policy: 'exact_required' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.selected?.name, 'oak_log');
  });

  it('recognizes wooden_axe as item', () => {
    assert.strictEqual(isKnownItem(mcData, 'wooden_axe'), true);
    const r = resolveInventoryItem({
      mcData,
      inventory: [{ name: 'wooden_axe', count: 1 }],
      query: 'wooden_axe',
      policy: 'exact_required',
    });
    assert.strictEqual(r.ok, true);
  });

  it('recognizes cobblestone block', () => {
    assert.strictEqual(isKnownBlock(mcData, 'cobblestone'), true);
  });
});

describe('resolver aliases', () => {
  it('resolves axe to best axe in inventory', () => {
    const r = resolveInventoryItem({
      mcData,
      inventory: [
        { name: 'stone_axe', count: 1 },
        { name: 'iron_axe', count: 1 },
      ],
      query: 'axe',
      policy: 'best_available',
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.selected?.name, 'iron_axe');
  });

  it('resolves wood resource group members', () => {
    const g = resolveResourceGroup('wood');
    assert.strictEqual(g.ok, true);
    assert.strictEqual(g.group, 'logs');
    assert.ok(g.members.includes('oak_log'));
  });

  it('block wood returns ambiguity under exact_required', () => {
    const r = resolveBlockQuery({ mcData, query: 'wood', policy: 'exact_required' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'ambiguous_query');
  });
});

describe('resolver policies', () => {
  it('exact_required rejects axe shorthand', () => {
    const r = resolveInventoryItem({
      mcData,
      inventory: [{ name: 'iron_axe', count: 1 }],
      query: 'axe',
      policy: 'exact_required',
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'ambiguous_query');
  });

  it('cheapest_craftable selects wooden axe for craft axe', () => {
    const r = resolveCraftTarget({ mcData, query: 'axe', policy: 'cheapest_craftable' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.selected?.name, 'wooden_axe');
  });

  it('most_available picks plank stack', () => {
    const r = resolveInventoryItem({
      mcData,
      inventory: [
        { name: 'oak_planks', count: 16 },
        { name: 'spruce_planks', count: 4 },
      ],
      query: 'planks',
      policy: 'most_available',
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.selected?.name, 'oak_planks');
  });

  it('nearest_visible policy placeholder groupsAllowed uses block group fallback', () => {
    const r = resolveBlockQuery({ mcData, query: 'logs', policy: 'nearest_visible' });
    assert.strictEqual(r.ok, true);
    assert.ok(typeof r.selected?.name === 'string');
  });
});

describe('resolver ambiguity', () => {
  it('unknown query returns unknown_query', () => {
    const r = resolveInventoryItem({
      mcData,
      inventory: [],
      query: 'totally_fake_item_xyz',
      policy: 'best_available',
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'unknown_query');
  });
});
