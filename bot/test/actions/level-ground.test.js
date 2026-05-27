/**
 * level_ground — the "clean up lumpy terrain" recipe.
 *
 * Motivated by 2026-05-27 session observation: bots left orphan pillars
 * + unfilled holes scattered around base after interrupted leveling
 * tasks + pillar_step churn. The operator asked for a recipe that:
 *   1. Determines a target Y for the area.
 *   2. Identifies holes / dirt-floor / pillar columns.
 *   3. Fills holes systematically without falling.
 *   4. Breaks down pillars + loose blocks above.
 *
 * This file tests the planner phase against a synthesized "messy field":
 * a flat baseline with randomly-injected holes (1-3 deep) and pillars
 * (1-5 tall). The plan should categorize every column and recommend a
 * target Y that minimizes total work (median heuristic).
 *
 * Execution path (delegating to mc level) is exercised via the bot
 * functional test suite (live mineflayer) — not here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuildingTerrainPart } from '../../lib/actions/building/terrain.js';

/**
 * Seeded PRNG so failures are reproducible. Park Miller LCG; not
 * cryptographic, just deterministic across Node versions.
 */
function makeRng(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/**
 * Build a mock bot whose blockAt() reads from a terrain dict.
 * Terrain is keyed by 'x,y,z' → { name }. Anything missing reads as air.
 * `groundTopY` is the canonical flat baseline.
 */
function makeMockBotWithTerrain(terrain, opts = {}) {
  const PASSABLE = new Set(['air', 'cave_air', 'void_air']);
  const FLUID = new Set(['water', 'lava', 'flowing_water', 'flowing_lava']);
  return {
    entity: { position: { x: 0, y: 70, z: 0, distanceTo: () => 0 } },
    game: { minY: -64, height: 384 },  // matches modern MC
    inventory: { items: () => [{ name: 'dirt' }, { name: 'cobblestone' }] },
    blockAt({ x, y, z }) {
      const k = `${x},${y},${z}`;
      const t = terrain.get(k);
      if (!t) return { name: 'air', boundingBox: 'empty', position: { x, y, z } };
      return { name: t.name, boundingBox: PASSABLE.has(t.name) || FLUID.has(t.name) ? 'empty' : 'block', position: { x, y, z } };
    },
    ...opts.extra,
  };
}

/**
 * Lay a flat slab at groundY across the rectangle, then randomly inject:
 *   - holes: pick `n_holes` columns; remove blocks down to (groundY - depth)
 *   - pillars: pick `n_pillars` columns; stack blocks up to (groundY + height)
 *
 * Returns the terrain map and a record of injected anomalies for assertions.
 */
function synthesizeMessyField({
  minX, maxX, minZ, maxZ, groundY = 64,
  n_holes = 5, n_pillars = 5, max_hole_depth = 3, max_pillar_height = 5,
  seed = 1337,
}) {
  const rand = makeRng(seed);
  const terrain = new Map();
  // Lay a stone subsurface 8 blocks thick, then a grass cap. This way a
  // hole that removes the cap + 1-2 dirt blocks still has a stone floor
  // below — matching how a real MC world reads at terrain_top.
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let dy = 1; dy <= 8; dy++) {
        terrain.set(`${x},${groundY - dy},${z}`, { name: 'stone' });
      }
      terrain.set(`${x},${groundY},${z}`, { name: 'grass_block' });
    }
  }
  const holes = [];
  const pillars = [];
  const cells = [];
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      cells.push({ x, z });
    }
  }
  // Shuffle (Fisher-Yates) so injections don't overlap predictably.
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  let idx = 0;
  for (let h = 0; h < n_holes && idx < cells.length; h++, idx++) {
    const { x, z } = cells[idx];
    const depth = 1 + Math.floor(rand() * max_hole_depth);
    // Remove the surface block and `depth - 1` below it.
    for (let dy = 0; dy < depth; dy++) {
      terrain.delete(`${x},${groundY - dy},${z}`);
    }
    holes.push({ x, z, depth, new_top: groundY - depth });
  }
  for (let p = 0; p < n_pillars && idx < cells.length; p++, idx++) {
    const { x, z } = cells[idx];
    const height = 1 + Math.floor(rand() * max_pillar_height);
    for (let dy = 1; dy <= height; dy++) {
      terrain.set(`${x},${groundY + dy},${z}`, { name: 'cobblestone' });
    }
    pillars.push({ x, z, height, new_top: groundY + height });
  }
  return { terrain, holes, pillars, groundY, levelCells: cells.length - n_holes - n_pillars };
}

