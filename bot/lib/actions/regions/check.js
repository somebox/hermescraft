import { Vec3 } from 'vec3';
import { ok, fail } from '../../shared/action-contract.js';
import {
  regionsEnabled,
  buildRegionResolveArgs,
  activeWorksiteRegion,
} from '../../runtime/regions/policy-guard.js';
import { coord3, itemName } from '../_args.js';

export function createRegionsCheckActions(deps) {
  const { ctx, config, ensureBot } = deps;

  return {
    async check(body) {
      const b = ensureBot();
      const store = ctx.runtime?.regions;
      const verb = String(body.verb || body.action || '').toLowerCase();
      if (verb !== 'dig' && verb !== 'place') {
        return fail('INVALID_ARGS', 'check supports dig and place only', { retry_safe: false });
      }

      let x;
      let y;
      let z;
      let blockName = null;

      if (verb === 'dig') {
        const c = coord3(body);
        if (!c.ok) return c.response;
        ({ x, y, z } = c);
        const blk = b.blockAt(new Vec3(x, y, z));
        blockName = blk?.name || body.block || 'unknown';
      } else {
        const itemParsed = itemName(body, { keys: ['block', 'item', 'name'] });
        if (!itemParsed.ok) return itemParsed.response;
        blockName = itemParsed.name;
        const c = coord3(body);
        if (!c.ok) return c.response;
        ({ x, y, z } = c);
      }

      const worksite = activeWorksiteRegion(ctx);
      const enforcement = Boolean(store && regionsEnabled(config));

      if (!enforcement) {
        return ok({
          result: store ? 'Region policy enforcement disabled' : 'No region store',
          data: {
            dry_run: true,
            verb,
            at: { x, y, z },
            block: blockName,
            enforcement: false,
            worksite,
            region_decision: {
              decision: 'allow',
              reason: 'ENFORCEMENT_DISABLED',
              winning_region: null,
            },
          },
        });
      }

      const resolveArgs = buildRegionResolveArgs(ctx, body);
      const regionResult = store.resolve(verb, resolveArgs, { x, y, z }, blockName);

      return ok({
        result: `${verb} @ ${x},${y},${z}: ${regionResult.decision} (${regionResult.reason})`,
        data: {
          dry_run: true,
          verb,
          at: { x, y, z },
          block: blockName,
          enforcement: true,
          worksite,
          region_decision: regionResult,
        },
      });
    },
  };
}
