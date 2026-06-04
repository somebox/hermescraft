/**
 * Phase A5 — buildObservePayload extension.
 *
 * Surfaces `nearby_signs[]` (POIs whose sign_at is within 32 blocks) and
 * `nearby_missing_torches[]` (POIs whose torch_at within 16 blocks no
 * longer reads as a torch). Both arrays must drop out under
 * HERMES_NAV_BRIEF=1 (nav-brief owns that channel).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { loadConfig } from '../../lib/config/index.js';
import { createObservation } from '../../lib/runtime/observation.js';

/**
 * Build a stub observe environment with controlled POIs and blockAt
 * responses. `blockMap` maps `${x},${y},${z}` to a block stub; missing
 * coords return air.
 */
function makeObserve({ envBrief = '', pois = {}, blockMap = {} } = {}) {
  const prevBrief = process.env.HERMES_NAV_BRIEF;
  if (envBrief) process.env.HERMES_NAV_BRIEF = envBrief;
  else delete process.env.HERMES_NAV_BRIEF;
  loadConfig();

  const pos = new Vec3(0, 64, 0);
  const bot = {
    username: 'testbot',
    health: 20,
    food: 20,
    entity: { position: pos },
    time: { timeOfDay: 6000 },
    inventory: { items: () => [] },
    isAlive: true,
    blockAt: (vec) => {
      const k = `${vec.x},${vec.y},${vec.z}`;
      return blockMap[k] || { name: 'air' };
    },
  };
  const ctx = {
    world: { bot, botReady: true, mcData: null },
    social: {
      chatLog: [], commandQueue: [], lastChatBriefedTime: 0,
      socialGraph: {}, socialEvents: [], overheardLog: [],
    },
    runtime: {
      regions: null, taskContext: null, soundEvents: [],
      navTrail: { crumbs: [] },
    },
    reactive: { fairPlayMode: true, autoActionLog: [] },
    team: { teamConfig: {}, combatStats: { kills: 0, deaths: 0 }, activeFurnaces: [], isSneaking: false },
    death: { deathLog: [], lastDeath: null, hardcoreDead: false },
    goals: { goalsStore: { goals: [] }, chestSnapshots: {} },
    tasks: {
      actionHistory: [], currentTask: null, lastApiError: null,
      actionCounters: { window_ms: 60000, events: [] },
    },
  };
  ctx.world.bot = bot;

  const { buildObservePayload } = createObservation({
    ctx,
    ensureBot: () => bot,
    fmt: (n) => n,
    posObj: () => ({ x: pos.x, y: pos.y, z: pos.z }),
    loadLocations: () => ({}),
    loadPersonalPois: () => pois,
    filterEntitiesFairPlay: (x) => x,
    buildSceneSummary: () => null,
    fireDueReminders: () => [],
    FAIR_PLAY: { LOS_ENTITY_RANGE: 48 },
    itemStr: () => null,
    getStandingState: () => ({ classification: 'open', open_dirs: ['n', 's', 'e', 'w'] }),
    getPathTo: () => ({ status: 'success', path: [{ x: 0, y: 64, z: 0 }] }),
  });

  return {
    ctx,
    buildObservePayload,
    restore: () => {
      if (prevBrief === undefined) delete process.env.HERMES_NAV_BRIEF;
      else process.env.HERMES_NAV_BRIEF = prevBrief;
      loadConfig();
    },
  };
}

test('observe: nearby_signs surfaces POIs with sign_at within 32 blocks', () => {
  const { buildObservePayload, restore } = makeObserve({
    pois: {
      spider_hill: { name: 'spider_hill', x: 3, y: 64, z: 4, sign_at: { x: 3, y: 64, z: 4 } },
      far_cairn: { name: 'far_cairn', x: 100, y: 64, z: 0, sign_at: { x: 100, y: 64, z: 0 } },
    },
    blockMap: {
      '3,64,4': { name: 'oak_sign', signText: ['spider hill', '', '', ''] },
    },
  });
  try {
    const p = buildObservePayload({ lean: false });
    assert.ok(Array.isArray(p.nearby_signs));
    assert.equal(p.nearby_signs.length, 1);
    assert.equal(p.nearby_signs[0].name, 'spider_hill');
    assert.equal(p.nearby_signs[0].block_present, true);
    assert.deepEqual(p.nearby_signs[0].lines, ['spider hill', '', '', '']);
  } finally {
    restore();
  }
});

test('observe: lean mode omits sign text lines', () => {
  const { buildObservePayload, restore } = makeObserve({
    pois: {
      spider_hill: { name: 'spider_hill', x: 3, y: 64, z: 4, sign_at: { x: 3, y: 64, z: 4 } },
    },
    blockMap: {
      '3,64,4': { name: 'oak_sign', signText: ['spider hill', '', '', ''] },
    },
  });
  try {
    const p = buildObservePayload({ lean: true });
    assert.ok(Array.isArray(p.nearby_signs));
    assert.equal(p.nearby_signs.length, 1);
    assert.equal(p.nearby_signs[0].lines, undefined);
    assert.equal(p.nearby_signs[0].block_present, true);
  } finally {
    restore();
  }
});

test('observe: nearby_missing_torches reports POIs whose torch_at is not a torch', () => {
  const { buildObservePayload, restore } = makeObserve({
    pois: {
      cairn_a: { name: 'cairn_a', x: 0, y: 64, z: 5, torch_at: { x: 0, y: 65, z: 5 } },
      cairn_b: { name: 'cairn_b', x: 0, y: 64, z: 8, torch_at: { x: 0, y: 65, z: 8 } },
    },
    blockMap: {
      '0,65,5': { name: 'air' },       // missing — should surface
      '0,65,8': { name: 'torch' },     // intact — should NOT surface
    },
  });
  try {
    const p = buildObservePayload({ lean: false });
    assert.ok(Array.isArray(p.nearby_missing_torches));
    assert.equal(p.nearby_missing_torches.length, 1);
    assert.equal(p.nearby_missing_torches[0].name, 'cairn_a');
    assert.equal(p.nearby_missing_torches[0].observed_block, 'air');
  } finally {
    restore();
  }
});

test('observe: HERMES_NAV_BRIEF=1 strips nearby_signs + nearby_missing_torches', () => {
  const { buildObservePayload, restore } = makeObserve({
    envBrief: '1',
    pois: {
      cairn_a: {
        name: 'cairn_a', x: 0, y: 64, z: 5,
        sign_at: { x: 0, y: 64, z: 5 },
        torch_at: { x: 0, y: 65, z: 5 },
      },
    },
    blockMap: {
      '0,64,5': { name: 'oak_sign', signText: ['', '', '', ''] },
      '0,65,5': { name: 'air' },
    },
  });
  try {
    const p = buildObservePayload({ lean: true });
    assert.equal(p.nearby_signs, undefined);
    assert.equal(p.nearby_missing_torches, undefined);
  } finally {
    restore();
  }
});

test('observe: torch_at present but wall_torch counts as present (not missing)', () => {
  const { buildObservePayload, restore } = makeObserve({
    pois: {
      cairn_b: { name: 'cairn_b', x: 0, y: 64, z: 8, torch_at: { x: 0, y: 65, z: 8 } },
    },
    blockMap: {
      '0,65,8': { name: 'wall_torch' },
    },
  });
  try {
    const p = buildObservePayload({ lean: false });
    assert.equal(p.nearby_missing_torches, undefined);
  } finally {
    restore();
  }
});
