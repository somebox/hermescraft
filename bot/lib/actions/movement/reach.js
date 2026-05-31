import { ok, fail } from '../../shared/action-contract.js';
import { formatSuggested } from '../../shared/envelope.js';

/**
 * mc reach — short-hop router over move / goto / goto_near (Stage 3 primitive).
 */
export function createReachActions(services) {
  const { getActions } = services;

  return {
    async reach({ x, y, z, mark, range = 2, reason }) {
      const actions = getActions ? getActions() : {};
      const target = mark
        ? { mark: String(mark).replace(/^@/, '') }
        : { x: Number(x), y: Number(y), z: Number(z) };
      if (target.mark) {
        if (typeof actions.go_mark === 'function') {
          return actions.go_mark({ name: target.mark, reason });
        }
        return fail('UNAVAILABLE', 'go_mark action not loaded', { retry_safe: false });
      }
      if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.z)) {
        return fail('INVALID_VALUE', 'reach requires coordinates or @mark', { retry_safe: false });
      }
      const tryOrder = [
        () => (typeof actions.move === 'function' ? actions.move({ x: target.x, y: target.y, z: target.z, reason }) : null),
        () => (typeof actions.goto === 'function' ? actions.goto({ x: target.x, y: target.y, z: target.z, reason }) : null),
        () => (typeof actions.goto_near === 'function' ? actions.goto_near({ x: target.x, y: target.y, z: target.z, range, reason }) : null),
      ];
      let last = null;
      for (const call of tryOrder) {
        try {
          const r = await call();
          if (!r) continue;
          last = r;
          if (r.ok !== false) {
            return ok({ ...r, data: { ...(r.data || {}), via: 'reach' } });
          }
        } catch (e) {
          last = fail('NAV_FAILED', String(e?.message || e), {
            next_action_hint: formatSuggested({ verb: 'goto_near', args: [String(target.x), String(target.y), String(target.z), String(range)] }),
            retry_safe: true,
          });
        }
      }
      return last || fail('NAV_FAILED', 'reach exhausted move/goto/goto_near', {
        next_action_hint: formatSuggested({ verb: 'goto_near', args: [target.x, target.y, target.z, range] }),
        retry_safe: true,
      });
    },
  };
}
