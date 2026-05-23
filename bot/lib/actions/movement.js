/** @size-exempt: goto / goto_near / move share pathfinder + stall recovery */
/**
 * Barrel shim — implementation lives under `./movement/` (preserve `createMovementActions`
 * spelling for manifests and HTTP wiring).
 */

import { createMovementActions as _createMovementActions } from './movement/index.js';

export { refuseWaterRouteWithoutBoat } from './movement/index.js';

export function createMovementActions(opts) {
  return _createMovementActions(opts);
}
