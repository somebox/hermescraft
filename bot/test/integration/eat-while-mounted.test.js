/**
 * Functional tests for mc eat — specifically the mounted-bot path
 * shipped in task #25.
 *
 * Pre-fix: b.equip(food, 'hand') would throw while mounted, and the
 * exception escaped before consume() ran. circuit-v5j showed Steve
 * trying mc eat at low HP in a boat with this exact failure mode.
 *
 * Post-fix:
 *   - if the food is already heldItem, skip equip and call consume directly
 *   - if equip throws, log the error and try a hotbar-slot select, then
 *     consume anyway (vanilla MC accepts the input even if mineflayer's
 *     equip helper disagrees)
 *   - if consume itself fails, surface a structured error tagged with
 *     EAT_FAILED_MOUNTED when mounted (so the agent gets a hint to
 *     disembark first)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCombatActions } from '../../lib/actions/combat.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure } from '../_helpers/action-harness.js';

function makeBot({
  foods = [{ name: 'cooked_beef', count: 32, slot: 36 }],
  held = null,
  mounted = false,
  consumeWorks = true,
  equipWorks = true,
} = {}) {
  let consumed = false;
  let equipCalls = 0;
  let setSlotCalls = 0;
  const bot = {
    health: 12,
    food: 8,
    heldItem: held,
    vehicle: mounted ? { id: 1, name: 'oak_boat' } : null,
    inventory: { items: () => foods },
    entity: { position: { x: 0, y: 64, z: 0 } },
    async equip(item, dest) {
      equipCalls++;
      if (!equipWorks) throw new Error('equip refused (mock: mounted)');
      bot.heldItem = item;
    },
    setQuickBarSlot(slot) {
      setSlotCalls++;
      const f = foods.find((it) => (it.slot - 36) === slot);
      if (f) bot.heldItem = f;
    },
    async consume() {
      consumed = true;
      if (!consumeWorks) throw new Error('consume refused (mock: in vehicle)');
      bot.food = Math.min(20, bot.food + 8);
      bot.health = Math.min(20, bot.health + 4);
    },
  };
  return Object.assign(bot, {
    _stats: () => ({ consumed, equipCalls, setSlotCalls }),
  });
}

function eatDeps(bot, mcData) {
  const services = createMockServices();
  services.state.world.mcData = mcData;
  services.state.world.bot = bot;
  return {
    ctx: services.state,
    ensureBot: () => bot,
    goals: { GoalNear: function () {} },
    fmt: (v) => v,
    posObj: () => bot.entity.position,
    sleep: () => Promise.resolve(),
    filterEntitiesFairPlay: (e) => e,
    reactionDelay: () => Promise.resolve(),
    loadLocations: () => ({}),
    rememberSocialEvent: () => {},
    getMyName: () => 'TestSteve',
    ACTIONS: {},
    hasLineOfSight: () => true,
    eyePosition: () => bot.entity.position,
  };
}

const mcData = {
  foodsByName: {
    cooked_beef: { foodPoints: 8 },
    bread: { foodPoints: 5 },
  },
};

// ─────────────────────────────────────────────────────────────────────────

test('mc eat: on dry land + food in hotbar → quickbar select + consume', async () => {
  const bot = makeBot();
  const combat = createCombatActions(eatDeps(bot, mcData));
  const r = await combat.eat();
  assert.match(r.result, /Ate cooked_beef/);
  assert.equal(bot._stats().equipCalls, 0, 'hotbar food uses setQuickBarSlot, not equip');
  assert.equal(bot._stats().setSlotCalls, 1);
  assert.equal(bot._stats().consumed, true);
});

test('mc eat: food already in hand → skip equip, call consume directly', async () => {
  // Pre-equip the food so heldItem matches the best-food pick.
  const food = { name: 'cooked_beef', count: 32, slot: 36 };
  const bot = makeBot({ foods: [food], held: food });
  const combat = createCombatActions(eatDeps(bot, mcData));
  const r = await combat.eat();
  assert.match(r.result, /Ate cooked_beef/);
  assert.equal(bot._stats().equipCalls, 0, 'equip must be skipped when food is already held');
  assert.equal(bot._stats().consumed, true);
});

test('mc eat: mounted + hotbar food → quickbar select + consume', async () => {
  const food = { name: 'cooked_beef', count: 32, slot: 36 };
  const bot = makeBot({ foods: [food], mounted: true, equipWorks: false });
  const combat = createCombatActions(eatDeps(bot, mcData));
  const r = await combat.eat();
  assert.match(r.result, /Ate cooked_beef/);
  assert.match(r.result, /mounted/);
  assert.equal(bot._stats().equipCalls, 0);
  assert.equal(bot._stats().setSlotCalls, 1);
  assert.equal(bot._stats().consumed, true);
});

test('mc eat: mounted + consume fails → EAT_FAILED_MOUNTED with disembark hint', async () => {
  // Worst case: even consume refuses. Return a structured error tagged
  // with the mounted state so the agent knows to disembark first.
  const food = { name: 'cooked_beef', count: 32, slot: 36 };
  const bot = makeBot({ foods: [food], held: food, mounted: true, consumeWorks: false });
  const combat = createCombatActions(eatDeps(bot, mcData));
  const r = await combat.eat();
  assertFailure(r, { code: 'EAT_FAILED_MOUNTED', messageIncludes: 'disembark', retrySafe: true });
});

test('mc eat: on land + consume fails → EAT_FAILED (no mounted hint)', async () => {
  const food = { name: 'cooked_beef', count: 32, slot: 36 };
  const bot = makeBot({ foods: [food], held: food, mounted: false, consumeWorks: false });
  const combat = createCombatActions(eatDeps(bot, mcData));
  const r = await combat.eat();
  assertFailure(r, { code: 'EAT_FAILED', retrySafe: true });
  assert.doesNotMatch(r.error.message, /disembark/);
});

test('mc eat: no food in inventory → "No food in inventory" error', async () => {
  const bot = makeBot({ foods: [] });
  const combat = createCombatActions(eatDeps(bot, mcData));
  const r = await combat.eat();
  assertFailure(r, { code: 'NO_FOOD', messageIncludes: 'No food', retrySafe: false });
});
