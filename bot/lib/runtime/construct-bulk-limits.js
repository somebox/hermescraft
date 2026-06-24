/**
 * Per-call bulk volume caps — construct clips to workset before counting.
 */

import { fail } from '../shared/action-contract.js';
import { normalizeInclusiveBox6 } from './coordinates.js';

export const BULK_MAX_CELLS_PER_CALL = 32;

/**
 * @param {object} p
 * @param {string} p.opName e.g. fill, dig_area
 * @param {number} p.total cells in requested box
 * @param {number} [p.mutableCount] after construct clip (required when inConstruct)
 * @param {boolean} p.inConstruct
 * @param {object} p.box { x1, y1, z1, x2, y2, z2 }
 * @returns {import('../shared/action-contract.js').ActionFail|null}
 */
export function checkBulkVolumeLimit({ opName, total, mutableCount, inConstruct, box }) {
  const max = BULK_MAX_CELLS_PER_CALL;
  const { x1, y1, z1, x2, y2, z2 } = box;
  const norm = normalizeInclusiveBox6({ x1, y1, z1, x2, y2, z2 });
  const { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } } = norm;

  if (inConstruct) {
    const n = mutableCount ?? 0;
    if (n > max) {
      return fail(
        'AREA_TOO_LARGE',
        `mc ${opName}: ${n} construct-eligible blocks is too many — the per-call limit is ${max} after workset clip (${total} in box).`,
        {
          observed_state: {
            requested_volume: total,
            mutable_volume: n,
            max_volume: max,
            x1, y1, z1, x2, y2, z2,
          },
          next_action_hint: `Pick a sub-box with ≤${max} workset cells and repeat.`,
          retry_safe: false,
        },
      );
    }
    return null;
  }

  if (total > max) {
    return fail(
      'AREA_TOO_LARGE',
      `mc ${opName}: ${total} blocks is too many — the per-call limit is ${max}. Run ${Math.ceil(total / max)} smaller calls instead, each with ≤${max} blocks (e.g. a ${Math.min(maxX - minX + 1, 4)}×${Math.min(maxY - minY + 1, 4)}×${Math.min(maxZ - minZ + 1, 2)} slice).`,
      {
        observed_state: { requested_volume: total, max_volume: max, x1, y1, z1, x2, y2, z2 },
        next_action_hint: `Pick a sub-box with ≤${max} blocks and repeat for the rest.`,
        retry_safe: false,
      },
    );
  }
  return null;
}
