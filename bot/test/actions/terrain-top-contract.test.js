/**
 * mc terrain_top — Y-vocabulary contract.
 *
 * Locks the response shape defined in docs/reference/world-coordinates.md:
 * every ground-plane Y is returned as the canonical pair
 * (block_y = topmost solid, surface_y = block_y + 1 = feet), at top level
 * and per-column, with legacy aliases (topY/blockName/feetYHint) preserved
 * for one release.
 *
 * Until now terrain_top was only exercised indirectly via corridor_sample.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createQueriesActions } from '../../lib/actions/queries.js';
import { createMockServices } from '../../lib/server/mock-services.js';

function makeBot(terrain) {
  const PASSABLE = new Set(['air', 'cave_air', 'void_air']);
  const FLUID = new Set(['water', 'lava', 'flowing_water', 'flowing_lava']);
  return {
    entity: { position: { x: 0, y: 70, z: 0, distanceTo: () => 0 } },
    game: { minY: -64, height: 384 },
    inventory: { items: () => [] },
    blockAt({ x, y, z }) {
      const k = `${x},${y},${z}`;
      const t = terrain.get(k);
      if (!t) return { name: 'air', boundingBox: 'empty', position: { x, y, z } };
      const isAir = PASSABLE.has(t) || FLUID.has(t);
      return { name: t, boundingBox: isAir ? 'empty' : 'block', position: { x, y, z } };
    },
  };
}

function makeQueries(bot) {
  const services = createMockServices({
    state: { world: { botReady: true, bot } },
    ensureBot: () => bot,
  });
  return createQueriesActions(services);
}

function groundColumn(t, x, z, y, name = 'grass_block') {
  for (let dy = 1; dy <= 4; dy++) t.set(`${x},${y - dy},${z}`, 'stone');
  t.set(`${x},${y},${z}`, name);
}

test('terrain_top: single column returns canonical block_y/surface_y pair (+1 invariant)', async () => {
  const t = new Map();
  groundColumn(t, 0, 0, 64);
  const q = makeQueries(makeBot(t));
  const r = await q.terrain_top({ x: 0, z: 0 });

  assert.equal(r.block_y, 64);
  assert.equal(r.surface_y, 65);
  assert.equal(r.surface_y, r.block_y + 1, 'surface_y must equal block_y + 1');
  assert.equal(r.block_name, 'grass_block');

  // Legacy aliases stay consistent with the canonical fields.
  assert.equal(r.topY, r.block_y);
  assert.equal(r.blockName, r.block_name);
  assert.equal(r.feetYHint, r.surface_y);

  assert.match(r.result, /block_y=64/);
  assert.match(r.result, /surface_y=65/);
});

test('terrain_top: radius + full returns per-column canonical pairs and picks max', async () => {
  const t = new Map();
  // 3×3 ground at y=64 with one bump at (1,1) to y=66.
  for (let x = 0; x <= 2; x++) {
    for (let z = 0; z <= 2; z++) groundColumn(t, x, z, 64);
  }
  t.set('1,65,1', 'stone');
  t.set('1,66,1', 'stone');

  const q = makeQueries(makeBot(t));
  const r = await q.terrain_top({ x: 1, z: 1, radius: 1, full: true });

  // Top-level pair reflects the max column.
  assert.equal(r.block_y, 66);
  assert.equal(r.surface_y, 67);
  assert.equal(r.columnX, 1);
  assert.equal(r.columnZ, 1);

  assert.equal(r.columns.length, 9);
  for (const c of r.columns) {
    assert.equal(typeof c.block_y, 'number');
    assert.equal(c.surface_y, c.block_y + 1, `column ${c.x},${c.z}: surface_y must be block_y + 1`);
    assert.equal(c.topY, c.block_y, 'legacy topY must mirror block_y');
  }
});

test('terrain_top: no solid blocks returns null pair (not zero, not absent)', async () => {
  const q = makeQueries(makeBot(new Map()));
  const r = await q.terrain_top({ x: 0, z: 0 });

  assert.equal(r.block_y, null);
  assert.equal(r.surface_y, null);
  assert.equal(r.block_name, null);
  assert.equal(r.columns.length, 0);
  assert.match(r.result, /No solid blocks/i);
});
