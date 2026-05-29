/**
 * move() detour precheck thresholds (mirrored in bot/test/actions/move-detour-check.test.js).
 */

/**
 * @param {number} straightLine meters
 * @param {number} pathLength blocks in planned path
 * @param {number} [dy] target.y - bot.y (negative = target below)
 */
export function isDetourAllowed(straightLine, pathLength, dy = 0) {
  if (straightLine < 5) return true;
  // Legitimate long climb along a dug staircase — do not refuse on ratio alone.
  if (dy > 3) return true;
  const maxAllowed = Math.max(straightLine * 3.5, straightLine + 25);
  return pathLength <= maxAllowed;
}

/**
 * @param {number} dy
 */
export function detourHintForDy(dy) {
  if (dy < -3) {
    return `Target is ${Math.abs(Math.round(dy))} blocks below you — use mc tunnel <X> <Y> <Z> <DIR> or mc stair_down to dig down. mc move can't traverse solid blocks.`;
  }
  if (dy > 3) {
    return 'Target is above you — use mc retrace after stair_down, mc stair_up, or mc goto with intermediate waypoints.';
  }
  return 'The direct route is blocked. Pick an intermediate waypoint, or mc tunnel through the obstacle.';
}
