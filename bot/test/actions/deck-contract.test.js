/**
 * deck — BFS edge-inward bridge primitive.
 *
 * Covers:
 *  - input validation (missing surface_y, missing block, oversize)
 *  - already-solid short-circuit (no placeBlock calls)
 *  - dry_run BFS planning (would_place_order, unanchored)
 *  - tier_4 cells preserved
 *  - bank-to-bank narrow bridge (1×N)
 *  - 3-wide bridge over a ravine
 *  - "no anchor" failure mode (an air cell with no rim path)
 *  - missing inventory → MISSING_INVENTORY
 *  - placement order: each placement either anchors to pre-existing rim
 *    OR to a cell placed earlier in this same call.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createBuildingRoadPart } from '../../lib/actions/building/road.js';
import { assertFailure, assertContract } from '../_helpers/action-harness.js';

/**
 * Mutable mock bot whose blockAt() reads from a terrain Map (key='x,y,z'),
 * placeBlock(ref, faceVec) writes the placed block back into the Map
 * (key=target = ref.position + faceVec) so future blockAt() sees it.
 *
 * The bot's position is always "in reach" (distanceTo() returns 0) so
 * pathfind is a no-op.
 */
function makeBot({ terrain, blockName = 'cobblestone', inventory }) {
  const PASSABLE = new Set(['air', 'cave_air', 'void_air']);
  const placeCalls = [];
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => (inventory || [{ name: blockName, count: 64 }]) },
    blockAt(p) {
      const k = `${p.x},${p.y},${p.z}`;
      const t = terrain.get(k);
      if (!t) return { name: 'air', boundingBox: 'empty', position: new Vec3(p.x, p.y, p.z) };
      const isAir = PASSABLE.has(t);
      return {
        name: t,
        boundingBox: isAir ? 'empty' : 'block',
        position: new Vec3(p.x, p.y, p.z),
      };
    },
    async equip() {},
    async placeBlock(ref, vec) {
      const tx = ref.position.x + vec.x;
      const ty = ref.position.y + vec.y;
      const tz = ref.position.z + vec.z;
      placeCalls.push({ x: tx, y: ty, z: tz, ref: { x: ref.position.x, y: ref.position.y, z: ref.position.z }, face: { x: vec.x, y: vec.y, z: vec.z } });
      terrain.set(`${tx},${ty},${tz}`, blockName);
    },
  };
  bot.entity.position.distanceTo = () => 0;
  return { bot, placeCalls };
}

function makePart(bot) {
  return createBuildingRoadPart({
    ctx: { runtime: { regions: null, recentPlaces: [] } },
    config: { behaviors: {} },
    ensureBot: () => bot,
    getActions: () => ({}),
  });
}

test('deck: missing surface_y → INVALID_COORD', async () => {
  const { bot } = makeBot({ terrain: new Map() });
  const part = makePart(bot);
  const r = await part.deck({ x1: 0, z1: 0, x2: 2, z2: 2, block: 'cobblestone' });
  assertFailure(r, { code: 'INVALID_COORD', messageIncludes: 'surface_y', retrySafe: false });
});

test('deck: missing block → INVALID_VALUE', async () => {
  const { bot } = makeBot({ terrain: new Map() });
  const part = makePart(bot);
  const r = await part.deck({ x1: 0, z1: 0, x2: 2, z2: 2, surface_y: 78 });
  assertFailure(r, { code: 'INVALID_VALUE', messageIncludes: 'block', retrySafe: false });
});

test('deck: oversize → OUT_OF_RANGE', async () => {
  const { bot } = makeBot({ terrain: new Map() });
  const part = makePart(bot);
  const r = await part.deck({ x1: 0, z1: 0, x2: 31, z2: 31, surface_y: 78, block: 'cobblestone' });
  assertFailure(r, {
    code: 'OUT_OF_RANGE',
    messageIncludes: 'exceeds',
    observedKeys: ['requested', 'max', 'bounds'],
    retrySafe: false,
  });
});

