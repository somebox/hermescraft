/**
 * Integration tests: bulk digs (dig_area, tunnel) preserve the bot's own
 * stair_down staircase treads unless forced. Protects the retrace egress
 * route so the bot can't tunnel away its way back to the surface.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createExcavationActions } from '../../lib/actions/excavation.js';
import { createDigHandlers } from '../../lib/actions/mining/dig.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { makeMockBot } from '../_helpers/action-harness.js';

// stair_down stand cells → tread supports at (x, y-1, z):
//   (0,64,0), (0,63,-1), (0,62,-2)
const STAIR_TRAIL = {
  steps: [
    { x: 0, y: 65, z: 0 },
    { x: 0, y: 64, z: -1 },
    { x: 0, y: 63, z: -2 },
  ],
  source: 'stair_down',
  start: { x: 0, y: 65, z: 0 },
  end: { x: 0, y: 63, z: -2 },
  ts: Date.now(),
};

function cellKey(x, y, z) {
  return `${x},${y},${z}`;
}

/** Solid-everywhere bot that records which cells it digs. */
function makeBot({ solidAt }) {
  const dug = new Set();
  const bot = {
    entity: { position: new Vec3(5.5, 64, 5.5), onGround: true },
    inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }] },
    look: async () => {},
    lookAt: async () => {},
    setControlState: () => {},
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    blockAt: (p) => {
      const k = cellKey(p.x, p.y, p.z);
      if (dug.has(k)) return { name: 'air', boundingBox: 'empty', position: p };
      if (solidAt(p)) return { name: 'stone', boundingBox: 'block', position: p, digTime: 1 };
      return { name: 'air', boundingBox: 'empty', position: p };
    },
    dig: async (blk) => {
      dug.add(cellKey(blk.position.x, blk.position.y, blk.position.z));
    },
    equip: async () => {},
    stopDigging: () => {},
    heldItem: { name: 'iron_pickaxe' },
    tool: { itemInHand: () => ({ name: 'iron_pickaxe' }), getDigTime: () => 20 },
  };
  return { bot, dug };
}

function makeServices(bot, runtime) {
  const holder = {};
  const services = createMockServices({
    state: {
      world: { botReady: true, bot, mcData: { blocksByName: { lava: { id: 1 } } } },
      runtime,
    },
    ensureBot: () => bot,
    getActions: () => holder.actions,
  });
  const actions = createExcavationActions(services);
  holder.actions = { ...actions, pickup: async () => ({ ok: true }) };
  // NOTE: createMockServices deep-merges (clones) state.runtime, so read the
  // live trail from services.state.runtime — not the passed-in object.
  return { services, actions, runtime: services.state.runtime };
}

test('dig_area: skips a stair_down tread and warns (no --force)', async () => {
  // Box is the single tread support cell (0,64,0).
  const { bot, dug } = makeBot({ solidAt: (p) => p.x === 0 && p.y === 64 && p.z === 0 });
  const { actions, runtime } = makeServices(bot, { lastDugSteps: { ...STAIR_TRAIL } });
  const r = await actions.dig_area({ x1: 0, y1: 64, z1: 0, x2: 0, y2: 64, z2: 0, pickup: false, safe: false });
  assert.equal(r.dug, 0, 'tread must not be dug');
  assert.equal(r.egress_protected, 1);
  assert.equal(dug.has(cellKey(0, 64, 0)), false, 'tread cell stays intact');
  assert.match(r.result, /Preserved 1 staircase tread/);
  assert.ok(runtime.lastDugSteps, 'trail preserved when not forced');
});

test('dig_area: digs non-tread blocks normally even with a trail present', async () => {
  // Solid block at (3,64,3) is NOT a tread → should dig.
  const { bot, dug } = makeBot({ solidAt: (p) => p.x === 3 && p.y === 64 && p.z === 3 });
  const { actions } = makeServices(bot, { lastDugSteps: { ...STAIR_TRAIL } });
  const r = await actions.dig_area({ x1: 3, y1: 64, z1: 3, x2: 3, y2: 64, z2: 3, pickup: false, safe: false });
  assert.equal(r.dug, 1);
  assert.equal(r.egress_protected, undefined);
  assert.ok(dug.has(cellKey(3, 64, 3)));
});

test('dig_area --force: digs through the tread and invalidates the retrace trail', async () => {
  const { bot, dug } = makeBot({ solidAt: (p) => p.x === 0 && p.y === 64 && p.z === 0 });
  const { actions, runtime } = makeServices(bot, { lastDugSteps: { ...STAIR_TRAIL } });
  const r = await actions.dig_area({ x1: 0, y1: 64, z1: 0, x2: 0, y2: 64, z2: 0, pickup: false, safe: false, force: true });
  assert.equal(r.dug, 1, 'forced → tread dug');
  assert.equal(r.egress_removed, 1);
  assert.ok(dug.has(cellKey(0, 64, 0)));
  assert.match(r.result, /Removed 1 staircase tread/);
  assert.equal(runtime.lastDugSteps, null, 'forced breach invalidates retrace trail');
});

