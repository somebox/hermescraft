/**
 * Single navigation facade for strategic destinations (go_site, go_mark, move).
 * raw=true → goto stack (preflight/water refusal, no move detour guard).
 */
import { recordNavBriefFailureForMark } from '../../runtime/nav-brief.js';

export function createNavigateToTarget(deps) {
  const { move, goto, goto_near: gotoNear, config, ctx } = deps;

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
    const mark = opts.mark != null ? String(opts.mark).replace(/^@/, '').trim() : '';

    const finish = (result) => {
      if (!result?.ok && mark) recordNavBriefFailureForMark(ctx, mark);
      return result;
    };

    const useResolve = config?.behaviors?.navMoveResolve === true;
    if (!useResolve && !raw) {
      return finish(await goto({ x, y, z, ...(mark ? { mark } : {}) }));
    }
    if (raw) {
      if (near != null && Number.isFinite(near)) {
        return finish(await gotoNear({ x, y, z, range: near, ...(mark ? { mark } : {}) }));
      }
      return finish(await goto({ x, y, z, ...(mark ? { mark } : {}) }));
    }
    if (near != null && Number.isFinite(near)) {
      return finish(await gotoNear({ x, y, z, range: near, ...(mark ? { mark } : {}) }));
    }
    return finish(await move({ x, y, z, ...(force ? { force: true } : {}), ...(mark ? { mark } : {}) }));
  };
}
