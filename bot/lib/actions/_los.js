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
 * The default 7-point sample (six faces + center) is the most permissive
 * — used by `mc dig` so reaching ANY visible face counts as line-of-sight.
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

/**
 * Tighter LOS check: only the up-to-three faces actually pointed at the
 * bot's eye get a raycast. Used by `mc collect` to refuse digs that would
 * "stab through stone" — a block whose far face is visible to the bot
 * from above, but whose bot-facing face is occluded by another block.
 *
 * Each axis where eye and block-center differ contributes one face
 * center, pulled 0.02 into the block from the matching face plane so the
 * raycast endpoint sits in air rather than inside the target.
 *
 * @param {number} x block coord
 * @param {number} y block coord
 * @param {number} z block coord
 * @param {{
 *   hasLineOfSight?: (from: import('vec3').Vec3, to: import('vec3').Vec3) => boolean,
 *   eyePosition?: () => import('vec3').Vec3 | null,
 *   fairPlay?: boolean,
 * }} deps
 */
export function canSeeBotFacingFace(x, y, z, deps = {}) {
  const { hasLineOfSight, eyePosition, fairPlay = true } = deps;
  if (!fairPlay || !hasLineOfSight || !eyePosition) return true;
  const eye = eyePosition();
  if (!eye) return true;
  const cx = x + 0.5;
  const cy = y + 0.5;
  const cz = z + 0.5;
  const dx = eye.x - cx;
  const dy = eye.y - cy;
  const dz = eye.z - cz;
  const faces = [];
  if (Math.abs(dx) > 0.001) faces.push(new Vec3(cx + Math.sign(dx) * 0.48, cy, cz));
  if (Math.abs(dy) > 0.001) faces.push(new Vec3(cx, cy + Math.sign(dy) * 0.48, cz));
  if (Math.abs(dz) > 0.001) faces.push(new Vec3(cx, cy, cz + Math.sign(dz) * 0.48));
  for (const f of faces) {
    if (hasLineOfSight(eye, f)) return true;
  }
  return false;
}
