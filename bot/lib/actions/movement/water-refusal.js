import { probeRouteCorridor } from '../../server/route-probe.js';

// Task #21 — force the strategic decision. When the agent calls mc move /
// bg_goto over a long distance, sample the route. If it crosses meaningful
// water and the bot has a boat in inventory, REFUSE and tell the agent to
// place_boat + board + sail. circuit-v5 saw Steve walk into a lake 5x in
// a row instead of using either of his two oak_boats.
const LONG_DISTANCE_THRESHOLD = 100;
const WATER_REFUSAL_THRESHOLD = 6; // of 30 samples (corridor)
// F40 (task #66, v55): probe a 20b-wide corridor (centre + ±10b perpendicular
// offsets, 10 samples each = 30 total) instead of a single straight line.
// circuit-v54 forensics: the straight-line probe from base→W1 had 0/30 water
// samples (line runs SW through dry forest), but the pathfinder detoured NW
// into marshland and stranded Steve in 1-deep water. The corridor probe
// catches water on either side of the straight line — typical detour radius.
const CORRIDOR_OFFSET = 10;
const CORRIDOR_SAMPLES_PER_LANE = 10;
const BOAT_INV_NAMES = new Set([
  'oak_boat', 'spruce_boat', 'birch_boat', 'jungle_boat',
  'acacia_boat', 'dark_oak_boat', 'cherry_boat', 'mangrove_boat',
  'bamboo_raft', 'pale_oak_boat',
]);

/**
 * Decide whether to refuse a long-distance navigation that crosses too
 * much water. Pure function — takes a bot-like object and a target.
 * Returns either an envelope (ok:false) to be returned by preflightNav,
 * or null to let the rest of preflight run.
 *
 * Exported so unit tests can exercise the decision logic without booting
 * the rest of createMovementActions.
 */
export function refuseWaterRouteWithoutBoat(b, x, y, z, {
  longDistanceThreshold = LONG_DISTANCE_THRESHOLD,
  waterRefusalThreshold = WATER_REFUSAL_THRESHOLD,
} = {}) {
  try {
    const me = b?.entity?.position;
    if (!me) return null;
    const tx = Number(x), ty = Number(y), tz = Number(z);
    if (![tx, ty, tz].every(Number.isFinite)) return null;
    const dist = Math.hypot(me.x - tx, me.y - ty, me.z - tz);
    if (dist < longDistanceThreshold) return null;
    // F40: corridor probe. 3 parallel lines × 10 samples = 30 total samples
    // covering a 20b-wide corridor. The pathfinder typically detours within
    // this width when avoiding obstacles, so water it would encounter on a
    // detour gets sampled too. Keep the original 30-sample threshold so
    // legitimate dry-corridor trips still pass.
    const probe = probeRouteCorridor(
      b,
      { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) },
      { x: Math.floor(tx), y: Math.floor(ty), z: Math.floor(tz) },
      CORRIDOR_SAMPLES_PER_LANE,
      CORRIDOR_OFFSET,
    );
    const counts = probe?.counts || {};
    const waterCount = Number(counts.water || 0);
    if (waterCount < waterRefusalThreshold) return null;
    const boat = (b.inventory?.items?.() || []).find((i) => BOAT_INV_NAMES.has(i.name));
    const samplesArr = probe?.samples || [];
    const firstWater = samplesArr.find((s) => s.classification === 'water');
    // Find the LAST land/wall sample before the first water — that's the
    // shore-stance coord. Pointing the agent at an actual dry shore cell
    // and letting `mc board` (no-args) handle the boat placement is far
    // more reliable than guessing a place_boat coord deep in the lake.
    // circuit-v5d showed the route_probe's ~25-block sample spacing put
    // every "water" sample well past any adjacent shore, so place_boat
    // hits returned NO_STANCE every time.
    let shoreStance = null;
    for (let i = 1; i < samplesArr.length; i++) {
      const s = samplesArr[i];
      const prev = samplesArr[i - 1];
      if (s.classification === 'water' && (prev.classification === 'land' || prev.classification === 'wall')) {
        shoreStance = prev;
        break;
      }
    }
    if (boat) {
      // v27: route the agent at the gated ferry primitive — mc board /
      // mc sail are deprecated and refuse direct calls. mc sail_to runs
      // the BFS plan + walk_to_entry + mount + sail + disembark + walk_to_target
      // end-to-end and is the only supported boat verb.
      const hint = `mc sail_to ${Math.floor(tx)} ${Math.floor(ty)} ${Math.floor(tz)}`;
      return {
        ok: false,
        error: {
          code: 'BOAT_REQUIRED',
          message: `Route to ${Math.floor(tx)},${Math.floor(ty)},${Math.floor(tz)} crosses ${waterCount}/${probe.sample_count} water samples — refusing to walk. You're holding ${boat.name}. Call \`mc sail_to ${Math.floor(tx)} ${Math.floor(ty)} ${Math.floor(tz)}\` — the ferry primitive plans the route, places the boat, sails, and disembarks at the destination shore. Don't try mc board / mc sail directly; they're gated.`,
          observed_state: {
            route_preview: {
              counts,
              sample_count: probe.sample_count,
              first_water: firstWater ? { x: firstWater.x, y: firstWater.y, z: firstWater.z } : null,
              shore_stance: shoreStance ? { x: shoreStance.x, y: shoreStance.y + 1, z: shoreStance.z } : null,
            },
            distance: Math.round(dist),
            boat_in_inventory: boat.name,
            target: { x: Math.floor(tx), y: Math.floor(ty), z: Math.floor(tz) },
          },
          next_action_hint: hint,
          retry_safe: false,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'WATER_ROUTE_NEEDS_BOAT',
        message: `Route to ${Math.floor(tx)},${Math.floor(ty)},${Math.floor(tz)} crosses ${waterCount}/${probe.sample_count} water samples and you have no boat. Craft one with \`mc craft oak_boat\` (needs 5 oak_planks), then call \`mc sail_to ${Math.floor(tx)} ${Math.floor(ty)} ${Math.floor(tz)}\`. Don't try to swim — you'll drown.`,
        observed_state: {
          route_preview: { counts, sample_count: probe.sample_count },
          distance: Math.round(dist),
          target: { x: Math.floor(tx), y: Math.floor(ty), z: Math.floor(tz) },
        },
        next_action_hint: `mc craft oak_boat`,
        retry_safe: false,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'ROUTE_PROBE_FAILED',
        message: `Route probe to ${Math.floor(Number(x))},${Math.floor(Number(y))},${Math.floor(Number(z))} failed (${err?.message || err}) — retry mc goto or use mc sail_to if crossing water.`,
        observed_state: {
          target: { x: Math.floor(Number(x)), y: Math.floor(Number(y)), z: Math.floor(Number(z)) },
          probe_error: String(err?.message || err),
        },
        next_action_hint: `mc goto ${Math.floor(Number(x))} ${Math.floor(Number(y))} ${Math.floor(Number(z))}`,
        retry_safe: true,
      },
    };
  }
}
