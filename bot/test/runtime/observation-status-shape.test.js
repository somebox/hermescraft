import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { createObservation } from '../../lib/runtime/observation.js';

function makeGetFullState(overrides = {}) {
  const pos = new Vec3(1, 64, 2);
  const held = overrides.heldItem ?? null;
  const invItems = overrides.invItems ?? [];
  const bot = {
    health: 20,
    food: 20,
    foodSaturation: 5,
    entity: { position: pos, onGround: true },
    inventory: { items: () => invItems },
    time: { timeOfDay: 6000 },
    entities: {},
    blockAt: () => ({ name: 'grass_block', biome: { name: 'plains' } }),
    blockAtCursor: () => null,
    game: { dimension: 'minecraft:overworld' },
    heldItem: held,
    experience: { level: 0 },
    isRaining: false,
    isAlive: true,
    vehicle: null,
  };
  const ctx = {
    world: { bot, botReady: true, mcData: null, bot: { ...bot, heldItem: held, vehicle: null } },
    social: { chatLog: [], commandQueue: [], socialGraph: {} },
    runtime: { soundEvents: [], regions: null, taskContext: null },
    reactive: { fairPlayMode: true },
    team: { teamConfig: {}, combatStats: { kills: 0, deaths: 0 }, activeFurnaces: [], isSneaking: false },
    death: { deathLog: [], lastDeath: null, hardcoreDead: false },
    goals: { goalsStore: { goals: [] }, chestSnapshots: {} },
    tasks: { actionHistory: [], currentTask: null },
  };
  ctx.world.bot = bot;
  const { getFullState } = createObservation({
    ctx,
    ensureBot: () => bot,
    fmt: (n) => n,
    posObj: () => ({ x: pos.x, y: pos.y, z: pos.z }),
    loadLocations: () => ({}),
    filterEntitiesFairPlay: (ents) => ents,
    buildSceneSummary: () => null,
    fireDueReminders: () => [],
    FAIR_PLAY: { LOS_ENTITY_RANGE: 48 },
    itemStr: (item) => (item ? { name: item.name, count: item.count } : null),
    getStandingState: overrides.getStandingState ?? null,
  });
  return getFullState;
}

test('getFullState lean: self-only shape (no world-scan keys)', () => {
  const getFullState = makeGetFullState({
    invItems: [{ name: 'oak_log', count: 4 }, { name: 'cobblestone', count: 32 }],
  });
  const state = getFullState({ lean: true });
  assert.equal(state.nearbyBlocks, undefined);
  assert.equal(state.notableBlocks, undefined);
  assert.equal(state.scene, undefined);
  assert.equal(state.inventory, undefined);
  assert.ok(state.supplies);
  assert.equal(state.supplies.oak_log, 4);
  assert.equal(state.supplies.cobblestone, 32);
  assert.ok(Array.isArray(state.nearby_entities));
});

test('getFullState lean: holding includes durability_left for tools', () => {
  const getFullState = makeGetFullState({
    heldItem: {
      name: 'stone_pickaxe',
      count: 1,
      maxDurability: 132,
      durability: 10,
    },
    invItems: [],
  });
  const state = getFullState({ lean: true });
  assert.equal(state.holding.name, 'stone_pickaxe');
  assert.equal(state.holding.durability_left, 122);
});

test('getFullState lean: hand_vs_inventory when pickaxe in inv, empty hand', () => {
  const getFullState = makeGetFullState({
    heldItem: null,
    invItems: [{ name: 'iron_pickaxe', count: 1 }],
  });
  const state = getFullState({ lean: true });
  assert.match(state.hand_vs_inventory, /iron_pickaxe/);
});
