/**
 * Smoke coverage for commands flagged in mc-command-audit 2026-05-29 (§B).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { RAW_COMMAND_DEFS } from '../cli/registry.mjs';
import { createAllActions } from '../lib/actions/index.js';
import { createCombatActions } from '../lib/actions/combat.js';
import { createMockServices } from '../lib/server/mock-services.js';
import { validate } from '../lib/shared/action-contract.js';
import { makeDeps, makeStubBot, makeStubMcData } from './actions/_mining-test-helpers.js';

const AUDIT_COMMANDS = [
  'alerts', 'anchors', 'blueprint', 'fair_play', 'furnaces', 'logistics', 'look_at',
  'farm_status', 'fish', 'construct', 'blueprint_repair', 'batch', 'dashboard', 'overhear',
  'shoot', 'shield', 'sprint_attack', 'crit', 'strafe', 'combo',
  'acknowledge_command', 'cancel_command', 'complete_command',
  'region_update_intent', 'regions_reload', 'regions_terrain', 'site_remove',
  'goal_add', 'goal_set', 'goal_remove', 'goal_status', 'goal_presets', 'goal_load',
  'bg_combo', 'bg_fight', 'bg_smelt', 'bg_strafe', 'task_history',
  'task_pause', 'task_resume', 'task_start', 'checkpoint_respond',
];

test('audit §B commands are registered in RAW_COMMAND_DEFS', () => {
  const names = new Set(RAW_COMMAND_DEFS.map((c) => c.name));
  const missing = AUDIT_COMMANDS.filter((n) => !names.has(n));
  assert.equal(missing.length, 0, `not in registry: ${missing.join(', ')}`);
});

function buildAllActions() {
  const deps = makeDeps();
  const services = createMockServices({ state: deps.ctx });
  services.state.world.bot = deps.ensureBot();
  services.state.world.mcData = makeStubMcData();
  deps.services = services;
  deps.ctx = services.state;
  deps.filterEntitiesFairPlay = services.fairPlay.filterEntitiesFairPlay;
  deps.reactionDelay = services.fairPlay.reactionDelay;
  deps.rememberSocialEvent = services.social.rememberSocialEvent;
  deps.getMyName = services.social.getMyName;
  deps.loadLocations = services.locations.load;
  deps.saveLocations = services.locations.save;
  deps.ACTIONS = {};
  const actions = createAllActions(deps);
  deps.ACTIONS = actions;
  return actions;
}

async function smokeAction(name, args = {}) {
  const actions = buildAllActions();
  assert.equal(typeof actions[name], 'function', `no handler for ${name}`);
  const r = await actions[name](args);
  const v = validate(r);
  assert.equal(v.valid, true, `${name}: ${v.issues.join('; ')}`);
  return r;
}

/** Handler keys on createAllActions() (registry aliases may differ). */
/** Handlers covered by *-contract.test.js — registry smoke only for the rest. */
const ACTION_HANDLERS = [
  'sprint_attack', 'critical_hit',
  'fish', 'farm_status',
  'region_update_intent', 'regions_terrain', 'site_remove',
];

/** Registered CLI names served via HTTP/task routes, not ACTION handlers. */
const HTTP_OR_TASK_ONLY = [
  'look_at', 'regions_reload', 'furnaces', 'logistics', 'fair_play', 'alerts',
  'bg_combo', 'bg_fight', 'bg_smelt', 'bg_strafe', 'task_history', 'task_pause',
  'task_resume', 'task_start', 'checkpoint_respond',
  'goal_add', 'goal_set', 'goal_remove', 'goal_status', 'goal_presets', 'goal_load',
  'acknowledge_command', 'cancel_command', 'complete_command', 'dashboard', 'batch', 'overhear',
];

for (const name of ACTION_HANDLERS) {
  test(`audit smoke (action handler): ${name}`, async () => {
    await smokeAction(name, {});
  });
}

test('audit §B HTTP/task-only commands are registered (no ACTION smoke)', () => {
  const names = new Set(RAW_COMMAND_DEFS.map((c) => c.name));
  const missing = HTTP_OR_TASK_ONLY.filter((n) => !names.has(n));
  assert.equal(missing.length, 0, missing.join(', '));
});

test('audit smoke: combat eat returns contract envelope', async () => {
  const bot = makeStubBot({ inventoryItems: [{ name: 'cooked_beef', count: 1, slot: 36 }] });
  const deps = makeDeps({ bot });
  deps.services = createMockServices({ state: deps.ctx });
  const combat = createCombatActions({
    ...deps,
    ACTIONS: {},
    filterEntitiesFairPlay: (e) => e,
    reactionDelay: async () => {},
    loadLocations: () => ({}),
    getMyName: () => 'Test',
    ctx: { ...deps.ctx, world: { ...deps.ctx.world, mcData: { foodsByName: { cooked_beef: { foodPoints: 8 } } } } },
  });
  const r = await combat.eat();
  assert.equal(validate(r).valid, true);
});
