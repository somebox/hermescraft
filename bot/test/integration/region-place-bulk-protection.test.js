import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { createRegionStore } from '../../lib/runtime/regions/index.js';
import { createBuildingPlaceBulkPart } from '../../lib/actions/building/place-bulk.js';
import { shouldSkipPlaceAt } from '../../lib/runtime/regions/policy-guard.js';

function blockMap(blocks) {
  const key = (x, y, z) => `${x},${y},${z}`;
  return (pos) => {
    const p = pos instanceof Vec3 ? pos : new Vec3(pos.x, pos.y, pos.z);
    return blocks[key(p.x, p.y, p.z)] || { name: 'air', boundingBox: 'empty' };
  };
}

function mockBotForSinglePlace() {
  return {
    entity: { position: { x: 20, y: 64, z: 20, distanceTo: () => 2 } },
    inventory: { items: () => [{ name: 'cobblestone', count: 8 }] },
    blockAt: blockMap({
      '20,64,20': { name: 'air', boundingBox: 'empty' },
      '20,65,20': { name: 'air', boundingBox: 'empty' },
      '20,63,20': { name: 'grass_block', boundingBox: 'block' },
      '5,64,5': { name: 'air', boundingBox: 'empty' },
      '5,63,5': { name: 'dirt', boundingBox: 'block' },
      '4,64,5': { name: 'dirt', boundingBox: 'block' },
    }),
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    equip: async () => {},
    placeBlock: async () => {},
  };
}

test('shouldSkipPlaceAt denies inside protect region without worksite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-bulk-place-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({
    id: 'base1',
    profile: 'base',
    status: 'active',
    anchor: { x: 5, y: 64, z: 5 },
    shape: { kind: 'column', radius: 12 },
  });
  const ctx = { runtime: { regions: store } };
  const config = { behaviors: { regionsEnabled: true } };
  const skip = shouldSkipPlaceAt(ctx, config, 'cobblestone', 5, 64, 5);
  assert.equal(skip.skip, true);
  assert.equal(skip.regionId, 'base1');
});

test('place_fill skips protected cell and reports region_protected counters', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-bulk-place2-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({
    id: 'hut3',
    profile: 'base',
    status: 'active',
    anchor: { x: 5, y: 64, z: 5 },
    shape: { kind: 'column', radius: 12 },
  });
  const ctx = { runtime: { regions: store, recentPlaceFailures: [] } };
  const config = { behaviors: { regionsEnabled: true } };
  let placedCalls = 0;
  const bot = mockBotForSinglePlace();
  bot.placeBlock = async () => {
    placedCalls++;
  };
  const bulk = createBuildingPlaceBulkPart({
    ctx,
    config,
    ensureBot: () => bot,
    sleep: async () => {},
  });
  const r = await bulk.place_fill({
    block: 'cobblestone',
    x1: 5,
    y1: 64,
    z1: 5,
    x2: 5,
    y2: 64,
    z2: 5,
  });
  assert.ok(r.data);
  assert.equal(r.data.skipped_region, 1);
  assert.deepEqual(r.data.region_protected, [{ id: 'hut3', count: 1 }]);
  assert.match(String(r.result), /skipped/i);
  assert.equal(placedCalls, 0);
});

test('place_fill places inside protect region when worksite matches', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-bulk-place3-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({
    id: 'hut3',
    profile: 'base',
    status: 'active',
    anchor: { x: 5, y: 64, z: 5 },
    shape: { kind: 'column', radius: 12 },
  });
  const ctx = {
    runtime: {
      regions: store,
      recentPlaceFailures: [],
      taskContext: {
        card_id: 't_test',
        worksite_region: 'hut3',
        expires_at: Date.now() + 60_000,
        source: 'test',
      },
    },
  };
  const config = { behaviors: { regionsEnabled: true } };
  let placedCalls = 0;
  const bot = mockBotForSinglePlace();
  bot.placeBlock = async () => {
    placedCalls++;
  };
  const bulk = createBuildingPlaceBulkPart({
    ctx,
    config,
    ensureBot: () => bot,
    sleep: async () => {},
  });
  const r = await bulk.place_fill({
    block: 'cobblestone',
    x1: 5,
    y1: 64,
    z1: 5,
    x2: 5,
    y2: 64,
    z2: 5,
  });
  assert.ok(r.data);
  assert.equal(r.data.skipped_region || 0, 0);
  assert.equal(placedCalls, 1);
});
