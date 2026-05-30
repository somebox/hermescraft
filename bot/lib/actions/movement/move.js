/** @size-exempt: move shares door-assist navigation */
import { Vec3 } from 'vec3';
import {
  pathfindWithProgressWatchdog,
  ACTION_CAPS_MS,
  OperationTimeoutError,
  NoProgressError,
} from '../_helpers.js';

import { enrichWithStand } from './_preflight.js';
import { isDetourAllowed, detourHintForDy } from './detour-check.js';
import { coord3 } from '../_args.js';
import { recordNavBriefNegativeLeg, navBriefLineKey } from '../../runtime/nav-brief.js';

function noteBriefMoveFailure(ctx, markName) {
  const name = markName ? String(markName).replace(/^@/, '').trim() : '';
  if (!name || !ctx) return;
  recordNavBriefNegativeLeg(ctx, navBriefLineKey({ verb: 'move', args: name }));
}

/**
 * Compute the {near_side, far_side} cells used by `mc through` when
 * traversing a door at `doorPos` toward `target`.
 *
 * The near_side is the cell the bot must reach to be in range to activate
 * the door; the far_side is what gets passed to `mc through` as its
 * destination (it determines `b.lookAt` and the forward-walk direction).
 *
 * Y-component fix (2026-05-26): the previous version used `target.y` for
 * both sides. When the door is at a different Y than the target — e.g.
 * an underground rescue door at Y=59 between bot and a surface target at
 * Y=65 — the far_side ended up 6 blocks ABOVE the door. `mc through`
 * called `b.lookAt(farSide)`, which pitched the bot's view sharply
 * upward; `setControlState('forward')` then translated to almost-zero
 * XZ velocity, and the bot stalled touching the doorframe ("Opened door
 * but bot stalled at X,Y,Z" — 26 such failures observed in the
 * 2026-05-26 hut1 supply run, all targeting the underground door at
 * (370,59,-591)). Using the door's own Y for both sides keeps the
 * traversal vector horizontal regardless of the surface target's
 * altitude. The leg loop in `move()` will resume vertical-axis routing
 * from the door's far side on the next iteration.
 */
export function computeDoorSides(doorPos, target) {
  const ddx = target.x - doorPos.x;
  const ddz = target.z - doorPos.z;
  if (Math.abs(ddx) >= Math.abs(ddz)) {
    const dir = Math.sign(ddx || 1);
    return {
      far_side: new Vec3(doorPos.x + dir * 2, doorPos.y, doorPos.z),
      near_side: new Vec3(doorPos.x - dir * 2, doorPos.y, doorPos.z),
      axis: 'x',
      dir,
    };
  }
  const dir = Math.sign(ddz || 1);
  return {
    far_side: new Vec3(doorPos.x, doorPos.y, doorPos.z + dir * 2),
    near_side: new Vec3(doorPos.x, doorPos.y, doorPos.z - dir * 2),
    axis: 'z',
    dir,
  };
}

/**
 * Build the success-message + `moved` flag for a completed move.
 *
 * Distinguishes "actually walked to the target" from "was already within the
 * arrival tolerance and never moved". The pathfinder returns immediately when
 * the (possibly y-/target-adjusted) goal is already within 2 blocks of the
 * bot, so without this the bot would claim "Arrived at <target>" while sitting
 * still — hiding from the agent that no travel happened and pointing it at the
 * requested coords rather than where it actually is.
 *
 * @param {{ startPos: {x:number,y:number,z:number}, finalPos: {x:number,y:number,z:number}, target: {x:number,y:number,z:number}, doorsUsed?: number, fmt?: (n:number)=>string, suffix?: string }} args
 * @returns {{ moved: boolean, text: string }}
 */
export function describeMoveOutcome({ startPos, finalPos, target, doorsUsed = 0, fmt = (n) => String(Math.round(Number(n))), suffix = '' }) {
  const moved =
    Math.floor(startPos.x) !== Math.floor(finalPos.x)
    || Math.floor(startPos.y) !== Math.floor(finalPos.y)
    || Math.floor(startPos.z) !== Math.floor(finalPos.z);
  const doorsNote = doorsUsed ? ` via ${doorsUsed} door${doorsUsed > 1 ? 's' : ''}` : '';
  const text = moved
    ? `Arrived at ${fmt(target.x)}, ${fmt(target.y)}, ${fmt(target.z)}${doorsNote}${suffix}`
    : `Already within range of ${fmt(target.x)}, ${fmt(target.y)}, ${fmt(target.z)} — did not move (still at ${fmt(finalPos.x)}, ${fmt(finalPos.y)}, ${fmt(finalPos.z)})${doorsNote}${suffix}`;
  return { moved, text };
}