function makePart(bot) {
  return createBuildingTerrainPart({
    ctx: { runtime: { regions: null, recentPlaces: [] } },
    config: { behaviors: {} },
    ensureBot: () => bot,
    sleep: async () => {},
    getActions: () => null,  // execute path tested separately
  });
}

test('level_ground: median Y on a perfectly flat field → 0 holes, 0 pillars, all level', async () => {
  // 4×4 = 16 cols — at the cap (lowered from 256→16 on 2026-05-27 to bound
  // CLI timeout risk; each column ≈ 2 ops on execute, so 16 cols ≈ 32 ops).
  const minX = 0, maxX = 3, minZ = 0, maxZ = 3;
  const { terrain } = synthesizeMessyField({
    minX, maxX, minZ, maxZ, groundY: 64,
    n_holes: 0, n_pillars: 0,
  });
  const part = makePart(makeMockBotWithTerrain(terrain));
  const res = await part.level_ground({ x1: minX, z1: minZ, x2: maxX, z2: maxZ });
  assert.equal(res.ok, true);
  assert.equal(res.data.target_y, 64);
  assert.equal(res.data.mode, 'median');
  assert.equal(res.data.summary.holes_n, 0);
  assert.equal(res.data.summary.pillars_n, 0);
  assert.equal(res.data.summary.level_n, 16);  // 4×4
  assert.equal(res.data.up_range_recommended, 1);  // no pillars
});

test('level_ground: identifies all injected holes + pillars with correct depth/height', async () => {
  // 4×4 = 16 cols, with 3 holes + 2 pillars (≤50% anomaly so median = groundY).
  const { terrain, holes, pillars, groundY } = synthesizeMessyField({
    minX: 0, maxX: 3, minZ: 0, maxZ: 3, groundY: 64,
    n_holes: 3, n_pillars: 2, max_hole_depth: 3, max_pillar_height: 5,
    seed: 42,
  });
  const part = makePart(makeMockBotWithTerrain(terrain));
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 3, z2: 3 });
  assert.equal(res.ok, true);
  // Median should still be the baseline groundY because >50% of columns
  // are level (16 cols, 5 anomalies = 11 level).
  assert.equal(res.data.target_y, groundY);
  assert.equal(res.data.summary.holes_n, holes.length);
  assert.equal(res.data.summary.pillars_n, pillars.length);
  // max_pillar_height should match the tallest injected pillar.
  const expectedMaxPillar = Math.max(...pillars.map((p) => p.height));
  assert.equal(res.data.summary.max_pillar_height, expectedMaxPillar);
  // up_range = max_pillar + 1, capped at 16.
  assert.equal(res.data.up_range_recommended, Math.min(expectedMaxPillar + 1, 16));
  // max_fill matches the deepest hole.
  const expectedMaxFill = Math.max(...holes.map((h) => h.depth));
  assert.equal(res.data.summary.max_fill, expectedMaxFill);

  // Verify per-column entries match injected anomalies exactly.
  const colByXZ = new Map(res.data.columns.map((c) => [`${c.x},${c.z}`, c]));
  for (const h of holes) {
    const c = colByXZ.get(`${h.x},${h.z}`);
    assert.ok(c, `hole at (${h.x},${h.z}) missing from plan`);
    assert.equal(c.action, 'fill');
    assert.equal(c.delta, -h.depth);
    assert.equal(c.top_y, h.new_top);
  }
  for (const p of pillars) {
    const c = colByXZ.get(`${p.x},${p.z}`);
    assert.ok(c, `pillar at (${p.x},${p.z}) missing from plan`);
    assert.equal(c.action, 'dig');
    assert.equal(c.delta, p.height);
    assert.equal(c.top_y, p.new_top);
  }
});

