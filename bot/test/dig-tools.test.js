import test from 'node:test';
import assert from 'node:assert/strict';
import {
  holdsAwfulBlockForWoodHarvest,
  blockNeedsAxeHarvest,
  blockNeedsPickaxeHarvest,
  isSoftLandscapeBlock,
  firstInvItemByPriority,
  HARVEST_AXE_PRIORITY,
  HARVEST_PICK_PRIORITY,
  isDigProtected,
  recordRecentPlace,
} from '../lib/runtime/dig-tools.js';

test('blockNeedsAxeHarvest recognizes log types', () => {
  assert.ok(blockNeedsAxeHarvest('oak_log'));
  assert.ok(blockNeedsAxeHarvest('birch_log'));
  assert.ok(blockNeedsAxeHarvest('spruce_log'));
  assert.ok(blockNeedsAxeHarvest('crimson_stem'));
  assert.ok(blockNeedsAxeHarvest('warped_stem'));
  assert.ok(!blockNeedsAxeHarvest('stone'));
  assert.ok(!blockNeedsAxeHarvest('iron_ore'));
});

test('blockNeedsPickaxeHarvest recognizes stone/ore', () => {
  assert.ok(blockNeedsPickaxeHarvest('stone'));
  assert.ok(blockNeedsPickaxeHarvest('cobblestone'));
  assert.ok(blockNeedsPickaxeHarvest('iron_ore'));
  assert.ok(blockNeedsPickaxeHarvest('deepslate_coal_ore'));
  assert.ok(!blockNeedsPickaxeHarvest('oak_log'));
  assert.ok(!blockNeedsPickaxeHarvest('dirt'));
});

test('holdsAwfulBlockForWoodHarvest catches building blocks but not tools', () => {
  assert.ok(holdsAwfulBlockForWoodHarvest('cobblestone'));
  assert.ok(holdsAwfulBlockForWoodHarvest('stone'));
  assert.ok(holdsAwfulBlockForWoodHarvest('oak_planks'));
  assert.ok(holdsAwfulBlockForWoodHarvest('dirt'));
  assert.ok(holdsAwfulBlockForWoodHarvest('sand'));
  assert.ok(!holdsAwfulBlockForWoodHarvest('wooden_axe'));
  assert.ok(!holdsAwfulBlockForWoodHarvest('stone_pickaxe'));
  assert.ok(!holdsAwfulBlockForWoodHarvest('diamond_sword'));
  assert.ok(!holdsAwfulBlockForWoodHarvest(''));
  assert.ok(!holdsAwfulBlockForWoodHarvest(null));
});

test('holdsAwfulBlockForWoodHarvest does not cover food (handled by preferHarvestToolForBlock)', () => {
  // Food items are NOT in the "awful block" set — the broader unequip logic
  // in preferHarvestToolForBlock handles these by unequipping anything non-tool
  assert.ok(!holdsAwfulBlockForWoodHarvest('cooked_porkchop'));
  assert.ok(!holdsAwfulBlockForWoodHarvest('apple'));
  assert.ok(!holdsAwfulBlockForWoodHarvest('bread'));
});

test('isSoftLandscapeBlock recognizes diggable terrain', () => {
  assert.ok(isSoftLandscapeBlock({ name: 'dirt' }));
  assert.ok(isSoftLandscapeBlock({ name: 'grass_block' }));
  assert.ok(isSoftLandscapeBlock({ name: 'sand' }));
  assert.ok(!isSoftLandscapeBlock({ name: 'stone' }));
  assert.ok(!isSoftLandscapeBlock({ name: 'oak_log' }));
  assert.ok(!isSoftLandscapeBlock(null));
});

test('firstInvItemByPriority returns best available tool', () => {
  const fakeBot = {
    inventory: {
      items: () => [
        { name: 'stone_axe', count: 1 },
        { name: 'wooden_pickaxe', count: 1 },
        { name: 'iron_axe', count: 1 },
      ],
    },
  };
  const axe = firstInvItemByPriority(fakeBot, HARVEST_AXE_PRIORITY);
  assert.equal(axe.name, 'iron_axe');

  const pick = firstInvItemByPriority(fakeBot, HARVEST_PICK_PRIORITY);
  assert.equal(pick.name, 'wooden_pickaxe');
});

test('firstInvItemByPriority returns null when nothing matches', () => {
  const fakeBot = {
    inventory: {
      items: () => [{ name: 'cooked_porkchop', count: 5 }],
    },
  };
  assert.equal(firstInvItemByPriority(fakeBot, HARVEST_AXE_PRIORITY), null);
});

// #101: recentPlaces exemption — bot can mine its own recently-placed
// protected blocks (e.g. tear down its own fence to rebuild bigger).

test('isDigProtected: protected list still refuses when no cell+ctx', () => {
  assert.equal(isDigProtected('oak_fence'), true);
  assert.equal(isDigProtected('stone'), false);
});

test('isDigProtected: empty recentPlaces still refuses protected block', () => {
  const ctx = { runtime: { recentPlaces: [] } };
  assert.equal(isDigProtected('oak_fence', { x: 1, y: 64, z: 1 }, ctx), true);
});

test('isDigProtected: recently-placed cell is EXEMPT', () => {
  const ctx = { runtime: { recentPlaces: [] } };
  recordRecentPlace(ctx, { x: 1, y: 64, z: 1 }, 'oak_fence');
  assert.equal(isDigProtected('oak_fence', { x: 1, y: 64, z: 1 }, ctx), false);
});

test('isDigProtected: different cell with same name stays protected', () => {
  const ctx = { runtime: { recentPlaces: [] } };
  recordRecentPlace(ctx, { x: 1, y: 64, z: 1 }, 'oak_fence');
  assert.equal(isDigProtected('oak_fence', { x: 99, y: 64, z: 99 }, ctx), true);
});

test('isDigProtected: expired recentPlace entry no longer exempts', () => {
  const ctx = { runtime: { recentPlaces: [] } };
  // Manually inject a stale entry (16 min old).
  ctx.runtime.recentPlaces.push({
    ts: Date.now() - 16 * 60 * 1000,
    cell: { x: 1, y: 64, z: 1 },
    block: 'oak_fence',
  });
  assert.equal(isDigProtected('oak_fence', { x: 1, y: 64, z: 1 }, ctx), true);
});

test('recordRecentPlace: caps the ring buffer at 64 entries', () => {
  const ctx = { runtime: { recentPlaces: [] } };
  for (let i = 0; i < 70; i++) {
    recordRecentPlace(ctx, { x: i, y: 64, z: 0 }, 'oak_planks');
  }
  assert.equal(ctx.runtime.recentPlaces.length, 64);
  // First few entries dropped (FIFO).
  assert.equal(ctx.runtime.recentPlaces[0].cell.x, 6);
});

test('recordRecentPlace: idempotent on same cell (refreshes ts, no duplicate)', () => {
  const ctx = { runtime: { recentPlaces: [] } };
  recordRecentPlace(ctx, { x: 5, y: 64, z: 5 }, 'oak_fence');
  recordRecentPlace(ctx, { x: 5, y: 64, z: 5 }, 'oak_fence');
  assert.equal(ctx.runtime.recentPlaces.length, 1);
});
