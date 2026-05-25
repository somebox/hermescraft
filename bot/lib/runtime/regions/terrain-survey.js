/**
 * Pure plot/region terrain analysis for farm construct cards.
 */

const TILLABLE = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'dirt_path']);
const AIR_LIKE = new Set(['air', 'cave_air', 'void_air']);

/**
 * @typedef {{ x: number, z: number, topY: number|null, blockName: string|null, belowName: string|null }} ColumnSample
 */

/**
 * Iterate integer columns in an axis-aligned rectangle (inclusive).
 * @param {number} x1
 * @param {number} z1
 * @param {number} x2
 * @param {number} z2
 * @returns {{ x: number, z: number }[]}
 */
export function columnsInRect(x1, z1, x2, z2) {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minZ = Math.min(z1, z2);
  const maxZ = Math.max(z1, z2);
  /** @type {{ x: number, z: number }[]} */
  const out = [];
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) out.push({ x, z });
  }
  return out;
}

/**
 * Columns whose (x,z) center lies inside a column disc (XZ only).
 * @param {object} anchor { x, y?, z }
 * @param {object} shape { radius?, kind? }
 */
export function columnsInRegionDisc(anchor, shape) {
  const ax = anchor.x;
  const az = anchor.z;
  const r = shape?.radius ?? 16;
  const r2 = r * r;
  const minX = ax - r;
  const maxX = ax + r;
  const minZ = az - r;
  const maxZ = az + r;
  /** @type {{ x: number, z: number }[]} */
  const out = [];
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      const dx = x - ax;
      const dz = z - az;
      if (dx * dx + dz * dz <= r2) out.push({ x, z });
    }
  }
  return out;
}

/**
 * @param {ColumnSample} col
 * @param {number|null|undefined} expectY
 */
function classifyColumn(col, expectY) {
  const issues = [];
  if (col.topY == null || col.blockName == null) {
    issues.push({ code: 'no_solid', severity: 'prep' });
    return issues;
  }
  if (col.blockName === 'farmland') {
    issues.push({ code: 'already_farmland', severity: 'info' });
    return issues;
  }
  if (!TILLABLE.has(col.blockName)) {
    issues.push({ code: 'non_tillable_top', severity: 'prep', block: col.blockName });
    return issues;
  }
  if (col.belowName != null && AIR_LIKE.has(col.belowName)) {
    issues.push({ code: 'floating_surface', severity: 'prep' });
  }
  if (expectY != null && Number.isFinite(expectY) && col.topY !== expectY) {
    issues.push({ code: 'expect_y_mismatch', severity: 'spec', topY: col.topY, expectY });
  }
  return issues;
}

/**
 * @param {ColumnSample[]} columns
 * @param {object} opts
 * @param {number|null} [opts.expectY]
 * @param {number} [opts.flatMaxDelta]
 * @param {number} [opts.worksiteCoverageMinPct] 0-100, default 100 (all inside)
 * @param {{ x: number, z: number, inside: boolean }[]} [opts.worksiteCoverage]
 */
