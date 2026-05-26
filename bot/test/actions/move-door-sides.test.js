/**
 * Regression test for `computeDoorSides` (move.js) — the Y-component fix.
 *
 * 2026-05-26: 26 NAV_BLOCKED failures in the hut1 supply run repeatedly
 * targeted the underground rescue door at (370,59,-591) while routing
 * toward a surface target at Y=65. The previous geometry used
 * `target.y` for both near_side and far_side, which made `mc through`
 * pitch the bot's view upward and stall the forward-walk loop. The
 * mason worker logged the canonical signature:
 *
 *   Opened oak_door but bot stalled at 365.3,51.0,-589.3 (target 368,65,-591)
 *
 * `dPos.y=59`, `target.y=65` — far_side was (368, 65, -591) — 6 blocks
 * above the door. With the fix, both sides stay at the door's own Y so
 * `mc through`'s `lookAt(destPos)` stays horizontal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { computeDoorSides } from '../../lib/actions/movement/move.js';

test('door sides use the door\'s Y, not the target\'s Y (underground rescue door case)', () => {
  // Production smoking gun: underground door 6 below surface target.
  const door = { x: 370, y: 59, z: -591 };
  const target = { x: 368, y: 65, z: -591 };
  const { far_side, near_side } = computeDoorSides(door, target);
  assert.equal(far_side.y, 59, 'far_side Y must equal door Y, not target Y');
  assert.equal(near_side.y, 59, 'near_side Y must equal door Y');
});

test('Z-axis traversal: door axis chosen when |Δz| > |Δx|', () => {
  // door at (5,65,0), target at (5,65,8): travel along +Z
  const { far_side, near_side, axis, dir } = computeDoorSides(
    { x: 5, y: 65, z: 0 },
    { x: 5, y: 65, z: 8 },
  );
  assert.equal(axis, 'z');
  assert.equal(dir, 1);
  assert.equal(far_side.x, 5);  assert.equal(far_side.z, 2);   // 2 past door toward target
  assert.equal(near_side.x, 5); assert.equal(near_side.z, -2); // 2 before door
});

test('X-axis traversal: door axis chosen when |Δx| > |Δz|', () => {
  // door at (0,65,5), target at (10,65,5): travel along +X
  const { far_side, near_side, axis, dir } = computeDoorSides(
    { x: 0, y: 65, z: 5 },
    { x: 10, y: 65, z: 5 },
  );
  assert.equal(axis, 'x');
  assert.equal(dir, 1);
  assert.equal(far_side.x, 2);   assert.equal(far_side.z, 5);
  assert.equal(near_side.x, -2); assert.equal(near_side.z, 5);
});

test('X axis wins ties (|Δx| === |Δz| → axis=x)', () => {
  const { axis } = computeDoorSides({ x: 0, y: 65, z: 0 }, { x: 5, y: 65, z: 5 });
  assert.equal(axis, 'x', 'ties resolve to x-axis (matches old behavior)');
});

test('zero-Δ target picks a default axis without NaN sign (degenerate case)', () => {
  // Target collocated with door — Math.sign(0) is 0, which would zero
  // the offset. The `|| 1` guard ensures we still produce a valid Vec3.
  const { far_side, near_side } = computeDoorSides({ x: 5, y: 65, z: 5 }, { x: 5, y: 65, z: 5 });
  assert.notEqual(far_side.x, far_side.z, 'something must be offset');
  assert.ok(Math.abs(far_side.x - 5) === 2 || Math.abs(far_side.z - 5) === 2);
  assert.ok(Math.abs(near_side.x - 5) === 2 || Math.abs(near_side.z - 5) === 2);
});

test('far_side is 2 blocks past door on the target side; near_side is 2 blocks before', () => {
  // Geometry sanity: far_side.distanceTo(target) < door.distanceTo(target)
  // and near_side.distanceTo(target) > door.distanceTo(target).
  const door = { x: 10, y: 65, z: 0 };
  const target = { x: 20, y: 65, z: 0 };
  const { far_side, near_side } = computeDoorSides(door, target);
  const doorDist = Math.hypot(target.x - door.x, target.z - door.z);
  const farDist = Math.hypot(target.x - far_side.x, target.z - far_side.z);
  const nearDist = Math.hypot(target.x - near_side.x, target.z - near_side.z);
  assert.ok(farDist < doorDist, 'far_side must be closer to target than door');
  assert.ok(nearDist > doorDist, 'near_side must be further from target than door');
});

test('Y stays at door.y across a wide range of surface-target altitudes', () => {
  // Confirm the fix is invariant to target.y for the same door.
  const door = { x: 100, y: 59, z: -500 };
  for (const targetY of [40, 50, 59, 65, 80, 120]) {
    const { far_side, near_side } = computeDoorSides(door, { x: 100, y: targetY, z: -495 });
    assert.equal(far_side.y, 59, `far_side.y must stay 59 for target.y=${targetY}`);
    assert.equal(near_side.y, 59, `near_side.y must stay 59 for target.y=${targetY}`);
  }
});