test('level_ground --mode min picks the lowest top (dig-only plan)', async () => {
  const { terrain } = synthesizeMessyField({
    minX: 0, maxX: 3, minZ: 0, maxZ: 3, groundY: 64,
    n_holes: 3, n_pillars: 3, seed: 7,
  });
  const part = makePart(makeMockBotWithTerrain(terrain));
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 3, z2: 3, mode: 'min' });
  assert.equal(res.ok, true);
  assert.equal(res.data.mode, 'min');
  // With mode=min, every column is either at-or-above the target.
  // No fill operations should be planned.
  assert.equal(res.data.summary.holes_n, 0);
  // Targets at the deepest hole's new_top.
  const expectedTarget = Math.min(...res.data.columns
    .filter((c) => c.top_y !== null)
    .map((c) => c.top_y));
  assert.equal(res.data.target_y, expectedTarget);
});

test('level_ground --mode max picks the highest top (fill-only plan)', async () => {
  const { terrain } = synthesizeMessyField({
    minX: 0, maxX: 3, minZ: 0, maxZ: 3, groundY: 64,
    n_holes: 3, n_pillars: 3, seed: 99,
  });
  const part = makePart(makeMockBotWithTerrain(terrain));
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 3, z2: 3, mode: 'max' });
  assert.equal(res.ok, true);
  assert.equal(res.data.mode, 'max');
  // Target at the tallest pillar.
  const expectedTarget = Math.max(...res.data.columns
    .filter((c) => c.top_y !== null)
    .map((c) => c.top_y));
  assert.equal(res.data.target_y, expectedTarget);
  // No pillars to dig.
  assert.equal(res.data.summary.pillars_n, 0);
});

test('level_ground: explicit target overrides mode', async () => {
  const { terrain } = synthesizeMessyField({
    minX: 0, maxX: 3, minZ: 0, maxZ: 3, groundY: 64, n_holes: 2, n_pillars: 2, seed: 11,
  });
  const part = makePart(makeMockBotWithTerrain(terrain));
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 3, z2: 3, target: 67, mode: 'min' });
  assert.equal(res.ok, true);
  assert.equal(res.data.target_y, 67);
  assert.equal(res.data.mode, 'explicit');
});

test('level_ground: rejects over-256-column rectangles', async () => {
  const part = makePart(makeMockBotWithTerrain(new Map()));
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 16, z2: 16 });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'OUT_OF_RANGE');
});

test('level_ground: rejects invalid mode', async () => {
  const part = makePart(makeMockBotWithTerrain(new Map()));
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 2, z2: 2, mode: 'average' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'INVALID_VALUE');
});

test('level_ground: invalid coords return INVALID_COORD', async () => {
  const part = makePart(makeMockBotWithTerrain(new Map()));
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 'bogus', z2: 5 });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'INVALID_COORD');
});

test('level_ground: returns NO_SURFACE when no column has a solid block', async () => {
  // Empty terrain — every column reads air down to bedrock. The mock's
  // game.minY is -64 so columnTopSolid scans 384 levels and finds none.
  const part = makePart(makeMockBotWithTerrain(new Map()));
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 2, z2: 2 });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'NO_SURFACE');
});

test('level_ground: dry-run by default (no executed flag, helpful result string)', async () => {
  const { terrain } = synthesizeMessyField({
    minX: 0, maxX: 3, minZ: 0, maxZ: 3, groundY: 64, n_holes: 2, n_pillars: 2, seed: 1,
  });
  const part = makePart(makeMockBotWithTerrain(terrain));
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 3, z2: 3 });
  assert.equal(res.ok, true);
  assert.equal(res.data.executed, undefined);
  assert.match(res.result, /dry-run/);
  assert.match(res.result, /pass execute=true/);
});

