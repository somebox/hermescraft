/** sail_to execution: sail branches, mount safety, disembark, walk_to_target, success. */

import { pathfindGotoNear } from '../../_helpers.js';
import { fail, ok } from '../../../shared/action-contract.js';

export async function runSailExecution(bindings, diag, state, planCtx) {
  const {
    ensureBot,
    ACTIONS,
    goals,
    sleep,
    pathfindWithProgressWatchdog,
    ACTION_CAPS_MS,
    Vec3,
  } = bindings;
  const { sailLog, fmtPos, blockName, fmtFootHead } = diag;

  const b = ensureBot();
  const { target, phases, startPos, startedAt } = state;
  const {
    route,
    legs,
    sailLegs,
    currentlyMounted,
    botInWater,
    swimmingOnSurface,
    botFootPos,
  } = planCtx;

  if (currentlyMounted) {
    phases.push('sail');
    try {
      const legsRes = await sailLegs(legs);
      if (!legsRes.ok) {
                return fail('SAIL_FAILED', `Resume-sail failed on leg ${legsRes.leg_index + 1}/${legs.length} (waypoint ${legsRes.waypoint.x},${legsRes.waypoint.y},${legsRes.waypoint.z}): ${legsRes.inner_error?.message || 'unknown'}. Call mc sail_to ${target.x} ${target.y} ${target.z} again to re-plan from here.`, {
          observed_state: { sail_error: legsRes.inner_error, leg_index: legsRes.leg_index, waypoint: legsRes.waypoint, route },
          next_action_hint: `mc sail_to ${target.x} ${target.y} ${target.z}`,
          retry_safe: true,
        });
      }
    } catch (e) {
              return fail('SAIL_FAILED', `Resume-sail threw: ${e?.message || e}`, { retry_safe: true });
    }
  } else if (botInWater) {
    phases.push('in_water_rescue', 'mount');
    const rescueWaterPos = swimmingOnSurface
      ? new Vec3(botFootPos.x, botFootPos.y - 1, botFootPos.z)
      : botFootPos;
    try {
      const placeRes = await ACTIONS.place_boat({
        x: rescueWaterPos.x,
        y: rescueWaterPos.y,
        z: rescueWaterPos.z,
        _from_sail_to: true,
        _rescue_from_water: true,
      });
      if (!placeRes?.ok) {
                return fail('RESCUE_PLACE_FAILED', `In-water rescue: place_boat at current foot (${botFootPos.x}, ${botFootPos.y}, ${botFootPos.z}) failed: ${placeRes?.error?.message || 'place_boat refused'}. Bot is stranded in water; try mc escape or chat for help.`, {
          observed_state: { place_boat_error: placeRes?.error, bot_foot: botFootPos, route },
          next_action_hint: 'mc escape   # try non-boat water escape first',
          retry_safe: true,
        });
      }
      const boardRes = await ACTIONS.board({ _from_sail_to: true });
      if (!boardRes?.ok) {
                return fail('RESCUE_MOUNT_FAILED', `In-water rescue: boat placed at (${botFootPos.x}, ${botFootPos.y}, ${botFootPos.z}) but board failed: ${boardRes?.error?.message || 'board refused'}. Re-call mc sail_to ${target.x} ${target.y} ${target.z} to retry from here.`, {
          observed_state: { board_error: boardRes?.error, bot_foot: botFootPos, route },
          next_action_hint: `mc sail_to ${target.x} ${target.y} ${target.z}`,
          retry_safe: true,
        });
      }
    } catch (e) {
              return fail('RESCUE_MOUNT_FAILED', `In-water rescue threw: ${e?.message || e}`, { retry_safe: true });
    }

    phases.push('sail');
    try {
      const legsRes = await sailLegs(legs);
      if (!legsRes.ok) {
                return fail('SAIL_FAILED', `Rescue-sail failed on leg ${legsRes.leg_index + 1}/${legs.length} (waypoint ${legsRes.waypoint.x},${legsRes.waypoint.y},${legsRes.waypoint.z}): ${legsRes.inner_error?.message || 'unknown'}. Re-call mc sail_to ${target.x} ${target.y} ${target.z}.`, {
          observed_state: { sail_error: legsRes.inner_error, leg_index: legsRes.leg_index, waypoint: legsRes.waypoint, route },
          next_action_hint: `mc sail_to ${target.x} ${target.y} ${target.z}`,
          retry_safe: true,
        });
      }
    } catch (e) {
              return fail('SAIL_FAILED', `Rescue-sail threw: ${e?.message || e}`, { retry_safe: true });
    }
  } else {
    phases.push('walk_to_entry');
    sailLog('walk_to_entry start',
      `entry_shore=${fmtPos(route.entry_shore)}`,
      `bot=${fmtPos(b.entity.position)}`,
    );
    try {
      const entry = route.entry_shore;
      await pathfindWithProgressWatchdog({
        bot: b,
        pathfinderGoto: () => b.pathfinder.goto(new goals.GoalNear(entry.x, entry.y, entry.z, 1)),
        onStall: () => { try { b.pathfinder.setGoal(null); } catch {} },
        opName: 'walk_to_entry',
        capMs: ACTION_CAPS_MS.goto_near,
      });
      sailLog('walk_to_entry done',
        `bot=${fmtPos(b.entity.position)}`,
        fmtFootHead(b.entity.position.floored()),
      );
    } catch (e) {
      sailLog('walk_to_entry FAILED',
        `bot=${fmtPos(b.entity.position)}`,
        `reason=${e?.message || e}`,
      );
              return fail('WALK_TO_ENTRY_FAILED', `Could not walk to entry shore at (${route.entry_shore.x}, ${route.entry_shore.y}, ${route.entry_shore.z}): ${e?.message || e}`, {
          observed_state: { entry_shore: route.entry_shore, route },
          next_action_hint: `mc bg_goto ${route.entry_shore.x} ${route.entry_shore.y} ${route.entry_shore.z}`,
          retry_safe: true,
        });
    }

    try {
      const footPos = b.entity.position.floored();
      const footBlock = b.blockAt(footPos);
      if (footBlock && (footBlock.name === 'water' || footBlock.name === 'flowing_water')) {
                return fail('WALK_TO_ENTRY_DROPPED_IN_WATER', `walk_to_entry's pathfinder routed bot through water and left it submerged at (${footPos.x}, ${footPos.y}, ${footPos.z}) instead of on the entry shore at (${route.entry_shore.x}, ${route.entry_shore.y}, ${route.entry_shore.z}). Cannot place a boat from-water cleanly. Escape water first; re-call sail_to and the BFS will pick a different entry shore from your new position.`, {
          observed_state: {
              bot_foot: { x: footPos.x, y: footPos.y, z: footPos.z },
              foot_block: footBlock.name,
              intended_entry_shore: route.entry_shore,
            },
          next_action_hint: 'mc escape',
          retry_safe: true,
        });
      }
    } catch {
      // blockAt threw — chunk unloaded or transient. Proceed; the
      // mount phase will surface the real error if there is one.
    }

    phases.push('mount');
    sailLog('mount start',
      `entry_water=${fmtPos(route.entry_water)}`,
      `entry_water_ctx=${fmtFootHead(route.entry_water)}`,
      `bot=${fmtPos(b.entity.position)}`,
    );
    try {
      const placeRes = await ACTIONS.place_boat({
        x: route.entry_water.x,
        y: route.entry_water.y,
        z: route.entry_water.z,
        _from_sail_to: true,
      });
      if (!placeRes?.ok) {
        sailLog('mount FAILED', `phase=place_boat`, `error=${placeRes?.error?.code || 'unknown'}`);
                return fail('MOUNT_FAILED', `Could not place boat at entry_water (${route.entry_water.x}, ${route.entry_water.y}, ${route.entry_water.z}): ${placeRes?.error?.message || 'place_boat failed'}`, {
          observed_state: { place_boat_error: placeRes?.error, route },
          retry_safe: true,
        });
      }
      const placedAt = Array.isArray(placeRes?.data?.boat_position)
        ? { x: placeRes.data.boat_position[0], y: placeRes.data.boat_position[1], z: placeRes.data.boat_position[2] }
        : null;
      if (placedAt) {
        const riderFootName = blockName(placedAt.x, placedAt.y + 1, placedAt.z);
        const riderHeadName = blockName(placedAt.x, placedAt.y + 2, placedAt.z);
        const isAirish = (n) => n === 'air' || n === 'cave_air' || n === 'void_air';
        const isAirOrWater = (n) => isAirish(n) || n === 'water' || n === 'flowing_water';
        if (!isAirOrWater(riderFootName) || !isAirish(riderHeadName)) {
          sailLog('mount FAILED', `phase=placement_unsafe`,
            `boat=${fmtPos(placedAt)}`,
            `rider_foot_block=${riderFootName}`,
            `rider_head_block=${riderHeadName}`,
          );
          try {
            await ACTIONS.disembark({ emergency: true });
          } catch { /* best-effort cleanup */ }
                  return fail('BOAT_PLACEMENT_UNSAFE', `Boat landed at (${placedAt.x}, ${placedAt.y}, ${placedAt.z}) but the rider position is obstructed: foot=${riderFootName}, head=${riderHeadName}. Mounting here would suffocate the bot. Move to a different shore stance and re-call sail_to from there.`, {
          observed_state: {
                boat_position: placedAt,
                rider_foot_block: riderFootName,
                rider_head_block: riderHeadName,
                route,
              },
          next_action_hint: `mc bg_goto ${route.entry_shore.x} ${route.entry_shore.y} ${route.entry_shore.z}  # try a different shore stance`,
          retry_safe: true,
        });
        }
      }
      const boardRes = await ACTIONS.board({ _from_sail_to: true });
      if (!boardRes?.ok) {
        sailLog('mount FAILED', `phase=board`, `error=${boardRes?.error?.code || 'unknown'}`);
                return fail('MOUNT_FAILED', `Boat placed at (${route.entry_water.x}, ${route.entry_water.y}, ${route.entry_water.z}) but mount failed: ${boardRes?.error?.message || 'board failed'}`, {
          observed_state: { board_error: boardRes?.error, place_data: placeRes.data, route },
          retry_safe: true,
        });
      }
      await sleep(150);
      const boatPos = b.vehicle?.position;
      const riderPos = b.entity?.position;
      const headSolidName = riderPos
        ? blockName(riderPos.x, Math.floor(riderPos.y + 1), riderPos.z)
        : '?';
      const footSolidName = riderPos
        ? blockName(riderPos.x, Math.floor(riderPos.y), riderPos.z)
        : '?';
      sailLog('mount done',
        `boat=${fmtPos(boatPos)}`,
        `rider=${fmtPos(riderPos)}`,
        `rider_foot=${footSolidName}`,
        `rider_head=${headSolidName}`,
        riderPos ? fmtFootHead(riderPos.floored()) : '',
      );
      const isAirish = (n) => n === 'air' || n === 'cave_air' || n === 'void_air';
      const isAirOrWater = (n) => isAirish(n) || n === 'water' || n === 'flowing_water';
      if (!isAirOrWater(footSolidName) || !isAirish(headSolidName)) {
        sailLog('mount UNSAFE — disembarking',
          `rider_foot=${footSolidName}`,
          `rider_head=${headSolidName}`,
        );
        try {
          await ACTIONS.disembark({ emergency: true });
        } catch { /* best-effort */ }
                return fail('MOUNT_UNSAFE', `Mount succeeded but rider hitbox is obstructed at (${Math.floor(riderPos.x)}, ${Math.floor(riderPos.y)}, ${Math.floor(riderPos.z)}): foot=${footSolidName}, head=${headSolidName}. Auto-disembarked before suffocation damage. Move to a different shore stance and re-call sail_to.`, {
          observed_state: {
              rider_position: riderPos ? { x: riderPos.x, y: riderPos.y, z: riderPos.z } : null,
              rider_foot_block: footSolidName,
              rider_head_block: headSolidName,
              route,
            },
          next_action_hint: `mc bg_goto ${route.entry_shore.x} ${route.entry_shore.y} ${route.entry_shore.z}  # try a different shore stance`,
          retry_safe: true,
        });
      }
    } catch (e) {
      sailLog('mount FAILED', `phase=throw`, `error=${e?.message || e}`);
              return fail('MOUNT_FAILED', `Mount sequence threw: ${e?.message || e}`, { retry_safe: true });
    }

    phases.push('sail');
    sailLog('sail start',
      `legs=${legs.length}`,
      `bot=${fmtPos(b.entity.position)}`,
      `boat=${fmtPos(b.vehicle?.position)}`,
    );
    try {
      const legsRes = await sailLegs(legs);
      if (!legsRes.ok) {
        sailLog('sail FAILED',
          `leg=${legsRes.leg_index + 1}/${legs.length}`,
          `waypoint=${fmtPos(legsRes.waypoint)}`,
          `bot=${fmtPos(b.entity.position)}`,
          fmtFootHead(b.entity.position.floored()),
          `inner=${legsRes.inner_error?.code || '?'}`,
        );
                return fail('SAIL_FAILED', `Sail failed on leg ${legsRes.leg_index + 1}/${legs.length} (waypoint ${legsRes.waypoint.x},${legsRes.waypoint.y},${legsRes.waypoint.z}): ${legsRes.inner_error?.message || 'unknown'}. Call mc sail_to ${target.x} ${target.y} ${target.z} again to re-plan from here.`, {
          observed_state: { sail_error: legsRes.inner_error, leg_index: legsRes.leg_index, waypoint: legsRes.waypoint, route },
          next_action_hint: `mc sail_to ${target.x} ${target.y} ${target.z}`,
          retry_safe: true,
        });
      }
      sailLog('sail done',
        `bot=${fmtPos(b.entity.position)}`,
        `boat=${fmtPos(b.vehicle?.position)}`,
      );
    } catch (e) {
      sailLog('sail FAILED', `phase=throw`, `error=${e?.message || e}`);
              return fail('SAIL_FAILED', `Sail threw: ${e?.message || e}`, { retry_safe: true });
    }
  }

  if (b.vehicle && b.entities[b.vehicle.id]) {
    phases.push('disembark');
    sailLog('disembark start',
      `exit_shore=${fmtPos(route.exit_shore)}`,
      `bot=${fmtPos(b.entity.position)}`,
      `boat=${fmtPos(b.vehicle?.position)}`,
    );
    try {
      const disRes = await ACTIONS.disembark({ target_shore: route.exit_shore });
      if (!disRes.ok && disRes.error?.code !== 'NOT_MOUNTED') {
                return fail('DISEMBARK_FAILED', `Disembark failed at (${route.exit_shore.x}, ${route.exit_shore.y}, ${route.exit_shore.z}): ${disRes.error?.message || 'unknown'}`, {
          observed_state: { disembark_error: disRes.error, exit_shore: route.exit_shore },
          retry_safe: true,
        });
      }
    } catch (e) {
              return fail('DISEMBARK_FAILED', `Disembark threw: ${e?.message || e}`, { retry_safe: true });
    }
  }

  const here = b.entity.position;
  const stillFar = Math.hypot(here.x - target.x, here.z - target.z) > 4;
  if (stillFar) {
    phases.push('walk_to_target');
    sailLog('walk_to_target start',
      `target=${fmtPos(target)}`,
      `bot=${fmtPos(here)}`,
    );
    try {
      await pathfindGotoNear(b, goals, target.x, target.y, target.z, 2, {
        opName: 'walk_to_target',
        capMs: ACTION_CAPS_MS.goto_near,
      });
      sailLog('walk_to_target done', `bot=${fmtPos(b.entity.position)}`);
    } catch (e) {
      sailLog('walk_to_target FAILED', `bot=${fmtPos(b.entity.position)}`, `reason=${e?.message || e}`);
      const endPos = b.entity.position;
      return ok({
        command: 'sail_to',
        data: {
          phases_executed: phases,
          walk_to_target_partial: { error: e?.message || String(e) },
          route: {
            entry_shore: route.entry_shore,
            exit_shore: route.exit_shore,
            horizontal_distance: route.horizontal_distance,
            waypoints_count: route.waypoints.length,
          },
          start_position: startPos,
          end_position: { x: endPos.x, y: endPos.y, z: endPos.z },
          elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
        },
        result: `Sailed to (${route.exit_shore.x},${route.exit_shore.y},${route.exit_shore.z}) — final ${Math.round(Math.hypot(endPos.x - target.x, endPos.z - target.z))}b on land failed; call mc bg_goto ${target.x} ${target.y} ${target.z} to finish.`,
      });
    }
  }

  const endPos = b.entity.position;
  const partial = !!route.partial;
  const walkRemaining = route.walk_remaining_after_water || 0;
  return ok({
    command: 'sail_to',
    data: {
      phases_executed: phases,
      route: {
        entry_shore: route.entry_shore,
        exit_shore: route.exit_shore,
        horizontal_distance: route.horizontal_distance,
        waypoints_count: route.waypoints.length,
        water_cells_explored: route.water_cells_explored,
        partial,
        walk_remaining_after_water: walkRemaining,
      },
      start_position: startPos,
      end_position: { x: endPos.x, y: endPos.y, z: endPos.z },
      elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
      ...(partial ? {
        next_action_hint: `mc bg_goto ${target.x} ${target.y} ${target.z}  # the water leg dropped you ${walkRemaining}b from target; walk the rest`,
      } : {}),
    },
    result: partial
      ? `Sailed PARTIAL: from (${Math.floor(startPos.x)},${Math.floor(startPos.y)},${Math.floor(startPos.z)}) to shore at (${route.exit_shore.x},${route.exit_shore.y},${route.exit_shore.z}) — ${route.horizontal_distance}b across water, but target is still ${walkRemaining}b away. Now call: mc bg_goto ${target.x} ${target.y} ${target.z}`
      : `Sailed from (${Math.floor(startPos.x)},${Math.floor(startPos.y)},${Math.floor(startPos.z)}) to (${target.x},${target.y},${target.z}) — ${route.horizontal_distance}b across water, ${phases.length} phases.`,
  });
}
