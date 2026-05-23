/**
 * Interaction action contract tests (refusal paths).
 * ADR: docs/design/action-contract.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createInteractionActions } from '../../lib/actions/interaction.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure } from '../_helpers/action-harness.js';

function interactionServices(bot) {
  return createMockServices({
    state: { world: { botReady: true, bot } },
    ensureBot: () => bot,
    fairPlay: {
      hasLineOfSight: () => true,
      eyePosition: () => ({ x: bot.entity.position.x, y: bot.entity.position.y + 1.6, z: bot.entity.position.z }),
    },
    getActions: () => ({}),
  });
}

test('interaction.interact: no block at coord → NO_BLOCK_AT_COORD', async () => {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: () => null,
    pathfinder: { goto: async () => {} },
  };
  const actions = createInteractionActions(interactionServices(bot));
  const r = await actions.interact({ x: 9, y: 64, z: 9 });
  assertFailure(r, { code: 'NO_BLOCK_AT_COORD', observedKeys: ['requested_coord'], retrySafe: false });
});

test('interaction.through: air at gate → NOT_A_DOOR', async () => {
  const bot = {
    entity: { position: { x: 0.5, y: 64, z: 0.5 } },
    inventory: { items: () => [] },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    entities: {},
    pathfinder: { goto: async () => {} },
    openBlock: async () => {},
    setControlState: () => {},
    lookAt: async () => {},
  };
  const actions = createInteractionActions(interactionServices(bot));
  const r = await actions.through({ gx: 1, gy: 64, gz: 0 });
  assertFailure(r, { code: 'NOT_A_DOOR', messageIncludes: 'door', retrySafe: false });
});

test('interaction.through: animal at gate → ANIMAL_AT_GATE', async () => {
  const gatePos = { x: 1, y: 64, z: 0, offset: (dx, dy, dz) => ({ x: 1 + dx, y: 64 + dy, z: 0 + dz }) };
  const bot = {
    entity: { position: { x: 0.5, y: 64, z: 0.5, distanceTo: () => 1 } },
    inventory: { items: () => [] },
    blockAt: (p) => {
      if (p.x === 1 && p.y === 64 && p.z === 0) {
        return {
          name: 'oak_door',
          boundingBox: 'block',
          position: gatePos,
          getProperties: () => ({ open: false }),
        };
      }
      return { name: 'air', boundingBox: 'empty', position: { x: p.x, y: p.y, z: p.z, offset: () => gatePos } };
    },
    entities: {
      cow: {
        name: 'cow',
        position: {
          x: 1.5, y: 64, z: 0.5,
          distanceTo: (p) => Math.hypot(p.x - 1.5, p.y - 64, p.z - 0.5),
        },
        type: 'animal',
        height: 1.4,
      },
    },
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    openBlock: async () => {},
    activateBlock: async () => {},
    setControlState: () => {},
    lookAt: async () => {},
  };
  const actions = createInteractionActions(interactionServices(bot));
  const r = await actions.through({ gx: 1, gy: 64, gz: 0 });
  assertFailure(r, { code: 'ANIMAL_AT_GATE', retrySafe: true });
});