test('level_ground execute=true calls the level handler with computed target + up_range', async () => {
  const { terrain } = synthesizeMessyField({
    minX: 0, maxX: 3, minZ: 0, maxZ: 3, groundY: 64,
    n_holes: 2, n_pillars: 2, max_pillar_height: 4, seed: 5,
  });
  let levelCall = null;
  const part = createBuildingTerrainPart({
    ctx: { runtime: { regions: null, recentPlaces: [] } },
    config: { behaviors: {} },
    ensureBot: () => makeMockBotWithTerrain(terrain),
    sleep: async () => {},
    getActions: () => ({
      // Spy on the level call so we can assert what level_ground delegates.
      async level(args) {
        levelCall = args;
        return { ok: true, data: { dug: 7, placed: 4, skipped: 0, failed: 0 } };
      },
    }),
  });
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 3, z2: 3, execute: true });
  assert.equal(res.ok, true);
  assert.equal(res.data.executed, true);
  assert.ok(levelCall, 'level handler should have been called');
  assert.equal(levelCall.y, res.data.target_y);
  assert.equal(levelCall.up, res.data.up_range_recommended);
  assert.equal(levelCall.x1, 0);
  assert.equal(levelCall.x2, 3);
  // Execute result threaded back into the response data.
  assert.equal(res.data.execute_result.dug, 7);
  assert.equal(res.data.execute_result.placed, 4);
  assert.match(res.result, /executed/);
});

test('level_ground: accepts surface_y as input (= target + 1)', async () => {
  const { terrain } = synthesizeMessyField({
    minX: 0, maxX: 3, minZ: 0, maxZ: 3, groundY: 64, n_holes: 2, n_pillars: 2, seed: 11,
  });
  const part = makePart(makeMockBotWithTerrain(terrain));
  // surface_y=65 → expect block_y=64 selected
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 3, z2: 3, surface_y: 65 });
  assert.equal(res.ok, true);
  assert.equal(res.data.block_y, 64);
  assert.equal(res.data.surface_y, 65);
  assert.equal(res.data.target_y, 64);  // legacy alias still present
  assert.equal(res.data.mode, 'explicit');
});

test('level_ground: surface_y wins when both target and surface_y are given', async () => {
  const { terrain } = synthesizeMessyField({
    minX: 0, maxX: 3, minZ: 0, maxZ: 3, groundY: 64, n_holes: 1, n_pillars: 1, seed: 12,
  });
  const part = makePart(makeMockBotWithTerrain(terrain));
  // target=99 (block_y) AND surface_y=65 → surface_y wins → block_y=64
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 3, z2: 3, target: 99, surface_y: 65 });
  assert.equal(res.ok, true);
  assert.equal(res.data.block_y, 64);
  assert.equal(res.data.surface_y, 65);
});

test('level_ground: returns block_y + surface_y on every column entry', async () => {
  const { terrain } = synthesizeMessyField({
    minX: 0, maxX: 3, minZ: 0, maxZ: 3, groundY: 64, n_holes: 0, n_pillars: 0,
  });
  const part = makePart(makeMockBotWithTerrain(terrain));
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 3, z2: 3 });
  assert.equal(res.ok, true);
  for (const c of res.data.columns) {
    assert.equal(c.top_block_y, 64);
    assert.equal(c.top_surface_y, 65);
    assert.equal(c.top_block, 'grass_block');  // synthesizer baseline
    assert.equal(c.top_y, 64);  // legacy alias
  }
});

