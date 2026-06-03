/** @size-exempt: goto shares pathfinder + stall recovery */
import { Vec3 } from 'vec3';
import {
  pathfindWithProgressWatchdog,
  ACTION_CAPS_MS,
  OperationTimeoutError,
  NoProgressError,
  timeoutError,
} from '../_helpers.js';
import { findStandableSameXZ } from '../_nav-helpers.js';
import { enrichWithStand, computeReachability, Y_GRACE_MAX_DY } from './_preflight.js';
import { coord3 } from '../_args.js';
import { ok } from '../../shared/action-contract.js';
import { maybeAutoRetraceOnStall } from './_nav-autoretrace.js';
import { navBlockedNextActionHint, withNavRetryWarning } from './nav-hints.js';

/**
 * @param {object} deps
 */
export function createGoto(deps) {
  const {
    ensureBot,
    gotoRetryKey,
    gotoRetryCounts,
    GOTO_RETRY_LIMIT,
    recordMoveFailure,
    clearGotoRetry,
    clearMoveFailure,
    pushStuckCell,
    preflightNav,
    preNudgeIfSticky,
    navBlockedError,
    navFailureError,
    goals,
    fmt,
    posObj,
    ctx,
    config,
    ACTIONS,
  } = deps;

  return async function goto(args) {
    const c = coord3(args);
    if (!c.ok) return c.response;
    let { x, y, z } = c;
    const b = ensureBot();
    const retryKey = gotoRetryKey('goto', x, y, z);
    const priorRetry = gotoRetryCounts.get(retryKey);
    if (priorRetry && priorRetry.count >= GOTO_RETRY_LIMIT) {
      return {
        ok: false,
        error: {
          code: 'NAV_RETRY_LOOP',
          message: `${priorRetry.count} consecutive mc bg_goto / mc goto calls to (${Math.floor(Number(x))}, ${Math.floor(Number(y))}, ${Math.floor(Number(z))}) have failed (last reason: ${priorRetry.lastReason}). Pick a different target — try an adjacent waypoint, mc advise, or look around with mc scene to reassess. Retrying the same coord will not work.`,
          observed_state: {
            retry_count: priorRetry.count,
            last_reason: priorRetry.lastReason,
            target: { x: Math.floor(Number(x)), y: Math.floor(Number(y)), z: Math.floor(Number(z)) },
          },
          next_action_hint: 'mc advise --reason="bg_goto stuck retrying"',
          retry_safe: false,
        },
      };
    }
    const pre = preflightNav(b, x, y, z, 1);
    if (pre && (pre.error || pre.ok === false)) {
      recordMoveFailure('goto', x, y, z, posObj(), pre.error?.code || 'preflight');
      return withNavRetryWarning(pre, retryKey, gotoRetryCounts, GOTO_RETRY_LIMIT);
    }
    let yAdjusted = null;
    if (pre && pre.y_adjusted) {
      yAdjusted = pre.y_adjusted;
      y = pre.y_adjusted.to;
    }
    let targetAdjusted = null;
    if (pre && pre.retarget) {
      targetAdjusted = pre.retarget;
      x = pre.retarget.x;
      y = pre.retarget.y;
      z = pre.retarget.z;
    }
    await preNudgeIfSticky(b, Math.floor(x), Math.floor(y), Math.floor(z));
    let tx = Math.floor(x), ty = Math.floor(y), tz = Math.floor(z);
    const blockAtTarget = b.blockAt(new Vec3(tx, ty, tz));
    const blockAtHead = b.blockAt(new Vec3(tx, ty + 1, tz));
    const isSolid = (blk) => blk && blk.name !== 'air' && blk.name !== 'cave_air'
      && blk.name !== 'void_air' && blk.boundingBox === 'block';
    if (isSolid(blockAtTarget) || isSolid(blockAtHead)) {
      let vert;
      try { vert = findStandableSameXZ(b, tx, ty, tz, Y_GRACE_MAX_DY); } catch { vert = null; }
      if (vert && vert.dy !== 0) {
        yAdjusted = { from: ty, to: vert.y, dy: vert.dy, reason: vert.target_reason, x: tx, z: tz };
        y = vert.y;
        ty = vert.y;
      } else {
        const blocker = isSolid(blockAtTarget) ? blockAtTarget : blockAtHead;
        const pos = posObj();
        return {
          ok: false,
          error: {
            code: 'NAV_TARGET_OCCUPIED',
            message: `Target ${tx},${ty},${tz} is inside a solid block (${blocker.name}), and no standable Y within ±${Y_GRACE_MAX_DY} at this (x,z). Use \`mc goto_near ${tx} ${ty} ${tz}\` to reach an adjacent walkable tile instead.`,
            observed_state: enrichWithStand(b, { target: { x: tx, y: ty, z: tz }, blocker: blocker.name, current: pos, y_grace_searched: Y_GRACE_MAX_DY }, tx, ty, tz),
            retry_safe: false,
          },
        };
      }
    }
    const goal = new goals.GoalBlock(tx, ty, tz);
    try {
      await pathfindWithProgressWatchdog({
        bot: b,
        pathfinderGoto: () => b.pathfinder.goto(goal),
        onStall: () => { try { b.pathfinder.setGoal(null); } catch {} },
        opName: 'goto',
        capMs: ACTION_CAPS_MS.goto,
      });
      const pos = posObj();
      const dist = Math.hypot(pos.x - x, pos.y - y, pos.z - z);
      if (dist > 2) {
        recordMoveFailure('goto', x, y, z, pos, 'pathfinder_gave_up');
        return withNavRetryWarning(
          navBlockedError(b, pos, x, y, z, dist),
          retryKey,
          gotoRetryCounts,
          GOTO_RETRY_LIMIT,
        );
      }
      const reachAfter = computeReachability(b, { x: tx, y: ty, z: tz }, 96);
      const atTargetCell = reachAfter?.walkable_to_target && reachAfter.arrived_cell
        && Math.abs(reachAfter.arrived_cell.x - tx) <= 1
        && Math.abs(reachAfter.arrived_cell.y - ty) <= 1
        && Math.abs(reachAfter.arrived_cell.z - tz) <= 1;
      if (atTargetCell) {
        clearMoveFailure();
      } else {
        recordMoveFailure('goto', x, y, z, pos, reachAfter?.walkable_to_target ? 'near_target_not_at_cell' : 'arrived_near_but_not_walkable');
      }
      clearGotoRetry('goto', x, y, z);
      // Post-action position + fall detection — mirrors goto_near. Server
      // physics can drop the bot after pathfinder reports "arrived" if
      // the landing cell's support is gone. Workers were reasoning from
      // stale Y values and looping pillar_step ↔ pillar_down.
      const endPos = posObj();
      const fellBy = Math.floor(Number(y)) - Math.floor(endPos.y);
      const fellWarning = fellBy >= 4
        ? `⚠ FELL ${fellBy} blocks during pathfinding — now at (${fmt(endPos.x)}, ${fmt(endPos.y)}, ${fmt(endPos.z)}). Surface terrain may differ from scouting; verify with mc terrain_top before further action. `
        : '';
      if (targetAdjusted) {
        const obs = { target_adjusted: targetAdjusted, end_position: endPos };
        if (fellBy >= 4) obs.fell_by_blocks = fellBy;
        return {
          result: `${fellWarning}Arrived at ${fmt(x)}, ${fmt(y)}, ${fmt(z)} (target adjusted ${targetAdjusted.distance}b from requested ${targetAdjusted.from.x},${targetAdjusted.from.y},${targetAdjusted.from.z} — original was unstandable)`,
          observed_state: obs,
        };
      }
      if (yAdjusted) {
        const obs = { y_adjusted: yAdjusted, end_position: endPos };
        if (fellBy >= 4) obs.fell_by_blocks = fellBy;
        return ok({
          result: `${fellWarning}Arrived at ${fmt(x)}, ${fmt(y)}, ${fmt(z)} (y adjusted from ${yAdjusted.from} to ${yAdjusted.to}, Δ=${yAdjusted.dy >= 0 ? '+' : ''}${yAdjusted.dy} — original Y was ${yAdjusted.reason})`,
          data: obs,
        });
      }
      const obs = { end_position: endPos };
      if (fellBy >= 4) obs.fell_by_blocks = fellBy;
      return ok({
        result: `${fellWarning}Arrived at ${fmt(x)}, ${fmt(y)}, ${fmt(z)}`,
        data: obs,
      });
    } catch (e) {
      try { b.pathfinder.setGoal(null); } catch {}
      if (e instanceof NoProgressError) {
        recordMoveFailure('goto', x, y, z, posObj(), 'no_progress');
        pushStuckCell(e.info?.stalled_position, 'no_progress');
        const autoRt = await maybeAutoRetraceOnStall({
          ctx,
          config,
          targetY: y,
          currentY: posObj().y,
          retrace: () => ACTIONS.retrace({}),
        });
        if (autoRt?.ok) {
          return ok({
            result: `Auto-retrace after stall: ${autoRt.result || 'ok'}`,
            data: { auto_retrace: true, retrace: autoRt.data },
          });
        }
        const reach = computeReachability(b, { x, y, z }, 144);
        const hopNote = reach && !reach.walkable_to_target && reach.next_hop_suggestion
          ? ` Try mc goto_near ${reach.next_hop_suggestion.x} ${reach.next_hop_suggestion.y} ${reach.next_hop_suggestion.z} range=1 to route around the obstacle.`
          : ' Try mc escape, mc dig at the blocker, or pick a different target.';
        const obs = enrichWithStand(b, { target: { x, y, z }, current: posObj(), ...e.info }, x, y, z);
        if (reach) Object.assign(obs, reach);
        const stallFail = {
          ok: false,
          error: {
            code: 'NAV_NO_PROGRESS',
            message: `Pathfinder stalled — bot stopped moving for ${e.info?.no_progress_for_ms}ms while heading to ${fmt(x)},${fmt(y)},${fmt(z)}. Often means a 1-block lip, a wedged corner, or a sealed route.${hopNote}`,
            observed_state: obs,
            next_action_hint: navBlockedNextActionHint(b, { x, y, z }, posObj()),
            retry_safe: false,
          },
        };
        return withNavRetryWarning(stallFail, retryKey, gotoRetryCounts, GOTO_RETRY_LIMIT);
      }
      if (e instanceof OperationTimeoutError) {
        recordMoveFailure('goto', x, y, z, posObj(), 'wallclock_timeout');
        return timeoutError('goto', ACTION_CAPS_MS.goto,
          enrichWithStand(b, { target: { x, y, z }, current: posObj() }, x, y, z),
          `Pathfinder didn't finish in time. If observed_state.closest_standable is set, retry mc goto there instead.`);
      }
      const pos = posObj();
      recordMoveFailure('goto', x, y, z, pos, 'pathfinder_error');
      return withNavRetryWarning(
        navFailureError(b, pos, x, y, z, e?.message || String(e)),
        retryKey,
        gotoRetryCounts,
        GOTO_RETRY_LIMIT,
      );
    }
  };
}