export function summarizePlotTerrain(columns, opts = {}) {
  const expectY = opts.expectY ?? null;
  const flatMaxDelta = opts.flatMaxDelta ?? 1;
  const worksiteCoverage = opts.worksiteCoverage ?? null;

  const topYs = columns.map((c) => c.topY).filter((y) => y != null);
  const topY_min = topYs.length ? Math.min(...topYs) : null;
  const topY_max = topYs.length ? Math.max(...topYs) : null;
  const delta_y = topY_min != null && topY_max != null ? topY_max - topY_min : null;

  const hist = {};
  for (const c of columns) {
    if (c.topY == null) continue;
    const k = String(c.topY);
    hist[k] = (hist[k] || 0) + 1;
  }

  /** @type {{ code: string, message: string, severity: 'spec'|'prep'|'info', details?: object }[]} */
  const issues = [];
  let floating = 0;
  let noSolid = 0;
  let nonTillable = 0;
  let alreadyFarmland = 0;
  let expectMismatch = 0;

  for (const col of columns) {
    for (const iss of classifyColumn(col, expectY)) {
      if (iss.code === 'floating_surface') floating++;
      if (iss.code === 'no_solid') noSolid++;
      if (iss.code === 'non_tillable_top') nonTillable++;
      if (iss.code === 'already_farmland') alreadyFarmland++;
      if (iss.code === 'expect_y_mismatch') expectMismatch++;
    }
  }

  if (delta_y != null && delta_y > flatMaxDelta) {
    issues.push({
      code: 'terrain_flatness',
      severity: 'spec',
      message: `Surface Y spans ${topY_min}..${topY_max} (delta ${delta_y}); card assumed flat within ${flatMaxDelta}.`,
      details: { topY_min, topY_max, delta_y, flat_max_delta: flatMaxDelta },
    });
  }
  if (expectMismatch > 0 && expectY != null) {
    issues.push({
      code: 'terrain_expect_y',
      severity: 'spec',
      message: `${expectMismatch}/${columns.length} columns have topY ≠ expect-y ${expectY}.`,
      details: { expect_y: expectY, mismatch_count: expectMismatch, topY_min, topY_max },
    });
  }
  if (noSolid > 0) {
    issues.push({
      code: 'terrain_no_solid',
      severity: 'prep',
      message: `${noSolid}/${columns.length} columns have no solid surface (fill before till).`,
      details: { count: noSolid },
    });
  }
  if (floating > 0) {
    issues.push({
      code: 'terrain_floating',
      severity: 'prep',
      message: `${floating}/${columns.length} columns have tillable top with air below (avoid mc level over void).`,
      details: { count: floating },
    });
  }
  if (nonTillable > 0) {
    issues.push({
      code: 'terrain_non_tillable',
      severity: 'prep',
      message: `${nonTillable}/${columns.length} columns have non-tillable surface blocks.`,
      details: { count: nonTillable },
    });
  }

  let columns_inside = null;
  let columns_outside = null;
  let pct_outside = null;
  if (worksiteCoverage && worksiteCoverage.length) {
    columns_inside = worksiteCoverage.filter((c) => c.inside).length;
    columns_outside = worksiteCoverage.filter((c) => !c.inside).length;
    pct_outside = columns.length ? Math.round((columns_outside / columns.length) * 1000) / 10 : 0;
    const minPct = opts.worksiteCoverageMinPct ?? 100;
    const minInside = Math.ceil((minPct / 100) * columns.length);
    if (columns_inside < minInside) {
      issues.push({
        code: 'worksite_coverage',
        severity: 'spec',
        message: `${columns_outside}/${columns.length} plot columns (${pct_outside}%) lie outside worksite region disc.`,
        details: {
          columns_inside,
          columns_outside,
          pct_outside,
          sample_outside: worksiteCoverage.filter((c) => !c.inside).slice(0, 8),
        },
      });
    }
  }

  const specFail = issues.some((i) => i.severity === 'spec');
  const prepFail = issues.some((i) => i.severity === 'prep');
  const ok = !specFail && !prepFail;

  let next_action_hint = null;
  if (!ok) {
    const first = issues.find((i) => i.severity === 'spec') || issues.find((i) => i.severity === 'prep');
    if (first?.code === 'worksite_coverage') {
      next_action_hint = 'kanban_block task_spec_invalid:worksite_coverage:<worksite_id>';
    } else if (first?.code === 'terrain_flatness') {
      next_action_hint = 'kanban_block task_spec_invalid:terrain_flatness';
    } else if (first?.code === 'terrain_expect_y') {
      next_action_hint = 'kanban_block task_spec_invalid:terrain_expect_y';
    } else if (first?.code === 'terrain_floating' || first?.code === 'terrain_no_solid') {
      next_action_hint = 'kanban_block task_spec_invalid:terrain:prep_required';
    } else {
      next_action_hint = 'kanban_block task_spec_invalid:terrain';
    }
  }

  const notes = [
    'Till is not region-guarded; UNCHANGED on mc till means Paper/farm primitive or bad cell — not worksite permission deny.',
  ];

  let recommendation = null;
  if (!ok) {
    if (delta_y != null && delta_y > flatMaxDelta) {
      recommendation = `Use mc till_area without fixed Y, or mc regions terrain --rect … — topY range ${topY_min}..${topY_max}.`;
    } else if (worksiteCoverage && columns_outside > 0) {
      recommendation = 'Fix card worksite region to cover the plot bbox, or remove incorrect worksite: line.';
    } else if (floating > 0 || noSolid > 0) {
      recommendation = 'Steward: add [PREP] fill/flatten child before till construct.';
    }
  }

  return {
    ok,
    column_count: columns.length,
    topY_min,
    topY_max,
    delta_y,
    topY_histogram: hist,
    counts: {
      floating_surface: floating,
      no_solid: noSolid,
      non_tillable_top: nonTillable,
      already_farmland: alreadyFarmland,
      expect_y_mismatch: expectMismatch,
    },
    worksite: columns_inside != null
      ? { columns_inside, columns_outside, pct_outside }
      : undefined,
    issues,
    notes,
    recommendation,
    next_action_hint,
  };
}

export { TILLABLE, AIR_LIKE };
