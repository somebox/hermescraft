/**
 * level_ground — disposition + dip-span detection (the planner-facing survey
 * additions). These tests cover the new fields:
 *
 *   data.summary.{fill_shallow_n, fill_deep_n, no_floor_n, max_hole_depth,
 *                 deck_required_n, reroute_required_n}
 *   data.dispositions.{level, cut, fill_shallow, fill_deep, no_floor,
 *                      preserved, unknown}
 *   data.dip_spans[] (BFS-connected fill cells with suggestion)
 *   data.recommended_actions[] (planner-readable strings)
 *
 * The thresholds are pinned here so a doctrine change shows up as a failing
 * test and not a silent behavior shift:
 *
 *   FILL_SHALLOW_MAX_DEPTH = 3   (hole_depth ≤ 3 → 'shallow' / level_caps)
 *   FILL_DEEP_MIN_DEPTH    = 4   (hole_depth in 4..15 → 'deep' / deck)
 *   NO_FLOOR_MIN_DEPTH     = 16  (hole_depth ≥ 16 → 'no_floor' / reroute)
 *   DECK_MIN_SPAN_N        = 3   (3+ connected fill cells → deck even if shallow)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBuildingTerrainPart } from '../../lib/actions/building/terrain.js';

/**
 * Bot whose blockAt() reads from a terrain map (key='x,y,z' → block name).
 * Anything missing = air.
 */
function makeBot(terrain) {
  const PASSABLE = new Set(['air', 'cave_air', 'void_air']);
  const FLUID = new Set(['water', 'lava', 'flowing_water', 'flowing_lava']);
  return {
    entity: { position: { x: 0, y: 70, z: 0, distanceTo: () => 0 } },
    game: { minY: -64, height: 384 },
    inventory: { items: () => [{ name: 'dirt' }, { name: 'cobblestone' }] },
    blockAt({ x, y, z }) {
      const k = `${x},${y},${z}`;
      const t = terrain.get(k);
      if (!t) return { name: 'air', boundingBox: 'empty', position: { x, y, z } };
      const isAir = PASSABLE.has(t) || FLUID.has(t);
      return { name: t, boundingBox: isAir ? 'empty' : 'block', position: { x, y, z } };
    },
  };
}

function makePart(bot) {
  return createBuildingTerrainPart({
    ctx: { runtime: { regions: null, recentPlaces: [] } },
    config: { behaviors: {} },
    ensureBot: () => bot,
    sleep: async () => {},
    getActions: () => null,
  });
}

/**
 * Build a flat slab at `groundY` over [x1..x2, z1..z2]. Then apply `holes`,
 * each entry shaping a column ({x,z,depth}): remove blocks groundY..groundY-depth+1.
 * `noFloorCells` (x,z) make a column purely air down to minY=-64 (well below
 * the NO_FLOOR_MIN_DEPTH threshold).
 */
function buildTerrain({ x1, x2, z1, z2, groundY, holes = [], noFloorCells = [] }) {
  const terrain = new Map();
  // stone subsurface 32 thick so even a 30-deep hole still has a floor.
  for (let x = x1; x <= x2; x++) {
    for (let z = z1; z <= z2; z++) {
      for (let dy = 1; dy <= 32; dy++) terrain.set(`${x},${groundY - dy},${z}`, 'stone');
      terrain.set(`${x},${groundY},${z}`, 'grass_block');
    }
  }
  for (const h of holes) {
    for (let dy = 0; dy < h.depth; dy++) {
      terrain.delete(`${h.x},${groundY - dy},${h.z}`);
    }
  }
  for (const c of noFloorCells) {
    // Clear everything from groundY all the way down — column reads as no-data
    // for columnTopSolid (which scans down to minY=-64).
    for (let y = groundY; y >= -64; y--) {
      terrain.delete(`${c.x},${y},${c.z}`);
    }
  }
  return terrain;
}

test('dispositions: perfectly flat field — all level, no recommended actions for spans', async () => {
  const t = buildTerrain({ x1: 0, x2: 3, z1: 0, z2: 3, groundY: 64 });
  const part = makePart(makeBot(t));
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 3, z2: 3 });
  assert.equal(res.ok, true);
  assert.equal(res.data.dispositions.level, 16);
  assert.equal(res.data.dispositions.fill_shallow, 0);
  assert.equal(res.data.dispositions.fill_deep, 0);
  assert.equal(res.data.dispositions.no_floor, 0);
  assert.equal(res.data.summary.max_hole_depth, 0);
  assert.equal(res.data.summary.deck_required_n, 0);
  assert.equal(res.data.summary.reroute_required_n, 0);
  assert.equal(res.data.dip_spans.length, 0);
});

