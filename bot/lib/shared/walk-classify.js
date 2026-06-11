/**
 * K1 walk-classify kernel (adaptive-road-planning §8.0.2).
 *
 * Pure terrain classification: column stacks in, walkability runs out.
 * No mineflayer, no CLI, no IO — testable entirely from the committed
 * fixture corpus (data/fixtures/terrain/*.json shares the input schema).
 *
 *   classifyLine({ line, columns }, spec) → { runs, steps, deficits, walkable }
 *   diffRuns(before, after)               → { changed, added, resolved, to_spec }
 *
 * Core semantics this kernel owns (the K1 "hard parts"):
 *  - Surface-pick: the walkable floor nearest the current walk elevation,
 *    NOT the topmost solid — ground under an overhang stays the surface.
 *  - Partial blocks: bottom slabs stand at y+0.5; steps are computed on
 *    real heights, so slab staircases read as walkable (step 0.5).
 *  - RLE hysteresis: run kinds come from sustained elevation trends
 *    (net change ≥ 2*max_step_up+1), so ±1 dither stays one walk run.
 *  - Swath rule: the line is classified path_width wide; obstructions on
 *    any path cell gate the step, shoulders are checked for drop hazards.
 */

const PASSABLE = new Set([
  'air', 'cave_air', 'void_air', 'torch', 'wall_torch', 'snow', 'snow_layer',
  'grass', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
]);
const FLUIDS = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);
const VEGETATION_RE = /(?:_log|_stem|_leaves|_wart_block|_sapling)$/;
const SLAB_RE = /_slab$/;

const isPassable = (name) => !name || PASSABLE.has(name);
const isFluid = (name) => FLUIDS.has(name);
const isVegetation = (name) => VEGETATION_RE.test(name);
const standHeight = (y, name) => (SLAB_RE.test(name) ? y + 0.5 : y + 1);

/**
 * Analyze one column against a reference walk elevation.
 * blocks: [[y, name], ...] sorted ascending; air is implicit.
 */
export function analyzeColumn(blocks, refHeight, spec) {
  if (!blocks || blocks.length === 0) return { surface: null };
  const byY = new Map(blocks.map(([y, name]) => [y, name]));

  // Floor candidates: solid (non-fluid, non-vegetation) blocks whose cell
  // above is not terrain-solid (fluid/vegetation above keeps candidacy —
  // those become water / tree findings, not "no floor").
  const candidates = [];
  for (const [y, name] of blocks) {
    if (isFluid(name) || isVegetation(name) || isPassable(name)) continue;
    const above = byY.get(y + 1);
    if (above && !isPassable(above) && !isFluid(above) && !isVegetation(above)) continue;
    candidates.push({ block_y: y, name, height: standHeight(y, name) });
  }
  if (candidates.length === 0) return { surface: null };

  let surface = candidates[0];
  for (const c of candidates) {
    const d = Math.abs(c.height - refHeight);
    const best = Math.abs(surface.height - refHeight);
    if (d < best || (d === best && c.height < surface.height)) surface = c;
  }

  let waterDepth = 0;
  for (let y = surface.block_y + 1; isFluid(byY.get(y)); y++) waterDepth++;

  // First obstruction in the clearance window above the feet.
  let obstruction = null;
  const feet = Math.ceil(surface.height);
  for (let y = feet; y < feet + spec.clearance_height; y++) {
    const name = byY.get(y);
    if (isPassable(name) || isFluid(name)) continue;
    obstruction = {
      y,
      name,
      gap: y - feet,
      vegetation: isVegetation(name),
    };
    break;
  }
  return { surface, waterDepth, obstruction };
}

function lineCells(from, to) {
  // 2D Bresenham over (x, z), endpoints inclusive.
  let [x, z] = from;
  const [x1, z1] = to;
  const dx = Math.abs(x1 - x);
  const dz = Math.abs(z1 - z);
  const sx = x < x1 ? 1 : -1;
  const sz = z < z1 ? 1 : -1;
  let err = dx - dz;
  const cells = [];
  for (;;) {
    cells.push([x, z]);
    if (x === x1 && z === z1) break;
    const e2 = 2 * err;
    if (e2 > -dz) { err -= dz; x += sx; }
    if (e2 < dx) { err += dx; z += sz; }
  }
  return cells;
}

