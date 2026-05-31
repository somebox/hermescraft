import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fail, ok } from '../../lib/shared/action-contract.js';
import { fromAction, formatSuggested } from '../../lib/shared/envelope.js';

describe('envelope', () => {
  it('fromAction adapts ok()', () => {
    const env = fromAction(ok({ data: { x: 1 }, result: 'done' }));
    assert.equal(env.ok, true);
    assert.deepEqual(env.data, { x: 1 });
  });

  it('fromAction round-trips P9 next_action_hint string on fail()', () => {
    const hint = 'mc collect oak_log 2';
    const env = fromAction(fail('MISSING_INGREDIENTS', 'need wool', { next_action_hint: hint, retry_safe: true }));
    assert.equal(env.ok, false);
    assert.equal(env.suggested, hint);
    assert.equal(formatSuggested(env.suggested), hint);
  });

  it('formatSuggested builds validator-safe one-liner from structured suggested', () => {
    const line = formatSuggested({ verb: 'goto_near', args: ['-456', '74', '593', '2'], why: 'retry path' });
    assert.match(line, /^mc goto_near/);
    assert.match(line, /# retry path$/);
  });

  it('formatSuggested passes through mc-prefixed verb', () => {
    assert.equal(formatSuggested({ verb: 'mc move', args: '1 2 3' }), 'mc move 1 2 3');
  });
});