test('level_ground: structural blocks above target → action=preserve, not dig', async () => {
  // Build a 3×3 field: flat dirt at Y=64 in all 9 cells, plus an oak_log at
  // Y=65 in the center column. Without structural classification this would
  // be planned as action=dig with delta=1. With it, action=preserve.
  const minX = 0, maxX = 2, minZ = 0, maxZ = 2;
  const groundY = 64;
  const { terrain } = synthesizeMessyField({
    minX, maxX, minZ, maxZ, groundY, n_holes: 0, n_pillars: 0,
  });
  // Inject a structural block above center
  terrain.set(`1,${groundY + 1},1`, { name: 'oak_log' });
  const part = makePart(makeMockBotWithTerrain(terrain));
  const res = await part.level_ground({ x1: minX, z1: minZ, x2: maxX, z2: maxZ });
  assert.equal(res.ok, true);
  // Center column should now be classified as preserve
  const center = res.data.columns.find((c) => c.x === 1 && c.z === 1);
  assert.ok(center);
  assert.equal(center.action, 'preserve');
  assert.equal(center.top_block, 'oak_log');
  // Summary counts preserved_n
  assert.equal(res.data.summary.preserved_n, 1);
  // structural_columns array lists it
  assert.equal(res.data.structural_columns.length, 1);
  assert.equal(res.data.structural_columns[0].block_name, 'oak_log');
  // Pillar count stays 0 — log is preserved, not counted as a pillar to dig
  assert.equal(res.data.summary.pillars_n, 0);
});

test('level_ground: palette_observed counts blocks per type', async () => {
  // 4×4 field with dirt baseline + 2 cobblestone pillars
  const minX = 0, maxX = 3, minZ = 0, maxZ = 3;
  const { terrain } = synthesizeMessyField({
    minX, maxX, minZ, maxZ, groundY: 64,
    n_holes: 0, n_pillars: 2, seed: 7,
  });
  const part = makePart(makeMockBotWithTerrain(terrain));
  const res = await part.level_ground({ x1: minX, z1: minZ, x2: maxX, z2: maxZ });
  assert.equal(res.ok, true);
  // 14 grass_block baseline + 2 cobblestone pillar tops
  assert.equal(res.data.palette_observed.grass_block, 14);
  assert.equal(res.data.palette_observed.cobblestone, 2);
});

test('level_ground execute=true surfaces underlying level errors without blowing up', async () => {
  const { terrain } = synthesizeMessyField({
    minX: 0, maxX: 2, minZ: 0, maxZ: 2, groundY: 64, n_holes: 1, n_pillars: 1, seed: 3,
  });
  const part = createBuildingTerrainPart({
    ctx: { runtime: { regions: null, recentPlaces: [] } },
    config: { behaviors: {} },
    ensureBot: () => makeMockBotWithTerrain(terrain),
    sleep: async () => {},
    getActions: () => ({
      async level() {
        return { ok: false, error: { code: 'MISSING_INVENTORY', message: 'no fill in inventory' } };
      },
    }),
  });
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 2, z2: 2, execute: true });
  assert.equal(res.ok, false);
  assert.match(res.data.execute_error, /no fill in inventory/);
  assert.match(res.result, /execute FAILED/);
});

// ─── level (direct) — region-aware palette default ────────────────────────
// Validates that without an explicit `block=` arg, `mc level` inside a
// protect-intent base region defaults to cobblestone (the base profile's
// region palette) instead of the generic tier_1 cascade that starts with
// dirt. This is the patchwork-prevention behavior from phase C1.

