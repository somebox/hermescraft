/**
 * Regression tests for `describeMoveOutcome` (move.js).
 *
 * Production bug (2026-05-29): mason called `mc move -451 66 589`. Preflight
 * snapped the target to (-451,65,590), already ~0.86 blocks from the bot's
 * position (-450.5,65,590.7), so the pathfinder returned immediately without
 * moving. The success message still read "Arrived at -451, 65, 590", making
 * it look like the bot had travelled when it had not budged. The fix reports
 * "did not move (still at …)" whenever the bot's block cell is unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { describeMoveOutcome } from '../../lib/actions/movement/move.js';

const fmt = (n) => String(Math.round(Number(n)));

test('did-not-move: same block cell → "still at" with actual position, not target', () => {
  // The exact production coordinates.
  const startPos = { x: -450.5, y: 65, z: 590.7 };
  const finalPos = { x: -450.5, y: 65, z: 590.7 };
  const target = { x: -451, y: 65, z: 590 };
  const { moved, text } = describeMoveOutcome({ startPos, finalPos, target, fmt });
  assert.equal(moved, false);
  assert.match(text, /did not move/);
  // Reports the ACTUAL position (-450,65,591), not the requested target.
  assert.match(text, /still at -450, 65, 591/);
  assert.doesNotMatch(text, /^Arrived at/);
});

test('moved: block cell changed → "Arrived at" the target', () => {
  const startPos = { x: 0.5, y: 64, z: 0.5 };
  const finalPos = { x: 10.4, y: 64, z: 0.5 };
  const target = { x: 10, y: 64, z: 0 };
  const { moved, text } = describeMoveOutcome({ startPos, finalPos, target, fmt });
  assert.equal(moved, true);
  assert.match(text, /^Arrived at 10, 64, 0/);
  assert.doesNotMatch(text, /did not move/);
});

test('moved: a single block step counts as movement', () => {
  const startPos = { x: 0.5, y: 64, z: 0.5 };
  const finalPos = { x: 1.5, y: 64, z: 0.5 }; // floor x 0 → 1
  const target = { x: 1, y: 64, z: 0 };
  const { moved } = describeMoveOutcome({ startPos, finalPos, target, fmt });
  assert.equal(moved, true);
});

test('moved: vertical-only change (climbed/descended) counts as movement', () => {
  const startPos = { x: 0.5, y: 64, z: 0.5 };
  const finalPos = { x: 0.5, y: 67, z: 0.5 };
  const target = { x: 0, y: 67, z: 0 };
  const { moved } = describeMoveOutcome({ startPos, finalPos, target, fmt });
  assert.equal(moved, true);
});

test('door + suffix notes are appended in both branches', () => {
  const moved = describeMoveOutcome({
    startPos: { x: 0.5, y: 64, z: 0.5 },
    finalPos: { x: 9.5, y: 64, z: 0.5 },
    target: { x: 10, y: 64, z: 0 },
    doorsUsed: 2,
    fmt,
    suffix: ' (escaped)',
  });
  assert.match(moved.text, /Arrived at 10, 64, 0 via 2 doors \(escaped\)/);

  const still = describeMoveOutcome({
    startPos: { x: 0.5, y: 64, z: 0.5 },
    finalPos: { x: 0.5, y: 64, z: 0.5 },
    target: { x: 1, y: 64, z: 0 },
    doorsUsed: 1,
    fmt,
  });
  assert.match(still.text, /did not move .* via 1 door/);
});
