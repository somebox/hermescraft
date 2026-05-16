/**
 * Phase 3 — sliced state tests.
 *
 * Asserts that each slice constructor returns the fields named in the
 * FIELD_SLICE_MAP authoritative reference, and that the full createBotState
 * has every documented slice + config. Drift in either direction breaks the
 * test (slice grows a field but FIELD_SLICE_MAP doesn't, or vice versa).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBotState,
  createWorldState,
  createSocialState,
  createTasksState,
  createRuntimeState,
  createGoalsState,
  createTeamState,
  createRemindersState,
  createDeathState,
  createReactiveState,
  FIELD_SLICE_MAP,
} from '../lib/server/state.js';

const SLICE_CONSTRUCTORS = {
  world:     () => createWorldState(),
  social:    () => createSocialState(),
  tasks:     () => createTasksState(),
  runtime:   () => createRuntimeState(),
  goals:     () => createGoalsState(),
  team:      () => createTeamState(),
  reminders: () => createRemindersState(),
  death:     () => createDeathState(),
  reactive:  () => createReactiveState({ behaviors: { fairPlay: true } }),
};

test('createBotState returns config + every slice declared in FIELD_SLICE_MAP', () => {
  const state = createBotState({ behaviors: { fairPlay: true } });
  const expectedKeys = ['config', ...Object.keys(FIELD_SLICE_MAP)].sort();
  const actualKeys = Object.keys(state).sort();
  assert.deepEqual(actualKeys, expectedKeys);
});

test('every slice constructor produces exactly the fields named in FIELD_SLICE_MAP', () => {
  for (const [slice, expected] of Object.entries(FIELD_SLICE_MAP)) {
    const constructor = SLICE_CONSTRUCTORS[slice];
    assert.ok(constructor, `no SLICE_CONSTRUCTORS entry for "${slice}"`);
    const actual = Object.keys(constructor()).sort();
    const wanted = [...expected].sort();
    assert.deepEqual(
      actual, wanted,
      `slice "${slice}" fields drift: got ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`,
    );
  }
});

test('two bot-state instances do not share mutable arrays/maps/objects', () => {
  const a = createBotState({ behaviors: { fairPlay: true } });
  const b = createBotState({ behaviors: { fairPlay: true } });

  a.social.chatLog.push({ time: 0, from: 'x', message: 'y' });
  assert.equal(b.social.chatLog.length, 0);

  a.tasks.actionHistory.push({ action: 'foo' });
  assert.equal(b.tasks.actionHistory.length, 0);

  a.runtime.recentPickups.push({ ts: 0, item: 'x', count: 1, source: 'test' });
  assert.equal(b.runtime.recentPickups.length, 0);

  a.goals.chestSnapshots.someMark = { total: 1 };
  assert.equal(b.goals.chestSnapshots.someMark, undefined);

  a.reactive.observedBlocks.set('k', { lastSeen: 1 });
  assert.equal(b.reactive.observedBlocks.size, 0);
});

test('createBotState carries the config reference at top level', () => {
  const cfg = { behaviors: { fairPlay: false }, mc: { username: 'X' } };
  const s = createBotState(cfg);
  assert.equal(s.config, cfg);
});

test('reactive.fairPlayMode tracks config.behaviors.fairPlay', () => {
  assert.equal(createBotState({ behaviors: { fairPlay: true } }).reactive.fairPlayMode, true);
  assert.equal(createBotState({ behaviors: { fairPlay: false } }).reactive.fairPlayMode, false);
});

test('every default field has a sensible empty/zero value', () => {
  const state = createBotState({ behaviors: { fairPlay: true } });
  // Arrays start empty.
  assert.equal(state.social.chatLog.length, 0);
  assert.equal(state.social.overheardLog.length, 0);
  assert.equal(state.social.commandQueue.length, 0);
  assert.equal(state.tasks.taskHistory.length, 0);
  assert.equal(state.tasks.actionHistory.length, 0);
  assert.equal(state.runtime.recentPlaceFailures.length, 0);
  assert.equal(state.runtime.recentEscapes.length, 0);
  assert.equal(state.runtime.recentPickups.length, 0);
  assert.equal(state.runtime.recentStuckCells.length, 0);
  assert.equal(state.runtime.soundEvents.length, 0);
  assert.equal(state.death.deathLog.length, 0);
  assert.equal(state.team.activeFurnaces.length, 0);
  assert.equal(state.reminders.reminders.length, 0);

  // Nullable singletons.
  assert.equal(state.world.bot, null);
  assert.equal(state.world.mcData, null);
  assert.equal(state.world.connectPromise, null);
  assert.equal(state.tasks.currentTask, null);
  assert.equal(state.tasks.lastApiError, null);
  assert.equal(state.runtime.lastMoveFailed, null);
  assert.equal(state.death.lastDeath, null);
  assert.equal(state.death.lastDamageEvent, null);

  // Booleans.
  assert.equal(state.world.botReady, false);
  assert.equal(state.tasks.syncActionInFlight, false);
  assert.equal(state.death.hardcoreDead, false);
  assert.equal(state.team.isSneaking, false);
  assert.equal(state.death.suppressEndReconnect, false);

  // Numbers.
  assert.equal(state.death.lastHealth, 20);
  assert.equal(state.death.reconnectAttempts, 0);
  assert.equal(state.reminders.remindersNextId, 1);
  assert.equal(state.social.lastChatTs, 0);

  // Caps + windows.
  assert.equal(state.social.MAX_LOG, 100);
  assert.equal(state.social.MAX_QUEUE, 20);
  assert.equal(state.tasks.MAX_ACTION_HISTORY, 24);
  assert.equal(state.tasks.MAX_TASK_HISTORY, 50);
  assert.equal(state.tasks.actionCounters.window_ms, 5 * 60 * 1000);
  assert.equal(state.tasks.actionCounters.events.length, 0);

  // Maps and complex objects.
  assert.ok(state.reactive.observedBlocks instanceof Map);
  assert.equal(state.reactive.observedBlocks.size, 0);
  assert.deepEqual(state.goals.goalsStore.goals, []);
  assert.deepEqual(state.goals.chestSnapshots, {});
  assert.deepEqual(state.team.combatStats, { kills: 0, deaths: 0, assists: 0, damageDealt: 0, damageTaken: 0 });

  // bootTime is "now" at construction.
  assert.ok(state.world.bootTime > 0);
  assert.ok(Math.abs(state.world.bootTime - Date.now()) < 1000);
});
