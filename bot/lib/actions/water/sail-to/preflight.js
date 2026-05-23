/** sail_to preflight: coords, retry guard, at_target, NO_BOAT. */

import { fail, ok } from '../../../shared/action-contract.js';

export function runSailPreflight(bindings, diag, { x, y, z }) {
  const {
    ensureBot,
    sailToRetryCounts,
    SAIL_TO_RETRY_LIMIT,
    RETRY_RESET_DISTANCE,
    BOAT_NAMES,
  } = bindings;
  const { sailLog, fmtPos, fmtFootHead } = diag;

  const b = ensureBot();
  if (![x, y, z].every((v) => Number.isFinite(Number(v)))) {
    return {
      done: true,
      result: fail('INVALID_COORD', 'mc sail_to requires numeric x, y, z', { retry_safe: false }),
    };
  }
  const target = { x: Number(x), y: Number(y), z: Number(z) };
  const targetKey = `${Math.floor(target.x)},${Math.floor(target.y)},${Math.floor(target.z)}`;
  const startedAt = Date.now();
  const phases = []; // names of phases that actually ran
  const startPos = {
    x: b.entity.position.x,
    y: b.entity.position.y,
    z: b.entity.position.z,
  };
  sailLog('start', `target=${fmtPos(target)}`, `bot=${fmtPos(startPos)}`,
    fmtFootHead(b.entity.position.floored()),
    `mounted=${!!b.vehicle}`,
    `boats_inv=${b.inventory?.items?.().filter((it) => BOAT_NAMES.has(it.name)).reduce((s, it) => s + it.count, 0) ?? 0}`,
  );

  let priorRetry = sailToRetryCounts.get(targetKey);
  if (priorRetry?.lastFailurePos) {
    const dxz = Math.hypot(
      startPos.x - priorRetry.lastFailurePos.x,
      startPos.z - priorRetry.lastFailurePos.z,
    );
    if (dxz > RETRY_RESET_DISTANCE) {
      sailToRetryCounts.delete(targetKey);
      priorRetry = undefined;
    }
  }
  if (priorRetry && priorRetry.count >= SAIL_TO_RETRY_LIMIT) {
    const stance = priorRetry.lastShoreStance;
    const nw = priorRetry.lastNearestWater;
    const hintCoord = stance || nw;
    const hintLabel = stance ? 'walkable shore' : 'nearest water';
    const nextHint = hintCoord
      ? `mc bg_goto ${hintCoord.x} ${hintCoord.y} ${hintCoord.z}  # ${hintLabel} — then mc sail_to ${target.x} ${target.y} ${target.z} again from there`
      : 'mc advise --reason="sail_to stuck retrying"';
    return {
      done: true,
      result: fail(
        'SAIL_TO_RETRY_LOOP',
        `${priorRetry.count} consecutive sail_to calls to (${target.x}, ${target.y}, ${target.z}) have failed (last error: ${priorRetry.lastErrorCode || 'unknown'}). The body cannot make progress to this target on its own.${stance ? ` Walk to the shore stance at (${stance.x}, ${stance.y}, ${stance.z}) first — sail_to from there will see a fresh entry.` : nw ? ` Walk near the water at (${nw.x}, ${nw.y}, ${nw.z}) first — sail_to from there will see a fresh entry.` : ' Pick a different waypoint or call mc advise.'}`,
        {
          observed_state: {
            retry_count: priorRetry.count,
            last_error_code: priorRetry.lastErrorCode,
            target,
            ...(nw ? { nearest_water_candidate: nw } : {}),
            ...(stance ? { nearest_shore_stance: stance } : {}),
          },
          next_action_hint: nextHint,
          retry_safe: false,
        },
      ),
    };
  }

  const horizToTarget = Math.hypot(startPos.x - target.x, startPos.z - target.z);
  if (horizToTarget < 4) {
    phases.push('at_target');
    sailToRetryCounts.delete(targetKey);
    return {
      done: true,
      result: ok({
        command: 'sail_to',
        data: {
          phases_executed: phases,
          start_position: startPos,
          end_position: startPos,
          elapsed_seconds: 0,
        },
        result: `Already within 4b of target (${horizToTarget.toFixed(1)}b) — no journey needed. Use mc bg_goto for the final approach.`,
      }),
    };
  }

  const hasBoatItem = b.inventory?.items?.().some((it) => BOAT_NAMES.has(it.name));
  const currentlyMounted = !!b.vehicle && !!b.entities[b.vehicle.id];
  if (!hasBoatItem && !currentlyMounted) {
    return {
      done: true,
      result: fail(
        'NO_BOAT',
        'No boat in inventory and not currently mounted. mc sail_to needs a boat (your ticket). Craft one with: mc craft oak_boat (needs 5 oak_planks).',
        {
          observed_state: { inventory_has_boat: false, mounted: false },
          next_action_hint: 'mc craft oak_boat',
          retry_safe: false,
        },
      ),
    };
  }

  return {
    done: false,
    state: {
      target,
      targetKey,
      phases,
      startPos,
      startedAt,
      currentlyMounted,
    },
  };
}
