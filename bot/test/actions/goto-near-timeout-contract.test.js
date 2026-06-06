import test from 'node:test';
import assert from 'node:assert/strict';
import { timeoutError, ACTION_CAPS_MS } from '../../lib/actions/_helpers.js';

test('goto_near OPERATION_TIMEOUT message cites 15000ms cap', () => {
  const r = timeoutError('goto_near', ACTION_CAPS_MS.goto_near, {}, 'hint');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'OPERATION_TIMEOUT');
  assert.match(r.error.message, /goto_near exceeded 15000ms wallclock cap/);
  assert.equal(r.error.observed_state.cap_ms, 15000);
});
