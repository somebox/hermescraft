/**
 * Axis-aligned bounds with padding so POIs near the edge stay inside the view (zoomed out).
 * @param {{ x: number, z: number }[]} points
 * @param {number} pad minimum margin in blocks
 * @param {number} padFrac extra margin as fraction of span (e.g. 0.35 → roomy frame)
 */
export function boundsXZ(points, pad = 28, padFrac = 0.35) {
  const emptyPad = Math.max(pad, 64);
  if (!points.length) return { minX: -emptyPad, maxX: emptyPad, minZ: -emptyPad, maxZ: emptyPad };
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const spanX = Math.max(maxX - minX, 1);
  const spanZ = Math.max(maxZ - minZ, 1);
  const margin = Math.max(pad, spanX * padFrac, spanZ * padFrac);
  return {
    minX: minX - margin,
    maxX: maxX + margin,
    minZ: minZ - margin,
    maxZ: maxZ + margin,
  };
}

/**
 * @param {number} x
 * @param {number} z
 * @param {{ minX: number, maxX: number, minZ: number, maxZ: number }} b
 * @param {number} w
 * @param {number} h
 */
export function worldToCanvas(x, z, b, w, h) {
  const dx = b.maxX - b.minX || 1;
  const dz = b.maxZ - b.minZ || 1;
  const nx = (x - b.minX) / dx;
  const nz = (z - b.minZ) / dz;
  return { cx: nx * w, cy: nz * h };
}
