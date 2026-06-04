import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAgentWorld } from '../lib/live-world.js';

describe('live-world', () => {
  it('mergeAgentWorld prefers live bot regions world', () => {
    assert.equal(mergeAgentWorld('proc-lab', 'world', 'world'), 'proc-lab');
  });

  it('mergeAgentWorld falls back to registry then default', () => {
    assert.equal(mergeAgentWorld(null, 'landfolk-test', 'world'), 'landfolk-test');
    assert.equal(mergeAgentWorld(null, null, 'world'), 'world');
  });
});
