import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { loadConfig } from '../../lib/config/index.js';
import { createObservation } from '../../lib/runtime/observation.js';

function makeObserve({ envBrief = '', locations = {} } = {}) {
  const prevBrief = process.env.HERMES_NAV_BRIEF;
  if (envBrief) process.env.HERMES_NAV_BRIEF = envBrief;
  else delete process.env.HERMES_NAV_BRIEF;
  loadConfig();

  const pos = new Vec3(10, 64, -3);
  const bot = {
    username: 'testbot',
    health: 20,
    food: 20,
    entity: { position: pos },
    time: { timeOfDay: 6000 },
    inventory: { items: () => [] },
    isAlive: true,
  };
  const ctx = {
    world: { bot, botReady: true, mcData: null },
    social: {
      chatLog: [],
      commandQueue: [],
      lastChatBriefedTime: 0,
      socialGraph: {},
      socialEvents: [],
      overheardLog: [],
    },
    runtime: {
      regions: null,
      taskContext: null,
      soundEvents: [],
      navTrail: { crumbs: [{ x: 1, y: 64, z: 2 }, { x: 5, y: 64, z: 0 }] },
    },
    reactive: { fairPlayMode: true, autoActionLog: [] },
    team: { teamConfig: {}, combatStats: { kills: 0, deaths: 0 }, activeFurnaces: [], isSneaking: false },
    death: { deathLog: [], lastDeath: null, hardcoreDead: false },
    goals: { goalsStore: { goals: [] }, chestSnapshots: {} },
    tasks: { actionHistory: [], currentTask: null, lastApiError: null },
  };
  ctx.world.bot = bot;

  const { buildObservePayload } = createObservation({
    ctx,
    ensureBot: () => bot,
    fmt: (n) => n,
    posObj: () => ({ x: pos.x, y: pos.y, z: pos.z }),
    loadLocations: () => locations,
    filterEntitiesFairPlay: (x) => x,
    buildSceneSummary: () => null,
    fireDueReminders: () => [],
    FAIR_PLAY: { LOS_ENTITY_RANGE: 48 },
    itemStr: () => null,
    getStandingState: () => ({
      classification: 'open',
      open_dirs: ['n', 's', 'e', 'w'],
    }),
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

test('buildObservePayload always includes nav frame fields', () => {
  const { buildObservePayload, restore } = makeObserve();
  try {
    const p = buildObservePayload({ lean: true });
    assert.equal(p.nav_mode, 'open');
    assert.ok(p.nav_header);
    assert.ok(p.nav_frame);
    assert.ok(p.journey?.line);
  } finally {
    restore();
  }
});

test('buildObservePayload with HERMES_NAV_BRIEF=1 surfaces nav_brief_text', () => {
  const { buildObservePayload, restore } = makeObserve({
    envBrief: '1',
    locations: { base_anchor: { x: 0, y: 64, z: 0 } },
  });
  try {
    const p = buildObservePayload({ lean: true });
    assert.equal(p.payload_version, 2);
    assert.ok(p.nav_brief);
    assert.ok(typeof p.nav_brief_text === 'string' && p.nav_brief_text.includes('paths:'));
    assert.equal(p.nearby_marks, undefined);
    const backRow = p.nav_brief.paths.find((r) => r.label === 'back');
    assert.ok(backRow);
    assert.equal(backRow.args, '--trail');
  } finally {
    restore();
  }
});

test('buildObservePayload sets brief_refresh_required after terrain mutation hook', () => {
  const { buildObservePayload, restore, ctx } = makeObserve({ envBrief: '1' });
  ctx.runtime.briefRefreshRequired = { ts: Date.now(), cells: [{ x: 1, y: 2, z: 3 }] };
  try {
    const p = buildObservePayload({ lean: true });
    assert.equal(p.brief_refresh_required, true);
    assert.equal(ctx.runtime.briefRefreshRequired, undefined);
  } finally {
    restore();
  }
});
