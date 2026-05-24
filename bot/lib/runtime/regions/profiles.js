/**
 * Region profile defaults: intent, capabilities, and block tolerances.
 */

/** @typedef {'protect'|'resource'|'marker'} RegionIntent */
/** @typedef {'base'|'farm'|'dock'|'mine'} RegionProfileName */

const PROFILE_DEFAULT_INTENT = {
  base: 'protect',
  farm: 'protect',
  dock: 'protect',
  mine: 'resource',
};

const CAPABILITIES_BY_INTENT = {
  protect: {
    allow_ad_hoc_dig: false,
    allow_ad_hoc_place: false,
    allow_guided_edit: true,
    allow_harvest: false,
    overrides_global_denylist: false,
  },
  resource: {
    allow_ad_hoc_dig: true,
    allow_ad_hoc_place: true,
    allow_guided_edit: true,
    allow_harvest: true,
    overrides_global_denylist: true,
  },
  marker: {
    allow_ad_hoc_dig: true,
    allow_ad_hoc_place: true,
    allow_guided_edit: false,
    allow_harvest: true,
    overrides_global_denylist: false,
  },
};

/** Blocks that must not be broken inside a protect profile (additive to resolver). */
const PROTECTED_BY_PROFILE = {
  base: new Set([
    'cobblestone', 'grass_block', 'dirt',
    'oak_planks', 'birch_planks', 'spruce_planks', 'dark_oak_planks',
    'oak_log', 'birch_log', 'spruce_log',
    'oak_fence', 'birch_fence', 'oak_door', 'glass', 'glass_pane',
    'oak_stairs', 'cobblestone_stairs', 'oak_slab', 'cobblestone_slab',
  ]),
  farm: new Set(['oak_fence', 'birch_fence', 'oak_log', 'dirt', 'grass_block', 'oak_planks']),
  dock: new Set(['oak_planks', 'oak_log', 'oak_fence']),
  mine: new Set(),
};

/** OK to break even inside protect profile (e.g. torch relight, harvest). */
const TOLERATED_BY_PROFILE = {
  base: new Set(['torch', 'wall_torch']),
  farm: new Set(['wheat', 'carrots', 'potatoes', 'beetroots', 'melon', 'pumpkin', 'kelp']),
  dock: new Set(['seagrass', 'kelp']),
  mine: new Set(),
};

export const PROFILES = PROFILE_DEFAULT_INTENT;

/**
 * Compute default capabilities for a profile+intent pair. Pure function;
 * does NOT preserve any region-level overrides.
 */
function defaultCapabilities(profile, intent) {
  const caps = { ...CAPABILITIES_BY_INTENT[intent] };
  if (profile === 'farm') caps.allow_harvest = true;
  return caps;
}

/**
 * Normalize a region: fill profile/intent, recompute capabilities from
 * profile+intent (so changing intent via sign upsert refreshes caps).
 *
 * @param {object} region
 * @returns {object}
 */
export function applyProfile(region) {
  const profile = region.profile || 'base';
  const intent = region.intent || PROFILE_DEFAULT_INTENT[profile] || 'protect';
  return {
    ...region,
    intent,
    profile,
    capabilities: defaultCapabilities(profile, intent),
  };
}

/**
 * @param {string} blockName
 * @param {object} region normalized with applyProfile
 */
export function isProtectedInRegion(blockName, region) {
  if (!blockName || !region) return false;
  if (region.intent === 'marker' || region.intent === 'resource') return false;
  const profile = region.profile || 'base';
  const tolerated = TOLERATED_BY_PROFILE[profile] || new Set();
  if (tolerated.has(blockName)) return false;
  const protectedSet = PROTECTED_BY_PROFILE[profile] || PROTECTED_BY_PROFILE.base;
  return protectedSet.has(blockName);
}

export function isToleratedBreak(blockName, region) {
  if (!blockName || !region) return false;
  const profile = region.profile || 'base';
  const tolerated = TOLERATED_BY_PROFILE[profile] || new Set();
  return tolerated.has(blockName);
}

export function getDefaultIntentForProfile(profile) {
  return PROFILE_DEFAULT_INTENT[profile] || 'protect';
}