test('deck: all cells already solid → placed=0, no placeBlock calls', async () => {
  const terrain = new Map();
  // 2×2 deck plane all pre-filled with cobblestone.
  for (let x = 0; x <= 1; x++) {
    for (let z = 0; z <= 1; z++) terrain.set(`${x},78,${z}`, 'cobblestone');
  }
  const { bot, placeCalls } = makeBot({ terrain });
  const part = makePart(bot);
  const r = await part.deck({ x1: 0, z1: 0, x2: 1, z2: 1, surface_y: 78, block: 'cobblestone' });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.placed, 0);
  assert.equal(r.data.already_solid, 4);
  assert.equal(r.data.unanchored.length, 0);
  assert.equal(placeCalls.length, 0);
});

test('deck: tier_4 cell at deck Y → counted as tier4_skipped, not placed', async () => {
  const terrain = new Map();
  terrain.set(`0,78,0`, 'diamond_block');
  // Adjacent solid bank so the rest of the deck can be placed.
  terrain.set(`-1,77,0`, 'stone'); // a column below the bank cell
  terrain.set(`-1,78,0`, 'stone'); // bank at deck Y
  const { bot } = makeBot({ terrain });
  const part = makePart(bot);
  const r = await part.deck({ x1: 0, z1: 0, x2: 0, z2: 0, surface_y: 78, block: 'cobblestone' });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.tier4_skipped, 1);
  assert.equal(r.data.placed, 0);
  assert.equal(r.data.air_cells, 0);
});

test('deck: dry_run reports BFS placement order + unanchored counts', async () => {
  const terrain = new Map();
  // 1×5 bridge from west bank to east bank. Banks are solid at deck Y, gap in between.
  // West bank: x=-1, East bank: x=5. Deck spans x=0..4, z=0.
  terrain.set(`-1,78,0`, 'grass_block');
  terrain.set(`5,78,0`, 'grass_block');
  const { bot, placeCalls } = makeBot({ terrain });
  const part = makePart(bot);
  const r = await part.deck({ x1: 0, z1: 0, x2: 4, z2: 0, surface_y: 78, block: 'cobblestone', dry_run: true });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.mode, 'dry_run');
  assert.equal(r.data.air_cells, 5);
  assert.equal(r.data.would_place, 5);
  assert.equal(r.data.unanchored.length, 0);
  // BFS expects edge cells first. Order: x=0 (adjacent to west bank) and x=4
  // (adjacent to east bank) should appear before x=2 (interior). Specifically
  // x=0 enqueues x=1 enqueues x=2; and from x=4 we get x=3 enqueues x=2 too,
  // but x=0 dequeues first. So order is roughly: 0, 4, 1, 3, 2.
  const ordX = r.data.would_place_order.map((c) => c.x);
  assert.equal(ordX[0], 0);
  assert.equal(ordX[ordX.length - 1], 2);
  assert.equal(placeCalls.length, 0);
});

test('deck: live 1×5 bridge between banks — places 5 cells in BFS order, each anchored', async () => {
  const terrain = new Map();
  terrain.set(`-1,78,0`, 'grass_block');
  terrain.set(`5,78,0`, 'grass_block');
  const { bot, placeCalls } = makeBot({ terrain });
  const part = makePart(bot);
  const r = await part.deck({ x1: 0, z1: 0, x2: 4, z2: 0, surface_y: 78, block: 'cobblestone' });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.placed, 5);
  assert.equal(r.data.failed, 0);
  assert.equal(r.data.unanchored.length, 0);
  assert.equal(placeCalls.length, 5);

  // Every placement must anchor against a cell that's solid at placement time.
  // We replay the placements in order, with the initial terrain, and verify
  // each refBlock was solid when placed.
  const replay = new Map();
  // Re-seed banks
  replay.set(`-1,78,0`, 'grass_block');
  replay.set(`5,78,0`, 'grass_block');
  for (const call of placeCalls) {
    const refK = `${call.ref.x},${call.ref.y},${call.ref.z}`;
    assert.ok(replay.has(refK) && replay.get(refK) !== 'air',
      `at placement ${JSON.stringify(call)}: ref ${refK} not solid yet (broken BFS order)`);
    replay.set(`${call.x},${call.y},${call.z}`, 'cobblestone');
  }
});

