/**
 * Region profile defaults: intent, capabilities, and block tolerances.
 */

import { isStructural as materialsIsStructural } from '../materials.js';

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

/**
 * Built/structural blocks — never dig under any grant (including WORKSITE_GRANT).
 * Subset of PROTECTED_BY_PROFILE: omits natural-terrain materials (dirt,
 * grass_block, cobblestone) that a cleanup card legitimately harvests from
 * orphan pillars. Add a material here only if mining it indicates the bot
 * is demolishing intentional infrastructure.
 */
const STRUCTURAL_BY_PROFILE = {
  base: new Set([
    'oak_planks', 'birch_planks', 'spruce_planks', 'dark_oak_planks',
    'oak_log', 'birch_log', 'spruce_log',
    'oak_fence', 'birch_fence', 'oak_door', 'glass', 'glass_pane',
    'oak_stairs', 'cobblestone_stairs', 'oak_slab', 'cobblestone_slab',
  ]),
  farm: new Set(['oak_fence', 'birch_fence', 'oak_log']),
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
 * Operator-level capability overrides: if the region carries an explicit
 * `capability_overrides` object, those keys override the intent defaults
 * after normalization. Use this to grant `allow_ad_hoc_*` inside a
 * protect-intent region without flipping the intent (e.g. an active
 * build site that still wants protect semantics on the perimeter).
 * The overrides survive `applyProfile` invocations — unlike a manually-
 * edited `capabilities` block, which would be normalized away on the
 * next sign upsert or store reload.
 *
 * @param {object} region
 * @returns {object}
 */
export function applyProfile(region) {
  const profile = region.profile || 'base';
  const intent = region.intent || PROFILE_DEFAULT_INTENT[profile] || 'protect';
  const baseCaps = defaultCapabilities(profile, intent);
  const overrides = region.capability_overrides && typeof region.capability_overrides === 'object'
    ? region.capability_overrides
    : null;
  const capabilities = overrides ? { ...baseCaps, ...overrides } : baseCaps;
  return {
    ...region,
    intent,
    profile,
    capabilities,
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

/**
 * Built/structural materials never permitted under a worksite grant.
 *
 * Implementation: defers to the tier_2+ classification in
 * data/materials.json (see bot/lib/runtime/materials.js). The
 * hardcoded STRUCTURAL_BY_PROFILE table above stays as a
 * profile-specific safety net — it includes blocks that should be
 * protected for that profile even if the materials.json classifier
 * doesn't pick them up. This is the C6 migration from the
 * coordinates+materials plan: single source of truth for the
 * structural set, with a fail-safe.
 *
 * @param {string} blockName
 * @param {object} region normalized with applyProfile
 */
export function isStructuralInRegion(blockName, region) {
  if (!blockName || !region) return false;
  if (region.intent === 'marker' || region.intent === 'resource') return false;
  // Primary: materials.json tier_2+ classification.
  if (materialsIsStructural(blockName)) return true;
  // Fail-safe: profile-specific hardcoded set (catches anything the
  // tier classifier might miss for a given profile).
  const profile = region.profile || 'base';
  const structural = STRUCTURAL_BY_PROFILE[profile] || STRUCTURAL_BY_PROFILE.base;
  return structural.has(blockName);
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
