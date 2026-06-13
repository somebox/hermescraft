/**
 * Assembles all action handlers from domain modules into one ACTIONS map.
 *
 * The actions-manifest.test.js asserts every `create*Actions` factory under
 * `bot/lib/actions/` is wired here. Skip-prefix: filenames starting with `_`
 * are excluded (helpers, not factories).
 */
import { createMovementActions } from './movement.js';
import { createMiningActions } from './mining.js';
import { createCraftingActions } from './crafting.js';
import { createCombatActions } from './combat.js';
import { createInventoryActions } from './inventory.js';
import { createBuildingActions } from './building.js';
import { createExcavationActions } from './excavation.js';
import { createInteractionActions } from './interaction.js';
import { createLifecycleActions } from './lifecycle.js';
import { createQueriesActions } from './queries.js';
import { createContainerActions } from './containers.js';
import { createMarksActions } from './marks.js';
import { createPersonalPoiActions } from './personal-pois.js';
import { createFurnaceActions } from './furnace.js';
import { createTeamActions } from './team.js';
import { createRemindersActions } from './reminders.js';
import { createFarmingActions } from './farming.js';
import { createAnimalsActions } from './animals.js';
import { createWaterActions } from './water.js';
import { createRegionsObserveActions } from './regions/observe.js';
import { createRegionsMutateActions } from './regions/create.js';
import { createMinesActions } from './mines/index.js';
import { createRegionsCheckActions } from './regions/check.js';
import { createBlueprintActions } from './blueprints/index.js';
import { createPlaybookActions } from './playbooks.js';
import { createReachActions } from './movement/reach.js';
import { createVerifyActions } from './verify.js';
import { createFeedbackActions } from './feedback.js';
import { createWaypointActions } from './waypoint.js';

export function createAllActions(deps) {
  // Modules already on services use deps.services; modules still on the
  // legacy deps bag use deps directly. Single instantiation per module
  // (no Phase-0 double-build) — cross-action calls go through
  // services.getActions() which is late-bound by server.js to actionsRef.
  const services = deps.services;

  // Modules already migrated to `services`. These come from the Phase 4 split.
  const inventory = createInventoryActions(services);
  const building = createBuildingActions(services);
  const excavation = createExcavationActions(services);
  const interaction = createInteractionActions(services);
  const lifecycle = createLifecycleActions(services);
  const queries = createQueriesActions(services);
  const crafting = createCraftingActions(services);
  const verify = createVerifyActions(services);
  const feedback = createFeedbackActions(services);

  // Modules still on the legacy deps bag — they will migrate to services in
  // a future sweep. Phase 5 splits containers.js into 5 focused modules but
  // keeps them on deps for now.
  const base = {
    ...inventory,
    ...building,
    ...excavation,
    ...interaction,
    ...lifecycle,
    ...queries,
    ...crafting,
    ...verify,
    ...feedback,
    ...createMovementActions(deps),
    ...createMiningActions(deps),
    ...createContainerActions(deps),
    ...createMarksActions(deps),
    ...createPersonalPoiActions(deps),
    ...createFurnaceActions(deps),
    ...createRegionsObserveActions(deps),
    ...createRegionsMutateActions(deps),
    ...createRegionsCheckActions(deps),
    ...createMinesActions(deps),
    ...createBlueprintActions(deps),
    ...createPlaybookActions(services),
    ...createReachActions(services),
    ...createTeamActions(deps),
    ...createRemindersActions(deps),
    ...createWaypointActions(deps),
  };

  // Combat, farming, animals, movement, water still need `ACTIONS` for
  // cross-action calls until they're migrated. We pass the partial map in
  // and merge after.
  const withSelf = { ...deps, ACTIONS: base };
  const combat = createCombatActions(withSelf);
  const movement = createMovementActions(withSelf);
  const farming = createFarmingActions(withSelf);
  const animals = createAnimalsActions(withSelf);
  const water = createWaterActions(withSelf);

  Object.assign(base, combat, movement, farming, animals, water);
  return base;
}