test('level: region palette default — base region → cobblestone before dirt', async () => {
  // Mock region store: returns a protect region with profile=base at the
  // bbox center query.
  const fakeRegionStore = {
    at(x, y, z) {
      return [{ id: 'base', intent: 'protect', profile: 'base', capabilities: {} }];
    },
  };

  // Synthesize a 2×2 area with no work to do (so `level` exercises just
  // the cascade selection without any actual placement).
  const minX = 0, maxX = 1, minZ = 0, maxZ = 1;
  const groundY = 64;
  const terrain = new Map();
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      terrain.set(`${x},${groundY},${z}`, { name: 'cobblestone' });  // already at target
    }
  }
  const bot = makeMockBotWithTerrain(terrain);
  const part = createBuildingTerrainPart({
    ctx: { runtime: { regions: fakeRegionStore, recentPlaces: [] } },
    config: { behaviors: {} },
    ensureBot: () => bot,
    sleep: async () => {},
    getActions: () => null,
  });

  const res = await part.level({ x1: minX, z1: minZ, x2: maxX, z2: maxZ, y: groundY });
  assert.equal(res.ok, true);
  // Cascade should start with cobblestone (the base palette) and then fall
  // through to the tier_1 default cascade (dirt, sand, gravel, stone…).
  assert.equal(res.data.fill_cascade[0], 'cobblestone');
  assert.equal(res.data.fill_cascade_reason, 'region:base');
  // Block_y / surface_y reported correctly:
  assert.equal(res.data.block_y, groundY);
  assert.equal(res.data.surface_y, groundY + 1);
});

test('level: outside any region → tier_1 fill_default cascade (dirt first)', async () => {
  const fakeRegionStore = { at() { return []; } };
  const terrain = new Map();
  for (let x = 0; x <= 1; x++) for (let z = 0; z <= 1; z++) {
    terrain.set(`${x},64,${z}`, { name: 'dirt' });
  }
  const bot = makeMockBotWithTerrain(terrain);
  const part = createBuildingTerrainPart({
    ctx: { runtime: { regions: fakeRegionStore, recentPlaces: [] } },
    config: { behaviors: {} },
    ensureBot: () => bot,
    sleep: async () => {},
    getActions: () => null,
  });
  const res = await part.level({ x1: 0, z1: 0, x2: 1, z2: 1, y: 64 });
  assert.equal(res.ok, true);
  assert.equal(res.data.fill_cascade_reason, 'fill_default');
  assert.equal(res.data.fill_cascade[0], 'dirt');
});