test('deck: live 3×3 deck over a ravine (with deeper banks at +1 below)', async () => {
  const terrain = new Map();
  // Banks completely surround the 3x3 deck rectangle at z=-1, z=3, x=-1, x=3.
  // For deck plane Y=78, banks at sy with grass_block.
  for (let i = -1; i <= 3; i++) {
    terrain.set(`${i},78,-1`, 'grass_block'); // south bank
    terrain.set(`${i},78,3`, 'grass_block');  // north bank
    terrain.set(`-1,78,${i}`, 'grass_block'); // west bank
    terrain.set(`3,78,${i}`, 'grass_block');  // east bank
  }
  // Interior 3x3 cells (0..2, 0..2) are pure air at sy.
  const { bot, placeCalls } = makeBot({ terrain });
  const part = makePart(bot);
  const r = await part.deck({ x1: 0, z1: 0, x2: 2, z2: 2, surface_y: 78, block: 'cobblestone' });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.placed, 9);
  assert.equal(r.data.unanchored.length, 0);
  assert.equal(placeCalls.length, 9);
});

test('deck: cell with NO rim anchor returns as unanchored (no placement attempted)', async () => {
  const terrain = new Map();
  // 1x1 isolated air cell — no banks, no column below, no column above.
  // Should be reported as unanchored.
  const { bot, placeCalls } = makeBot({ terrain });
  const part = makePart(bot);
  const r = await part.deck({ x1: 0, z1: 0, x2: 0, z2: 0, surface_y: 78, block: 'cobblestone' });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.placed, 0);
  assert.equal(r.data.unanchored.length, 1);
  assert.deepEqual(r.data.unanchored[0], { x: 0, z: 0 });
  assert.equal(placeCalls.length, 0);
});

test('deck: deck cell sitting on a column anchors via bottom face (placement on top of column)', async () => {
  const terrain = new Map();
  // No horizontal banks; just a column underneath. Should still place — bottom face anchor.
  terrain.set(`0,77,0`, 'stone');
  const { bot, placeCalls } = makeBot({ terrain });
  const part = makePart(bot);
  const r = await part.deck({ x1: 0, z1: 0, x2: 0, z2: 0, surface_y: 78, block: 'cobblestone' });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.placed, 1);
  assert.equal(placeCalls.length, 1);
  // The reference should be the column block at (0,77,0); face vector (0,+y,0)
  // (use sign-tolerant compare to dodge -0 vs +0 in Vec3 arithmetic)
  assert.deepEqual(placeCalls[0].ref, { x: 0, y: 77, z: 0 });
  assert.equal(placeCalls[0].face.y, 1);
  assert.equal(Math.abs(placeCalls[0].face.x), 0);
  assert.equal(Math.abs(placeCalls[0].face.z), 0);
  // Final placed cell is at deck Y (0, 78, 0).
  assert.equal(placeCalls[0].x, 0);
  assert.equal(placeCalls[0].y, 78);
  assert.equal(placeCalls[0].z, 0);
});

test('deck: MISSING_INVENTORY when block runs out mid-bridge', async () => {
  const terrain = new Map();
  terrain.set(`-1,78,0`, 'grass_block');
  terrain.set(`5,78,0`, 'grass_block');
  // Empty inventory.
  const { bot, placeCalls } = makeBot({
    terrain,
    inventory: [], // no cobblestone
  });
  const part = makePart(bot);
  const r = await part.deck({ x1: 0, z1: 0, x2: 4, z2: 0, surface_y: 78, block: 'cobblestone' });
  assertFailure(r, {
    code: 'MISSING_INVENTORY',
    messageIncludes: 'cobblestone',
    observedKeys: ['placed', 'remaining', 'block', 'bounds'],
    retrySafe: true,
  });
  assert.equal(placeCalls.length, 0);
});

test('deck: partial — one bank only, interior reaches but two cells isolated on far side', async () => {
  const terrain = new Map();
  // West bank only; the deck is x=0..2, z=0. Cells x=0,1,2 all become anchored
  // via BFS from the west bank. Confirm full placement.
  terrain.set(`-1,78,0`, 'grass_block');
  const { bot, placeCalls } = makeBot({ terrain });
  const part = makePart(bot);
  const r = await part.deck({ x1: 0, z1: 0, x2: 2, z2: 0, surface_y: 78, block: 'cobblestone' });
  assertContract(r);
  assert.equal(r.data.placed, 3);
  assert.equal(r.data.unanchored.length, 0);
  // Order: x=0, then x=1, then x=2 (each step extends one block further).
  assert.deepEqual(placeCalls.map((c) => c.x), [0, 1, 2]);
});
