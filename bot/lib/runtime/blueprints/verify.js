import fs from 'node:fs';
import path from 'node:path';
import { compareBlocks, isAirBlockName, isFixtureBlockName } from './compare.js';
import { iterateFootprintLocals, localToWorld } from './footprint.js';
import { BLUEPRINT_LIMITS } from './limits.js';

/**
 * Classify footprint cells vs observed blocks.
 */
export function verifyPlan(ctx, getBlockName, phase = {}) {
  const { footprint, cellsIndex, anchor } = ctx;
  const mismatches = [];
  let ok = 0;
  let missing = 0;
  let wrong = 0;
  let extra = 0;
  let fixtures = 0;

  const max = BLUEPRINT_LIMITS.verifyMaxCellsPerCall;
  let scanned = 0;
  let truncated = false;

  const inPhase = (lx, ly, lz) => {
    if (phase.atWorld) {
      const w = localToWorld(anchor, footprint, lx, ly, lz);
      return w.x === phase.atWorld.x && w.y === phase.atWorld.y && w.z === phase.atWorld.z;
    }
    if (phase.level != null) return ly === phase.level;
    if (phase.range) {
      const [a, b] = phase.range;
      return ly >= a && ly <= b;
    }
    return true;
  };

  for (const [lx, ly, lz] of iterateFootprintLocals(footprint)) {
    if (!inPhase(lx, ly, lz)) continue;
    if (scanned >= max) {
      truncated = true;
      break;
    }
    scanned++;
    const key = `${lx},${ly},${lz}`;
    const expectedCell = cellsIndex.get(key);
    const expectedBlock = expectedCell?.block || 'air';
    const world = localToWorld(anchor, footprint, lx, ly, lz);
    const observed = getBlockName(world.x, world.y, world.z) || 'air';
    const obsAir = isAirBlockName(observed);
    const expAir = !expectedCell;

    if (expAir && obsAir) {
      ok++;
      continue;
    }
    if (expAir && !obsAir) {
      // Base furniture (chest/furnace/bed/…) placed in an interior air cell is
      // INTENDED content, not structural junk, and is usually protected from
      // digging — don't count it as a removable extra (it must not block the
      // structural construct-end gate). Scaffolding/material blocks still do.
      if (isFixtureBlockName(observed)) {
        fixtures++;
        continue;
      }
      extra++;
      mismatches.push({
        cell: world,
        local: [lx, ly, lz],
        expected: 'air',
        observed,
        category: 'extra',
      });
      continue;
    }
    if (!expAir && obsAir) {
      missing++;
      mismatches.push({
        cell: world,
        local: [lx, ly, lz],
        expected: expectedBlock,
        observed: 'air',
        category: 'missing',
      });
      continue;
    }
    const cmp = compareBlocks(expectedBlock, observed);
    if (cmp.match) {
      ok++;
    } else {
      wrong++;
      mismatches.push({
        cell: world,
        local: [lx, ly, lz],
        expected: expectedBlock,
        observed,
        category: 'wrong',
        compare_note: cmp.compare_note,
      });
    }
  }

  return {
    summary: { ok, missing, wrong, extra, fixtures, scanned },
    mismatches,
    truncated,
    next_hint: truncated ? 'Rerun with --level or --range to continue' : undefined,
  };
}

export function writePlanAtomic(filePath, plan) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

const LOCK_STALE_MS = 5 * 60 * 1000;

export function plansDirForLock(dataDir) {
  return path.join(dataDir, 'ops', 'plans');
}

export function acquirePlanWriteLock(dataDir) {
  const dir = plansDirForLock(dataDir);
  const lockPath = path.join(dir, '.write.lock');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(lockPath)) {
    const st = fs.statSync(lockPath);
    if (Date.now() - st.mtimeMs < LOCK_STALE_MS) {
      return { ok: false, code: 'WRITE_LOCKED' };
    }
    fs.unlinkSync(lockPath);
  }
  fs.writeFileSync(lockPath, `${process.pid}\n`, 'utf8');
  return { ok: true, lockPath };
}

export function releasePlanWriteLock(lockPath) {
  try {
    if (lockPath && fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}