/**
 * Label a contiguous stretch of standable steps walk/climb/descend.
 * A monotone group (same-sign dys, plateau gaps ≤2 cells) whose net
 * elevation change reaches minNet becomes climb/descend; everything else
 * is walk. This is the hysteresis that keeps dither from fragmenting.
 */
function trendLabels(elevs, baseElev, minNet) {
  const n = elevs.length;
  const labels = new Array(n).fill('walk');
  const dys = elevs.map((h, i) => h - (i ? elevs[i - 1] : baseElev));
  const groups = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    if (dys[i] === 0) continue;
    const sign = dys[i] > 0 ? 1 : -1;
    if (cur && cur.sign === sign && i - cur.end <= 3) {
      cur.end = i;
      cur.net += dys[i];
    } else {
      if (cur) groups.push(cur);
      cur = { sign, start: i, end: i, net: dys[i] };
    }
  }
  if (cur) groups.push(cur);
  for (const g of groups) {
    if (Math.abs(g.net) < minNet) continue;
    const kind = g.sign > 0 ? 'climb' : 'descend';
    for (let i = g.start; i <= g.end; i++) labels[i] = kind;
  }
  return labels;
}

export function classifyLine(input, spec) {
  const { line, columns } = input;
  const width = input.width ?? spec.path_width;
  const half = Math.floor((width - 1) / 2);
  const colMap = new Map(columns.map((c) => [`${c.x},${c.z}`, c.blocks]));
  const colAt = (x, z) => colMap.get(`${x},${z}`) || null;

  const cells = lineCells(line.from, line.to);
  // Perpendicular axis: offsets run across the line's dominant direction.
  const axisX = Math.abs(line.to[0] - line.from[0]) >= Math.abs(line.to[1] - line.from[1]);
  const side = (x, z, o) => (axisX ? [x, z + o] : [x + o, z]);

  const minNet = 2 * spec.max_step_up + 1;
  let prevElev = line.y_hint + 1;

  const steps = [];
  const deficits = [];
  // Open spans for mergeable deficits, keyed by kind.
  const spans = {};
  const closeSpan = (kind) => {
    const s = spans[kind];
    if (!s) return;
    delete spans[kind];
    const base = { kind, from: s.from, to: s.to };
    if (kind === 'water') deficits.push({ ...base, width: s.n, depth: s.depth });
    else if (kind === 'gap') deficits.push({ ...base, width: s.n, depth: s.depth });
    else if (kind === 'clearance') deficits.push({ ...base, height: s.height });
  };
  const closeSpansExcept = (kind) => {
    for (const k of Object.keys(spans)) if (k !== kind) closeSpan(k);
  };
  const extendSpan = (kind, x, z, fields) => {
    closeSpansExcept(kind);
    const s = spans[kind];
    if (s) {
      s.to = [x, z];
      s.n += 1;
      if (fields.depth !== undefined) s.depth = Math.max(s.depth, fields.depth);
      if (fields.height !== undefined) s.height = Math.min(s.height, fields.height);
    } else {
      spans[kind] = { from: [x, z], to: [x, z], n: 1, ...fields };
    }
  };

  for (const [x, z] of cells) {
    const center = analyzeColumn(colAt(x, z), prevElev, spec);
    const step = { x, z, kind: null, elev: prevElev };

    if (!center.surface) {
      step.kind = 'gap';
      extendSpan('gap', x, z, { depth: null });
    } else {
      const h = center.surface.height;
      const drop = prevElev - h;
      if (drop >= spec.no_floor_min_depth) {
        step.kind = 'gap';
        extendSpan('gap', x, z, { depth: drop });
      } else if (center.waterDepth > 0) {
        step.kind = 'water';
        extendSpan('water', x, z, { depth: center.waterDepth });
      } else {
        // Standable: steps, floor material, obstructions across the swath.
        const dy = h - prevElev;
        if (dy > spec.max_step_up) {
          deficits.push({ kind: 'step', at: [x, z], rise: dy });
        } else if (-dy > spec.max_unguarded_drop) {
          deficits.push({ kind: 'drop', at: [x, z], drop: -dy });
        }
        if (spec.forbidden_floor.includes(center.surface.name) &&
            !isFluid(center.surface.name)) {
          deficits.push({ kind: 'forbidden_floor', at: [x, z], block: center.surface.name });
        }

        let clearanceGap = null;
        const trunkCells = [];
        const inspect = (cx, cz, found) => {
          if (!found || !found.obstruction) return;
          if (found.obstruction.vegetation) {
            trunkCells.push({ at: [cx, cz], base_y: found.obstruction.y });
          } else {
            clearanceGap = clearanceGap === null
              ? found.obstruction.gap : Math.min(clearanceGap, found.obstruction.gap);
          }
        };
        inspect(x, z, center);
        for (let o = 1; o <= half; o++) {
          for (const sgn of [-1, 1]) {
            const [sx, sz] = side(x, z, sgn * o);
            inspect(sx, sz, analyzeColumn(colAt(sx, sz), h, spec));
          }
        }
        // Shoulders: drop hazards just off the path edge.
        for (const sgn of [-1, 1]) {
          for (let o = half + 1; o <= half + spec.shoulder_width; o++) {
            const [sx, sz] = side(x, z, sgn * o);
            const sh = analyzeColumn(colAt(sx, sz), h, spec);
            if (sh && sh.surface && h - sh.surface.height > spec.max_unguarded_drop) {
              deficits.push({
                kind: 'drop_hazard', at: [sx, sz], drop: h - sh.surface.height,
              });
            }
          }
        }

        for (const t of trunkCells) deficits.push({ kind: 'tree', ...t });
        if (trunkCells.length > 0) {
          step.kind = 'trees';
          closeSpansExcept(null);
        } else if (clearanceGap !== null) {
          step.kind = 'clearance';
          extendSpan('clearance', x, z, { height: clearanceGap });
        } else {
          closeSpansExcept(null);  // trend cell — resolved after the pass
        }
        prevElev = h;
        step.elev = h;
      }
    }
    steps.push(step);
  }
  closeSpansExcept(null);

  // Resolve trend cells (kind=null) stretch by stretch.
  let i = 0;
  while (i < steps.length) {
    if (steps[i].kind !== null) { i++; continue; }
    let j = i;
    while (j < steps.length && steps[j].kind === null) j++;
    const stretch = steps.slice(i, j);
    const baseElev = i > 0 ? steps[i - 1].elev : line.y_hint + 1;
    const labels = trendLabels(stretch.map((s) => s.elev), baseElev, minNet);
    stretch.forEach((s, k) => { s.kind = labels[k]; });
    i = j;
  }

  // RLE merge into runs.
  const runs = [];
  for (const s of steps) {
    const last = runs[runs.length - 1];
    if (last && last.kind === s.kind) {
      last.to = [s.x, s.z];
      last.length += 1;
      last.elev_end = s.elev;
    } else {
      runs.push({
        kind: s.kind, from: [s.x, s.z], to: [s.x, s.z],
        length: 1, elev_start: s.elev, elev_end: s.elev,
      });
    }
  }

  return { runs, steps, deficits, walkable: deficits.length === 0 };
}

