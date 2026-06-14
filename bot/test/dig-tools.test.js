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
  detectPostDigBreach,
  SAFE_STEP_DOWN_BLOCKS,
  measureDrop,
  measureDropIfSupportRemoved,
  describeDrop,
  formatFallHazardMessage,
  checkFallHazard,
  detectDigHazards,
  hasPlaceableBlocks,
} from '../lib/runtime/dig-tools.js';
import { Vec3 } from 'vec3';

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

// ─────────────────────────────────────────────────────────────────────────
// detectPostDigBreach — post-dig water/lava detection.
//
// Returns null when the just-dug cell is air. Returns a breach record when
// the cell contains water/flowing_water/lava/flowing_lava, with
// source_cell populated when a face-neighbour is a non-flowing source.
// ─────────────────────────────────────────────────────────────────────────

function makeBreachBot(terrain) {
  return {
    blockAt({ x, y, z }) {
      const name = terrain(x, y, z) || 'air';
      return { name, boundingBox: name === 'air' ? 'empty' : 'block' };
    },
  };
}

// Skip the settle in tests — we don't need real timing for stub block reads.
const NO_SLEEP = { settleMs: 0 };

test('detectPostDigBreach: returns null when dug cell is air', async () => {
  const bot = makeBreachBot(() => 'air');
  const r = await detectPostDigBreach(bot, { x: 5, y: 64, z: 5 }, NO_SLEEP);
  assert.equal(r, null);
});

test('detectPostDigBreach: water source on east face → kind=water, source_cell=east', async () => {
  // The dug cell has water that flowed in; an adjacent source is to the east.
  const terrain = (x, y, z) => {
    if (x === 5 && y === 64 && z === 5) return 'water';        // dug cell now wet
    if (x === 6 && y === 64 && z === 5) return 'water';        // E source
    return 'air';
  };
  const r = await detectPostDigBreach(makeBreachBot(terrain), { x: 5, y: 64, z: 5 }, NO_SLEEP);
  assert.ok(r, 'expected a breach record');
  assert.equal(r.kind, 'water');
  assert.equal(r.severity, 'warn');
  assert.deepEqual(r.breach_cell, { x: 5, y: 64, z: 5 });
  assert.deepEqual(r.source_cell, { x: 6, y: 64, z: 5 });
  assert.equal(r.wet_neighbors.length, 1);
});

test('detectPostDigBreach: lava in dug cell → kind=lava, severity=critical', async () => {
  const terrain = (x, y, z) => {
    if (x === 5 && y === 64 && z === 5) return 'lava';
    if (x === 5 && y === 65 && z === 5) return 'lava';   // overhead source dripped down
    return 'air';
  };
  const r = await detectPostDigBreach(makeBreachBot(terrain), { x: 5, y: 64, z: 5 }, NO_SLEEP);
  assert.ok(r);
  assert.equal(r.kind, 'lava');
  assert.equal(r.severity, 'critical');
  assert.deepEqual(r.source_cell, { x: 5, y: 65, z: 5 });
});

test('detectPostDigBreach: flowing-only fluid (no nearby source visible) → source_cell=null', async () => {
  // Flowing water can reach the dug cell from off-frame; the immediate
  // neighbours are also flowing (not source). We still report the breach
  // but can't pinpoint the leak.
  const terrain = (x, y, z) => {
    if (x === 5 && y === 64 && z === 5) return 'flowing_water';
    if (x === 6 && y === 64 && z === 5) return 'flowing_water';
    return 'air';
  };
  const r = await detectPostDigBreach(makeBreachBot(terrain), { x: 5, y: 64, z: 5 }, NO_SLEEP);
  assert.ok(r);
  assert.equal(r.kind, 'flowing_water');
  assert.equal(r.source_cell, null);
  assert.equal(r.wet_neighbors.length, 1);
});

test('detectPostDigBreach: counts wet face-neighbours from any of the 6 sides', async () => {
  // Source above + flowing on east and below.
  const terrain = (x, y, z) => {
    if (x === 5 && y === 64 && z === 5) return 'water';
    if (x === 5 && y === 65 && z === 5) return 'water';          // up source
    if (x === 6 && y === 64 && z === 5) return 'flowing_water';  // east flowing
    if (x === 5 && y === 63 && z === 5) return 'flowing_water';  // down flowing
    return 'air';
  };
  const r = await detectPostDigBreach(makeBreachBot(terrain), { x: 5, y: 64, z: 5 }, NO_SLEEP);
  assert.equal(r.wet_neighbors.length, 3);
  // Source preferred over flowing for source_cell.
  assert.deepEqual(r.source_cell, { x: 5, y: 65, z: 5 });
});

test('detectPostDigBreach: dug cell is solid (race lost) → null', async () => {
  // If by the time we check, the cell has been re-filled with a solid
  // block (e.g. gravity collapse), it's not a fluid breach.
  const terrain = (x, y, z) => (x === 5 && y === 64 && z === 5 ? 'cobblestone' : 'air');
  const r = await detectPostDigBreach(makeBreachBot(terrain), { x: 5, y: 64, z: 5 }, NO_SLEEP);
  assert.equal(r, null);
});

test('detectPostDigBreach: defensive — blockAt throwing on neighbour does not crash', async () => {
  const bot = {
    blockAt({ x, y, z }) {
      if (x === 5 && y === 64 && z === 5) return { name: 'water', boundingBox: 'empty' };
      throw new Error('chunk unloaded');
    },
  };
  const r = await detectPostDigBreach(bot, { x: 5, y: 64, z: 5 }, NO_SLEEP);
  // We still detect the breach (dug cell is fluid) but no neighbours
  // could be inspected.
  assert.ok(r);
  assert.equal(r.wet_neighbors.length, 0);
  assert.equal(r.source_cell, null);
});

