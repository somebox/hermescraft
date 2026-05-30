/**
 * Single navigation facade for strategic destinations (go_site, go_mark, move).
 * raw=true → goto stack (preflight/water refusal, no move detour guard).
 */
export function createNavigateToTarget(deps) {
  const { move, goto, goto_near: gotoNear, config } = deps;

  return async function navigateToTarget(opts = {}) {
    const raw = opts.raw === true || opts.raw === 'true';
    const force = opts.force === true || opts.force === 'true';
    const near = opts.near != null ? Number(opts.near) : undefined;
    const x = Number(opts.x);
    const y = Number(opts.y);
    const z = Number(opts.z);
    if (![x, y, z].every((n) => Number.isFinite(n))) {
      return {
        ok: false,
        error: { code: 'missing:coords', message: 'navigateToTarget requires numeric x,y,z', retry_safe: false },
      };
    }
    const useResolve = config?.behaviors?.navMoveResolve === true;
    if (!useResolve && !raw) {
      return goto({ x, y, z, ...(opts.mark ? { mark: opts.mark } : {}) });
    }
    if (raw) {
      if (near != null && Number.isFinite(near)) {
        return gotoNear({ x, y, z, range: near, ...(opts.mark ? { mark: opts.mark } : {}) });
      }
      return goto({ x, y, z, ...(opts.mark ? { mark: opts.mark } : {}) });
    }
    if (near != null && Number.isFinite(near)) {
      return gotoNear({ x, y, z, range: near, ...(opts.mark ? { mark: opts.mark } : {}) });
    }
    return move({ x, y, z, ...(force ? { force: true } : {}), ...(opts.mark ? { mark: opts.mark } : {}) });
  };
}
