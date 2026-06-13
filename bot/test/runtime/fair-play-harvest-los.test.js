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

// Characterization pin for the unified occludesLOS predicate (Pass 1). The
// key branch existing tests miss is the harvest target-log identity: a log
// is transparent ONLY in harvest mode AND only when it IS the target.
test('occludesLOS: target-log identity differs by mode', () => {
  const { occludesLOS } = makeSuite(() => ({ name: 'air', boundingBox: 'empty' }));
  const log = { name: 'oak_log', boundingBox: 'block' };
  const otherLog = { name: 'spruce_log', boundingBox: 'block' };
  const leaves = { name: 'oak_leaves', boundingBox: 'block' };
  const stone = { name: 'stone', boundingBox: 'block' };

  // Harvest mode: the matching log is passable (you're looking AT it);
  // a different-species log still occludes.
  assert.equal(occludesLOS(log, { mode: 'harvest', targetName: 'oak_log' }), false);
  assert.equal(occludesLOS(otherLog, { mode: 'harvest', targetName: 'oak_log' }), true);

  // Generic mode: every log occludes (no target to look at).
  assert.equal(occludesLOS(log, { mode: 'generic' }), true);
  assert.equal(occludesLOS(log), true); // generic is the default

  // Foliage passes in both modes; solid stone occludes in both.
  assert.equal(occludesLOS(leaves, { mode: 'generic' }), false);
  assert.equal(occludesLOS(leaves, { mode: 'harvest', targetName: 'oak_log' }), false);
  assert.equal(occludesLOS(stone, { mode: 'generic' }), true);
  assert.equal(occludesLOS(stone, { mode: 'harvest', targetName: 'oak_log' }), true);
});
