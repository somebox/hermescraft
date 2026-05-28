/**
 * Pillar geometry unit tests.
 *
 * pillar_step / pillar_down are mineflayer-heavy in their physics layer
 * (jump, placeBlock, ground polling). The COORDINATE arithmetic — what
 * cell to dig next, where to place the new block, what counts as
 * "surface reached" — is pure and unit-testable. These tests pin that
 * layer against a known matrix of input shapes (integer foot Y, slab
 * top, pre-dug holes), exposing the kind of off-by-one Y bug observed
 * in genesis run g-2026-05-27-10 if it lives in the geometry.
 *
 * Property targets:
 *   - findStandingBlockCell must walk to the correct cell across:
 *     integer Y, slab-top Y, fractional Y, foot-above-air.
 *   - computePillarTargetCell + expectedFootYAfterPillarStep must agree
 *     so that count=N from start yields foot-Y delta = N (no slab off-
 *     by-one).
 *   - nextPillarDownCell + reachedSurface must agree on layer when the
 *     bot's foot Y is settled (post-fall).
 *
 * Bug-catching property: from a slab (foot Y = 64.5), 1 pillar_step's
 * expected foot Y must be 65.5 (slab.top + 1.0), NOT 66.0. If the helper
 * stack predicts 66.0, the bot will report endY-startY = 2 for placed=1
 * (off-by-one in reporting) AND drift further on subsequent steps.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import {
  findStandingBlockCell,
  computePillarTargetCell,
  expectedFootYAfterPillarStep,
  nextPillarDownCell,
  reachedSurface,
  isPartialBlockShape,
  feetCellY,
  blockUnderFeetCellY,
} from '../../lib/actions/building/pillar-geometry.js';

/** Build a blockAt(pos) callable from a {key: blockSpec} map. */
function world(specs) {
  const m = new Map();
  for (const [key, spec] of Object.entries(specs)) {
    const [x, y, z] = key.split(',').map(Number);
    m.set(key, { ...spec, position: new Vec3(x, y, z) });
  }
  return (pos) => {
    const k = `${pos.x},${pos.y},${pos.z}`;
    return m.get(k) || { name: 'air', boundingBox: 'empty', position: pos };
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Y-convention helpers — feetCellY / blockUnderFeetCellY
//
// Same axis, two different cells. Pin both at every shape (integer Y,
// slab top, fractional mid-jump). Diverging usage caused the bugs this
// module documents.
// ─────────────────────────────────────────────────────────────────────────

test('Y-convention: feetCellY = floor(y+ε), blockUnderFeetCellY = floor(y-ε)', () => {
  // Integer foot Y (standing on full block top at cell 63 → foot Y = 64.0).
  assert.equal(feetCellY({ y: 64.0 }), 64,
    'foot on full block top: feet occupy cell 64');
  assert.equal(blockUnderFeetCellY({ y: 64.0 }), 63,
    'foot on full block top: standing on block 63');
});

test('Y-convention: slab top (foot Y = 64.5) — feet AND block-under both = 64', () => {
  // Slab occupies bottom half of cell.y=64; top face at y=64.5; foot Y = 64.5.
  // Both conventions converge to cell 64 (the slab itself).
  assert.equal(feetCellY({ y: 64.5 }), 64);
  assert.equal(blockUnderFeetCellY({ y: 64.5 }), 64);
});

test('Y-convention: fractional foot Y mid-jump — divergence only at integer Y', () => {
  // For non-integer foot Y safely INSIDE a cell (not within ε of the
  // boundary), the ±ε nudge doesn't cross a cell boundary — both helpers
  // return the same cell.
  assert.equal(feetCellY({ y: 65.4 }), 65);
  assert.equal(blockUnderFeetCellY({ y: 65.4 }), 65);
  assert.equal(feetCellY({ y: 65.7 }), 65);
  assert.equal(blockUnderFeetCellY({ y: 65.7 }), 65);
});

test('Y-convention: foot Y within ε of the cell-boundary above — feetCellY rounds up', () => {
  // y = 65.999 is essentially "at the floor of cell 66". feetCellY's +ε
  // pushes over the boundary → returns 66 (the next cell). This is
  // intentional: the bot's effective foot cell IS 66 at that point.
  // blockUnderFeetCellY's -ε stays in cell 65. Documenting the edge.
  assert.equal(feetCellY({ y: 65.999 }), 66, 'feet effectively in cell 66 at y≈66');
  assert.equal(blockUnderFeetCellY({ y: 65.999 }), 65, '-ε keeps it in cell 65');
});

test('Y-convention: foot Y just above integer (y=64.001) — both round to the same cell', () => {
  // y = 64.001 means foot is slightly above the cell-64 boundary (just
  // past integer Y=64). feetCellY's +ε: floor(64.002) = 64. blockUnderFeetCellY's
  // -ε: floor(64.000) = 64. Same cell.
  assert.equal(feetCellY({ y: 64.001 }), 64);
  assert.equal(blockUnderFeetCellY({ y: 64.001 }), 64);
});

test('Y-convention: negative epsilon prevents the integer-Y off-by-one in block lookup', () => {
  // The classic bug findStandingBlockCell guards against:
  //   floor(64.0) === 64 → would look for a block AT the bot's foot cell
  //   (which is AIR if the bot is standing — bot's feet are in the air-
  //   above-block cell), missing the actual standing block at 63.
  // The -0.001 nudge fixes this.
  assert.equal(blockUnderFeetCellY({ y: 64.0 }), 63,
    'integer foot Y must resolve to block-below, not air-at-foot');
});

// ─────────────────────────────────────────────────────────────────────────
// findStandingBlockCell — feet on full block, slab, air, fractional
// ─────────────────────────────────────────────────────────────────────────

test('pillar geom: foot on full-block top (integer y) → standing block is one below', () => {
  // Bot foot at (0.5, 64.0, 0.5) standing on top of block at y=63.
  const blockAt = world({
    '0,63,0': { boundingBox: 'block', name: 'cobblestone' },
  });
  const standing = findStandingBlockCell({ x: 0.5, y: 64.0, z: 0.5 }, blockAt);
  assert.ok(standing, 'should find a standing block');
  assert.equal(standing.position.y, 63);
  assert.equal(standing.name, 'cobblestone');
});

test('pillar geom: foot on slab top (y=64.5) → standing block is the slab at y=64', () => {
  // Slab fills bottom half of cell y=64; top face at y=64.5; foot Y = 64.5.
  const blockAt = world({
    '0,64,0': { boundingBox: 'block', name: 'oak_slab' },
  });
  const standing = findStandingBlockCell({ x: 0.5, y: 64.5, z: 0.5 }, blockAt);
  assert.ok(standing, 'should find a standing block (the slab)');
  assert.equal(standing.position.y, 64);
  assert.equal(standing.name, 'oak_slab');
});

test('pillar geom: foot exactly on integer y at full block boundary works (no off-by-one)', () => {
  // The -0.001 nudge in findStandingBlockCell prevents floor(64.0) = 64
  // from picking the air cell at y=64 instead of the block at y=63.
  const blockAt = world({
    '0,63,0': { boundingBox: 'block', name: 'stone' },
    // No block at y=64 → that cell is air.
  });
  const standing = findStandingBlockCell({ x: 0.5, y: 64.0, z: 0.5 }, blockAt);
  assert.equal(standing?.position.y, 63,
    `integer-y foot must resolve to block-below, not air-at-foot (got ${standing?.position.y})`);
});

test('pillar geom: foot floating in air just above feet block returns null within maxDown=1', () => {
  // Bot mid-jump at y=65.4 (foot above ground). Only block at y=63 exists.
  // feetY = floor(65.4 - 0.001) = 65. y=65 is air, y=64 is air (with default
  // maxDown=1 we probe y=65 and y=64). Both return non-'block' → null.
  const blockAt = world({
    '0,63,0': { boundingBox: 'block', name: 'stone' },
  });
  const standing = findStandingBlockCell({ x: 0.5, y: 65.4, z: 0.5 }, blockAt);
  assert.equal(standing, null,
    'mid-jump foot above the block-below should not resolve to a standing block');
});

test('pillar geom: maxDown=2 lets the probe reach two layers below feet', () => {
  // Same setup as the previous test but with maxDown=2 — should find the
  // block at y=63 since the probe now reaches y=63.
  const blockAt = world({
    '0,63,0': { boundingBox: 'block', name: 'stone' },
  });
  const standing = findStandingBlockCell({ x: 0.5, y: 65.4, z: 0.5 }, blockAt, 2);
  assert.equal(standing?.position.y, 63);
});

// ─────────────────────────────────────────────────────────────────────────
// computePillarTargetCell + expectedFootYAfterPillarStep
// ─────────────────────────────────────────────────────────────────────────

test('pillar geom: target cell is one Y above standing block', () => {
  const standing = { position: new Vec3(7, 63, -2) };
  assert.deepEqual(computePillarTargetCell(standing), { x: 7, y: 64, z: -2 });
});

test('pillar geom: expected foot Y after a pillar_step is targetY + 1 (full block top)', () => {
  // Placement at target cell y=64 creates a full block there. Bot stands
  // on top → foot Y = 64 + 1 = 65.
  const target = { x: 0, y: 64, z: 0 };
  assert.equal(expectedFootYAfterPillarStep(target), 65);
});

// ─────────────────────────────────────────────────────────────────────────
// Property: pillar_step count=N from full block raises foot by exactly N
// ─────────────────────────────────────────────────────────────────────────

test('pillar geom: PROPERTY pillar_step count=N from full block top → foot Y delta = N', () => {
  // Initial: foot at y=64.0 (on block at y=63). Simulate N pillar_steps:
  // each step finds standing block, computes target = standing.y+1,
  // expected post-step foot = target.y + 1. After step, the "new standing
  // block" is the just-placed block at y=target.y.
  for (let N = 1; N <= 5; N++) {
    let footY = 64.0;
    const placed = new Map();
    placed.set('0,63,0', { boundingBox: 'block', name: 'stone', position: new Vec3(0, 63, 0) });

    for (let step = 0; step < N; step++) {
      const blockAt = (pos) => placed.get(`${pos.x},${pos.y},${pos.z}`)
        || { name: 'air', boundingBox: 'empty', position: pos };
      const standing = findStandingBlockCell({ x: 0.5, y: footY, z: 0.5 }, blockAt);
      assert.ok(standing, `step ${step}: standing block must be found`);
      const target = computePillarTargetCell(standing);
      // Simulate placement.
      placed.set(`${target.x},${target.y},${target.z}`,
        { boundingBox: 'block', name: 'cobblestone', position: new Vec3(target.x, target.y, target.z) });
      footY = expectedFootYAfterPillarStep(target);
    }

    const reportedStart = 64;   // Math.floor(64.0)
    const reportedEnd = Math.floor(footY);
    assert.equal(reportedEnd - reportedStart, N,
      `pillar_step count=${N} from full-block top: expected delta=${N}, got ${reportedEnd - reportedStart} (footY=${footY})`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Property + KNOWN-BUG: pillar_step from slab off-by-one in reported Y
// ─────────────────────────────────────────────────────────────────────────

test('pillar geom: PROPERTY pillar_step from slab top — placed=N, reported floor-Y delta', () => {
  // Initial: slab fills bottom half of cell y=64; foot at y=64.5 (slab top).
  //
  // Step 1: standing = slab at y=64. target = y=65. After place, bot
  // jumps from foot=64.5, lands at foot=66 (top of new full block at y=65).
  // Floor delta this step: floor(66) - floor(64.5) = 66 - 64 = +2 for a
  // SINGLE pillar_step. Off-by-one.
  //
  // Status: production code now REFUSES pillar_step from a partial-block
  // start (PILLAR_FROM_PARTIAL_BLOCK guard) unless force=true, so this
  // math is unreachable on the happy path. The pure-geometry property is
  // still documented here because (a) force=true callers still hit it,
  // and (b) if someone removes the guard without addressing the math,
  // this test continues to flag the off-by-one as a known property.
  //
  // For N=2: step1 ends footY=66, step2 standing=block@65, target=66,
  // foot after = 67. Floor delta total = 67 - 64 = 3 for placed=2.
  // For N=3: floor delta = 4 for placed=3.
  for (let N = 1; N <= 4; N++) {
    let footY = 64.5;
    const placed = new Map();
    placed.set('0,64,0',
      { boundingBox: 'block', name: 'oak_slab', position: new Vec3(0, 64, 0) });

    for (let step = 0; step < N; step++) {
      const blockAt = (pos) => placed.get(`${pos.x},${pos.y},${pos.z}`)
        || { name: 'air', boundingBox: 'empty', position: pos };
      const standing = findStandingBlockCell({ x: 0.5, y: footY, z: 0.5 }, blockAt);
      const target = computePillarTargetCell(standing);
      placed.set(`${target.x},${target.y},${target.z}`,
        { boundingBox: 'block', name: 'cobblestone', position: new Vec3(target.x, target.y, target.z) });
      footY = expectedFootYAfterPillarStep(target);
    }

    const reportedStart = Math.floor(64.5);    // 64
    const reportedEnd = Math.floor(footY);
    const reportedDelta = reportedEnd - reportedStart;

    // Document the off-by-one: floor-delta exceeds placed by exactly 1
    // when the starting foot is on a slab top. If a future fix normalizes
    // this, change the assertion to `reportedDelta === N` and remove the
    // KNOWN-BUG marker.
    assert.equal(reportedDelta, N + 1,
      `KNOWN BUG: pillar_step from slab N=${N}: reported floor-delta=${reportedDelta}, ` +
      `expected ${N + 1} (real foot delta is +1.5 for first step, +1 thereafter, ` +
      `but floor-rounding the fractional start makes the report look like one extra). ` +
      `Mitigation: refuse to pillar_step from a slab, OR snap startY to the slab top ` +
      `(64.5 → 64.5) and report the delta as 64.5-based.`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// pillar_down geometry
// ─────────────────────────────────────────────────────────────────────────

test('pillar geom: nextPillarDownCell digs the cell directly under the foot block', () => {
  // Bot foot at y=64.0 (foot block is y=64, the cell the bot occupies as
  // standing space — actually under the bot's feet is y=63). Dig cell
  // should be y=64-1 = 63.
  const cell = nextPillarDownCell({ x: 0.3, y: 64.0, z: 0.7 });
  assert.deepEqual(cell, { x: 0, y: 63, z: 0 });
});

test('pillar geom: nextPillarDownCell from fractional foot Y still floors correctly', () => {
  // Bot mid-fall (foot Y = 64.7). Floor gives 64; dig target = 63.
  const cell = nextPillarDownCell({ x: 0.5, y: 64.7, z: 0.5 });
  assert.deepEqual(cell, { x: 0, y: 63, z: 0 });
});

test('pillar geom: reachedSurface true when 3+ cardinal neighbours have solid floor + air feet', () => {
  // Bot foot at (5.5, 64.0, 5.5). Cells at foot level (y=64) are air.
  // Floor cells (y=63) — 3 of 4 cardinals are stone, the 4th is air
  // (shaft continues that way). 3/4 → reached_surface.
  const blockAt = world({
    '6,63,5': { boundingBox: 'block', name: 'stone' },
    '4,63,5': { boundingBox: 'block', name: 'stone' },
    '5,63,6': { boundingBox: 'block', name: 'stone' },
    // '5,63,4' missing → air. Only 3 cardinals.
  });
  assert.equal(reachedSurface({ x: 5.5, y: 64.0, z: 5.5 }, blockAt), true);
});

test('pillar geom: reachedSurface false when ≤2 cardinals have solid floor', () => {
  // Only 2 of 4 cardinals have floor → still in a shaft (or pillar of 2
  // adjacent blocks). Should NOT report reached.
  const blockAt = world({
    '6,63,5': { boundingBox: 'block', name: 'stone' },
    '4,63,5': { boundingBox: 'block', name: 'stone' },
    // No floor on z+1 / z-1.
  });
  assert.equal(reachedSurface({ x: 5.5, y: 64.0, z: 5.5 }, blockAt), false);
});

test('pillar geom: reachedSurface false when a cardinal floor exists but the feet cell is also solid', () => {
  // Wall scenario: there's a solid block at neighbour foot level (the bot
  // can't walk into it). Should not count as a "walkable neighbour".
  const blockAt = world({
    '6,63,5': { boundingBox: 'block', name: 'stone' }, // floor exists
    '6,64,5': { boundingBox: 'block', name: 'stone' }, // ...but feet cell is also solid → blocked
    '4,63,5': { boundingBox: 'block', name: 'stone' },
    '5,63,6': { boundingBox: 'block', name: 'stone' },
    // Now only 2 of 4 are walkable.
  });
  assert.equal(reachedSurface({ x: 5.5, y: 64.0, z: 5.5 }, blockAt), false);
});

// ─────────────────────────────────────────────────────────────────────────
// pillar_down property: N digs from foot Y should land bot N blocks lower
// (assuming each dug cell has another block below it / floor settles).
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// isPartialBlockShape — used by pillar_step's PILLAR_FROM_PARTIAL_BLOCK guard
// to refuse starts from blocks whose top face is below the cell's +1.0
// boundary. False-positives here cause spurious refusals; false-negatives
// re-introduce the slab off-by-one. Worth a coverage matrix.
// ─────────────────────────────────────────────────────────────────────────

test('pillar geom: isPartialBlockShape recognizes slabs and stairs', () => {
  assert.equal(isPartialBlockShape('oak_slab'), true);
  assert.equal(isPartialBlockShape('cobblestone_slab'), true);
  assert.equal(isPartialBlockShape('stone_brick_slab'), true);
  assert.equal(isPartialBlockShape('oak_stairs'), true);
  assert.equal(isPartialBlockShape('cobblestone_stairs'), true);
  assert.equal(isPartialBlockShape('deepslate_brick_stairs'), true);
});

test('pillar geom: isPartialBlockShape recognizes carpet / snow_layer / trapdoor / fence_gate', () => {
  assert.equal(isPartialBlockShape('white_carpet'), true);
  assert.equal(isPartialBlockShape('snow_layer'), true);
  assert.equal(isPartialBlockShape('oak_trapdoor'), true);
  assert.equal(isPartialBlockShape('iron_trapdoor'), true);
  assert.equal(isPartialBlockShape('oak_fence_gate'), true);
});

test('pillar geom: isPartialBlockShape rejects full-cube blocks', () => {
  assert.equal(isPartialBlockShape('stone'), false);
  assert.equal(isPartialBlockShape('cobblestone'), false);
  assert.equal(isPartialBlockShape('oak_planks'), false);
  assert.equal(isPartialBlockShape('dirt'), false);
  assert.equal(isPartialBlockShape('grass_block'), false);
  assert.equal(isPartialBlockShape('iron_ore'), false);
});

test('pillar geom: isPartialBlockShape handles null/undefined/empty without throwing', () => {
  assert.equal(isPartialBlockShape(null), false);
  assert.equal(isPartialBlockShape(undefined), false);
  assert.equal(isPartialBlockShape(''), false);
});

test('pillar geom: isPartialBlockShape is NOT fooled by names with "slab"/"stairs" in the middle', () => {
  // Watch for false positives — names ending in slab/stairs are the target.
  // (Currently nothing in mcData fits this risk, but the regex anchors `$`
  // so a hypothetical "slabby_thing" wouldn't match. Lock that in.)
  assert.equal(isPartialBlockShape('slab_foo'), false);
  assert.equal(isPartialBlockShape('stairs_to_nowhere'), false);
});

test('pillar geom: PROPERTY pillar_down N digs lowers floor-Y by N when each cell has support', () => {
  // Stack of blocks from y=58..63 (column under the bot). Bot starts at
  // foot=64.0. Each "dig" removes the block directly under feet; the bot
  // falls one Y, foot becomes one lower. After N digs: foot at 64-N.
  for (let N = 1; N <= 5; N++) {
    const blocks = new Map();
    for (let y = 58; y <= 63; y++) {
      blocks.set(`0,${y},0`, { boundingBox: 'block', name: 'dirt', position: new Vec3(0, y, 0) });
    }
    let footY = 64.0;

    for (let step = 0; step < N; step++) {
      const cell = nextPillarDownCell({ x: 0.5, y: footY, z: 0.5 });
      // Simulate the dig: remove block at cell from the world.
      blocks.delete(`${cell.x},${cell.y},${cell.z}`);
      // Bot falls to top of next block below. Find it.
      let newFootY = cell.y; // candidate: foot rests where the dug cell USED to be
      // Walk downward until we hit a block (foot lands on top of it).
      for (let probeY = cell.y - 1; probeY >= 0; probeY--) {
        if (blocks.has(`0,${probeY},0`)) {
          newFootY = probeY + 1;
          break;
        }
      }
      footY = newFootY;
    }

    assert.equal(Math.floor(footY), 64 - N,
      `pillar_down N=${N}: expected floor(foot Y) = ${64 - N}, got ${Math.floor(footY)} (footY=${footY})`);
  }
});
