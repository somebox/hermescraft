/** sail_to plan_route: planWaterRoute, refusals, legs + sailLegs closure. */

import { fail, ok } from '../../../shared/action-contract.js';
import { escalationHint } from '../../../shared/escalation-hint.js';

export async function runSailPlanRoute(bindings, diag, state) {
  const {
    ensureBot,
    ACTIONS,
    planWaterRoute,
    Vec3,
  } = bindings;
  const { sailLog, fmtPos } = diag;

  const b = ensureBot();
  const { target, phases, startPos, currentlyMounted } = state;

  const planStart = currentlyMounted && b.vehicle?.position
    ? { x: b.vehicle.position.x, y: b.vehicle.position.y, z: b.vehicle.position.z }
    : startPos;
  const botFootPos0 = b.entity.position.floored();
  const botFootBlk0 = b.blockAt(botFootPos0);
  const botInWaterAtPlanTime = !!botFootBlk0 && (botFootBlk0.name === 'water' || botFootBlk0.name === 'flowing_water');
  const routeRes = planWaterRoute(b, planStart, target, {
    min_useful_sail: botInWaterAtPlanTime ? 1 : undefined,
  });
  phases.push('plan_route');
  if (!routeRes.ok) {
    if (routeRes.error.code === 'ALREADY_AT_TARGET') {
      phases.push('at_target');
      return {
        done: true,
        result: ok({
          command: 'sail_to',
          data: { phases_executed: phases, start_position: startPos, end_position: startPos, elapsed_seconds: 0 },
          result: 'Already at target.',
        }),
      };
    }
    const suggestion = ({
      POND_DISCONNECTED: 'walk to a real shore first (mc bg_goto to a coast cell)',
      WATER_TOO_SHALLOW: 'find deeper water — the bot would ground out here',
      TARGET_NOT_REACHABLE_FROM_WATER: 'the destination has no water shore; consider mc bg_goto for the land approach',
      NO_WATER_ROUTE: 'no navigable water near you — walk to a shore first',
    })[routeRes.error.code] || 'check the observed_state for details';
    const nearestStance = routeRes.error.observed_state?.nearest_shore_stance;
    const nearestCandidate = routeRes.error.observed_state?.nearest_water_candidate;
    let nextHint;
    if (nearestStance) {
      nextHint = `mc bg_goto ${nearestStance.x} ${nearestStance.y} ${nearestStance.z}  # walkable shore — then mc sail_to ${target.x} ${target.y} ${target.z}`;
    } else if (nearestCandidate) {
      nextHint = `mc bg_goto ${nearestCandidate.x} ${nearestCandidate.y} ${nearestCandidate.z}  # nearest water — then mc sail_to ${target.x} ${target.y} ${target.z}`;
    } else if (routeRes.error.code === 'NO_WATER_ROUTE') {
      nextHint = escalationHint({ reason: `find shore to sail to ${target.x},${target.y},${target.z}`, target: `${target.x},${target.y},${target.z}` });
    } else if (routeRes.error.code === 'POND_DISCONNECTED') {
      nextHint = 'mc bg_goto <coast coords>  # then mc sail_to again';
    } else {
      nextHint = 'mc bg_goto <target>';
    }
    return {
      done: true,
      result: fail(
        'NO_NAVIGABLE_ROUTE',
        `Can't plan a water route: ${routeRes.error.message} Suggestion: ${suggestion}.`,
        {
          observed_state: {
            water_route_error: routeRes.error.code,
            water_route_state: routeRes.error.observed_state,
            start: planStart,
            target,
            ...(nearestCandidate ? { nearest_water_candidate: nearestCandidate } : {}),
            ...(nearestStance ? { nearest_shore_stance: nearestStance } : {}),
          },
          next_action_hint: nextHint,
          retry_safe: false,
        },
      ),
    };
  }

  const route = routeRes.data;
  sailLog('plan_route',
    `entry_water=${fmtPos(route.entry_water)}`,
    `entry_shore=${fmtPos(route.entry_shore)}`,
    `exit_water=${fmtPos(route.exit_water)}`,
    `exit_shore=${fmtPos(route.exit_shore)}`,
    `waypoints=${route.waypoints?.length ?? 0}`,
    `partial=${!!route.partial}`,
    `sail_distance=${route.sail_distance ?? '?'}`,
  );

  const sailLegs = async (legs) => {
    const lastWp = legs[legs.length - 1];
    if (route?.cells_path && route.cells_path.length > 1) {
      const legRes = await ACTIONS.sail({
        x: lastWp.x, y: lastWp.y, z: lastWp.z,
        allow_shore_early_exit: true,
        _from_sail_to: true,
        precomputed_path: route.cells_path,
      });
      if (!legRes.ok) {
        return {
          ok: false,
          leg_index: 0,
          waypoint: lastWp,
          inner_error: legRes.error,
        };
      }
      return { ok: true, detoursTaken: [] };
    }
    const detoursTaken = [];
    for (let i = 0; i < legs.length; i++) {
      const wp = legs[i];
      const isLast = (i === legs.length - 1);
      const legRes = await ACTIONS.sail({
        x: wp.x, y: wp.y, z: wp.z,
        allow_shore_early_exit: isLast,
        _from_sail_to: true,
      });
      if (!legRes.ok) {
        return { ok: false, leg_index: i, waypoint: wp, inner_error: legRes.error };
      }
      if (legRes.data?.detours) detoursTaken.push(...legRes.data.detours);
      if (legRes.data?.shore_reached && isLast) {
        return { ok: true, shore_reached: legRes.data.shore_reached, detoursTaken };
      }
    }
    return { ok: true, detoursTaken };
  };

  const legs = route.waypoints.length > 1
    ? route.waypoints.slice(1)
    : [route.exit_water];

  const botFootPos = b.entity.position.floored();
  const botFootBlock = b.blockAt(botFootPos);
  const botBelowBlock = b.blockAt(new Vec3(botFootPos.x, botFootPos.y - 1, botFootPos.z));
  const footIsWater = botFootBlock && (botFootBlock.name === 'water' || botFootBlock.name === 'flowing_water');
  const swimmingOnSurface = !footIsWater
    && botFootBlock && (botFootBlock.name === 'air' || botFootBlock.name === 'cave_air' || botFootBlock.name === 'void_air')
    && botBelowBlock && (botBelowBlock.name === 'water' || botBelowBlock.name === 'flowing_water')
    && !b.entity.onGround;
  const botInWater = !!(footIsWater || swimmingOnSurface);

  return {
    done: false,
    route,
    legs,
    sailLegs,
    currentlyMounted,
    botInWater,
    swimmingOnSurface,
    botFootPos,
  };
}
