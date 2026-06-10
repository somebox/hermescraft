/**
 * clear_strip action contract tests.
 *
 * Tests the road-tier clearing primitive: survey + auto-batch dig_area calls
 * to remove all blocks ABOVE a road surface in a corridor strip. Covers:
 *  - input validation
 *  - dry-run accounting (would_dig, removed_by_block, skipped_*)
 *  - already-clear short-circuit (no dig_area calls)
 *  - terrain clearing (live path, batched dig_area)
 *  - structural preservation off (default) vs road_mode=true
 *  - tier_4 always preserved
 *  - oversize cap returns OUT_OF_RANGE
 *  - auto-batching keeps each dig_area call ≤32 cells even when total > 32
 *
 * ADR: docs/reference/bot/handler-contract-adr.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createBuildingRoadPart } from '../../lib/actions/building/road.js';
import { assertFailure, assertContract } from '../_helpers/action-harness.js';

/**
 * Build a synthetic world that returns a specific block name at certain (x,y,z)
 * cells and 'air' everywhere else.
 *
 * @param {Record<string,string>} fixedBlocks  key = "x,y,z", value = block name
 */
function makeBot(fixedBlocks = {}) {
  return {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    inventory: { items: () => [] },
    blockAt: (p) => {
      const k = `${p.x},${p.y},${p.z}`;
      const name = fixedBlocks[k] || 'air';
      const bbox = name === 'air' ? 'empty' : 'block';
      return { name, boundingBox: bbox, position: p };
    },
  };
}

/**
 * Build a road part whose dig_area mock records every call and reports a
 * simple dug-count = (volume - 1) so we can verify batching + propagation.
 */
function makeRoadPart({ bot, digAreaCalls, digAreaImpl }) {
  const handlers = {
    dig_area: digAreaImpl || (async (args) => {
      digAreaCalls.push(args);
      const w = Math.abs(args.x2 - args.x1) + 1;
      const h = Math.abs(args.y2 - args.y1) + 1;
      const l = Math.abs(args.z2 - args.z1) + 1;
      const volume = w * h * l;
      return { ok: true, dug: volume, skipped: 0, errors: [] };
    }),
    pickup: async () => ({ ok: true }),
  };
  return createBuildingRoadPart({
    ctx: {},
    ensureBot: () => bot,
    getActions: () => handlers,
  });
}

test('clear_strip: missing y → INVALID_COORD', async () => {
  const calls = [];
  const part = makeRoadPart({ bot: makeBot(), digAreaCalls: calls });
  const r = await part.clear_strip({ x1: 0, z1: 0, x2: 2, z2: 2 });
  assertFailure(r, { code: 'INVALID_COORD', messageIncludes: 'y', retrySafe: false });
  assert.equal(calls.length, 0);
});

test('clear_strip: surface_y is rejected during the Y-semantics migration (phase 1)', async () => {
  // surface_y historically meant the BED block Y here, clashing with the
  // canonical vocabulary (feet = block_y + 1). Phase 1 rejects it loudly so
  // no caller silently builds off-by-one; phase 2 reintroduces it as feet.
  const calls = [];
  const part = makeRoadPart({ bot: makeBot(), digAreaCalls: calls });
  const r = await part.clear_strip({ x1: 0, z1: 0, x2: 2, z2: 2, surface_y: 78 });
  assertFailure(r, {
    code: 'INVALID_COORD',
    messageIncludes: ['surface_y', 'y='],
    retrySafe: false,
  });
  assert.equal(calls.length, 0);
});

test('clear_strip: response carries the canonical block_y/surface_y pair for the bed', async () => {
  const calls = [];
  const part = makeRoadPart({ bot: makeBot(), digAreaCalls: calls });
  const r = await part.clear_strip({ x1: 0, z1: 0, x2: 0, z2: 0, y: 78, dry_run: true });
  assertContract(r);
  assert.equal(r.data.block_y, 78);
  assert.equal(r.data.surface_y, 79, 'surface_y in the RESPONSE is canonical feet (= block_y + 1)');
});

