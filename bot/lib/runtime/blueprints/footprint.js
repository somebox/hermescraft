/**
 * Footprint helpers: tight AABB from cells, iterate cells in footprint.
 */

/** @param {Array<{ local: number[] }>} cells */
export function tightFootprintFromCells(cells) {
  if (!cells?.length) {
    return { mode: 'tight', local: { x: [0, 0], y: [0, 0], z: [0, 0] } };
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const c of cells) {
    const [x, y, z] = c.local;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  return { mode: 'tight', local: { x: [minX, maxX], y: [minY, maxY], z: [minZ, maxZ] } };
}

/** @param {object} meta dimensions from grabcraft */
export function metadataFootprint(meta) {
  const w = Number(meta?.width) || 1;
  const h = Number(meta?.height) || 1;
  const d = Number(meta?.depth) || 1;
  return { mode: 'metadata', local: { x: [1, w], y: [1, h], z: [1, d] } };
}

export function resolveFootprint(plan) {
  if (plan.footprint?.local) {
    return plan.footprint;
  }
  return tightFootprintFromCells(plan.cells || []);
}

export function footprintMins(footprint) {
  const loc = footprint.local;
  return { x: loc.x[0], y: loc.y[0], z: loc.z[0] };
}

/** Iterate every local cell in footprint (inclusive). */
export function* iterateFootprintLocals(footprint) {
  const { x, y, z } = footprint.local;
  for (let ly = y[0]; ly <= y[1]; ly++) {
    for (let lx = x[0]; lx <= x[1]; lx++) {
      for (let lz = z[0]; lz <= z[1]; lz++) {
        yield [lx, ly, lz];
      }
    }
  }
}

export function localToWorld(anchor, footprint, lx, ly, lz) {
  const mins = footprintMins(footprint);
  return {
    x: anchor[0] + (lx - mins.x),
    y: anchor[1] + (ly - mins.y),
    z: anchor[2] + (lz - mins.z),
  };
}

export function worldToLocal(anchor, footprint, wx, wy, wz) {
  const mins = footprintMins(footprint);
  return [wx - anchor[0] + mins.x, wy - anchor[1] + mins.y, wz - anchor[2] + mins.z];
}
