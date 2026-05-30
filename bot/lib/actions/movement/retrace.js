/**
 * Walk back along mc stair_down's recorded steps[] (reverse ascent).
 * Phase 1: lastDugSteps only. Phase 2 adds NavTrail / marks / recovery.
 */
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { fail, ok } from '../../shared/action-contract.js';
import { pathfindGoalCapped } from '../_helpers.js';
import { navTrailCrumbsNewestFirst } from '../../runtime/nav-trail.js';

const { goals } = pathfinderPkg;

const AIR = new Set(['air', 'cave_air', 'void_air']);
const LEG_CAP_MS = 10000;
const MAX_CONSECUTIVE_LEG_FAILURES = 5;
const ARRIVE_TOL_XZ = 1.25;
const ARRIVE_TOL_Y = 1.5;

/**
 * @param {any} blk
 */
function isSolidBlock(blk) {
  return blk && !AIR.has(blk.name) && blk.boundingBox === 'block';
}

/**
 * Whether a stand cell is walkable (support below, feet/head air).
 * @param {any} b mineflayer bot
 * @param {{ x: number, y: number, z: number }} cell feet block coords
 */
export function validateRetraceStepCell(b, cell) {
  const x = Math.floor(cell.x);
  const y = Math.floor(cell.y);
  const z = Math.floor(cell.z);
  const below = b.blockAt(new Vec3(x, y - 1, z));
  const feet = b.blockAt(new Vec3(x, y, z));
  const head = b.blockAt(new Vec3(x, y + 1, z));
  if (!below || !feet || !head) {
    return { ok: false, reason: 'chunk_unloaded' };
  }
  if (!isSolidBlock(below)) {
    return { ok: false, reason: 'gap', below: below.name };
  }
  if (isSolidBlock(feet) || isSolidBlock(head)) {
    const blocker = isSolidBlock(feet) ? feet.name : head.name;
    return { ok: false, reason: 'obstruction', blocker };
  }
  return { ok: true };
}

/**
 * @param {Array<{ x: number, y: number, z: number }>} steps descent order
 * @returns {Array<{ x: number, y: number, z: number }>} bottom → top
 */
export function ascentTargetsFromSteps(steps) {
  if (!Array.isArray(steps) || steps.length < 2) return [];
  return [...steps].reverse();
}

function distToCell(pos, cell) {
  return Math.hypot(
    pos.x - (cell.x + 0.5),
    pos.y - cell.y,
    pos.z - (cell.z + 0.5),
  );
}

function atCell(pos, cell) {
  return (
    Math.abs(pos.x - (cell.x + 0.5)) <= ARRIVE_TOL_XZ
    && Math.abs(pos.z - (cell.z + 0.5)) <= ARRIVE_TOL_XZ
    && Math.abs(pos.y - cell.y) <= ARRIVE_TOL_Y
  );
}

/**
 * @param {object} deps
 */
/**
 * @param {Record<string, any>} ctx
 * @param {(name?: string) => Record<string, { x: number, y: number, z: number }>} [loadLocations]
 * @param {Record<string, unknown>} [args]
 */
