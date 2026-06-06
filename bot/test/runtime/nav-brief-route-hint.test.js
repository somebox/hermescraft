import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNavFrame } from '../../lib/runtime/nav-brief.js';

test('buildNavFrame: trapped standing surfaces sculpt hint in suggested_hint', () => {
  const blocks = {
    '1,64,0': { name: 'stone', boundingBox: 'block' },
    '1,65,0': { name: 'stone', boundingBox: 'block' },
    '1,66,0': { name: 'air', boundingBox: 'empty' },
  };
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt(pos) {
      const key = `${pos.x},${pos.y},${pos.z}`;
      return blocks[key] || { name: 'air', boundingBox: 'empty' };
    },
    world: { sync: null },
    registry: { biomes: {} },
  };
  const standing = {
    classification: 'trapped',
    cell: { x: 0, y: 64, z: 0 },
    step_up_dirs: ['E'],
    blocked_dirs: ['N', 'E', 'S', 'W'],
    open_dirs: [],
  };
  const frame = buildNavFrame(
    { world: { bot } },
    { getStandingState: () => standing, now: () => 1 },
  );
  assert.ok(frame.header?.suggested_hint);
  assert.match(frame.header.suggested_hint, /mc dig|mc escape/);
});