test('clear_strip: oversize volume → OUT_OF_RANGE', async () => {
  const calls = [];
  const part = makeRoadPart({ bot: makeBot(), digAreaCalls: calls });
  // 33×33×4 = 4356 > 1024 default cap
  const r = await part.clear_strip({ x1: 0, z1: 0, x2: 32, z2: 32, y: 78, height: 4 });
  assertFailure(r, {
    code: 'OUT_OF_RANGE',
    messageIncludes: 'exceeds',
    observedKeys: ['requested_volume', 'max_volume', 'bounds'],
    retrySafe: false,
  });
  assert.equal(calls.length, 0);
});

test('clear_strip: empty corridor (all air) short-circuits with no dig_area calls', async () => {
  const calls = [];
  const part = makeRoadPart({ bot: makeBot({}), digAreaCalls: calls });
  const r = await part.clear_strip({ x1: 0, z1: 0, x2: 2, z2: 11, y: 78, height: 4 });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.dug, 0);
  assert.equal(r.data.would_dig, 0);
  assert.equal(r.data.present_non_air, 0);
  assert.equal(r.data.batches, 0);
  assert.equal(calls.length, 0, 'no dig_area calls should have been issued');
  assert.match(r.result, /already clear/i);
});

test('clear_strip: dry_run returns accounting without dig_area calls', async () => {
  const fixed = {};
  // Put a 3×3 patch of grass at y=79 (just above the bed at y=78)
  for (let x = 0; x <= 2; x++) {
    for (let z = 0; z <= 2; z++) {
      fixed[`${x},79,${z}`] = 'grass_block';
    }
  }
  const calls = [];
  const part = makeRoadPart({ bot: makeBot(fixed), digAreaCalls: calls });
  const r = await part.clear_strip({
    x1: 0, z1: 0, x2: 2, z2: 2, y: 78, height: 4, dry_run: true,
  });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.mode, 'dry_run');
  assert.equal(r.data.would_dig, 9);
  assert.equal(r.data.present_non_air, 9);
  assert.equal(r.data.removed_by_block.grass_block, 9);
  assert.equal(r.data.skipped_tier4, 0);
  assert.equal(r.data.skipped_structural, 0);
  assert.equal(calls.length, 0, 'dry_run must not call dig_area');
});

test('clear_strip: structural (oak_log) preserved by default, cleared in road_mode', async () => {
  const fixed = {
    // Tree trunk: 4 oak_log blocks at (1, 79..82, 1)
    '1,79,1': 'oak_log',
    '1,80,1': 'oak_log',
    '1,81,1': 'oak_log',
    '1,82,1': 'oak_log',
  };
  // Default (road_mode=false): trunk preserved
  {
    const calls = [];
    const part = makeRoadPart({ bot: makeBot(fixed), digAreaCalls: calls });
    const r = await part.clear_strip({
      x1: 0, z1: 0, x2: 2, z2: 2, y: 78, height: 4, dry_run: true,
    });
    assertContract(r);
    assert.equal(r.data.would_dig, 0);
    assert.equal(r.data.skipped_structural, 4);
    assert.equal(r.data.removed_by_block.oak_log, undefined);
  }
  // road_mode=true: trunk in the dig list
  {
    const calls = [];
    const part = makeRoadPart({ bot: makeBot(fixed), digAreaCalls: calls });
    const r = await part.clear_strip({
      x1: 0, z1: 0, x2: 2, z2: 2, y: 78, height: 4, dry_run: true, road_mode: true,
    });
    assertContract(r);
    assert.equal(r.data.would_dig, 4);
    assert.equal(r.data.skipped_structural, 0);
    assert.equal(r.data.removed_by_block.oak_log, 4);
  }
});

test('clear_strip: tier_4 (diamond_block) always skipped — even in road_mode', async () => {
  const fixed = { '0,79,0': 'diamond_block' };
  const calls = [];
  const part = makeRoadPart({ bot: makeBot(fixed), digAreaCalls: calls });
  const r = await part.clear_strip({
    x1: 0, z1: 0, x2: 0, z2: 0, y: 78, height: 4, dry_run: true, road_mode: true,
  });
  assertContract(r);
  assert.equal(r.data.would_dig, 0);
  assert.equal(r.data.skipped_tier4, 1);
  assert.equal(r.data.skipped_structural, 0);
});

