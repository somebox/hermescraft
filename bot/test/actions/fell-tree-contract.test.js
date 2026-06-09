/**
 * fell_tree — connected trunk + leaves removal.
 *
 * Covers:
 *  - input validation
 *  - NO_TREE_AT_COORD when scan window has no log
 *  - dry_run returns trunk/leaves counts without digging
 *  - single-column trunk + small canopy (oak-shaped)
 *  - multi-stem trunk (dark_oak 2×2)
 *  - leaves_radius=0 skips leaf cleanup
 *  - log cap respected (deep trunk gets clipped, doesn't infinite-loop)
 *  - species detection
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createBuildingRoadPart } from '../../lib/actions/building/road.js';
import { assertFailure, assertContract } from '../_helpers/action-harness.js';

function makeBot({ terrain, axe = 'iron_axe' }) {
  const PASSABLE = new Set(['air', 'cave_air', 'void_air']);
  const digCalls = [];
  const heldItem = { name: axe };
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [{ name: axe, count: 1 }] },
    // mineflayer-tool surface used by equipForDig.
    tool: {
      itemInHand: () => heldItem,
      equipForBlock: async () => {},
      getDigTime: () => 20,
    },
    blockAt(p) {
      const k = `${p.x},${p.y},${p.z}`;
      const t = terrain.get(k);
      if (!t) return { name: 'air', boundingBox: 'empty', position: new Vec3(p.x, p.y, p.z) };
      const isAir = PASSABLE.has(t);
      return {
        name: t,
        boundingBox: isAir ? 'empty' : 'block',
        position: new Vec3(p.x, p.y, p.z),
        digTime: 1,
      };
    },
    async equip() {},
    async dig(target) {
      digCalls.push({ x: target.position.x, y: target.position.y, z: target.position.z, name: target.name });
      terrain.delete(`${target.position.x},${target.position.y},${target.position.z}`);
    },
  };
  bot.entity.position.distanceTo = () => 0;
  return { bot, digCalls };
}

function makePart(bot) {
  return createBuildingRoadPart({
    ctx: { runtime: { regions: null, recentPlaces: [] } },
    config: { behaviors: {} },
    ensureBot: () => bot,
    getActions: () => ({ pickup: async () => ({ ok: true }) }),
  });
}

test('fell_tree: missing x → INVALID_COORD', async () => {
  const { bot } = makeBot({ terrain: new Map() });
  const part = makePart(bot);
  const r = await part.fell_tree({ z: 0 });
  assertFailure(r, { code: 'INVALID_COORD', messageIncludes: 'x', retrySafe: false });
});

test('fell_tree: no log in scan window → NO_TREE_AT_COORD', async () => {
  const terrain = new Map();
  terrain.set(`0,64,0`, 'stone'); // no log
  const { bot } = makeBot({ terrain });
  const part = makePart(bot);
  const r = await part.fell_tree({ x: 0, z: 0 });
  assertFailure(r, {
    code: 'NO_TREE_AT_COORD',
    messageIncludes: 'no log block',
    observedKeys: ['x', 'z', 'scanned_y_range'],
    retrySafe: false,
  });
});

test('fell_tree: single-column oak (4 logs + 12 leaves) — dry_run reports counts, no dig calls', async () => {
  const terrain = new Map();
  // trunk at (0, 64..67)
  for (let y = 64; y <= 67; y++) terrain.set(`0,${y},0`, 'oak_log');
  // canopy: 3x3 leaves around top, at y=67 and y=68
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      terrain.set(`${dx},67,${dz}`, 'oak_leaves');
      terrain.set(`${dx},68,${dz}`, 'oak_leaves');
    }
  }
  // top leaf above trunk
  terrain.set(`0,68,0`, 'oak_leaves');
  const { bot, digCalls } = makeBot({ terrain });
  const part = makePart(bot);
  const r = await part.fell_tree({ x: 0, z: 0, y_hint: 64, dry_run: true });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.mode, 'dry_run');
  assert.equal(r.data.species, 'oak');
  assert.equal(r.data.trunk_base_y, 64);
  assert.equal(r.data.trunk_top_y, 67);
  assert.equal(r.data.logs_n, 4);
  // 8 leaves at y=67 (skipping center which is trunk) + 8 leaves at y=68 + 1 top = 17
  assert.equal(r.data.leaves_n, 17);
  assert.equal(digCalls.length, 0);
});

test('fell_tree: live — trunk sweep + leaf sweep, each top-down within its cluster', async () => {
  const terrain = new Map();
  for (let y = 64; y <= 66; y++) terrain.set(`0,${y},0`, 'birch_log');
  terrain.set(`1,66,0`, 'birch_leaves');
  terrain.set(`-1,66,0`, 'birch_leaves');
  terrain.set(`0,67,0`, 'birch_leaves');
  const { bot, digCalls } = makeBot({ terrain });
  const part = makePart(bot);
  const r = await part.fell_tree({ x: 0, z: 0, y_hint: 64 });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.logs_removed, 3);
  assert.equal(r.data.leaves_removed, 3);
  assert.equal(r.data.species, 'birch');
  // Cluster-aware order: the trunk dig sweep should be the first 3 calls
  // and strictly top-down (logs at y=66, 65, 64). The leaf cluster comes
  // next, also top-down within itself.
  const trunkSweep = digCalls.slice(0, 3);
  for (const call of trunkSweep) {
    assert.match(call.name, /_log$/, `expected first ${digCalls.length >= 3 ? 3 : digCalls.length} calls to be logs`);
  }
  const trunkYs = trunkSweep.map((c) => c.y);
  assert.deepEqual(trunkYs, [...trunkYs].sort((a, c) => c - a),
    'trunk dig sweep must be top-down for bot-foot-safety');
  // Leaf cluster: remaining calls all leaves, internally top-down.
  const leafSweep = digCalls.slice(3);
  for (const call of leafSweep) {
    assert.match(call.name, /_leaves$/);
  }
  const leafYs = leafSweep.map((c) => c.y);
  assert.deepEqual(leafYs, [...leafYs].sort((a, c) => c - a),
    'leaf sweep must be top-down within cluster');
});

test('fell_tree: leaves_radius=0 leaves canopy untouched', async () => {
  const terrain = new Map();
  for (let y = 64; y <= 65; y++) terrain.set(`0,${y},0`, 'spruce_log');
  terrain.set(`0,66,0`, 'spruce_leaves');
  terrain.set(`1,66,0`, 'spruce_leaves');
  const { bot, digCalls } = makeBot({ terrain });
  const part = makePart(bot);
  const r = await part.fell_tree({ x: 0, z: 0, y_hint: 64, leaves_radius: 0 });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.logs_removed, 2);
  assert.equal(r.data.leaves_removed, 0);
  // Confirm leaves still in terrain
  assert.equal(terrain.get('0,66,0'), 'spruce_leaves');
  assert.equal(terrain.get('1,66,0'), 'spruce_leaves');
});

test('fell_tree: multi-stem dark_oak (2×2 trunk) — all 4 columns connect, all 4 logs picked up', async () => {
  const terrain = new Map();
  // 2x2 trunk at (0..1, 64, 0..1)
  for (let dx = 0; dx <= 1; dx++) {
    for (let dz = 0; dz <= 1; dz++) {
      for (let y = 64; y <= 65; y++) terrain.set(`${dx},${y},${dz}`, 'dark_oak_log');
    }
  }
  const { bot, digCalls } = makeBot({ terrain });
  const part = makePart(bot);
  const r = await part.fell_tree({ x: 0, z: 0, y_hint: 64, leaves_radius: 0 });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.logs_removed, 8);
  assert.equal(r.data.species, 'dark_oak');
});

test('fell_tree: trunk cap (max_logs) is respected — clips at cap', async () => {
  const terrain = new Map();
  // 30-tall trunk; cap default is 24
  for (let y = 64; y <= 93; y++) terrain.set(`0,${y},0`, 'oak_log');
  const { bot } = makeBot({ terrain });
  const part = makePart(bot);
  const r = await part.fell_tree({ x: 0, z: 0, y_hint: 64, leaves_radius: 0, max_logs: 24 });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.logs_n, 24);
});

test('fell_tree: y_hint omitted scans around bot Y', async () => {
  const terrain = new Map();
  for (let y = 64; y <= 66; y++) terrain.set(`5,${y},5`, 'oak_log');
  const { bot } = makeBot({ terrain });
  bot.entity.position = new Vec3(0, 64, 0); // bot is at y=64
  bot.entity.position.distanceTo = () => 0;
  const part = makePart(bot);
  const r = await part.fell_tree({ x: 5, z: 5, leaves_radius: 0 });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.logs_removed, 3);
});

test('fell_tree: pickup is called per cluster (trunk + 1 leaf cluster + final = 3)', async () => {
  // Tiny oak with 1 connected leaf cluster: 1 trunk cluster + 1 leaf
  // cluster + 1 final pickup = 3 total.
  const terrain = new Map();
  for (let y = 64; y <= 66; y++) terrain.set(`0,${y},0`, 'oak_log');
  // Connected leaves cluster (all adjacent to the trunk top)
  terrain.set(`1,66,0`, 'oak_leaves');
  terrain.set(`-1,66,0`, 'oak_leaves');
  terrain.set(`0,67,0`, 'oak_leaves');
  const { bot } = makeBot({ terrain });
  let pickupCalls = 0;
  const part = createBuildingRoadPart({
    ctx: { runtime: { regions: null, recentPlaces: [] } },
    config: { behaviors: {} },
    ensureBot: () => bot,
    getActions: () => ({ pickup: async () => { pickupCalls++; return { ok: true }; } }),
  });
  await part.fell_tree({ x: 0, z: 0, y_hint: 64 });
  // 1 trunk cluster + 1 leaf cluster (all leaves within radius 2 of each
  // other) + 1 final = 3.
  assert.equal(pickupCalls, 3, `expected 3 pickup calls, got ${pickupCalls}`);
});

test('fell_tree: distant leaves form separate clusters (bot pre-positions per cluster)', async () => {
  // Wide canopy: leaves at x=±4 won't cluster with leaves at x=∓4 (separation > 2).
  const terrain = new Map();
  for (let y = 64; y <= 66; y++) terrain.set(`0,${y},0`, 'oak_log');
  // Cluster A — far west
  terrain.set(`-4,66,0`, 'oak_leaves');
  terrain.set(`-4,66,1`, 'oak_leaves');
  // Cluster B — far east
  terrain.set(`4,66,0`, 'oak_leaves');
  terrain.set(`4,66,1`, 'oak_leaves');
  // Cluster C — directly attached to trunk top (anchors BFS)
  terrain.set(`0,67,0`, 'oak_leaves');
  // Trunk-adjacent seeds (these connect to far-cluster via the BFS chain
  // since the leaf BFS uses 6-face from the trunk).
  // To form genuinely separate clusters, our test needs leaves NOT BFS-
  // reachable from the trunk: we'll seed only the trunk-adjacent +y leaf;
  // the far ones are intentionally disconnected (no leaf BFS path) and
  // therefore will NOT be added to fell_tree's leaves[] list.
  // So in this test we get 1 leaf cluster (the trunk-adjacent one) and
  // confirm fell_tree does NOT travel to (-4,66,0) and (4,66,0).
  const { bot } = makeBot({ terrain });
  let pickupCalls = 0;
  const part = createBuildingRoadPart({
    ctx: { runtime: { regions: null, recentPlaces: [] } },
    config: { behaviors: {} },
    ensureBot: () => bot,
    getActions: () => ({ pickup: async () => { pickupCalls++; return { ok: true }; } }),
  });
  const r = await part.fell_tree({ x: 0, z: 0, y_hint: 64 });
  assertContract(r);
  // Only the +y leaf adjacent to trunk top is connected.
  assert.equal(r.data.leaves_removed, 1);
  // Far leaves remain in terrain (proves we didn't wander out there).
  assert.equal(terrain.get('-4,66,0'), 'oak_leaves');
  assert.equal(terrain.get('4,66,0'), 'oak_leaves');
  // Clusters: trunk + 1 leaf cluster = 2 + final = 3.
  assert.equal(pickupCalls, 3);
});
