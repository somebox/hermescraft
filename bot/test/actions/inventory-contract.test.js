/**
 * Inventory action contract tests.
 * ADR: docs/reference/bot/handler-contract-adr.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createInventoryActions } from '../../lib/actions/inventory.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure } from '../_helpers/action-harness.js';

function inventoryServices(bot) {
  return createMockServices({
    state: { world: { botReady: true, bot, mcData: { itemsByName: {} } } },
    ensureBot: () => bot,
  });
}

test('equip: item not in inventory → NOT_IN_INVENTORY # spec', async () => {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => [] },
    equip: async () => {},
  };
  const actions = createInventoryActions(inventoryServices(bot));
  const r = await actions.equip({ item: 'diamond_pickaxe' });
  assertFailure(r, { code: 'NOT_IN_INVENTORY', retrySafe: false });
});

test('toss: missing item → NOT_IN_INVENTORY', async () => {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => [] },
    toss: async () => {},
    tossStack: async () => {},
  };
  const actions = createInventoryActions(inventoryServices(bot));
  const r = await actions.toss({ item: 'oak_log' });
  assertFailure(r, { code: 'NOT_IN_INVENTORY', retrySafe: false });
});

test('unequip: empty hand → ok', async () => {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { slots: [], items: () => [] },
    heldItem: null,
    QUICK_BAR_START: 36,
    setQuickBarSlot: () => {},
    unequip: async () => {},
  };
  const actions = createInventoryActions(inventoryServices(bot));
  const r = await actions.unequip({});
  assert.equal(r.ok, true);
});
