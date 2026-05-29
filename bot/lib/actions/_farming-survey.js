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

/**
 * Per-cell categorization of a farm rect: tilled vs planted vs harvestable
 * vs empty. Designed as the one verb an agent calls to answer "what's the
 * state of this plot?" before deciding to till / plant / harvest / wait.
 *
 * Categories:
 *   harvestable        — mature crop on farmland (age == max). Direct
 *                        next-action: mc harvest.
 *   planted_growing    — crop on farmland, age < max. Wait or bonemeal.
 *   tilled             — farmland with air above. Next: mc plant.
 *   empty_soil         — dirt/grass/etc with air above. Next: mc till.
 *   unplantable        — solid non-soil surface (stone, cobble, etc).
 *   no_surface         — no solid block within scan window (cave / void).
 *   farmland_occupied  — farmland with a non-crop block above (decor /
 *                        torch / sapling). Manual triage.
 *   soil_occupied      — soil with a non-air block above. Manual triage.
 */
const FARM_SURFACE_SOIL = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol']);
const FARM_AIR = new Set(['air', 'cave_air', 'void_air']);
const FARM_CROP_MATURE_AGE = {
  wheat: 7, carrots: 7, potatoes: 7, beetroots: 3,
  // Stems mature at age 7 but the actual fruit (pumpkin/melon block) appears
  // adjacent, not above. We report stems as planted_growing until they're
  // age 7, then harvestable (stem-age == max, regardless of fruit presence).
  melon_stem: 7, pumpkin_stem: 7,
};

function categorizeFarmCell(b, x, y, z) {
  const surface = b.blockAt(new Vec3(x, y, z));
  if (!surface) return { category: 'unknown' };
  if (FARM_AIR.has(surface.name)) return { category: 'air' };

  const aboveBlk = b.blockAt(new Vec3(x, y + 1, z));
  const aboveName = aboveBlk?.name ?? null;
  const aboveAir = !aboveBlk || FARM_AIR.has(aboveName);

  if (surface.name === 'farmland') {
    if (aboveAir) return { category: 'tilled' };
    const mature = FARM_CROP_MATURE_AGE[aboveName];
    if (mature != null) {
      const age = Number((aboveBlk.getProperties?.() || {}).age ?? 0);
      return {
        category: age >= mature ? 'harvestable' : 'planted_growing',
        crop: aboveName,
        age,
        mature_age: mature,
      };
    }
    return { category: 'farmland_occupied', block_above: aboveName };
  }
  if (FARM_SURFACE_SOIL.has(surface.name)) {
    return aboveAir
      ? { category: 'empty_soil', soil: surface.name }
      : { category: 'soil_occupied', soil: surface.name, block_above: aboveName };
  }
  return { category: 'unplantable', block: surface.name };
}

/**
 * `mc farm_status X1 Z1 X2 Z2 [Y]` — categorize every column in the rect.
 *
 * If Y is given, the categorizer reads (X, Y, Z) as the surface block. If
 * Y is omitted, each column auto-resolves its top non-air block (via
 * columnTopSolid) and categorizes that. The latter is what a survey card
 * usually wants ("scan this rect, tell me what's there").
 */
export function runFarmStatus(deps, body) {
  const b = deps.ensureBot();

  const x1 = Number(body.x1 ?? body.x);
  const z1 = Number(body.z1 ?? body.z);
  const x2 = Number(body.x2);
  const z2 = Number(body.z2);
  if (![x1, z1, x2, z2].every(Number.isFinite)) {
    return {
      ok: false,
      error: { code: 'INVALID_ARGS', message: 'farm_status requires x1 z1 x2 z2.', retry_safe: false },
    };
  }
  const explicitY = body.y != null ? Number(body.y) : null;

  const cols = columnsInRect(x1, z1, x2, z2);
  if (cols.length > MAX_VERIFY_CELLS) {
    return {
      ok: false,
      error: {
        code: 'RECT_TOO_LARGE',
        message: `farm_status rect has ${cols.length} columns; max ${MAX_VERIFY_CELLS}.`,
        retry_safe: false,
      },
    };
  }

  const counts = {
    harvestable: 0,
    planted_growing: 0,
    tilled: 0,
    empty_soil: 0,
    unplantable: 0,
    no_surface: 0,
    farmland_occupied: 0,
    soil_occupied: 0,
    air: 0,
    unknown: 0,
  };
  /** @type {{x:number,y:number,z:number,crop:string}[]} */
  const harvestable_coords = [];
  /** @type {{x:number,y:number,z:number}[]} */
  const empty_soil_coords = [];
  /** @type {{x:number,y:number,z:number,soil?:string,block_above?:string}[]} */
  const issues = [];

  for (const { x, z } of cols) {
    let yToProbe;
    if (explicitY != null) {
      yToProbe = explicitY;
    } else {
      const top = columnTopSolid(b, x, z);
      if (!top) {
        counts.no_surface++;
        continue;
      }
      yToProbe = top.topY;
    }
    const cell = categorizeFarmCell(b, x, yToProbe, z);
    counts[cell.category] = (counts[cell.category] ?? 0) + 1;
    if (cell.category === 'harvestable' && harvestable_coords.length < 12) {
      harvestable_coords.push({ x, y: yToProbe, z, crop: cell.crop });
    }
    if (cell.category === 'empty_soil' && empty_soil_coords.length < 12) {
      empty_soil_coords.push({ x, y: yToProbe, z });
    }
    if (cell.category === 'farmland_occupied' || cell.category === 'soil_occupied') {
      if (issues.length < 8) issues.push({ x, y: yToProbe, z, ...cell });
    }
  }

  // Next-action hint priority: harvest > till > plant > none.
  const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
  const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
  let nextHint = null;
  if (counts.harvestable > 0) {
    const yHint = harvestable_coords[0]?.y;
    nextHint = `mc harvest ${minX} ${minZ} ${maxX} ${maxZ}${yHint != null ? ` ${yHint}` : ''}   # ${counts.harvestable} mature`;
  } else if (counts.empty_soil > 0) {
    nextHint = `mc till_area ${minX} ${minZ} ${maxX} ${maxZ}   # ${counts.empty_soil} cells need tilling`;
  } else if (counts.tilled > 0) {
    nextHint = `mc plant <seed> X Y Z   # ${counts.tilled} farmland ready (no till_area equivalent for plant yet)`;
  } else if (counts.planted_growing > 0) {
    nextHint = `wait or mc bonemeal each cell — ${counts.planted_growing} crops still growing`;
  } else {
    nextHint = 'no farm-actionable cells in rect';
  }

  return {
    ok: true,
    data: {
      bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ, y: explicitY },
      column_count: cols.length,
      counts,
      harvestable_coords,
      empty_soil_coords,
      ...(issues.length ? { manual_triage: issues } : {}),
    },
    next_action_hint: nextHint,
    result: `${counts.harvestable} harvestable, ${counts.planted_growing} growing, ${counts.tilled} tilled, ${counts.empty_soil} empty soil, ${counts.unplantable + counts.no_surface + counts.farmland_occupied + counts.soil_occupied} other (of ${cols.length} columns).`,
  };
}

export { columnsInRect, MAX_VERIFY_CELLS };
