/**
 * Building action contract tests.
 * ADR: docs/reference/bot/handler-contract-adr.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBuildingActions } from '../../lib/actions/building.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure } from '../_helpers/action-harness.js';

test('building.place_fill: AREA_TOO_LARGE returns structured failure # spec', async () => {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => [{ name: 'cobblestone', count: 64 }] },
  };
  const services = createMockServices({
    state: { world: { botReady: true, bot } },
    ensureBot: () => bot,
  });
  const actions = createBuildingActions(services);
  const r = await actions.place_fill({
    block: 'cobblestone',
    x1: 0, y1: 0, z1: 0,
    x2: 20, y2: 20, z2: 20,
  });
  assertFailure(r, {
    code: 'AREA_TOO_LARGE',
    messageIncludes: '32',  // cap lowered from 500 → 32 (2026-05-27)
    observedKeys: ['requested_volume', 'max_volume'],
    retrySafe: false,
  });
  assert.match(r.error.next_action_hint, /sub-box|smaller/i);
});

test('building.place_fill: partial fill returns FILL_PARTIAL with remaining_cells', async () => {
  let placeCalls = 0;
  const bot = {
    entity: { position: { x: 20, y: 64, z: 20, distanceTo: () => 2 } },
    inventory: { items: () => [{ name: 'cobblestone', count: 16 }] },
    blockAt: (pos) => {
      const x = pos.x;
      const y = pos.y;
      const z = pos.z;
      if (x === 5 && y === 64 && z === 5) return { name: 'air', boundingBox: 'empty' };
      if (x === 6 && y === 64 && z === 5) return { name: 'air', boundingBox: 'empty' };
      if (x === 5 && y === 63 && z === 5) return { name: 'dirt', boundingBox: 'block' };
      if (x === 6 && y === 63 && z === 5) return { name: 'dirt', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    },
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    equip: async () => {},
    placeBlock: async () => {
      placeCalls += 1;
      if (placeCalls >= 2) throw new Error('no_adjacent_face');
    },
  };
  const services = createMockServices({
    state: { world: { botReady: true, bot } },
    ensureBot: () => bot,
  });
  const actions = createBuildingActions(services);
  const r = await actions.place_fill({
    block: 'cobblestone',
    x1: 5,
    y1: 64,
    z1: 5,
    x2: 6,
    y2: 64,
    z2: 5,
  });
  assertFailure(r, {
    code: 'FILL_PARTIAL',
    messageIncludes: 'FILL_PARTIAL',
    observedKeys: ['remaining_cells', 'remaining_count', 'placed'],
    retrySafe: true,
  });
  assert.ok(r.error.observed_state.remaining_cells.length >= 1);
  assert.ok(r.error.next_action_hint);
});
