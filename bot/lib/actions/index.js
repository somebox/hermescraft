/**
 * Assembles all action handlers from domain modules into one ACTIONS map.
 */
import { createMovementActions } from './movement.js';
import { createMiningActions } from './mining.js';
import { createCraftingActions } from './crafting.js';
import { createCombatActions } from './combat.js';
import { createWorldActions } from './world.js';
import { createContainerActions } from './containers.js';
import { createFarmingActions } from './farming.js';
import { createAnimalsActions } from './animals.js';
import { createWaterActions } from './water.js';

export function createAllActions(deps) {
  const base = {
    ...createMovementActions(deps),
    ...createMiningActions(deps),
    ...createWorldActions(deps),
    ...createContainerActions(deps),
  };

  // Combat, crafting, farming, animals, world, and movement modules reference
  // ACTIONS (for combo/discover, dig_area, pickup, mc move calling mc through,
  // harvest reusing pickup, and shear/hunt reusing pickup), so we pass the
  // partial map in and merge after.
  const withSelf = { ...deps, ACTIONS: base };
  const combat = createCombatActions(withSelf);
  const crafting = createCraftingActions(withSelf);
  const world = createWorldActions(withSelf);
  const movement = createMovementActions(withSelf);
  const farming = createFarmingActions(withSelf);
  const animals = createAnimalsActions(withSelf);
  const water = createWaterActions(withSelf);

  Object.assign(base, combat, crafting, world, movement, farming, animals, water);
  return base;
}
