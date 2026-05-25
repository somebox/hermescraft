/**
 * Bot-side column sampling + verify_plot for construct/farm cards.
 */
import { Vec3 } from 'vec3';
import { columnTopSolid } from '../runtime/dig-tools.js';
import { containsPoint } from '../runtime/regions/resolver.js';
import { normalizeId } from '../runtime/regions/index.js';
import {
  columnsInRect,
  columnsInRegionDisc,
  summarizePlotTerrain,
} from '../runtime/regions/terrain-survey.js';

const MAX_VERIFY_CELLS = 81;

/**
 * @param {import('mineflayer').Bot} b
 * @param {number} x
 * @param {number} z
 * @returns {import('../runtime/regions/terrain-survey.js').ColumnSample}
 */
export function sampleColumnAt(b, x, z) {
  const col = columnTopSolid(b, x, z);
  if (!col) {
    return { x, z, topY: null, blockName: null, belowName: null };
  }
  const below = b.blockAt(new Vec3(x, col.topY - 1, z));
  const belowName = below?.name ?? null;
  return { x, z, topY: col.topY, blockName: col.blockName, belowName };
}

/**
 * @param {import('mineflayer').Bot} b
 * @param {{ x: number, z: number }[]} cols
 */
export function samplePlotColumns(b, cols) {
  return cols.map(({ x, z }) => sampleColumnAt(b, x, z));
}

/**
 * @param {object} region
 * @param {number} x
 * @param {number} z
 * @param {number} yHint
 */
export function columnInsideRegion(region, x, z, yHint) {
  if (!region?.anchor || !region?.shape) return false;
  const y = Number.isFinite(yHint) ? yHint : (region.anchor.y ?? 64);
  return containsPoint(region.shape, region.anchor, x, y, z);
}

/**
 * @param {object} deps
 * @param {object} body
 */
export function runVerifyPlot(deps, body) {
  const b = deps.ensureBot();
  const store = deps.ctx?.runtime?.regions;

  const x1 = Number(body.x1 ?? body.x);
  const z1 = Number(body.z1 ?? body.z);
  const x2 = Number(body.x2);
  const z2 = Number(body.z2);
  if (![x1, z1, x2, z2].every(Number.isFinite)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_ARGS',
        message: 'verify_plot requires x1 z1 x2 z2 (rectangle corners).',
        retry_safe: false,
      },
    };
  }

  let cols = columnsInRect(x1, z1, x2, z2);
  if (cols.length > MAX_VERIFY_CELLS) {
    return {
      ok: false,
      error: {
        code: 'RECT_TOO_LARGE',
        message: `verify_plot rect has ${cols.length} columns; max ${MAX_VERIFY_CELLS}.`,
        retry_safe: false,
      },
    };
  }

  const expectY = body.expect_y != null ? Number(body.expect_y) : (body.expectY != null ? Number(body.expectY) : null);
  const flatMaxDelta = body.flat_max_delta != null ? Number(body.flat_max_delta) : 1;
  const worksiteRaw = body.worksite ?? body.worksite_region ?? body.worksite_id;
  const worksiteId = worksiteRaw != null ? normalizeId(String(worksiteRaw)) : null;

  const samples = samplePlotColumns(b, cols);

  /** @type {{ x: number, z: number, inside: boolean }[]|null} */
  let worksiteCoverage = null;
  if (worksiteId && store) {
    const region = store.get(worksiteId);
    if (!region) {
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_WORKSITE',
          message: `worksite region "${worksiteId}" not found. mc regions`,
          next_action_hint: 'kanban_block task_spec_invalid:worksite_unknown:' + worksiteId,
          retry_safe: false,
        },
      };
    }
    const yHint = expectY ?? region.anchor?.y ?? 64;
    worksiteCoverage = cols.map(({ x, z }) => ({
      x,
      z,
      inside: columnInsideRegion(region, x, z, yHint),
    }));
  }

  const summary = summarizePlotTerrain(samples, {
    expectY: Number.isFinite(expectY) ? expectY : null,
    flatMaxDelta,
    worksiteCoverage,
    worksiteCoverageMinPct: body.worksite_coverage_min_pct != null
      ? Number(body.worksite_coverage_min_pct)
      : 100,
  });

  if (worksiteId && summary.next_action_hint?.includes('<worksite_id>')) {
    summary.next_action_hint = summary.next_action_hint.replace('<worksite_id>', worksiteId);
  }

  const resultMsg = summary.ok
    ? `Plot ${cols.length} columns OK for till (worksite ${worksiteId || 'n/a'}).`
    : `Plot verify failed: ${summary.issues.map((i) => i.code).join(', ')}`;

  if (summary.ok) {
    return {
      ok: true,
      data: {
        bounds: { x1: Math.min(x1, x2), z1: Math.min(z1, z2), x2: Math.max(x1, x2), z2: Math.max(z1, z2) },
        worksite: worksiteId,
        expect_y: Number.isFinite(expectY) ? expectY : null,
        ...summary,
      },
      result: resultMsg,
    };
  }

  return {
    ok: false,
    error: {
      code: 'TASK_SPEC_INVALID',
      message: resultMsg,
      observed_state: summary,
      next_action_hint: summary.next_action_hint,
      retry_safe: false,
    },
    data: {
      bounds: { x1: Math.min(x1, x2), z1: Math.min(z1, z2), x2: Math.max(x1, x2), z2: Math.max(z1, z2) },
      worksite: worksiteId,
      ...summary,
    },
    result: resultMsg,
  };
}

/**
 * Terrain-only survey for a region id or --rect (no worksite gate).
 */
export function runRegionsTerrain(deps, args) {
  const b = deps.ensureBot();
  const store = deps.ctx?.runtime?.regions;

  const expectY = args.expect_y != null ? Number(args.expect_y) : (args['expect-y'] != null ? Number(args['expect-y']) : null);
  const flatMaxDelta = args.flat_max_delta != null ? Number(args.flat_max_delta) : 1;

  let cols;
  const rect = args.rect ?? args['--rect'];
  if (rect) {
    const parts = String(rect).split(/[,\s]+/).map(Number);
    if (parts.length < 4 || !parts.every(Number.isFinite)) {
      return { ok: false, error: { code: 'INVALID_ARGS', message: 'rect needs x1 z1 x2 z2', retry_safe: false } };
    }
    cols = columnsInRect(parts[0], parts[1], parts[2], parts[3]);
  } else {
    const regionId = normalizeId(String(args.region ?? args._positional?.[0] ?? args.id ?? ''));
    if (!regionId || !store) {
      return { ok: false, error: { code: 'INVALID_ARGS', message: 'regions terrain needs region id or --rect x1 z1 x2 z2', retry_safe: false } };
    }
    const region = store.get(regionId);
    if (!region) {
      return { ok: false, error: { code: 'UNKNOWN_REGION', message: `No region ${regionId}`, retry_safe: false } };
    }
    cols = columnsInRegionDisc(region.anchor, region.shape);
  }

  if (cols.length > 256) {
    cols = cols.slice(0, 256);
  }

  const samples = samplePlotColumns(b, cols);
  const summary = summarizePlotTerrain(samples, {
    expectY: Number.isFinite(expectY) ? expectY : null,
    flatMaxDelta,
  });

  return {
    ok: true,
    data: { column_count: cols.length, ...summary },
    result: summary.ok
      ? `Terrain OK (${cols.length} columns, topY ${summary.topY_min}..${summary.topY_max}).`
      : `Terrain issues: ${summary.issues.map((i) => i.code).join(', ')}`,
  };
}

export { columnsInRect, MAX_VERIFY_CELLS };