test('detectPostDigBreach: honors custom sleep injection (no real-time wait)', async () => {
  let slept = 0;
  const bot = makeBreachBot(() => 'air');
  const fakeSleep = async (ms) => { slept = ms; };
  await detectPostDigBreach(bot, { x: 5, y: 64, z: 5 }, { settleMs: 250, sleep: fakeSleep });
  assert.equal(slept, 250);
});

// ─────────────────────────────────────────────────────────────────────────
// measureDrop / fall hazard classification
// ─────────────────────────────────────────────────────────────────────────

function makeTerrainBot(terrain) {
  return {
    entity: { position: new Vec3(0.5, 65, 0.5) },
    blockAt(p) {
      const raw = terrain(p.x, p.y, p.z);
      const name = typeof raw === 'string' ? raw : raw?.name ?? 'air';
      const fluid = name === 'water' || name === 'flowing_water' || name === 'lava' || name === 'flowing_lava';
      const boundingBox = name === 'air' || name === 'cave_air' || name === 'void_air' || fluid ? 'empty' : 'block';
      return { name, boundingBox };
    },
    inventory: { items: () => [] },
  };
}

test('measureDrop: flat when solid directly under stand cell', () => {
  const bot = makeTerrainBot((x, y, z) => {
    if (x === 0 && y === 64 && z === 0) return 'stone';
    return 'air';
  });
  const m = measureDrop(bot, 0, 65, 0);
  assert.equal(m.kind, 'flat');
  assert.equal(m.depth, 0);
});

test('measureDrop: 2-block step-down (M2-like forward stand)', () => {
  const bot = makeTerrainBot((x, y, z) => {
    if (x === 0 && y === 62 && z === 0) return 'stone';
    return 'air';
  });
  const m = measureDrop(bot, 0, 65, 0);
  assert.equal(m.kind, 'step');
  assert.equal(m.depth, 2);
});

test('measureDrop: 3-block step is still step', () => {
  const bot = makeTerrainBot((x, y, z) => {
    if (x === 0 && y === 61 && z === 0) return 'stone';
    return 'air';
  });
  const m = measureDrop(bot, 0, 65, 0);
  assert.equal(m.kind, 'step');
  assert.equal(m.depth, 3);
});

test('measureDrop: 5-block drop to solid floor', () => {
  const bot = makeTerrainBot((x, y, z) => {
    if (x === 0 && y === 59 && z === 0) return 'stone';
    return 'air';
  });
  const m = measureDrop(bot, 0, 65, 0);
  assert.equal(m.kind, 'drop');
  assert.equal(m.depth, 5);
});

test('measureDrop: no floor within maxScan → void', () => {
  const bot = makeTerrainBot(() => 'air');
  const m = measureDrop(bot, 0, 65, 0, { maxScan: 8 });
  assert.equal(m.kind, 'void');
});

test('measureDrop: water in fall column → void not step', () => {
  const bot = makeTerrainBot((x, y, z) => {
    if (x === 0 && y === 63 && z === 0) return 'water';
    if (x === 0 && y === 62 && z === 0) return 'stone';
    return 'air';
  });
  const m = measureDrop(bot, 0, 65, 0);
  assert.equal(m.kind, 'void');
});

test('describeDrop: step context avoids cliff wording', () => {
  const msg = describeDrop(
    { kind: 'step', depth: 2, floorY: 63 },
    { context: 'stair_down_fully_air', dir: 'north' },
  );
  assert.match(msg, /minor falloff/i);
  assert.doesNotMatch(msg, /\bfall through\b/i);
  assert.match(msg, /mc move/i);
});

test('checkFallHazard: 2-block air below foot → step', () => {
  const bot = makeTerrainBot((x, y, z) => {
    if (x === 0 && y === 64 && z === 0) return 'stone';
    if (x === 0 && y === 62 && z === 0) return 'stone';
    return 'air';
  });
  bot.entity.position = new Vec3(0.5, 65, 0.5);
  const h = checkFallHazard(bot, 0, 64, 0);
  assert.ok(h);
  assert.equal(h.dropKind, 'step');
  assert.equal(h.drop, 2);
});

test('checkFallHazard: 10-block air → dropKind drop not void', () => {
  const bot = makeTerrainBot((x, y, z) => {
    if (x === 0 && y === 54 && z === 0) return 'stone';
    if (x === 0 && y === 64 && z === 0) return 'stone';
    return 'air';
  });
  bot.entity.position = new Vec3(0.5, 65, 0.5);
  const h = checkFallHazard(bot, 0, 64, 0);
  assert.ok(h);
  assert.equal(h.dropKind, 'drop');
  assert.equal(h.drop, 10);
});

test('formatFallHazardMessage: step vs drop tone', () => {
  const calm = formatFallHazardMessage(
    { drop: 2, dropKind: 'step' },
    { x: 0, y: 64, z: 0 },
    { blockName: 'stone' },
  );
  assert.match(calm, /harmless/i);
  const harsh = formatFallHazardMessage(
    { drop: 10, dropKind: 'drop' },
    { x: 0, y: 64, z: 0 },
    { blockName: 'stone' },
  );
  assert.match(harsh, /fall damage/i);
});
