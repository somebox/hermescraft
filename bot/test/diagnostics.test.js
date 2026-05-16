/**
 * Phase 6 — unit tests for the diagnostics helpers extracted from http-app.js.
 *
 * buildActionStats: 5-minute rolling-window aggregator over ctx.tasks.actionCounters.
 * classifyIdleReason: one-word reason for why the bot is idle right now.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildActionStats, classifyIdleReason } from '../lib/server/diagnostics.js';
import { createBotState } from '../lib/server/state.js';

function fixtureState() {
  return createBotState({ behaviors: { fairPlay: true } });
}

// ── buildActionStats ─────────────────────────────────────────────────────

test('buildActionStats: empty window returns zero-shape result with window_sec', () => {
  const state = fixtureState();
  const stats = buildActionStats(state);
  assert.equal(stats.total, 0);
  assert.equal(stats.done, 0);
  assert.equal(stats.failed, 0);
  assert.equal(stats.error_rate_pct, 0);
  assert.equal(stats.actions_per_min, 0);
  assert.deepEqual(stats.top_errors, []);
  assert.equal(stats.window_sec, 300);
});

test('buildActionStats: aggregates done + failed counts in window', () => {
  const state = fixtureState();
  const now = Date.now();
  state.tasks.actionCounters.events.push(
    { ts: now - 10_000, action: 'craft', status: 'done', error: null },
    { ts: now - 9_000,  action: 'craft', status: 'done', error: null },
    { ts: now - 8_000,  action: 'place', status: 'error', error: 'OUT_OF_RANGE' },
    { ts: now - 7_000,  action: 'place', status: 'error', error: 'OUT_OF_RANGE' },
    { ts: now - 6_000,  action: 'place', status: 'error', error: 'NO_SOLID_NEIGHBOR' },
  );
  const stats = buildActionStats(state);
  assert.equal(stats.total, 5);
  assert.equal(stats.done, 2);
  assert.equal(stats.failed, 3);
  assert.equal(stats.error_rate_pct, 60); // 3/5
  // top_errors: deduped by (action, error). OUT_OF_RANGE×2 is the leader.
  assert.equal(stats.top_errors.length, 2);
  assert.match(stats.top_errors[0].msg, /place: OUT_OF_RANGE/);
  assert.equal(stats.top_errors[0].n, 2);
});

test('buildActionStats: drops events older than window_ms', () => {
  const state = fixtureState();
  const now = Date.now();
  state.tasks.actionCounters.events.push(
    { ts: now - 6 * 60_000, action: 'old', status: 'done', error: null }, // 6m ago — too old
    { ts: now - 1_000,      action: 'fresh', status: 'done', error: null },
  );
  const stats = buildActionStats(state);
  assert.equal(stats.total, 1);
});

test('buildActionStats: top_errors capped at 5 entries, sorted by count desc', () => {
  const state = fixtureState();
  const now = Date.now();
  // Inject 7 distinct error keys with varying counts.
  for (let i = 0; i < 7; i++) {
    const n = 7 - i; // 7, 6, 5, 4, 3, 2, 1
    for (let j = 0; j < n; j++) {
      state.tasks.actionCounters.events.push({
        ts: now - 1000 - i * 100,
        action: `verb${i}`,
        status: 'error',
        error: `CODE_${i}`,
      });
    }
  }
  const stats = buildActionStats(state);
  assert.equal(stats.top_errors.length, 5);
  // Verify descending order.
  for (let i = 1; i < stats.top_errors.length; i++) {
    assert.ok(stats.top_errors[i - 1].n >= stats.top_errors[i].n);
  }
  assert.equal(stats.top_errors[0].n, 7);
});

// ── classifyIdleReason ───────────────────────────────────────────────────

test('classifyIdleReason: "disconnected" when bot is null or not ready', () => {
  const a = fixtureState();
  assert.equal(classifyIdleReason(a), 'disconnected'); // bot is null

  a.world.bot = { entity: {} };
  a.world.botReady = false;
  assert.equal(classifyIdleReason(a), 'disconnected'); // not ready
});

test('classifyIdleReason: "task_running" / "task_stuck" reflect currentTask status', () => {
  const s = fixtureState();
  s.world.bot = {};
  s.world.botReady = true;

  s.tasks.currentTask = { status: 'running' };
  assert.equal(classifyIdleReason(s), 'task_running');

  s.tasks.currentTask = { status: 'stuck' };
  assert.equal(classifyIdleReason(s), 'task_stuck');

  s.tasks.currentTask = { status: 'done' };
  assert.equal(classifyIdleReason(s), 'awaiting_agent');
});

test('classifyIdleReason: "error_loop" when same action fails 3× consecutively', () => {
  const s = fixtureState();
  s.world.bot = {};
  s.world.botReady = true;
  s.tasks.actionHistory = [
    { action: 'place', status: 'error', started_at: 1, finished_at: 2, detail: 'x' },
    { action: 'place', status: 'error', started_at: 3, finished_at: 4, detail: 'x' },
    { action: 'place', status: 'error', started_at: 5, finished_at: 6, detail: 'x' },
  ];
  assert.equal(classifyIdleReason(s), 'error_loop');
});

test('classifyIdleReason: "recent_error" when lastApiError <30s ago', () => {
  const s = fixtureState();
  s.world.bot = {};
  s.world.botReady = true;
  s.tasks.lastApiError = { ts: Date.now() - 10_000, method: 'POST', path: '/x', action: null, message: 'oops' };
  assert.equal(classifyIdleReason(s), 'recent_error');

  // Stale error → not flagged.
  s.tasks.lastApiError.ts = Date.now() - 60_000;
  assert.equal(classifyIdleReason(s), 'awaiting_agent');
});

test('classifyIdleReason: "awaiting_agent" when everything is quiet', () => {
  const s = fixtureState();
  s.world.bot = {};
  s.world.botReady = true;
  assert.equal(classifyIdleReason(s), 'awaiting_agent');
});
