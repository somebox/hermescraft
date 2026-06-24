/**
 * Partial-completion wallclock caps — level / place_fill / clear_strip.
 *
 * proc-nav-1781014144: long bulk verbs ran past the CLI's 120s abort, so
 * agents got a blind client-side timeout with zero progress data and
 * re-issued the identical command. These verbs now stop at a server-side
 * cap (~100s in prod, injected tiny here via deps.capsMs) and return an
 * OPERATION_TIMEOUT envelope carrying live counters + remaining work so
 * the agent can resume instead of retrying blind.
 *
 * Date is mocked (node:test mock timers) so each work unit "costs" a
 * deterministic 60ms — no real sleeping, no flakiness.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createBuildingTerrainPart } from '../../lib/actions/building/terrain.js';
import { createBuildingPlaceBulkPart } from '../../lib/actions/building/place-bulk.js';
import { createBuildingRoadPart } from '../../lib/actions/building/road.js';

test('level: cap stops the column loop and returns partial-completion envelope', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  // 8 columns (x=0..7, z=0): stone floor at y=63, air at/above y=64 → pure
  // fill work, one placement per column.
  const floor = new Set();
  for (let x = 0; x <= 7; x++) floor.add(`${x},63,0`);
  let placeCalls = 0;
  const bot = {
    entity: { position: { x: 0, y: 65, z: 0, distanceTo: () => 1 } },
    inventory: { items: () => [{ name: 'dirt', count: 64 }] },
    blockAt: (p) => (floor.has(`${p.x},${p.y},${p.z}`)
      ? { name: 'stone', boundingBox: 'block', position: p }
      : { name: 'air', boundingBox: 'empty', position: p }),
    equip: async () => {},
    placeBlock: async () => { placeCalls++; t.mock.timers.tick(60); },
  };
  const part = createBuildingTerrainPart({
    ctx: {},
    config: {},
    ensureBot: () => bot,
    sleep: async () => {},
    getActions: () => ({}),
    capsMs: { level: 100 },
  });

  const r = await part.level({ x1: 0, z1: 0, x2: 7, z2: 0, y: 64, block: 'dirt' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'OPERATION_TIMEOUT');
  assert.equal(r.error.retry_safe, true);
  const obs = r.error.observed_state;
  assert.equal(obs.op, 'level');
  assert.equal(obs.cap_ms, 100);
  // 2 columns fit inside the 100ms cap at 60ms each.
  assert.equal(obs.placed, 2);
  assert.equal(obs.columns_done, 2);
  assert.equal(obs.columns_remaining, 6);
  assert.deepEqual(obs.next_unfilled[0], [2, 0], 'next_unfilled starts at the first untouched column');
  assert.equal(obs.next_unfilled.length, 6);
  assert.equal(obs.bounds.x1, 0);
  assert.equal(obs.bounds.x2, 7);
  assert.match(r.error.message, /Partial completion: 2\/8 columns/);
  assert.match(r.error.message, /Re-run the same mc level/);
  assert.equal(placeCalls, 2, 'work loop must stop placing once the cap fires');
});

test('level with useExecKernel: partial envelope includes cursor and plan_hash', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const floor = new Set();
  for (let x = 0; x <= 7; x++) floor.add(`${x},63,0`);
  const bot = {
    entity: { position: { x: 0, y: 65, z: 0, distanceTo: () => 1 } },
    inventory: { items: () => [{ name: 'dirt', count: 64 }] },
    blockAt: (p) => (floor.has(`${p.x},${p.y},${p.z}`)
      ? { name: 'stone', boundingBox: 'block', position: p }
      : { name: 'air', boundingBox: 'empty', position: p }),
    equip: async () => {},
    placeBlock: async () => { t.mock.timers.tick(60); },
  };
  const part = createBuildingTerrainPart({
    ctx: {},
    config: {},
    ensureBot: () => bot,
    sleep: async () => {},
    getActions: () => ({}),
    capsMs: { level: 100 },
    useExecKernel: true,
  });
  const r = await part.level({ x1: 0, z1: 0, x2: 7, z2: 0, y: 64, block: 'dirt' });
  assert.equal(r.error.code, 'OPERATION_TIMEOUT');
  assert.equal(typeof r.error.observed_state.cursor?.next_index, 'number');
  assert.equal(typeof r.error.observed_state.plan_hash, 'string');
});

test('level_ground execute: inherits the partial-completion envelope from level', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  // Flat floor at y=63 everywhere; explicit target=64 makes every column a
  // shallow fill, so execute delegates to level which hits the tiny cap.
  const bot = {
    entity: { position: { x: 0, y: 65, z: 0, distanceTo: () => 1 } },
    game: { minY: -64, height: 384 },
    inventory: { items: () => [{ name: 'dirt', count: 64 }] },
    blockAt: (p) => (p.y <= 63
      ? { name: 'stone', boundingBox: 'block', position: p }
      : { name: 'air', boundingBox: 'empty', position: p }),
    equip: async () => {},
    placeBlock: async () => { t.mock.timers.tick(60); },
  };
  const handlers = {};
  const part = createBuildingTerrainPart({
    ctx: {},
    config: {},
    ensureBot: () => bot,
    sleep: async () => {},
    getActions: () => handlers,
    capsMs: { level: 100 },
  });
  handlers.level = part.level;

  const r = await part.level_ground({
    x1: 0, z1: 0, x2: 7, z2: 0, target: 64, block: 'dirt', execute: true,
  });
  assert.equal(r.ok, false);
  assert.match(r.data.execute_error, /exceeded 100ms wallclock cap/);
  // The partial-completion counters from level's envelope are forwarded.
  assert.equal(r.data.execute_result.columns_done, 2);
  assert.equal(r.data.execute_result.columns_remaining, 6);
  assert.deepEqual(r.data.execute_result.next_unfilled[0], [2, 0]);
});

test('place_fill: cap stops the cell loop and reports remaining cells', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  // 4×1×4 = 16 air cells at y=64 over a solid stone floor at y=63.
  let placeCalls = 0;
  const bot = {
    entity: { position: { x: -1.5, y: 64, z: 0.5, distanceTo: () => 1 } },
    inventory: { items: () => [{ name: 'dirt', count: 64 }] },
    blockAt: (p) => (p.y <= 63
      ? { name: 'stone', boundingBox: 'block', position: p }
      : { name: 'air', boundingBox: 'empty', position: p }),
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    equip: async () => {},
    placeBlock: async () => { placeCalls++; t.mock.timers.tick(60); },
  };
  const part = createBuildingPlaceBulkPart({
    ctx: {},
    config: {},
    ensureBot: () => bot,
    sleep: async () => {},
    capsMs: { place_fill: 100 },
  });

  const r = await part.place_fill({
    block: 'dirt', x1: 0, y1: 64, z1: 0, x2: 3, y2: 64, z2: 3,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'OPERATION_TIMEOUT');
  assert.equal(r.error.retry_safe, true);
  const obs = r.error.observed_state;
  assert.equal(obs.op, 'place_fill');
  assert.equal(obs.block, 'dirt');
  assert.equal(obs.placed, 2);
  assert.equal(obs.cells_done, 2);
  assert.equal(obs.remaining_count, 14);
  assert.equal(obs.total, 16);
  assert.equal(obs.next_unfilled.length, 8, 'next_unfilled is capped at 8 coords');
  assert.equal(obs.next_unfilled[0].length, 3, 'cells are [x,y,z] triples');
  assert.ok(obs.bounds);
  assert.match(r.error.message, /Partial completion: 2\/16 cells/);
  assert.match(r.error.message, /Re-run the same mc fill/);
  assert.equal(placeCalls, 2, 'work loop must stop placing once the cap fires');
});

test('clear_strip: cap stops batching and reports next_batch origin', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  // 6×6 dirt layer at y=79 above bed y=78 → 4 batches (2 X-chunks × 2 Z-chunks).
  const fixed = {};
  for (let x = 0; x <= 5; x++) {
    for (let z = 0; z <= 5; z++) fixed[`${x},79,${z}`] = 'dirt';
  }
  const calls = [];
  const bot = {
    entity: { position: new Vec3(0.5, 79, 0.5) },
    inventory: { items: () => [] },
    blockAt: (p) => {
      const name = fixed[`${p.x},${p.y},${p.z}`] || 'air';
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: p };
    },
    pathfinder: { goto: async () => {}, setGoal: () => {} },
  };
  const part = createBuildingRoadPart({
    ctx: {},
    config: {},
    ensureBot: () => bot,
    getActions: () => ({
      dig_area: async (args) => {
        calls.push(args);
        t.mock.timers.tick(60);
        const w = Math.abs(args.x2 - args.x1) + 1;
        const l = Math.abs(args.z2 - args.z1) + 1;
        return { ok: true, dug: w * l, skipped: 0, errors: [] };
      },
      pickup: async () => ({ ok: true }),
    }),
    capsMs: { clear_strip: 100 },
  });

  const r = await part.clear_strip({ x1: 0, z1: 0, x2: 5, z2: 5, y: 78, height: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'OPERATION_TIMEOUT');
  assert.equal(r.error.retry_safe, true);
  const obs = r.error.observed_state;
  assert.equal(obs.op, 'clear_strip');
  // 2 batches of 3×3 fit inside the 100ms cap at 60ms each.
  assert.equal(obs.batches, 2);
  assert.equal(obs.dug, 18);
  assert.equal(obs.would_dig, 36);
  // Snake order: (0,0) → (0,3) done; third batch would be (3,3).
  assert.deepEqual(obs.next_batch, { x1: 3, y1: 79, z1: 3, x2: 5, y2: 79, z2: 5 });
  assert.ok(obs.bounds);
  assert.match(r.error.message, /Partial completion: dug 18\/36/);
  assert.match(r.error.message, /Re-run the same mc clear_strip/);
  assert.equal(calls.length, 2, 'no more dig_area batches after the cap fires');
});

test('wall: cap stops runCells loop and reports partial-completion envelope', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let placeCalls = 0;
  const bot = {
    entity: { position: { x: 0.5, y: 64, z: 0.5, distanceTo: () => 1 } },
    inventory: { items: () => [{ name: 'cobblestone', count: 64 }] },
    blockAt: (p) => (p.y <= 63
      ? { name: 'stone', boundingBox: 'block', position: p }
      : { name: 'air', boundingBox: 'empty', position: p }),
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    equip: async () => {},
    placeBlock: async () => { placeCalls++; t.mock.timers.tick(60); },
  };
  const part = createBuildingPlaceBulkPart({
    ctx: {},
    config: {},
    ensureBot: () => bot,
    sleep: async () => {},
    capsMs: { wall: 100 },
  });

  const r = await part.wall({
    block: 'cobblestone', x1: 0, y1: 64, z1: 0, x2: 3, y2: 66, z2: 0,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'OPERATION_TIMEOUT');
  assert.equal(r.error.retry_safe, true);
  const obs = r.error.observed_state;
  assert.equal(obs.op, 'wall');
  assert.equal(obs.placed, 2);
  assert.equal(typeof obs.plan_hash, 'string');
  assert.match(r.error.message, /Partial completion/);
  assert.match(r.error.message, /Re-run the same mc wall/);
  assert.equal(placeCalls, 2);
});