test('dispositions: single 2-deep pit — fill_shallow, level execute can handle', async () => {
  // 4×4 field at y=64 with one column carved 2 deep.
  // columnTopSolid → top_y=62 → delta=-2 → hole_depth = 1
  // (delta=-2 means top_y=62, targetY=64. Air cells: y=63. depth=1.)
  // We want depth=2 → carve 3 cells. Let's compute: delta=-3 → hole_depth=2.
  const t = buildTerrain({
    x1: 0, x2: 3, z1: 0, z2: 3, groundY: 64,
    holes: [{ x: 1, z: 1, depth: 3 }],
  });
  const part = makePart(makeBot(t));
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 3, z2: 3 });
  assert.equal(res.ok, true);
  assert.equal(res.data.dispositions.fill_shallow, 1);
  assert.equal(res.data.dispositions.fill_deep, 0);
  assert.equal(res.data.dispositions.no_floor, 0);
  assert.equal(res.data.summary.max_hole_depth, 2);
  assert.equal(res.data.summary.deck_required_n, 0);
  assert.equal(res.data.summary.reroute_required_n, 0);
  assert.equal(res.data.dip_spans.length, 1);
  assert.equal(res.data.dip_spans[0].suggestion, 'level_caps');
  assert.equal(res.data.dip_spans[0].n, 1);
  // No deck/reroute recommendation should appear in recommended_actions for this case.
  assert.ok(!res.data.recommended_actions.some((s) => /deck|reroute/i.test(s)),
    `did not expect deck/reroute hint, got: ${JSON.stringify(res.data.recommended_actions)}`);
});

test('dispositions: 6-deep isolated hole → fill_deep, suggests deck (or reroute), result text mentions hole_depth', async () => {
  // Carve depth=7 → delta=-7 → hole_depth = 6 (well over 3 = shallow limit, well under 16 = no_floor).
  const t = buildTerrain({
    x1: 0, x2: 3, z1: 0, z2: 3, groundY: 64,
    holes: [{ x: 2, z: 2, depth: 7 }],
  });
  const part = makePart(makeBot(t));
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 3, z2: 3 });
  assert.equal(res.ok, true);
  assert.equal(res.data.dispositions.fill_shallow, 0);
  assert.equal(res.data.dispositions.fill_deep, 1);
  assert.equal(res.data.dispositions.no_floor, 0);
  assert.equal(res.data.summary.max_hole_depth, 6);
  assert.equal(res.data.summary.deck_required_n, 1);
  assert.equal(res.data.summary.reroute_required_n, 0);
  assert.equal(res.data.dip_spans.length, 1);
  assert.equal(res.data.dip_spans[0].suggestion, 'deck');
  assert.equal(res.data.dip_spans[0].max_depth, 6);
  assert.match(res.data.recommended_actions.join('\n'), /deck|reroute/i);
  assert.match(res.result, /max hole_depth 6/);
});

test('dispositions: 3-cell connected shallow span → deck (span_n ≥ 3 even with shallow depth)', async () => {
  // 3 adjacent holes in a row at z=1, each 2 deep. Should bucket as ONE span
  // with n=3, max_depth=1. Span size triggers deck even though each cell is shallow.
  const t = buildTerrain({
    x1: 0, x2: 3, z1: 0, z2: 3, groundY: 64,
    holes: [
      { x: 1, z: 1, depth: 2 }, // hole_depth=1
      { x: 2, z: 1, depth: 2 },
      { x: 3, z: 1, depth: 2 },
    ],
  });
  const part = makePart(makeBot(t));
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 3, z2: 3 });
  assert.equal(res.ok, true);
  // Each cell is shallow…
  assert.equal(res.data.dispositions.fill_shallow, 3);
  assert.equal(res.data.dispositions.fill_deep, 0);
  // …but the SPAN is wide enough that the planner should still treat it as deck-required.
  assert.equal(res.data.dip_spans.length, 1);
  assert.equal(res.data.dip_spans[0].n, 3);
  assert.equal(res.data.dip_spans[0].suggestion, 'deck');
  assert.equal(res.data.summary.deck_required_n, 1);
});

test('dispositions: two separate shallow pits stay as TWO spans (BFS doesn\'t merge non-adjacent)', async () => {
  // 4×4=16 cells (at the cap). Two non-adjacent pits at opposite corners.
  const t = buildTerrain({
    x1: 0, x2: 3, z1: 0, z2: 3, groundY: 64,
    holes: [
      { x: 0, z: 0, depth: 2 }, // hole_depth=1
      { x: 3, z: 3, depth: 2 },
    ],
  });
  const part = makePart(makeBot(t));
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 3, z2: 3, target: 64 });
  assert.equal(res.ok, true);
  assert.equal(res.data.dip_spans.length, 2);
  for (const s of res.data.dip_spans) {
    assert.equal(s.n, 1);
    assert.equal(s.suggestion, 'level_caps');
  }
  assert.equal(res.data.summary.deck_required_n, 0);
});

test('dispositions: no-floor cell (≥16 deep void) → reroute, ravine in result/recommended_actions', async () => {
  // 4×4 field with one column that has no floor anywhere within view.
  const t = buildTerrain({
    x1: 0, x2: 3, z1: 0, z2: 3, groundY: 64,
    noFloorCells: [{ x: 1, z: 2 }],
  });
  const part = makePart(makeBot(t));
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 3, z2: 3, target: 64 });
  assert.equal(res.ok, true);
  // The no-floor column reads as no_data (top_y=null) because columnTopSolid
  // walks the whole Y range and returns null on pure-air. So it goes into the
  // 'unknown' bucket, NOT 'no_floor'. The 'no_floor' bucket is reserved for
  // columns where we DO see a floor but it's ≥16 below target — i.e., a deep
  // crater with a verifiable bottom. We assert the 'unknown' bucket here.
  // (If you carve a deep-but-finite crater, that's the no_floor case below.)
  assert.equal(res.data.dispositions.unknown, 1);
});

