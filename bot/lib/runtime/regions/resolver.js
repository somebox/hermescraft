/**
 * Pure region policy resolver (no Mineflayer).
 */
import { applyProfile, isProtectedInRegion, isStructuralInRegion, isToleratedBreak } from './profiles.js';

/**
 * @param {object} shape
 * @param {object} anchor
 * @param {number} x
 * @param {number} y
 * @param {number} z
 */
export function containsPoint(shape, anchor, x, y, z) {
  if (!shape || !anchor) return false;
  const ax = anchor.x;
  const ay = anchor.y ?? 0;
  const az = anchor.z;
  const dx = x - ax;
  const dz = z - az;
  const r = shape.radius ?? 16;
  const kind = shape.kind || 'column';

  if (kind === 'sphere') {
    const dy = y - ay;
    if (dx * dx + dy * dy + dz * dz > r * r) return false;
    return true;
  }

  // column: X/Z disc
  if (dx * dx + dz * dz > r * r) return false;
  const yMin = shape.y_min;
  const yMax = shape.y_max;
  if (yMin != null && y < yMin) return false;
  if (yMax != null && y > yMax) return false;
  return true;
}

/**
 * @param {object[]} regions raw region rows
 * @returns {object[]} active, profile-applied regions
 */
export function normalizeRegions(regions) {
  const now = Date.now();
  return (regions || [])
    .map((r) => applyProfile({ ...r }))
    .filter((r) => {
      if (r.intent !== 'marker') return true;
      if (!r.expires_at) return true;
      const exp = Date.parse(r.expires_at);
      return !Number.isFinite(exp) || exp > now;
    });
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {object[]} regions
 */
export function regionsAt(x, y, z, regions) {
  return normalizeRegions(regions).filter((r) =>
    containsPoint(r.shape, r.anchor, x, y, z),
  );
}

/**
 * Pick winning region for policy among overlapping regions at a point.
 * @param {object[]} containing
 * @param {string} verb
 * @param {object} args
 */
function pickWinningRegion(containing, verb, args) {
  if (!containing.length) return { winner: null, losers: [] };

  const scored = containing.map((r) => {
    const radius = r.shape?.radius ?? 16;
    const intentScore = r.intent === 'resource' ? 2 : r.intent === 'protect' ? 1 : 0;
    return { r, radius, intentScore, updated: r.updated || r.created || '' };
  });

  scored.sort((a, b) => {
    if (b.intentScore !== a.intentScore) return b.intentScore - a.intentScore;
    if (a.radius !== b.radius) return a.radius - b.radius;
    return String(b.updated).localeCompare(String(a.updated));
  });

  const winner = scored[0].r;
  const losers = scored.slice(1).map((s) => ({ id: s.r.id, intent: s.r.intent }));
  return { winner, losers };
}

/**
 * @param {string} ref e.g. :base1:/tower
 * @param {object[]} regions
 */
export function resolveSiteRef(ref, regions) {
  const m = String(ref || '').match(/^:([a-z0-9]{2,12}):\/([a-z0-9]{2,12})$/i);
  if (!m) {
    return {
      decision: 'deny',
      reason: 'INVALID_SITE_REF',
      winning_region: null,
      resolved: null,
    };
  }
  const regionId = m[1].toLowerCase();
  const siteName = m[2]?.toLowerCase();
  const region = normalizeRegions(regions).find((r) => r.id === regionId);
  if (!region) {
    return {
      decision: 'deny',
      reason: 'REGION_NOT_FOUND',
      winning_region: null,
      resolved: null,
    };
  }
  const sites = region.sites || [];
  const siteList = Array.isArray(sites)
    ? sites
    : Object.entries(sites).map(([name, coords]) => ({ name, ...coords }));
  const site = siteList.find((s) => s.name === siteName);
  if (!site) {
    return {
      decision: 'deny',
      reason: 'SITE_NOT_FOUND',
      winning_region: summarizeRegion(region),
      resolved: null,
    };
  }
  return {
    decision: 'allow',
    reason: 'SITE_RESOLVED',
    winning_region: summarizeRegion(region),
    losing_regions: [],
    resolved: { x: site.x, y: site.y, z: site.z },
  };
}

function summarizeRegion(r) {
  if (!r) return null;
  return {
    id: r.id,
    intent: r.intent,
    profile: r.profile,
    status: r.status,
    capabilities: r.capabilities,
    sites: Array.isArray(r.sites)
      ? r.sites.map((s) => s.name)
      : Object.keys(r.sites || {}),
  };
}

/**
 * @param {string} verb dig | place | resolve_site
 * @param {object} args
 * @param {object} position {x,y,z}
 * @param {string|null} blockName
 * @param {object[]} regions
 */
export function resolve(verb, args, position, blockName, regions) {
  if (verb === 'resolve_site') {
    return resolveSiteRef(args?.ref, regions);
  }

  const { x, y, z } = position;
  const containing = regionsAt(x, y, z, regions);
  const { winner, losers } = pickWinningRegion(containing, verb, args);

  if (!winner) {
    return {
      decision: 'allow',
      reason: 'OUTSIDE_ALL_REGIONS',
      winning_region: null,
      losing_regions: [],
      matched_capability: null,
    };
  }

  const caps = winner.capabilities || {};
  const adHoc = args?.ad_hoc !== false && !args?.guided;
  const guided = args?.guided === true;

  if (winner.intent === 'marker') {
    return {
      decision: 'allow',
      reason: 'INTENT_MARKER_NOOP',
      winning_region: summarizeRegion(winner),
      losing_regions: losers,
      matched_capability: null,
    };
  }

  const taskWorksite = args?.task_worksite ?? null;
  if (winner.intent === 'protect' && taskWorksite && taskWorksite === winner.id) {
    if (verb === 'dig' && isStructuralInRegion(blockName, winner)) {
      return {
        decision: 'deny',
        reason: 'REGION_STRUCTURAL_BLOCK',
        winning_region: summarizeRegion(winner),
        losing_regions: losers,
        matched_capability: 'task_worksite',
      };
    }
    return {
      decision: 'allow',
      reason: 'WORKSITE_GRANT',
      winning_region: summarizeRegion(winner),
      losing_regions: losers,
      matched_capability: 'task_worksite',
    };
  }

  if (verb === 'dig') {
    if (guided && caps.allow_guided_edit) {
      return {
        decision: 'allow',
        reason: 'REGION_GUIDED_EDIT',
        winning_region: summarizeRegion(winner),
        losing_regions: losers,
        matched_capability: 'allow_guided_edit',
      };
    }
    if (isToleratedBreak(blockName, winner)) {
      return {
        decision: 'allow',
        reason: 'REGION_TOLERATED_BREAK',
        winning_region: summarizeRegion(winner),
        losing_regions: losers,
        matched_capability: 'allow_harvest',
      };
    }
    if (adHoc && caps.allow_ad_hoc_dig) {
      return {
        decision: 'allow',
        reason: 'REGION_OVERRIDE',
        winning_region: summarizeRegion(winner),
        losing_regions: losers,
        matched_capability: 'allow_ad_hoc_dig',
      };
    }
    if (adHoc && isProtectedInRegion(blockName, winner)) {
      return {
        decision: 'deny',
        reason: 'REGION_PROTECTED',
        winning_region: summarizeRegion(winner),
        losing_regions: losers,
        matched_capability: 'allow_ad_hoc_dig',
      };
    }
    if (adHoc && winner.intent === 'protect') {
      return {
        decision: 'deny',
        reason: 'REGION_PROTECTED',
        winning_region: summarizeRegion(winner),
        losing_regions: losers,
        matched_capability: 'allow_ad_hoc_dig',
      };
    }
    return {
      decision: 'allow',
      reason: 'REGION_OVERRIDE',
      winning_region: summarizeRegion(winner),
      losing_regions: losers,
      matched_capability: 'allow_ad_hoc_dig',
    };
  }

  if (verb === 'place') {
    if (guided && caps.allow_guided_edit) {
      return {
        decision: 'allow',
        reason: 'REGION_GUIDED_EDIT',
        winning_region: summarizeRegion(winner),
        losing_regions: losers,
        matched_capability: 'allow_guided_edit',
      };
    }
    if (adHoc && caps.allow_ad_hoc_place) {
      return {
        decision: 'allow',
        reason: 'REGION_OVERRIDE',
        winning_region: summarizeRegion(winner),
        losing_regions: losers,
        matched_capability: 'allow_ad_hoc_place',
      };
    }
    if (adHoc && winner.intent === 'protect') {
      return {
        decision: 'deny',
        reason: 'REGION_PROTECTED',
        winning_region: summarizeRegion(winner),
        losing_regions: losers,
        matched_capability: 'allow_ad_hoc_place',
      };
    }
    return {
      decision: 'allow',
      reason: 'REGION_OVERRIDE',
      winning_region: summarizeRegion(winner),
      losing_regions: losers,
      matched_capability: 'allow_ad_hoc_place',
    };
  }

  return {
    decision: 'allow',
    reason: 'OUTSIDE_ALL_REGIONS',
    winning_region: summarizeRegion(winner),
    losing_regions: losers,
    matched_capability: null,
  };
}