test('tunnel: preserves treads it would cross, then --force tunnels through + invalidates', async () => {
  // The staircase descends north (z↓, y↓): tread supports at (0,64,0),
  // (0,63,-1), (0,62,-2). A 3-tall tunnel north from y=62 spans y 62..64,
  // so slice z=-1 crosses tread (0,63,-1) and slice z=-2 crosses (0,62,-2).
  const treadSet = new Set([cellKey(0, 64, 0), cellKey(0, 63, -1), cellKey(0, 62, -2)]);
  const solidAt = (p) => treadSet.has(cellKey(p.x, p.y, p.z));

  // Run 1: no force → treads preserved.
  {
    const { bot, dug } = makeBot({ solidAt });
    const { actions, runtime } = makeServices(bot, { lastDugSteps: { ...STAIR_TRAIL } });
    const r = await actions.tunnel({ x: 0, y: 62, z: 0, direction: 'north', length: 2, width: 1, height: 3, pickup: false });
    assert.equal(r.egress_protected, 2, `expected 2 preserved treads, got ${JSON.stringify(r)}`);
    assert.equal(dug.has(cellKey(0, 63, -1)), false);
    assert.equal(dug.has(cellKey(0, 62, -2)), false);
    assert.match(r.result, /Preserved 2 staircase treads/);
    assert.ok(runtime.lastDugSteps, 'trail preserved');
  }

  // Run 2: force → tunnel through, trail invalidated.
  {
    const { bot, dug } = makeBot({ solidAt });
    const { actions, runtime } = makeServices(bot, { lastDugSteps: { ...STAIR_TRAIL } });
    const r = await actions.tunnel({ x: 0, y: 62, z: 0, direction: 'north', length: 2, width: 1, height: 3, pickup: false, force: true });
    assert.equal(r.egress_removed, 2, `expected 2 removed treads, got ${JSON.stringify(r)}`);
    assert.ok(dug.has(cellKey(0, 63, -1)));
    assert.ok(dug.has(cellKey(0, 62, -2)));
    assert.match(r.result, /Removed 2 staircase treads/);
    assert.equal(runtime.lastDugSteps, null, 'forced tunnel invalidates retrace trail');
  }
});

function makeDigHandlers(ctx, bot) {
  return createDigHandlers({
    ctx,
    config: { behaviors: { regionsEnabled: false, allowSlowDig: true, digDropScanMs: 0 } },
    ensureBot: () => bot,
    goals: { GoalNear: class {} },
    posObj: (p) => ({ x: p.x, y: p.y, z: p.z }),
    sleep: async () => {},
    hasLineOfSight: () => true,
    eyePosition: () => new Vec3(0, 0, 0),
  });
}

/** Vec3-position bot whose dig() runs to completion (for force/success paths). */
function makeDigBot({ x, y, z }) {
  return {
    entity: { position: new Vec3(x, y, z), isInWater: false, onGround: true, yaw: 0, pitch: 0 },
    inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }] },
    entities: {},
    blockAt: (p) => ({ name: 'stone', boundingBox: 'block', position: new Vec3(p.x, p.y, p.z), digTime: 1 }),
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    dig: async () => {},
    equip: async () => {},
    tool: { itemInHand: () => ({ name: 'iron_pickaxe' }), equipForBlock: async () => {}, getDigTime: () => 20 },
    heldItem: { name: 'iron_pickaxe' },
  };
}

test('mc dig: refuses STAIRCASE_EGRESS on a stair_down tread (no --force)', async () => {
  const ctx = { runtime: { recentDigFailures: [], lastDugSteps: { ...STAIR_TRAIL } } };
  const bot = makeMockBot({
    position: { x: 5, y: 64, z: 5 },
    blockAt: (p) => ({ name: 'stone', boundingBox: 'block', position: { x: p.x, y: p.y, z: p.z } }),
  });
  const dig = makeDigHandlers(ctx, bot);
  const r = await dig.dig({ x: 0, y: 64, z: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'STAIRCASE_EGRESS');
  assert.match(r.error.message, /stair_down/);
  assert.ok(ctx.runtime.lastDugSteps, 'refusal must not touch the trail');
});

test('mc dig --force: removes the tread and invalidates the retrace trail', async () => {
  const ctx = { runtime: { recentDigFailures: [], lastDugSteps: { ...STAIR_TRAIL } } };
  const bot = makeDigBot({ x: 5.5, y: 64, z: 5.5 });
  const dig = makeDigHandlers(ctx, bot);
  // (0,63,-1) is a tread support (one below stand cell (0,64,-1)).
  const r = await dig.dig({ x: 0, y: 63, z: -1, force: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ctx.runtime.lastDugSteps, null, 'forced dig through tread invalidates trail');
});

test('mc dig: a non-tread block digs normally with a trail present', async () => {
  const ctx = { runtime: { recentDigFailures: [], lastDugSteps: { ...STAIR_TRAIL } } };
  const bot = makeDigBot({ x: 9.5, y: 64, z: 9.5 });
  const dig = makeDigHandlers(ctx, bot);
  const r = await dig.dig({ x: 9, y: 64, z: 9 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(ctx.runtime.lastDugSteps, 'non-tread dig keeps the trail');
});
