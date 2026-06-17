import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adviseHintsSuppressed, escalationHint } from '../lib/shared/escalation-hint.js';

function withEnv(value, fn) {
  const prev = process.env.MC_SUPPRESS_ADVISE_HINTS;
  if (value === undefined) delete process.env.MC_SUPPRESS_ADVISE_HINTS;
  else process.env.MC_SUPPRESS_ADVISE_HINTS = value;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.MC_SUPPRESS_ADVISE_HINTS;
    else process.env.MC_SUPPRESS_ADVISE_HINTS = prev;
  }
}

test('escalationHint: default (unset) keeps the mc advise directive', () => {
  withEnv(undefined, () => {
    assert.equal(adviseHintsSuppressed(), false);
    assert.equal(
      escalationHint({ reason: 'dig blocked at 1,2,3' }),
      'mc advise --reason="dig blocked at 1,2,3"',
    );
    assert.equal(
      escalationHint({ reason: 'find shore', target: '1,2,3' }),
      'mc advise --reason="find shore" --target 1,2,3',
    );
  });
});

test('escalationHint: suppressed degrades to a kanban_block directive, never mc advise', () => {
  withEnv('1', () => {
    assert.equal(adviseHintsSuppressed(), true);
    const hint = escalationHint({ reason: 'dig blocked at 1,2,3', target: '1,2,3' });
    assert.match(hint, /kanban_block/);
    assert.doesNotMatch(hint, /mc advise/);
  });
});
