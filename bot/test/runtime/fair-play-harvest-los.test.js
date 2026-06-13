/**
 * Harvest vs generic LOS — leaves must not block mc dig / mc collect after
 * fairPlayHarvestTrunkCandidates already found the log.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createFairPlaySuite } from '../../lib/runtime/fair-play.js';
import { FAIR_PLAY } from '../../lib/runtime/fair-play-constants.js';

function makeSuite(blockAtFn) {
  const bot = {
    entity: { position: new Vec3(0, 64, 0), height: FAIR_PLAY.PHYSICAL_EYE_HEIGHT, yaw: 0, pitch: 0 },
    blockAt: blockAtFn,
  };
  const ctx = { world: { bot, botReady: true }, reactive: { fairPlayMode: true, observedBlocks: new Map() } };
  return createFairPlaySuite({
    ctx,
    ensureBot: () => bot,
    fmt: (n) => n,
    posObj: (p) => (p ? { x: p.x, y: p.y, z: p.z } : null),
    sleep: async () => {},
    getMemoryHints: () => [],
  });
}

test('hasLineOfSight: oak_leaves (solid bbox) between bot and log do not occlude', () => {
  const blocks = new Map([
    ['3,64,0', { name: 'oak_leaves', boundingBox: 'block' }],
    ['4,64,0', { name: 'oak_leaves', boundingBox: 'block' }],
  ]);
  const blockAt = (p) =>
    blocks.get(`${p.x},${p.y},${p.z}`) || { name: 'air', boundingBox: 'empty' };
  const { hasLineOfSight, eyePosition } = makeSuite(blockAt);
  const eye = eyePosition();
  assert.ok(eye);
  const logFace = new Vec3(5.48, 64.5, 0.5);
  assert.ok(hasLineOfSight(eye, logFace), 'leaves in ray path should be transparent for mining LOS');
});

test('hasLineOfSight: stone between bot and log still occludes', () => {
  const blocks = new Map([['3,64,0', { name: 'stone', boundingBox: 'block' }]]);
  const blockAt = (p) =>
    blocks.get(`${p.x},${p.y},${p.z}`) || { name: 'air', boundingBox: 'empty' };
  const { hasLineOfSight, eyePosition } = makeSuite(blockAt);
  const eye = eyePosition();
  const logFace = new Vec3(5.48, 64.5, 0.5);
  assert.equal(hasLineOfSight(eye, logFace), false);
});
