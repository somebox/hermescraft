/**
 * place_torch action — forgiving cell selection + delegation.
 *
 * place_torch should "just work": agents routinely pass a coord that can't
 * hold a torch (their own foot/head cell, a solid block, an unsupported air
 * cell). Rather than fail, the wrapper SNAPS to the nearest cell that can hold
 * a torch (air/replaceable, clear of the bot, with a solid floor below or wall
 * beside), then delegates to `mc place`. These tests pin that behaviour.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createInteractionActions } from '../../lib/actions/interaction.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure } from '../_helpers/action-harness.js';

/**
 * Bot stub. Bot stands at foot cell (0,64,0). `blocks` maps "x,y,z" → block;
 * unmapped cells are air. A 3×3 solid floor at y=63 (x,z ∈ {-1,0,1}) gives the
 * cells at y=64 floor support, so there are real snap targets around the bot.
 */
function makeBot({ inventory = ['torch'], blocks = null } = {}) {
  const floor = {};
  for (const x of [-1, 0, 1]) for (const z of [-1, 0, 1]) floor[`${x},63,${z}`] = { name: 'stone' };
  const map = blocks ?? floor;
  return {
    entity: { position: { x: 0.5, y: 64, z: 0.5 } },
    inventory: {
      items: () => inventory.map((name, i) => ({ name, count: 1, slot: 36 + i })),
    },
    blockAt: (vec) => {
      const k = `${Math.floor(vec.x)},${Math.floor(vec.y)},${Math.floor(vec.z)}`;
      const blk = map[k];
      if (!blk) return { name: 'air', boundingBox: 'empty' };
      return { name: blk.name, boundingBox: blk.boundingBox ?? 'block' };
    },
    lookAt: async () => {},
  };
}

function actionsWith(bot, placeImpl) {
  const services = createMockServices({
    state: { world: { botReady: true } },
    ensureBot: () => bot,
    fairPlay: { hasLineOfSight: () => true, eyePosition: () => ({ x: 0, y: 64, z: 0 }) },
    getActions: () => ({ place: placeImpl }),
  });
  services.ensureBot = () => bot;
  return createInteractionActions(services);
}

test('place_torch: missing coords → MISSING_ARGS', async () => {
  const actions = actionsWith(makeBot(), async () => ({ ok: true }));
  const r = await actions.place_torch({ y: 64 });
  assertFailure(r, { code: 'MISSING_ARGS', observedKeys: ['received'], retrySafe: false });
});

test('place_torch: empty inventory → NO_TORCH_IN_INVENTORY', async () => {
  const actions = actionsWith(makeBot({ inventory: [] }), async () => ({ ok: true }));
  const r = await actions.place_torch({ x: 1, y: 64, z: 0 });
  assertFailure(r, {
    code: 'NO_TORCH_IN_INVENTORY',
    observedKeys: ['requested_coord', 'inventory_summary'],
    retrySafe: false,
  });
});

test('place_torch: valid non-body cell → places there (no snap)', async () => {
  let placedAt = null;
  const bot = makeBot();
  // After placement the target reads back as a torch.
  const orig = bot.blockAt;
  bot.blockAt = (vec) => {
    const k = `${Math.floor(vec.x)},${Math.floor(vec.y)},${Math.floor(vec.z)}`;
    if (k === '1,64,0' && placedAt) return { name: 'torch', boundingBox: 'empty' };
    return orig(vec);
  };
  const actions = actionsWith(bot, async (args) => { placedAt = args; return { ok: true }; });
  const r = await actions.place_torch({ x: 1, y: 64, z: 0 });  // air, floor below, not body
  assert.equal(r.ok, true);
  assert.equal(r.data.snapped, false);
  assert.deepEqual(r.data.coord, { x: 1, y: 64, z: 0 });
  assert.equal(r.data.support, 'floor');
  assert.deepEqual(placedAt, { block: 'torch', x: 1, y: 64, z: 0 });
});

test('place_torch: request the bot\'s own cell → snaps to a nearby supported cell', async () => {
  let placedAt = null;
  const actions = actionsWith(makeBot(), async (args) => { placedAt = args; return { ok: true }; });
  const r = await actions.place_torch({ x: 0, y: 64, z: 0 });  // bot's foot cell
  assert.equal(r.ok, true);
  assert.equal(r.data.snapped, true, 'should snap off the body cell');
  assert.deepEqual(r.data.requested, { x: 0, y: 64, z: 0 });
  // Snapped to some other supported cell, not the body cell.
  assert.notDeepEqual(r.data.coord, { x: 0, y: 64, z: 0 });
  assert.deepEqual(placedAt, { block: 'torch', ...r.data.coord });
});

test('place_torch: request a solid block → snaps to the air cell above it', async () => {
  let placedAt = null;
  const actions = actionsWith(makeBot(), async (args) => { placedAt = args; return { ok: true }; });
  const r = await actions.place_torch({ x: 1, y: 63, z: 0 });  // solid floor block
  assert.equal(r.ok, true);
  assert.equal(r.data.snapped, true);
  // Above the solid block (1,64,0) is air with floor support — the natural snap.
  assert.equal(placedAt.block, 'torch');
  assert.ok(r.data.support);
});

test('place_torch: no supported air cell anywhere near → NO_TORCH_SPOT', async () => {
  // Floating in the void: no solid blocks at all, so nothing supports a torch.
  const bot = makeBot({ blocks: {} });
  const actions = actionsWith(bot, async () => ({ ok: true }));
  const r = await actions.place_torch({ x: 0, y: 64, z: 0 });
  assertFailure(r, { code: 'NO_TORCH_SPOT', retrySafe: true });
});

test('place_torch: place delegation failure propagates', async () => {
  const actions = actionsWith(makeBot(), async () => ({
    ok: false,
    error: { code: 'REGION_PROTECTED', message: 'denied', retry_safe: false },
  }));
  const r = await actions.place_torch({ x: 1, y: 64, z: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'REGION_PROTECTED');
});

test('place_torch: getActions().place not registered → PLACE_NOT_AVAILABLE', async () => {
  const bot = makeBot();
  const services = createMockServices({
    state: { world: { botReady: true } },
    ensureBot: () => bot,
    getActions: () => ({}),  // no place
  });
  services.ensureBot = () => bot;
  const actions = createInteractionActions(services);
  const r = await actions.place_torch({ x: 1, y: 64, z: 0 });
  assertFailure(r, { code: 'PLACE_NOT_AVAILABLE', retrySafe: true });
});