test('clear_strip: the road-bed block (y) itself is never touched', async () => {
  // Put a block AT the bed y=78. It must be invisible to clear_strip.
  const fixed = { '0,78,0': 'stone', '0,79,0': 'grass_block' };
  const calls = [];
  const part = makeRoadPart({ bot: makeBot(fixed), digAreaCalls: calls });
  const r = await part.clear_strip({
    x1: 0, z1: 0, x2: 0, z2: 0, y: 78, height: 4, dry_run: true,
  });
  assertContract(r);
  assert.equal(r.data.would_dig, 1); // only the grass_block at y=79
  assert.equal(r.data.removed_by_block.grass_block, 1);
  assert.equal(r.data.removed_by_block.stone, undefined);
  assert.equal(r.data.bounds.y1, 79);
  assert.equal(r.data.bounds.y2, 82);
});

test('clear_strip: live path batches dig_area at ≤32 cells per call', async () => {
  // Fill a 3×12×4 = 144-cell strip with dirt so wouldDig=144.
  const fixed = {};
  for (let x = 0; x <= 2; x++) {
    for (let z = 0; z <= 11; z++) {
      for (let y = 79; y <= 82; y++) {
        fixed[`${x},${y},${z}`] = 'dirt';
      }
    }
  }
  const calls = [];
  const part = makeRoadPart({ bot: makeBot(fixed), digAreaCalls: calls });
  const r = await part.clear_strip({
    x1: 0, z1: 0, x2: 2, z2: 11, y: 78, height: 4,
  });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.would_dig, 144);
  assert.ok(calls.length > 0, 'must have issued dig_area calls');
  for (const c of calls) {
    const w = Math.abs(c.x2 - c.x1) + 1;
    const h = Math.abs(c.y2 - c.y1) + 1;
    const l = Math.abs(c.z2 - c.z1) + 1;
    const vol = w * h * l;
    assert.ok(vol <= 32, `dig_area batch volume ${vol} exceeds 32-cell cap`);
  }
  // batches counter matches calls
  assert.equal(r.data.batches, calls.length);
  // dug count comes from the mock = sum of batch volumes
  const expectedDug = calls.reduce((acc, c) => {
    const w = Math.abs(c.x2 - c.x1) + 1;
    const h = Math.abs(c.y2 - c.y1) + 1;
    const l = Math.abs(c.z2 - c.z1) + 1;
    return acc + w * h * l;
  }, 0);
  assert.equal(r.data.dug, expectedDug);
});

test('clear_strip: live path propagates road_mode → force_structural on dig_area', async () => {
  const fixed = { '0,79,0': 'oak_log' };
  const calls = [];
  const part = makeRoadPart({ bot: makeBot(fixed), digAreaCalls: calls });
  const r = await part.clear_strip({
    x1: 0, z1: 0, x2: 0, z2: 0, y: 78, height: 1, road_mode: true,
  });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.ok(calls.length >= 1);
  for (const c of calls) {
    assert.equal(c.force_structural, true, 'road_mode must propagate as force_structural=true');
  }
});

test('clear_strip: handlers.dig_area missing → WIRING error (covers integration drift)', async () => {
  const part = createBuildingRoadPart({
    ctx: {},
    ensureBot: () => makeBot({ '0,79,0': 'grass_block' }),
    getActions: () => ({}), // no dig_area registered
  });
  const r = await part.clear_strip({
    x1: 0, z1: 0, x2: 0, z2: 0, y: 78, height: 1,
  });
  assertFailure(r, { code: 'WIRING', messageIncludes: 'dig_area', retrySafe: false });
});

test('clear_strip: batches capped at 3x3 = 9 cells per dig_area call (bot reach)', async () => {
  // 6×6 dirt at y=79 → 36 cells. Without the 3×3 cap, this would
  // become a single 6×6 = 36-cell batch (over dig_area's 32 cap anyway,
  // but the symptom we're guarding against is unreachable cells in a
  // batch larger than the bot's ~4.5-block reach).
  const fixed = {};
  for (let x = 0; x <= 5; x++) {
    for (let z = 0; z <= 5; z++) fixed[`${x},79,${z}`] = 'dirt';
  }
  const calls = [];
  const part = makeRoadPart({ bot: makeBot(fixed), digAreaCalls: calls });
  const r = await part.clear_strip({
    x1: 0, z1: 0, x2: 5, z2: 5, y: 78, height: 1,
  });
  assertContract(r);
  assert.equal(r.ok, true);
  for (const c of calls) {
    const w = Math.abs(c.x2 - c.x1) + 1;
    const l = Math.abs(c.z2 - c.z1) + 1;
    assert.ok(w <= 3 && l <= 3,
      `dig_area batch ${w}×${l} exceeds 3×3 cap (cell would be out of reach)`);
  }
});

