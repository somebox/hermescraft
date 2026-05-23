/** Public sail_to heartbeat + retry counter wrapper (Phase 4a). */

/** @typedef {{ ctx: any; ensureBot: ()=>import('mineflayer').Bot; sailToRetryCounts: Map<string, unknown> }} WrapBindings */

/**
 * @param {WrapBindings & Record<string, unknown>} bindings
 * @param {{(): (args:{x:number,y:number,z:number}) => Promise<any>}} implAccessor
 */
export function createSailToOuterWrapper(bindings, implAccessor) {
  const { ctx, ensureBot, sailToRetryCounts } = bindings;

  return async function sail_to(args) {
    let result;
    let sailToStartedAt = Date.now();
    let heartbeat = null;
    if (ctx?.runtime) {
      ctx.runtime.sailToActiveStartedAt = sailToStartedAt;
      heartbeat = setInterval(() => {
        if (ctx.runtime.sailToActiveStartedAt === sailToStartedAt) {
          sailToStartedAt = Date.now();
          ctx.runtime.sailToActiveStartedAt = sailToStartedAt;
        }
      }, 15_000);
      if (typeof heartbeat?.unref === 'function') heartbeat.unref();
    }
    try {
      result = await implAccessor()(args);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (ctx?.runtime && ctx.runtime.sailToActiveStartedAt === sailToStartedAt) {
        ctx.runtime.sailToActiveStartedAt = null;
      }
    }
    const tx = Number(args?.x), ty = Number(args?.y), tz = Number(args?.z);
    if (Number.isFinite(tx) && Number.isFinite(ty) && Number.isFinite(tz)) {
      const targetKey = `${Math.floor(tx)},${Math.floor(ty)},${Math.floor(tz)}`;
      if (result?.ok) {
        sailToRetryCounts.delete(targetKey);
      } else {
        const code = result?.error?.code;
        const noCountCodes = new Set(['INVALID_COORD', 'NO_BOAT', 'SAIL_TO_RETRY_LOOP']);
        if (code && !noCountCodes.has(code)) {
          const prior = sailToRetryCounts.get(targetKey) || {
            count: 0,
            lastErrorCode: null,
            lastNearestWater: null,
            lastShoreStance: null,
          };
          const obs = result?.error?.observed_state || {};
          const nearestCandidate =
            (obs.nearest_water_candidate && Number.isFinite(obs.nearest_water_candidate.x))
              ? obs.nearest_water_candidate
              : (obs.water_route_state?.nearest_water_candidate && Number.isFinite(obs.water_route_state.nearest_water_candidate.x))
                ? obs.water_route_state.nearest_water_candidate
                : prior.lastNearestWater;
          const nearestShoreStance =
            (obs.nearest_shore_stance && Number.isFinite(obs.nearest_shore_stance.x))
              ? obs.nearest_shore_stance
              : (obs.water_route_state?.nearest_shore_stance && Number.isFinite(obs.water_route_state.nearest_shore_stance.x))
                ? obs.water_route_state.nearest_shore_stance
                : prior.lastShoreStance;
          const b = ensureBot();
          const failurePos = b?.entity?.position
            ? { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z }
            : null;
          sailToRetryCounts.set(targetKey, {
            count: prior.count + 1,
            lastErrorCode: code,
            lastNearestWater: nearestCandidate,
            lastShoreStance: nearestShoreStance,
            lastFailurePos: failurePos,
          });
        }
      }
    }
    return result;
  };
}