test('level: explicit block= wins over region palette', async () => {
  const fakeRegionStore = {
    at() { return [{ id: 'base', intent: 'protect', profile: 'base', capabilities: {} }]; },
  };
  const terrain = new Map();
  for (let x = 0; x <= 1; x++) for (let z = 0; z <= 1; z++) {
    terrain.set(`${x},64,${z}`, { name: 'cobblestone' });
  }
  const bot = makeMockBotWithTerrain(terrain);
  const part = createBuildingTerrainPart({
    ctx: { runtime: { regions: fakeRegionStore, recentPlaces: [] } },
    config: { behaviors: {} },
    ensureBot: () => bot,
    sleep: async () => {},
    getActions: () => null,
  });
  const res = await part.level({ x1: 0, z1: 0, x2: 1, z2: 1, y: 64, block: 'sand' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.fill_cascade, ['sand']);
  assert.equal(res.data.fill_cascade_reason, 'explicit');
});

test('level: tier_2 fallback fill emits a hint and records placed_by_block', async () => {
  const fakeRegionStore = {
    at() { return []; },
    resolve() { return { decision: 'allow', reason: 'OUTSIDE_ALL_REGIONS', winning_region: null, losing_regions: [], matched_capability: null }; },
  };
  // 1×1 hole at Y=64 → needs exactly one fill placement. Bot inventory
  // carries oak_planks (tier_2) only; the cascade is fill_default
  // (dirt/sand/gravel/cobblestone/stone — all tier_1). When placing the
  // bot picks the first cascade item ACTUALLY IN INVENTORY, which is
  // none of the tier_1 set — so it falls through. To exercise the
  // tier_2 fallback we pass block=oak_planks explicitly (the cascade
  // becomes [oak_planks]) and verify the hint surfaces.
  const terrain = new Map();
  // No fill block at (0, 64, 0); bot must place something here.
  // Solid neighbor for placement:
  terrain.set(`0,64,1`, { name: 'cobblestone' });
  const bot = {
    entity: { position: { x: 0, y: 65, z: 0, distanceTo: () => 0 } },
    game: { minY: -64, height: 384 },
    inventory: { items: () => [{ name: 'oak_planks', count: 64 }] },
    blockAt({ x, y, z }) {
      const t = terrain.get(`${x},${y},${z}`);
      if (!t) return { name: 'air', boundingBox: 'empty', position: { x, y, z } };
      return { name: t.name, boundingBox: 'block', position: { x, y, z } };
    },
    equip: async () => {},
    placeBlock: async () => {},
  };
  const part = createBuildingTerrainPart({
    ctx: { runtime: { regions: fakeRegionStore, recentPlaces: [] } },
    config: { behaviors: {} },
    ensureBot: () => bot,
    sleep: async () => {},
    getActions: () => null,
  });
  const res = await part.level({ x1: 0, z1: 0, x2: 0, z2: 0, y: 64, block: 'oak_planks' });
  assert.equal(res.ok, true);
  // 1 cell filled with oak_planks
  assert.equal(res.data.placed_by_block.oak_planks, 1);
  // Tier-2 fallback hint surfaces both in data + result
  assert.ok(res.data.fill_fallback_hint);
  assert.match(res.data.fill_fallback_hint, /tier_2/);
  assert.match(res.data.fill_fallback_hint, /oak_planks/);
  assert.match(res.result, /tier_2\+ fallback/);
});

test('level: tier_1 fill emits NO fallback hint', async () => {
  const fakeRegionStore = {
    at() { return []; },
    resolve() { return { decision: 'allow', reason: 'OUTSIDE_ALL_REGIONS', winning_region: null, losing_regions: [], matched_capability: null }; },
  };
  const terrain = new Map();
  terrain.set(`0,64,1`, { name: 'cobblestone' });
  const bot = {
    entity: { position: { x: 0, y: 65, z: 0, distanceTo: () => 0 } },
    game: { minY: -64, height: 384 },
    inventory: { items: () => [{ name: 'dirt', count: 64 }] },
    blockAt({ x, y, z }) {
      const t = terrain.get(`${x},${y},${z}`);
      if (!t) return { name: 'air', boundingBox: 'empty', position: { x, y, z } };
      return { name: t.name, boundingBox: 'block', position: { x, y, z } };
    },
    equip: async () => {},
    placeBlock: async () => {},
  };
  const part = createBuildingTerrainPart({
    ctx: { runtime: { regions: fakeRegionStore, recentPlaces: [] } },
    config: { behaviors: {} },
    ensureBot: () => bot,
    sleep: async () => {},
    getActions: () => null,
  });
  const res = await part.level({ x1: 0, z1: 0, x2: 0, z2: 0, y: 64 });
  assert.equal(res.ok, true);
  assert.equal(res.data.placed_by_block.dirt, 1);
  assert.equal(res.data.fill_fallback_hint, undefined);
  assert.doesNotMatch(res.result, /tier_2/);
});

test('level: surface_y wins over y; block_y derived as surface_y - 1', async () => {
  const fakeRegionStore = { at() { return []; } };
  const terrain = new Map();
  for (let x = 0; x <= 1; x++) for (let z = 0; z <= 1; z++) {
    terrain.set(`${x},64,${z}`, { name: 'dirt' });
  }
  const bot = makeMockBotWithTerrain(terrain);
  const part = createBuildingTerrainPart({
    ctx: { runtime: { regions: fakeRegionStore, recentPlaces: [] } },
    config: { behaviors: {} },
    ensureBot: () => bot,
    sleep: async () => {},
    getActions: () => null,
  });
  // y=99 (block_y), surface_y=65 → surface_y wins, block_y becomes 64
  const res = await part.level({ x1: 0, z1: 0, x2: 1, z2: 1, y: 99, surface_y: 65 });
  assert.equal(res.ok, true);
  assert.equal(res.data.block_y, 64);
  assert.equal(res.data.surface_y, 65);
});
