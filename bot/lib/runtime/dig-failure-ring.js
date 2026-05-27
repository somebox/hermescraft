/**
 * Shared per-cell dig-failure ring. Backs `mc dig`'s DIG_BLOCKED_REPEAT
 * short-circuit and `mc collect`'s pool filtering — both verbs see the
 * same evidence that a particular cell is genuinely stuck.
 *
 * Stored at `ctx.runtime.recentDigFailures`: an array of
 *   { ts, cell: {x,y,z}, block: name|null, code, hit_count }
 * entries with a 60s sliding window and a 12-entry FIFO cap.
 *
 * Read paths:
 *   - `createDigFailureTracker(ctx, cell, getName).priorRepeat()`
 *     — per-call view used by mc dig's pre-check.
 *   - `priorRepeatBlockedAt(ctx, x, y, z)` — point query used by
 *     mc collect's refreshPool to skip known-stuck cells.
 *
 * Write paths (today): mc dig only — every failure code in dig's
 * runPreDigGuards / equipOrFail / approachOrFail / assertLineOfSight /
 * performDig records via tracker.record(code).
 *
 * Why not write from collect: collect's per-candidate failures include
 * positional causes (pathfind_failed, behind_wall) that resolve when the
 * bot moves to a different cardinal. Recording those would block a
 * legitimate retry from a new angle. Hard dig failures (server reject,
 * timeout) MIGHT be safe to record, but until we've measured we keep
 * collect read-only and let mc dig be the sole writer.
 */

export const DIG_FAIL_WINDOW_MS = 60_000;
export const DIG_FAIL_REPEAT_THRESHOLD = 3;
export const DIG_FAIL_RING_MAX = 12;

/** Prune expired entries and return the ring (creating it if needed). */
function pruneAndGetRing(ctx) {
  if (!ctx?.runtime) return null;
  if (!Array.isArray(ctx.runtime.recentDigFailures)) {
    ctx.runtime.recentDigFailures = [];
  }
  const cutoff = Date.now() - DIG_FAIL_WINDOW_MS;
  ctx.runtime.recentDigFailures = ctx.runtime.recentDigFailures.filter((e) => e.ts > cutoff);
  return ctx.runtime.recentDigFailures;
}

/**
 * Per-cell tracker. Capture once for a known cell + name, then call
 * `record(code)` on each failure, `priorRepeat()` to short-circuit before
 * attempting again, and `clearForCell()` after a confirmed success.
 *
 * @param {object} ctx
 * @param {{x:number,y:number,z:number}} cell
 * @param {() => string | null | undefined} getBlockName
 *   Deferred lookup — at call time the block name may not be known yet.
 */
export function createDigFailureTracker(ctx, cell, getBlockName) {
  const cellMatches = (e) =>
    e.cell.x === cell.x && e.cell.y === cell.y && e.cell.z === cell.z;
  return {
    record(code) {
      const ring = pruneAndGetRing(ctx);
      if (!ring) return;
      const existing = ring.find(cellMatches);
      if (existing) {
        existing.hit_count = (existing.hit_count || 1) + 1;
        existing.ts = Date.now();
        existing.code = code;
      } else {
        ring.push({
          ts: Date.now(),
          cell: { ...cell },
          block: getBlockName() || null,
          code,
          hit_count: 1,
        });
        if (ring.length > DIG_FAIL_RING_MAX) ring.shift();
      }
    },
    priorRepeat() {
      const ring = pruneAndGetRing(ctx);
      if (!ring) return null;
      const prior = ring.find(cellMatches);
      if (prior && prior.hit_count >= DIG_FAIL_REPEAT_THRESHOLD) return prior;
      return null;
    },
    clearForCell() {
      if (!ctx?.runtime?.recentDigFailures?.length) return;
      ctx.runtime.recentDigFailures = ctx.runtime.recentDigFailures.filter((e) => !cellMatches(e));
    },
  };
}

/**
 * Point query — returns the prior ring entry for (x,y,z) if its hit_count
 * is past the repeat threshold, otherwise null. Used by `mc collect`'s
 * pool filter to skip cells `mc dig` has already given up on.
 *
 * Cell coords are floored internally; floats from b.entity.position are OK.
 *
 * @param {object} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} z
 */
export function priorRepeatBlockedAt(ctx, x, y, z) {
  const ring = pruneAndGetRing(ctx);
  if (!ring || ring.length === 0) return null;
  const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
  const prior = ring.find((e) => e.cell.x === fx && e.cell.y === fy && e.cell.z === fz);
  if (prior && prior.hit_count >= DIG_FAIL_REPEAT_THRESHOLD) return prior;
  return null;
}
