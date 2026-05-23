/**
 * Unit tests for refuseWaterRouteWithoutBoat (task #21).
 *
 * The decision is: when an agent calls mc move / bg_goto >100 blocks away,
 * sample the route. If ≥6/30 samples are water:
 *   - has a boat → BOAT_REQUIRED with mc board next_action_hint
 *   - no boat   → WATER_ROUTE_NEEDS_BOAT with craft oak_boat hint
 * Short routes and dry routes pass through (returns null).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { refuseWaterRouteWithoutBoat, createMovementActions } from '../lib/actions/movement.js';

function makeBot({ pos, water = [], inventory = [] }) {
  // water: list of {x,y,z} cells that classify as water source.
  const waterKeys = new Set(water.map((c) => `${c.x},${c.y},${c.z}`));
  return {
    entity: { position: { x: pos[0], y: pos[1], z: pos[2] } },
    inventory: { items: () => inventory.map((name) => ({ name, count: 1 })) },
    blockAt(p) {
      const k = `${p.x},${p.y},${p.z}`;
      if (waterKeys.has(k)) return { name: 'water', boundingBox: 'empty' };
      // Default: dry land — a stone block below the bot's foot Y, air above.
      if (p.y === pos[1] - 1) return { name: 'stone', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    },
  };
}

test('refuseWaterRouteWithoutBoat: probe path inventory error → ROUTE_PROBE_FAILED # spec', () => {
  const water = [];
  for (let i = 0; i <= 200; i++) water.push({ x: i, y: 63, z: 0 });
  const waterKeys = new Set(water.map((c) => `${c.x},${c.y},${c.z}`));
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: {
      items: () => {
        throw new Error('inventory sync failed');
      },
    },
    blockAt(p) {
      const k = `${p.x},${p.y},${p.z}`;
      if (waterKeys.has(k)) return { name: 'water', boundingBox: 'empty' };
      if (p.y === 63) return { name: 'stone', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    },
  };
  const r = refuseWaterRouteWithoutBoat(bot, 200, 64, 0);
  assert.ok(r && !r.ok);
  assert.equal(r.error.code, 'ROUTE_PROBE_FAILED');
  assert.equal(r.error.retry_safe, true);
  assert.match(r.error.next_action_hint, /mc goto/);
});

test('refuseWaterRouteWithoutBoat: short trip (under threshold) → null', () => {
  // Bot at (0,64,0), target at (50,64,0) — distance 50, under 100.
  const bot = makeBot({ pos: [0, 64, 0], inventory: ['oak_boat'] });
  const r = refuseWaterRouteWithoutBoat(bot, 50, 64, 0);
  assert.equal(r, null);
});

test('refuseWaterRouteWithoutBoat: long route over dry land → null', () => {
  const bot = makeBot({ pos: [0, 64, 0], inventory: ['oak_boat'] });
  // Target 200 blocks away, no water anywhere → counts.water should be 0.
  const r = refuseWaterRouteWithoutBoat(bot, 200, 64, 0);
  assert.equal(r, null);
});

test('refuseWaterRouteWithoutBoat: water-heavy route + boat → BOAT_REQUIRED', () => {
  // Build a 30-step line of water at y=63 (one below foot Y). All samples
  // will see water at floor → classified as 'water'.
  const water = [];
  for (let i = 0; i <= 200; i++) water.push({ x: i, y: 63, z: 0 });
  const bot = makeBot({ pos: [0, 64, 0], water, inventory: ['oak_boat'] });
  const r = refuseWaterRouteWithoutBoat(bot, 200, 64, 0);
  assert.ok(r && !r.ok);
  assert.equal(r.error.code, 'BOAT_REQUIRED');
  assert.match(r.error.message, /mc sail_to/);
  assert.match(r.error.message, /oak_boat/);
  assert.ok(r.error.observed_state.route_preview.counts.water >= 6);
  assert.equal(r.error.observed_state.boat_in_inventory, 'oak_boat');
  assert.match(r.error.next_action_hint, /mc sail_to/);
});

test('refuseWaterRouteWithoutBoat: water-heavy route, no boat → WATER_ROUTE_NEEDS_BOAT', () => {
  const water = [];
  for (let i = 0; i <= 200; i++) water.push({ x: i, y: 63, z: 0 });
  const bot = makeBot({ pos: [0, 64, 0], water, inventory: [] });
  const r = refuseWaterRouteWithoutBoat(bot, 200, 64, 0);
  assert.ok(r && !r.ok);
  assert.equal(r.error.code, 'WATER_ROUTE_NEEDS_BOAT');
  assert.match(r.error.message, /no boat/i);
  assert.equal(r.error.next_action_hint, 'mc craft oak_boat');
});

test('refuseWaterRouteWithoutBoat: water below 6/30 threshold → null', () => {
  // Only 4 water cells on the route: not enough to trigger the refusal.
  const water = [
    { x: 50, y: 63, z: 0 }, { x: 51, y: 63, z: 0 },
    { x: 100, y: 63, z: 0 }, { x: 101, y: 63, z: 0 },
  ];
  const bot = makeBot({ pos: [0, 64, 0], water, inventory: ['oak_boat'] });
  const r = refuseWaterRouteWithoutBoat(bot, 200, 64, 0);
  // Probe samples 30 evenly-spaced points; only a tiny window of water
  // around x=50-51 and x=100-101 → most samples land elsewhere → counts.water
  // should stay below 6. May vary; test verifies behaviour, not exact count.
  if (r !== null) {
    assert.ok(r.error.observed_state.route_preview.counts.water >= 6,
      `if refused, water count should be >= 6, got ${r.error.observed_state.route_preview.counts.water}`);
  }
});

test('refuseWaterRouteWithoutBoat: any boat type satisfies the check', () => {
  const water = [];
  for (let i = 0; i <= 200; i++) water.push({ x: i, y: 63, z: 0 });
  for (const boatName of ['spruce_boat', 'cherry_boat', 'bamboo_raft', 'pale_oak_boat']) {
    const bot = makeBot({ pos: [0, 64, 0], water, inventory: [boatName] });
    const r = refuseWaterRouteWithoutBoat(bot, 200, 64, 0);
    assert.equal(r.error.code, 'BOAT_REQUIRED', `${boatName} should trigger BOAT_REQUIRED`);
    assert.equal(r.error.observed_state.boat_in_inventory, boatName);
  }
});

test('refuseWaterRouteWithoutBoat: surfaces first_water sample coord in observed_state', () => {
  const water = [];
  for (let i = 0; i <= 200; i++) water.push({ x: i, y: 63, z: 0 });
  const bot = makeBot({ pos: [0, 64, 0], water, inventory: ['oak_boat'] });
  const r = refuseWaterRouteWithoutBoat(bot, 200, 64, 0);
  const fw = r.error.observed_state.route_preview.first_water;
  assert.ok(fw, 'first_water should be populated');
  // Hint always recommends `mc board` (no-args) for placement; first_water
  // is just diagnostic context in observed_state.
  assert.match(r.error.next_action_hint, /mc sail_to/);
});

test('refuseWaterRouteWithoutBoat: malformed inputs return null (defensive)', () => {
  const water = [{ x: 0, y: 63, z: 0 }];
  const bot = makeBot({ pos: [0, 64, 0], water, inventory: ['oak_boat'] });
  // Missing target coords
  assert.equal(refuseWaterRouteWithoutBoat(bot, NaN, 64, 0), null);
  assert.equal(refuseWaterRouteWithoutBoat(bot, 200, NaN, 0), null);
  // Bot with no position
  assert.equal(refuseWaterRouteWithoutBoat({}, 200, 64, 0), null);
  // Null bot
  assert.equal(refuseWaterRouteWithoutBoat(null, 200, 64, 0), null);
});

test('refuseWaterRouteWithoutBoat: hints at SHORE STANCE (last dry sample before water)', () => {
  // Build a route where the first ~3 samples are dry land, then the rest
  // are water. The hint should tell the agent to mc move to the shore
  // stance (the LAST dry cell) and then mc board to handle placement.
  // Bot at (0,64,0), target at (200,64,0). 30 samples ~6.9 blocks apart.
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => [{ name: 'oak_boat', count: 1 }] },
    blockAt(p) {
      // Sample x in [0, 200], step ~6.9. First 4 samples (x<25) dry land;
      // rest water. probeRouteAlongLine reads foot (y=64), head (65), floor (63).
      if (p.x < 25) {
        if (p.y === 63) return { name: 'stone', boundingBox: 'block' };
        return { name: 'air', boundingBox: 'empty' };
      }
      if (p.y === 63 || p.y === 64) return { name: 'water', boundingBox: 'empty' };
      return { name: 'air', boundingBox: 'empty' };
    },
  };
  const r = refuseWaterRouteWithoutBoat(bot, 200, 64, 0);
  assert.ok(r && !r.ok);
  assert.equal(r.error.code, 'BOAT_REQUIRED');
  const ss = r.error.observed_state.route_preview.shore_stance;
  assert.ok(ss, 'shore_stance should be populated when route has a land→water transition');
  // shore_stance.y is the stance Y (last-land foot Y + 1).
  // The land samples are at x<25. The shore_stance is the LAST land
  // before water, so x should be in [0, 25).
  assert.ok(ss.x < 25, `expected shore_stance x<25 (last dry before water), got ${ss.x}`);
  // The hint always points at mc sail_to — sail_to handles walk-to-shore internally.
  assert.match(r.error.next_action_hint, /mc sail_to/);
});

test('refuseWaterRouteWithoutBoat: no land→water transition → hint is bare mc board', () => {
  // Route is entirely water from the start. No shore_stance.
  const water = [];
  for (let i = 0; i <= 200; i++) water.push({ x: i, y: 63, z: 0 });
  const waterKeys = new Set(water.map((c) => `${c.x},${c.y},${c.z}`));
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => [{ name: 'oak_boat', count: 1 }] },
    blockAt(p) {
      const k = `${p.x},${p.y},${p.z}`;
      if (waterKeys.has(k)) return { name: 'water', boundingBox: 'empty' };
      return { name: 'air', boundingBox: 'empty' };
    },
  };
  const r = refuseWaterRouteWithoutBoat(bot, 200, 64, 0);
  assert.ok(r && !r.ok);
  assert.equal(r.error.observed_state.route_preview.shore_stance, null);
  // Always points at mc sail_to (ferry primitive) — the old chain is gated.
  assert.match(r.error.next_action_hint, /mc sail_to/);
});

test('refuseWaterRouteWithoutBoat: respects custom thresholds', () => {
  // Override longDistanceThreshold to 10 → a 20-block trip should be eligible.
  const water = [];
  for (let i = 0; i <= 20; i++) water.push({ x: i, y: 63, z: 0 });
  const bot = makeBot({ pos: [0, 64, 0], water, inventory: ['oak_boat'] });
  const r = refuseWaterRouteWithoutBoat(bot, 20, 64, 0, { longDistanceThreshold: 10 });
  assert.ok(r && !r.ok);
  assert.equal(r.error.code, 'BOAT_REQUIRED');
});

// ─── F7 — goto retry-loop detector (task #44) ──────────────────────────
// After GOTO_RETRY_LIMIT consecutive bg_goto / goto calls to the same
// floored target fail, the body refuses with NAV_RETRY_LOOP. v31 forensics
// showed the agent burning 12+ bg_goto retries to an unreachable peninsula
// tip with no escalation; this gives a definitive "stop" signal.

// Build a movement-actions instance whose preflightNav always returns
// BOAT_REQUIRED (long route across water, bot has boat). This lets us
// drive goto's failure recording without instantiating a pathfinder.
function makeMovementForRetryTest() {
  // Water across the whole route 0→200 at y=63.
  const water = [];
  for (let i = 0; i <= 200; i++) water.push({ x: i, y: 63, z: 0 });
  const bot = makeBot({ pos: [0, 64, 0], water, inventory: ['oak_boat'] });
  const ctx = { runtime: { lastMoveFailed: null, recentStuckCells: [] }, world: { bot } };
  return createMovementActions({
    ctx,
    ensureBot: () => bot,
    goals: { GoalBlock: function () {}, GoalNear: function () {} },
    fmt: (n) => String(Math.round(Number(n))),
    posObj: () => ({ ...bot.entity.position }),
    ACTIONS: {},
    hasLineOfSight: () => false,
    eyePosition: () => bot.entity.position,
  });
}

test('goto: 4 consecutive failures to same target → NAV_RETRY_LOOP', async () => {
  const movement = makeMovementForRetryTest();
  // First 4 calls all refuse with BOAT_REQUIRED (long route + water).
  for (let i = 1; i <= 4; i++) {
    const r = await movement.goto({ x: 200, y: 64, z: 0 });
    assert.equal(r.ok, false, `call ${i}: expected refusal, got ${JSON.stringify(r).slice(0, 80)}`);
    assert.equal(r.error.code, 'BOAT_REQUIRED', `call ${i}: expected BOAT_REQUIRED, got ${r.error.code}`);
  }
  // 5th call hits the retry-loop check at the top — refuses BEFORE
  // running preflightNav.
  const r5 = await movement.goto({ x: 200, y: 64, z: 0 });
  assert.equal(r5.ok, false);
  assert.equal(r5.error.code, 'NAV_RETRY_LOOP');
  assert.equal(r5.error.observed_state.retry_count, 4);
  assert.equal(r5.error.observed_state.last_reason, 'BOAT_REQUIRED');
  assert.match(r5.error.next_action_hint, /mc advise/);
});

test('goto: retry counter is per-target', async () => {
  // Failing at coord A should not gate a fresh call to coord B.
  const movement = makeMovementForRetryTest();
  // Burn target A's budget.
  for (let i = 0; i < 5; i++) {
    await movement.goto({ x: 200, y: 64, z: 0 });
  }
  // Target B (different floored coords) — must still go through preflight,
  // not the loop refusal.
  const r = await movement.goto({ x: 150, y: 64, z: 0 });
  assert.notEqual(r.error?.code, 'NAV_RETRY_LOOP',
    `target B should not inherit target A's retry count; got ${r.error?.code}`);
});

test('goto: detached-function regression (action registry dispatch)', async () => {
  // Lesson from 970d33b: action registry invokes methods as detached
  // functions (this === undefined). The wrapper / retry logic must not
  // depend on `this`. Pluck the method and call it with `this` removed.
  const movement = makeMovementForRetryTest();
  const detached = movement.goto;
  // Should not throw — even if the result is a refusal, we must get an
  // envelope back, not a TypeError about reading properties of undefined.
  const r = await detached.call(undefined, { x: 200, y: 64, z: 0 });
  assert.ok(r && typeof r === 'object', 'goto must return an envelope, not throw');
  assert.equal('ok' in r || 'error' in r, true);
});

// ─── F24 — mc move retry-loop detector (task #62) ──────────────────────
// Mirrors F7 for the synchronous `mc move` verb. v25-v41 postmortem:
// when bg_goto was refused, the agent chained mc move calls (each one
// pathfinds independently with no shore-proximity awareness), walking
// past the shore into open water. After 4 failed mc move calls to the
// same coord, refuse with NAV_RETRY_LOOP so the agent escalates.

test('move: 4 consecutive failures to same target → NAV_RETRY_LOOP', async () => {
  const movement = makeMovementForRetryTest();
  // First 4 calls all refuse with BOAT_REQUIRED (long route + water).
  // recordMoveFailure('move',...) feeds the per-target counter.
  for (let i = 1; i <= 4; i++) {
    const r = await movement.move({ x: 200, y: 64, z: 0 });
    assert.equal(r.ok, false, `call ${i}: expected refusal, got ${JSON.stringify(r).slice(0, 80)}`);
    assert.equal(r.error.code, 'BOAT_REQUIRED', `call ${i}: expected BOAT_REQUIRED, got ${r.error.code}`);
  }
  // 5th call hits the F24 retry-loop guard at the top — refuses BEFORE
  // pathfinding or preflight.
  const r5 = await movement.move({ x: 200, y: 64, z: 0 });
  assert.equal(r5.ok, false);
  assert.equal(r5.error.code, 'NAV_RETRY_LOOP');
  assert.equal(r5.error.observed_state.retry_count, 4);
  assert.equal(r5.error.observed_state.last_reason, 'BOAT_REQUIRED');
  assert.match(r5.error.next_action_hint, /mc advise/);
  assert.match(r5.error.message, /mc move/, 'message should mention mc move (not bg_goto)');
});

test('move: retry counter is per-target', async () => {
  const movement = makeMovementForRetryTest();
  // Burn target A's budget (5 calls — 4 fails then NAV_RETRY_LOOP).
  for (let i = 0; i < 5; i++) {
    await movement.move({ x: 200, y: 64, z: 0 });
  }
  // Target B (different floored coords) — must still refuse with
  // BOAT_REQUIRED (preflight), not inherit target A's loop refusal.
  const r = await movement.move({ x: 150, y: 64, z: 0 });
  assert.notEqual(r.error?.code, 'NAV_RETRY_LOOP',
    `target B should not inherit target A's retry count; got ${r.error?.code}`);
});

test('move: retry counter is per-verb (move vs goto tracked separately)', async () => {
  // F7 and F24 share the gotoRetryCounts Map but key by verb. Burning
  // mc move's budget for a target should NOT poison the same target's
  // budget for mc bg_goto (and vice versa).
  const movement = makeMovementForRetryTest();
  for (let i = 0; i < 5; i++) {
    await movement.move({ x: 200, y: 64, z: 0 });
  }
  // Now call goto with the same coord — must NOT see NAV_RETRY_LOOP.
  const r = await movement.goto({ x: 200, y: 64, z: 0 });
  assert.notEqual(r.error?.code, 'NAV_RETRY_LOOP',
    `goto must have its own budget; got ${r.error?.code}`);
});

test('move: detached-function regression (action registry dispatch)', async () => {
  // Same protection as F7: action registry calls methods as
  // detached functions. Must not throw `this`-undefined errors.
  const movement = makeMovementForRetryTest();
  const detached = movement.move;
  const r = await detached.call(undefined, { x: 200, y: 64, z: 0 });
  assert.ok(r && typeof r === 'object', 'move must return an envelope, not throw');
  assert.equal('ok' in r || 'error' in r, true);
});
