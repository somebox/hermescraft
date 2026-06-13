/** @size-exempt: goto_near shares pathfinder + stall recovery */
import { Vec3 } from 'vec3';
import {
  pathfindWithProgressWatchdog,
  ACTION_CAPS_MS,
  OperationTimeoutError,
  NoProgressError,
  timeoutError,
} from '../_helpers.js';
import {
  enrichWithStand,
  isStandableCell,
  standingState,
  computeReachability,
} from './_preflight.js';
import { coord3 } from '../_args.js';
import { ok } from '../../shared/action-contract.js';
import { navBlockedNextActionHint, withNavRetryWarning } from './nav-hints.js';
import { FAIR_PLAY } from '../../runtime/fair-play-constants.js';

/**
 * @param {object} deps
 */
export function createGotoNear(deps) {
  const {
    ensureBot,
    goals,
    fmt,
    posObj,
    hasLineOfSight,
    recordMoveFailure,
    clearMoveFailure,
    pushStuckCell,
    preflightNav,
    preNudgeIfSticky,
    navBlockedError,
    navFailureError,
    gotoRetryKey,
    gotoRetryCounts,
    GOTO_RETRY_LIMIT,
  } = deps;

  return async function goto_near(args) {
    const c = coord3(args);
    if (!c.ok) return c.response;
    let { x, y, z } = c;
    const range = args.range ?? 2;
    const los = args.los;
    const b = ensureBot();
    const retryKey = gotoRetryKey('goto_near', x, y, z);
    const pre = preflightNav(b, x, y, z, range);
    if (pre && (pre.error || pre.ok === false)) {
      recordMoveFailure('goto_near', x, y, z, posObj(), pre.error?.code || 'preflight');
      return withNavRetryWarning(pre, retryKey, gotoRetryCounts, GOTO_RETRY_LIMIT);
    }
    let yAdjusted = null;
    if (pre && pre.y_adjusted) {
      yAdjusted = pre.y_adjusted;
      y = pre.y_adjusted.to;
    }
    await preNudgeIfSticky(b, Math.floor(x), Math.floor(y), Math.floor(z));
    const tx = Math.floor(x), ty = Math.floor(y), tz = Math.floor(z);

    let goal = new goals.GoalNear(tx, ty, tz, range);
    let losPicked = null;
    if (los !== false && typeof hasLineOfSight === 'function') {
      const targetBlock = b.blockAt(new Vec3(tx, ty, tz));
      const targetIsSolid = !!(targetBlock
        && targetBlock.boundingBox === 'block'
        && targetBlock.name !== 'air'
        && targetBlock.name !== 'cave_air');
      if (targetIsSolid) {
        const cBx = tx + 0.5, cBy = ty + 0.5, cBz = tz + 0.5;
        const faces = [
          { x: cBx, y: cBy, z: cBz - 0.48 },
          { x: cBx, y: cBy, z: cBz + 0.48 },
          { x: cBx - 0.48, y: cBy, z: cBz },
          { x: cBx + 0.48, y: cBy, z: cBz },
          { x: cBx, y: cBy - 0.48, z: cBz },
          { x: cBx, y: cBy + 0.48, z: cBz },
          { x: cBx, y: cBy, z: cBz },
        ];
        const cands = [];
        const R = Math.max(1, Math.floor(range));
        for (let dx = -R; dx <= R; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -R; dz <= R; dz++) {
              if (dx === 0 && dy === 0 && dz === 0) continue;
              const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
              if (d > range) continue;
              const cx = tx + dx, cy = ty + dy, cz = tz + dz;
              if (!isStandableCell(b, cx, cy, cz)) continue;
              const candEye = { x: cx + 0.5, y: cy + FAIR_PLAY.FAIRPLAY_EYE_HEIGHT_DEFAULT, z: cz + 0.5 };
              if (faces.some((p) => hasLineOfSight(candEye, p))) {
                cands.push({ cx, cy, cz, d });
              }
            }
          }
        }
        if (cands.length > 0) {
          cands.sort((a, c) => a.d - c.d);
          losPicked = cands[0];
          goal = new goals.GoalBlock(losPicked.cx, losPicked.cy, losPicked.cz);
        }
      }
    }
    try {
      await pathfindWithProgressWatchdog({
        bot: b,
        pathfinderGoto: () => b.pathfinder.goto(goal),
        onStall: () => { try { b.pathfinder.setGoal(null); } catch {} },
        opName: 'goto_near',
        capMs: ACTION_CAPS_MS.goto_near,
      });
      const pos = posObj();
      const dist = Math.hypot(pos.x - x, pos.y - y, pos.z - z);
      if (dist > range + 1.5) {
        recordMoveFailure('goto_near', x, y, z, pos, 'pathfinder_gave_up');
        return withNavRetryWarning(
          navBlockedError(b, pos, x, y, z, dist),
          retryKey,
          gotoRetryCounts,
          GOTO_RETRY_LIMIT,
        );
      }
      clearMoveFailure();
      // Post-action position read (used by every success path below).
      // Pathfinder reports "arrived" at the goal cell, but server physics
      // can drop the bot if the landing cell's support failed (cave-below,
      // floating block, etc.). Live evidence 2026-05-27: Flint's
      // `mc goto_near 386 63 -601` returned success; his actual Y by the
      // time the response arrived was 43 (20-block fall). Worker read
      // only the message text and assumed Y=63 → looped pillar_step ↔
      // pillar_down without realizing he was on a totally different
      // level. Always include end_position; surface a loud fall warning
      // when the bot dropped >3 from the target Y (4+ is fall damage).
      const endPos = posObj();
      const fellBy = Math.floor(Number(y)) - Math.floor(endPos.y);
      const fellWarning = fellBy >= 4
        ? `⚠ FELL ${fellBy} blocks during pathfinding — now at (${fmt(endPos.x)}, ${fmt(endPos.y)}, ${fmt(endPos.z)}). The path landed on or led through a hole/cave; surface terrain at the target cell may differ from what scouting showed. Verify with mc terrain_top before any further dig/place. `
        : '';
      let landingInfo;
      try {
        const ss = standingState(b);
        const ugly = ['corner', 'wedge', 'edge', 'three_walled'];
        if (ugly.includes(ss.classification)) {
          let suggested = null;
          const candidates = [];
          for (let dx = -range; dx <= range; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              for (let dz = -range; dz <= range; dz++) {
                if (dx === 0 && dy === 0 && dz === 0) continue;
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (dist > range) continue;
                candidates.push({ cx: tx + dx, cy: ty + dy, cz: tz + dz, dist });
              }
            }
          }
          candidates.sort((a, c) => a.dist - c.dist);
          const myCellX = ss.cell.x, myCellY = ss.cell.y, myCellZ = ss.cell.z;
          for (const c of candidates) {
            if (c.cx === myCellX && c.cy === myCellY && c.cz === myCellZ) continue;
            if (!isStandableCell(b, c.cx, c.cy, c.cz)) continue;
            const checks = [
              b.blockAt(new Vec3(c.cx + 1, c.cy, c.cz)),
              b.blockAt(new Vec3(c.cx - 1, c.cy, c.cz)),
              b.blockAt(new Vec3(c.cx, c.cy, c.cz + 1)),
              b.blockAt(new Vec3(c.cx, c.cy, c.cz - 1)),
            ];
            const blocked = checks.filter(blk => blk && blk.boundingBox === 'block').length;
            if (blocked <= 1) {
              suggested = { x: c.cx, y: c.cy, z: c.cz, blocked_neighbors: blocked, distance_from_target: Number(c.dist.toFixed(2)) };
              break;
            }
          }
          landingInfo = {
            landed_in: ss.classification,
            landing_position: ss.position,
            suggested_correction: suggested,
          };
        }
      } catch { /* never let landing inspection break success */ }
      const reachability = computeReachability(b, { x: tx, y: ty, z: tz }, 96);

      const yAdjNote = yAdjusted
        ? ` (y adjusted from ${yAdjusted.from} to ${yAdjusted.to}, Δ=${yAdjusted.dy >= 0 ? '+' : ''}${yAdjusted.dy} — original Y was ${yAdjusted.reason})`
        : '';
      if (landingInfo) {
        const note = landingInfo.suggested_correction
          ? ` (landed in ${landingInfo.landed_in} — observed_state.suggested_correction shows a cleaner cell within range)`
          : ` (landed in ${landingInfo.landed_in} — no cleaner cell within range)`;
        if (losPicked) {
          landingInfo.los_cell_picked = { x: losPicked.cx, y: losPicked.cy, z: losPicked.cz };
        }
        if (reachability) Object.assign(landingInfo, reachability);
        if (yAdjusted) landingInfo.y_adjusted = yAdjusted;
        const reachNote = reachability && !reachability.walkable_to_target && reachability.next_hop_suggestion
          ? ` — can't reach target from here; try mc goto_near ${reachability.next_hop_suggestion.x} ${reachability.next_hop_suggestion.y} ${reachability.next_hop_suggestion.z} range=1`
          : '';
        landingInfo.end_position = endPos;
        if (fellBy >= 4) landingInfo.fell_by_blocks = fellBy;
        return {
          result: `${fellWarning}Arrived near ${fmt(x)}, ${fmt(y)}, ${fmt(z)}${yAdjNote}${note}${reachNote}`,
          observed_state: landingInfo,
        };
      }
      if (losPicked) {
        const obs = { los_cell_picked: { x: losPicked.cx, y: losPicked.cy, z: losPicked.cz }, end_position: endPos };
        if (fellBy >= 4) obs.fell_by_blocks = fellBy;
        if (reachability) Object.assign(obs, reachability);
        if (yAdjusted) obs.y_adjusted = yAdjusted;
        const reachNote = reachability && !reachability.walkable_to_target && reachability.next_hop_suggestion
          ? ` — can't reach target from here; try mc goto_near ${reachability.next_hop_suggestion.x} ${reachability.next_hop_suggestion.y} ${reachability.next_hop_suggestion.z} range=1`
          : '';
        return {
          result: `${fellWarning}Arrived at LOS cell ${losPicked.cx}, ${losPicked.cy}, ${losPicked.cz} (clear sight to target ${fmt(x)}, ${fmt(y)}, ${fmt(z)})${yAdjNote}${reachNote}`,
          observed_state: obs,
        };
      }
      const reachNote = reachability && !reachability.walkable_to_target && reachability.next_hop_suggestion
        ? ` — can't reach target from here; try mc goto_near ${reachability.next_hop_suggestion.x} ${reachability.next_hop_suggestion.y} ${reachability.next_hop_suggestion.z} range=1`
        : '';
      const obs = reachability ? { ...reachability } : {};
      obs.end_position = endPos;
      if (fellBy >= 4) obs.fell_by_blocks = fellBy;
      if (yAdjusted) obs.y_adjusted = yAdjusted;
      return ok({
        result: `${fellWarning}Arrived near ${fmt(x)}, ${fmt(y)}, ${fmt(z)}${yAdjNote}${reachNote}`,
        data: obs,
        observed_state: obs,
      });
    } catch (e) {
      try { b.pathfinder.setGoal(null); } catch {}
      if (e instanceof NoProgressError) {
        recordMoveFailure('goto_near', x, y, z, posObj(), 'no_progress');
        pushStuckCell(e.info?.stalled_position, 'no_progress');
        const reach = computeReachability(b, { x, y, z }, 144);
        const hopNote = reach && !reach.walkable_to_target && reach.next_hop_suggestion
          ? ` Try mc goto_near ${reach.next_hop_suggestion.x} ${reach.next_hop_suggestion.y} ${reach.next_hop_suggestion.z} range=1 to route around the obstacle.`
          : ' Try mc escape, mc dig at the blocker, or use mc goto_near with different coords.';
        const obs = enrichWithStand(b, { target: { x, y, z }, range, current: posObj(), ...e.info, pathfinder_error: `no_progress:${e.info?.no_progress_for_ms || '?'}ms` }, x, y, z);
        if (reach) Object.assign(obs, reach);
        const stallFail = {
          ok: false,
          error: {
            code: 'NAV_NO_PROGRESS',
            message: `Pathfinder stalled — bot stopped moving for ${e.info?.no_progress_for_ms}ms while heading to ${fmt(x)},${fmt(y)},${fmt(z)} (range ${range}). Likely a 1-block lip, wedge, or sealed route.${hopNote}`,
            observed_state: obs,
            next_action_hint: navBlockedNextActionHint(b, { x, y, z }, posObj(), { observedState: obs }),
            retry_safe: false,
          },
        };
        return withNavRetryWarning(stallFail, retryKey, gotoRetryCounts, GOTO_RETRY_LIMIT);
      }
      if (e instanceof OperationTimeoutError) {
        recordMoveFailure('goto_near', x, y, z, posObj(), 'wallclock_timeout');
        return timeoutError('goto_near', ACTION_CAPS_MS.goto_near,
          enrichWithStand(b, { target: { x, y, z }, current: posObj(), range, pathfinder_error: 'timeout' }, x, y, z),
          `Pathfinder didn't finish in time. If observed_state.closest_standable is set, retry mc goto_near with those coords.`);
      }
      const pos = posObj();
      recordMoveFailure('goto_near', x, y, z, pos, 'pathfinder_error');
      return withNavRetryWarning(
        navFailureError(b, pos, x, y, z, e?.message || String(e)),
        retryKey,
        gotoRetryCounts,
        GOTO_RETRY_LIMIT,
      );
    }
  };
}
