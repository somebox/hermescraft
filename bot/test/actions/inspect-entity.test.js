/**
 * mc inspect occupancy aligns with mc place entity rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createQueriesActions } from '../../lib/actions/queries/index.js';
import { createMockServices } from '../../lib/server/mock-services.js';

function inspectBot(entities, blockAt) {
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    entities,
    blockAt: blockAt || (() => ({ name: 'air', boundingBox: 'empty', hardness: 0 })),
  };
  const services = createMockServices({
    state: { world: { botReady: true, bot } },
    ensureBot: () => bot,
  });
  return createQueriesActions(services);
}

test('inspect: air + dropped item → not occupied, empty entities_at', async () => {
  const actions = inspectBot({
    e1: { name: 'item', position: new Vec3(5.5, 74.1, 9.5) },
  });
  const r = await actions.inspect({ x: 5, y: 74, z: 9 });
  assert.equal(r.ok, true);
  assert.equal(r.data.block.is_air, true);
  assert.equal(r.data.entities_at.length, 0);
  assert.equal(r.data.occupied, false);
});

test('inspect: chest in cell → blocks_placement hint in result', async () => {
  const actions = inspectBot(
    {},
    () => ({ name: 'chest', boundingBox: 'block', hardness: 2.5 }),
  );
  const r = await actions.inspect({ x: 3, y: 64, z: 7 });
  assert.equal(r.ok, true);
  assert.equal(r.data.block.blocks_placement, true);
  assert.equal(r.data.block.is_relocatable, true);
  assert.match(r.result, /blocks mc place/);
  assert.match(r.result, /mc dig 3 64 7/);
});

test('inspect: air + player in cell → occupied', async () => {
  const actions = inspectBot({
    p1: { type: 'player', username: 'Partner', name: 'player', position: new Vec3(5.5, 74, 9.5) },
  });
  const r = await actions.inspect({ x: 5, y: 74, z: 9 });
  assert.equal(r.ok, true);
  assert.equal(r.data.occupied, true);
  assert.equal(r.data.entities_at.length, 1);
  assert.match(r.result, /1 entity/);
});
