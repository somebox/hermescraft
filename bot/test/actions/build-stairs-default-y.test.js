/**
 * mc build_stairs — default-Y contract.
 *
 * Locks the Y-resolution rules in terrain.js build_stairs:
 *   - explicit `y` = block_y (legacy), explicit `surface_y` = feet (= block_y + 1)
 *   - when neither is given, startY defaults to the bot's foot block_y
 *     (Math.floor(entity.position.y))
 *
 * The handler reports its resolved start plane via withYBoth on data.start,
 * which is what these tests read — no placement needs to succeed (an all-air
 * world makes every place fail with "no solid neighbor", which still returns
 * ok:true with the resolved start).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBuildingTerrainPart } from '../../lib/actions/building/terrain.js';
import { assertContract } from '../_helpers/action-harness.js';

function makeBot({ y }) {
  return {
    entity: { position: { x: 0.5, y, z: 0.5 } },
    inventory: { items: () => [{ name: 'cobblestone', count: 64 }] },
    blockAt: ({ x, y: by, z }) => ({ name: 'air', boundingBox: 'empty', position: { x, y: by, z } }),
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

const BASE_ARGS = { block: 'cobblestone', direction: 'north', length: 1 };

test('build_stairs: no y/surface_y defaults to floor(bot position.y) as block_y', async () => {
  const part = makePart(makeBot({ y: 70.5 }));
  const r = await part.build_stairs({ ...BASE_ARGS });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.start.block_y, 70, 'default startY must be the bot foot block_y');
  assert.equal(r.data.start.surface_y, 71);
});

test('build_stairs: explicit y= is block_y', async () => {
  const part = makePart(makeBot({ y: 70.5 }));
  const r = await part.build_stairs({ ...BASE_ARGS, y: 64 });
  assertContract(r);
  assert.equal(r.data.start.block_y, 64);
  assert.equal(r.data.start.surface_y, 65);
});

test('build_stairs: surface_y= is feet — surface_y=65 resolves to the same plane as y=64', async () => {
  const part = makePart(makeBot({ y: 70.5 }));
  const viaSurface = await part.build_stairs({ ...BASE_ARGS, surface_y: 65 });
  const viaBlock = await part.build_stairs({ ...BASE_ARGS, y: 64 });
  assertContract(viaSurface);
  assert.deepEqual(viaSurface.data.start, viaBlock.data.start,
    'surface_y=65 and y=64 must resolve to the identical start plane');
  assert.equal(viaSurface.data.start.block_y, 64);
});

test('build_stairs: surface_y wins when both y and surface_y are passed', async () => {
  const part = makePart(makeBot({ y: 70.5 }));
  const r = await part.build_stairs({ ...BASE_ARGS, y: 60, surface_y: 65 });
  assertContract(r);
  assert.equal(r.data.start.block_y, 64, 'parseYInput precedence: surface_y over y');
});
