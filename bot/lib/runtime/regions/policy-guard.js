import { fail } from '../../shared/action-contract.js';
import { getConfig } from '../../config/index.js';

const EXIT_SITE_NAMES = new Set(['gate', 'entrance', 'exit']);

function buildRegionExitHint(regionResult, verb, blockName, x, y, z) {
  const id = regionResult.winning_region?.id;
  if (!id) {
    const checkHint =
      verb === 'dig'
        ? `mc check dig ${x} ${y} ${z}`
        : `mc check place ${blockName || 'BLOCK'} ${x} ${y} ${z}`;
    return {
      hint: `${checkHint}   # then mc move to a coord outside the region`,
      exit_hint_kind: 'none',
    };
  }
  const siteNames = regionResult.winning_region?.sites || [];
  const names = Array.isArray(siteNames) ? siteNames : Object.keys(siteNames);
  const preferred = names.find((n) => EXIT_SITE_NAMES.has(String(n).toLowerCase()));
  if (preferred) {
    return {
      hint: `mc go_site :${id}:/${preferred}   # leave region first`,
      exit_hint_kind: 'site',
    };
  }
  return {
    hint: `mc go_site :${id}:   # region anchor`,
    exit_hint_kind: 'anchor',
  };
}

export function regionsEnabled(config) {
  const cfg = config || getConfig();
  return cfg?.behaviors?.regionsEnabled !== false;
}

/**
 * Active worksite region id from task context, or null if missing/expired.
 * @param {object} ctx
 */
export function activeWorksiteRegion(ctx) {
  const tc = ctx?.runtime?.taskContext;
  if (!tc) return null;
  if (Number.isFinite(tc.expires_at) && tc.expires_at <= Date.now()) return null;
  return tc.worksite_region ?? null;
}

/**
 * @param {object} ctx
 * @param {object} [overrides] body fields or test overrides
 */
export function buildRegionResolveArgs(ctx, overrides = {}) {
  const taskWorksite =
    overrides.task_worksite !== undefined ? overrides.task_worksite : activeWorksiteRegion(ctx);
  return {
    ad_hoc: overrides.ad_hoc !== false && !overrides.guided,
    guided: overrides.guided === true,
    task_worksite: taskWorksite,
  };
}

/**
 * @param {object} ctx
 * @param {object} config
 * @param {'dig'|'place'} verb
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {string|null} blockName
 * @param {object} [overrides] merged into buildRegionResolveArgs
 */
export function evaluateRegionPolicy(ctx, config, verb, x, y, z, blockName, overrides = {}) {
  const cfg = config || getConfig();
  const store = ctx?.runtime?.regions;
  if (!store || !regionsEnabled(cfg)) {
    return { deny: false, skipGlobalDeny: false, regionResult: null };
  }
  const args = buildRegionResolveArgs(ctx, overrides);
  const regionResult = store.resolve(verb, args, { x, y, z }, blockName);
  if (regionResult.decision === 'deny') {
    return { deny: true, skipGlobalDeny: false, regionResult };
  }
  const skipGlobalDeny =
    verb === 'dig' &&
    (regionResult.reason === 'WORKSITE_GRANT' ||
      (regionResult.reason === 'REGION_OVERRIDE' &&
        regionResult.winning_region?.capabilities?.overrides_global_denylist === true));
  return { deny: false, skipGlobalDeny, regionResult };
}

/**
 * @returns {{ skip: boolean, regionId: string|null }}
 */
export function shouldSkipDigAt(ctx, config, blockName, x, y, z, isDigProtectedFn) {
  const pol = evaluateRegionPolicy(ctx, config, 'dig', x, y, z, blockName);
  if (pol.deny) {
    return { skip: true, regionId: pol.regionResult?.winning_region?.id ?? null };
  }
  if (pol.skipGlobalDeny) return { skip: false, regionId: null };
  if (isDigProtectedFn(blockName, { x, y, z }, ctx)) {
    return { skip: true, regionId: null };
  }
  return { skip: false, regionId: null };
}

/**
 * @returns {{ skip: boolean, regionId: string|null }}
 */
export function shouldSkipPlaceAt(ctx, config, blockName, x, y, z) {
  const pol = evaluateRegionPolicy(ctx, config, 'place', x, y, z, blockName);
  if (pol.deny) {
    return { skip: true, regionId: pol.regionResult?.winning_region?.id ?? null };
  }
  return { skip: false, regionId: null };
}

/** @param {Record<string, number>} counts */
export function formatRegionSkipSuffix(counts) {
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (!entries.length) return '';
  const parts = entries.map(([id, n]) => `${n} inside :${id}:`);
  return ` (skipped ${parts.join('; ')})`;
}

/** @param {Record<string, number>} counts */
export function regionProtectedRows(counts) {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([id, count]) => ({ id, count }));
}

/** Tracks region-policy skips for bulk action envelopes. */
export function createRegionSkipTracker() {
  /** @type {Record<string, number>} */
  const counts = {};
  return {
    /** @param {string|null|undefined} regionId */
    noteSkip(regionId) {
      if (!regionId) return;
      counts[regionId] = (counts[regionId] || 0) + 1;
    },
    skippedTotal() {
      return Object.values(counts).reduce((a, b) => a + b, 0);
    },
    suffix() {
      return formatRegionSkipSuffix(counts);
    },
    dataFields() {
      const skipped_region = this.skippedTotal();
      if (!skipped_region) return {};
      return { skipped_region, region_protected: regionProtectedRows(counts) };
    },
  };
}

/**
 * @param {'dig'|'place'} verb
 * @param {string|null} blockName
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {object} regionResult
 */
export function regionProtectedFailure(verb, blockName, x, y, z, regionResult) {
  const id = regionResult.winning_region?.id || '?';
  const intent = regionResult.winning_region?.intent || '';
  const targetLabel = verb === 'dig' ? (blockName || 'block') : (blockName || 'block');
  const { hint, exit_hint_kind } = buildRegionExitHint(regionResult, verb, blockName, x, y, z);
  return fail(
    'REGION_PROTECTED',
    `Cannot ${verb} ${targetLabel} — inside region :${id}: (${intent})`.replace(/\s+/g, ' ').trim(),
    {
      observed_state: {
        region_id: id,
        exit_hint_kind,
        region_decision: { ...regionResult, dry_run: false },
        requested_coord: { x, y, z },
        block_at_target: blockName,
      },
      next_action_hint: hint,
      retry_safe: false,
    },
  );
}
