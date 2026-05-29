/**
 * Combat action contract tests (refusal paths).
 * ADR: docs/design/action-contract.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCombatActions } from '../../lib/actions/combat.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure } from '../_helpers/action-harness.js';

function combatDeps(overrides = {}) {
  const bot = overrides.bot || {
    entity: { position: { x: 0, y: 64, z: 0 } },
    entities: overrides.entities || {},
    inventory: { items: () => [] },
    health: 20,
    pathfinder: { goto: async () => {}, setGoal: () => {} },
  };
  const services = createMockServices();
  services.state.world.bot = bot;
  services.state.reactive = services.state.reactive || { mode: 'normal', combat_skill: 0.5 };
  return {
    ctx: services.state,
    ensureBot: () => bot,
    goals: { GoalNear: function () {}, GoalFollow: function () {} },
    fmt: (v) => String(v),
    posObj: () => bot.entity.position,
    sleep: () => Promise.resolve(),
    filterEntitiesFairPlay: (e) => e,
    reactionDelay: () => Promise.resolve(),
    loadLocations: () => ({}),
    rememberSocialEvent: () => {},
    getMyName: () => 'TestSteve',
    ACTIONS: {},
    hasLineOfSight: () => true,
    eyePosition: () => ({ x: 0, y: 65, z: 0 }),
  };
}

test('combat.flee: no hostile mobs → NO_THREAT', async () => {
  const deps = combatDeps({
    entities: {
      p1: { name: 'player', username: 'Partner', position: { x: 2, y: 64, z: 0, distanceTo: () => 2 }, type: 'player' },
    },
  });
  const combat = createCombatActions(deps);
  const r = await combat.flee({ distance: 16 });
  assertFailure(r, { code: 'NO_THREAT', messageIncludes: 'hostile', retrySafe: false });
});

test('combat.flee: from=Player with only player visible still finds threat', async () => {
  const deps = combatDeps({
    entities: {
      p1: { name: 'player', username: 'Partner', position: { x: 2, y: 64, z: 0, distanceTo: () => 2 }, type: 'player' },
    },
  });
  const combat = createCombatActions(deps);
  const r = await combat.flee({ distance: 8, from: 'Partner' });
  assert.equal(r.ok !== false || r.result, true);
});

test('combat.mode: invalid name → INVALID_MODE', async () => {
  const combat = createCombatActions(combatDeps());
  const r = await combat.mode({ name: 'panic' });
  assertFailure(r, { code: 'INVALID_MODE', messageIncludes: 'Mode', retrySafe: false });
});

test('combat.combat_skill: non-numeric → INVALID_VALUE', async () => {
  const combat = createCombatActions(combatDeps());
  const r = await combat.combat_skill({ value: 'high' });
  assertFailure(r, { code: 'INVALID_VALUE', messageIncludes: 'combat_skill', retrySafe: false });
});

test('combat.attack: target item with only drop entity → NO_TARGET', async () => {
  const deps = combatDeps({
    entities: {
      drop: {
        name: 'item',
        type: 'object',
        position: { x: 1, y: 64, z: 0, distanceTo: () => 1 },
        height: 0.25,
      },
    },
  });
  const combat = createCombatActions(deps);
  const r = await combat.attack({ target: 'item' });
  assertFailure(r, { code: 'NO_TARGET', messageIncludes: 'item', retrySafe: false });
});

test('combat.fight: no hostile nearby → informal refusal result', async () => {
  const combat = createCombatActions(combatDeps());
  const r = await combat.fight({});
  assert.match(r.result, /No .* found nearby/i);
});

test('combat.fight: low health triggers retreat path', async () => {
  const zombie = {
    name: 'zombie',
    displayName: 'Zombie',
    position: {
      x: 1, y: 64, z: 0,
      distanceTo: (p) => Math.hypot(p.x - 1, p.y - 64, p.z - 0),
    },
    height: 1.8,
    isValid: true,
  };
  const bot = {
    entity: {
      position: {
        x: 0, y: 64, z: 0,
        offset: (dx, dy, dz) => ({ x: 0 + dx, y: 64 + dy, z: 0 + dz }),
        distanceTo: (p) => Math.hypot(p.x, p.y - 64, p.z),
      },
    },
    entities: { z1: zombie },
    inventory: { items: () => [{ name: 'wooden_sword', count: 1 }] },
    health: 5,
    equip: async () => {},
    lookAt: async () => {},
    attack: async () => {},
    pathfinder: { goto: async () => {}, setGoal: () => {} },
  };
  const deps = combatDeps({ bot, entities: { z1: zombie } });
  deps.ctx.world.mcData = { foodsByName: {} };
  const combat = createCombatActions(deps);
  const r = await combat.fight({ target: 'Zombie', retreat_health: 6, duration: 1 });
  assert.match(r.result, /Retreated/i);
});
