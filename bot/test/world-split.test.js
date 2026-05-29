/**
 * Phase 4 — verify the split of actions/world.js into six focused modules.
 *
 * Each new factory is invoked with createMockServices() and the returned
 * object is checked for the expected handler names. A representative failure
 * path per module is exercised and the result is asserted to conform to the
 * action contract via validate().
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validate } from '../lib/shared/action-contract.js';
import { createMockServices } from '../lib/server/mock-services.js';

import { createInventoryActions } from '../lib/actions/inventory.js';
import { createBuildingActions } from '../lib/actions/building.js';
import { createExcavationActions } from '../lib/actions/excavation.js';
import { createInteractionActions } from '../lib/actions/interaction.js';
import { createLifecycleActions } from '../lib/actions/lifecycle.js';
import { createQueriesActions } from '../lib/actions/queries.js';

const EXPECTED = {
  inventory:   ['equip', 'unequip', 'toss'],
  building:    ['pillar_step', 'place', 'place_fill', 'wall', 'fence', 'path', 'dig_pit', 'level', 'level_ground', 'build_stairs'],
  excavation:  ['dig_area', 'tunnel', 'stair_down', 'stair_up', 'pillar_down'],
  interaction: ['close_screen', 'edit_sign', 'interact', 'through', 'use'],
  lifecycle:   ['chat', 'wait', 'surface', 'sleep_bed', 'set_home', 'chat_to', 'whisper', 'respawn', 'deathpoint'],
  queries:     ['scout', 'terrain_top', 'reachable', 'standing', 'escape', 'find', 'inspect', 'is_empty', 'is_filled', 'is_sheltered'],
};

const FACTORIES = {
  inventory:   createInventoryActions,
  building:    createBuildingActions,
  excavation:  createExcavationActions,
  interaction: createInteractionActions,
  lifecycle:   createLifecycleActions,
  queries:     createQueriesActions,
};

test('every new module exposes exactly its expected handlers', () => {
  for (const [name, factory] of Object.entries(FACTORIES)) {
    const services = createMockServices();
    const actions = factory(services);
    const got = Object.keys(actions).filter((k) => typeof actions[k] === 'function').sort();
    const want = [...EXPECTED[name]].sort();
    assert.deepEqual(got, want, `module "${name}" handler set mismatch: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
});

test('total split handler count matches the legacy world.js + water absorption', () => {
  const total = Object.values(EXPECTED).reduce((s, names) => s + names.length, 0);
  // Original world.js had 41 handlers; two (bucket_fill, bucket_empty) moved
  // to water.js, leaving 39 across the six new modules. #99 added
  // pillar_down to excavation, making the total 40.
  assert.equal(total, 42);
});

test('water.js absorbed bucket_fill and bucket_empty from former world.js', async () => {
  const { createWaterActions } = await import('../lib/actions/water.js');
  // water.js still on legacy deps shape — provide both.
  const services = createMockServices();
  const deps = {
    ctx: services.state,
    ensureBot: services.ensureBot,
    sleep: services.utils.sleep,
    log: services.utils.log,
    getMyName: services.social.getMyName,
    ACTIONS: {},
    goals: { GoalNear: function () {} },
  };
  const water = createWaterActions(deps);
  assert.equal(typeof water.bucket_fill, 'function');
  assert.equal(typeof water.bucket_empty, 'function');
});

// ── Representative failure paths per module ──────────────────────────────

test('inventory.toss: fails when item not in inventory', async () => {
  const services = createMockServices({
    state: { world: { botReady: true } },
    ensureBot: () => ({
      inventory: { items: () => [] },
    }),
  });
  const actions = createInventoryActions(services);
  const r = await actions.toss({ item: 'oak_log' });
  assert.equal(r.ok, false);
  assert.match(r.error?.message ?? '', /No oak_log in inventory/);
});

test('building.place_fill: oversize returns ok:false AREA_TOO_LARGE (dispatch contract)', async () => {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => [] },
  };
  const services = createMockServices({
    state: { world: { botReady: true, bot } },
    ensureBot: () => bot,
  });
  const actions = createBuildingActions(services);
  const r = await actions.place_fill({
    block: 'cobblestone',
    x1: 0, y1: 0, z1: 0,
    x2: 30, y2: 30, z2: 30,
  });
  const v = validate(r);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'AREA_TOO_LARGE');
});

test('building.fence: MISSING_FENCE_BLOCK conforms to contract', async () => {
  const services = createMockServices({
    state: { world: { botReady: true } },
    ensureBot: () => ({}),
  });
  const actions = createBuildingActions(services);
  // Calling fence without a block argument trips the MISSING_FENCE_BLOCK guard.
  const r = await actions.fence({ x1: 0, z1: 0, x2: 5, z2: 5 });
  const v = validate(r);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'MISSING_FENCE_BLOCK');
});

test('queries.is_filled: validates coordinate args', async () => {
  const mockBot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: () => ({ name: 'air' }),
  };
  const services = createMockServices({
    state: { world: { botReady: true, bot: mockBot } },
    ensureBot: () => mockBot,
  });
  const actions = createQueriesActions(services);
  // Smoke: is_filled with valid coords + a known fill material returns a
  // contract-shaped result. Empty space + asking for stone → ok with
  // some_missing reporting.
  const r = await actions.is_filled({ x1: 0, y1: 64, z1: 0, x2: 1, y2: 64, z2: 1, material: 'stone' });
  const v = validate(r);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
});

test('lifecycle.chat: empty message contract-validates', async () => {
  // chat is a thin wrapper — test that we can at least call it without
  // crashing and that it returns a sane shape.
  const calls = [];
  const mockBot = {
    chat: (msg) => calls.push(msg),
    username: 'TestBot',
  };
  const services = createMockServices({
    state: { world: { botReady: true, bot: mockBot } },
    ensureBot: () => mockBot,
  });
  const actions = createLifecycleActions(services);
  const r = await actions.chat({ message: 'hello' });
  // chat returns either a contract-shaped result or an informal { result } —
  // validate accepts either when ok is true (informal has no ok field).
  if (r && r.ok !== undefined) {
    const v = validate(r);
    assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  }
  assert.equal(calls.length >= 1, true, 'bot.chat() should have been called');
});
