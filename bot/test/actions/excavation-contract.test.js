/**
 * Excavation action contract tests.
 * ADR: docs/design/action-contract.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createExcavationActions } from '../../lib/actions/excavation.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure } from '../_helpers/action-harness.js';

function makeExcavationServices({ bot, digAreaImpl }) {
  const services = createMockServices({
    state: { world: { botReady: true, bot, mcData: { blocksByName: { lava: { id: 1 } } } } },
    ensureBot: () => bot,
    getActions: () => ({
      dig_area: digAreaImpl,
      pickup: async () => ({ ok: true }),
    }),
  });
  return services;
}

test('excavation.dig_area: lava hazard → HAZARD_LAVA', async () => {
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }] },
    blockAt: (p) => {
      const pos = { x: p.x, y: p.y, z: p.z };
      if (p.x === 1 && p.y === 64 && p.z === 0) return { name: 'lava', boundingBox: 'block', position: pos, digTime: 1 };
      if (p.x === 0 && p.y === 64 && p.z === 0) return { name: 'stone', boundingBox: 'block', position: pos, digTime: 1 };
      return { name: 'air', boundingBox: 'empty', position: pos, digTime: 1 };
    },
    pathfinder: { goto: async () => {} },
    dig: async () => {},
  };
  const services = makeExcavationServices({ bot, digAreaImpl: undefined });
  const actions = createExcavationActions(services);
  const r = await actions.dig_area({ x1: 0, y1: 64, z1: 0, x2: 0, y2: 64, z2: 0, safe: true });
  assertFailure(r, { code: 'HAZARD_LAVA', messageIncludes: 'dig_area', retrySafe: false });
});

test('excavation.stair_up: dig_area hazard abort propagates', async () => {
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    inventory: { items: () => [{ name: 'cobblestone', count: 64 }] },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    pathfinder: { goto: async () => {} },
    lookAt: async () => {},
    setControlState: () => {},
    equip: async () => {},
    placeBlock: async () => {},
    dig: async () => {},
  };
  const hazard = {
    ok: false,
    error: {
      code: 'HAZARD_LAVA',
      message: 'dig_area aborted: lava',
      retry_safe: false,
    },
  };
  const services = makeExcavationServices({
    bot,
    digAreaImpl: async () => hazard,
  });
  const actions = createExcavationActions(services);
  const r = await actions.stair_up({ direction: 'north', length: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'HAZARD_LAVA');
});

test('excavation.stair_down: invalid direction returns INVALID_VALUE', async () => {
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    inventory: { items: () => [] },
    blockAt: () => ({ name: 'stone', boundingBox: 'block' }),
    pathfinder: { goto: async () => {} },
  };
  const services = makeExcavationServices({ bot, digAreaImpl: async () => ({ dug: 0 }) });
  const actions = createExcavationActions(services);
  const r = await actions.stair_down({ direction: 'invalid', depth: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_VALUE');
  assert.match(r.error.message, /Invalid direction/);
});
