/** Env-overridable blueprint size limits (shared with Python blueprint_lib). */

function intEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export const BLUEPRINT_LIMITS = {
  maxCells: intEnv('BLUEPRINT_MAX_CELLS', 50_000),
  maxFootprintVolume: intEnv('BLUEPRINT_MAX_FOOTPRINT_VOLUME', 200_000),
  minCells: intEnv('BLUEPRINT_MIN_CELLS', 1),
  verifyMaxCellsPerCall: intEnv('BLUEPRINT_VERIFY_MAX_CELLS_PER_CALL', 2_000),
  captureMaxRegionRadius: intEnv('BLUEPRINT_CAPTURE_MAX_REGION_RADIUS', 64),
  auditWarnCells: intEnv('BLUEPRINT_AUDIT_WARN_CELLS', 20_000),
};

export function footprintVolume(local) {
  const dx = local.x[1] - local.x[0] + 1;
  const dy = local.y[1] - local.y[0] + 1;
  const dz = local.z[1] - local.z[0] + 1;
  return dx * dy * dz;
}

export function assertPlanSize(cellsCount, footprintLocal) {
  const { maxCells, maxFootprintVolume, minCells } = BLUEPRINT_LIMITS;
  if (cellsCount < minCells) {
    return { ok: false, code: 'BLUEPRINT_SIZE_EXCEEDED', message: `Plan has ${cellsCount} cells (min ${minCells})` };
  }
  if (cellsCount > maxCells) {
    return { ok: false, code: 'BLUEPRINT_SIZE_EXCEEDED', message: `Plan has ${cellsCount} cells (max ${maxCells})` };
  }
  if (footprintLocal) {
    const vol = footprintVolume(footprintLocal);
    if (vol > maxFootprintVolume) {
      return {
        ok: false,
        code: 'BLUEPRINT_SIZE_EXCEEDED',
        message: `Footprint volume ${vol} exceeds max ${maxFootprintVolume}`,
      };
    }
  }
  return { ok: true };
}
