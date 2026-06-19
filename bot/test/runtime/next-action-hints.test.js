import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectNextActionHints,
  buildObserveNextActionHints,
  isDestructiveNavHint,
} from '../../lib/runtime/next-action-hints.js';

test('collectNextActionHints orders move before dig_area', () => {
  const hints = collectNextActionHints([
    'mc dig_area 1 2 3',
    'mc move 1 64 2  # walk first',
  ]);
  assert.match(hints[0], /^mc move/);
});

test('collectNextActionHints returns empty when brief is stale', () => {
  const hints = collectNextActionHints(['mc move 1 2 3'], { staleBrief: true });
  assert.deepEqual(hints, []);
});

test('buildObserveNextActionHints merges header and path rows', () => {
  const hints = buildObserveNextActionHints({
    navHeader: { suggested_hint: 'mc move one step N' },
    navBrief: {
      paths: [{ label: 'base', verb: 'move', args: 'base_anchor', suggested: true }],
    },
  });
  assert.ok(hints.length >= 2);
  assert.match(hints[0], /mc move/);
});

test('isDestructiveNavHint flags tunnel and dig_area', () => {
  assert.equal(isDestructiveNavHint('mc tunnel 1 2 3 down'), true);
  assert.equal(isDestructiveNavHint('mc move 1 2 3'), false);
});
