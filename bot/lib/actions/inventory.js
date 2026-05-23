import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail } from '../shared/action-contract.js';

const { goals } = pathfinderPkg;

/**
 * createInventoryActions — extracted from former lib/actions/world.js (Phase 4 split).
 */
export function createInventoryActions(services) {
  const { state: ctx, config, ensureBot, utils, social, resolver, fairPlay, getActions } = services;
  const { fmt, posObj, sleep, log } = utils;
  const { resolveInventoryItem } = resolver;
  const { rememberSocialEvent, getMyName } = social;
  const { hasLineOfSight, eyePosition } = fairPlay;

  return {
  async equip({ item, slot = 'hand' }) {
    const b = ensureBot();
    const invRows = b.inventory.items().map((i) => ({ name: i.name, count: i.count }));
    const er = resolveInventoryItem({
      mcData: ctx.world.mcData,
      inventory: invRows,
      query: String(item),
      policy: 'best_available',
    });
    if (!er.ok) {
      return fail('NOT_IN_INVENTORY', er.message || `No ${item} in inventory.`, { retry_safe: false });
    }
    const invItem = b.inventory.items().find((i) => i.name === er.selected.name);
    if (!invItem) {
      const available = b.inventory.items().map((i) => i.name);
      return fail('NOT_IN_INVENTORY', `No ${er.selected.name} in inventory. Have: ${[...new Set(available)].join(', ')}`, { retry_safe: false });
    }
    await b.equip(invItem, slot);
    return ok({ result: `Equipped ${er.selected.name} to ${slot}` });
  },

  async unequip({ slot = 'hand' }) {
    const b = ensureBot();
    if (slot === 'hand') {
      const qbStart = b.QUICK_BAR_START ?? 36;
      let cleared = false;
      for (let s = 0; s < 9; s++) {
        if (!b.inventory.slots[qbStart + s]) {
          b.setQuickBarSlot(s);
          cleared = true;
          break;
        }
      }
      if (!cleared) {
        await b.unequip('hand');
      }
    } else {
      await b.unequip(slot);
    }
    const nowHeld = b.heldItem;
    return ok({ result: nowHeld?.name ? `Hand now holds ${nowHeld.name}` : 'Hand is now empty.' });
  },

  async toss({ item, count }) {
    const b = ensureBot();
    const invItem = b.inventory.items().find(i => i.name === item);
    if (!invItem) {
      return fail('NOT_IN_INVENTORY', `No ${item} in inventory.`, { retry_safe: false });
    }
    if (count && count > 0 && count < invItem.count) {
      await b.toss(invItem.type, null, count);
    } else {
      await b.tossStack(invItem);
    }
    return ok({ result: `Tossed ${count || invItem.count} ${item}` });
  },
  };
}
