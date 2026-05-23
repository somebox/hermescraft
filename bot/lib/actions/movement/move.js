/** @size-exempt: move shares door-assist navigation */
import { Vec3 } from 'vec3';
import {
  pathfindWithProgressWatchdog,
  ACTION_CAPS_MS,
  OperationTimeoutError,
  NoProgressError,
} from '../_helpers.js';

import { enrichWithStand } from './_preflight.js';
import { coord3 } from '../_args.js';

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
  } = deps;

  return async function move(args) {
    const c = coord3(args);
    if (!c.ok) return c.response;
    const { x, y, z } = c;
    const b = ensureBot();
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

    const findBestDoor = (maxDistance = 32) => {
      const me = b.entity.position;
      const targetVec = new Vec3(target.x, target.y, target.z);
      const myDist = me.distanceTo(targetVec);
      const positions = b.findBlocks({
        matching: (block) => isPassable(block.name),
        maxDistance,
        count: 30,
      });
      let best = null;
      let bestScore = Infinity;
      for (const dPos of positions) {
        const dBlock = b.blockAt(dPos);
        if (!dBlock) continue;
        const props = (typeof dBlock.getProperties === 'function') ? dBlock.getProperties() : {};
        if (props.half === 'upper') continue;
        const ddx = target.x - dPos.x;
        const ddz = target.z - dPos.z;
        let farSide, nearSide;
        if (Math.abs(ddx) >= Math.abs(ddz)) {
          const dir = Math.sign(ddx || 1);
          farSide = new Vec3(dPos.x + dir * 2, target.y, dPos.z);
          nearSide = new Vec3(dPos.x - dir * 2, target.y, dPos.z);
        } else {
          const dir = Math.sign(ddz || 1);
          farSide = new Vec3(dPos.x, target.y, dPos.z + dir * 2);
          nearSide = new Vec3(dPos.x, target.y, dPos.z - dir * 2);
        }
        const farDist = farSide.distanceTo(targetVec);
        if (farDist >= myDist - 0.5) continue;
        const nearDist = me.distanceTo(nearSide);
        if (nearDist < bestScore) {
          bestScore = nearDist;
          best = { pos: dPos, block: dBlock.name, near_side: nearSide, far_side: farSide, near_dist: nearDist, far_dist: farDist };
        }
      }
      return best;
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
        return {
          ok: true,
          data: {
            doors_used,
            legs: leg,
            end_position: finalPos,
            ...(yAdjusted ? { y_adjusted: yAdjusted } : {}),
            ...(targetAdjusted ? { target_adjusted: targetAdjusted } : {}),
            ...(autoEscape ? { auto_escape: autoEscape, adjusted_target: { x: Math.floor(finalPos.x), y: Math.floor(finalPos.y), z: Math.floor(finalPos.z), original: { x: target.x, y: target.y, z: target.z } } } : {}),
          },
          result: `Arrived at ${fmt(target.x)}, ${fmt(target.y)}, ${fmt(target.z)}${doors_used.length ? ` via ${doors_used.length} door${doors_used.length > 1 ? 's' : ''}` : ''}${yAdjNote}${escapeNote}`,
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
        const ddx = target.x - dPos.x;
        const ddz = target.z - dPos.z;
        const farSide = (Math.abs(ddx) >= Math.abs(ddz))
          ? new Vec3(dPos.x + Math.sign(ddx || 1) * 2, target.y, dPos.z)
          : new Vec3(dPos.x, target.y, dPos.z + Math.sign(ddz || 1) * 2);
        chosen = { pos: dPos, block: dBlock.name, far_side: farSide };
      } else {
        chosen = findBestDoor(32);
        if (!chosen) chosen = findBestDoor(64);
      }

      if (!chosen) {
        recordMoveFailure('move', target.x, target.y, target.z, pos, lastPathfinderError || 'no_door');
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
