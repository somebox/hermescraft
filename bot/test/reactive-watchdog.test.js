/**
 * Unit tests for the reactive watchdog state machine (task #20).
 *
 * Pure-function coverage of:
 *   - computeBackoffMs: exponential cooldown progression
 *   - shouldResetEscapeCounter: 2-min dry-foot reset window
 *   - isAgentIdle: 5-min "no agent driving" predicate
 *
 * The integration into the tick loop (bot/lib/runtime/reactive.js) is
 * verified live via the next expedition run — these tests pin the
 * helper semantics that the live integration depends on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeBackoffMs,
  shouldResetEscapeCounter,
  isAgentIdle,
  shouldEmergencyDisembark,
  isHostileNearBoat,
} from '../lib/runtime/reactive-helpers.js';

// ─── computeBackoffMs ────────────────────────────────────────────────────

test('computeBackoffMs steps: 30s → 60s → 120s → 300s', () => {
  assert.equal(computeBackoffMs(0), 30_000);
  assert.equal(computeBackoffMs(1), 60_000);
  assert.equal(computeBackoffMs(2), 120_000);
  assert.equal(computeBackoffMs(3), 300_000);
});

test('computeBackoffMs caps at 300s for high fire counts', () => {
  // After 3 fires we're at the cap. circuit-v4 left the bot at 100% CPU
  // for 6.5h because there was no cap — every 30s a new fire. With this
  // cap the worst case is 1 fire per 5 min (~12/hour) regardless of how
  // unrecoverable the situation.
  assert.equal(computeBackoffMs(4), 300_000);
  assert.equal(computeBackoffMs(10), 300_000);
  assert.equal(computeBackoffMs(1000), 300_000);
});

test('computeBackoffMs coerces negative or fractional input to safe value', () => {
  // Defensive: caller might pass anything. Treat <0 as 0 (full cooldown
  // step). NaN/undefined → 0 (lowest cooldown is the safest default).
  assert.equal(computeBackoffMs(-1), 30_000);
  assert.equal(computeBackoffMs(-100), 30_000);
  assert.equal(computeBackoffMs(NaN), 30_000);
  assert.equal(computeBackoffMs(undefined), 30_000);
  // Fractional input floors to int (1.7 → 1 → 60s, NOT 2 → 120s)
  assert.equal(computeBackoffMs(1.7), 60_000);
});

// ─── shouldResetEscapeCounter ────────────────────────────────────────────

test('shouldResetEscapeCounter: false when no dry timestamp recorded yet', () => {
  // Bot has never been observed dry — no reset condition possible.
  assert.equal(shouldResetEscapeCounter(0, 1_000_000), false);
  assert.equal(shouldResetEscapeCounter(null, 1_000_000), false);
  assert.equal(shouldResetEscapeCounter(undefined, 1_000_000), false);
});

test('shouldResetEscapeCounter: true after ≥2-min dry window', () => {
  const now = 1_000_000_000;
  // exactly 2 min ago → reset (boundary inclusive)
  assert.equal(shouldResetEscapeCounter(now - 120_000, now), true);
  // 3 min ago → reset
  assert.equal(shouldResetEscapeCounter(now - 180_000, now), true);
  // 1 hour ago → reset
  assert.equal(shouldResetEscapeCounter(now - 3_600_000, now), true);
});

test('shouldResetEscapeCounter: false if dry for less than 2 min', () => {
  const now = 1_000_000_000;
  assert.equal(shouldResetEscapeCounter(now - 60_000, now), false);
  assert.equal(shouldResetEscapeCounter(now - 119_999, now), false);
  // Same tick — no time at all has passed
  assert.equal(shouldResetEscapeCounter(now, now), false);
});

test('shouldResetEscapeCounter: custom window respected', () => {
  const now = 1_000_000_000;
  // 30s window: 1 min ago triggers reset
  assert.equal(shouldResetEscapeCounter(now - 60_000, now, 30_000), true);
  // 30s window: 20s ago does not
  assert.equal(shouldResetEscapeCounter(now - 20_000, now, 30_000), false);
});

// ─── isAgentIdle ─────────────────────────────────────────────────────────

test('isAgentIdle: true when both agent and task are idle past threshold', () => {
  const now = 1_000_000_000;
  // 10 min since last agent call AND task
  assert.equal(isAgentIdle(now - 600_000, now - 600_000, now), true);
  // exactly at threshold (boundary inclusive)
  assert.equal(isAgentIdle(now - 300_000, now - 300_000, now), true);
});

test('isAgentIdle: false when agent called within threshold', () => {
  const now = 1_000_000_000;
  // agent called 1 min ago, task idle 10 min
  assert.equal(isAgentIdle(now - 60_000, now - 600_000, now), false);
  // agent called just now
  assert.equal(isAgentIdle(now, now - 600_000, now), false);
});

test('isAgentIdle: false when task active within threshold', () => {
  const now = 1_000_000_000;
  // agent idle 10 min, task running 1 min ago
  assert.equal(isAgentIdle(now - 600_000, now - 60_000, now), false);
});

test('isAgentIdle: null/0 timestamps mean "never seen" = fully idle', () => {
  const now = 1_000_000_000;
  // Fresh bot, no agent has ever called → idle from the get-go
  assert.equal(isAgentIdle(0, 0, now), true);
  assert.equal(isAgentIdle(null, null, now), true);
  // Mixed: agent never called but task ran recently → not idle
  assert.equal(isAgentIdle(null, now - 60_000, now), false);
});

test('isAgentIdle: custom idle threshold respected', () => {
  const now = 1_000_000_000;
  // 90s threshold: 2 min ago is idle
  assert.equal(isAgentIdle(now - 120_000, now - 120_000, now, 90_000), true);
  // 90s threshold: 30s ago is not
  assert.equal(isAgentIdle(now - 30_000, now - 30_000, now, 90_000), false);
});

// ─── shouldEmergencyDisembark (task #23 — circuit-v5 survival defense) ───
// Auto-disembark a mounted bot taking damage with low HP. The agent
// log in v5h/v5i/v5j showed Steve getting hit by drowned mobs in the
// lake; HP ticked from 15→0 while the agent processed BOAT_STUCK and
// before any recovery action landed.

test('shouldEmergencyDisembark: mounted + hp<=10 + recently damaged → true', () => {
  assert.equal(shouldEmergencyDisembark({
    mounted: true, hp: 9, recentlyDamaged: true,
    lastAutoDisembarkTs: null, now: 1_000_000_000,
  }), true);
  // Right at the threshold (hp=10) — still triggers (the predicate is ≤).
  assert.equal(shouldEmergencyDisembark({
    mounted: true, hp: 10, recentlyDamaged: true,
    lastAutoDisembarkTs: null, now: 1_000_000_000,
  }), true);
});

test('shouldEmergencyDisembark: not mounted → always false', () => {
  // Dry land + low HP + damage = the existing flee_step handles it.
  assert.equal(shouldEmergencyDisembark({
    mounted: false, hp: 4, recentlyDamaged: true,
    lastAutoDisembarkTs: null, now: 1_000_000_000,
  }), false);
});

test('shouldEmergencyDisembark: HP above threshold → false', () => {
  // Mounted, took a hit, but plenty of HP. Don't bail prematurely.
  assert.equal(shouldEmergencyDisembark({
    mounted: true, hp: 15, recentlyDamaged: true,
    lastAutoDisembarkTs: null, now: 1_000_000_000,
  }), false);
});

test('shouldEmergencyDisembark: no recent damage → false', () => {
  // Steve might just be hungry or low from earlier; don't disembark
  // unless he's ACTIVELY taking hits.
  assert.equal(shouldEmergencyDisembark({
    mounted: true, hp: 5, recentlyDamaged: false,
    lastAutoDisembarkTs: null, now: 1_000_000_000,
  }), false);
});

test('shouldEmergencyDisembark: within 30s cooldown → false (ping-pong guard)', () => {
  const now = 1_000_000_000;
  // Last disembark was 15s ago — well within the 30s cooldown.
  assert.equal(shouldEmergencyDisembark({
    mounted: true, hp: 4, recentlyDamaged: true,
    lastAutoDisembarkTs: now - 15_000, now,
  }), false);
  // Outside cooldown: triggers again.
  assert.equal(shouldEmergencyDisembark({
    mounted: true, hp: 4, recentlyDamaged: true,
    lastAutoDisembarkTs: now - 35_000, now,
  }), true);
});

test('shouldEmergencyDisembark: custom hp threshold respected', () => {
  const now = 1_000_000_000;
  // Tighten the threshold to 5; hp=8 should no longer trigger.
  assert.equal(shouldEmergencyDisembark({
    mounted: true, hp: 8, recentlyDamaged: true,
    lastAutoDisembarkTs: null, now, hpThreshold: 5,
  }), false);
  // hp=5 with the same threshold does trigger.
  assert.equal(shouldEmergencyDisembark({
    mounted: true, hp: 5, recentlyDamaged: true,
    lastAutoDisembarkTs: null, now, hpThreshold: 5,
  }), true);
});

// ─── isHostileNearBoat (task #24 — telemetry predicate) ──────────────────

test('isHostileNearBoat: mounted + hostile within range → true', () => {
  assert.equal(isHostileNearBoat({
    mounted: true,
    closestHostile: { name: 'drowned', distance: 3.5 },
  }), true);
});

test('isHostileNearBoat: not mounted → false (even with hostile in range)', () => {
  // When on foot, the existing combat-tier flee handles it; we don't
  // want to spam the boat-specific telemetry.
  assert.equal(isHostileNearBoat({
    mounted: false,
    closestHostile: { name: 'zombie', distance: 2 },
  }), false);
});

test('isHostileNearBoat: hostile too far → false', () => {
  assert.equal(isHostileNearBoat({
    mounted: true,
    closestHostile: { name: 'drowned', distance: 10 },
  }), false);
});

test('isHostileNearBoat: no hostile → false', () => {
  assert.equal(isHostileNearBoat({ mounted: true, closestHostile: null }), false);
  assert.equal(isHostileNearBoat({ mounted: true, closestHostile: undefined }), false);
});

test('isHostileNearBoat: custom range respected', () => {
  // Tightening to 3 blocks: a hostile at distance 4 no longer triggers.
  assert.equal(isHostileNearBoat({
    mounted: true,
    closestHostile: { name: 'drowned', distance: 4 },
    range: 3,
  }), false);
});
