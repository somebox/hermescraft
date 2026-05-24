import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { createObservation } from '../../lib/runtime/observation.js';
import { createRegionStore } from '../../lib/runtime/regions/index.js';

function makeObservationCtx(regions) {
  const pos = new Vec3(2, 64, 2);
  const bot = {
    health: 20,
    food: 20,
    foodSaturation: 5,
    entity: { position: pos, onGround: true },
    inventory: { items: () => [] },
    time: { timeOfDay: 6000 },
    entities: {},
    blockAt: () => ({ name: 'grass_block', biome: { name: 'plains' } }),
    game: { dimension: 'minecraft:overworld' },
    heldItem: null,
    experience: { level: 0 },
    isRaining: false,
    isAlive: true,
  };
  const ctx = {
    world: { bot, botReady: true, mcData: null },
    social: { chatLog: [], commandQueue: [], socialGraph: {} },
    runtime: { soundEvents: [], regions },
    reactive: { fairPlayMode: true },
    team: { teamConfig: {}, combatStats: { kills: 0, deaths: 0 }, activeFurnaces: [] },
    death: { deathLog: [], lastDeath: null, hardcoreDead: false },
    goals: { goalsStore: { goals: [] }, chestSnapshots: {} },
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
    itemStr: () => '',
  });
  return getFullState;
}

test('getFullState includes regions_here when inside a region', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-obs-reg-'));
  const store = createRegionStore({ dataDir: dir, world: 'w' });
  store.upsert({
    id: 'base1',
    profile: 'base',
    status: 'unanchored',
    anchor: { x: 0, y: 64, z: 0 },
    shape: { kind: 'column', radius: 16 },
  });
  const getFullState = makeObservationCtx(store);
  const state = getFullState({ lean: true });
  assert.ok(state.regions_here);
  assert.equal(state.regions_here.length, 1);
  assert.equal(state.regions_here[0].id, 'base1');
});
