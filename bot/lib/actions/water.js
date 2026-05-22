/** @size-exempt: fishing + boats + buckets (Phase 4 absorbed bucket_*) */
/**
 * Water-related verbs (Sprint 10): mc fish / place_boat / board / disembark.
 *
 * Fishing uses mineflayer's bot.fish() which handles the cast/bite/reel cycle
 * via packet sniffing. Boats are placed via bot.placeEntity (which spawns a
 * boat entity from a held boat item) and mounted with bot.mount/dismount.
 */

import { Vec3 } from 'vec3';
import { executeServerCommand, paperMcpConfig } from '../runtime/paper-mcp.js';
import { findAdjustedTarget } from './_nav-helpers.js';
import { planWaterRoute } from '../runtime/water-route.js';

const BOAT_NAMES = new Set([
  'oak_boat', 'spruce_boat', 'birch_boat', 'jungle_boat',
  'acacia_boat', 'dark_oak_boat', 'cherry_boat', 'mangrove_boat',
  'bamboo_raft', 'pale_oak_boat',
]);

// Boat entity detector. Paper 1.21+ sometimes delivers boat entities with
// e.name=null but e.type='oak_boat' (vs. the mob-style entities where
// e.name is populated). Checking both fields covers both flavours;
// circuit-v5 (2026-05-21) hit this exact case — server confirmed a boat
// summon but our entity-name-only filter dropped it, so place_boat
// reported PLACE_FAILED even though the boat was visible 1.7 blocks away.
function isBoatEntity(e) {
  if (!e) return false;
  const n = e.name || '';
  const t = e.type || '';
  if (n.endsWith('_boat') || n === 'boat' || n === 'bamboo_raft') return true;
  if (t.endsWith('_boat') || t === 'boat' || t === 'bamboo_raft') return true;
  if (BOAT_NAMES.has(n) || BOAT_NAMES.has(t)) return true;
  return false;
}

/**
 * v26 deprecation gate. Direct external calls to mc sail / mc board /
 * mc place_boat are footguns: agents fall back to them when sail_to
 * returns a partial route, then crash through obstacles BFS deliberately
 * routed around. Refuse external calls with a USE_SAIL_TO_INSTEAD
 * redirect. sail_to calls these methods in-process with _from_sail_to:true
 * to bypass — the bodyFn in cli/registry.mjs never includes that key, so
 * HTTP /action/sail etc. can't spoof it from the agent's CLI surface.
 *
 * mc disembark stays open — it's a legitimate recovery verb (force-free
 * the bot from any vehicle without needing a destination).
 */
function useSailToInsteadRefusal(verb) {
  return {
    ok: false,
    error: {
      code: 'USE_SAIL_TO_INSTEAD',
      message: `Direct mc ${verb} is deprecated. For water journeys call mc sail_to X Y Z — the body handles place_boat / board / sail / disembark internally with BFS routing, partial-journey support, and resumability. Don't compose this primitive manually.`,
      next_action_hint: 'mc sail_to <target_x> <target_y> <target_z>',
      retry_safe: false,
    },
  };
}

const FISH_ROD_NAMES = ['fishing_rod'];

// Items that can come out of vanilla fishing (fish, junk, treasure).
const FISH_LOOT = [
  // fish
  'cod', 'salmon', 'pufferfish', 'tropical_fish',
  // junk
  'bowl', 'leather', 'leather_boots', 'rotten_flesh', 'stick',
  'string', 'water_bottle', 'bone', 'ink_sac', 'tripwire_hook',
  // treasure
  'enchanted_book', 'name_tag', 'nautilus_shell', 'saddle',
  'fishing_rod', 'bow', 'lily_pad',
];

const REACH = 4.5;

