/**
 * mc dig handler tests.
 *
 * Two clusters:
 *   - DIG_BLOCKED_REPEAT (circuit-v8 postmortem item #3) — surfaces after
 *     ≥3 failures at the same cell within 60s, resets on success.
 *   - DIG_UNDER_FEET (circuit-v8/v11 — Steve dug his own pit) — refuses
 *     to break the block directly below the bot's feet; honors --force.
 *
 * Shared scaffolding lives in `_mining-test-helpers.js` (makeStubBot /
 * makeDeps / makeStubMcData). Collect-side tests live in mining-collect.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createMiningActions } from '../../lib/actions/mining.js';
import { makeStubBot, makeDeps } from './_mining-test-helpers.js';

// ─────────────────────────────────────────────────────────────────────────
// Repeat-fail detector (circuit-v8 postmortem item #3)
// dig surfaces DIG_BLOCKED_REPEAT after ≥3 failures at the same cell
// within 60s. Resets on a successful dig at that cell.
// ─────────────────────────────────────────────────────────────────────────

test('mining.dig: DIG_BLOCKED_REPEAT after 3 NO_LINE_OF_SIGHT failures at the same cell # spec', async () => {
  // Bot at (0,64,0) trying to dig stone at (5,64,0) with no LOS (raycast
  // returns false). 3 calls should all return NO_LINE_OF_SIGHT; 4th
  // returns DIG_BLOCKED_REPEAT pre-empting the LOS check.
  const stoneAt = (pos) => ({
    name: 'stone',
    position: pos,
    getProperties: () => ({}),
    boundingBox: 'block',
    type: 1,
  });
  const bot = makeStubBot({
    position: new Vec3(0, 64, 0),
    blockAtByPos: stoneAt,
  });
  bot.blockAt = stoneAt;
  const deps = makeDeps({
    bot,
    hasLineOfSight: () => false,                  // ← every attempt fails LOS
    eyePosition: () => new Vec3(0, 65.6, 0),
  });
  const actions = createMiningActions(deps);

  for (let i = 1; i <= 3; i++) {
    const r = await actions.dig({ x: 5, y: 64, z: 0 });
    assert.equal(r.ok, false, `attempt ${i} should fail`);
    assert.equal(r.error.code, 'NO_LINE_OF_SIGHT', `attempt ${i} code`);
  }
  const blocked = await actions.dig({ x: 5, y: 64, z: 0 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'DIG_BLOCKED_REPEAT', 'after 3 fails, 4th returns DIG_BLOCKED_REPEAT');
  assert.equal(blocked.error.observed_state.failed_count, 3);
  assert.equal(blocked.error.observed_state.last_error_code, 'NO_LINE_OF_SIGHT');
  assert.deepEqual(blocked.error.observed_state.requested_coord, { x: 5, y: 64, z: 0 });
  assert.match(blocked.error.next_action_hint || '', /mc advise/);
});

test('mining.dig: success at the same cell clears the failure record', async () => {
  // Accumulate 2 failures (under the 3-threshold), then succeed →
  // the failure record at that cell should be cleared so future attempts
  // don't trip the repeat detector.
  let losReturn = false;
  const stoneAt = (pos) => ({
    name: 'stone',
    position: pos,
    getProperties: () => ({}),
    boundingBox: 'block',
    type: 1,
  });
  const bot = makeStubBot({
    position: new Vec3(5, 64, 0),                 // close enough for dig
    blockAtByPos: stoneAt,
    dig: async () => {},                          // success
  });
  bot.blockAt = stoneAt;
  bot.tool = { itemInHand: () => ({ name: 'iron_pickaxe' }) };
  const deps = makeDeps({
    bot,
    hasLineOfSight: () => losReturn,
    eyePosition: () => new Vec3(5, 65.6, 0),
  });
  const actions = createMiningActions(deps);

  // 2 NO_LINE_OF_SIGHT failures — under the 3-threshold so the next dig
  // can still try.
  losReturn = false;
  for (let i = 0; i < 2; i++) await actions.dig({ x: 5, y: 64, z: 0 });
  // Precondition: 1 entry in the failure cache at this cell.
  const before = (deps.ctx.runtime.recentDigFailures || []).find(e =>
    e.cell.x === 5 && e.cell.y === 64 && e.cell.z === 0);
  assert.ok(before && before.hit_count === 2, `precondition: 2 failures recorded, got ${JSON.stringify(before)}`);

  // Flip LOS on → next dig should succeed and clear the record.
  losReturn = true;
  const ok = await actions.dig({ x: 5, y: 64, z: 0 });
  assert.equal(ok.ok, true, `expected ok success: ${JSON.stringify(ok)}`);
  // Failure record at this cell must be gone.
  const remaining = (deps.ctx.runtime.recentDigFailures || []).find(e =>
    e.cell.x === 5 && e.cell.y === 64 && e.cell.z === 0);
  assert.equal(remaining, undefined, 'success should clear the failure record at the cell');
});

// ─────────────────────────────────────────────────────────────────────────
// DIG_UNDER_FEET safety (circuit-v8/v11 — Steve digs his own pit)
// ─────────────────────────────────────────────────────────────────────────

test('mining.dig: DIG_UNDER_FEET refuses to dig the block directly below feet', async () => {
  // Bot at (10, 64, 5). The block at (10, 63, 5) is what the bot is
  // standing on — digging it drops the bot into a 1-cell pit. Refuse.
  const stoneAt = (pos) => ({
    name: 'stone',
    position: pos,
    getProperties: () => ({}),
    boundingBox: 'block',
    type: 1,
  });
  const bot = makeStubBot({
    position: new Vec3(10.3, 64, 5.7),     // foot block = (10, 64, 5); pillar floor at y=63
    blockAtByPos: stoneAt,
  });
  bot.blockAt = stoneAt;
  // Empty inventory — no placeable to climb back out. Should still
  // refuse but the error message should mention the missing placeable.
  bot.inventory = { items: () => [] };
  const deps = makeDeps({ bot });
  const actions = createMiningActions(deps);
  const r = await actions.dig({ x: 10, y: 63, z: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'DIG_UNDER_FEET');
  assert.match(r.error.message, /under your feet/);
  assert.match(r.error.message, /no placeable blocks/);
  assert.equal(r.error.observed_state.has_placeable, false);
});

test('mining.dig: DIG_UNDER_FEET allows the dig when --force is set', async () => {
  // Power-user override (mc stair_down primitive uses this internally).
  const stoneAt = (pos) => ({
    name: 'stone',
    position: pos,
    getProperties: () => ({}),
    boundingBox: 'block',
    type: 1,
  });
  const bot = makeStubBot({
    position: new Vec3(10.3, 64, 5.7),
    blockAtByPos: stoneAt,
  });
  bot.blockAt = stoneAt;
  bot.tool = { itemInHand: () => ({ name: 'iron_pickaxe' }) };
  const deps = makeDeps({ bot, hasLineOfSight: () => true, eyePosition: () => new Vec3(10.3, 65.6, 5.7) });
  const actions = createMiningActions(deps);
  const r = await actions.dig({ x: 10, y: 63, z: 5, force: true });
  // Pass force=true: must NOT return DIG_UNDER_FEET. Other failures
  // (NO_LINE_OF_SIGHT, INTERRUPTED) are acceptable depending on the
  // mock; what we lock in is that DIG_UNDER_FEET specifically is bypassed.
  if (!r.ok) {
    assert.notEqual(r.error.code, 'DIG_UNDER_FEET',
      `--force must bypass DIG_UNDER_FEET; got ${r.error.code}`);
  }
});

test('mining.dig: DIG_UNDER_FEET hint mentions has_placeable=true when bot has dirt', async () => {
  const stoneAt = (pos) => ({
    name: 'stone',
    position: pos,
    getProperties: () => ({}),
    boundingBox: 'block',
    type: 1,
  });
  const bot = makeStubBot({
    position: new Vec3(10.3, 64, 5.7),
    blockAtByPos: stoneAt,
    inventoryItems: [{ name: 'dirt', count: 8 }, { name: 'iron_pickaxe', count: 1 }],
  });
  bot.blockAt = stoneAt;
  const deps = makeDeps({ bot });
  const actions = createMiningActions(deps);
  const r = await actions.dig({ x: 10, y: 63, z: 5 });
  assert.equal(r.error.code, 'DIG_UNDER_FEET');
  assert.equal(r.error.observed_state.has_placeable, true);
  // Different message when placeable IS available.
  assert.doesNotMatch(r.error.message, /no placeable blocks/);
  assert.match(r.error.message, /pillar-down/);
});

test('mining.dig: blocks adjacent to bot but not under-feet are fine', async () => {
  // Foot at (10, 64, 5). Digging (11, 64, 5) — adjacent at foot level,
  // not under feet — must NOT trip DIG_UNDER_FEET.
  const stoneAt = (pos) => ({
    name: 'stone',
    position: pos,
    getProperties: () => ({}),
    boundingBox: 'block',
    type: 1,
  });
  const bot = makeStubBot({
    position: new Vec3(10.3, 64, 5.7),
    blockAtByPos: stoneAt,
    inventoryItems: [],
  });
  bot.blockAt = stoneAt;
  bot.tool = { itemInHand: () => ({ name: 'iron_pickaxe' }) };
  const deps = makeDeps({ bot, hasLineOfSight: () => true, eyePosition: () => new Vec3(10.3, 65.6, 5.7) });
  const actions = createMiningActions(deps);
  const r = await actions.dig({ x: 11, y: 64, z: 5 });
  if (!r.ok) {
    assert.notEqual(r.error.code, 'DIG_UNDER_FEET',
      `lateral dig must not trip DIG_UNDER_FEET; got ${r.error.code}`);
  }
});

test('mining.safe_dig: HAZARD_FALL step-down uses calm harmless wording', async () => {
  const blockAtByPos = (pos) => {
    const { x, y, z } = pos;
    if (x === 5 && z === 5 && y === 64) {
      return { name: 'stone', position: pos, boundingBox: 'block', getProperties: () => ({}) };
    }
    if (x === 5 && z === 5 && y === 61) {
      return { name: 'stone', position: pos, boundingBox: 'block', getProperties: () => ({}) };
    }
    if (x === 5 && z === 5 && y < 64 && y > 61) {
      return { name: 'air', position: pos, boundingBox: 'empty', getProperties: () => ({}) };
    }
    return null;
  };
  const bot = makeStubBot({
    position: new Vec3(5.5, 65, 5.5),
    blockAtByPos,
  });
  bot.blockAt = blockAtByPos;
  const deps = makeDeps({ bot });
  const actions = createMiningActions(deps);
  const r = await actions.safe_dig({ x: 5, y: 64, z: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'HAZARD_FALL');
  assert.match(r.error.message, /harmless/i);
  assert.equal(r.error.observed_state.hazard.dropKind, 'step');
});

