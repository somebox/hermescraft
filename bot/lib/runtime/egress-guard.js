/**
 * Egress protection — keep a bot from digging out its own escape route.
 *
 * `mc stair_down` records its descent in `ctx.runtime.lastDugSteps`
 * ({ steps:[…stand cells…], source:'stair_down', ts, … }) and `mc retrace`
 * walks that trail back up to the surface. The staircase only stays
 * walkable while each tread's *support block* — the block one below each
 * recorded stand cell, at (s.x, s.y-1, s.z) — is intact. If a later bulk
 * dig (tunnel / dig_area) or a single `mc dig` removes those supports, the
 * staircase collapses into an un-climbable shaft and the bot is trapped.
 *
 * This module derives the protected tread set from the most recent trail
 * and provides a small tracker that bulk ops use to skip + report those
 * cells (unless the caller passes `force`). The carved air cells of the
 * staircase are NOT protected: a dig only ever makes air, so it cannot
 * re-fill the walkway — only the support floor is at risk.
 *
 * Single-writer rule: only this module nulls `ctx.runtime.lastDugSteps`
 * for the "dug through with force" case; stair_down/manager own the rest.
 */

const EGRESS_TTL_MS = 30 * 60 * 1000;

function cellKey(x, y, z) {
  return `${x},${y},${z}`;
}

/**
 * Protected tread-support cells from the most recent stair_down trail, or
 * null when there is no fresh trail worth protecting. Each recorded stand
 * cell `s` implies a support block at (s.x, s.y-1, s.z); removing it breaks
 * the step.
 * @param {Record<string, any>|null|undefined} ctx
 * @returns {{ cells: Set<string>, trail: any }|null}
 */
export function egressTreadCells(ctx) {
  const trail = ctx?.runtime?.lastDugSteps;
  const steps = trail?.steps;
  if (!Array.isArray(steps) || steps.length < 2) return null;
  if (trail.source !== 'stair_down') return null;
  if (Number.isFinite(trail.ts) && Date.now() - trail.ts > EGRESS_TTL_MS) return null;
  const cells = new Set();
  for (const s of steps) {
    if (!Number.isFinite(s?.x) || !Number.isFinite(s?.y) || !Number.isFinite(s?.z)) continue;
    cells.add(cellKey(Math.floor(s.x), Math.floor(s.y) - 1, Math.floor(s.z)));
  }
  return cells.size ? { cells, trail } : null;
}

/**
 * @param {{ cells: Set<string> }|null} egress
 */
export function isEgressProtectedCell(egress, x, y, z) {
  return egress ? egress.cells.has(cellKey(Math.floor(x), Math.floor(y), Math.floor(z))) : false;
}

/**
 * Invalidate the recorded stair trail — e.g. after the bot deliberately
 * dug through it with `force`, so `mc retrace` won't follow a now-broken
 * route. No-op when there is no trail.
 * @param {Record<string, any>|null|undefined} ctx
 */
export function clearEgressTrail(ctx, reason = 'dug_through') {
  if (!ctx?.runtime) return;
  if (ctx.runtime.lastDugSteps) {
    ctx.runtime.lastDugStepsClearedAt = { ts: Date.now(), reason };
  }
  ctx.runtime.lastDugSteps = null;
}

/**
 * Tracker a bulk dig uses to decide what to do with each target cell and to
 * build the agent-facing warning afterward.
 *
 * @param {Record<string, any>} ctx
 * @param {object} [opts]
 * @param {boolean} [opts.force] When true, dig through tread cells (and on
 *   finalize invalidate the retrace trail) instead of skipping them.
 * @param {boolean} [opts.ownsTrail] When false (internal sub-op like a
 *   tunnel slice), do NOT invalidate the trail on finalize — the top-level
 *   caller owns that so the count isn't truncated mid-run.
 */
export function createEgressTracker(ctx, { force = false, ownsTrail = true } = {}) {
  const egress = egressTreadCells(ctx);
  let skipped = 0;
  let breached = 0;
  return {
    active: !!egress,
    /**
     * @returns {boolean} true if the caller should SKIP this cell (preserve
     *   the staircase). false → dig it (not protected, or forced through).
     */
    shouldSkip(x, y, z) {
      if (!egress || !isEgressProtectedCell(egress, x, y, z)) return false;
      if (force) {
        breached++;
        return false;
      }
      skipped++;
      return true;
    },
    skippedTotal() {
      return skipped;
    },
    breachedTotal() {
      return breached;
    },
    /** Call once after the op completes. Invalidates the trail if forced through it. */
    finalize() {
      if (breached > 0 && ownsTrail) clearEgressTrail(ctx, 'dug_through_with_force');
    },
    /** Human-facing warning to append to the result line. */
    suffix() {
      if (skipped > 0) {
        return ` ⚠ Preserved ${skipped} staircase tread${skipped === 1 ? '' : 's'} (your stair_down egress) — digging them would strand you below. Pass force=true to tunnel through (this invalidates the retrace trail; build a new way up first).`;
      }
      if (breached > 0) {
        return ` ⚠ Removed ${breached} staircase tread${breached === 1 ? '' : 's'} (force) — retrace trail invalidated. Build a new way up (mc stair_up / mc pillar_up) before you need it.`;
      }
      return '';
    },
    /** Structured fields for the data envelope. */
    dataFields() {
      const out = {};
      if (skipped > 0) out.egress_protected = skipped;
      if (breached > 0) out.egress_removed = breached;
      return out;
    },
  };
}