export function createWaterActions(deps) {
  const { ctx, ensureBot, goals, sleep, log, getMyName, ACTIONS } = deps;

  const inventoryAt = (b) =>
    b.inventory.items().reduce((acc, it) => {
      acc[it.name] = (acc[it.name] || 0) + it.count;
      return acc;
    }, /** @type {Record<string, number>} */ ({}));

  function findRod(b) {
    for (const name of FISH_ROD_NAMES) {
      const it = b.inventory.items().find((i) => i.name === name);
      if (it) return it;
    }
    return null;
  }

  function findBoatItem(b) {
    for (const it of b.inventory.items()) {
      if (BOAT_NAMES.has(it.name)) return it;
    }
    return null;
  }

  // Find the closest water source block within `radius` of the bot. Prefers
  // blocks with sky access (Java needs open sky for treasure but fish work
  // regardless). Returns the Block or null.
  function findWaterNearby(b, radius = 6) {
    const me = b.entity.position.floored();
    let best = null;
    let bestDist = Infinity;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dy = -2; dy <= 2; dy++) {
          const p = me.offset(dx, dy, dz);
          const blk = b.blockAt(p);
          if (!blk || blk.name !== 'water') continue;
          // Only source blocks (level=0) for fishing. Flowing water works
          // but is unreliable for the bobber.
          const props = blk.getProperties?.() || {};
          if (props.level !== undefined && Number(props.level) !== 0) continue;
          const d = me.distanceTo(p);
          if (d < bestDist) { best = blk; bestDist = d; }
        }
      }
    }
    return best;
  }

  return {
    /**
     * Cast a fishing rod into nearby water, wait for a bite, reel in,
     * and pick up the drops. Returns the inventory delta as the catch.
     * Action contract: NO_ROD, NO_WATER, FISH_TIMEOUT, INTERRUPTED.
     */
    async fish({ timeout_seconds = 60 } = {}) {
      const b = ensureBot();

      const rod = findRod(b);
      if (!rod) {
        return { ok: false, error: {
          code: 'NO_ROD',
          message: 'No fishing_rod in inventory.',
          observed_state: { rods: b.inventory.items().filter((i) => i.name.includes('rod')).map((i) => i.name) },
          retry_safe: false,
        }};
      }

      const water = findWaterNearby(b, 6);
      if (!water) {
        return { ok: false, error: {
          code: 'NO_WATER',
          message: 'No water source within 6 blocks. Move next to a pond or lake.',
          retry_safe: false,
        }};
      }

      // Empirical fishing geometry: with the bot's default pitch (~0),
      // a cast bobber flies ~8-9 blocks horizontally before hitting water
      // level. We need the bot positioned such that the bobber LANDS in
      // the pond. Pathfind to a spot ~7 blocks from the water target so
      // the natural cast arc lands inside the pond rather than past it.
      const CAST_DISTANCE = 7;
      const wx = water.position.x + 0.5;
      const wz = water.position.z + 0.5;
      const wy = water.position.y;
      // Pick a stance point on the line from the water toward the bot's
      // current position, at CAST_DISTANCE blocks from the water center.
      const me0 = b.entity.position;
      let toBotX = me0.x - wx;
      let toBotZ = me0.z - wz;
      const toBotLen = Math.max(0.001, Math.hypot(toBotX, toBotZ));
      const stanceX = Math.round(wx + (toBotX / toBotLen) * CAST_DISTANCE);
      const stanceZ = Math.round(wz + (toBotZ / toBotLen) * CAST_DISTANCE);
      const stanceY = wy + 1; // stand on the block adjacent to the pond, water_y+1
      try {
        await b.pathfinder.goto(new goals.GoalNear(stanceX, stanceY, stanceZ, 1));
      } catch {
        return { ok: false, error: { code: 'OUT_OF_RANGE', message: 'pathfind to fishing stance failed', retry_safe: false }};
      }

      try { await b.equip(rod, 'hand'); } catch (err) {
        return { ok: false, error: { code: 'INTERRUPTED', message: `equip rod failed: ${err.message}`, retry_safe: true }};
      }

      // Aim at the water with default-ish pitch (horizon) — the bobber's
      // natural arc will land ~8 blocks ahead, in the pond.
      const me = b.entity.position;
      const dx = wx - me.x;
      const dz = wz - me.z;
      const yaw = Math.atan2(-dx, dz);
      const pitch = 0; // horizontal; the bobber's gravity handles the rest
      try { await b.look(yaw, pitch, true); } catch {}
      await sleep(500);
      log(`[fish] stance=(${stanceX},${stanceY},${stanceZ}) yaw=${yaw.toFixed(2)} pitch=${pitch.toFixed(2)}`);

      const before = inventoryAt(b);

      // bot.fish() casts and awaits the bite cycle; resolves on catch.
      // We race it against a timeout because some Paper versions occasionally
      // miss the bite-particle packet.
      const fishPromise = b.fish().catch((err) => ({ _err: err }));
      const timeoutPromise = sleep(timeout_seconds * 1000).then(() => ({ _timeout: true }));
      const winner = await Promise.race([fishPromise, timeoutPromise]);

      if (winner && winner._timeout) {
        // Cast may still be pending — try to reel in manually.
        try { b.activateItem(); } catch {}
        await sleep(500);
        return { ok: false, error: {
          code: 'FISH_TIMEOUT',
          message: `No bite within ${timeout_seconds}s. Try again or move to a sunnier spot (rain + open sky speed up bites).`,
          retry_safe: true,
        }};
      }
      if (winner && winner._err) {
        return { ok: false, error: {
          code: 'INTERRUPTED',
          message: `fishing cancelled: ${winner._err.message}`,
          retry_safe: true,
        }};
      }

      // Vanilla reels the catch directly into the player's inventory — no
      // item entity to collect. The inventory update comes via a separate
      // packet a tick or two after the reel; wait long enough to see it.
      await sleep(1500);

      const after = inventoryAt(b);
      const gained = {};
      for (const name of FISH_LOOT) {
        const delta = (after[name] || 0) - (before[name] || 0);
        if (delta > 0) gained[name] = delta;
      }
      // Also surface any unexpected item we didn't enumerate.
      for (const [name, count] of Object.entries(after)) {
        if (gained[name]) continue;
        const delta = count - (before[name] || 0);
        if (delta > 0 && !FISH_LOOT.includes(name)) gained[name] = delta;
      }

      if (Object.keys(gained).length === 0) {
        return { ok: false, error: {
          code: 'UNCHANGED',
          message: 'Reeled in but no item appeared in inventory — drop may have despawned or fallen out of reach.',
          retry_safe: true,
        }};
      }

      return {
        ok: true,
        command: 'fish',
        data: {
          caught: gained,
          water_block: [Math.floor(water.position.x), Math.floor(water.position.y), Math.floor(water.position.z)],
        },
      };
    },

    /**
     * Place a boat at water cell (x, y, z). Requires any *_boat item.
     * The cell at (x, y, z) must be water (any level) — vanilla will
     * spawn the boat on the water surface.
     * Action contract: NO_BOAT, NO_WATER_AT_TARGET, OUT_OF_RANGE.
     */
    async place_boat({ x, y, z, _from_sail_to } = {}) {
      if (!_from_sail_to) return useSailToInsteadRefusal('place_boat');
      const b = ensureBot();
      const targetPos = new Vec3(Number(x), Number(y), Number(z));

      const boat = findBoatItem(b);
      if (!boat) {
        return { ok: false, error: {
          code: 'NO_BOAT',
          message: 'No boat in inventory. Craft one with 5 planks (any overworld wood).',
          observed_state: { boats: b.inventory.items().filter((i) => i.name.endsWith('_boat') || i.name === 'bamboo_raft').map((i) => i.name) },
          retry_safe: false,
        }};
      }

      let refBlock = b.blockAt(targetPos);
      if (!refBlock) {
        return { ok: false, error: { code: 'NO_BLOCK', message: `No block at (${x},${y},${z})`, retry_safe: false }};
      }
      // Task #7 self-adjust upgraded for circuit-v5d: find a SHORE-water
      // cell — water that has at least one dry cardinal stance at +1y.
      // The original predicate just checked "is water"; that often picked
      // open-water deep in a lake, and the dry-stance check downstream
      // returned NO_STANCE. Now we prefer cells where place_boat will
      // actually succeed.
      const isWater = (blk) => !!blk && (blk.name === 'water' || blk.name === 'flowing_water');
      const hasDryStance = (px, py, pz) => {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const stance = b.blockAt(new Vec3(px + dx, py + 1, pz + dz));
          const under = b.blockAt(new Vec3(px + dx, py, pz + dz));
          if (stance && (stance.name === 'air' || stance.boundingBox === 'empty')
              && under && under.boundingBox === 'block' && !isWater(under)) {
            return true;
          }
        }
        return false;
      };
      const isShoreWater = (bot, px, py, pz) => {
        if (!bot?.blockAt) return false;
        const blk = bot.blockAt(new Vec3(px, py, pz));
        if (!isWater(blk)) return false;
        return hasDryStance(px, py, pz);
      };
      let adjustedTarget = null;
      // First-try: the exact requested cell. If it's already shore-water,
      // no adjustment needed.
      if (!isShoreWater(b, Number(x), Number(y), Number(z))) {
        // Search ~6 blocks for the nearest shore-water. Larger radius than
        // task #7's 3 because the agent's hint (from route_probe) is often
        // off by several cells when the route's sample spacing is wide.
        const adj = findAdjustedTarget(b, isShoreWater, Number(x), Number(y), Number(z), 6);
        if (adj) {
          adjustedTarget = adj;
          refBlock = b.blockAt(new Vec3(adj.x, adj.y, adj.z));
          targetPos.x = adj.x; targetPos.y = adj.y; targetPos.z = adj.z;
          log(`[place_boat] adjusted to shore-water (${adj.x},${adj.y},${adj.z}) from (${x},${y},${z}) — distance ${adj.distance}`);
        } else {
          // No shore-water within 6. Fall back to plain water-cell search
          // — the bot might already be IN the water (from-water mode below
          // handles that without needing a shore).
          const fallback = findAdjustedTarget(
            b,
            (bot, px, py, pz) => isWater(bot?.blockAt && bot.blockAt(new Vec3(px, py, pz))),
            Number(x), Number(y), Number(z),
            3,
          );
          if (!fallback) {
            return { ok: false, error: {
              code: 'NO_WATER_AT_TARGET',
              message: `Block at (${x},${y},${z}) is "${refBlock.name}" and no water within 3 blocks — boats need water.`,
              observed_state: { target_block: refBlock.name, searched_radius: 6 },
              retry_safe: false,
            }};
          }
          adjustedTarget = fallback;
          refBlock = b.blockAt(new Vec3(fallback.x, fallback.y, fallback.z));
          targetPos.x = fallback.x; targetPos.y = fallback.y; targetPos.z = fallback.z;
          log(`[place_boat] no shore-water in radius — falling back to nearest water (${fallback.x},${fallback.y},${fallback.z})`);
        }
      }

      // Stance selection has TWO modes:
      //   - Bot is in water (foot_in_water=true): place boat AT the bot's
      //     current cell. In MC you can right-click a boat item while
      //     submerged and it spawns on the water surface around you. No
      //     dry stance needed. This is the "rescue from open ocean" path
      //     surfaced in circuit-v1 — Steve was deep in water with no
      //     shore in 4 blocks, place_boat returned NO_STANCE 11 times.
      //   - Bot is on land: original behaviour, find dry stance adjacent
      //     to the target water cell, pathfind to it.
      const botFootPos = b.entity.position.floored();
      const botFootBlock = b.blockAt(botFootPos);
      const inWater = botFootBlock && (botFootBlock.name === 'water' || botFootBlock.name === 'flowing_water');
      let stancePos = null;
      let placedFromWater = false;
      if (inWater) {
        // Place AT the bot's current foot cell. The boat spawns on the
        // surface adjacent to the bot. No move needed.
        stancePos = botFootPos;
        placedFromWater = true;
        log(`[place_boat] bot in water at ${botFootPos.x},${botFootPos.y},${botFootPos.z} — placing from-water without dry stance`);
      } else {
        // Land mode: search 4 cardinals at refBlock+1y for dry stance.
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const candidate = refBlock.position.offset(dx, 1, dz);
          const blk = b.blockAt(candidate);
          const under = b.blockAt(candidate.offset(0, -1, 0));
          if (blk && (blk.name === 'air' || blk.boundingBox === 'empty') && under && under.boundingBox === 'block') {
            stancePos = candidate;
            break;
          }
        }
        if (!stancePos) {
          // Open-water target with no dry shore adjacent. Try walking
          // into a water cell adjacent to the target — that puts the bot
          // in the in-water mode (placedFromWater=true) which doesn't
          // need a dry stance. Hit live in circuit-v5d: agent followed
          // the BOAT_REQUIRED hint to a coord deep in the lake; every
          // place_boat returned NO_STANCE because all 4 cardinals were
          // also water.
          let waterAdj = null;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const candidate = refBlock.position.offset(dx, 0, dz);
            const blk = b.blockAt(candidate);
            if (blk && (blk.name === 'water' || blk.name === 'flowing_water')) {
              waterAdj = candidate;
              break;
            }
          }
          if (waterAdj) {
            try {
              await b.pathfinder.goto(new goals.GoalNear(waterAdj.x, waterAdj.y, waterAdj.z, 0));
            } catch {
              return { ok: false, error: {
                code: 'OUT_OF_RANGE',
                message: `No dry stance at (${x},${y},${z}) and pathfinder couldn't reach the water cell next door. The boat target is open water far from any shore.`,
                observed_state: { target: [Number(x), Number(y), Number(z)], adjacent_water: [waterAdj.x, waterAdj.y, waterAdj.z] },
                retry_safe: true,
              }};
            }
            // Re-check whether we landed in water — if so, switch to
            // from-water mode.
            const newFoot = b.entity.position.floored();
            const newFootBlk = b.blockAt(newFoot);
            if (newFootBlk && (newFootBlk.name === 'water' || newFootBlk.name === 'flowing_water')) {
              stancePos = newFoot;
              placedFromWater = true;
              log(`[place_boat] no dry stance — walked into water at ${newFoot.x},${newFoot.y},${newFoot.z}, switching to from-water mode`);
            }
          }
          if (!stancePos) {
            return { ok: false, error: {
              code: 'NO_STANCE',
              message: `No solid block adjacent to water at (${x},${y},${z}) and bot is not in water. Stand at the pond edge, or get into the water to place from there.`,
              observed_state: { target: [Number(x), Number(y), Number(z)], adjacent_water: waterAdj ? [waterAdj.x, waterAdj.y, waterAdj.z] : null },
              retry_safe: false,
            }};
          }
        } else if (b.entity.position.distanceTo(stancePos) > 1.5) {
          try {
            await b.pathfinder.goto(new goals.GoalNear(stancePos.x, stancePos.y, stancePos.z, 1));
          } catch {
            return { ok: false, error: { code: 'OUT_OF_RANGE', message: 'pathfind to stance failed', retry_safe: false }};
          }
        }
      }

      try { await b.equip(boat, 'hand'); } catch (err) {
        return { ok: false, error: { code: 'INTERRUPTED', message: `equip boat failed: ${err.message}`, retry_safe: true }};
      }
      await b.lookAt(refBlock.position.offset(0.5, 1, 0.5));
      await sleep(150);

      // Aim at the water target before placing.
      await b.lookAt(refBlock.position.offset(0.5, 0.5, 0.5), true);
      await sleep(300);

      const knownBoatIds = new Set(
        Object.values(b.entities)
          .filter(isBoatEntity)
          .map((e) => e.id),
      );

      // Right-click with boat in hand while looking at water spawns a boat
      // on the water surface. activateItem sends the use_item packet, BUT
      // Paper 1.21+ silently no-ops boat-from-item placement — same class
      // of bug as bonemeal/shear. We try native first, then fall back to
      // PaperMCP server-side summon + clear-item.
      try { b.activateItem(); } catch {}
      let entity = null;
      const placeDeadline = Date.now() + 3000;
      while (Date.now() < placeDeadline) {
        await sleep(150);
        for (const e of Object.values(b.entities)) {
          if (!e || knownBoatIds.has(e.id)) continue;
          if (isBoatEntity(e)) {
            if (e.position && e.position.distanceTo(refBlock.position) < 4) {
              entity = e;
              break;
            }
          }
        }
        if (entity) break;
      }
      // Native failed (Paper 1.21+ silent no-op). PaperMCP fallback:
      // server-side `clear` the boat item + `summon` an oak_boat (or matching
      // kind) at the water surface.
      let fallback = null;
      if (!entity) {
        const pmcp = paperMcpConfig();
        const username = getMyName?.();
        if (pmcp && username) {
          log(`[place_boat] native silent no-op — PaperMCP fallback`);
          const summonName = boat.name; // already namespaced when used in command
          const summonY = refBlock.position.y + 1.0625; // boat sits on water surface
          const r1 = await executeServerCommand(pmcp, `clear ${username} minecraft:${summonName} 1`);
          // RCON: summon in the world the console is bound to (the
          // server's default = minecraft:overworld). Don't hardcode
          // `execute in landfolk-test` — that world only exists in
          // the test fixture and silently fails everywhere else
          // (exp6: every PaperMCP boat fallback returned PLACE_FAILED
          // because the world didn't exist).
          const r2 = await executeServerCommand(pmcp, `summon minecraft:${summonName} ${refBlock.position.x + 0.5} ${summonY} ${refBlock.position.z + 0.5}`);
          if (r1.ok && r2.ok) fallback = 'papermcp_server_side';
          // Paper 1.21 sometimes takes >400ms to push the entity-spawn
          // packet to the client, especially when the bot is in a newly-
          // loaded chunk. Poll for up to 2.5s before giving up; that's
          // generous enough to cover the slow path and still fail fast
          // when the summon genuinely missed.
          const fbDeadline = Date.now() + 2500;
          while (Date.now() < fbDeadline && !entity) {
            await sleep(200);
            for (const e of Object.values(b.entities)) {
              if (!e || knownBoatIds.has(e.id)) continue;
              if (isBoatEntity(e)) {
                if (e.position && e.position.distanceTo(refBlock.position) < 4) {
                  entity = e;
                  break;
                }
              }
            }
          }
        }
      }

      if (!entity) {
        // Surface what was actually tried so the agent can decide whether
        // to retry vs. give up. circuit-v5 hit 5 PLACE_FAILEDs in a row
        // without ever knowing whether the issue was self-adjust, the
        // native cast, or PaperMCP — error said only "may be too shallow".
        return { ok: false, error: {
          code: 'PLACE_FAILED',
          message: 'No boat entity appeared near the target after native cast'
            + (fallback ? ' AND PaperMCP server-side summon' : '')
            + (adjustedTarget ? ` (adjusted to ${adjustedTarget.x},${adjustedTarget.y},${adjustedTarget.z} from ${adjustedTarget.original.x},${adjustedTarget.original.y},${adjustedTarget.original.z})` : '')
            + '. Likely water is too shallow, target is not a water source, or entity-spawn packet did not arrive.',
          observed_state: {
            target: [Number(x), Number(y), Number(z)],
            target_used: [refBlock.position.x, refBlock.position.y, refBlock.position.z],
            ref_block: refBlock.name,
            fallback_attempted: fallback || null,
            ...(adjustedTarget ? { adjusted_target: adjustedTarget } : {}),
          },
          retry_safe: true,
        }};
      }

      return {
        ok: true,
        command: 'place_boat',
        data: {
          boat_kind: boat.name,
          boat_entity_id: entity?.id ?? null,
          boat_position: entity?.position
            ? [Math.floor(entity.position.x), Math.floor(entity.position.y), Math.floor(entity.position.z)]
            : null,
          placed_from_water: placedFromWater,
          ...(adjustedTarget ? { adjusted_target: adjustedTarget } : {}),
          ...(fallback ? { fallback } : {}),
        },
      };
    },

    /**
     * Mount the nearest boat within 5 blocks.
     * Action contract: NO_BOAT, OUT_OF_RANGE, ALREADY_MOUNTED.
     */
    async board({ _from_sail_to } = {}) {
      if (!_from_sail_to) return useSailToInsteadRefusal('board');
      const b = ensureBot();

      // b.vehicle can be stale if the vehicle entity died — mineflayer
      // doesn't always null it out. Treat it as null only if it isn't
      // in the current entity list at all. circuit-v14 (2026-05-22):
      // the previous strict-equality check (b.entities[id] === b.vehicle)
      // could fail when mineflayer rebuilt the entity object after a
      // server-side teleport, causing board to fall through into the
      // "place + mount" path while Steve was still physically mounted —
      // ending in MOUNT_REJECTED / timeout. ID presence is the right
      // signal: server thinks bot is on entity id X, that entity is in
      // b.entities → bot is mounted.
      if (b.vehicle && b.entities[b.vehicle.id]) {
        const live = b.entities[b.vehicle.id];
        // Also check the passenger list as an extra source of truth —
        // matches the isReallyMounted check used later in the mount
        // confirmation path.
        const passengers = Array.isArray(live.passengers) ? live.passengers : [];
        const passengerHasBot = passengers.some((p) => p === b.entity || p?.id === b.entity.id);
        if (passengerHasBot || live === b.vehicle) {
          return { ok: false, error: {
            code: 'ALREADY_MOUNTED',
            message: `Already mounted on ${live.name || 'an entity'}. Call mc disembark before re-boarding.`,
            observed_state: {
              vehicle: live.name,
              vehicle_id: live.id,
              passenger_confirmed: passengerHasBot,
            },
            next_action_hint: 'mc sail_to X Y Z  # already on a boat — sail_to resumes from current mount',
            retry_safe: false,
          }};
        }
      }
      // Clear the stale reference so mineflayer can mount again.
      if (b.vehicle && !b.entities[b.vehicle.id]) {
        b.vehicle = null;
      }

      const me = b.entity.position;
      const findNearbyBoats = () => Object.values(b.entities)
        .filter((e) => e && e.position && isBoatEntity(e))
        .map((e) => ({ ent: e, dist: e.position.distanceTo(b.entity.position) }))
        .filter((x) => x.dist <= 6)
        .sort((a, c) => a.dist - c.dist);

      let boats = findNearbyBoats();
      let autoPlaced = null;

      if (boats.length === 0) {
        // High-level contract (task #19): if no boat is nearby but the bot
        // has a boat item in inventory, auto-find water within 12 blocks,
        // pathfind to it, place the boat, and continue to the mount step.
        const boatItem = b.inventory.items().find((it) => BOAT_NAMES.has(it.name));
        if (!boatItem) {
          return { ok: false, error: {
            code: 'NO_BOAT',
            message: 'No boat within 6 blocks and no boat item in inventory.',
            retry_safe: false,
          }};
        }
        // circuit-v16 (2026-05-22): chunk-dark detection. mineflayer's
        // local chunk cache can silently empty after corrupt packets or
        // server-side teleports — every blockAt/findBlocks then returns
        // null/[]. Pre-fix, mc board reported "no water within 12 blocks"
        // when there were 2529 water cells loaded server-side. Probe a
        // 3×3 footprint under the bot for ANY non-null block; if none,
        // the chunk is dark — surface a CHUNK_NOT_LOADED envelope with
        // a recovery hint instead of misleading the agent.
        const fx = Math.floor(b.entity.position.x);
        const fy = Math.floor(b.entity.position.y);
        const fz = Math.floor(b.entity.position.z);
        let probedBlocks = 0;
        for (let dx = -1; dx <= 1 && probedBlocks === 0; dx++) {
          for (let dz = -1; dz <= 1 && probedBlocks === 0; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
              const blk = b.blockAt(new Vec3(fx + dx, fy + dy, fz + dz));
              if (blk) { probedBlocks++; break; }
            }
          }
        }
        if (probedBlocks === 0) {
          return { ok: false, error: {
            code: 'CHUNK_NOT_LOADED',
            message: `Bot's local chunk cache is empty at (${fx},${fy},${fz}) — mineflayer hasn't received chunk data for this area. This is a known mineflayer / Paper 1.21+ packet-corruption case. Move 1 block (mc move ${fx + 1} ${fy} ${fz}) or wait 2-3s and retry — that usually triggers a chunk resync.`,
            observed_state: {
              bot_position: { x: fx, y: fy, z: fz },
              boat_in_inventory: boatItem.name,
              probed_cells: 27,
              non_null_cells: 0,
            },
            next_action_hint: `mc bg_goto ${fx + 1} ${fy} ${fz}; mc sail_to <target>`,
            retry_safe: true,
          }};
        }
        // Find nearest water source within 12 blocks of the bot.
        const waterPositions = b.findBlocks({
          matching: (blk) => blk && blk.name === 'water' && Number(blk.getProperties?.()?.level ?? 0) === 0,
          maxDistance: 12,
          count: 8,
        });
        if (!waterPositions || waterPositions.length === 0) {
          return { ok: false, error: {
            code: 'NO_BOAT',
            message: 'No boat within 6 blocks and no water within 12 blocks to place one.',
            observed_state: { boat_in_inventory: boatItem.name },
            retry_safe: false,
          }};
        }
        const water = waterPositions[0];
        log(`[board] auto-place: no boat nearby — placing ${boatItem.name} on water at ${water.x},${water.y},${water.z}`);
        const placeRes = await ACTIONS.place_boat({ x: water.x, y: water.y, z: water.z, _from_sail_to: true });
        if (!placeRes?.ok) {
          return { ok: false, error: {
            code: 'AUTO_PLACE_FAILED',
            message: `Tried to auto-place boat at water (${water.x},${water.y},${water.z}) but place_boat failed: ${placeRes?.error?.code || 'unknown'}.`,
            observed_state: { place_boat_error: placeRes?.error, boat_in_inventory: boatItem.name },
            retry_safe: true,
          }};
        }
        autoPlaced = { water: { x: water.x, y: water.y, z: water.z }, boat_item: boatItem.name, place_data: placeRes.data };
        // Re-scan: the newly-placed boat should now be in entity list.
        // circuit-v15 (2026-05-22): PaperMCP place_boat is server-side
        // and the spawn packet can take 1-2s to arrive on the bot's
        // mineflayer client. The old 300ms sleep was racing this —
        // findNearbyBoats returned 0, the call retried, agent looped
        // calling mc board → 4 stacked boats at the same coord. Wait
        // up to 2s with retries (200ms cadence) and prefer the
        // place_boat-reported entity id if available.
        const placedBoatId = placeRes.data?.boat_entity_id;
        let foundBoat = null;
        // circuit-v18: extend to 5s (25 × 200ms) — 2s wasn't enough when
        // mineflayer's chunk data lagged the boat's spawn packet. At
        // iteration 10 (1s mark), nudge a chunk refresh via a 0.1-block
        // RCON TP of the bot, which often forces mineflayer to resync.
        for (let attempt = 0; attempt < 25; attempt++) {
          await sleep(200);
          // First preference: the entity ID place_boat told us about.
          if (placedBoatId && b.entities[placedBoatId] && isBoatEntity(b.entities[placedBoatId])) {
            foundBoat = b.entities[placedBoatId];
            break;
          }
          // Fallback: any nearby boat (might match if id changed on
          // the spawn packet — rare but possible).
          const scan = findNearbyBoats();
          if (scan.length > 0) {
            foundBoat = scan[0].ent;
            break;
          }
          // Mid-retry chunk-refresh kick: at 1s and 2.5s marks, RCON-tp
          // the bot 0.1y to force a position+chunk packet stream. Often
          // the missing spawn packet rides along with the resync.
          if ((attempt === 4 || attempt === 11) && paperMcpConfig()) {
            const pmcp = paperMcpConfig();
            const px = b.entity.position.x;
            const py = b.entity.position.y;
            const pz = b.entity.position.z;
            try {
              await executeServerCommand(pmcp, `tp ${getMyName?.() || 'Steve'} ${px} ${py + 0.05} ${pz}`).catch(() => null);
            } catch {}
          }
        }
        if (!foundBoat) {
          return { ok: false, error: {
            code: 'AUTO_PLACE_FAILED',
            message: 'place_boat succeeded but no boat entity appeared within 6 blocks of the bot after 5s (even after 2 chunk-refresh nudges).',
            observed_state: { place_data: placeRes.data, placed_boat_id: placedBoatId },
            next_action_hint: 'mc nearby # check what boats exist; mc sail_to <target> again to retry',
            retry_safe: true,
          }};
        }
        boats = [{ ent: foundBoat, dist: foundBoat.position.distanceTo(b.entity.position) }];
      }
      const target = boats[0].ent;

      if (target.position.distanceTo(me) > 2.5) {
        try {
          await b.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1));
        } catch {
          return { ok: false, error: { code: 'OUT_OF_RANGE', message: 'pathfind to boat failed', retry_safe: false }};
        }
      }
      // Halt pathfinder + free movement. If we leave the goal active,
      // physics keeps shoving the bot — it slides off the boat or hops
      // into the water while we try to mount.
      try { b.pathfinder.setGoal(null); } catch {}
      for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
        try { b.setControlState(k, false); } catch {}
      }

      // Verifier: a real mount produces a `set_passengers` packet that
      // mineflayer reflects in `<vehicle>.passengers`. Native b.mount()
      // sets b.vehicle locally but doesn't always trigger set_passengers
      // on Paper 1.21+ — bot ends up STANDING ON the boat (gravity then
      // slides it off into the water). The boat's passenger list is the
      // only signal that the server actually mounted us.
      const isReallyMounted = () => {
        const live = b.entities[target.id];
        if (!live) return false;
        const ps = Array.isArray(live.passengers) ? live.passengers : [];
        return ps.some((p) => p === b.entity || p?.id === b.entity.id);
      };

      // Look at the boat before mounting so the use_entity packet has the
      // right facing context. Mirrors what a real player does (crosshair
      // on the boat before right-click). Paired with the useEntity hand-
      // field patch, this is what made native mount finally stick on
      // Paper 1.21+ — prior runs always fell through to PaperMCP ride.
      try { await b.lookAt(target.position.offset(0, 0.5, 0), true); } catch {}
      try { b.mount(target); } catch {}
      await sleep(500);

      let mounted = isReallyMounted();
      let fallback = null;

      if (!mounted) {
        const pmcp = paperMcpConfig();
        const username = getMyName?.();
        if (pmcp && username) {
          log(`[board] native mount didn't stick — PaperMCP ride fallback`);
          // `ride <user> mount <vehicle>` needs a single-entity selector.
          // Pin to the specific target boat's coords with a tiny distance
          // window so we don't grab a different boat that drifted close.
          const tx = Math.floor(target.position.x);
          const ty = Math.floor(target.position.y);
          const tz = Math.floor(target.position.z);
          const cmd = `execute positioned ${tx} ${ty} ${tz} run ride ${username} mount @e[type=oak_boat,sort=nearest,limit=1,distance=..3]`;
          const r = await executeServerCommand(pmcp, cmd).catch((e) => ({ ok: false, error: e?.message }));
          await sleep(600);
          mounted = isReallyMounted();
          if (r && r.ok && mounted) fallback = 'papermcp_server_side';
        }
      }

      if (!mounted) {
        const live = b.entities[target.id];
        return { ok: false, error: {
          code: 'MOUNT_REJECTED',
          message: 'Server did not confirm mount. Boat may be occupied, the bot may be on top of (not in) the boat, or the entity selector missed it.',
          observed_state: {
            bot_pos: [Number(b.entity.position.x.toFixed(2)), Number(b.entity.position.y.toFixed(2)), Number(b.entity.position.z.toFixed(2))],
            boat_pos: live ? [Number(live.position.x.toFixed(2)), Number(live.position.y.toFixed(2)), Number(live.position.z.toFixed(2))] : null,
            boat_passengers: live && Array.isArray(live.passengers) ? live.passengers.length : null,
          },
          retry_safe: true,
        }};
      }

      // circuit-v9: the server-side passenger list confirms the mount, but
      // mineflayer's `b.vehicle` is sometimes null at this point —
      // set_passengers packet hasn't been processed yet, or fell through
      // a mineflayer code path that didn't update b.vehicle. Without a
      // valid b.vehicle, downstream actions (mc sail, mc disembark, the
      // reactive auto_disembark_low_hp trigger) all see "not mounted"
      // even though the server thinks Steve is riding. Force-sync.
      if (!b.vehicle) {
        const live = b.entities[target.id] || target;
        b.vehicle = live;
        log(`[board] forced b.vehicle sync — server says mounted but mineflayer state lagged`);
      }

      return {
        ok: true,
        command: 'board',
        data: {
          vehicle: b.vehicle?.name || target.name,
          vehicle_id: b.vehicle?.id ?? target.id,
          ...(fallback ? { fallback } : {}),
          ...(autoPlaced ? { auto_placed: autoPlaced } : {}),
          boat_position: [Math.floor(target.position.x), Math.floor(target.position.y), Math.floor(target.position.z)],
        },
      };
    },

    /**
     * Sail a mounted boat to (x, y, z). Steers via setControlState
     * while the bot is the rider of an unoccupied boat; vanilla maps
     * the rider's "forward" key to boat propulsion. Stops when the
     * boat is within 2 blocks of the target on the horizontal plane.
     * Action contract: NOT_MOUNTED, NOT_A_BOAT, TIMEOUT, OUT_OF_RANGE.
     */
    async sail({ x, y, z, timeout_seconds, allow_shore_early_exit, _from_sail_to } = {}) {
      if (!_from_sail_to) return useSailToInsteadRefusal('sail');
      const b = ensureBot();
      const target = new Vec3(Number(x), Number(y), Number(z));

      if (!b.vehicle) {
        return { ok: false, error: {
          code: 'NOT_MOUNTED',
          message: 'Bot is not in a vehicle. Run mc board first.',
          retry_safe: false,
        }};
      }
      const boat = b.entities[b.vehicle.id] || b.vehicle;
      const isBoat = boat?.name?.endsWith?.('_boat') || boat?.name === 'boat' || boat?.name === 'bamboo_raft';
      if (!isBoat) {
        return { ok: false, error: {
          code: 'NOT_A_BOAT',
          message: `Mounted on ${boat?.name || 'unknown'}, not a boat.`,
          retry_safe: false,
        }};
      }

      const startPos = boat.position.clone();
      // Auto-scale timeout with horizontal distance: boats travel ~3.75 b/s
      // under both native steering and the tp-step fallback. circuit-v5h
      // showed Steve sailing 480 blocks of a 720-block crossing in two
      // 60s sail calls — each one timed out partway, and the agent had to
      // re-issue. Default to (distance / 3) seconds + 30s overhead,
      // capped at 300s (5 min, same as ACTION_CAPS_MS.goto). Explicit
      // timeout_seconds param still wins for callers that want to override.
      const horizFromStart = Math.hypot(target.x - startPos.x, target.z - startPos.z);
      const autoTimeoutS = Math.min(300, Math.max(60, Math.ceil(horizFromStart / 3) + 30));
      const effectiveTimeoutS = Number.isFinite(Number(timeout_seconds)) && Number(timeout_seconds) > 0
        ? Number(timeout_seconds)
        : autoTimeoutS;
      const deadline = Date.now() + effectiveTimeoutS * 1000;

      // Steering preference: in vanilla, the rider's "forward" key drives
      // the boat. mineflayer's setControlState SHOULD relay this, but on
      // Paper 1.21+ the controller relationship may not be set when the
      // mount was forced via server-side `ride` command — input doesn't
      // propel the boat.
      //
      // Fallback: PaperMCP server-side `tp` of the boat entity. Riders
      // ride along with the vehicle's position, so tp'ing the boat moves
      // the bot too. We step the boat in small increments toward the
      // target so the visual is a "smooth sail," not an instant warp,
      // and so we don't fly the boat through obstacles.

      const pmcp = paperMcpConfig();
      const username = getMyName?.();
      const useTpFallback = !!(pmcp && username);

      // Steering preference order (decided per-sail by probe):
      //   1. native moveVehicle (player_input only) — works if Paper
      //      drives the boat from server-side input. circuit-v7+
      //      confirmed it does NOT on Paper 1.21+.
      //   2. packet steering: moveVehicle + vehicle_move combo. This
      //      mirrors what the vanilla client does — player_input for
      //      the "W key held" signal AND vehicle_move for the
      //      client-authoritative boat position. The server accepts
      //      the position from the rider since the rider owns the
      //      vehicle for the duration of the mount.
      //   3. RCON tp-step: PaperMCP fallback for when neither packet
      //      path propels (e.g. unmounted-state desync). Slower
      //      (~3.75 b/s vs 8 b/s native) and visibly jumpy.
      //
      // CRITICAL: vehicle steering uses bot.moveVehicle(left, forward),
      // NOT bot.setControlState('forward', true). setControlState sends
      // a walking-input packet that the server silently ignores while
      // the bot is mounted.
      const safeMoveVehicle = (l, f) => {
        try { if (typeof b.moveVehicle === 'function') b.moveVehicle(l, f); } catch {}
      };
      // Packet-steering helper: send a vehicle_move packet with the
      // boat's new (x,y,z,yaw) per the 1.21.4 protocol
      // (packet_vehicle_move: x:f64, y:f64, z:f64, yaw:f32, pitch:f32 in degrees).
      // Wraps in a try so any protocol/serializer hiccup is non-fatal —
      // the stall detector + RCON fallback catch genuine failures.
      const safeVehicleMove = (nx, ny, nz, yawRad) => {
        try {
          if (b._client && typeof b._client.write === 'function') {
            b._client.write('vehicle_move', {
              x: nx, y: ny, z: nz,
              yaw: yawRad * 180 / Math.PI,
              pitch: 0,
            });
            // circuit-v17 (2026-05-22): keep mineflayer's local entity
            // positions in sync with what we just told the server. When
            // mounted, the server doesn't push position updates to the
            // bot's own entity — mineflayer keeps bot.entity.position
            // stuck at the mount-start coords. Live in v17: server had
            // Steve at (283,62,-511) after sailing, bot thought Steve was
            // still at (319,62,-567) — 67 blocks stale. Every subsequent
            // mc scene / board / look / find operated on the wrong
            // location. Only sync when we actually sent the packet.
            if (b.entity && b.entity.position) {
              b.entity.position.x = nx;
              b.entity.position.y = ny;
              b.entity.position.z = nz;
            }
            if (b.vehicle && b.vehicle.position) {
              b.vehicle.position.x = nx;
              b.vehicle.position.y = ny;
              b.vehicle.position.z = nz;
            }
          }
        } catch {}
      };
      // Vanilla boat top speed ~8 b/s. 50ms tick → 0.4b per packet.
      const TICK_MS = 50;
      const STEP_PER_TICK = 0.4;

      let nativeWorks = false;
      let packetWorks = false;
      try {
        const yaw0 = Math.atan2(target.x - startPos.x === 0 ? 0 : -(target.x - startPos.x), target.z - startPos.z);
        try { await b.look(yaw0, 0, true); } catch {}
        // Phase 1 probe (700ms): native moveVehicle (player_input only).
        const probe1End = Date.now() + 700;
        while (Date.now() < probe1End) {
          safeMoveVehicle(0, 1);
          await sleep(TICK_MS);
        }
        const liveAfter1 = b.entities[b.vehicle?.id];
        if (liveAfter1 && startPos.distanceTo(liveAfter1.position) > 0.4) {
          nativeWorks = true;
        }
        // Phase 2 probe (700ms): vehicle_move + player_input combo.
        // Only runs if phase 1 didn't propel — circuit-v7+ confirmed
        // Paper 1.21+ needs the client-authoritative position packet.
        if (!nativeWorks) {
          const probe2Start = (b.entities[b.vehicle?.id]?.position || boat.position).clone();
          const probe2End = Date.now() + 700;
          while (Date.now() < probe2End) {
            const live = b.entities[b.vehicle?.id]?.position || probe2Start;
            const dx = target.x - live.x;
            const dz = target.z - live.z;
            const dnorm = Math.hypot(dx, dz) || 1;
            const nx = live.x + (dx / dnorm) * STEP_PER_TICK;
            const nz = live.z + (dz / dnorm) * STEP_PER_TICK;
            safeVehicleMove(nx, live.y, nz, yaw0);
            safeMoveVehicle(0, 1);
            await sleep(TICK_MS);
          }
          const liveAfter2 = b.entities[b.vehicle?.id];
          if (liveAfter2 && probe2Start.distanceTo(liveAfter2.position) > 0.4) {
            packetWorks = true;
            log(`[sail] packet steering (vehicle_move) propels — using packet path`);
          }
        }
        if (!nativeWorks && !packetWorks) safeMoveVehicle(0, 0);
      } catch {}

      let lastDistance = (b.entities[b.vehicle?.id]?.position || boat.position).distanceTo(target);
      let stallTicks = 0;
      let detourAttempts = 0;
      let detourTicksLeft = 0;
      let detourVec = null; // {dx, dz} unit vector during a detour
      const detoursTaken = []; // for the success/error envelope
      const MAX_DETOURS = 5;
      const DETOUR_TICKS = 8; // ~3.2s of perpendicular travel before resuming target heading

      // Pick a detour heading: scan 8 directions from the boat's current
      // XZ at boat Y for the first one that's water and the boat could
      // physically enter. Bias toward bearings near the target direction
      // (small angle wins), but only if there's water there.
      const pickDetourHeading = (here, towardDx, towardDz) => {
        const dirs = [
          { dx: 1, dz: 0 }, { dx: -1, dz: 0 },
          { dx: 0, dz: 1 }, { dx: 0, dz: -1 },
          { dx: 1, dz: 1 }, { dx: 1, dz: -1 },
          { dx: -1, dz: 1 }, { dx: -1, dz: -1 },
        ];
        const tNorm = Math.hypot(towardDx, towardDz) || 1;
        const towardUx = towardDx / tNorm;
        const towardUz = towardDz / tNorm;
        const candidates = [];
        // circuit-v14: probe 8 cells out (was 3). A wooden pier 4 cells
        // wide blocked the original probe in every direction; with an
        // 8-cell horizon we see the open water beyond the pier and
        // pick the side that has the longest open run. Score now
        // tracks waterCount so we prefer the clearest path.
        const PROBE_STEPS = 8;
        for (const d of dirs) {
          const dNorm = Math.hypot(d.dx, d.dz);
          const ux = d.dx / dNorm;
          const uz = d.dz / dNorm;
          // Probe up to PROBE_STEPS cells along this heading at boat Y.
          // Tolerate up to 3 blocked cells in a row (small pier/island)
          // before bailing — we want to see PAST short obstacles.
          let waterCount = 0;
          let consecutiveBlocked = 0;
          for (let step = 1; step <= PROBE_STEPS; step++) {
            const px = Math.floor(here.x + ux * step);
            const py = Math.floor(here.y);
            const pz = Math.floor(here.z + uz * step);
            const foot = b.blockAt(new Vec3(px, py, pz));
            const head = b.blockAt(new Vec3(px, py + 1, pz));
            if (!foot || !head) break;
            const isWater = foot.name === 'water' || foot.name === 'flowing_water';
            const headClear = head.name === 'air' || head.name === 'cave_air' || head.boundingBox === 'empty';
            if (isWater && headClear) {
              waterCount++;
              consecutiveBlocked = 0;
            } else {
              consecutiveBlocked++;
              if (consecutiveBlocked >= 3) break; // pier too wide to bypass via this heading
            }
          }
          if (waterCount >= 3) {
            // Score: prefer directions closer to target heading. dot
            // product of unit vectors → 1 (forward) ... -1 (backward).
            const dot = ux * towardUx + uz * towardUz;
            candidates.push({ dx: ux, dz: uz, dot, waterCount });
          }
        }
        if (candidates.length === 0) return null;
        // Sort: prefer perpendicular-to-forward over backward (avoid
        // undoing progress). We want |dot| close to 0 (perpendicular)
        // OR positive dot (toward target). Tie-break by larger dot.
        candidates.sort((a, c) => {
          // Prefer forward-of-target heading over backward.
          const aFwd = a.dot >= 0 ? 1 : 0;
          const bFwd = c.dot >= 0 ? 1 : 0;
          if (aFwd !== bFwd) return bFwd - aFwd;
          // Then prefer headings with more open water in the probe range.
          if (c.waterCount !== a.waterCount) return c.waterCount - a.waterCount;
          // Last tie-break: closer to target direction.
          return c.dot - a.dot;
        });
        return candidates[0];
      };

      try {
        while (Date.now() < deadline) {
          const live = b.entities[b.vehicle?.id];
          if (!live || !b.vehicle) {
            safeMoveVehicle(0, 0);
            return { ok: false, error: {
              code: 'OUT_OF_RANGE',
              message: 'Lost the boat mid-sail (dismounted by physics or boat broke).',
              retry_safe: true,
            }};
          }

          const here = live.position;
          const dx = target.x - here.x;
          const dz = target.z - here.z;
          const horiz = Math.hypot(dx, dz);

          if (horiz < 2) {
            safeMoveVehicle(0, 0);
            await sleep(400);
            return {
              ok: true,
              command: 'sail',
              data: {
                from: [Math.floor(startPos.x), Math.floor(startPos.y), Math.floor(startPos.z)],
                to: [Math.floor(here.x), Math.floor(here.y), Math.floor(here.z)],
                target: [Number(x), Number(y), Number(z)],
                horizontal_distance_remaining: Number(horiz.toFixed(2)),
                ...(nativeWorks ? {} : { fallback: packetWorks ? 'packet_vehicle_move' : 'papermcp_tp_step' }),
                ...(detoursTaken.length ? { detours: detoursTaken } : {}),
              },
            };
          }

          // circuit-v5h/v5i: Steve sailed to ~50 blocks of W1 but the
          // target was a land coord; the boat couldn't get within 2 of
          // it. Sail kept retrying until Steve drowned. Now: if the boat
          // is within 8 blocks of a dry standable shore, return success
          // early as SHORE_REACHED so the agent disembarks instead of
          // looping. This only fires when sail has been making forward
          // progress (no stall ticks); a wedged boat goes through the
          // detour path below.
          //
          // circuit-v25: sail_to threads BFS waypoints through sail() —
          // for middle legs (8b apart), SHORE_REACHED would misfire on
          // the very first tick because horiz starts in (2, 16) and the
          // route runs near a coast. Callers in waypoint mode pass
          // allow_shore_early_exit=false to gate this short-circuit;
          // the final leg uses the default (true) so the existing
          // "boat reached the destination shore" behavior still works.
          const allowShoreExit = allow_shore_early_exit !== false;
          if (allowShoreExit && horiz < 16 && stallTicks === 0 && detourTicksLeft === 0) {
            let shoreCell = null;
            scanShore: for (let dx2 = -8; dx2 <= 8; dx2++) {
              for (let dz2 = -8; dz2 <= 8; dz2++) {
                if (Math.hypot(dx2, dz2) > 8) continue;
                const sx = Math.floor(here.x + dx2);
                const sz = Math.floor(here.z + dz2);
                const sy = Math.floor(here.y);
                // Standable: foot air, head air, below solid non-water.
                const foot = b.blockAt(new Vec3(sx, sy, sz));
                const head = b.blockAt(new Vec3(sx, sy + 1, sz));
                const under = b.blockAt(new Vec3(sx, sy - 1, sz));
                if (!foot || !head || !under) continue;
                const isAir = (n) => n === 'air' || n === 'cave_air' || n === 'void_air';
                const isWater = (n) => n === 'water' || n === 'flowing_water';
                if (!isAir(foot.name)) continue;
                if (!isAir(head.name)) continue;
                if (under.boundingBox !== 'block') continue;
                if (isWater(under.name)) continue;
                shoreCell = { x: sx, y: sy, z: sz, distance: Number(Math.hypot(dx2, dz2).toFixed(2)) };
                break scanShore;
              }
            }
            if (shoreCell && shoreCell.distance >= 2) {
              safeMoveVehicle(0, 0);
              await sleep(200);
              return {
                ok: true,
                command: 'sail',
                data: {
                  from: [Math.floor(startPos.x), Math.floor(startPos.y), Math.floor(startPos.z)],
                  to: [Math.floor(here.x), Math.floor(here.y), Math.floor(here.z)],
                  target: [Number(x), Number(y), Number(z)],
                  horizontal_distance_remaining: Number(horiz.toFixed(2)),
                  shore_reached: shoreCell,
                  ...(nativeWorks ? {} : { fallback: packetWorks ? 'packet_vehicle_move' : 'papermcp_tp_step' }),
                  ...(detoursTaken.length ? { detours: detoursTaken } : {}),
                },
                result: `Reached shore — dry land at (${shoreCell.x},${shoreCell.y},${shoreCell.z}), ${shoreCell.distance}b from boat. Target ${Math.floor(horiz)}b further but you're at the shore — call mc disembark.`,
              };
            }
          }

          // If we're mid-detour, steer along detourVec instead of toward target.
          const steerDx = detourTicksLeft > 0 ? detourVec.dx : dx;
          const steerDz = detourTicksLeft > 0 ? detourVec.dz : dz;
          const steerNorm = Math.hypot(steerDx, steerDz) || 1;

          if (nativeWorks) {
            const yaw = Math.atan2(-steerDx, steerDz);
            try { await b.look(yaw, 0, true); } catch {}
            // Burst-pump moveVehicle to match the server's vehicle physics
            // tick rate (~50ms). One packet per 250ms loop barely moves the
            // boat; 5 packets per loop saturates the input window so the
            // server treats it as a held "forward" key.
            for (let pump = 0; pump < 5; pump++) {
              safeMoveVehicle(0, 1);
              await sleep(50);
            }
          } else if (packetWorks) {
            // Packet steering: vehicle_move + player_input combo. Each
            // tick we send the boat's intended next position and the
            // "W held" flag. Mirrors vanilla client behavior; the server
            // validates and broadcasts.
            const yaw = Math.atan2(-steerDx, steerDz);
            try { await b.look(yaw, 0, true); } catch {}
            for (let pump = 0; pump < 5; pump++) {
              const live = b.entities[b.vehicle?.id]?.position || here;
              const nx = live.x + (steerDx / steerNorm) * STEP_PER_TICK;
              const nz = live.z + (steerDz / steerNorm) * STEP_PER_TICK;
              // Collision-check the next cell. Same logic as the RCON
              // tp-step: refuse to shove the boat into a solid block.
              try {
                const probe = b.blockAt(new Vec3(Math.floor(nx), Math.floor(live.y), Math.floor(nz)));
                const collides = probe
                  && probe.name !== 'air' && probe.name !== 'cave_air' && probe.name !== 'void_air'
                  && probe.name !== 'water' && probe.name !== 'flowing_water'
                  && probe.boundingBox === 'block';
                if (collides) {
                  // Halt this burst; outer stall loop will detour or bail.
                  safeMoveVehicle(0, 0);
                  break;
                }
              } catch { /* probe failed (unloaded chunk?) — fall through and send the packet */ }
              safeVehicleMove(nx, live.y, nz, yaw);
              safeMoveVehicle(0, 1);
              await sleep(TICK_MS);
            }
          } else if (useTpFallback) {
            // Step the boat 1.5 blocks toward steerVec each tick.
            const step = Math.min(1.5, detourTicksLeft > 0 ? 1.5 : horiz);
            const nx = here.x + (steerDx / steerNorm) * step;
            const nz = here.z + (steerDz / steerNorm) * step;
            const ny = here.y;
            // Collision safety (Phase 2): before TPing the boat, probe the
            // target cell. If it's solid (non-air, non-water), the TP would
            // shove the boat into a block and break it — killing Steve from
            // the boat-shatter impact. Abort with BOAT_STUCK; the existing
            // auto-disembark chain below handles recovery.
            try {
              const probe = b.blockAt(new Vec3(Math.floor(nx), Math.floor(ny), Math.floor(nz)));
              const collides = probe
                && probe.name !== 'air' && probe.name !== 'cave_air' && probe.name !== 'void_air'
                && probe.name !== 'water' && probe.name !== 'flowing_water'
                && probe.boundingBox === 'block';
              if (collides) {
                safeMoveVehicle(0, 0);
                // Try auto-disembark to get Steve out of the doomed boat.
                let autoDisembark = null;
                if (ACTIONS && typeof ACTIONS.disembark === 'function') {
                  try {
                    const dis = await ACTIONS.disembark({ fromSailFallback: true });
                    autoDisembark = {
                      ok: !!dis?.ok,
                      ...(dis?.data ? { data: dis.data } : {}),
                      ...(dis?.error ? { error: dis.error } : {}),
                    };
                  } catch (e) {
                    autoDisembark = { ok: false, error: e?.message || String(e) };
                  }
                }
                return { ok: false, error: {
                  code: 'BOAT_STUCK',
                  message: `Sail TP-step would have teleported the boat into a ${probe.name} block at (${Math.floor(nx)},${Math.floor(ny)},${Math.floor(nz)}). Refused — that would shatter the boat. ${autoDisembark?.ok ? 'Auto-disembarked you — you should be on dry shore now.' : 'Call mc disembark.'}`,
                  observed_state: {
                    boat_pos: [Number(here.x.toFixed(2)), Number(here.y.toFixed(2)), Number(here.z.toFixed(2))],
                    collision_at: { x: Math.floor(nx), y: Math.floor(ny), z: Math.floor(nz), block: probe.name },
                    horizontal_distance_remaining: Number(horiz.toFixed(2)),
                    ...(autoDisembark ? { auto_disembark: autoDisembark } : {}),
                  },
                  next_action_hint: autoDisembark?.ok ? 'mc status' : 'mc disembark',
                  retry_safe: false,
                }};
              }
            } catch { /* probe failed (unloaded chunk?) — fall through and let the TP try */ }
            const bx = Math.floor(here.x);
            const by = Math.floor(here.y);
            const bz = Math.floor(here.z);
            const cmd = `execute positioned ${bx} ${by} ${bz} run tp @e[type=oak_boat,distance=..2,limit=1] ${nx.toFixed(3)} ${ny.toFixed(3)} ${nz.toFixed(3)}`;
            const r = await executeServerCommand(pmcp, cmd).catch(() => ({ ok: false }));
            if (!r || !r.ok) log(`[sail] tp step failed`);
            // circuit-v17: keep local entity positions in sync with the
            // server-side teleport we just issued. Without this, the bot's
            // bot.entity.position stays at the pre-sail coords; every
            // subsequent action operates on the wrong location.
            if (r && r.ok) {
              if (b.entity && b.entity.position) {
                b.entity.position.x = nx;
                b.entity.position.y = ny;
                b.entity.position.z = nz;
              }
              if (b.vehicle && b.vehicle.position) {
                b.vehicle.position.x = nx;
                b.vehicle.position.y = ny;
                b.vehicle.position.z = nz;
              }
            }
            await sleep(400);
          } else {
            // No fallback available; native isn't working. Bail.
            return { ok: false, error: {
              code: 'OUT_OF_RANGE',
              message: 'Boat not responding to rider input and no PaperMCP fallback configured.',
              retry_safe: false,
            }};
          }

          if (detourTicksLeft > 0) {
            detourTicksLeft--;
            if (detourTicksLeft === 0) {
              // Detour done; reset stall counter so we get a fresh
              // chance to make forward progress before re-detouring.
              stallTicks = 0;
              detourVec = null;
              lastDistance = horiz; // re-baseline so we don't re-flag stall instantly
              continue;
            }
            lastDistance = horiz;
            continue;
          }

          if (Math.abs(lastDistance - horiz) < 0.05) {
            stallTicks++;
            if (stallTicks >= 8) {
              safeMoveVehicle(0, 0);
              // Attempt a detour before giving up. circuit-v5f showed the
              // boat wedging against shore/shallows ~50s into a sail —
              // a 2.4s sidestep around the obstacle often recovers.
              if (detourAttempts < MAX_DETOURS) {
                const heading = pickDetourHeading(here, dx, dz);
                if (heading) {
                  detourAttempts++;
                  detourVec = heading;
                  detourTicksLeft = DETOUR_TICKS;
                  detoursTaken.push({
                    attempt: detourAttempts,
                    from: [Number(here.x.toFixed(2)), Number(here.y.toFixed(2)), Number(here.z.toFixed(2))],
                    heading: [Number(heading.dx.toFixed(2)), Number(heading.dz.toFixed(2))],
                  });
                  log(`[sail] stall detected, detouring attempt ${detourAttempts}/${MAX_DETOURS} heading (${heading.dx.toFixed(2)},${heading.dz.toFixed(2)})`);
                  continue;
                }
              }
              // No detour available or budget exhausted. Don't just return
              // an error — circuit-v5j showed Steve dying to drowned mobs
              // while the agent processed the BOAT_STUCK envelope and
              // figured out to call mc disembark. Auto-chain disembark
              // (which auto-escapes to shore) so the bot is safe by the
              // time the response lands.
              let autoDisembark = null;
              if (ACTIONS && typeof ACTIONS.disembark === 'function') {
                try {
                  const dis = await ACTIONS.disembark({ fromSailFallback: true });
                  autoDisembark = {
                    ok: !!dis?.ok,
                    ...(dis?.data ? { data: dis.data } : {}),
                    ...(dis?.error ? { error: dis.error } : {}),
                  };
                } catch (e) {
                  autoDisembark = { ok: false, error: e?.message || String(e) };
                }
              }
              return { ok: false, error: {
                code: 'BOAT_STUCK',
                message: `Boat stuck after ${detourAttempts} detour attempt(s) — wedged against terrain at (${here.x.toFixed(1)}, ${here.y.toFixed(1)}, ${here.z.toFixed(1)}).${autoDisembark?.ok ? ' Auto-disembarked you — you should now be on dry shore.' : ' Call mc disembark — it will dismount you and the auto-escape will swim you to shore.'}`,
                observed_state: {
                  boat_pos: [Number(here.x.toFixed(2)), Number(here.y.toFixed(2)), Number(here.z.toFixed(2))],
                  horizontal_distance_remaining: Number(horiz.toFixed(2)),
                  detour_attempts: detourAttempts,
                  detours: detoursTaken,
                  ...(autoDisembark ? { auto_disembark: autoDisembark } : {}),
                },
                next_action_hint: autoDisembark?.ok ? 'mc status' : 'mc disembark',
                retry_safe: false,
              }};
            }
          } else {
            stallTicks = 0;
          }
          lastDistance = horiz;
        }
      } finally {
        safeMoveVehicle(0, 0);
      }

      const here = b.entities[b.vehicle?.id]?.position || boat.position;
      const remaining = Number(here.distanceTo(target).toFixed(2));
      return { ok: false, error: {
        code: 'TIMEOUT',
        message: `Did not reach (${x},${y},${z}) within ${effectiveTimeoutS}s. Boat is at (${here.x.toFixed(1)},${here.y.toFixed(1)},${here.z.toFixed(1)}) — ${remaining}b remaining. Call \`mc sail ${Math.floor(target.x)} ${Math.floor(target.y)} ${Math.floor(target.z)}\` again to continue.`,
        observed_state: {
          boat_pos: [Number(here.x.toFixed(2)), Number(here.y.toFixed(2)), Number(here.z.toFixed(2))],
          horizontal_distance_remaining: remaining,
          effective_timeout_s: effectiveTimeoutS,
          ...(detoursTaken.length ? { detours: detoursTaken } : {}),
        },
        next_action_hint: `mc sail ${Math.floor(target.x)} ${Math.floor(target.y)} ${Math.floor(target.z)}`,
        retry_safe: true,
      }};
    },

    /**
     * Ferry-service primitive: plan and execute a full water journey
     * from current position to (x, y, z) in one transactional call.
     *
     * Why this exists: circuit-v15 through v20 surfaced that exposing
     * the 4 boat verbs (board → sail → disembark, plus implicit
     * craft) to the agent compounded failure modes. Each call was
     * blind to the others. Steve burned boats, placed them in
     * disconnected ponds, hit 1-block bridges with no recovery, and
     * had no way to resume mid-journey. The user's framing — "treat
     * it like a portable ferry service" — is the right abstraction.
     *
     * Phases (each can be skipped on re-entry if current state shows
     * it already completed):
     *
     *   1. plan_route        — planWaterRoute BFS over water cells
     *   2. walk_to_entry     — pathfinder to entry_shore
     *   3. mount             — place_boat at entry_water + board
     *   4. sail              — sail to exit_water (waypoint hints)
     *   5. disembark         — dismount at exit_shore
     *   6. walk_to_target    — pathfinder to target
     *
     * Resumability is by state-detection, not persistent storage:
     *   - already within 4b → at_target, return success
     *   - b.vehicle set → skip walk_to_entry + mount; re-plan from
     *     current water position; jump to sail
     *   - bot near exit_shore on land → skip to walk_to_target
     *   - otherwise → full sequence
     *
     * Action contract: NO_BOAT, NO_NAVIGABLE_ROUTE, WALK_TO_ENTRY_FAILED,
     * MOUNT_FAILED, SAIL_FAILED, DISEMBARK_FAILED, WALK_TO_TARGET_FAILED.
     */
    async sail_to({ x, y, z }) {
      const b = ensureBot();
      if (![x, y, z].every((v) => Number.isFinite(Number(v)))) {
        return {
          ok: false,
          error: {
            code: 'INVALID_COORD',
            message: 'mc sail_to requires numeric x, y, z',
            retry_safe: false,
          },
        };
      }
      const target = { x: Number(x), y: Number(y), z: Number(z) };
      const startedAt = Date.now();
      const phases = []; // names of phases that actually ran
      const startPos = {
        x: b.entity.position.x,
        y: b.entity.position.y,
        z: b.entity.position.z,
      };

      // ── Phase: at_target ────────────────────────────────────────────
      const horizToTarget = Math.hypot(startPos.x - target.x, startPos.z - target.z);
      if (horizToTarget < 4) {
        phases.push('at_target');
        return {
          ok: true,
          command: 'sail_to',
          data: {
            phases_executed: phases,
            start_position: startPos,
            end_position: startPos,
            elapsed_seconds: 0,
          },
          result: `Already within 4b of target (${horizToTarget.toFixed(1)}b) — no journey needed. Use mc bg_goto for the final approach.`,
        };
      }

      // ── Boat ticket check (early) ───────────────────────────────────
      // Allow currently-mounted bots through even if inventory is empty —
      // the boat they're on is the ticket. Only refuse if neither held
      // nor mounted.
      const hasBoatItem = b.inventory?.items?.().some((it) => BOAT_NAMES.has(it.name));
      const currentlyMounted = !!b.vehicle && !!b.entities[b.vehicle.id];
      if (!hasBoatItem && !currentlyMounted) {
        return {
          ok: false,
          error: {
            code: 'NO_BOAT',
            message: 'No boat in inventory and not currently mounted. mc sail_to needs a boat (your ticket). Craft one with: mc craft oak_boat (needs 5 oak_planks).',
            observed_state: { inventory_has_boat: false, mounted: false },
            next_action_hint: 'mc craft oak_boat',
            retry_safe: false,
          },
        };
      }

      // ── Phase: plan_route ───────────────────────────────────────────
      // If already mounted, re-plan from the current boat position so
      // the rest of the journey continues from where we are.
      const planStart = currentlyMounted && b.vehicle?.position
        ? { x: b.vehicle.position.x, y: b.vehicle.position.y, z: b.vehicle.position.z }
        : startPos;
      const routeRes = planWaterRoute(b, planStart, target);
      phases.push('plan_route');
      if (!routeRes.ok) {
        // Inner code is one of: ALREADY_AT_TARGET, WATER_TOO_SHALLOW,
        // POND_DISCONNECTED, TARGET_NOT_REACHABLE_FROM_WATER, NO_WATER_ROUTE.
        // ALREADY_AT_TARGET shouldn't happen here (we caught it above)
        // but if it does, treat as success.
        if (routeRes.error.code === 'ALREADY_AT_TARGET') {
          phases.push('at_target');
          return {
            ok: true,
            command: 'sail_to',
            data: { phases_executed: phases, start_position: startPos, end_position: startPos, elapsed_seconds: 0 },
            result: 'Already at target.',
          };
        }
        const suggestion = ({
          POND_DISCONNECTED: 'walk to a real shore first (mc bg_goto to a coast cell)',
          WATER_TOO_SHALLOW: 'find deeper water — the bot would ground out here',
          TARGET_NOT_REACHABLE_FROM_WATER: 'the destination has no water shore; consider mc bg_goto for the land approach',
          NO_WATER_ROUTE: 'no navigable water near you — walk to a shore first',
        })[routeRes.error.code] || 'check the observed_state for details';
        return {
          ok: false,
          error: {
            code: 'NO_NAVIGABLE_ROUTE',
            message: `Can't plan a water route: ${routeRes.error.message} Suggestion: ${suggestion}.`,
            observed_state: {
              water_route_error: routeRes.error.code,
              water_route_state: routeRes.error.observed_state,
              start: planStart,
              target,
            },
            next_action_hint: routeRes.error.code === 'POND_DISCONNECTED' || routeRes.error.code === 'NO_WATER_ROUTE'
              ? 'mc bg_goto <coast coords>  # then mc sail_to again'
              : 'mc bg_goto <target>',
            retry_safe: false,
          },
        };
      }

      const route = routeRes.data;

      // Sail one leg per BFS waypoint. waypoints[0] is the entry_water
      // (already there post-mount, or current position when resuming);
      // skip it and step through waypoints[1..N]. Each call to sail()
      // has only ~8 blocks to cover, so it can't drift wide and ram
      // obstacles BFS deliberately routed around. Middle legs pass
      // allow_shore_early_exit=false so SHORE_REACHED doesn't trip on
      // a coast-adjacent waypoint mid-route; only the last leg uses
      // the default behavior (so reaching the destination shore still
      // surfaces shore_reached for the disembark phase).
      const sailLegs = async (legs) => {
        const detoursTaken = [];
        for (let i = 0; i < legs.length; i++) {
          const wp = legs[i];
          const isLast = (i === legs.length - 1);
          const legRes = await ACTIONS.sail({
            x: wp.x, y: wp.y, z: wp.z,
            allow_shore_early_exit: isLast,
            _from_sail_to: true,
          });
          if (!legRes.ok) {
            return {
              ok: false,
              leg_index: i,
              waypoint: wp,
              inner_error: legRes.error,
            };
          }
          if (legRes.data?.detours) detoursTaken.push(...legRes.data.detours);
          // Last leg might surface shore_reached — that's expected;
          // the orchestrator's disembark phase handles it.
          if (legRes.data?.shore_reached && isLast) {
            return { ok: true, shore_reached: legRes.data.shore_reached, detoursTaken };
          }
        }
        return { ok: true, detoursTaken };
      };

      // Drop entry_water (already there) — waypoints array starts with
      // it. Tolerate single-waypoint routes (short journeys) by always
      // including at least exit_water.
      const legs = route.waypoints.length > 1
        ? route.waypoints.slice(1)
        : [route.exit_water];

      // ── Phase: mounted_in_water → skip to sail ──────────────────────
      // If already mounted, skip walk_to_entry + mount and go straight
      // to sail from current position along the waypoint chain.
      if (currentlyMounted) {
        phases.push('sail');
        try {
          const legsRes = await sailLegs(legs);
          if (!legsRes.ok) {
            return {
              ok: false,
              error: {
                code: 'SAIL_FAILED',
                message: `Resume-sail failed on leg ${legsRes.leg_index + 1}/${legs.length} (waypoint ${legsRes.waypoint.x},${legsRes.waypoint.y},${legsRes.waypoint.z}): ${legsRes.inner_error?.message || 'unknown'}. Call mc sail_to ${target.x} ${target.y} ${target.z} again to re-plan from here.`,
                observed_state: { sail_error: legsRes.inner_error, leg_index: legsRes.leg_index, waypoint: legsRes.waypoint, route },
                next_action_hint: `mc sail_to ${target.x} ${target.y} ${target.z}`,
                retry_safe: true,
              },
            };
          }
        } catch (e) {
          return {
            ok: false,
            error: {
              code: 'SAIL_FAILED',
              message: `Resume-sail threw: ${e?.message || e}`,
              retry_safe: true,
            },
          };
        }
      } else {
        // ── Phase: walk_to_entry ─────────────────────────────────────
        phases.push('walk_to_entry');
        try {
          const entry = route.entry_shore;
          const goal = new goals.GoalNear(entry.x, entry.y, entry.z, 1);
          await b.pathfinder.goto(goal);
        } catch (e) {
          return {
            ok: false,
            error: {
              code: 'WALK_TO_ENTRY_FAILED',
              message: `Could not walk to entry shore at (${route.entry_shore.x}, ${route.entry_shore.y}, ${route.entry_shore.z}): ${e?.message || e}`,
              observed_state: { entry_shore: route.entry_shore, route },
              next_action_hint: `mc bg_goto ${route.entry_shore.x} ${route.entry_shore.y} ${route.entry_shore.z}`,
              retry_safe: true,
            },
          };
        }

        // ── Phase: mount ─────────────────────────────────────────────
        phases.push('mount');
        try {
          const placeRes = await ACTIONS.place_boat({
            x: route.entry_water.x,
            y: route.entry_water.y,
            z: route.entry_water.z,
            _from_sail_to: true,
          });
          if (!placeRes?.ok) {
            return {
              ok: false,
              error: {
                code: 'MOUNT_FAILED',
                message: `Could not place boat at entry_water (${route.entry_water.x}, ${route.entry_water.y}, ${route.entry_water.z}): ${placeRes?.error?.message || 'place_boat failed'}`,
                observed_state: { place_boat_error: placeRes?.error, route },
                retry_safe: true,
              },
            };
          }
          const boardRes = await ACTIONS.board({ _from_sail_to: true });
          if (!boardRes?.ok) {
            return {
              ok: false,
              error: {
                code: 'MOUNT_FAILED',
                message: `Boat placed at (${route.entry_water.x}, ${route.entry_water.y}, ${route.entry_water.z}) but mount failed: ${boardRes?.error?.message || 'board failed'}`,
                observed_state: { board_error: boardRes?.error, place_data: placeRes.data, route },
                retry_safe: true,
              },
            };
          }
        } catch (e) {
          return {
            ok: false,
            error: {
              code: 'MOUNT_FAILED',
              message: `Mount sequence threw: ${e?.message || e}`,
              retry_safe: true,
            },
          };
        }

        // ── Phase: sail ──────────────────────────────────────────────
        phases.push('sail');
        try {
          const legsRes = await sailLegs(legs);
          if (!legsRes.ok) {
            return {
              ok: false,
              error: {
                code: 'SAIL_FAILED',
                message: `Sail failed on leg ${legsRes.leg_index + 1}/${legs.length} (waypoint ${legsRes.waypoint.x},${legsRes.waypoint.y},${legsRes.waypoint.z}): ${legsRes.inner_error?.message || 'unknown'}. Call mc sail_to ${target.x} ${target.y} ${target.z} again to re-plan from here.`,
                observed_state: { sail_error: legsRes.inner_error, leg_index: legsRes.leg_index, waypoint: legsRes.waypoint, route },
                next_action_hint: `mc sail_to ${target.x} ${target.y} ${target.z}`,
                retry_safe: true,
              },
            };
          }
        } catch (e) {
          return {
            ok: false,
            error: {
              code: 'SAIL_FAILED',
              message: `Sail threw: ${e?.message || e}`,
              retry_safe: true,
            },
          };
        }
      }

      // ── Phase: disembark ────────────────────────────────────────────
      // Only run disembark if the bot is still on a vehicle. Sail's
      // BOAT_STUCK auto-disembark may have already freed Steve.
      if (b.vehicle && b.entities[b.vehicle.id]) {
        phases.push('disembark');
        try {
          const disRes = await ACTIONS.disembark({});
          if (!disRes.ok && disRes.error?.code !== 'NOT_MOUNTED') {
            return {
              ok: false,
              error: {
                code: 'DISEMBARK_FAILED',
                message: `Disembark failed at (${route.exit_shore.x}, ${route.exit_shore.y}, ${route.exit_shore.z}): ${disRes.error?.message || 'unknown'}`,
                observed_state: { disembark_error: disRes.error, exit_shore: route.exit_shore },
                retry_safe: true,
              },
            };
          }
        } catch (e) {
          return {
            ok: false,
            error: {
              code: 'DISEMBARK_FAILED',
              message: `Disembark threw: ${e?.message || e}`,
              retry_safe: true,
            },
          };
        }
      }

      // ── Phase: walk_to_target ───────────────────────────────────────
      // Only if we're not already there.
      const here = b.entity.position;
      const stillFar = Math.hypot(here.x - target.x, here.z - target.z) > 4;
      if (stillFar) {
        phases.push('walk_to_target');
        try {
          const goal = new goals.GoalNear(target.x, target.y, target.z, 2);
          await b.pathfinder.goto(goal);
        } catch (e) {
          // Don't fail the whole sail_to for the final-land-leg —
          // Steve is on dry land near the target. Return success
          // with a note in the data.
          const endPos = b.entity.position;
          return {
            ok: true,
            command: 'sail_to',
            data: {
              phases_executed: phases,
              walk_to_target_partial: { error: e?.message || String(e) },
              route: {
                entry_shore: route.entry_shore,
                exit_shore: route.exit_shore,
                horizontal_distance: route.horizontal_distance,
                waypoints_count: route.waypoints.length,
              },
              start_position: startPos,
              end_position: { x: endPos.x, y: endPos.y, z: endPos.z },
              elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
            },
            result: `Sailed to (${route.exit_shore.x},${route.exit_shore.y},${route.exit_shore.z}) — final ${Math.round(Math.hypot(endPos.x - target.x, endPos.z - target.z))}b on land failed; call mc bg_goto ${target.x} ${target.y} ${target.z} to finish.`,
          };
        }
      }

      const endPos = b.entity.position;
      // circuit-v24: partial-journey result strings. When the route plan
      // returned partial=true, the water leg got the bot closer but not
      // to target — the agent needs to walk the rest. Surface this in
      // the data envelope AND the human result string so the agent
      // sees the next step plainly.
      const partial = !!route.partial;
      const walkRemaining = route.walk_remaining_after_water || 0;
      return {
        ok: true,
        command: 'sail_to',
        data: {
          phases_executed: phases,
          route: {
            entry_shore: route.entry_shore,
            exit_shore: route.exit_shore,
            horizontal_distance: route.horizontal_distance,
            waypoints_count: route.waypoints.length,
            water_cells_explored: route.water_cells_explored,
            partial,
            walk_remaining_after_water: walkRemaining,
          },
          start_position: startPos,
          end_position: { x: endPos.x, y: endPos.y, z: endPos.z },
          elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
          ...(partial ? {
            next_action_hint: `mc bg_goto ${target.x} ${target.y} ${target.z}  # the water leg dropped you ${walkRemaining}b from target; walk the rest`,
          } : {}),
        },
        result: partial
          ? `Sailed PARTIAL: from (${Math.floor(startPos.x)},${Math.floor(startPos.y)},${Math.floor(startPos.z)}) to shore at (${route.exit_shore.x},${route.exit_shore.y},${route.exit_shore.z}) — ${route.horizontal_distance}b across water, but target is still ${walkRemaining}b away. Now call: mc bg_goto ${target.x} ${target.y} ${target.z}`
          : `Sailed from (${Math.floor(startPos.x)},${Math.floor(startPos.y)},${Math.floor(startPos.z)}) to (${target.x},${target.y},${target.z}) — ${route.horizontal_distance}b across water, ${phases.length} phases.`,
      };
    },

    /**
     * Exit the current vehicle.
     * Action contract: NOT_MOUNTED.
     */
    async disembark(opts = {}) {
      const b = ensureBot();
      const emergency = !!opts.emergency;
      // Phase 6 follow-up (circuit-v8 postmortem): sail()'s BOAT_STUCK
      // fallback calls disembark, and if the boat is in water disembark
      // calls sail-to-shore — which can stall and recurse back into
      // disembark. The `fromSailFallback` opt breaks the loop by
      // skipping the auto-sail-to-shore step when sail is the caller.
      const fromSailFallback = !!opts.fromSailFallback;
      // Stale vehicle reference cleanup (mineflayer leaves b.vehicle set
      // after the vehicle entity dies).
      if (b.vehicle && !b.entities[b.vehicle.id]) {
        const stale = b.vehicle.name;
        b.vehicle = null;
        return {
          ok: true,
          command: 'disembark',
          data: { dismounted_from: stale, note: 'vehicle had despawned; cleared stale reference' },
        };
      }
      // Phase 6 follow-up: positional stale-vehicle reaper. mineflayer
      // sometimes keeps b.vehicle pointing at a boat the bot is no
      // longer riding (PaperMCP ride dismount races, server-side
      // teleports, packet corruption). If the bot's own position is
      // > 16 blocks horizontally from the vehicle, it's clearly not
      // riding — clear the stale ref instead of trying to dismount.
      if (b.vehicle && b.entity?.position && b.vehicle.position) {
        const dx = b.entity.position.x - b.vehicle.position.x;
        const dz = b.entity.position.z - b.vehicle.position.z;
        const horiz = Math.hypot(dx, dz);
        if (horiz > 16) {
          const stale = b.vehicle.name;
          const vpos = b.vehicle.position;
          b.vehicle = null;
          return {
            ok: true,
            command: 'disembark',
            data: {
              dismounted_from: stale,
              note: `bot was ${horiz.toFixed(1)}b from vehicle — cleared stale b.vehicle ref`,
              bot_pos: [Number(b.entity.position.x.toFixed(1)), Number(b.entity.position.y.toFixed(1)), Number(b.entity.position.z.toFixed(1))],
              vehicle_pos: [Number(vpos.x.toFixed(1)), Number(vpos.y.toFixed(1)), Number(vpos.z.toFixed(1))],
            },
          };
        }
      }
      if (!b.vehicle) {
        return { ok: false, error: {
          code: 'NOT_MOUNTED',
          message: 'Bot is not in a vehicle.',
          retry_safe: false,
        }};
      }
      const wasVehicle = b.vehicle.name;
      let fallback = null;

      // High-level contract (task #19): if the boat is currently in open
      // water, scan for the nearest standable shore within 16 blocks and
      // sail there first so the agent doesn't disembark into deep water.
      // Skipped when called from sail's stall/collision fallback —
      // otherwise disembark → sail → disembark recurses forever.
      let autoSailed = null;
      {
        const boatPos = b.vehicle.position;
        const below = b.blockAt(boatPos.offset(0, -1, 0));
        const inOpenWater = !!below && (below.name === 'water' || below.name === 'flowing_water');
        if (inOpenWater && !fromSailFallback) {
          const isStandableLand = (bot, px, py, pz) => {
            const foot = bot?.blockAt && bot.blockAt(new Vec3(px, py, pz));
            const head = bot?.blockAt && bot.blockAt(new Vec3(px, py + 1, pz));
            const belowSolid = bot?.blockAt && bot.blockAt(new Vec3(px, py - 1, pz));
            if (!foot || !head || !belowSolid) return false;
            const isAirish = (n) => n === 'air' || n === 'cave_air' || n === 'void_air';
            const isWater = (n) => n === 'water' || n === 'flowing_water';
            if (!isAirish(foot.name)) return false;
            if (!isAirish(head.name)) return false;
            if (belowSolid.boundingBox !== 'block') return false;
            if (isWater(belowSolid.name)) return false;
            return true;
          };
          const shore = findAdjustedTarget(
            b,
            isStandableLand,
            Math.floor(boatPos.x),
            Math.floor(boatPos.y),
            Math.floor(boatPos.z),
            12,
          );
          if (shore && shore.adjusted && shore.distance >= 2) {
            log(`[disembark] in open water — auto-sailing to shore at ${shore.x},${shore.y},${shore.z} (distance ${shore.distance})`);
            try {
              const sailRes = await ACTIONS.sail({ x: shore.x, y: shore.y, z: shore.z, timeout_seconds: 30, _from_sail_to: true });
              autoSailed = {
                ok: !!sailRes?.ok,
                shore: { x: shore.x, y: shore.y, z: shore.z, distance: shore.distance },
                ...(sailRes?.data ? { sail_data: sailRes.data } : {}),
                ...(sailRes?.error ? { sail_error: sailRes.error } : {}),
              };
            } catch (e) {
              autoSailed = { ok: false, shore: { x: shore.x, y: shore.y, z: shore.z }, error: e?.message || String(e) };
            }
            await sleep(200);
          }
        }
      }
      try { b.dismount(); } catch {}
      await sleep(700);
      if (b.vehicle) {
        // Sneak-key vanilla dismount mechanism.
        try {
          b.setControlState('sneak', true);
          await sleep(300);
          b.setControlState('sneak', false);
        } catch {}
        await sleep(500);
      }
      if (b.vehicle) {
        // Paper 1.21+ fallback: server-side `ride` command forces dismount.
        // Note: mineflayer's b.vehicle state may not update even after
        // the server-side dismount succeeds — so we trust the server
        // command's result and clear b.vehicle manually.
        const pmcp = paperMcpConfig();
        const username = getMyName?.();
        if (pmcp && username) {
          log(`[disembark] native + sneak both failed — PaperMCP ride dismount`);
          const r = await executeServerCommand(pmcp, `ride ${username} dismount`).catch((e) => ({ ok: false, error: e?.message }));
          await sleep(400);
          if (r && r.ok) {
            // Server says we're not riding; clear stale mineflayer state.
            b.vehicle = null;
            fallback = 'papermcp_server_side';
          }
        }
      }
      if (b.vehicle) {
        // Last-resort: forcibly destroy the vehicle entity via RCON.
        // Vanilla MC drops riders when their boat breaks. We lose the
        // boat but free Steve. Originally gated on emergency=true (only
        // the reactive auto_disembark_low_hp path used it); circuit-v11
        // showed the agent's plain `mc disembark` getting stuck in a
        // DISMOUNT_REJECTED loop because every prior path silently
        // failed and the force-kill was skipped. Now any caller gets
        // the escalation — a free rider with no boat is always better
        // than a stranded mounted bot.
        const pmcp = paperMcpConfig();
        if (pmcp && b.vehicle) {
          const vid = b.vehicle.id;
          const vname = b.vehicle.name || 'boat';
          const bx = Math.floor(b.entity.position.x);
          const by = Math.floor(b.entity.position.y);
          const bz = Math.floor(b.entity.position.z);
          try {
            log(`[disembark] ${emergency ? 'EMERGENCY' : 'last-resort'} — force-killing vehicle ${vname}#${vid} via RCON`);
            const r = await executeServerCommand(
              pmcp,
              `execute positioned ${bx} ${by} ${bz} run kill @e[type=#minecraft:boat,distance=..3,limit=1]`,
            ).catch(() => ({ ok: false }));
            await sleep(400);
            // Vehicle entity dies → mineflayer's entityGone handler
            // clears b.vehicle. Trust the entity-list check first.
            // Only fall back to clearing manually if the RCON command
            // returned ok — otherwise we'd risk desyncing (server still
            // has Steve riding, mineflayer thinks not).
            if (b.vehicle && !b.entities[b.vehicle.id]) {
              b.vehicle = null;
              fallback = 'rcon_force_kill';
            } else if (b.vehicle && b.vehicle.id === vid && r && r.ok) {
              b.vehicle = null;
              fallback = 'rcon_force_kill';
            }
          } catch (e) {
            log(`[disembark] force-kill failed: ${e?.message || e}`);
          }
        }
      }
      if (b.vehicle) {
        return { ok: false, error: {
          code: 'DISMOUNT_REJECTED',
          message: 'Server did not confirm dismount even after RCON force-kill. Vehicle entity is sticky; agent should mc respawn or wait it out.',
          retry_safe: true,
        }};
      }

      // After dismount: if the bot is now in water (sail-to-shore failed
      // or wasn't attempted), chain mc escape so the agent doesn't have
      // to deal with "stranded in lake" as a separate step. circuit-v5f
      // showed Steve drowning after a stuck boat because disembark left
      // him in deep water with no recovery hint.
      let autoEscape = null;
      await sleep(300); // let physics settle so foot block is accurate
      const footBlk = b.blockAt(b.entity.position.floored());
      const stillInWater = !!footBlk && (footBlk.name === 'water' || footBlk.name === 'flowing_water');
      if (stillInWater) {
        try {
          const escRes = await ACTIONS.escape({});
          autoEscape = {
            ok: !!escRes?.ok,
            ...(escRes?.data ? { details: escRes.data } : {}),
            ...(escRes?.error ? { error: escRes.error } : {}),
          };
        } catch (e) {
          autoEscape = { ok: false, error: e?.message || String(e) };
        }
      }

      return {
        ok: true,
        command: 'disembark',
        data: {
          dismounted_from: wasVehicle,
          bot_position: [Math.floor(b.entity.position.x), Math.floor(b.entity.position.y), Math.floor(b.entity.position.z)],
          ...(fallback ? { fallback } : {}),
          ...(autoSailed ? { auto_sailed: autoSailed } : {}),
          ...(autoEscape ? { auto_escape: autoEscape } : {}),
        },
      };
    },
  async bucket_fill({ x, y, z }) {
    const b = ensureBot();
    const inventoryAt = () =>
      b.inventory.items().reduce((acc, it) => { acc[it.name] = (acc[it.name] || 0) + it.count; return acc; }, /** @type {Record<string, number>} */ ({}));

    const empty = b.inventory.items().find((i) => i.name === 'bucket');
    if (!empty) {
      const buckets = b.inventory.items().filter((i) => /bucket$/.test(i.name)).map((i) => `${i.name}x${i.count}`);
      return { ok: false, error: {
        code: 'MISSING_BUCKET',
        message: 'No empty bucket in inventory. Craft one (3 iron_ingot).',
        observed_state: { inventory_buckets: buckets },
        retry_safe: false,
      }};
    }

    const isLiquidSource = (bot, px, py, pz) => {
      const blk = bot?.blockAt && bot.blockAt(new Vec3(px, py, pz));
      if (!blk) return false;
      if (blk.name !== 'water' && blk.name !== 'lava') return false;
      const lvl = Number(blk.getProperties?.()?.level ?? 0);
      return lvl === 0;
    };

    const targetPos = new Vec3(x, y, z);
    let target = b.blockAt(targetPos);
    let adjustedTarget = null;

    // Self-adjust: if the requested cell isn't a liquid source, search within
    // 3 blocks for the nearest source and use that instead.
    if (!target || !isLiquidSource(b, x, y, z)) {
      const adj = findAdjustedTarget(b, isLiquidSource, x, y, z, 3);
      if (adj && adj.adjusted) {
        targetPos.x = adj.x; targetPos.y = adj.y; targetPos.z = adj.z;
        target = b.blockAt(targetPos);
        adjustedTarget = { x: adj.x, y: adj.y, z: adj.z, distance: adj.distance, original: adj.original };
      }
    }

    if (!target || (target.name !== 'water' && target.name !== 'lava')) {
      return { ok: false, error: {
        code: 'NOT_A_LIQUID',
        message: `Block at (${x}, ${y}, ${z}) is ${target?.name ?? 'unloaded'}, not water/lava.`,
        observed_state: { target_block: target?.name ?? null, requested_coord: { x, y, z } },
        retry_safe: false,
      }};
    }

    const rawLevel = target.getProperties?.()?.level;
    const level = Number(rawLevel ?? 0);
    if (level !== 0) {
      return { ok: false, error: {
        code: 'NOT_A_SOURCE',
        message: `${target.name} at (${x}, ${y}, ${z}) is flowing (level=${level}), not a source. Buckets only fill from source blocks.`,
        observed_state: { target_block: target.name, level },
        retry_safe: false,
      }};
    }

    if (b.entity.position.distanceTo(targetPos) > 4.5) {
      try {
        await b.pathfinder.goto(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 3));
      } catch {
        return { ok: false, error: {
          code: 'OUT_OF_RANGE',
          message: `Target at (${targetPos.x}, ${targetPos.y}, ${targetPos.z}) is ${Math.round(b.entity.position.distanceTo(targetPos) * 10) / 10} blocks away and pathfind failed.`,
          observed_state: { distance: b.entity.position.distanceTo(targetPos), bot_position: posObj(b.entity.position) },
          retry_safe: false,
        }};
      }
    }

    try { await b.equip(empty, 'hand'); } catch (err) {
      return { ok: false, error: {
        code: 'INTERRUPTED',
        message: `equip bucket failed: ${/** @type {Error} */ (err).message}`,
        retry_safe: true,
      }};
    }

    const liquidName = target.name === 'water' ? 'water_bucket' : 'lava_bucket';
    const before = inventoryAt();
    // Try native mineflayer first; falls through to PaperMCP server-side
    // if the inventory delta is zero. On Paper 1.21+, both use_item and
    // use_item_on packets silently no-op for bucket fill against fluid
    // blocks (same class of bug as the 3x3 craft delta=0 issue); the
    // PaperMCP fallback is the reliable path.
    try {
      await b.lookAt(target.position.offset(0.5, 0.5, 0.5), true);
      await sleep(100);
      await b.activateItem();
      await sleep(400);
      try { b.deactivateItem(); } catch { /* ignore */ }
    } catch { /* fall through to PaperMCP */ }
    let after = inventoryAt();
    let gained = (after[liquidName] || 0) - (before[liquidName] || 0);
    let fallback = null;
    if (gained < 1) {
      const pmcp = paperMcpConfig();
      const username = getMyName?.();
      if (pmcp && username) {
        log(`[bucket_fill] native no-op for ${liquidName} — using PaperMCP fallback`);
        const r1 = await executeServerCommand(pmcp, `clear ${username} minecraft:bucket 1`);
        const r2 = await executeServerCommand(pmcp, `give ${username} minecraft:${liquidName} 1`);
        const r3 = await executeServerCommand(pmcp, `setblock ${targetPos.x} ${targetPos.y} ${targetPos.z} minecraft:air`);
        if (r1.ok && r2.ok && r3.ok) {
          for (let i = 0; i < 8; i++) {
            await sleep(120);
            after = inventoryAt();
            if ((after[liquidName] || 0) - (before[liquidName] || 0) >= 1) break;
          }
          gained = (after[liquidName] || 0) - (before[liquidName] || 0);
          fallback = 'papermcp_server_side';
        } else if (log) {
          log(`[bucket_fill] PaperMCP fallback failed: clear=${r1.error} give=${r2.error} setblock=${r3.error}`);
        }
      }
    }
    if (gained < 1) {
      return { ok: false, error: {
        code: 'UNCHANGED',
        message: `bucket_fill did not produce a ${liquidName}.`,
        observed_state: { started_inventory: before, ended_inventory: after, target_block: target.name, fallback_attempted: !!paperMcpConfig() },
        retry_safe: true,
      }};
    }
    return {
      ok: true,
      data: {
        filled: liquidName,
        source_coord: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
        started_inventory: before,
        ended_inventory: after,
        ...(fallback ? { fallback } : {}),
        ...(adjustedTarget ? { adjusted_target: adjustedTarget } : {}),
      },
      result: fallback
        ? `Filled ${liquidName} from ${target.name} at ${targetPos.x},${targetPos.y},${targetPos.z} (server-side fallback).`
        : `Filled ${liquidName} from ${target.name} at ${targetPos.x},${targetPos.y},${targetPos.z}.`,
    };
  },

  /**
   * Empty a filled water/lava bucket into a replaceable cell at (x,y,z).
   * Bucket placement is "right-click on a face of a solid neighbor" semantically;
   * the liquid appears in the empty cell on that face.
   * ── Phase-2 action contract (Sprint 7) ──
   *   MISSING_BUCKET   no water_bucket / lava_bucket in inventory
   *   BLOCKED          target cell isn't replaceable, OR no solid neighbor to anchor placement
   *   OUT_OF_RANGE     bot couldn't reach within 4.5 blocks
   *   UNCHANGED        server rejected — destination block didn't change
   */
  async bucket_empty({ x, y, z }) {
    const b = ensureBot();
    const inventoryAt = () =>
      b.inventory.items().reduce((acc, it) => { acc[it.name] = (acc[it.name] || 0) + it.count; return acc; }, /** @type {Record<string, number>} */ ({}));

    const filled = b.inventory.items().find((i) => i.name === 'water_bucket' || i.name === 'lava_bucket');
    if (!filled) {
      return { ok: false, error: {
        code: 'MISSING_BUCKET',
        message: 'No water_bucket or lava_bucket in inventory. Use mc bucket_fill first.',
        observed_state: { inventory_buckets: b.inventory.items().filter((i) => /bucket$/.test(i.name)).map((i) => i.name) },
        retry_safe: false,
      }};
    }
    const liquid = filled.name === 'water_bucket' ? 'water' : 'lava';

    const targetPos = new Vec3(x, y, z);
    const REPLACEABLE = new Set([
      'air', 'cave_air', 'void_air',
      'tall_grass', 'short_grass', 'grass', 'fern', 'large_fern',
      'vine', 'snow', 'snow_layer', 'fire', 'soul_fire',
      'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'dead_bush',
    ]);
    const oppositeLiquid = liquid === 'water' ? 'lava' : 'water';

    const ANCHOR_OFFSETS = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    const findAnchor = (px, py, pz) => {
      for (const [dx, dy, dz] of ANCHOR_OFFSETS) {
        const nb = b.blockAt(new Vec3(px + dx, py + dy, pz + dz));
        if (nb && (nb.boundingBox === 'block' || nb.name === 'water' || nb.name === 'lava')) {
          return { refBlock: nb, refOffset: [dx, dy, dz] };
        }
      }
      return null;
    };

    const isPourable = (bot, px, py, pz) => {
      const blk = bot?.blockAt && bot.blockAt(new Vec3(px, py, pz));
      const acceptable = !blk || REPLACEABLE.has(blk.name) || blk.name === oppositeLiquid;
      if (!acceptable) return false;
      return !!findAnchor(px, py, pz);
    };

    let existing = b.blockAt(targetPos);
    let adjustedTarget = null;

    const targetPourable = (() => {
      if (existing && !REPLACEABLE.has(existing.name) && existing.name !== oppositeLiquid) return false;
      return !!findAnchor(targetPos.x, targetPos.y, targetPos.z);
    })();

    if (!targetPourable) {
      const adj = findAdjustedTarget(b, isPourable, x, y, z, 3);
      if (adj && adj.adjusted) {
        targetPos.x = adj.x; targetPos.y = adj.y; targetPos.z = adj.z;
        existing = b.blockAt(targetPos);
        adjustedTarget = { x: adj.x, y: adj.y, z: adj.z, distance: adj.distance, original: adj.original };
      }
    }

    if (existing && !REPLACEABLE.has(existing.name) && existing.name !== oppositeLiquid) {
      return { ok: false, error: {
        code: 'BLOCKED',
        message: `Target (${targetPos.x}, ${targetPos.y}, ${targetPos.z}) is ${existing.name}, not replaceable. Dig it first.`,
        observed_state: { target_block: existing.name, requested_coord: { x, y, z } },
        next_action_hint: `mc dig ${targetPos.x} ${targetPos.y} ${targetPos.z}`,
        retry_safe: false,
      }};
    }

    const anchor = findAnchor(targetPos.x, targetPos.y, targetPos.z);
    if (!anchor) {
      return { ok: false, error: {
        code: 'BLOCKED',
        message: `Target (${targetPos.x}, ${targetPos.y}, ${targetPos.z}) has no solid or fluid neighbor — bucket placement needs a face to click on.`,
        observed_state: { requested_coord: { x, y, z } },
        retry_safe: false,
      }};
    }
    const { refBlock, refOffset } = anchor;

    if (b.entity.position.distanceTo(targetPos) > 4.5) {
      try {
        await b.pathfinder.goto(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 3));
      } catch {
        return { ok: false, error: {
          code: 'OUT_OF_RANGE',
          message: `Target at (${targetPos.x}, ${targetPos.y}, ${targetPos.z}) is ${Math.round(b.entity.position.distanceTo(targetPos) * 10) / 10} blocks away and pathfind failed.`,
          observed_state: { distance: b.entity.position.distanceTo(targetPos), bot_position: posObj(b.entity.position) },
          retry_safe: false,
        }};
      }
    }

    try { await b.equip(filled, 'hand'); } catch (err) {
      return { ok: false, error: {
        code: 'INTERRUPTED',
        message: `equip ${filled.name} failed: ${/** @type {Error} */ (err).message}`,
        retry_safe: true,
      }};
    }

    const before = inventoryAt();
    // Try native first; fall through to PaperMCP if no inventory delta.
    // Same Paper 1.21+ quirk as bucket_fill — use_item_on against a solid
    // face holding a water/lava bucket silently no-ops.
    const faceVec = new Vec3(-refOffset[0], -refOffset[1], -refOffset[2]);
    try {
      await b.lookAt(refBlock.position.offset(0.5, 0.5, 0.5), true);
      await sleep(100);
      await b.activateBlock(refBlock, faceVec);
      await sleep(400);
    } catch { /* fall through to PaperMCP */ }
    let placed = b.blockAt(targetPos);
    let after = inventoryAt();
    let fallback = null;
    const bucketGone = (before[filled.name] || 0) - (after[filled.name] || 0) >= 1;
    if (!bucketGone) {
      const pmcp = paperMcpConfig();
      const username = getMyName?.();
      if (pmcp && username) {
        log(`[bucket_empty] native no-op — using PaperMCP fallback`);
        // If pouring onto the opposite liquid, simulate the MC reaction:
        //   water-on-lava → obsidian (source-source meeting)
        //   lava-on-water → stone
        let placedBlock = liquid;
        if (existing && existing.name === oppositeLiquid) {
          placedBlock = liquid === 'water' ? 'obsidian' : 'stone';
        }
        const r1 = await executeServerCommand(pmcp, `clear ${username} minecraft:${filled.name} 1`);
        const r2 = await executeServerCommand(pmcp, `give ${username} minecraft:bucket 1`);
        const r3 = await executeServerCommand(pmcp, `setblock ${targetPos.x} ${targetPos.y} ${targetPos.z} minecraft:${placedBlock}`);
        if (r1.ok && r2.ok && r3.ok) {
          for (let i = 0; i < 8; i++) {
            await sleep(120);
            after = inventoryAt();
            placed = b.blockAt(targetPos);
            if ((after.bucket || 0) > (before.bucket || 0) && placed?.name) break;
          }
          fallback = 'papermcp_server_side';
        } else if (log) {
          log(`[bucket_empty] PaperMCP fallback failed: clear=${r1.error} give=${r2.error} setblock=${r3.error}`);
        }
      }
    }
    // Lava + water reactions can convert the target to stone/cobble/obsidian.
    const liquidReacted = placed && /^(stone|cobblestone|obsidian)$/.test(placed.name);
    const ok = placed && (placed.name === liquid || liquidReacted);
    if (!ok) {
      return { ok: false, error: {
        code: 'UNCHANGED',
        message: `bucket_empty did not place ${liquid} at (${targetPos.x}, ${targetPos.y}, ${targetPos.z}); block is ${placed?.name ?? 'unloaded'}.`,
        observed_state: { target_block_after: placed?.name ?? null, started_inventory: before, ended_inventory: after, fallback_attempted: !!paperMcpConfig() },
        retry_safe: true,
      }};
    }
    return {
      ok: true,
      data: {
        emptied: filled.name,
        placed_block: placed.name,
        target_coord: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
        reacted: liquidReacted ? placed.name : null,
        started_inventory: before,
        ended_inventory: after,
        ...(fallback ? { fallback } : {}),
        ...(adjustedTarget ? { adjusted_target: adjustedTarget } : {}),
      },
      result: liquidReacted
        ? `Emptied ${filled.name} — water/lava reaction produced ${placed.name} at ${targetPos.x},${targetPos.y},${targetPos.z}${fallback ? ' (server-side fallback)' : ''}.`
        : `Emptied ${filled.name} — ${liquid} placed at ${targetPos.x},${targetPos.y},${targetPos.z}${fallback ? ' (server-side fallback)' : ''}.`,
    };
  },

  };
}
