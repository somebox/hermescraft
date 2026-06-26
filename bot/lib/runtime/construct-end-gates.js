/**
 * Plan completion gates for construct end (D3).
 * Pure probes over getBlockName — no world mutation.
 */

import { isAirBlockName } from './blueprints/compare.js';
import {
  footprintMins,
  iterateFootprintLocals,
  localToWorld,
} from './blueprints/footprint.js';
import { verifyPlan } from './blueprints/verify.js';

const FLUID_OR_EMPTY = new Set(['air', 'cave_air', 'void_air', 'water', 'lava']);

function isPassableBlock(name) {
  const n = String(name || 'air');
  if (FLUID_OR_EMPTY.has(n)) return true;
  return /(_door|_fence_gate|_trapdoor)$/.test(n);
}

function parsePhaseRange(raw) {
  if (Array.isArray(raw)) return raw.map(Number);
  if (typeof raw === 'string') {
    const m = raw.match(/^(-?\d+)\.\.(-?\d+)$/);
    if (m) return [Number(m[1]), Number(m[2])];
  }
  return undefined;
}

/** verifyPlan slice: level/range only (phase id labels do not scope verify). */
function phaseFilter(phase) {
  const p = phase && typeof phase === 'object' ? phase : {};
  const out = {};
  if (p.level != null && Number.isFinite(Number(p.level))) out.level = Number(p.level);
  const range = parsePhaseRange(p.range);
  if (range) out.range = range;
  return out;
}

/**
 * @param {object} ctxPlan enriched plan context (footprint, cellsIndex, anchor)
 * @param {(x:number,y:number,z:number)=>string} getBlockName
 * @param {object} phase
 */
export function evaluatePhaseClean(ctxPlan, getBlockName, phase) {
  const result = verifyPlan(ctxPlan, getBlockName, phaseFilter(phase));
  const { missing, wrong, extra } = result.summary;
  const clean = missing === 0 && wrong === 0 && extra === 0;
  return {
    clean,
    verify: result,
    message: clean
      ? null
      : `Phase not clean: missing=${missing} wrong=${wrong} extra=${extra}`,
  };
}

/**
 * L0: footprint floor (local y=min) must be solid — no air/water/lava.
 */
export function gateL0Ground(ctxPlan, getBlockName) {
  const { footprint, anchor } = ctxPlan;
  const mins = footprintMins(footprint);
  const offenders = [];
  for (const [lx, ly, lz] of iterateFootprintLocals(footprint)) {
    if (ly !== mins.y) continue;
    const w = localToWorld(anchor, footprint, lx, ly, lz);
    const observed = getBlockName(w.x, w.y, w.z) || 'air';
    if (FLUID_OR_EMPTY.has(observed) || isAirBlockName(observed)) {
      offenders.push({ local: [lx, ly, lz], world: w, found: observed, expected: 'solid' });
    }
  }
  return {
    gate: 'l0_ground',
    ok: offenders.length === 0,
    message: offenders.length
      ? `L0 ground not solid: ${offenders.length} air/water/lava cell(s) on footprint floor`
      : null,
    offenders: offenders.slice(0, 12),
  };
}

const PERIMETER_FACES = ['min_z', 'max_z', 'min_x', 'max_x'];

/**
 * Perimeter cells with no planned solid at wall heights (inset from floor/roof).
 * @returns {{ local: number[], face: string }[]}
 */
export function findPerimeterGapLocals(footprint, cellsIndex) {
  const { x, y, z } = footprint.local;
  const gaps = [];
  const wallMinY = y[0] + 2;
  const wallMaxY = y[1] - 1;
  if (wallMinY > wallMaxY) return gaps;

  for (let ly = wallMinY; ly <= wallMaxY; ly++) {
    for (let lx = x[0]; lx <= x[1]; lx++) {
      const keyMinZ = `${lx},${ly},${z[0]}`;
      if (!cellsIndex.has(keyMinZ)) gaps.push({ local: [lx, ly, z[0]], face: 'min_z' });
      const keyMaxZ = `${lx},${ly},${z[1]}`;
      if (!cellsIndex.has(keyMaxZ)) gaps.push({ local: [lx, ly, z[1]], face: 'max_z' });
    }
    for (let lz = z[0]; lz <= z[1]; lz++) {
      const keyMinX = `${x[0]},${ly},${lz}`;
      if (!cellsIndex.has(keyMinX)) gaps.push({ local: [x[0], ly, lz], face: 'min_x' });
      const keyMaxX = `${x[1]},${ly},${lz}`;
      if (!cellsIndex.has(keyMaxX)) gaps.push({ local: [x[1], ly, lz], face: 'max_x' });
    }
  }
  return gaps;
}

