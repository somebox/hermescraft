/**
 * Assembles all action handlers from domain modules into one ACTIONS map.
 */
import { createMovementActions } from './movement.js';
import { createMiningActions } from './mining.js';
import { createCraftingActions } from './crafting.js';
import { createCombatActions } from './combat.js';
import { createWorldActions } from './world.js';
import { createContainerActions } from './containers.js';

export function createAllActions(deps) {
  const base = {
    ...createMovementActions(deps),
    ...createMiningActions(deps),
    ...createWorldActions(deps),
    ...createContainerActions(deps),
  };

  // Combat and crafting modules reference ACTIONS (for combo/discover),
  // so we pass the partial map in and merge after.
  const withSelf = { ...deps, ACTIONS: base };
  const combat = createCombatActions(withSelf);
  const crafting = createCraftingActions(withSelf);

  Object.assign(base, combat, crafting);
  return base;
}
