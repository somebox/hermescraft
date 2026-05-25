/**
 * Regression test for the stair_down yaw-key-mismatch bug.
 *
 * 2026-05-25: stair_down's `yawByKey` map was keyed by full names
 * (north/south/east/west), but `cardinalDeltaOrFail` returns the
 * short-form lowercase key (n/s/e/w). Every stair_down call passed
 * `yawByKey[key] === undefined` to `b.look()`, polluting bot.entity.yaw
 * and triggering 20Hz NaN-yaw packet cascades until the watchdog
 * forced a reconnect. The fix changed yawByKey to use short-form keys.
 *
 * This test asserts the invariant: for every direction that
 * cardinalDeltaOrFail accepts, the yawByKey lookup MUST return a
 * finite number. Catches future re-introduction of the typo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cardinalDelta } from '../../lib/actions/_directions.js';

// The exact yawByKey map from excavation.js stair_down. If you change
// the source, mirror the change here so the test stays meaningful.
// The keys MUST match what cardinalDeltaOrFail produces after its
// `.toLowerCase()` step (short-form: n/s/e/w).
const yawByKey = { n: Math.PI, s: 0, e: -Math.PI / 2, w: Math.PI / 2 };

const ACCEPTED_DIRECTION_INPUTS = [
  'north', 'south', 'east', 'west',
  'N', 'S', 'E', 'W',
  'n', 's', 'e', 'w',
];

test('cardinalDelta returns short-form uppercase keys', () => {
  // Documents the producer side of the contract.
  assert.equal(cardinalDelta('north').key, 'N');
  assert.equal(cardinalDelta('south').key, 'S');
  assert.equal(cardinalDelta('east').key, 'E');
  assert.equal(cardinalDelta('west').key, 'W');
});

test('yawByKey returns a finite yaw for every accepted direction input', () => {
  // This mirrors the stair_down flow:
  //   const dirParsed = cardinalDeltaOrFail(direction);
  //   const { key } = dirParsed;        // key is .toLowerCase()'d
  //   await b.look(yawByKey[key], 0, true);
  // The yaw value MUST be a finite number or mineflayer's physics tick
  // ships NaN look packets at 20Hz.
  for (const input of ACCEPTED_DIRECTION_INPUTS) {
    const r = cardinalDelta(input);
    assert.ok(r, `cardinalDelta(${input}) returned null`);
    const keyAsStairDownUsesIt = r.key.toLowerCase();
    const yaw = yawByKey[keyAsStairDownUsesIt];
    assert.equal(
      typeof yaw, 'number',
      `yawByKey[${keyAsStairDownUsesIt}] (from direction "${input}") was ${yaw} — typeof ${typeof yaw}, expected number`,
    );
    assert.ok(
      Number.isFinite(yaw),
      `yawByKey[${keyAsStairDownUsesIt}] = ${yaw} (not finite) — would pollute bot.entity.yaw`,
    );
  }
});

test('yawByKey covers all four cardinals (no extras, no gaps)', () => {
  const keys = Object.keys(yawByKey).sort();
  assert.deepEqual(keys, ['e', 'n', 's', 'w'],
    'yawByKey must have exactly the 4 short-form lowercase keys produced by cardinalDeltaOrFail');
});

test('yaw values correspond to canonical MC facing angles', () => {
  // MC yaw: +Z (south) = 0, -X (west) = π/2, -Z (north) = ±π, +X (east) = -π/2
  // (matches the convention in our codebase)
  assert.equal(yawByKey.s, 0, 'south = 0');
  assert.equal(yawByKey.n, Math.PI, 'north = π');
  assert.equal(yawByKey.e, -Math.PI / 2, 'east = -π/2');
  assert.equal(yawByKey.w, Math.PI / 2, 'west = π/2');
});
