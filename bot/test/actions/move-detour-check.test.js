/**
 * Regression test for the move detour sanity check.
 *
 * 2026-05-25: flint at (378,58,-597) underground asked mc move to (378,46,-600)
 * — 12 blocks DOWN, 3 south. Pathfinder couldn't find a direct down-path
 * through solid stone, so it routed UP the existing stair, across surface,
 * back down somewhere else — ~50 blocks of travel for a 12-block goal.
 * Bot died to mobs on the way. The LLM saw an HTTP timeout and had no idea
 * the bot had respawned at world spawn.
 *
 * Fix: pre-compute the path with getPathTo, compare to straight-line
 * distance, refuse if detour exceeds max(straight * 3.5, straight + 25).
 *
 * This test asserts the threshold logic: which (straight, path) pairs
 * should pass, which should refuse.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Mirror the threshold formula in move.js.
// If this changes in source, mirror the change here.
function isDetourAllowed(straightLine, pathLength) {
  if (straightLine < 5) return true; // tiny moves skip the check
  const maxAllowed = Math.max(straightLine * 3.5, straightLine + 25);
  return pathLength <= maxAllowed;
}

test('tiny moves (< 5 blocks straight) skip the check entirely', () => {
  // Even a 100-block detour for a 2-block straight goal would be allowed —
  // tiny moves often have natural path noise.
  assert.equal(isDetourAllowed(2, 100), true, '2-block straight, 100-block path: skipped');
  assert.equal(isDetourAllowed(4.9, 50), true, 'just-under-threshold straight: skipped');
});

test('short moves use additive headroom (+25 blocks)', () => {
  // 5-block straight: allowed up to max(17.5, 30) = 30 blocks
  assert.equal(isDetourAllowed(5, 25), true, '5m straight, 25m path: within +25 headroom');
  assert.equal(isDetourAllowed(5, 30), true, '5m straight, 30m path: at +25 headroom limit');
  assert.equal(isDetourAllowed(5, 31), false, '5m straight, 31m path: just over');
});

test('the observed bug case is refused (12 down + 3 across → 50 path)', () => {
  // dy=-12, dx=0, dz=3 → straight = sqrt(144+9) ≈ 12.4
  // path = ~50 (up to surface, across, back down)
  // max allowed = max(43.3, 37.4) = 43.3
  // 50 > 43.3 → refused ✓
  const straight = Math.sqrt(12 * 12 + 3 * 3);
  assert.equal(isDetourAllowed(straight, 50), false,
    'the smoking-gun case: 12-block underground goal, 50-block surface detour, must refuse');
});

test('medium moves use ratio (3.5x straight-line)', () => {
  // 20-block straight: allowed up to max(70, 45) = 70 blocks
  assert.equal(isDetourAllowed(20, 65), true, '20m straight, 65m path: within 3.5x ratio');
  assert.equal(isDetourAllowed(20, 70), true, '20m straight, 70m path: at ratio limit');
  assert.equal(isDetourAllowed(20, 71), false, '20m straight, 71m path: just over ratio');
});

test('long moves are tolerant of detour for terrain (e.g. mountain skirt)', () => {
  // 100-block straight: allowed up to max(350, 125) = 350 blocks
  // A 200m detour for a 100m straight goal (going around a mountain) is fine.
  assert.equal(isDetourAllowed(100, 200), true, '100m straight, 200m detour: allowed');
  assert.equal(isDetourAllowed(100, 350), true, '100m straight, 350m detour: at ratio limit');
  assert.equal(isDetourAllowed(100, 400), false, '100m straight, 400m detour: too much');
});

test('threshold formula: 3.5x ratio or +25m, whichever is more generous', () => {
  // The Math.max() of the two limits ensures we use the more permissive bound.
  // For straight <= 10m, the +25m additive dominates.
  // For straight > 10m, the 3.5x ratio dominates.
  const crossover = 10; // straight where 3.5x equals straight + 25 (approx)
  // At crossover: 3.5 * 10 = 35, 10 + 25 = 35 — equal.
  assert.equal(isDetourAllowed(crossover, 35), true, 'at crossover: 35-block path allowed');
  assert.equal(isDetourAllowed(crossover, 36), false, 'at crossover: 36-block path refused');
});
