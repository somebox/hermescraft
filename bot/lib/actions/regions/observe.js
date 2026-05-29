import { ok } from '../../shared/action-contract.js';
import { runRegionsTerrain } from '../_farming-survey.js';

/**
 * Read-only region listing (create/remove in regions/create.js).
 */
export function createRegionsObserveActions(deps) {
  const { ctx, ensureBot } = deps;

  return {
    async regions(args) {
      ensureBot();
      const store = ctx.runtime?.regions;
      if (!store) {
        return ok({ result: 'No region store', data: { regions: [] } });
      }
      const bot = ctx.world.bot;
      const botPos = bot?.entity?.position ?? null;

      const atArg = args.at ?? args['at'];
      let preview = null;
      if (atArg != null) {
        const parts = String(atArg).split(/[,\s]+/).map(Number);
        if (parts.length >= 3 && parts.every(Number.isFinite)) {
          const [x, y, z] = parts;
          preview = {
            at: { x, y, z },
            containing: store.at(Math.floor(x), Math.floor(y), Math.floor(z)).map((r) => r.id),
            dig: store.resolve('dig', { ad_hoc: true }, { x, y, z }, args.block || 'cobblestone'),
            place: store.resolve('place', { ad_hoc: true }, { x, y, z }, args.block || 'dirt'),
          };
        }
      }

      const regions = store.listForApi({ botPos });
      return ok({
        result: regions.length ? `${regions.length} region(s)` : 'No regions defined',
        data: { world: store.world, regions, preview, regions_here: store.regionsHere(botPos) },
      });
    },

    async regions_terrain(args) {
      ensureBot();
      return runRegionsTerrain({ ctx, ensureBot }, args || {});
    },
  };
}
