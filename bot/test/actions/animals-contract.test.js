/**
 * Animals action contract tests (refusal paths).
 * ADR: docs/design/action-contract.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAnimalsActions } from '../../lib/actions/animals.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure } from '../_helpers/action-harness.js';

function animalsDeps(bot) {
  const services = createMockServices();
  services.state.world.bot = bot;
  return {
    ctx: services.state,
    ensureBot: () => bot,
    goals: { GoalNear: function () {} },
    sleep: () => Promise.resolve(),
    log: () => {},
    getMyName: () => 'TestBot',
    ACTIONS: {},
    filterEntitiesFairPlay: (e) => e,
  };
}

function baseBot(overrides = {}) {
  return {
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => overrides.inventory || [] },
    entities: overrides.entities || {},
    pathfinder: { goto: async () => {} },
    lookAt: async () => {},
    equip: async () => {},
    useOn: async () => {},
    attack: async () => {},
    activateItem: async () => {},
  };
}

test('animals.breed: unsupported species → UNSUPPORTED_SPECIES', async () => {
  const actions = createAnimalsActions(animalsDeps(baseBot()));
  const r = await actions.breed({ species: 'dragon' });
  assertFailure(r, { code: 'UNSUPPORTED_SPECIES', messageIncludes: 'breed', retrySafe: false });
});

test('animals.breed: no food → NO_FOOD', async () => {
  const actions = createAnimalsActions(animalsDeps(baseBot()));
  const r = await actions.breed({ species: 'cow' });
  assertFailure(r, { code: 'NO_FOOD', messageIncludes: 'cow', observedKeys: ['required_any'], retrySafe: false });
});

test('animals.shear: no shears → NO_SHEARS', async () => {
  const actions = createAnimalsActions(animalsDeps(baseBot()));
  const r = await actions.shear();
  assertFailure(r, { code: 'NO_SHEARS', messageIncludes: 'shears', retrySafe: false });
});

test('animals.milk_cow: no bucket → NO_BUCKET', async () => {
  const actions = createAnimalsActions(animalsDeps(baseBot()));
  const r = await actions.milk_cow();
  assertFailure(r, { code: 'NO_BUCKET', messageIncludes: 'bucket', retrySafe: false });
});

test('animals.hunt: unsupported species → UNSUPPORTED_SPECIES', async () => {
  const actions = createAnimalsActions(animalsDeps(baseBot()));
  const r = await actions.hunt({ species: 'dragon' });
  assertFailure(r, { code: 'UNSUPPORTED_SPECIES', retrySafe: false });
});

test('animals.lure: no food → NO_FOOD', async () => {
  const actions = createAnimalsActions(animalsDeps(baseBot()));
  const r = await actions.lure({ species: 'cow', x: 0, y: 64, z: 0 });
  assertFailure(r, { code: 'NO_FOOD', messageIncludes: 'cow', retrySafe: false });
});