export function resolveRetraceTrail(ctx, loadLocations, args = {}) {
  const markName = args.mark != null ? String(args.mark).trim() : '';
  if (markName && typeof loadLocations === 'function') {
    const loc = loadLocations()[markName];
    if (loc && Number.isFinite(loc.x)) {
      const pos = ctx?.world?.bot?.entity?.position;
      const start = pos
        ? { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
        : null;
      const end = { x: Math.round(loc.x), y: Math.round(loc.y), z: Math.round(loc.z) };
      const steps = start ? [start, end] : [end];
      return { steps, source: 'mark', mark: markName, start: steps[0], end };
    }
  }
  if (args.use_trail === true || args.use_trail === 'true') {
    const crumbs = navTrailCrumbsNewestFirst(ctx);
    if (crumbs.length >= 2) {
      return { steps: crumbs, source: 'nav_trail', ts: Date.now() };
    }
    const last = ctx?.runtime?.lastDugSteps;
    if (last?.steps?.length >= 2) {
      return {
        steps: last.steps,
        source: 'stair_down',
        requested_trail: 'nav_trail',
        fallback: true,
      };
    }
    return null;
  }
  const last = ctx?.runtime?.lastDugSteps;
  if (last?.steps?.length >= 2) {
    return { steps: last.steps, source: 'stair_down' };
  }
  return null;
}

export function createRetrace(deps) {
  const { ctx, ensureBot, posObj, fmt, loadLocations, ACTIONS } = deps;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  return async function retrace(args = {}) {
    const b = ensureBot();
    const trail = resolveRetraceTrail(ctx, loadLocations, args);
    const steps = trail?.steps;
    if (!trail || !Array.isArray(steps) || steps.length < 2) {
      const wantedCrumbs = args.use_trail === true || args.use_trail === 'true';
      const message = wantedCrumbs
        ? 'No trail to retrace: nav-trail crumbs < 2 AND no stair_down trail available. Walk somewhere (mc move) to lay crumbs, or mc stair_down to record a descent first.'
        : 'No stair_down trail to retrace. Run mc stair_down first (at least 2 stand cells), or mc retrace --trail to walk back over nav-trail crumbs.';
      return fail('RETRACE_NO_TRAIL', message, {
        observed_state: { has_trail: !!trail, step_count: steps?.length ?? 0, requested_trail: wantedCrumbs ? 'nav_trail' : 'stair_down' },
        next_action_hint: wantedCrumbs ? 'mc move <coords> # lays crumbs' : 'mc stair_down north 8',
        retry_safe: false,
      });
    }

    const targets = ascentTargetsFromSteps(steps);
    const attempts = [];
    let consecutiveFailures = 0;
    const fromPos = posObj();

    for (let i = 0; i < targets.length; i++) {
      const cell = targets[i];
      const pos = b.entity.position;
      if (atCell(pos, cell)) {
        attempts.push({ leg: i, cell, mode: 'already_there' });
        consecutiveFailures = 0;
        continue;
      }

      let validation = validateRetraceStepCell(b, cell);
      if (!validation.ok && validation.reason === 'obstruction' && ACTIONS?.dig) {
        const budget = ctx.runtime._retraceRecovery || { digs: 0, places: 0 };
        if (budget.digs < 2) {
          const feet = b.blockAt(new Vec3(Math.floor(cell.x), Math.floor(cell.y), Math.floor(cell.z)));
          if (feet && validation.blocker) {
            try {
              await ACTIONS.dig({
                x: Math.floor(cell.x),
                y: Math.floor(cell.y),
                z: Math.floor(cell.z),
              });
              budget.digs++;
              ctx.runtime._retraceRecovery = budget;
              validation = validateRetraceStepCell(b, cell);
            } catch { /* fall through */ }
          }
        }
      }
      if (!validation.ok) {
        consecutiveFailures++;
        attempts.push({ leg: i, cell, mode: 'validate_failed', ...validation });
        const code = validation.reason === 'gap' ? 'RETRACE_GAP' : 'RETRACE_BLOCKED';
        if (consecutiveFailures >= MAX_CONSECUTIVE_LEG_FAILURES) {
          return fail(code, `Retrace blocked at leg ${i}: ${validation.reason}.`, {
            observed_state: { step_index: i, cell, attempts, ...validation },
            next_action_hint: 'mc dig or mc place to restore the tread',
            retry_safe: true,
          });
        }
        continue;
      }

      const goal = new goals.GoalBlock(cell.x, cell.y, cell.z);
      let legMode = 'goto';
      try {
        await pathfindGoalCapped(b, () => b.pathfinder.goto(goal), LEG_CAP_MS, 'retrace_leg');
      } catch {
        legMode = 'goto_stalled';
      }
      try { b.pathfinder.setGoal(null); } catch {}

      let posAfter = b.entity.position;
      if (!atCell(posAfter, cell)) {
        legMode = 'burst';
        const cx = cell.x + 0.5;
        const cy = cell.y;
        const cz = cell.z + 0.5;
        const prev = i > 0 ? targets[i - 1] : null;
        const dirX = prev ? cx - (prev.x + 0.5) : 0;
        const dirZ = prev ? cz - (prev.z + 0.5) : 0;
        const lookX = cx + (dirX !== 0 ? Math.sign(dirX) * 0.5 : 0);
        const lookZ = cz + (dirZ !== 0 ? Math.sign(dirZ) * 0.5 : 0);
        try {
          await b.lookAt(new Vec3(lookX, cy + 1.62, lookZ));
          b.setControlState('forward', true);
          b.setControlState('jump', true);
          await sleep(450);
          b.setControlState('forward', false);
          b.setControlState('jump', false);
          await sleep(150);
        } catch {
          try { b.setControlState('forward', false); b.setControlState('jump', false); } catch {}
        }
        posAfter = b.entity.position;
      }

      const arrived = atCell(posAfter, cell);
      attempts.push({ leg: i, cell, mode: legMode, arrived });
      if (arrived) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_LEG_FAILURES) {
          return fail(
            'RETRACE_STEP_FAILED',
            `Retrace stalled at leg ${i} toward ${fmt(cell.x)},${fmt(cell.y)},${fmt(cell.z)} (${legMode}).`,
            {
              observed_state: {
                step_index: i,
                cell,
                attempts,
                from: fromPos,
                to: posObj(),
                trail_source: trail.source,
              },
              next_action_hint: 'mc escape',
              retry_safe: true,
            },
          );
        }
      }
    }

    const endPos = posObj();
    const top = steps[0];
    const atTop = atCell(endPos, top);
    return ok({
      result: atTop
        ? `Retraced ${steps.length} cells to ${fmt(top.x)},${fmt(top.y)},${fmt(top.z)}.`
        : `Retrace finished at ${fmt(endPos.x)},${fmt(endPos.y)},${fmt(endPos.z)} (target top ${fmt(top.x)},${fmt(top.y)},${fmt(top.z)}).`,
      data: {
        legs: attempts.length,
        at_top: atTop,
        from: fromPos,
        to: endPos,
        top,
        attempts,
        trail_source: trail.source,
        ...(trail.fallback ? { trail_fallback: true, requested_trail: trail.requested_trail } : {}),
      },
    });
  };
}