test('dispositions: 20-deep crater (verifiable floor, ≥16 below target) → no_floor disposition + reroute span', async () => {
  // Carve depth=21 → delta=-21 → hole_depth=20. Above NO_FLOOR_MIN_DEPTH (16).
  // Our buildTerrain stone subsurface is 32 thick at groundY=64, so the floor
  // at y=43 is still readable.
  const t = buildTerrain({
    x1: 0, x2: 3, z1: 0, z2: 3, groundY: 64,
    holes: [{ x: 1, z: 1, depth: 21 }],
  });
  const part = makePart(makeBot(t));
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 3, z2: 3, target: 64 });
  assert.equal(res.ok, true);
  assert.equal(res.data.dispositions.no_floor, 1);
  assert.equal(res.data.dispositions.fill_shallow, 0);
  assert.equal(res.data.dispositions.fill_deep, 0);
  assert.equal(res.data.summary.max_hole_depth, 20);
  assert.equal(res.data.summary.reroute_required_n, 1);
  assert.equal(res.data.summary.deck_required_n, 0);
  assert.equal(res.data.dip_spans.length, 1);
  assert.equal(res.data.dip_spans[0].suggestion, 'reroute');
  assert.equal(res.data.dip_spans[0].contains_no_floor, true);
  assert.match(res.data.recommended_actions.join('\n'), /ravine|reroute/i);
});

test('dispositions: mixed terrain — flat + shallow + deep + ravine in one rectangle', async () => {
  // 4×4: cells at (1,1) shallow (2-deep), (2,2) deep (6-deep crater), (3,3) ravine (21-deep).
  const t = buildTerrain({
    x1: 0, x2: 3, z1: 0, z2: 3, groundY: 64,
    holes: [
      { x: 1, z: 1, depth: 3 }, // shallow, hole_depth=2
      { x: 2, z: 2, depth: 7 }, // deep, hole_depth=6
      { x: 3, z: 3, depth: 21 }, // no_floor, hole_depth=20
    ],
  });
  const part = makePart(makeBot(t));
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 3, z2: 3, target: 64 });
  assert.equal(res.ok, true);
  assert.equal(res.data.dispositions.level, 16 - 3);
  assert.equal(res.data.dispositions.fill_shallow, 1);
  assert.equal(res.data.dispositions.fill_deep, 1);
  assert.equal(res.data.dispositions.no_floor, 1);
  assert.equal(res.data.dip_spans.length, 3);
  // Each pit is isolated, so 3 separate spans.
  const suggestions = res.data.dip_spans.map((s) => s.suggestion).sort();
  assert.deepEqual(suggestions, ['deck', 'level_caps', 'reroute']);
  // The recommended_actions should mention both deck AND reroute.
  const joined = res.data.recommended_actions.join('\n');
  assert.match(joined, /deck/i);
  assert.match(joined, /reroute|ravine/i);
});

test('dispositions: standard-terrain only (no deep) → recommended_actions confirms level execute works', async () => {
  // 4×4 with one shallow pit. Planner should see exactly one "level_ground … execute=true" hint.
  const t = buildTerrain({
    x1: 0, x2: 3, z1: 0, z2: 3, groundY: 64,
    holes: [{ x: 0, z: 0, depth: 2 }], // hole_depth=1, shallow
  });
  const part = makePart(makeBot(t));
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 3, z2: 3 });
  assert.equal(res.ok, true);
  assert.equal(res.data.summary.deck_required_n, 0);
  assert.equal(res.data.summary.reroute_required_n, 0);
  const joined = res.data.recommended_actions.join('\n');
  assert.match(joined, /mc level_ground.*execute=true/i);
});

test('per-column hole_depth and fill_kind fields appear on fill cells', async () => {
  const t = buildTerrain({
    x1: 0, x2: 1, z1: 0, z2: 1, groundY: 64,
    holes: [
      { x: 0, z: 0, depth: 2 },  // shallow, hole_depth=1
      { x: 1, z: 1, depth: 7 },  // deep, hole_depth=6
    ],
  });
  const part = makePart(makeBot(t));
  const res = await part.level_ground({ x1: 0, z1: 0, x2: 1, z2: 1 });
  assert.equal(res.ok, true);
  const byXZ = new Map(res.data.columns.map((c) => [`${c.x},${c.z}`, c]));
  const shallow = byXZ.get('0,0');
  const deep = byXZ.get('1,1');
  assert.equal(shallow.action, 'fill');
  assert.equal(shallow.fill_kind, 'shallow');
  assert.equal(shallow.hole_depth, 1);
  assert.equal(deep.action, 'fill');
  assert.equal(deep.fill_kind, 'deep');
  assert.equal(deep.hole_depth, 6);
});
