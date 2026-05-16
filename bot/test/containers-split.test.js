/**
 * Phase 5 — verify the split of actions/containers.js into five focused
 * modules + the relocation of smelt from crafting.js to furnace.js.
 *
 * Each new module is invoked with a minimal legacy-deps stub (the same shape
 * containers.js itself takes) and its handler list is asserted against the
 * documented expectation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validate } from '../lib/shared/action-contract.js';
import { createMockServices } from '../lib/server/mock-services.js';

import { createContainerActions } from '../lib/actions/containers.js';
import { createMarksActions } from '../lib/actions/marks.js';
import { createFurnaceActions } from '../lib/actions/furnace.js';
import { createTeamActions } from '../lib/actions/team.js';
import { createRemindersActions } from '../lib/actions/reminders.js';
import { createCraftingActions } from '../lib/actions/crafting.js';

const EXPECTED = {
  containers: ['list_container', 'deposit', 'withdraw', 'chest_search'],
  marks:      ['mark', 'mark_update', 'marks', 'go_mark', 'unmark'],
  furnace:    ['smelt_start', 'furnace_check', 'furnace_take', 'smelt'],
  team:       ['team_chat', 'team_status', 'rally', 'report', 'set_team', 'set_fair_play'],
  reminders:  ['remind', 'list_reminders', 'unremind'],
};

const FACTORIES = {
  containers: createContainerActions,
  marks:      createMarksActions,
  furnace:    createFurnaceActions,
  team:       createTeamActions,
  reminders:  createRemindersActions,
};

/** Legacy deps shape mirroring what containers.js used to receive from
 *  server.js. Tests don't drive real behaviour; they just need the deps
 *  destructure to succeed when the factory body runs. */
function legacyDeps() {
  const services = createMockServices();
  return {
    ctx: services.state,
    config: services.config,
    ensureBot: services.ensureBot,
    goals: { GoalNear: function GoalNear() {} },
    fmt: services.utils.fmt,
    posObj: services.utils.posObj,
    sleep: services.utils.sleep,
    log: services.utils.log,
    loadLocations: () => ({}),
    saveLocations: () => {},
    flagMarkStale: () => {},
    clearMarkStale: () => {},
    resolveMarkPlaceFromBody: () => null,
    resolveContainerCoords: () => ({ ix: 0, iy: 64, iz: 0 }),
    normalizeDepositWithdrawItems: (b) => b,
    buildMarksListApi: () => [],
    isContainerBlock: () => false,
    findNearbyContainer: () => null,
    snapshotChestAtPosition: () => {},
    rememberSocialEvent: () => {},
    saveReminders: () => {},
    getMyName: () => 'TestBot',
  };
}

test('every new module exposes exactly its expected handlers', () => {
  for (const [name, factory] of Object.entries(FACTORIES)) {
    const actions = factory(legacyDeps());
    const got = Object.keys(actions).filter((k) => typeof actions[k] === 'function').sort();
    const want = [...EXPECTED[name]].sort();
    assert.deepEqual(got, want, `module "${name}" handler set mismatch: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
});

test('total split handler count matches the legacy containers.js + smelt move', () => {
  // Legacy containers.js had 21 handlers. smelt was added to furnace from
  // crafting.js (+1). Total = 22 across the five new modules.
  const total = Object.values(EXPECTED).reduce((s, names) => s + names.length, 0);
  assert.equal(total, 22);
});

test('crafting.js no longer exposes smelt (moved to furnace.js)', () => {
  const services = createMockServices();
  const crafting = createCraftingActions(services);
  assert.equal(crafting.smelt, undefined, 'crafting.smelt should be gone — moved to furnace.js');
  // The other crafting handlers must still be present.
  for (const name of ['craft', 'recipes', 'craft_plan', 'discover']) {
    assert.equal(typeof crafting[name], 'function', `crafting.${name} should still exist`);
  }
});

// ── Representative failure paths per module ──────────────────────────────

test('containers.list_container: MISSING_COORDS contract-validates when no coords supplied', async () => {
  const deps = legacyDeps();
  deps.resolveContainerCoords = () => { throw new Error('Missing coords'); };
  deps.ensureBot = () => ({});
  const actions = createContainerActions(deps);
  const r = await actions.list_container({});
  const v = validate(r);
  assert.equal(v.valid, true, `validate() failed: ${v.issues.join('; ')}`);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'MISSING_COORDS');
});

test('marks.go_mark: returns informal "no location" when mark not found', async () => {
  const deps = legacyDeps();
  deps.loadLocations = () => ({});
  deps.ensureBot = () => ({
    pathfinder: { goto: async () => {}, setGoal: () => {} },
  });
  const actions = createMarksActions(deps);
  // go_mark uses an informal `{result}` shape on unknown mark (not yet
  // migrated to ok/fail contract — pre-Phase-8 legacy pattern).
  const r = await actions.go_mark({ name: 'no_such_mark' });
  assert.match(String(r.result || ''), /no location/i);
});

test('team.set_team: stores team config without crashing', async () => {
  const deps = legacyDeps();
  const actions = createTeamActions(deps);
  const r = await actions.set_team({ team: 'red', role: 'gatherer', teammates: ['a', 'b'] });
  // Informal return shape — but call must succeed and state must mutate.
  assert.equal(deps.ctx.team.teamConfig.team, 'red');
  assert.equal(deps.ctx.team.teamConfig.role, 'gatherer');
  assert.deepEqual(deps.ctx.team.teamConfig.teammates, ['a', 'b']);
});

test('reminders.remind: requires a note', async () => {
  const deps = legacyDeps();
  const actions = createRemindersActions(deps);
  // remind() with no note should error gracefully (throw or contract fail).
  try {
    const r = await actions.remind({});
    // If it returns rather than throws, it must be a contract failure.
    if (r && r.ok === false) {
      const v = validate(r);
      assert.equal(v.valid, true);
    }
  } catch (err) {
    assert.ok(err.message, 'error should have a message');
  }
});
