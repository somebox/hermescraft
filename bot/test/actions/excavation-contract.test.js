/**
 * Excavation action contract tests.
 * ADR: docs/design/action-contract.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createExcavationActions } from '../../lib/actions/excavation.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure } from '../_helpers/action-harness.js';

function makeExcavationServices({ bot, digAreaImpl }) {
  const services = createMockServices({
    state: { world: { botReady: true, bot, mcData: { blocksByName: { lava: { id: 1 } } } } },
    ensureBot: () => bot,
    getActions: () => ({
      dig_area: digAreaImpl,
      pickup: async () => ({ ok: true }),
    }),
  });
  return services;
}

test('excavation.dig_area: lava hazard → HAZARD_LAVA', async () => {
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }] },
    blockAt: (p) => {
      const pos = { x: p.x, y: p.y, z: p.z };
      if (p.x === 1 && p.y === 64 && p.z === 0) return { name: 'lava', boundingBox: 'block', position: pos, digTime: 1 };
      if (p.x === 0 && p.y === 64 && p.z === 0) return { name: 'stone', boundingBox: 'block', position: pos, digTime: 1 };
      return { name: 'air', boundingBox: 'empty', position: pos, digTime: 1 };
    },
    pathfinder: { goto: async () => {} },
    dig: async () => {},
  };
  const services = makeExcavationServices({ bot, digAreaImpl: undefined });
  const actions = createExcavationActions(services);
  const r = await actions.dig_area({ x1: 0, y1: 64, z1: 0, x2: 0, y2: 64, z2: 0, safe: true });
  assertFailure(r, { code: 'HAZARD_LAVA', messageIncludes: 'dig_area', retrySafe: false });
});

test('excavation.stair_up: dig_area hazard abort propagates', async () => {
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    inventory: { items: () => [{ name: 'cobblestone', count: 64 }] },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    pathfinder: { goto: async () => {} },
    lookAt: async () => {},
    setControlState: () => {},
    equip: async () => {},
    placeBlock: async () => {},
    dig: async () => {},
  };
  const hazard = {
    ok: false,
    error: {
      code: 'HAZARD_LAVA',
      message: 'dig_area aborted: lava',
      retry_safe: false,
    },
  };
  const services = makeExcavationServices({
    bot,
    digAreaImpl: async () => hazard,
  });
  const actions = createExcavationActions(services);
  const r = await actions.stair_up({ direction: 'north', length: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'HAZARD_LAVA');
});

test('excavation.stair_down: invalid direction returns INVALID_VALUE', async () => {
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    inventory: { items: () => [] },
    blockAt: () => ({ name: 'stone', boundingBox: 'block' }),
    pathfinder: { goto: async () => {} },
  };
  const services = makeExcavationServices({ bot, digAreaImpl: async () => ({ dug: 0 }) });
  const actions = createExcavationActions(services);
  const r = await actions.stair_down({ direction: 'invalid', depth: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_VALUE');
  assert.match(r.error.message, /Invalid direction/);
});

// ─────────────────────────────────────────────────────────────────────────
// pillar_down state-drift: the report's `position` field must reflect
// where pillar_down ENDED, NOT where the post-action pickup pathed to
// reach scattered drops.
//
// Without the snapshot, agents chaining mc ops misread "the position I
// landed at" as "the position pickup ended at", drifting lateral coords
// each iteration. (Genesis run g-2026-05-27-10 mid-P1 obs #4 "next op
// doesn't realize where prev op stopped".)
// ─────────────────────────────────────────────────────────────────────────

test('excavation.pillar_down: reported `position` is captured BEFORE pickup runs', async () => {
  // The bot starts at (10.5, 65, 5.5) and digs down 2 blocks. After the
  // last dig, foot is at (10.5, 63, 5.5). Then pickup runs and (simulated)
  // pathfinds the bot to (3.5, 63, 4.5) chasing drops. The report's
  // `position` must show (10, 63, 5) — the pillar-down landing — not
  // (3, 63, 4) — the pickup-pathed location.
  let digCount = 0;
  let pickupCalled = false;
  const dugCells = new Set();
  const bot = {
    entity: { position: new Vec3(10.5, 65, 5.5), isInWater: false, onGround: true },
    inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }] },
    pathfinder: { goto: async () => {} },
    blockAt: (p) => {
      const key = `${p.x},${p.y},${p.z}`;
      if (dugCells.has(key)) return { name: 'air', position: p, boundingBox: 'empty' };
      // Solid stone column under the bot at x=10, z=5, y=63 and y=64.
      // Below y=63 also stone (so neighbours-have-floor surface check
      // doesn't fire prematurely after 2 digs).
      if (p.x === 10 && p.z === 5 && p.y >= 60 && p.y <= 64) {
        return { name: 'stone', position: p, boundingBox: 'block' };
      }
      // Neighbours at the bot's new foot level have NO floor — so
      // reached_surface stays false and we stop on max_steps_reached.
      return { name: 'air', position: p, boundingBox: 'empty' };
    },
    dig: async (blk) => {
      digCount++;
      const key = `${blk.position.x},${blk.position.y},${blk.position.z}`;
      dugCells.add(key);
      // Drop bot foot one Y on each dig.
      bot.entity.position = new Vec3(10.5, bot.entity.position.y - 1, 5.5);
    },
    equip: async () => {},
    heldItem: { name: 'iron_pickaxe' },
    tool: { itemInHand: () => ({ name: 'iron_pickaxe' }), getDigTime: () => 20 },
  };

  // Simulate pickup PATHING the bot away — this is the state drift the
  // snapshot fix protects against.
  const pickupImpl = async () => {
    pickupCalled = true;
    bot.entity.position = new Vec3(3.5, bot.entity.position.y, 4.5);
    return { ok: true, result: 'picked up 2' };
  };
  const services = createMockServices({
    state: { world: { botReady: true, bot, mcData: { blocksByName: { lava: { id: 1 } } } } },
    ensureBot: () => bot,
    getActions: () => ({ pickup: pickupImpl }),
  });
  const actions = createExcavationActions(services);
  const r = await actions.pillar_down({ count: 2, pickup: true });
  assert.ok(pickupCalled, 'pickup should have been called');
  assert.equal(r.dug, 2, `expected 2 digs, got ${r.dug}`);
  // The KEY assertion: position reflects pre-pickup state.
  assert.equal(r.position.x, 10, `expected x=10 (pillar landing), got ${r.position.x} (likely pickup-pathed)`);
  assert.equal(r.position.z, 5, `expected z=5 (pillar landing), got ${r.position.z} (likely pickup-pathed)`);
  assert.equal(r.position.y, 63, `expected y=63 (pillar landing), got ${r.position.y}`);
  assert.equal(r.endY, 63, `expected endY=63, got ${r.endY}`);
});

test('excavation.pillar_down: position snapshot is correct even when pickup=false (no drift to test)', async () => {
  // Sanity: snapshot logic must also produce the right values when pickup
  // is disabled (no movement after the dig loop).
  const dugCells = new Set();
  const bot = {
    entity: { position: new Vec3(2.5, 64, 8.5), isInWater: false, onGround: true },
    inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }] },
    pathfinder: { goto: async () => {} },
    blockAt: (p) => {
      const key = `${p.x},${p.y},${p.z}`;
      if (dugCells.has(key)) return { name: 'air', position: p, boundingBox: 'empty' };
      if (p.x === 2 && p.z === 8 && p.y >= 60 && p.y <= 63) {
        return { name: 'stone', position: p, boundingBox: 'block' };
      }
      return { name: 'air', position: p, boundingBox: 'empty' };
    },
    dig: async (blk) => {
      const key = `${blk.position.x},${blk.position.y},${blk.position.z}`;
      dugCells.add(key);
      bot.entity.position = new Vec3(2.5, bot.entity.position.y - 1, 8.5);
    },
    equip: async () => {},
    heldItem: { name: 'iron_pickaxe' },
    tool: { itemInHand: () => ({ name: 'iron_pickaxe' }), getDigTime: () => 20 },
  };
  const services = createMockServices({
    state: { world: { botReady: true, bot, mcData: { blocksByName: { lava: { id: 1 } } } } },
    ensureBot: () => bot,
    getActions: () => ({ pickup: async () => ({ ok: true }) }),
  });
  const actions = createExcavationActions(services);
  const r = await actions.pillar_down({ count: 1, pickup: false });
  assert.equal(r.dug, 1);
  assert.equal(r.position.x, 2);
  assert.equal(r.position.z, 8);
  assert.equal(r.position.y, 63);
});
