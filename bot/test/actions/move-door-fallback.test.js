/**
 * Door-fallback paths in mc move — regression for missing `ctx` in createMove (34d6340)
 * and nav-brief negative-leg recording on marked targets.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createMove } from '../../lib/actions/movement/move.js';
import { navBriefLineKey } from '../../lib/runtime/nav-brief.js';

function makeMoveDeps({ bot, ctx, throughOk = true, locations = {} }) {
  return {
    ctx,
    ensureBot: () => bot,
    goals: {
      GoalBlock: class GoalBlock {
        constructor(x, y, z) {
          this.x = x;
          this.y = y;
          this.z = z;
        }
      },
      GoalNear: class GoalNear {
        constructor(x, y, z, r) {
          this.x = x;
          this.y = y;
          this.z = z;
          this.range = r;
        }
      },
    },
    gotoRetryKey: (verb, x, y, z) => `${verb}@${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`,
    gotoRetryCounts: new Map(),
    GOTO_RETRY_LIMIT: 4,
    ACTIONS: {
      through: async () => (throughOk ? { ok: true, data: { closed: false } } : { ok: false, error: { message: 'blocked' } }),
      escape: async () => ({ ok: true }),
    },
    recordMoveFailure: () => {},
    clearMoveFailure: () => {},
    clearGotoRetry: () => {},
    pushStuckCell: () => {},
    preflightNav: () => null,
    preNudgeIfSticky: async () => {},
    fmt: (n) => String(Math.round(Number(n))),
    posObj: () => ({
      x: bot.entity.position.x,
      y: bot.entity.position.y,
      z: bot.entity.position.z,
    }),
    loadLocations: () => locations,
    config: { behaviors: {} },
    services: {},
  };
}

function makeBotForNoDoor() {
  const pos = new Vec3(0, 64, 0);
  return {
    entity: { position: pos, isInWater: false },
    pathfinder: {
      movements: {},
      getPathTo: () => null,
      goto: async () => {},
      setGoal: () => {},
    },
    findBlocks: () => [],
    blockAt: () => ({ name: 'stone', boundingBox: 'block' }),
  };
}

function makeBotWithDoorLoop({ doorX = 40 }) {
  const doorPos = new Vec3(doorX, 64, 0);
  const pos = new Vec3(0, 64, 0);
  return {
    entity: { position: pos, isInWater: false },
    pathfinder: {
      movements: {},
      getPathTo: () => ({ status: 'success', path: [{ x: 0, y: 64, z: 0 }] }),
      goto: async () => {},
      setGoal: () => {},
    },
    findBlocks: () => [doorPos],
    blockAt(p) {
      if (p.x === doorPos.x && p.y === doorPos.y && p.z === doorPos.z) {
        return { name: 'oak_door', boundingBox: 'block', getProperties: () => ({ half: 'lower', open: 'false' }) };
      }
      return { name: 'stone', boundingBox: 'block' };
    },
  };
}

test('move: no door/gate path returns NAV_BLOCKED without throwing (ctx regression)', async () => {
  const bot = makeBotForNoDoor();
  const ctx = { runtime: { navBriefNegativeLegs: {} }, world: { bot } };
  const move = createMove(makeMoveDeps({
    bot,
    ctx,
    locations: { scout_pin: { x: 8, y: 64, z: 0 } },
  }));
  const r = await move({ x: 8, y: 64, z: 0, mark: 'scout_pin' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NAV_BLOCKED');
  assert.match(r.error.message, /no door\/gate/i);
  assert.ok(ctx.runtime.navBriefNegativeLegs[navBriefLineKey({ verb: 'move', args: 'scout_pin' })]);
});

test('move: no door path without mark does not record negative leg', async () => {
  const bot = makeBotForNoDoor();
  const ctx = { runtime: { navBriefNegativeLegs: {} }, world: { bot } };
  const move = createMove(makeMoveDeps({ bot, ctx }));

  const r = await move({ x: 8, y: 64, z: 0 });
  assert.equal(r.ok, false);
  assert.equal(Object.keys(ctx.runtime.navBriefNegativeLegs).length, 0);
});

test('move: max doors exhausted returns TOO_MANY_DOORS and records negative leg', async () => {
  const bot = makeBotWithDoorLoop({});
  const ctx = { runtime: { navBriefNegativeLegs: {} }, world: { bot } };
  const move = createMove(makeMoveDeps({
    bot,
    ctx,
    locations: { base_anchor: { x: 80, y: 64, z: 0 } },
  }));

  const r = await move({ x: 80, y: 64, z: 0, max_doors: 1, mark: 'base_anchor' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'TOO_MANY_DOORS');
  assert.ok(ctx.runtime.navBriefNegativeLegs[navBriefLineKey({ verb: 'move', args: 'base_anchor' })]);
});

// proc-nav-1781014144: movement failures said "No path" with no WHY —
// lastPathfinderError was recorded internally but only surfaced in one
// branch. These pin pathfinder_error + the readable reason clause.

test('move: NAV_BLOCKED surfaces pathfinder error reason in message + observed_state', async () => {
  const bot = makeBotForNoDoor();
  bot.pathfinder.goto = async () => { throw new Error('No path to the goal!'); };
  const ctx = { runtime: { navBriefNegativeLegs: {} }, world: { bot } };
  const move = createMove(makeMoveDeps({ bot, ctx }));

  const r = await move({ x: 8, y: 64, z: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NAV_BLOCKED');
  assert.equal(r.error.observed_state.pathfinder_error, 'No path to the goal!');
  assert.match(r.error.message, /Why: pathfinder searched and found no route/);
});

test('move: TOO_MANY_DOORS carries pathfinder_error + readable clause', async () => {
  const bot = makeBotWithDoorLoop({});
  bot.pathfinder.goto = async () => { throw new Error('No path to the goal!'); };
  const ctx = { runtime: { navBriefNegativeLegs: {} }, world: { bot } };
  const move = createMove(makeMoveDeps({ bot, ctx }));

  const r = await move({ x: 80, y: 64, z: 0, max_doors: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'TOO_MANY_DOORS');
  assert.equal(r.error.observed_state.pathfinder_error, 'No path to the goal!');
  assert.match(r.error.message, /Last pathfinder failure: pathfinder searched and found no route/);
});

test('move: door traverse failure includes pathfinder_error in observed_state', async () => {
  const bot = makeBotWithDoorLoop({});
  bot.pathfinder.goto = async () => { throw new Error('No path to the goal!'); };
  const ctx = { runtime: { navBriefNegativeLegs: {} }, world: { bot } };
  const move = createMove(makeMoveDeps({ bot, ctx, throughOk: false }));

  const r = await move({ x: 80, y: 64, z: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NAV_BLOCKED');
  assert.match(r.error.message, /Could not traverse/);
  assert.equal(r.error.observed_state.pathfinder_error, 'No path to the goal!');
});