test('clear_strip: batches snake across Z (alternate direction per X-chunk)', async () => {
  // 6×6 → 4 batches per Y layer (2 X-chunks × 2 Z-chunks).
  // X-chunk 0 (x=0..2): batches should go z=0..2 then z=3..5.
  // X-chunk 1 (x=3..5): batches should REVERSE to z=3..5 then z=0..2.
  const fixed = {};
  for (let x = 0; x <= 5; x++) {
    for (let z = 0; z <= 5; z++) fixed[`${x},79,${z}`] = 'dirt';
  }
  const calls = [];
  const part = makeRoadPart({ bot: makeBot(fixed), digAreaCalls: calls });
  await part.clear_strip({ x1: 0, z1: 0, x2: 5, z2: 5, y: 78, height: 1 });
  assert.equal(calls.length, 4, 'expected 4 batches for 6×6 single layer');
  // Batches 0, 1 = X-chunk 0; batches 2, 3 = X-chunk 1
  assert.equal(calls[0].x1, 0); assert.equal(calls[0].z1, 0);
  assert.equal(calls[1].x1, 0); assert.equal(calls[1].z1, 3);
  assert.equal(calls[2].x1, 3); assert.equal(calls[2].z1, 3); // reversed!
  assert.equal(calls[3].x1, 3); assert.equal(calls[3].z1, 0);
});

test('clear_strip: pickup is called per batch (drops stay near bot)', async () => {
  const fixed = {};
  for (let x = 0; x <= 5; x++) {
    for (let z = 0; z <= 5; z++) fixed[`${x},79,${z}`] = 'dirt';
  }
  const calls = [];
  let pickupCalls = 0;
  const bot = makeBot(fixed);
  const part = createBuildingRoadPart({
    ctx: {},
    config: {},
    ensureBot: () => bot,
    getActions: () => ({
      dig_area: async (args) => {
        calls.push(args);
        const w = Math.abs(args.x2 - args.x1) + 1;
        const l = Math.abs(args.z2 - args.z1) + 1;
        return { ok: true, dug: w * l, skipped: 0, errors: [] };
      },
      pickup: async () => { pickupCalls++; return { ok: true }; },
    }),
  });
  await part.clear_strip({ x1: 0, z1: 0, x2: 5, z2: 5, y: 78, height: 1 });
  // 4 batches → 4 per-batch pickups + 1 final pickup = 5
  assert.equal(pickupCalls, calls.length + 1,
    `expected one pickup per batch plus one final; got ${pickupCalls} for ${calls.length} batches`);
});

test('clear_strip: surfaces first dig_area tool-needed hint via data.first_hints', async () => {
  const fixed = { '0,79,0': 'dirt' };
  const calls = [];
  const bot = makeBot(fixed);
  const part = createBuildingRoadPart({
    ctx: {},
    config: {},
    ensureBot: () => bot,
    getActions: () => ({
      dig_area: async (args) => {
        calls.push(args);
        // Simulate the slow-dig refusal that the in-world trial revealed:
        // dig_area returns ok:true with errors[] populated but dug=0.
        return {
          ok: true,
          data: {
            dug: 0,
            skipped: 1,
            errors: ['(0,79,0): Refusing to dig dirt with "granite" (~25s break time ≥ 280 ticks). Equip a fitting tool (`mc equip wooden_shovel`).'],
          },
          dug: 0,
          skipped: 1,
        };
      },
      pickup: async () => ({ ok: true }),
    }),
  });
  const r = await part.clear_strip({
    x1: 0, z1: 0, x2: 0, z2: 0, y: 78, height: 1,
  });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.data.first_hints), 'expected data.first_hints to be populated');
  assert.ok(r.data.first_hints.length >= 1);
  assert.match(r.data.first_hints[0], /Refusing to dig/);
  assert.match(r.result, /first hint: .*Refusing to dig/);
});

