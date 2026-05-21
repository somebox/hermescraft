/**
 * Unit tests for route-probe.js — bot→target terrain sampler used by
 * mc advise to give the LLM concrete route data (task #6).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifySample, probeRouteAlongLine, HAZARD_NAMES } from '../lib/server/route-probe.js';

// ── classifySample ───────────────────────────────────────────────────

test('classifySample: null → unloaded', () => {
  assert.equal(classifySample(null), 'unloaded');
  assert.equal(classifySample(undefined), 'unloaded');
});

test('classifySample: lava / fire / magma / cactus → hazard', () => {
  for (const name of ['lava', 'flowing_lava', 'fire', 'soul_fire', 'magma_block', 'cactus']) {
    assert.equal(classifySample({ name }), 'hazard', `${name} should be a hazard`);
  }
});

test('classifySample: water / flowing_water → water', () => {
  assert.equal(classifySample({ name: 'water' }), 'water');
  assert.equal(classifySample({ name: 'flowing_water' }), 'water');
});

test('classifySample: air variants → air', () => {
  assert.equal(classifySample({ name: 'air' }), 'air');
  assert.equal(classifySample({ name: 'cave_air' }), 'air');
  assert.equal(classifySample({ name: 'void_air' }), 'air');
});

test('classifySample: solid block (boundingBox=block) → land', () => {
  assert.equal(classifySample({ name: 'stone', boundingBox: 'block' }), 'land');
  assert.equal(classifySample({ name: 'grass_block', boundingBox: 'block' }), 'land');
  assert.equal(classifySample({ name: 'oak_planks', boundingBox: 'block' }), 'land');
});

test('classifySample: non-solid plant → other', () => {
  // foliage doesn't fit air/water/hazard/land; gets bucketed as other.
  assert.equal(classifySample({ name: 'tall_grass', boundingBox: 'empty' }), 'other');
  assert.equal(classifySample({ name: 'dandelion', boundingBox: 'empty' }), 'other');
});

test('classifySample: HAZARD_NAMES set is exported and contains lava', () => {
  assert.ok(HAZARD_NAMES.has('lava'), 'lava must be in the hazard set');
});

// ── probeRouteAlongLine ──────────────────────────────────────────────

function makeBot(blockMap) {
  // blockMap: { 'x,y,z': { name, boundingBox } } — anything not in the map
  // is returned as null (== unloaded).
  return {
    blockAt(pos) {
      return blockMap[`${pos.x},${pos.y},${pos.z}`] || null;
    },
  };
}

test('probeRouteAlongLine: returns empty when bot lacks blockAt', () => {
  const r = probeRouteAlongLine(null, { x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }, 5);
  assert.deepEqual(r, []);
});

test('probeRouteAlongLine: returns the requested sample count (clamped 2-50)', () => {
  const bot = makeBot({});
  assert.equal(probeRouteAlongLine(bot, { x: 0, y: 64, z: 0 }, { x: 9, y: 64, z: 0 }, 10).sample_count, 10);
  // Clamp lower bound: count=1 → forced to 2
  assert.equal(probeRouteAlongLine(bot, { x: 0, y: 64, z: 0 }, { x: 9, y: 64, z: 0 }, 1).sample_count, 2);
  // Clamp upper bound: count=500 → forced to 50
  assert.equal(probeRouteAlongLine(bot, { x: 0, y: 64, z: 0 }, { x: 99, y: 64, z: 0 }, 500).sample_count, 50);
});

test('probeRouteAlongLine: classifies a fully-unloaded route as 100% unloaded', () => {
  const bot = makeBot({}); // blockAt always returns null
  const r = probeRouteAlongLine(bot, { x: 0, y: 64, z: 0 }, { x: 1000, y: 64, z: 1000 }, 10);
  assert.equal(r.counts.unloaded, 10);
});

test('probeRouteAlongLine: detects water along a flat over-the-water route', () => {
  // Build a 10-block route along +X. Place water at y=63 (one below the
  // bot's foot Y of 64). The classifier should mark every sample as water
  // because flc (floor) === 'water'.
  const blocks = {};
  for (let x = 0; x <= 10; x++) {
    blocks[`${x},63,0`] = { name: 'water', boundingBox: 'empty' };
    blocks[`${x},64,0`] = { name: 'air', boundingBox: 'empty' };
    blocks[`${x},65,0`] = { name: 'air', boundingBox: 'empty' };
  }
  const bot = makeBot(blocks);
  const r = probeRouteAlongLine(bot, { x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }, 5);
  assert.equal(r.counts.water, 5);
});

test('probeRouteAlongLine: hazard at any of foot/head/floor wins the classification', () => {
  // Bot's path is mostly land but step 2 has a magma block on the floor.
  const blocks = {};
  for (let x = 0; x <= 4; x++) {
    blocks[`${x},63,0`] = { name: 'stone', boundingBox: 'block' };
    blocks[`${x},64,0`] = { name: 'air', boundingBox: 'empty' };
    blocks[`${x},65,0`] = { name: 'air', boundingBox: 'empty' };
  }
  blocks['2,63,0'] = { name: 'magma_block', boundingBox: 'block' };
  const bot = makeBot(blocks);
  const r = probeRouteAlongLine(bot, { x: 0, y: 64, z: 0 }, { x: 4, y: 64, z: 0 }, 5);
  assert.ok(r.counts.hazard >= 1, `expected at least 1 hazard, got ${JSON.stringify(r.counts)}`);
  assert.ok(r.counts.land >= 1, `expected at least 1 land, got ${JSON.stringify(r.counts)}`);
});

test('probeRouteAlongLine: wall (foot is solid) is distinct from land (foot air over solid)', () => {
  // Bot walking into a wall at x=2: foot is stone, not air.
  const blocks = {};
  for (let x = 0; x <= 4; x++) {
    blocks[`${x},63,0`] = { name: 'stone', boundingBox: 'block' };
    blocks[`${x},64,0`] = { name: 'air', boundingBox: 'empty' };
    blocks[`${x},65,0`] = { name: 'air', boundingBox: 'empty' };
  }
  blocks['2,64,0'] = { name: 'stone', boundingBox: 'block' };
  const bot = makeBot(blocks);
  const r = probeRouteAlongLine(bot, { x: 0, y: 64, z: 0 }, { x: 4, y: 64, z: 0 }, 5);
  assert.ok(r.counts.wall >= 1, `expected at least 1 wall sample, got ${JSON.stringify(r.counts)}`);
});

test('probeRouteAlongLine: bad coords return empty result', () => {
  const bot = makeBot({});
  assert.deepEqual(probeRouteAlongLine(bot, { x: NaN, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 5), []);
  assert.deepEqual(probeRouteAlongLine(bot, null, { x: 0, y: 0, z: 0 }, 5), []);
  assert.deepEqual(probeRouteAlongLine(bot, { x: 0, y: 0, z: 0 }, null, 5), []);
});

test('probeRouteAlongLine: sample positions include both endpoints', () => {
  const bot = makeBot({});
  const r = probeRouteAlongLine(bot, { x: 0, y: 64, z: 0 }, { x: 8, y: 64, z: 0 }, 5);
  assert.equal(r.samples[0].x, 0, 'first sample should be at start.x');
  assert.equal(r.samples[r.samples.length - 1].x, 8, 'last sample should be at end.x');
});

test('probeRouteAlongLine: defensive against blockAt that throws', () => {
  const bot = { blockAt: () => { throw new Error('chunk pending'); } };
  const r = probeRouteAlongLine(bot, { x: 0, y: 64, z: 0 }, { x: 4, y: 64, z: 0 }, 5);
  // Every sample's foot/head/floor lookup throws → null → 'unloaded'.
  assert.equal(r.counts.unloaded, 5);
});
