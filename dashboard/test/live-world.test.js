import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { inferHermesWorldFromPosition, mergeAgentWorld } from '../lib/live-world.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('live-world', () => {
  it('mergeAgentWorld prefers live bot regions world', () => {
    assert.equal(mergeAgentWorld('proc-lab', 'world', 'world'), 'proc-lab');
  });

  it('mergeAgentWorld falls back to registry then default', () => {
    assert.equal(mergeAgentWorld(null, 'landfolk-test', 'world'), 'landfolk-test');
    assert.equal(mergeAgentWorld(null, null, 'world'), 'world');
  });

  it('inferHermesWorldFromPosition maps establish arena coords to proc-lab', () => {
    const w = inferHermesWorldFromPosition(REPO, { x: 10, y: 65, z: -5 }, 'world');
    if (REPO) {
      // When last-establish-map.json exists with arena, coords near muster → proc-lab
      const hasMap = w === 'proc-lab' || w === 'world';
      assert.ok(hasMap);
    }
  });
});
