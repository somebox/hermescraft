/**
 * Unit tests for pillar-outcome.js — the pure messaging + sky-exposure
 * helpers behind mc pillar_up.
 *
 * These pin the 2026-05-29 fix: a partial climb that hit a stone ceiling
 * bare-handed must report the stop loudly (placed/requested + the real
 * blocker + a --force / tool next step), not return a bare "climbed N"
 * success that the agent misreads as "lateral exit at every level".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
  describePillarOutcome,
  isCellSkyExposed,
  classifyPillarBlocker,
} from '../../lib/actions/building/pillar-outcome.js';

// ── isCellSkyExposed ──────────────────────────────────────────────────────

test('isCellSkyExposed: true when the column above is all air', () => {
  const blockAt = () => ({ name: 'air', boundingBox: 'empty' });
  assert.equal(isCellSkyExposed(blockAt, 0, 70, 0, 120), true);
});

test('isCellSkyExposed: false when a solid block sits overhead (cave roof)', () => {
  const blockAt = (p) => (p.y === 75
    ? { name: 'stone', boundingBox: 'block' }
    : { name: 'air', boundingBox: 'empty' });
  assert.equal(isCellSkyExposed(blockAt, 0, 65, 0, 120), false);
});

test('isCellSkyExposed: air-named "block" boundingBox does not count as a ceiling', () => {
  // Defensive: cave_air can report boundingBox oddly; name takes priority.
  const blockAt = () => ({ name: 'cave_air', boundingBox: 'block' });
  assert.equal(isCellSkyExposed(blockAt, 0, 65, 0, 80), true);
});

// ── classifyPillarBlocker ─────────────────────────────────────────────────

test('classifyPillarBlocker: empty-hand stone refusal → no_tool', () => {
  assert.equal(
    classifyPillarBlocker(['placement did not register within 1.5s (ensureHeadroom: attempted=1, succeeded=0, lastError=Refusing to dig stone with "empty hand")']),
    'no_tool',
  );
});

test('classifyPillarBlocker: region denylist → protected', () => {
  assert.equal(classifyPillarBlocker(['POLICY_DENY at 1,70,2 (oak_planks)']), 'protected');
});

test('classifyPillarBlocker: generic place failure → obstructed; empty → null', () => {
  assert.equal(classifyPillarBlocker(['target cell is already solid (stone)']), 'obstructed');
  assert.equal(classifyPillarBlocker([]), null);
});

// ── describePillarOutcome ─────────────────────────────────────────────────

test('describePillarOutcome: PRODUCTION BUG — partial climb on stone ceiling, no tool', () => {
  // The exact transcript scenario: asked for 9, placed 1, then stone ceiling
  // + bare hands stopped it. Must NOT look like a clean success.
  const o = describePillarOutcome({
    placed: 1,
    requested: 9,
    startY: 64,
    endY: 65,
    x: -442,
    z: 586,
    stopReason: 'obstruction',
    failReasons: ['placement did not register within 1.5s (ensureHeadroom: attempted=1, succeeded=0, lastError=Refusing to dig stone with "empty hand")'],
    forced: false,
  });
  assert.equal(o.stoppedEarly, true);
  assert.equal(o.blocker, 'no_tool');
  assert.match(o.message, /climbed 1\/9/);
  assert.match(o.message, /stopped early/i);
  assert.match(o.message, /bare-handed/i);
  // remaining = 9 - 1 = 8; the next-step hint must point at --force.
  assert.equal(o.remaining, 8);
  assert.match(o.nextHint, /pillar_up 8 --force/);
});

test('describePillarOutcome: forced + no tool suggests crafting a pickaxe instead of --force again', () => {
  const o = describePillarOutcome({
    placed: 2, requested: 9, startY: 64, endY: 66, x: 0, z: 0,
    stopReason: 'obstruction',
    failReasons: ['Refusing to dig stone with "empty hand"'],
    forced: true,
  });
  assert.match(o.nextHint, /pickaxe/i);
  assert.doesNotMatch(o.nextHint, /--force/);
});

test('describePillarOutcome: reached a sky-open surface → step-out hint, not stopped early', () => {
  const o = describePillarOutcome({
    placed: 4, requested: 8, startY: 64, endY: 68, x: 10, z: 20,
    stopReason: 'surface',
    lateralExit: { x: 11, y: 68, z: 20, floor: 'grass_block' },
  });
  assert.equal(o.stoppedEarly, false);
  assert.match(o.message, /surface/i);
  assert.match(o.nextHint, /goto_near 11 68 20 1/);
});

test('describePillarOutcome: full clean climb with room — no force/stop noise', () => {
  const o = describePillarOutcome({
    placed: 5, requested: 5, startY: 64, endY: 69, x: 0, z: 0,
    stopReason: 'count',
  });
  assert.equal(o.stoppedEarly, false);
  assert.equal(o.nextHint, null);
  assert.match(o.message, /climbed 5 blocks: Y 64 → 69/);
  assert.doesNotMatch(o.message, /stopped early|force/i);
});

test('describePillarOutcome: count reached but on a 1×1 column → BOT_ON_PILLAR cleanup guidance', () => {
  const o = describePillarOutcome({
    placed: 5, requested: 5, startY: 64, endY: 69, x: 0, z: 0,
    stopReason: 'count',
    onPillar: true,
    shaftTrap: { walls: [], can_pillar_further: true },
  });
  assert.match(o.message, /BOT_ON_PILLAR/);
  assert.match(o.message, /pillar_down 5/);
});

test('describePillarOutcome: total failure (placed 0) → fail message + force hint', () => {
  const o = describePillarOutcome({
    placed: 0, requested: 9, startY: 65, endY: 65, x: -442, z: 586,
    stopReason: 'failed',
    failReasons: ['Refusing to dig stone with "empty hand"'],
    forced: false,
  });
  assert.match(o.message, /could not place any blocks/);
  assert.match(o.message, /no pickaxe/i);
  assert.match(o.nextHint, /pillar_up 9 --force/);
});

test('describePillarOutcome: offers a side exit alternative when one was seen', () => {
  const o = describePillarOutcome({
    placed: 1, requested: 9, startY: 64, endY: 65, x: 0, z: 0,
    stopReason: 'obstruction',
    failReasons: ['Refusing to dig stone with "empty hand"'],
    sideExit: { x: 1, y: 65, z: 0, floor: 'stone' },
  });
  assert.match(o.nextHint, /goto_near 1 65 0 1/);
});