/**
 * @param {object} deps
 */
export function createMove(deps) {
  const {
    ensureBot,
    goals,
    gotoRetryKey,
    gotoRetryCounts,
    GOTO_RETRY_LIMIT,
    ACTIONS,
    recordMoveFailure,
    clearMoveFailure,
    clearGotoRetry,
    pushStuckCell,
    preflightNav,
    preNudgeIfSticky,
    fmt,
    posObj,
    loadLocations,
    config,
    services,
  } = deps;

  return async function move(args) {
    if (args?.mark && typeof loadLocations === 'function') {
      const name = String(args.mark).replace(/^@/, '').trim();
      const loc = loadLocations()[name];
      if (!loc || !Number.isFinite(loc.x)) {
        return {
          ok: false,
          error: { code: 'MARK_NOT_FOUND', message: `No location '${name}'`, retry_safe: false },
        };
      }
      args = { ...args, x: loc.x, y: loc.y, z: loc.z, mark: name };
    }
    if (args?.raw === true && config?.behaviors?.navMoveResolve === true) {
      const { services } = deps;
      const nav = services?.getActions?.()?.navigateToTarget;
      if (typeof nav === 'function') {
        return nav({
          x: args.x,
          y: args.y,
          z: args.z,
          near: args.near,
          raw: true,
          force: args.force,
          mark: args.mark,
        });
      }
    }
    const c = coord3(args);
    if (!c.ok) return c.response;
    let { x, y, z } = c;
    const b = ensureBot();
    // Snapshot where the command started so the success message can tell
    // "actually walked there" apart from "was already in range, never moved"
    // — the latter must not claim "Arrived at <target>" while sitting still.
    const startPos = posObj();
    const max_doors = args.max_doors;
    const door = args.door;
    const moveRetryKey = gotoRetryKey('move', x, y, z);
    const movePriorRetry = gotoRetryCounts.get(moveRetryKey);
    if (movePriorRetry && movePriorRetry.count >= GOTO_RETRY_LIMIT) {
      return {
        ok: false,
        error: {
          code: 'NAV_RETRY_LOOP',
          message: `${movePriorRetry.count} consecutive mc move calls to (${Math.floor(Number(x))}, ${Math.floor(Number(y))}, ${Math.floor(Number(z))}) have failed (last reason: ${movePriorRetry.lastReason}). Pick a different target — try an adjacent waypoint, mc advise, or mc scene to reassess. Retrying the same coord will not work.`,
          observed_state: {
            retry_count: movePriorRetry.count,
            last_reason: movePriorRetry.lastReason,
            target: { x: Math.floor(Number(x)), y: Math.floor(Number(y)), z: Math.floor(Number(z)) },
          },
          next_action_hint: 'mc advise --reason="mc move stuck retrying"',
          retry_safe: false,
        },
      };
    }
    const pre = preflightNav(b, x, y, z, 1);
    if (pre && (pre.error || pre.ok === false)) {
      recordMoveFailure('move', x, y, z, posObj(), pre.error?.code || 'preflight');
      return pre;
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
    await preNudgeIfSticky(b, Math.floor(Number(x)), Math.floor(Number(y)), Math.floor(Number(z)));
    const target = { x: Number(x), y: Number(y), z: Number(z) };
    const maxDoors = Math.min(Math.max(parseInt(String(max_doors ?? 5), 10) || 5, 1), 10);

    const isPassable = (name) =>
      (/(_door|_fence_gate)$/.test(name)) && !name.startsWith('iron_') && !name.endsWith('_trapdoor');

    // Connectivity precheck: confirm pathfinder can actually reach a
    // door's near_side. Catches the "distant unreachable door" pattern
    // — bot at (326,60,-618) was repeatedly picking a door at
    // (370,59,-591) 52m away because findBlocks(64) surfaced it, even
    // though pathfinder couldn't route to it. Without this check the
    // bot wastes 8-30s of the reach cap on a doomed approach. Uses
    // getPathTo (no movement) with a tight 1500ms compute cap.
    const isDoorReachable = (nearSide) => {
      try {
        const movements = b.pathfinder?.movements;
        if (!movements) return true; // movements not yet bound — assume yes
        const checkGoal = new goals.GoalNear(
          Math.floor(nearSide.x),
          Math.floor(nearSide.y),
          Math.floor(nearSide.z),
          2,
        );
        const r = b.pathfinder.getPathTo(movements, checkGoal, 1500);
        return r && r.status === 'success' && Array.isArray(r.path);
      } catch {
        return true; // precheck never blocks on its own errors
      }
    };

    const findBestDoor = (maxDistance = 32, excludeKeys = null) => {
      const me = b.entity.position;
      const targetVec = new Vec3(target.x, target.y, target.z);
      const myDist = me.distanceTo(targetVec);
      const positions = b.findBlocks({
        matching: (block) => isPassable(block.name),
        maxDistance,
        count: 30,
      });
      // Two-pass: score all viable candidates, then reachability-precheck
      // them in score order. Returns the first reachable candidate; falls
      // back to the highest-scoring candidate even if unreachable (so the
      // existing "Could not traverse" error path still fires with the
      // most plausible door, not nothing).
      /** @type {Array<{pos:any, block:string, near_side:Vec3, far_side:Vec3, near_dist:number, far_dist:number, _score:number}>} */
      const candidates = [];
      for (const dPos of positions) {
        const dBlock = b.blockAt(dPos);
        if (!dBlock) continue;
        const props = (typeof dBlock.getProperties === 'function') ? dBlock.getProperties() : {};
        if (props.half === 'upper') continue;
        const key = `${dPos.x},${dPos.y},${dPos.z}`;
        if (excludeKeys && excludeKeys.has(key)) continue;
        const { far_side: farSide, near_side: nearSide } = computeDoorSides(dPos, target);
        const farDist = farSide.distanceTo(targetVec);
        if (farDist >= myDist - 0.5) continue;
        const nearDist = me.distanceTo(nearSide);
        candidates.push({
          pos: dPos,
          block: dBlock.name,
          near_side: nearSide,
          far_side: farSide,
          near_dist: nearDist,
          far_dist: farDist,
          _score: nearDist,
        });
      }
      if (candidates.length === 0) return null;
      candidates.sort((a, c) => a._score - c._score);
      // Precheck top-3 by score — capped to avoid spending more than ~5s
      // total on connectivity checks even when many candidates exist.
      // If NONE of the top-3 is reachable, return null so the caller
      // emits the clean "no door/gate between to use" error (with its
      // tunnel/dig_area hint) instead of burning 8-30s of the reach
      // cap on a doomed approach. The findBlocks-scan candidates that
      // were rejected here still appear in `nearby_doors` in the
      // failure envelope, so the agent retains full visibility.
      const PRECHECK_CAP = 3;
      for (let i = 0; i < Math.min(PRECHECK_CAP, candidates.length); i++) {
        if (isDoorReachable(candidates[i].near_side)) {
          return candidates[i];
        }
      }
      return null;
    };

    const nearbyDoorList = (maxDistance = 32) =>
      b.findBlocks({
        matching: (block) => isPassable(block.name),
        maxDistance,
        count: 8,
      }).map((p) => {
        const blk = b.blockAt(p);
        const props = (typeof blk?.getProperties === 'function') ? blk.getProperties() : {};
        return { x: p.x, y: p.y, z: p.z, block: blk?.name || 'unknown', open: props.open === 'true' || props.open === true };
      }).filter((d) => {
        const blk = b.blockAt(new Vec3(d.x, d.y, d.z));
        const props = (typeof blk?.getProperties === 'function') ? blk.getProperties() : {};
        return props.half !== 'upper';
      });

    const doors_used = [];
    let lastPathfinderError = null;

    // Detour sanity check (one-shot, before any goto).
    //
    // Observed 2026-05-25: flint at (378,58,-597) underground asked to move to
    // (378,46,-600) — 12 blocks DOWN, 3 south. Pathfinder couldn't find a
    // direct down-path through solid stone, so it routed UP the existing stair,
    // across surface, back down somewhere else — ~50 blocks of travel for a
    // 12-block goal. Bot died to mobs on the way. The LLM saw an HTTP timeout
    // and had no idea the bot had respawned at world spawn.
    //
    // Fix: pre-compute the path with `getPathTo` (doesn't execute), compare to
    // straight-line distance, refuse if detour exceeds max(straight * 3.5,
    // straight + 25). The error envelope tells the worker the actual path
    // length and suggests the right primitive (tunnel/stair_down) when the
    // target is below them. `force: true` bypasses the check for cases where
    // the long route is genuinely intended.
    const force = args.force === true || args.force === 'true' || args.force === 1;
    {
      const myPos = b.entity.position;
      const dx = target.x - myPos.x;
      const dy = target.y - myPos.y;
      const dz = target.z - myPos.z;
      const straightLine = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (straightLine >= 5 && !force) {
        let pathCheck = null;
        try {
          const checkGoal = new goals.GoalBlock(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z));
          pathCheck = b.pathfinder.getPathTo(b.pathfinder.movements, checkGoal, 3000);
        } catch { /* if precheck fails, fall through and let goto try */ }

        if (pathCheck && pathCheck.status === 'success' && pathCheck.path) {
          const pathLength = pathCheck.path.length;
          if (!isDetourAllowed(straightLine, pathLength, dy)) {
            const ratio = pathLength / Math.max(straightLine, 1);
            const hint = detourHintForDy(dy);
            recordMoveFailure('move', target.x, target.y, target.z, posObj(), 'detour_too_long');
            return {
              ok: false,
              error: {
                code: 'NAV_DETOUR_TOO_LONG',
                message: `No direct route to ${fmt(target.x)},${fmt(target.y)},${fmt(target.z)} — shortest path pathfinder found is ${pathLength} blocks but straight-line is only ${straightLine.toFixed(0)}m (${ratio.toFixed(1)}x detour). ${hint} To force the long route anyway, append --force.`,
                observed_state: {
                  current: { x: myPos.x, y: myPos.y, z: myPos.z },
                  target,
                  straight_line_distance: Math.round(straightLine),
                  actual_path_length: pathLength,
                  detour_ratio: parseFloat(ratio.toFixed(2)),
                  max_allowed_ratio: 3.5,
                  dy: Math.round(dy),
                },
                next_action_hint: hint,
                retry_safe: false,
              },
            };
          }
        }
      }
    }

    for (let leg = 1; leg <= maxDoors + 1; leg++) {
      const goal = new goals.GoalBlock(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z));
      try {
        await pathfindWithProgressWatchdog({
          bot: b,
          pathfinderGoto: () => b.pathfinder.goto(goal),
          onStall: () => { try { b.pathfinder.setGoal(null); } catch {} },
          opName: 'move',
          capMs: ACTION_CAPS_MS.move,
        });
      } catch (e) {
        if (e instanceof NoProgressError) {
          lastPathfinderError = `no_progress:${e.info?.no_progress_for_ms || '?'}ms`;
          pushStuckCell(e.info?.stalled_position, 'no_progress');
        } else if (e instanceof OperationTimeoutError) lastPathfinderError = 'timeout';
        else lastPathfinderError = e?.message || String(e);
        try { b.pathfinder.setGoal(null); } catch {}
      }

      const pos = posObj();
      const dist = Math.hypot(pos.x - target.x, pos.y - target.y, pos.z - target.z);
      if (dist <= 2) {
        clearMoveFailure();
        clearGotoRetry('move', target.x, target.y, target.z);
        let autoEscape = null;
        if (b.entity?.isInWater) {
          try {
            const esc = await ACTIONS.escape({});
            const endPos = posObj();
            autoEscape = {
              ok: !!esc?.ok,
              from: pos,
              to: endPos,
              ...(esc?.data ? { details: esc.data } : {}),
            };
          } catch (e) {
            autoEscape = { ok: false, from: pos, to: posObj(), error: e?.message || String(e) };
          }
        }
        const finalPos = autoEscape ? autoEscape.to : pos;
        const yAdjNote = yAdjusted
          ? ` (y adjusted from ${yAdjusted.from} to ${yAdjusted.to}, Δ=${yAdjusted.dy >= 0 ? '+' : ''}${yAdjusted.dy} — original Y was ${yAdjusted.reason})`
          : '';
        const escapeNote = autoEscape
          ? ` (auto-escaped from water to ${finalPos.x.toFixed(1)},${finalPos.y.toFixed(1)},${finalPos.z.toFixed(1)})`
          : '';
        const { moved: movedCells, text: result } = describeMoveOutcome({
          startPos,
          finalPos,
          target,
          doorsUsed: doors_used.length,
          fmt,
          suffix: `${yAdjNote}${escapeNote}`,
        });
        return {
          ok: true,
          data: {
            doors_used,
            legs: leg,
            end_position: finalPos,
            start_position: startPos,
            moved: movedCells,
            ...(yAdjusted ? { y_adjusted: yAdjusted } : {}),
            ...(targetAdjusted ? { target_adjusted: targetAdjusted } : {}),
            ...(autoEscape ? { auto_escape: autoEscape, adjusted_target: { x: Math.floor(finalPos.x), y: Math.floor(finalPos.y), z: Math.floor(finalPos.z), original: { x: target.x, y: target.y, z: target.z } } } : {}),
          },
          result,
        };
      }

      let chosen;
      if (leg === 1 && door && Number.isFinite(Number(door.x)) && Number.isFinite(Number(door.y)) && Number.isFinite(Number(door.z))) {
        const dPos = new Vec3(Number(door.x), Number(door.y), Number(door.z));
        const dBlock = b.blockAt(dPos);
        if (!dBlock || !isPassable(dBlock.name)) {
          return {
            ok: false,
            error: {
              code: 'NAV_BLOCKED',
              message: `--door at ${door.x},${door.y},${door.z} is not a passable door/gate (block: ${dBlock?.name || 'unknown'})`,
              observed_state: { current: pos, target, doors_used, requested_door: door },
              retry_safe: false,
            },
          };
        }
        const { far_side: farSide } = computeDoorSides(dPos, target);
        chosen = { pos: dPos, block: dBlock.name, far_side: farSide };
      } else {
        chosen = findBestDoor(32);
        if (!chosen) chosen = findBestDoor(64);
      }

      if (!chosen) {
        recordMoveFailure('move', target.x, target.y, target.z, pos, lastPathfinderError || 'no_door');
        noteBriefMoveFailure(ctx, args.mark);
        const doorList = (() => {
          const near = nearbyDoorList(32);
          return near.length > 0 ? near : nearbyDoorList(64);
        })();
        const botInWater = !!b.entity.isInWater;
        let extraHint = ' Use mc tunnel or mc dig_area to clear terrain explicitly.';
        if (botInWater) {
          extraHint = ' You are in water — call `mc escape` to swim to the nearest shore before retrying navigation.';
        }
        return {
          ok: false,
          error: {
            code: 'NAV_BLOCKED',
            message: `No path to ${fmt(target.x)},${fmt(target.y)},${fmt(target.z)} from ${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)} and no door/gate between to use.${extraHint}`,
            observed_state: enrichWithStand(b, { current: pos, target, doors_used, nearby_doors: doorList, pathfinder_error: lastPathfinderError, in_water: botInWater }, target.x, target.y, target.z),
            retry_safe: false,
          },
        };
      }

      const through = await ACTIONS.through({
        gx: chosen.pos.x, gy: chosen.pos.y, gz: chosen.pos.z,
        dx: chosen.far_side.x, dy: chosen.far_side.y, dz: chosen.far_side.z,
      });

      if (!through.ok) {
        return {
          ok: false,
          error: {
            code: 'NAV_BLOCKED',
            message: `Could not traverse ${chosen.block} at ${chosen.pos.x},${chosen.pos.y},${chosen.pos.z}: ${through.error?.message || 'through failed'}`,
            observed_state: enrichWithStand(b, { current: posObj(), target, doors_used, failed_door: { x: chosen.pos.x, y: chosen.pos.y, z: chosen.pos.z, block: chosen.block }, through_error: through.error }, target.x, target.y, target.z),
            retry_safe: through.error?.retry_safe ?? false,
          },
        };
      }

      doors_used.push({
        x: chosen.pos.x, y: chosen.pos.y, z: chosen.pos.z,
        block: chosen.block,
        closed: through.data?.closed ?? false,
      });
    }

    noteBriefMoveFailure(ctx, args.mark);
    return {
      ok: false,
      error: {
        code: 'TOO_MANY_DOORS',
        message: `Used max ${maxDoors} doors without reaching ${fmt(target.x)},${fmt(target.y)},${fmt(target.z)}. Building may have a routing loop or be too complex; try mc move --door X Y Z to pick a specific door.`,
        observed_state: enrichWithStand(b, { doors_used, target, current: posObj() }, target.x, target.y, target.z),
        retry_safe: false,
      },
    };
  };
}
