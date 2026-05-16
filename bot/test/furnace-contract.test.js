/**
 * Phase 5 — contract conformance for actions/furnace.js.
 *
 * Furnace handlers (smelt, smelt_start, furnace_check, furnace_take) are
 * still on the legacy `deps` factory shape, not `services`. The mock here
 * builds the deps bag from createMockServices() for state + utils, plus
 * directly-supplied closures for the marks/locations side.
 *
 * smelt moved here from crafting.js in Phase 5; its NO_FURNACE / NO_INPUT
 * failure paths used to live in bot/test/crafting-contract.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validate } from '../lib/shared/action-contract.js';
import { createMockServices } from '../lib/server/mock-services.js';
import { createFurnaceActions } from '../lib/actions/furnace.js';

const KNOWN_CODES = new Set([
  'NO_FURNACE',
  'NO_INPUT',
  'NO_FUEL',
  'NOT_SMELTABLE',
  'INTERRUPTED',
]);

function makeMockBot(overrides = {}) {
  const inventory = {
    items: () => overrides.inventoryItems || [],
  };
  const entity = {
    position: { x: 0, y: 64, z: 0, distanceTo: () => 0 },
  };
  return {
    inventory,
    entity,
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    findBlock: () => null,
    openFurnace: async () => { throw new Error('mock: no furnace'); },
    ...overrides.bot,
  };
}

function buildFurnace(botOverrides = {}, depsOverrides = {}) {
  const mockBot = makeMockBot(botOverrides);
  const services = createMockServices();
  const deps = {
    ctx: services.state,
    ensureBot: () => mockBot,
    goals: { GoalNear: function GoalNear() {} },
    sleep: async () => {},
    log: () => {},
    loadLocations: () => ({}),
    getMyName: () => 'TestBot',
    ...depsOverrides,
  };
  return { deps, mockBot, actions: createFurnaceActions(deps) };
}

function assertContract(result) {
  const v = validate(result);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  if (result.ok === false) {
    assert.ok(
      KNOWN_CODES.has(result.error.code),
      `error.code "${result.error.code}" not in KNOWN_CODES`,
    );
  }
}

test('furnace registry exposes smelt + smelt_start + furnace_check + furnace_take', () => {
  const { actions } = buildFurnace();
  assert.equal(typeof actions.smelt, 'function');
  assert.equal(typeof actions.smelt_start, 'function');
  assert.equal(typeof actions.furnace_check, 'function');
  assert.equal(typeof actions.furnace_take, 'function');
});

test('smelt: NO_FURNACE when no furnace nearby and no mark', async () => {
  const { actions } = buildFurnace({ bot: { findBlock: () => null } });
  const r = await actions.smelt({ input: 'iron_ore', count: 1 });
  assertContract(r);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_FURNACE');
});

test('smelt: NO_INPUT when input item missing from inventory', async () => {
  const furnaceBlock = { name: 'furnace', position: { x: 0, y: 64, z: 0 } };
  const { actions } = buildFurnace({
    bot: {
      findBlock: (q) => {
        if (typeof q.matching === 'function') {
          return q.matching(furnaceBlock) ? furnaceBlock : null;
        }
        return furnaceBlock;
      },
    },
    inventoryItems: [],
  });
  const r = await actions.smelt({ input: 'iron_ore' });
  assertContract(r);
  assert.equal(r.error.code, 'NO_INPUT');
});
