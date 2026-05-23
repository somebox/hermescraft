import { Vec3 } from 'vec3';

/**
 * Seven face samples + block center (F45.3 / F64–F67 pattern for place, dig, interact).
 * @param {number} x block coord
 * @param {number} y block coord
 * @param {number} z block coord
 */
export function standardBlockFacePoints(x, y, z) {
  const cx = x + 0.5;
  const cy = y + 0.5;
  const cz = z + 0.5;
  return [
    { x: cx, y: cy, z: cz - 0.48 },
    { x: cx, y: cy, z: cz + 0.48 },
    { x: cx - 0.48, y: cy, z: cz },
    { x: cx + 0.48, y: cy, z: cz },
    { x: cx, y: cy - 0.48, z: cz },
    { x: cx, y: cy + 0.48, z: cz },
    { x: cx, y: cy, z: cz },
  ];
}

/**
 * Sample block face centers; true if any candidate face has clear LOS.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {number} x block coord
 * @param {number} y block coord
 * @param {number} z block coord
 * @param {{
 *   hasLineOfSight?: (from: import('vec3').Vec3, to: import('vec3').Vec3) => boolean,
 *   eyePosition?: () => import('vec3').Vec3 | null,
 *   faces?: Array<{ x: number, y: number, z: number }>,
 *   fairPlay?: boolean,
 * }} deps
 */
export function canSeeBlockFaces(bot, x, y, z, deps = {}) {
  const { hasLineOfSight, eyePosition, faces, fairPlay = true } = deps;
  if (!fairPlay || !hasLineOfSight || !eyePosition) return true;
  const eye = eyePosition();
  if (!eye) return true;

  let candidates = faces;
  if (!candidates || candidates.length === 0) {
    candidates = standardBlockFacePoints(x, y, z);
  }

  for (const f of candidates) {
    const to = f instanceof Vec3 ? f : new Vec3(f.x, f.y, f.z);
    if (hasLineOfSight(eye, to)) return true;
  }
  return false;
}