/**
 * Perimeter cells on min-Z face with no planned solid at wall heights must stay passable.
 */
export function findMinZGapLocals(footprint, cellsIndex) {
  return findPerimeterGapLocals(footprint, cellsIndex)
    .filter((g) => g.face === 'min_z')
    .map((g) => g.local);
}

function resolveDoorFace(ctxPlan, gaps) {
  const configured = ctxPlan?.door_gap?.face ?? ctxPlan?.plan?.door_gap?.face;
  if (configured && PERIMETER_FACES.includes(configured)) return configured;
  const counts = Object.fromEntries(PERIMETER_FACES.map((f) => [f, 0]));
  for (const g of gaps) counts[g.face] = (counts[g.face] || 0) + 1;
  let best = 'min_z';
  let bestN = -1;
  for (const face of PERIMETER_FACES) {
    if (counts[face] > bestN) {
      bestN = counts[face];
      best = face;
    }
  }
  return best;
}

function doorTraversalPath(face, footprint) {
  const { x, y, z } = footprint.local;
  const midX = Math.floor((x[0] + x[1]) / 2);
  const midZ = Math.floor((z[0] + z[1]) / 2);
  const standY = y[0] + 2;
  switch (face) {
    case 'max_z':
      return { start: [midX, standY, z[1] + 1], goal: [midX, standY, z[1] - 2] };
    case 'min_x':
      return { start: [x[0] - 1, standY, midZ], goal: [x[0] + 2, standY, midZ] };
    case 'max_x':
      return { start: [x[1] + 1, standY, midZ], goal: [x[1] - 2, standY, midZ] };
    case 'min_z':
    default:
      return { start: [midX, standY, z[0] - 1], goal: [midX, standY, z[0] + 2] };
  }
}

function apronPathMessage(face) {
  switch (face) {
    case 'max_z':
      return 'No traversable path from north apron through door into interior';
    case 'min_x':
      return 'No traversable path from west apron through door into interior';
    case 'max_x':
      return 'No traversable path from east apron through door into interior';
    case 'min_z':
    default:
      return 'No traversable path from south apron through door into interior';
  }
}

function bfsTraversable(ctxPlan, getBlockName, startLocal, goalLocal) {
  const { footprint, anchor } = ctxPlan;
  const { x, y, z } = footprint.local;
  const key = (lx, ly, lz) => `${lx},${ly},${lz}`;
  const startKey = key(...startLocal);
  const goalKey = key(...goalLocal);
  const queue = [startLocal];
  const seen = new Set([startKey]);
  const dirs = [
    [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0],
  ];
  while (queue.length) {
    const [lx, ly, lz] = queue.shift();
    if (key(lx, ly, lz) === goalKey) return true;
    for (const [dx, dy, dz] of dirs) {
      const nx = lx + dx;
      const ny = ly + dy;
      const nz = lz + dz;
      if (nx < x[0] - 1 || nx > x[1] + 1 || ny < y[0] || ny > y[1] || nz < z[0] - 1 || nz > z[1] + 1) {
        continue;
      }
      const k = key(nx, ny, nz);
      if (seen.has(k)) continue;
      const w = localToWorld(anchor, footprint, nx, ny, nz);
      if (!isPassableBlock(getBlockName(w.x, w.y, w.z))) continue;
      seen.add(k);
      queue.push([nx, ny, nz]);
    }
  }
  return false;
}