// ─────────────────────────────────────────────────────────────────────────
// road_mode auto-fell — extension Phase 3 from W2-NAV-015 follow-up.
// When clear_strip's height window only covers the lowest trunk blocks,
// the upper trunk + connected canopy were left floating. The fix walks
// each touched trunk upward + BFSes attached leaves + digs the extras.
// ─────────────────────────────────────────────────────────────────────────

test('clear_strip road_mode: trunk extending above the rectangle gets felled', async () => {
  // Rectangle: x=0..0, z=0..0, bed y=78, height=2 (covers y=79, y=80).
  // Trunk: y=79..84 (6 logs, 4 above the rectangle).
  // Leaves: a small 3x3 crown at y=83 around the trunk.
  const fixed = {};
  for (let y = 79; y <= 84; y++) fixed[`0,${y},0`] = 'oak_log';
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      fixed[`${dx},83,${dz}`] = 'oak_leaves';
    }
  }
  const calls = [];
  const part = makeRoadPart({ bot: makeBot(fixed), digAreaCalls: calls });
  const r = await part.clear_strip({
    x1: 0, z1: 0, x2: 0, z2: 0, y: 78, height: 2, road_mode: true,
  });
  assertContract(r);
  assert.equal(r.ok, true);
  // In-rect: 2 logs (y=79, 80) dug via the main batch loop.
  // Extra (Phase 3): 4 logs (y=81..84) + 8 leaves at y=83.
  assert.ok(r.data.wood_blocks_removed >= 6,
    `expected ≥6 logs total (2 in-rect + 4 extension); got ${r.data.wood_blocks_removed}`);
  assert.ok(r.data.leaf_blocks_removed >= 8,
    `expected ≥8 leaves from canopy extension; got ${r.data.leaf_blocks_removed}`);
  // Extension counters surface separately too.
  assert.ok(r.data.extension, 'expected extension block in data when canopy was extended');
  assert.equal(r.data.extension.extra_logs_removed, 4);
  assert.equal(r.data.extension.extra_leaves_removed, 8);
});

test('clear_strip road_mode=false: no canopy extension (preserves legacy semantics)', async () => {
  // Same setup but road_mode=false. Structural blocks (oak_log) are
  // preserved by default; no canopy extension should run.
  const fixed = {};
  for (let y = 79; y <= 84; y++) fixed[`0,${y},0`] = 'oak_log';
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      fixed[`${dx},83,${dz}`] = 'oak_leaves';
    }
  }
  const calls = [];
  const part = makeRoadPart({ bot: makeBot(fixed), digAreaCalls: calls });
  const r = await part.clear_strip({
    x1: 0, z1: 0, x2: 0, z2: 0, y: 78, height: 2,
    // road_mode omitted (default false)
  });
  assertContract(r);
  assert.equal(r.ok, true);
  // road_mode=false: logs counted as skipped_structural, no dig.
  assert.equal(r.data.skipped_structural, 2);
  // No extension phase ran.
  assert.equal(r.data.wood_blocks_removed, 0);
  assert.equal(r.data.leaf_blocks_removed, 0);
  assert.equal(r.data.extension, undefined);
});

test('clear_strip road_mode: no tree in rect → no extension, no overhead', async () => {
  // Just snow_layer and tall_grass in the rectangle. road_mode=true but
  // no logs touched → Phase 3 short-circuits cleanly.
  const fixed = {};
  for (let x = 0; x <= 2; x++) {
    for (let z = 0; z <= 2; z++) {
      fixed[`${x},79,${z}`] = 'snow';
    }
  }
  const calls = [];
  const part = makeRoadPart({ bot: makeBot(fixed), digAreaCalls: calls });
  const r = await part.clear_strip({
    x1: 0, z1: 0, x2: 2, z2: 2, y: 78, height: 1, road_mode: true,
  });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.wood_blocks_removed, 0);
  assert.equal(r.data.leaf_blocks_removed, 0);
  assert.equal(r.data.extension, undefined);
});
