/**
 * Central services container.
 *
 * One path to state (`services.state`), one path to each helper bundle.
 * Factories receive `services` and destructure what they need; tests build a
 * mock with `createMockServices()` (lib/server/mock-services.js).
 *
 * Phase 1: `services.state` is the flat `ctx` from createBotState. Phase 3
 * swaps that for bounded slices (`state.world.bot`, `state.social.chatLog`,
 * …). Consumers should already read through `services.state` so the swap is
 * mechanical.
 *
 * Top-level shape:
 *   config       — loaded config object
 *   state        — flat ctx now, sliced from Phase 3
 *   ensureBot    — () => bot (throws if not connected)
 *   resolver     — { resolveInventoryItem, resolveCraftTarget, resolveBlockQuery }
 *   fairPlay     — line-of-sight + sound + perception suite
 *   spatial      — map + look-around generators
 *   locations    — marks store (load/save/flagStale/...)
 *   personalPois — per-bot POI store (load/save/addPoi/flagTorchMissing/...)
 *   social       — { rememberSocialEvent, getMyName, getNearbyPlayerNames }
 *   utils        — { fmt, posObj, sleep, log, itemStr }
 *   getActions   — late-bound ACTIONS lookup; returns {} until createAllActions
 *                  populates the ref. Cross-action calls go through this.
 */

/**
 * @typedef {Record<string, any>} Services
 * @param {{
 *   config: object,
 *   state: object,
 *   ensureBot: () => any,
 *   resolver: { resolveInventoryItem: Function, resolveCraftTarget: Function, resolveBlockQuery: Function },
 *   craft: { resolveCraftItemName: Function, buildCraftPlan: Function, bestRecipeForInventory: Function },
 *   fairPlay: object,
 *   spatial: object,
 *   locations: object,
 *   social: { rememberSocialEvent: Function, getMyName: Function, getNearbyPlayerNames: Function },
 *   utils: { fmt: Function, posObj: Function, sleep: Function, log: Function, itemStr: Function },
 *   getActions?: () => Record<string, Function>,
 * }} parts
 * @returns {Services}
 */
export function createServices(parts) {
  const {
    config,
    state,
    ensureBot,
    resolver,
    craft,
    fairPlay,
    spatial,
    locations,
    personalPois,
    social,
    utils,
    getActions = () => ({}),
  } = parts;
  return {
    config,
    state,
    ensureBot,
    resolver,
    craft,
    fairPlay,
    spatial,
    locations,
    personalPois,
    social,
    utils,
    getActions,
  };
}

/** Top-level keys a real services container must expose. Used by mock-services
 *  for the parity check, and exported so tests don't have to re-derive it. */
export const SERVICES_KEYS = Object.freeze([
  'config',
  'state',
  'ensureBot',
  'resolver',
  'craft',
  'fairPlay',
  'spatial',
  'locations',
  'personalPois',
  'social',
  'utils',
  'getActions',
]);

/** Required keys per service bundle. Used by mock-services for parity tests
 *  on nested objects. State slice keys are handled separately (Phase 3). */
export const SERVICE_BUNDLE_KEYS = Object.freeze({
  resolver: ['resolveInventoryItem', 'resolveCraftTarget', 'resolveBlockQuery'],
  craft: ['resolveCraftItemName', 'buildCraftPlan', 'bestRecipeForInventory', 'pickRecipeFromRecipes', 'pickRecipeForCraft'],
  social: ['rememberSocialEvent', 'getMyName', 'getNearbyPlayerNames'],
  utils: ['fmt', 'posObj', 'sleep', 'log', 'itemStr'],
});
