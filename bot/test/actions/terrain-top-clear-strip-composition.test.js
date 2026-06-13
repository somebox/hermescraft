/**
 * Cross-command Y composition: terrain_top -> clear_strip.
 *
 * Surface-y migration end-state (phase 2 landed): clear_strip accepts both
 * `y` (= block_y of the road bed, legacy) and `surface_y` (= feet =
 * block_y + 1, canonical). Either composition with terrain_top works —
 * `top.block_y → clear_strip.y` is what proc_scout_road_graph.py emits;
 * `top.surface_y → clear_strip.surface_y` is the natural name-matching
 * composition and now does the right thing (clears the feet cell).
 *
 * Historically clear_strip had a dialect where `surface_y` meant the
 * GROUND BLOCK Y; phase 1 turned that into a loud rejection, phase 2
 * unified the vocabulary via parseYInput.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createQueriesActions } from '../../lib/actions/queries.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { createBuildingRoadPart } from '../../lib/actions/building/road.js';
import { assertContract } from '../_helpers/action-harness.js';

const PASSABLE = new Set(['air', 'cave_air', 'void_air']);

/** One synthetic world shared by the query and the road handler. */
function makeBot(terrain) {
  return {
    entity: { position: { x: 0.5, y: 70, z: 0.5, distanceTo: () => 0 } },
    game: { minY: -64, height: 384 },
    inventory: { items: () => [] },
    blockAt({ x, y, z }) {
      const k = `${x},${y},${z}`;
      const t = terrain.get(k);
      if (!t) return { name: 'air', boundingBox: 'empty', position: { x, y, z } };
      return { name: t, boundingBox: PASSABLE.has(t) ? 'empty' : 'block', position: { x, y, z } };
    },
  };
}

function makeWorld() {
  const t = new Map();
  // Flat grass ground at y=64 on columns (0,0) and (1,0), stone below.
  for (const x of [0, 1]) {
    for (let dy = 1; dy <= 4; dy++) t.set(`${x},${64 - dy},0`, 'stone');
    t.set(`${x},64,0`, 'grass_block');
  }
  // Obstruction in the corridor column (1,0) sitting IN the feet cell
  // (y=65, the cell a bot's feet occupy when standing on the y=64 ground).
  t.set('1,65,0', 'dirt');
  return t;
}

function makeHandlers(bot) {
  const services = createMockServices({
    state: { world: { botReady: true, bot } },
    ensureBot: () => bot,
  });
  const queries = createQueriesActions(services);
  const road = createBuildingRoadPart({
    ctx: {},
    ensureBot: () => bot,
    getActions: () => ({ dig_area: async () => ({ ok: true, dug: 0, skipped: 0, errors: [] }), pickup: async () => ({ ok: true }) }),
  });
  return { queries, road };
}

test('composition: terrain_top.block_y -> clear_strip.y clears exactly the feet+head cells', async () => {
  const bot = makeBot(makeWorld());
  const { queries, road } = makeHandlers(bot);

  // Survey the clean column: canonical pair.
  const top = await queries.terrain_top({ x: 0, z: 0 });
  assert.equal(top.block_y, 64);
  assert.equal(top.surface_y, 65);

  // The supported composition: block value -> y param. This is exactly what
  // proc_scout_road_graph.py emits (y=<elevation_median>).
  const r = await road.clear_strip({
    x1: 1, z1: 0, x2: 1, z2: 0, y: top.block_y, height: 4, dry_run: true,
  });
  assertContract(r);
  assert.equal(r.ok, true);

  // Clears [65..68] — feet + head cells above the bed: walkable corridor.
  assert.equal(r.data.bounds.y1, 65);
  assert.equal(r.data.would_dig, 1);
  assert.equal(r.data.removed_by_block.dirt, 1);

  // Response pair is canonical and feeds back into other commands directly.
  assert.equal(r.data.block_y, 64);
  assert.equal(r.data.surface_y, 65);
});

test('composition (phase 2): terrain_top.surface_y -> clear_strip.surface_y clears the feet cell', async () => {
  const bot = makeBot(makeWorld());
  const { queries, road } = makeHandlers(bot);

  const top = await queries.terrain_top({ x: 0, z: 0 });
  assert.equal(top.surface_y, 65);

  // Natural name-matching composition. Pre-phase-2 this was rejected; now
  // surface_y is canonical feet and the call clears the same volume as
  // y = top.block_y would.
  const r = await road.clear_strip({
    x1: 1, z1: 0, x2: 1, z2: 0, surface_y: top.surface_y, height: 4, dry_run: true,
  });
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(r.data.bounds.y1, 65);
  assert.equal(r.data.would_dig, 1);
  assert.equal(r.data.removed_by_block.dirt, 1);
  assert.equal(r.data.block_y, 64);
  assert.equal(r.data.surface_y, 65);
});
