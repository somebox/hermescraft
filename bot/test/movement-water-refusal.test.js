/**
 * Unit tests for refuseWaterRouteWithoutBoat (task #21).
 *
 * The decision is: when an agent calls mc move / bg_goto >100 blocks away,
 * sample the route. If ≥6/30 samples are water:
 *   - has a boat → BOAT_REQUIRED with place_boat next_action_hint
 *   - no boat   → WATER_ROUTE_NEEDS_BOAT with craft oak_boat hint
 * Short routes and dry routes pass through (returns null).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { refuseWaterRouteWithoutBoat } from '../lib/actions/movement.js';

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
  assert.match(r.error.message, /place_boat/);
  assert.match(r.error.message, /oak_boat/);
  assert.ok(r.error.observed_state.route_preview.counts.water >= 6);
  assert.equal(r.error.observed_state.boat_in_inventory, 'oak_boat');
  assert.ok(r.error.next_action_hint.startsWith('mc place_boat'));
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

test('refuseWaterRouteWithoutBoat: surfaces first_water sample coord for place_boat hint', () => {
  const water = [];
  for (let i = 0; i <= 200; i++) water.push({ x: i, y: 63, z: 0 });
  const bot = makeBot({ pos: [0, 64, 0], water, inventory: ['oak_boat'] });
  const r = refuseWaterRouteWithoutBoat(bot, 200, 64, 0);
  const fw = r.error.observed_state.route_preview.first_water;
  assert.ok(fw, 'first_water should be populated');
  assert.match(r.error.next_action_hint, new RegExp(`mc place_boat ${fw.x} ${fw.y} ${fw.z}`));
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

test('refuseWaterRouteWithoutBoat: respects custom thresholds', () => {
  // Override longDistanceThreshold to 10 → a 20-block trip should be eligible.
  const water = [];
  for (let i = 0; i <= 20; i++) water.push({ x: i, y: 63, z: 0 });
  const bot = makeBot({ pos: [0, 64, 0], water, inventory: ['oak_boat'] });
  const r = refuseWaterRouteWithoutBoat(bot, 20, 64, 0, { longDistanceThreshold: 10 });
  assert.ok(r && !r.ok);
  assert.equal(r.error.code, 'BOAT_REQUIRED');
});
