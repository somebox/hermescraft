/**
 * Site readiness checks run inside construct begin (D1 MVP).
 * Read-only — uses block samples only, no mutation.
 */

import { iterateFootprintLocals, localToWorld } from './blueprints/footprint.js';

const FLUID_BLOCKS = new Set([
  'water', 'flowing_water', 'lava', 'flowing_lava',
]);

function topSolidY(getBlockName, x, z, yHint) {
  for (let y = yHint + 5; y >= yHint - 8; y--) {
    const name = getBlockName(x, y, z) || 'air';
    if (name !== 'air' && name !== 'cave_air' && name !== 'void_air' && !FLUID_BLOCKS.has(name)) {
      return y;
    }
  }
  return yHint;
}

/**
 * @param {object} ctxPlan enriched plan context (anchor, footprint, cellsIndex)
 * @param {(x:number,y:number,z:number)=>string} getBlockName
 * @param {{ level?: number, range?: number[], spreadThreshold?: number, maxFluidCells?: number }} opts
 */
export function evaluateConstructSiteReadiness(ctxPlan, getBlockName, opts = {}) {
  const anchor = ctxPlan.anchor;
  const footprint = ctxPlan.footprint;
  const spreadThreshold = opts.spreadThreshold ?? 2;
  const maxFluid = opts.maxFluidCells ?? 0;
  const level = opts.level != null ? Number(opts.level) : null;
  const range = opts.range;

  const inSlice = (ly) => {
    if (level != null && Number.isFinite(level)) return ly === level;
    if (Array.isArray(range) && range.length >= 2) {
      const a = Math.min(range[0], range[1]);
      const b = Math.max(range[0], range[1]);
      return ly >= a && ly <= b;
    }
    return ly === 1;
  };

  const loc = footprint?.local;
  const checks = [];
  if (!anchor || !loc) {
    return {
      status: 'prep_required',
      message: 'Plan missing anchor or footprint for readiness',
      hint: 'Fix plan anchor.coords and footprint before construct begin',
      checks,
    };
  }

  const cornerLocals = [
    [loc.x[0], loc.z[0]],
    [loc.x[1], loc.z[0]],
    [loc.x[0], loc.z[1]],
    [loc.x[1], loc.z[1]],
  ];
  const cornerWorldYs = [];
  for (const [lx, lz] of cornerLocals) {
    const ly = level != null ? level : 1;
    const w = localToWorld(anchor, footprint, lx, ly, lz);
    const surfaceY = topSolidY(getBlockName, w.x, w.z, w.y);
    cornerWorldYs.push(surfaceY);
    const name = getBlockName(w.x, w.y, w.z) || 'air';
    checks.push({ kind: 'corner_L1', local: [lx, ly, lz], world: w, block: name, surface_y: surfaceY });
    if (FLUID_BLOCKS.has(name)) {
      return {
        status: 'prep_required',
        message: `Fluid ${name} at footprint corner (${w.x},${w.y},${w.z})`,
        hint: 'Drain/fill L0 and re-run mc task_context set or mc construct begin',
        checks,
        fluid_at: w,
      };
    }
  }

  const spread = Math.max(...cornerWorldYs) - Math.min(...cornerWorldYs);
  checks.push({ kind: 'corner_y_spread', spread, threshold: spreadThreshold });
  if (spread > spreadThreshold) {
    return {
      status: 'prep_required',
      message: `Footprint corner Y spread ${spread} exceeds ${spreadThreshold} — level site before construct`,
      hint: 'Run L0 ground/drain cards or mc level_ground on the worksite apron',
      checks,
    };
  }

  let fluidCount = 0;
  let scanned = 0;
  const maxScan = 128;
  for (const [lx, ly, lz] of iterateFootprintLocals(footprint)) {
    if (!inSlice(ly)) continue;
    if (scanned >= maxScan) break;
    scanned++;
    const w = localToWorld(anchor, footprint, lx, ly, lz);
    const name = getBlockName(w.x, w.y, w.z) || 'air';
    if (FLUID_BLOCKS.has(name)) fluidCount++;
  }
  checks.push({ kind: 'fluid_scan', fluid_count: fluidCount, cells_scanned: scanned });
  if (fluidCount > maxFluid) {
    return {
      status: 'prep_required',
      message: `${fluidCount} fluid cell(s) in plan slice — drain before construct`,
      hint: 'L0 drain/fill gate; see base-build-layered.md L0 ground',
      checks,
    };
  }

  return {
    status: 'ready',
    message: 'Site readiness OK for construct begin',
    checks,
  };
}
