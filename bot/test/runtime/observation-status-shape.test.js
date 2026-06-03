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

test('getFullState: surfaces nav_header so workers see the brief on mc status (#50)', () => {
  // Workers strongly prefer mc status / scene / nearby over mc observe.
  // The nav-brief was previously gated behind mc observe; this test guards
  // that the compact header rides on status now (open|confined classification
  // + position + signals). Verified live in g-2026-05-30-3 (zero observe
  // calls across 259 worker messages).
  const getFullState = makeGetFullState({
    getStandingState: () => ({ classification: 'open', open_dirs: ['N', 'E', 'S', 'W'] }),
  });
  const state = getFullState({});
  assert.ok(state.nav_header, 'nav_header must be present on /status responses');
  assert.equal(state.nav_header.nav_mode, 'open');
  assert.ok(state.nav_header.pos, 'header carries position snapshot');
  assert.equal(state.nav_header.situation, 'Surface');
});

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

// Run-7 PR-J: server-side wiring contract. The CLI test asserts the
// rendered output contains `terrain=`; this asserts the upstream payload
// (`nav_header.terrain`) is populated when the classifier runs. Without
// this guard, a future refactor of `buildNavFrame` could silently drop
// terrain from the header and the CLI test would only catch it via the
// fixture's specific shape — this catches it at the wire format.
test('getFullState: nav_header.terrain shape is populated when bot has a position (PR-J)', () => {
  // Use a blockAt that puts a real grass surface at Y=63 so the classifier
  // produces a sensible `flat` result (feet at Y=64, surface at Y=63 →
  // feet_vs_local_ground=1 → mound_1; or surface at Y=64 if blockAt(Y=64)
  // returns grass → flat). Easier path: blockAt returns grass at and below
  // feetY (64), air above. surfaceYAt walks down from 96 skipping air,
  // returns 64 → feet_vs_local_ground=0, classifier may return `flat`.
  const pos = new Vec3(1, 64, 2);
  const blockAtSurface = (p) => {
    const py = p?.y ?? p?.[1];
    if (typeof py !== 'number') return { name: 'air', biome: { name: 'plains' } };
    if (py <= 64) return { name: 'grass_block', biome: { name: 'plains' } };
    return { name: 'air', biome: { name: 'plains' } };
  };
  const bot = {
    health: 20, food: 20, foodSaturation: 5,
    entity: { position: pos, onGround: true },
    inventory: { items: () => [] },
    time: { timeOfDay: 6000 },
    entities: {},
    blockAt: blockAtSurface,
    blockAtCursor: () => null,
    game: { dimension: 'minecraft:overworld' },
    heldItem: null,
    experience: { level: 0 },
    isRaining: false,
    isAlive: true,
    vehicle: null,
  };
  const ctx = {
    world: { bot, botReady: true, mcData: null },
    social: { chatLog: [], commandQueue: [], socialGraph: {} },
    runtime: { soundEvents: [], regions: null, taskContext: null },
    reactive: { fairPlayMode: true },
    team: { teamConfig: {}, combatStats: { kills: 0, deaths: 0 }, activeFurnaces: [], isSneaking: false },
    death: { deathLog: [], lastDeath: null, hardcoreDead: false },
    goals: { goalsStore: { goals: [] }, chestSnapshots: {} },
    tasks: { actionHistory: [], currentTask: null },
  };
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
    getStandingState: () => ({ classification: 'open', open_dirs: ['N', 'E', 'S', 'W'] }),
  });

  const state = getFullState({});
  assert.ok(state.nav_header, 'nav_header must be present');
  const t = state.nav_header.terrain;
  assert.ok(t, 'nav_header.terrain must be populated when bot.entity.position is set');
  assert.equal(typeof t.kind, 'string', 'terrain.kind must be a string label');
  assert.ok(t.kind.length > 0, 'terrain.kind must be non-empty');
  assert.equal(typeof t.feet_vs_local_ground, 'number',
    'terrain.feet_vs_local_ground must be a number');
  // Belt-and-braces: assert the label is one the classifier actually emits
  // (i.e. not a leaked `null` / `undefined` via JSON stringification quirks).
  const valid = new Set([
    'flat', 'slope_N', 'slope_E', 'slope_S', 'slope_W',
    'depression_1', 'mound_1', 'on_structure',
    'underground', 'cliff_above', 'cliff_below', 'unknown',
  ]);
  assert.ok(valid.has(t.kind), `terrain.kind ${JSON.stringify(t.kind)} not in known set`);
});
