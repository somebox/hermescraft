/**
 * Cross-command Y composition: terrain_top -> clear_strip.
 *
 * PHASE 1 of the surface-y migration (see the surface-y-consistency plan).
 * Historically clear_strip's `surface_y` param meant the GROUND BLOCK Y
 * (road.js dialect) while terrain_top's `surface_y` output means FEET
 * (= block_y + 1, canonical) — so the naive name-matching composition was
 * silently off by one (the feet cell stayed uncleared).
 *
 * Phase 1 turns that silent off-by-one into a LOUD error: clear_strip
 * rejects `surface_y` outright and takes `y` (= block_y of the road bed),
 * which pairs directly with terrain_top.block_y / corridor_sample
 * elevation_median. Phase 2 will reintroduce `surface_y` as true feet via
 * parseYInput — at that point the rejection test below flips to a
 * works-canonically assertion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createQueriesActions } from '../../lib/actions/queries.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { createBuildingRoadPart } from '../../lib/actions/building/road.js';
import { assertContract, assertFailure } from '../_helpers/action-harness.js';

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

test('composition (PHASE 1, flips at phase 2): terrain_top.surface_y -> clear_strip.surface_y fails LOUDLY, not off-by-one', async () => {
  const bot = makeBot(makeWorld());
  const { queries, road } = makeHandlers(bot);

  const top = await queries.terrain_top({ x: 0, z: 0 });

  // The naive name-matching composition an agent would write. Before the
  // migration this silently cleared one cell too high; now it errors with
  // guidance instead.
  const r = await road.clear_strip({
    x1: 1, z1: 0, x2: 1, z2: 0, surface_y: top.surface_y, height: 4, dry_run: true,
  });
  assertFailure(r, {
    code: 'INVALID_COORD',
    messageIncludes: ['surface_y', 'y='],
    retrySafe: false,
  });
});
