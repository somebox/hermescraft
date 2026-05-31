/**
 * Test-time services container.
 *
 * `createMockServices(overrides)` returns a structurally-parity-matching mock
 * of the real services container (see services.js). Every function-typed
 * field is a no-op stub; state defaults to the real `createBotState` output
 * so the mock can't drift from production state shape.
 *
 * Overrides deep-merge into the default at leaf granularity:
 *
 *   createMockServices({ state: { botReady: true } })  // patches one field
 *   createMockServices({ utils: { sleep: customSleep } })  // overrides one stub
 *   createMockServices({ getActions: () => ({ pickup: async () => ok() }) })
 *
 * The parity test in bot/test/foundation.test.js asserts bidirectional key
 * equality with `createServices()` so drift in either direction breaks the
 * build (real-services gains a field → mock must add it; mock has a stale
 * key → mock must drop it).
 */

import { createBotState } from './state.js';
import { SERVICES_KEYS, SERVICE_BUNDLE_KEYS } from './services.js';

/** Stub config — minimum surface to drive createBotState + reactive defaults. */
function defaultMockConfig() {
  return {
    mc: { host: 'localhost', port: 25565, username: 'MockBot', auth: 'offline', connectTimeoutMs: 55000 },
    api: { port: 0 },
    behaviors: {
      fairPlay: true,
      hearAll: false,
      allowParkour: false,
      allowDigInfrastructure: false,
      allowSlowDig: false,
      slowDigTicksMax: 280,
      chatMinIntervalMs: 2500,
      digDropScanMs: 300,
      reactiveOn: false,
      combatSkill: null,
    },
    papermcp: { host: 'localhost', port: 0, enabled: false },
    agent: { profile: 'mock', model: null, provider: null },
    logging: { banner: false },
  };
}

const noop = () => undefined;
const asyncNoop = async () => undefined;

function defaultUtils() {
  return {
    fmt: (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v),
    posObj: () => null,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: noop,
    itemStr: (i) => (i ? { name: i.name, count: i.count } : null),
  };
}

function defaultResolver() {
  return {
    resolveInventoryItem: () => ({ ok: false, code: 'unknown', message: 'mock resolver' }),
    resolveCraftTarget: () => ({ ok: false, code: 'unknown', message: 'mock resolver' }),
    resolveBlockQuery: () => ({ ok: false, code: 'unknown', message: 'mock resolver' }),
  };
}

function defaultCraft() {
  return {
    resolveCraftItemName: (raw) => { throw new Error(`mock resolveCraftItemName: ${raw}`); },
    buildCraftPlan: () => ({ ok: false, error: 'mock buildCraftPlan' }),
    bestRecipeForInventory: (recipes) => (recipes && recipes[0]) || null,
    pickRecipeFromRecipes: (recipes) => ({ recipe: recipes?.[0] || null, invocations: 1 }),
    pickRecipeForCraft: () => ({ recipe: null, invocations: 0, plan: null }),
  };
}

function defaultSocial() {
  return {
    rememberSocialEvent: noop,
    getMyName: () => 'MockBot',
    getNearbyPlayerNames: () => [],
  };
}

function defaultFairPlay() {
  return {
    filterEntitiesFairPlay: (xs) => xs || [],
    addSoundEvent: noop,
    fairPlayHarvestTrunkCandidates: () => [],
    findVisibleBlocksByNameWithPhysicalSweep: async () => [],
    entitiesMatchingAfterLookSweep: async () => [],
    reactionDelay: asyncNoop,
    buildSceneSummary: () => ({}),
    hasLineOfSight: () => true,
    eyePosition: () => null,
  };
}

function defaultSpatial() {
  return {
    generateMap: () => null,
    generateLookAround: () => null,
  };
}

function defaultLocations() {
  const store = {};
  return {
    load: () => store,
    save: (next) => { Object.keys(store).forEach((k) => delete store[k]); Object.assign(store, next); },
    flagStale: noop,
    clearStale: noop,
    resolvePlace: () => null,
    normalizeDepositWithdrawItems: (body) => body,
    resolveContainerCoords: () => null,
    buildMarksList: () => [],
  };
}

function defaultBaseServices() {
  const config = defaultMockConfig();
  return {
    config,
    state: createBotState(config),
    ensureBot: () => { throw new Error('mock: bot not connected'); },
    resolver: defaultResolver(),
    craft: defaultCraft(),
    fairPlay: defaultFairPlay(),
    spatial: defaultSpatial(),
    locations: defaultLocations(),
    social: defaultSocial(),
    utils: defaultUtils(),
    getActions: () => ({}),
  };
}

/** Deep merge `src` into `dst` at leaf granularity. Arrays are replaced
 *  wholesale (don't try to merge by index). Functions and primitives at
 *  leaves are replaced. Plain objects are recursed. */
function deepMerge(dst, src) {
  if (src === null || typeof src !== 'object' || Array.isArray(src)) return src;
  if (dst === null || typeof dst !== 'object' || Array.isArray(dst)) {
    return deepMerge({}, src);
  }
  const out = { ...dst };
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v !== 'function'
      && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) {
      out[k] = deepMerge(dst[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * @param {Record<string, any>} [overrides]
 * @returns {Record<string, any>}
 */
export function createMockServices(overrides = {}) {
  return deepMerge(defaultBaseServices(), overrides);
}

/** Exported for the parity test — these are the keys a real services
 *  container must expose, mirrored from services.js. */
export { SERVICES_KEYS, SERVICE_BUNDLE_KEYS };
