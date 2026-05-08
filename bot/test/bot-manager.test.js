import assert from 'node:assert/strict';
import test from 'node:test';
import { reconnectBackoffMs, STUCK_MOVEMENT_ACTIONS } from '../lib/bot-manager.js';

test('reconnectBackoffMs caps exponential delay', () => {
  assert.equal(reconnectBackoffMs(0), 5000);
  assert.equal(reconnectBackoffMs(1), 10000);
  assert.equal(reconnectBackoffMs(2), 20000);
  assert.equal(reconnectBackoffMs(3), 40000);
  assert.equal(reconnectBackoffMs(4), 60000);
  assert.equal(reconnectBackoffMs(10), 60000);
});

test('STUCK_MOVEMENT_ACTIONS includes core movement actions', () => {
  for (const a of ['goto', 'collect', 'follow', 'combo']) {
    assert.ok(STUCK_MOVEMENT_ACTIONS.includes(a), a);
  }
});
