import { fail } from '../../shared/action-contract.js';
import { normalizeId } from '../../runtime/regions/index.js';

/**
 * Navigate to a region anchor or named site ref (:base1: or :base1:/tower).
 * @param {object} deps
 */
export function createGoSite(deps) {
  const { ctx, loadLocations, goto } = deps;

  return async function go_site(body) {
    const ref = String(body?.ref ?? '').trim();
    if (!ref) {
      return fail('INVALID_ARGS', 'Missing ref — use :region: or :region:/site', { retry_safe: false });
    }

    const siteRef = ref.match(/^:([a-z0-9]{2,12}):\/([a-z0-9]{2,12})$/i);
    if (siteRef) {
      const store = ctx.runtime?.regions;
      if (!store) {
        return fail('INVALID_REF', 'Regions are not loaded', {
          retry_safe: false,
          next_action_hint: 'mc regions',
        });
      }
      const decision = store.resolve('resolve_site', { ref }, { x: 0, y: 0, z: 0 }, null);
      if (decision.decision !== 'allow' || !decision.resolved) {
        const msg =
          decision.reason === 'REGION_NOT_FOUND'
            ? `No region ${ref.split('/')[0]}`
            : decision.reason === 'SITE_NOT_FOUND'
              ? `Site not found on ${ref}`
              : `Could not resolve ${ref}`;
        return fail('INVALID_REF', msg, {
          retry_safe: false,
          observed_state: { region_decision: decision },
          next_action_hint: 'mc regions',
        });
      }
      const { x, y, z } = decision.resolved;
      const nav = await goto({ x, y, z });
      if (nav?.ok && nav.data) {
        nav.data.resolved_ref = ref;
        nav.data.resolved_from = 'site';
      }
      return nav;
    }

    const bare = ref.match(/^:([a-z0-9]{2,12}):$/i);
    if (bare) {
      const id = normalizeId(ref);
      const store = ctx.runtime?.regions;
      const region = store?.get(id);
      if (region?.anchor) {
        const { x, y, z } = region.anchor;
        const nav = await goto({ x, y, z });
        if (nav?.ok && nav.data) {
          nav.data.resolved_ref = ref;
          nav.data.resolved_from = 'region_anchor';
        }
        return nav;
      }
      const locs = loadLocations();
      if (locs[id]) {
        const l = locs[id];
        const nav = await goto({ x: l.x, y: l.y, z: l.z });
        if (nav?.ok && nav.data) {
          nav.data.resolved_ref = ref;
          nav.data.resolved_from = 'placemark';
        }
        return nav;
      }
      return fail('INVALID_REF', `Unknown region or placemark ${ref}`, {
        retry_safe: false,
        next_action_hint: 'mc regions',
      });
    }

    return fail('INVALID_ARGS', 'Ref must look like :base1: or :base1:/tower', { retry_safe: false });
  };
}
