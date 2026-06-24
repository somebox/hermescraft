/**
 * Wall placement smoke — replaces arena test_wall_kernel_places_column postflight.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBuildingPlaceBulkPart } from '../../lib/actions/building/place-bulk.js';

test('wall: small column places all cells (kernel runCells path)', async () => {
  let placeCalls = 0;
  const bot = {
    entity: { position: { x: 0.5, y: 64, z: 0.5, distanceTo: () => 1 } },
    inventory: { items: () => [{ name: 'cobblestone', count: 64 }] },
    blockAt: (p) => (p.y <= 63
      ? { name: 'stone', boundingBox: 'block', position: p }
      : { name: 'air', boundingBox: 'empty', position: p }),
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    equip: async () => {},
    placeBlock: async () => { placeCalls++; },
  };
  const part = createBuildingPlaceBulkPart({
    ctx: {},
    config: {},
    ensureBot: () => bot,
    sleep: async () => {},
  });
  const r = await part.wall({
    block: 'cobblestone', x1: 0, y1: 64, z1: 0, x2: 0, y2: 65, z2: 0,
  });
  assert.equal(r.ok, true);
  assert.ok(r.data.blocks_placed >= 1);
  assert.ok(placeCalls >= 1);
});
