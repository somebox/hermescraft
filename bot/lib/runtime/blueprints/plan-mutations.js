import { isAirBlockName } from './compare.js';
import { tightFootprintFromCells, worldToLocal } from './footprint.js';

export function adoptWorldCell(plan, footprint, anchor, wx, wy, wz, blockName) {
  const [lx, ly, lz] = worldToLocal(anchor, footprint, wx, wy, wz);
  const cells = [...(plan.cells || [])];
  const idx = cells.findIndex((c) => c.local[0] === lx && c.local[1] === ly && c.local[2] === lz);
  const air = isAirBlockName(blockName);

  if (air) {
    if (idx >= 0) cells.splice(idx, 1);
  } else {
    const block = String(blockName || 'unknown').toLowerCase();
    const entry = { local: [lx, ly, lz], block };
    if (idx >= 0) cells[idx] = { ...cells[idx], ...entry };
    else cells.push(entry);
  }

  plan.cells = cells;
  plan.footprint = tightFootprintFromCells(cells);
  return { local: [lx, ly, lz], air };
}