const deficitKey = (d) =>
  `${d.kind}@${(d.at || d.from).join(',')}${d.to ? `-${d.to.join(',')}` : ''}`;

/**
 * Diff two classifications of the same line, aligned by world coords.
 * Returns RLE kind deviations plus resolved/added deficits — the payload
 * behind `mc survey_line --diff` (§7.2).
 */
export function diffRuns(before, after) {
  const beforeKind = new Map(before.steps.map((s) => [`${s.x},${s.z}`, s.kind]));
  const changed = [];
  for (const s of after.steps) {
    const was = beforeKind.get(`${s.x},${s.z}`);
    if (was === undefined || was === s.kind) continue;
    const last = changed[changed.length - 1];
    if (last && last.before === was && last.after === s.kind) {
      last.to = [s.x, s.z];
      last.length += 1;
    } else {
      changed.push({ from: [s.x, s.z], to: [s.x, s.z], length: 1, before: was, after: s.kind });
    }
  }
  const beforeDef = new Map(before.deficits.map((d) => [deficitKey(d), d]));
  const afterDef = new Map(after.deficits.map((d) => [deficitKey(d), d]));
  const resolved = [...beforeDef.entries()]
    .filter(([k]) => !afterDef.has(k)).map(([, d]) => d);
  const added = [...afterDef.entries()]
    .filter(([k]) => !beforeDef.has(k)).map(([, d]) => d);
  return { changed, resolved, added, to_spec: after.walkable };
}