export function gateDoorTraversable(ctxPlan, getBlockName) {
  const { footprint, cellsIndex, anchor } = ctxPlan;
  const allGaps = findPerimeterGapLocals(footprint, cellsIndex);
  const face = resolveDoorFace(ctxPlan, allGaps);
  const gaps = allGaps.filter((g) => g.face === face);
  const blocked = [];
  for (const { local: [lx, ly, lz] } of gaps) {
    const w = localToWorld(anchor, footprint, lx, ly, lz);
    const observed = getBlockName(w.x, w.y, w.z) || 'air';
    if (!isPassableBlock(observed)) {
      blocked.push({ local: [lx, ly, lz], world: w, found: observed, expected: 'passable' });
    }
  }
  if (blocked.length) {
    return {
      gate: 'door_traversable',
      ok: false,
      message: `Door gap blocked (${face}): ${blocked.length} cell(s) not passable`,
      offenders: blocked.slice(0, 12),
    };
  }
  const { start: startLocal, goal: goalLocal } = doorTraversalPath(face, footprint);
  const reachable = bfsTraversable(ctxPlan, getBlockName, startLocal, goalLocal);
  return {
    gate: 'door_traversable',
    ok: reachable,
    message: reachable ? null : apronPathMessage(face),
    offenders: reachable ? [] : [{ local: startLocal, expected: 'path_to_interior', face }],
  };
}

/** Interior ring (inset 1) must match planned air — catches solid-filled rooms. */
export function gateInteriorAir(ctxPlan, getBlockName) {
  const { footprint, cellsIndex, anchor } = ctxPlan;
  const { x, y, z } = footprint.local;
  const offenders = [];
  for (let ly = y[0] + 1; ly <= y[1] - 1; ly++) {
    for (let lx = x[0] + 1; lx <= x[1] - 1; lx++) {
      for (let lz = z[0] + 1; lz <= z[1] - 1; lz++) {
        const key = `${lx},${ly},${lz}`;
        const cell = cellsIndex.get(key);
        const expectAir = !cell;
        if (!expectAir) continue;
        const w = localToWorld(anchor, footprint, lx, ly, lz);
        const observed = getBlockName(w.x, w.y, w.z) || 'air';
        if (!isAirBlockName(observed) && !isPassableBlock(observed)) {
          offenders.push({
            local: [lx, ly, lz],
            world: w,
            found: observed,
            expected: 'air',
          });
        }
      }
    }
  }
  return {
    gate: 'interior_air',
    ok: offenders.length === 0,
    message: offenders.length
      ? `Interior not hollow: ${offenders.length} unexpected solid cell(s)`
      : null,
    offenders: offenders.slice(0, 12),
  };
}

const GATE_RUNNERS = {
  l0_ground: gateL0Ground,
  door_traversable: gateDoorTraversable,
  interior_air: gateInteriorAir,
};

/**
 * @param {object} opts
 * @param {object} opts.ctxPlan
 * @param {(x:number,y:number,z:number)=>string} opts.getBlockName
 * @param {string[]} [opts.gates]
 * @param {object} [opts.phase]
 * @param {boolean} [opts.requirePhaseClean]
 */
export function evaluateConstructEndGates(opts) {
  const {
    ctxPlan,
    getBlockName,
    gates = [],
    phase,
    requirePhaseClean = true,
  } = opts;
  /** @type {object[]} */
  const failures = [];

  if (requirePhaseClean) {
    const phaseCheck = evaluatePhaseClean(ctxPlan, getBlockName, phase);
    if (!phaseCheck.clean) {
      failures.push({
        gate: 'phase_clean',
        ok: false,
        message: phaseCheck.message,
        verify_summary: phaseCheck.verify.summary,
        sample_mismatches: phaseCheck.verify.mismatches.slice(0, 8),
      });
    }
  }

  for (const gateId of gates) {
    const run = GATE_RUNNERS[gateId];
    if (!run) {
      failures.push({
        gate: gateId,
        ok: false,
        message: `Unknown plan gate: ${gateId}`,
      });
      continue;
    }
    const result = run(ctxPlan, getBlockName);
    if (!result.ok) failures.push(result);
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}
