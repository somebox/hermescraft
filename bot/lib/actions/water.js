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
import { pathfindWithProgressWatchdog, ACTION_CAPS_MS, pathfindGotoNear } from './_helpers.js';
import { planBoatPath, executeBoatPath, bestEffortSail } from '../runtime/boat-path.js';

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

  // task #43 (v30): per-target retry tracking for sail_to. Closure-scoped
  // so it persists across calls within a bot session but resets on
  // process restart. Keyed by "x,y,z" of the target coord. When the same
  // target fails SAIL_TO_RETRY_LIMIT times in a row, sail_to refuses
  // with SAIL_TO_RETRY_LOOP and hints at mc advise — prevents the v29
  // pattern where the agent burns ~1500 tokens retrying the same broken
  // sail with no new information.
  /** @type {Map<string, { count: number, lastErrorCode: string|null, lastNearestWater: {x:number,y:number,z:number}|null, lastFailurePos: {x:number,y:number,z:number}|null }>} */
  const sailToRetryCounts = new Map();
  const SAIL_TO_RETRY_LIMIT = 4;
  // F19 (task #57, v39): if the bot has moved >MOVE_RESET_DISTANCE
  // blocks since the last recorded failure, reset the retry counter.
  // The previous-failure state is irrelevant from a different position
  // (BFS plan + nearest_water_candidate are position-dependent), so the
  // 4-fail gate was holding stale evidence against fresh attempts.
  //
  // F23 (task #61, v42): tightened 32 → 12. v25-v41 forensics showed
  // the agent shuffles inside a 10-15b cluster between attempts;
  // 32b never tripped, so the counter held stuck across mostly-stationary
  // retries. 12b matches the typical bg_goto step and keeps the counter
  // honest while still excluding micro-jitter.
  const RETRY_RESET_DISTANCE = 12;

  // Forward reference for sail_to's impl. Filled in after the object
  // literal is constructed (see the assignment at the bottom of
  // createWaterActions). Lets the public sail_to method dispatch to
  // _sailToImpl without relying on `this` — the action registry
  // detaches methods from their parent object when invoking them.
  /** @type {(args: {x: number, y: number, z: number}) => Promise<any>} */
  let sailToImplRef;

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

  const actions = {
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
        await pathfindGotoNear(b, goals, stanceX, stanceY, stanceZ, 1, { opName: 'fish_stance', capMs: ACTION_CAPS_MS.reach });
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
    async place_boat({ x, y, z, _from_sail_to, _rescue_from_water } = {}) {
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
      // F37 (task #66, v49): only run the shore-water adjustment when
      // the requested target ISN'T already water. circuit-v49 forensics:
      // BFS picked entry_water=(362,62,-543) (a water cell with a
      // diagonal dry shore at (361,63,-544)). place_boat's hasDryStance
      // check only inspects 4 CARDINAL neighbors (diagonal misses),
      // so isShoreWater returned false and the adjustment slid the
      // boat 1 cell west to (361,62,-543) — directly under Steve at
      // (361.5,63,-543.4). Boat and bot occupied the same cell;
      // mount could not interact with a boat inside its own hitbox;
      // board() returned MOUNT_REJECTED.
      //
      // The original purpose of the shore-water adjustment was the
      // v1 "agent gave a dirt coord" recovery — when the target
      // ISN'T water, find the nearest real water. When the target
      // IS already water, the adjustment can only move the boat
      // toward unpredictable cells (including the bot's hitbox).
      // Skip it.
      const targetIsAlreadyWater = (() => {
        try {
          const blk = b.blockAt(new Vec3(Number(x), Number(y), Number(z)));
          return isWater(blk);
        } catch { return false; }
      })();
      if (!targetIsAlreadyWater && !isShoreWater(b, Number(x), Number(y), Number(z))) {
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
      const botBelowBlock = b.blockAt(new Vec3(botFootPos.x, botFootPos.y - 1, botFootPos.z));
      const footIsWater = botFootBlock && (botFootBlock.name === 'water' || botFootBlock.name === 'flowing_water');
      const belowIsWater = botBelowBlock && (botBelowBlock.name === 'water' || botBelowBlock.name === 'flowing_water');
      // Task #66: treat "swimming on water surface" as in-water too —
      // foot=air with water directly below means the bot is floating
      // on the surface, can't walk to a dry stance, but CAN have a
      // boat placed at the water cell below.
      const swimmingOnSurface = !footIsWater && belowIsWater && !b.entity.onGround;
      const inWater = footIsWater || swimmingOnSurface;
      // Water cell to use for rescue placement. Submerged: bot's foot
      // cell IS water. Floating: water is one below.
      const rescuePos = footIsWater ? botFootPos : new Vec3(botFootPos.x, botFootPos.y - 1, botFootPos.z);
      let stancePos = null;
      let placedFromWater = false;
      if (inWater) {
        // v30 defense-in-depth: when called from sail_to, the bot
        // should already be on a dry entry shore. If we got here with
        // the bot in water, walk_to_entry's pathfinder dropped Steve
        // mid-walk — placing a boat from-water in that situation just
        // makes things worse (Steve was submerged, now there's an
        // unmountable boat at his foot). Refuse with a clear envelope
        // so sail_to surfaces the error instead of cascading.
        //
        // sail_to itself does an explicit walk_to_entry post-check
        // (F3) — this refusal is the safety net if that check is
        // bypassed or its precondition changes. The escape/recovery
        // path (no _from_sail_to flag) still gets the original
        // from-water rescue behaviour: that path is intentional for
        // "Steve deep in water with no shore nearby" scenarios from
        // circuit-v1.
        //
        // F9 (task #47): sail_to's new in-water rescue branch passes
        // _rescue_from_water:true to opt INTO the from-water placement
        // path explicitly. v33 forensics: Steve stranded mid-ocean with
        // no shore his pathfinder could reach; sail_to had no recovery.
        // The rescue branch detects that case at sail_to start and
        // bypasses this gate via the explicit flag (NOT by silently
        // ignoring walk_to_entry's failure — that's still F2's job).
        if (_from_sail_to && !_rescue_from_water) {
          return { ok: false, error: {
            code: 'BOT_IN_WATER',
            message: `Cannot place a boat — bot is submerged at (${botFootPos.x}, ${botFootPos.y}, ${botFootPos.z}). A boat needs a dry stance to mount cleanly; placing from-water leaves the boat unreachable. Escape water first, then sail_to can pick a fresh entry shore from your new position.`,
            observed_state: {
              bot_position: { x: botFootPos.x, y: botFootPos.y, z: botFootPos.z },
              foot_block: botFootBlock.name,
              target_water: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
            },
            next_action_hint: 'mc escape   # then mc sail_to <target> again',
            retry_safe: true,
          }};
        }
        // Place AT the actual water cell (foot for submerged, below
        // for swimming-on-surface). The boat spawns on the surface
        // adjacent to the bot. No move needed.
        stancePos = rescuePos;
        placedFromWater = true;
        log(`[place_boat] bot in water at ${rescuePos.x},${rescuePos.y},${rescuePos.z} (${swimmingOnSurface ? 'surface' : 'submerged'}) — placing from-water without dry stance`);
      } else {
        // Land mode: search outward by Chebyshev ring for the closest
        // dry stance. Ring 1 = 4 cardinals at refBlock+1y (original
        // behavior). Ring 2 = 8 cells at distance 2 (so a bot standing
        // on a grass shore 1 cell back from the channel can still
        // launch — task #66 / B5).
        //
        // The bot ends up walking to `stancePos` via b.pathfinder.goto
        // below, then places the boat by looking at refBlock. So a
        // stance 2b from the water still works as long as the boat's
        // look-target is in reach (4.5b).
        const MAX_RING = 2;
        outer: for (let r = 1; r <= MAX_RING; r++) {
          const ring = [];
          for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
              if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
              // Prefer cardinals before diagonals within the ring.
              const prio = (dx === 0 || dz === 0) ? 0 : 1;
              ring.push({ dx, dz, prio });
            }
          }
          ring.sort((a, b2) => a.prio - b2.prio);
          for (const { dx, dz } of ring) {
            const candidate = refBlock.position.offset(dx, 1, dz);
            const blk = b.blockAt(candidate);
            const under = b.blockAt(candidate.offset(0, -1, 0));
            if (blk && (blk.name === 'air' || blk.boundingBox === 'empty') && under && under.boundingBox === 'block') {
              stancePos = candidate;
              break outer;
            }
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
            // F49 (task #66, v59): GoalNear with range=1 (not 0) — exact
            // cell was over-strict; pathfinder often gets within 1b but
            // not on the exact tile, throws, and the OLD catch returned
            // OUT_OF_RANGE even though the bot was now in water and
            // ready to place from-water. Use range=1 so the goto
            // succeeds when the bot is adjacent; AND when it does throw,
            // CHECK the bot's foot block before returning — if in
            // water, switch to from-water mode regardless.
            let gotoThrew = false;
            try {
              await pathfindGotoNear(b, goals, waterAdj.x, waterAdj.y, waterAdj.z, 1, { opName: 'place_boat', capMs: ACTION_CAPS_MS.reach });
            } catch {
              gotoThrew = true;
            }
            const newFoot = b.entity.position.floored();
            const newFootBlk = b.blockAt(newFoot);
            if (newFootBlk && (newFootBlk.name === 'water' || newFootBlk.name === 'flowing_water')) {
              stancePos = newFoot;
              placedFromWater = true;
              log(`[place_boat] no dry stance — walked into water at ${newFoot.x},${newFoot.y},${newFoot.z}, switching to from-water mode`);
            } else if (gotoThrew) {
              return { ok: false, error: {
                code: 'OUT_OF_RANGE',
                message: `No dry stance at (${x},${y},${z}) and pathfinder couldn't reach the water cell next door (bot still at ${newFoot.x},${newFoot.y},${newFoot.z} on ${newFootBlk?.name || 'unknown'}). The boat target may be open water far from any shore.`,
                observed_state: { target: [Number(x), Number(y), Number(z)], adjacent_water: [waterAdj.x, waterAdj.y, waterAdj.z], bot_foot: { x: newFoot.x, y: newFoot.y, z: newFoot.z, block: newFootBlk?.name } },
                retry_safe: true,
              }};
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
            await pathfindGotoNear(b, goals, stancePos.x, stancePos.y, stancePos.z, 1, { opName: 'place_boat_stance', capMs: ACTION_CAPS_MS.reach });
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
          await pathfindGotoNear(b, goals, target.position.x, target.position.y, target.position.z, 1, { opName: 'board', capMs: ACTION_CAPS_MS.reach });
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
     * Sail a mounted boat to (x, y, z) via a precomputed, collision-safe
     * tp-step path. Replaces the prior native/packet/probe steering
     * (deleted task #66): the planner walks the corridor up front,
     * shifts perpendicular around obstacles, and returns PATH_BLOCKED
     * when no clear lane exists. The driver tp-steps the boat through
     * each waypoint via PaperMCP — deterministic, no physics dependence.
     *
     * Action contract: NOT_MOUNTED, NOT_A_BOAT, PATH_BLOCKED, BOAT_LOST,
     * NO_PAPERMCP.
     */
    async sail({ x, y, z, timeout_seconds: _ts, allow_shore_early_exit: _ase, _from_sail_to, precomputed_path } = {}) {
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
      // Two planning paths:
      //   precomputed_path  → the caller (sail_to) already has the dense
      //     BFS water-cell path; we convert each cell to a boat waypoint
      //     and follow it directly. Guaranteed cell-by-cell navigable
      //     because the BFS only expanded into sailable cells.
      //   no precomputed_path  → fall back to planBoatPath's straight-line
      //     planner with perpendicular shifts. Useful for ad-hoc legs.
      let plan;
      let drive;
      let usedFallback = false;
      if (Array.isArray(precomputed_path) && precomputed_path.length > 0) {
        // Convert water-cell coords to boat waypoints (cell-center XZ +
        // boat float offset). Then check the first cell matches the
        // boat's current column (otherwise the caller has a stale path).
        const dy = 1.0625; // boat float offset above water_cell.y
        const boatPath = precomputed_path.map((c) => ({
          x: Math.floor(c.x) + 0.5,
          y: Math.floor(c.y) + dy,
          z: Math.floor(c.z) + 0.5,
        }));
        plan = { ok: true, path: boatPath, water_y: Math.floor(precomputed_path[0].y), source: 'precomputed' };
        drive = await executeBoatPath(b, boatPath, {
          executeServerCommand,
          paperMcpConfig,
          sleep,
          log,
        });
      } else {
        // Plan a collision-safe boat path from current boat position to
        // target. The planner snaps to cell centers, checks each step's
        // hitbox against blockAt, and shifts ±1/±2 perpendicular around
        // y=water_y obstacles.
        plan = planBoatPath(b, startPos, target);
        if (plan.ok) {
        // Easy case: drive the boat along the precomputed path.
        drive = await executeBoatPath(b, plan.path, {
          executeServerCommand,
          paperMcpConfig,
          sleep,
          log,
        });
      } else if (plan.reason === 'NARROW_CHANNEL') {
        // Precomputed path threads through a corridor too tight for
        // the ±2 perpendicular shift to clear. Drop into best-effort
        // packet-steering: same vehicle_move + player_input mechanism,
        // but with per-tick collision probes that refuse to push the
        // boat into a solid block. Vanilla physics handles drift around
        // small obstacles; we just halt if walled in.
        if (log) log(`[sail] planBoatPath returned NARROW_CHANNEL — falling back to bestEffortSail`);
        usedFallback = true;
        drive = await bestEffortSail(b, target, { sleep, log });
      } else {
        // NOT_ON_WATER or other unrecoverable plan failures — auto-
        // disembark so Steve isn't stranded mid-ocean.
        let autoDisembark = null;
        if (ACTIONS && typeof ACTIONS.disembark === 'function') {
          try {
            const dis = await ACTIONS.disembark({ fromSailFallback: true });
            autoDisembark = { ok: !!dis?.ok, ...(dis?.data ? { data: dis.data } : {}), ...(dis?.error ? { error: dis.error } : {}) };
          } catch (e) {
            autoDisembark = { ok: false, error: e?.message || String(e) };
          }
        }
        return { ok: false, error: {
          code: 'PATH_BLOCKED',
          message: `Could not find a collision-safe boat path to (${Math.floor(target.x)},${Math.floor(target.y)},${Math.floor(target.z)}): ${plan.message || plan.reason}.${autoDisembark?.ok ? ' Auto-disembarked.' : ''}`,
          observed_state: {
            boat_pos: [Number(startPos.x.toFixed(2)), Number(startPos.y.toFixed(2)), Number(startPos.z.toFixed(2))],
            target: [Number(target.x), Number(target.y), Number(target.z)],
            plan_reason: plan.reason,
            blockers: plan.blockers || [],
            water_y: plan.water_y ?? null,
            ...(autoDisembark ? { auto_disembark: autoDisembark } : {}),
          },
          next_action_hint: autoDisembark?.ok ? 'mc status' : 'mc disembark',
          retry_safe: false,
        }};
      }
      } // close outer else (precomputed_path)

      if (!drive.ok) {
        // Boat died mid-sail (entity attacked, despawn, etc.) or tp
        // failed. Either way Steve is in water — try to auto-disembark
        // so the recovery path swims him to shore.
        //
        // Task #66: scan for the nearest standable dry shore around
        // wherever the boat died and pass it as target_shore to
        // disembark. This avoids the failure mode where vanilla MC
        // drops the rider at the boat's last position (often over
        // water) and Steve ends up swimming with no recovery path.
        const broke = drive.broke_at;
        let nearbyDryShore = null;
        if (broke) {
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
          try {
            const r = findAdjustedTarget(
              b,
              isStandableLand,
              Math.floor(broke.x),
              Math.floor(broke.y),
              Math.floor(broke.z),
              12,
            );
            if (r && r.adjusted) {
              nearbyDryShore = { x: r.x, y: r.y, z: r.z };
            }
          } catch { /* no shore in range — fall back to legacy disembark */ }
        }
        let autoDisembark = null;
        if (ACTIONS && typeof ACTIONS.disembark === 'function') {
          try {
            const dis = await ACTIONS.disembark({
              fromSailFallback: true,
              ...(nearbyDryShore ? { target_shore: nearbyDryShore } : {}),
            });
            autoDisembark = { ok: !!dis?.ok, ...(dis?.data ? { data: dis.data } : {}), ...(dis?.error ? { error: dis.error } : {}) };
          } catch (e) {
            autoDisembark = { ok: false, error: e?.message || String(e) };
          }
        }
        // Map driver-level error to action-level code:
        //   STALLED  → PATH_BLOCKED (boat is fine; corridor doesn't progress)
        //   TIMEOUT  → PATH_BLOCKED (gave up before reaching target)
        //   NO_PAPERMCP → NO_PAPERMCP
        //   anything else (BOAT_LOST / TP_FAILED) → BOAT_LOST
        let code;
        if (drive.error === 'NO_PAPERMCP') code = 'NO_PAPERMCP';
        else if (drive.error === 'STALLED' || drive.error === 'TIMEOUT') code = 'PATH_BLOCKED';
        else code = 'BOAT_LOST';
        const message = code === 'NO_PAPERMCP'
          ? 'PaperMCP unavailable — cannot drive the boat. Sail requires the PaperMCP server-side tp fallback.'
          : code === 'PATH_BLOCKED'
          ? `Sail could not reach (${Math.floor(target.x)},${Math.floor(target.y)},${Math.floor(target.z)}): boat ${drive.error.toLowerCase()} after ${drive.after_steps || 0} steps near (${drive.broke_at ? `${Math.floor(drive.broke_at.x)},${Math.floor(drive.broke_at.y)},${Math.floor(drive.broke_at.z)}` : 'unknown'}).${drive.blocker ? ` Blocker: ${drive.blocker.name} at (${drive.blocker.x},${drive.blocker.y},${drive.blocker.z}).` : ''}${autoDisembark?.ok ? ' Auto-disembarked.' : ''}`
          : `Boat lost mid-sail (${drive.error || 'unknown'}) after ${drive.after_steps || 0} steps near (${drive.broke_at ? `${Math.floor(drive.broke_at.x)},${Math.floor(drive.broke_at.y)},${Math.floor(drive.broke_at.z)}` : 'unknown'}).${autoDisembark?.ok ? ' Auto-disembarked.' : ''}`;
        return { ok: false, error: {
          code,
          message,
          observed_state: {
            boat_pos_start: [Number(startPos.x.toFixed(2)), Number(startPos.y.toFixed(2)), Number(startPos.z.toFixed(2))],
            broke_at: drive.broke_at,
            after_steps: drive.after_steps,
            mechanism: drive.mechanism || (usedFallback ? 'best_effort' : 'precomputed'),
            ...(drive.blocker ? { blocker: drive.blocker } : {}),
            ...(autoDisembark ? { auto_disembark: autoDisembark } : {}),
          },
          next_action_hint: autoDisembark?.ok ? 'mc status' : 'mc disembark',
          retry_safe: code !== 'NO_PAPERMCP',
        }};
      }

      // Success — boat is at the final waypoint.
      const finalPos = drive.final || { x: target.x, y: startPos.y, z: target.z };
      const remaining = Math.hypot(target.x - finalPos.x, target.z - finalPos.z);
      return {
        ok: true,
        command: 'sail',
        data: {
          from: [Math.floor(startPos.x), Math.floor(startPos.y), Math.floor(startPos.z)],
          to: [Math.floor(finalPos.x), Math.floor(finalPos.y), Math.floor(finalPos.z)],
          target: [Number(x), Number(y), Number(z)],
          horizontal_distance_remaining: Number(remaining.toFixed(2)),
          steps: drive.steps,
          mechanism: drive.mechanism || (usedFallback ? 'best_effort' : 'precomputed'),
          ...(plan.ok ? { path_blockers_avoided: plan.path.length - drive.steps } : {}),
        },
      };
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
    async sail_to(args) {
      // task #43 (v30): thin wrapper around _sailToImpl that records
      // per-target retry counts. After SAIL_TO_RETRY_LIMIT failures to
      // the same target, the impl itself surfaces SAIL_TO_RETRY_LOOP.
      // NOTE: uses sailToImplRef (closure-captured reference set
      // post-object-construction) instead of `this._sailToImpl` because
      // the action dispatcher invokes methods as detached functions —
      // `this` is undefined at call time. The closure ref dodges that.
      //
      // F25 (task #63, v42): set the sailToActive flag for the
      // reactive layer so its auto_escape_water + head_in_water
      // swim_up branches stand down while sail_to drives pathfinder
      // through water-adjacent terrain. Pre-fix, the reactive's
      // `setGoal(null)` raced against walk_to_entry and surfaced
      // "The goal was changed before it could be completed!" errors
      // (circuit-v42 forensics). try/finally guarantees the flag is
      // cleared on success, refusal envelope, AND throw — the
      // staleness check in shouldSuppressAutoEscape is the
      // belt-and-suspenders if even the finally somehow misses.
      //
      // F28 (task #66, v44): the original implementation set the
      // flag ONCE at entry, but sail_to phases can collectively
      // exceed the 60s staleness window — circuit-v44 forensics
      // showed a real journey running 2m30s end-to-end (HTTP client
      // aborted at 25s but the body kept sailing). Once staleness
      // expired, reactive's swim_up resumed firing mid-sail and
      // cancelled pathfinder goals all over again. A heartbeat
      // timer refreshes the flag every 15s while sail_to runs, so
      // the gate stays armed for the full journey but still expires
      // ≤60s after a true crash. The heartbeat is cleared in the
      // finally; flag itself also cleared (same equality guard as
      // before so overlapping calls don't trample each other).
      let result;
      let sailToStartedAt = Date.now();
      let heartbeat = null;
      if (ctx?.runtime) {
        ctx.runtime.sailToActiveStartedAt = sailToStartedAt;
        heartbeat = setInterval(() => {
          // Only refresh if WE still own the flag — an overlapping
          // sail_to wrapper would have replaced sailToStartedAt with
          // its own value; in that case stop touching it.
          if (ctx.runtime.sailToActiveStartedAt === sailToStartedAt) {
            sailToStartedAt = Date.now();
            ctx.runtime.sailToActiveStartedAt = sailToStartedAt;
          }
        }, 15_000);
        if (typeof heartbeat?.unref === 'function') heartbeat.unref();
      }
      try {
        result = await sailToImplRef(args);
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (ctx?.runtime && ctx.runtime.sailToActiveStartedAt === sailToStartedAt) {
          ctx.runtime.sailToActiveStartedAt = null;
        }
      }
      const tx = Number(args?.x), ty = Number(args?.y), tz = Number(args?.z);
      if (Number.isFinite(tx) && Number.isFinite(ty) && Number.isFinite(tz)) {
        const targetKey = `${Math.floor(tx)},${Math.floor(ty)},${Math.floor(tz)}`;
        if (result?.ok) {
          sailToRetryCounts.delete(targetKey);
        } else {
          // Don't count refusals that signal "nothing to retry" or
          // that are the loop-detector itself (avoid double-counting).
          const code = result?.error?.code;
          const noCountCodes = new Set(['INVALID_COORD', 'NO_BOAT', 'SAIL_TO_RETRY_LOOP']);
          if (code && !noCountCodes.has(code)) {
            const prior = sailToRetryCounts.get(targetKey) || { count: 0, lastErrorCode: null, lastNearestWater: null, lastShoreStance: null };
            // F18 (task #56, v38): remember the last nearest_water_candidate
            // so the SAIL_TO_RETRY_LOOP refusal can surface a concrete
            // bg_goto coord instead of just "mc advise." Pre-fix, the
            // agent followed the mc-advise hint, got circular advice
            // ("retry sail_to"), and burned LLM cycles ping-ponging.
            // The candidate lives on result.error.observed_state OR
            // observed_state.water_route_state — both shapes exist
            // depending on which inner code returned.
            const obs = result?.error?.observed_state || {};
            const nearestCandidate =
              (obs.nearest_water_candidate && Number.isFinite(obs.nearest_water_candidate.x))
                ? obs.nearest_water_candidate
                : (obs.water_route_state?.nearest_water_candidate && Number.isFinite(obs.water_route_state.nearest_water_candidate.x))
                  ? obs.water_route_state.nearest_water_candidate
                  : prior.lastNearestWater;
            // F21 (task #59, v42): water candidates are unwalkable. Also
            // remember the SHORE STANCE (dry cell adjacent) so the retry-loop
            // refusal hands the agent a coord mc bg_goto will accept.
            const nearestShoreStance =
              (obs.nearest_shore_stance && Number.isFinite(obs.nearest_shore_stance.x))
                ? obs.nearest_shore_stance
                : (obs.water_route_state?.nearest_shore_stance && Number.isFinite(obs.water_route_state.nearest_shore_stance.x))
                  ? obs.water_route_state.nearest_shore_stance
                  : prior.lastShoreStance;
            // F19 (task #57): also record the bot's position at the time of
            // failure. If the bot moves significantly before its next
            // attempt, the retry-loop check resets (different position →
            // different BFS plan → previous failures shouldn't gate).
            const b = ensureBot();
            const failurePos = b?.entity?.position
              ? { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z }
              : null;
            sailToRetryCounts.set(targetKey, {
              count: prior.count + 1,
              lastErrorCode: code,
              lastNearestWater: nearestCandidate,
              lastShoreStance: nearestShoreStance,
              lastFailurePos: failurePos,
            });
          }
        }
      }
      return result;
    },

    async _sailToImpl({ x, y, z }) {
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
      // F34 (task #66, v48): structured diagnostics at every phase
      // boundary. circuit-v48 forensics took ~10 minutes to reconstruct
      // because the bot log only logged "[disembark] last-resort" — no
      // record of WHERE the boat wedged, what the surrounding blocks
      // were, or whether the bot was suffocating. With this trace the
      // postmortem becomes: grep '[sail_to]' /tmp/bot-steve.log.
      //
      // Format: `[sail_to <phase>] <key=value …>` so it's grep-friendly
      // and uniform. Block-context lines (foot/head names) are the
      // load-bearing ones for "bot stuck in solid" investigations.
      const sailLog = (phase, ...kvs) => {
        const head = `[sail_to ${phase}]`;
        const body = kvs.join(' ');
        try { log(`${head} ${body}`); } catch { /* logger always available, defensive */ }
      };
      const fmtPos = (p) => p && Number.isFinite(p.x)
        ? `(${p.x.toFixed ? p.x.toFixed(1) : p.x},${p.y.toFixed ? p.y.toFixed(1) : p.y},${p.z.toFixed ? p.z.toFixed(1) : p.z})`
        : String(p);
      const blockName = (px, py, pz) => {
        try {
          const blk = b.blockAt(new Vec3(Math.floor(px), Math.floor(py), Math.floor(pz)));
          return blk?.name || 'unknown';
        } catch { return 'unknown'; }
      };
      const fmtFootHead = (p) => p
        ? `foot=${blockName(p.x, p.y, p.z)} head=${blockName(p.x, p.y + 1, p.z)} below=${blockName(p.x, p.y - 1, p.z)}`
        : 'foot=? head=? below=?';
      const targetKey = `${Math.floor(target.x)},${Math.floor(target.y)},${Math.floor(target.z)}`;
      const startedAt = Date.now();
      const phases = []; // names of phases that actually ran
      const startPos = {
        x: b.entity.position.x,
        y: b.entity.position.y,
        z: b.entity.position.z,
      };
      sailLog('start', `target=${fmtPos(target)}`, `bot=${fmtPos(startPos)}`,
        fmtFootHead(b.entity.position.floored()),
        `mounted=${!!b.vehicle}`,
        `boats_inv=${b.inventory?.items?.().filter((it) => BOAT_NAMES.has(it.name)).reduce((s, it) => s + it.count, 0) ?? 0}`,
      );

      // task #43 (v30): retry-loop guard. After SAIL_TO_RETRY_LIMIT
      // consecutive failures to the same target, refuse with
      // SAIL_TO_RETRY_LOOP and hint mc advise. v29 showed the agent
      // can burn unbounded tokens retrying the same broken sail_to
      // with no new information; this gives it a definitive stop.
      //
      // F19 (task #57, v39): if the bot has moved >RETRY_RESET_DISTANCE
      // blocks since the last failure was recorded, reset the counter.
      // The BFS plan and nearest_water_candidate are position-dependent;
      // a fresh position deserves a fresh budget. Pre-F19, Steve standing
      // 7b from water still got the retry-loop refusal from prior
      // failures at base (50+b away).
      let priorRetry = sailToRetryCounts.get(targetKey);
      if (priorRetry?.lastFailurePos) {
        const dxz = Math.hypot(
          startPos.x - priorRetry.lastFailurePos.x,
          startPos.z - priorRetry.lastFailurePos.z,
        );
        if (dxz > RETRY_RESET_DISTANCE) {
          sailToRetryCounts.delete(targetKey);
          priorRetry = undefined;
        }
      }
      if (priorRetry && priorRetry.count >= SAIL_TO_RETRY_LIMIT) {
        // F18 (task #56, v38): if a nearest_water_candidate was found
        // on a prior attempt, surface that coord directly so the agent
        // can mc bg_goto to it without going through advise. v37/v38
        // saw the sail_to ↔ mc advise ping-pong loop where advise
        // (no retry-counter awareness) recommended retrying sail_to.
        // A concrete coord short-circuits the loop.
        // F21 (task #59, v42): prefer the SHORE STANCE coord (walkable)
        // over the water candidate (which mc bg_goto refuses as
        // NAV_TARGET_UNSTANDABLE). Both are retained in observed_state
        // for debugging, but the hint points to the cell the agent can
        // actually walk to.
        const stance = priorRetry.lastShoreStance;
        const nw = priorRetry.lastNearestWater;
        const hintCoord = stance || nw;
        const hintLabel = stance ? 'walkable shore' : 'nearest water';
        const nextHint = hintCoord
          ? `mc bg_goto ${hintCoord.x} ${hintCoord.y} ${hintCoord.z}  # ${hintLabel} — then mc sail_to ${target.x} ${target.y} ${target.z} again from there`
          : 'mc advise --reason="sail_to stuck retrying"';
        return {
          ok: false,
          error: {
            code: 'SAIL_TO_RETRY_LOOP',
            message: `${priorRetry.count} consecutive sail_to calls to (${target.x}, ${target.y}, ${target.z}) have failed (last error: ${priorRetry.lastErrorCode || 'unknown'}). The body cannot make progress to this target on its own.${stance ? ` Walk to the shore stance at (${stance.x}, ${stance.y}, ${stance.z}) first — sail_to from there will see a fresh entry.` : nw ? ` Walk near the water at (${nw.x}, ${nw.y}, ${nw.z}) first — sail_to from there will see a fresh entry.` : ' Pick a different waypoint or call mc advise.'}`,
            observed_state: {
              retry_count: priorRetry.count,
              last_error_code: priorRetry.lastErrorCode,
              target,
              ...(nw ? { nearest_water_candidate: nw } : {}),
              ...(stance ? { nearest_shore_stance: stance } : {}),
            },
            next_action_hint: nextHint,
            retry_safe: false,
          },
        };
      }

      // ── Phase: at_target ────────────────────────────────────────────
      const horizToTarget = Math.hypot(startPos.x - target.x, startPos.z - target.z);
      if (horizToTarget < 4) {
        phases.push('at_target');
        // Success — clear any retry record for this target.
        sailToRetryCounts.delete(targetKey);
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
      // F43 (task #66, v55): if the bot is already submerged, lower the
      // BFS's MIN_USEFUL_SAIL threshold to 1. Pre-fix the F19 20b minimum
      // refused a 16b sail to dry shore — even though that 16b would
      // have RESCUED the swimming bot. For dry-land callers, the 20b
      // default still applies: a 5b crossing isn't worth the place_boat
      // overhead when walking is an option.
      const botFootPos0 = b.entity.position.floored();
      const botFootBlk0 = b.blockAt(botFootPos0);
      const botInWaterAtPlanTime = !!botFootBlk0 && (botFootBlk0.name === 'water' || botFootBlk0.name === 'flowing_water');
      const routeRes = planWaterRoute(b, planStart, target, {
        min_useful_sail: botInWaterAtPlanTime ? 1 : undefined,
      });
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
        // F10 (task #48): if planWaterRoute attached a nearest_water_candidate
        // (via its widened findBlocks scan), promote it into the
        // sail_to-level next_action_hint so the agent gets a concrete
        // coord to bg_goto toward — no exploration loop needed.
        //
        // F21 (task #59, v42): prefer nearest_shore_stance (a walkable
        // dry cell adjacent to the water) over nearest_water_candidate
        // (a water cell, which mc bg_goto refuses with
        // NAV_TARGET_UNSTANDABLE). v41 postmortem: every sail_to refusal
        // shipped a water coord; agent walked toward the area with
        // chained mc move calls and ended up swimming.
        const nearestStance = routeRes.error.observed_state?.nearest_shore_stance;
        const nearestCandidate = routeRes.error.observed_state?.nearest_water_candidate;
        let nextHint;
        if (nearestStance) {
          nextHint = `mc bg_goto ${nearestStance.x} ${nearestStance.y} ${nearestStance.z}  # walkable shore — then mc sail_to ${target.x} ${target.y} ${target.z}`;
        } else if (nearestCandidate) {
          nextHint = `mc bg_goto ${nearestCandidate.x} ${nearestCandidate.y} ${nearestCandidate.z}  # nearest water — then mc sail_to ${target.x} ${target.y} ${target.z}`;
        } else if (routeRes.error.code === 'NO_WATER_ROUTE') {
          // F10: no water found in the 12b entry scan AND no candidate
          // returned by the wider 64b findBlocks scan. Recommend mc advise
          // — its perception bundle + LLM analysis can recommend a route
          // the body's spatial scans don't see (e.g. across a desert).
          nextHint = `mc advise --reason="find shore to sail to ${target.x},${target.y},${target.z}" --target ${target.x},${target.y},${target.z}`;
        } else if (routeRes.error.code === 'POND_DISCONNECTED') {
          // Pond case — Steve is in/at a small isolated water body.
          // bg_goto out to a real coast (agent has to pick the coord).
          nextHint = 'mc bg_goto <coast coords>  # then mc sail_to again';
        } else {
          nextHint = 'mc bg_goto <target>';
        }
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
              ...(nearestCandidate ? { nearest_water_candidate: nearestCandidate } : {}),
              ...(nearestStance ? { nearest_shore_stance: nearestStance } : {}),
            },
            next_action_hint: nextHint,
            retry_safe: false,
          },
        };
      }

      const route = routeRes.data;
      sailLog('plan_route',
        `entry_water=${fmtPos(route.entry_water)}`,
        `entry_shore=${fmtPos(route.entry_shore)}`,
        `exit_water=${fmtPos(route.exit_water)}`,
        `exit_shore=${fmtPos(route.exit_shore)}`,
        `waypoints=${route.waypoints?.length ?? 0}`,
        `partial=${!!route.partial}`,
        `sail_distance=${route.sail_distance ?? '?'}`,
      );

      // Sail one leg per BFS waypoint. waypoints[0] is the entry_water
      // (already there post-mount, or current position when resuming);
      // skip it and step through waypoints[1..N]. Each call to sail()
      // has only ~8 blocks to cover, so it can't drift wide and ram
      // obstacles BFS deliberately routed around. Middle legs pass
      // allow_shore_early_exit=false so SHORE_REACHED doesn't trip on
      // a coast-adjacent waypoint mid-route; only the last leg uses
      // the default behavior (so reaching the destination shore still
      // surfaces shore_reached for the disembark phase).
      // Task #66: drive the boat along the dense BFS cell path in ONE
      // sail() call. Pre-fix, sailLegs called sail() once per sparse
      // waypoint (~8b spacing) — each call ran planBoatPath in a
      // straight line to the next waypoint, which would fail when the
      // BFS path bent around obstacles that planBoatPath's ±2
      // perpendicular shift can't replicate. With the dense path,
      // every consecutive pair is guaranteed cardinal-adjacent
      // sailable water (BFS expansion predicate), so no in-flight
      // collision search is needed.
      const sailLegs = async (legs) => {
        const lastWp = legs[legs.length - 1];
        // Trust the BFS dense path if available; else fall back to
        // sparse waypoints (one sail() call per waypoint).
        if (route?.cells_path && route.cells_path.length > 1) {
          const legRes = await ACTIONS.sail({
            x: lastWp.x, y: lastWp.y, z: lastWp.z,
            allow_shore_early_exit: true,
            _from_sail_to: true,
            precomputed_path: route.cells_path,
          });
          if (!legRes.ok) {
            return {
              ok: false,
              leg_index: 0,
              waypoint: lastWp,
              inner_error: legRes.error,
            };
          }
          return { ok: true, detoursTaken: [] };
        }
        // Fallback: sparse-waypoint chain (legacy path).
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
            return { ok: false, leg_index: i, waypoint: wp, inner_error: legRes.error };
          }
          if (legRes.data?.detours) detoursTaken.push(...legRes.data.detours);
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

      // F9 (task #47): detect "bot already submerged" — sail_to's normal
      // walk_to_entry path can't help here (pathfinder can't reach the
      // entry shore from mid-water). Run a rescue branch that places a
      // boat at the bot's current foot cell, mounts, and continues to
      // sail. This restores the pre-F2 "rescue from open ocean" path
      // (originally circuit-v1) but only via an explicit rescue flag —
      // F2's BOT_IN_WATER refusal still catches walk_to_entry cascade
      // failures.
      const botFootPos = b.entity.position.floored();
      const botFootBlock = b.blockAt(botFootPos);
      // Task #66: include "floating on water surface" as in-water case.
      // After a boat breaks mid-sail, mineflayer reports bot.y = water_y+1
      // — foot cell is AIR but the cell BELOW is water. Pre-fix, sail_to
      // routed this through walk_to_entry which can't pathfind from a
      // swimming position; pathfinder timed out at 8s and the agent
      // looped indefinitely (SAIL_TO_RETRY_LOOP after 4 tries).
      const botBelowBlock = b.blockAt(new Vec3(botFootPos.x, botFootPos.y - 1, botFootPos.z));
      const footIsWater = botFootBlock && (botFootBlock.name === 'water' || botFootBlock.name === 'flowing_water');
      const swimmingOnSurface = !footIsWater
        && botFootBlock && (botFootBlock.name === 'air' || botFootBlock.name === 'cave_air' || botFootBlock.name === 'void_air')
        && botBelowBlock && (botBelowBlock.name === 'water' || botBelowBlock.name === 'flowing_water')
        && !b.entity.onGround;
      const botInWater = !!(footIsWater || swimmingOnSurface);

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
      } else if (botInWater) {
        // ── Phase: in_water_rescue ────────────────────────────────────
        // Bot is currently submerged OR swimming on water surface —
        // skip walk_to_entry (pathfinder fails from water) and place
        // the boat AT the water cell via place_boat's from-water rescue
        // mode. When the bot is floating ON the surface (foot=air,
        // below=water), the actual water cell is one below the foot
        // position; submerged bots have foot=water directly.
        phases.push('in_water_rescue', 'mount');
        const rescueWaterPos = swimmingOnSurface
          ? new Vec3(botFootPos.x, botFootPos.y - 1, botFootPos.z)
          : botFootPos;
        try {
          const placeRes = await ACTIONS.place_boat({
            x: rescueWaterPos.x,
            y: rescueWaterPos.y,
            z: rescueWaterPos.z,
            _from_sail_to: true,
            _rescue_from_water: true,
          });
          if (!placeRes?.ok) {
            return {
              ok: false,
              error: {
                code: 'RESCUE_PLACE_FAILED',
                message: `In-water rescue: place_boat at current foot (${botFootPos.x}, ${botFootPos.y}, ${botFootPos.z}) failed: ${placeRes?.error?.message || 'place_boat refused'}. Bot is stranded in water; try mc escape or chat for help.`,
                observed_state: { place_boat_error: placeRes?.error, bot_foot: botFootPos, route },
                next_action_hint: 'mc escape   # try non-boat water escape first',
                retry_safe: true,
              },
            };
          }
          const boardRes = await ACTIONS.board({ _from_sail_to: true });
          if (!boardRes?.ok) {
            return {
              ok: false,
              error: {
                code: 'RESCUE_MOUNT_FAILED',
                message: `In-water rescue: boat placed at (${botFootPos.x}, ${botFootPos.y}, ${botFootPos.z}) but board failed: ${boardRes?.error?.message || 'board refused'}. Re-call mc sail_to ${target.x} ${target.y} ${target.z} to retry from here.`,
                observed_state: { board_error: boardRes?.error, bot_foot: botFootPos, route },
                next_action_hint: `mc sail_to ${target.x} ${target.y} ${target.z}`,
                retry_safe: true,
              },
            };
          }
        } catch (e) {
          return {
            ok: false,
            error: {
              code: 'RESCUE_MOUNT_FAILED',
              message: `In-water rescue threw: ${e?.message || e}`,
              retry_safe: true,
            },
          };
        }

        // Now mounted — sail toward the BFS-planned exit_water along
        // the waypoint chain. (The BFS plan's entry_water may not
        // match botFootPos exactly, but sail()'s leg-following
        // navigates per-waypoint regardless of where we boarded.)
        phases.push('sail');
        try {
          const legsRes = await sailLegs(legs);
          if (!legsRes.ok) {
            return {
              ok: false,
              error: {
                code: 'SAIL_FAILED',
                message: `Rescue-sail failed on leg ${legsRes.leg_index + 1}/${legs.length} (waypoint ${legsRes.waypoint.x},${legsRes.waypoint.y},${legsRes.waypoint.z}): ${legsRes.inner_error?.message || 'unknown'}. Re-call mc sail_to ${target.x} ${target.y} ${target.z}.`,
                observed_state: { sail_error: legsRes.inner_error, leg_index: legsRes.leg_index, waypoint: legsRes.waypoint, route },
                next_action_hint: `mc sail_to ${target.x} ${target.y} ${target.z}`,
                retry_safe: true,
              },
            };
          }
        } catch (e) {
          return {
            ok: false,
            error: { code: 'SAIL_FAILED', message: `Rescue-sail threw: ${e?.message || e}`, retry_safe: true },
          };
        }
      } else {
        // ── Phase: walk_to_entry ─────────────────────────────────────
        phases.push('walk_to_entry');
        sailLog('walk_to_entry start',
          `entry_shore=${fmtPos(route.entry_shore)}`,
          `bot=${fmtPos(b.entity.position)}`,
        );
        try {
          const entry = route.entry_shore;
          // F26 (task #64, v42): wallclock cap + progress watchdog,
          // matching mc bg_goto / mc move. Pre-F26 the bare
          // `b.pathfinder.goto` had no cap, no stall detection, and no
          // onStall to clear a wedged goal. circuit-v42 forensics saw
          // walk_to_entry hit the HTTP 25s timeout (AbortError) AND
          // throw "The goal was changed before it could be completed!"
          // when the reactive layer (F25 root cause) cancelled the goal
          // mid-walk. F25 stops the reactive race; F26 stops the bot
          // from waiting forever when the pathfinder genuinely stalls.
          // Uses ACTION_CAPS_MS.goto_near (8s) — entry_shore is by
          // construction within ~14b of bot (entry_search_radius=12).
          await pathfindWithProgressWatchdog({
            bot: b,
            pathfinderGoto: () => b.pathfinder.goto(new goals.GoalNear(entry.x, entry.y, entry.z, 1)),
            onStall: () => { try { b.pathfinder.setGoal(null); } catch {} },
            opName: 'walk_to_entry',
            capMs: ACTION_CAPS_MS.goto_near,
          });
          sailLog('walk_to_entry done',
            `bot=${fmtPos(b.entity.position)}`,
            fmtFootHead(b.entity.position.floored()),
          );
        } catch (e) {
          sailLog('walk_to_entry FAILED',
            `bot=${fmtPos(b.entity.position)}`,
            `reason=${e?.message || e}`,
          );
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

        // v30 F3: post-walk water-drop guard. GoalNear(entry_shore, 1)
        // doesn't forbid water cells along the path. On beaches with
        // shallow water adjacent to land, the pathfinder cheerfully
        // walks Steve through 1-deep water and sometimes leaves him
        // standing IN the water rather than on the entry shore. Then
        // place_boat sees Steve submerged and (pre-F2) silently
        // placed a boat at his foot — useless. F2 now refuses that;
        // F3 catches the condition one phase earlier with a more
        // informative envelope so the agent doesn't see a misleading
        // MOUNT_FAILED wrapping a BOT_IN_WATER inner error.
        try {
          const footPos = b.entity.position.floored();
          const footBlock = b.blockAt(footPos);
          if (footBlock && (footBlock.name === 'water' || footBlock.name === 'flowing_water')) {
            return {
              ok: false,
              error: {
                code: 'WALK_TO_ENTRY_DROPPED_IN_WATER',
                message: `walk_to_entry's pathfinder routed bot through water and left it submerged at (${footPos.x}, ${footPos.y}, ${footPos.z}) instead of on the entry shore at (${route.entry_shore.x}, ${route.entry_shore.y}, ${route.entry_shore.z}). Cannot place a boat from-water cleanly. Escape water first; re-call sail_to and the BFS will pick a different entry shore from your new position.`,
                observed_state: {
                  bot_foot: { x: footPos.x, y: footPos.y, z: footPos.z },
                  foot_block: footBlock.name,
                  intended_entry_shore: route.entry_shore,
                },
                next_action_hint: 'mc escape',
                retry_safe: true,
              },
            };
          }
        } catch {
          // blockAt threw — chunk unloaded or transient. Proceed; the
          // mount phase will surface the real error if there is one.
        }

        // ── Phase: mount ─────────────────────────────────────────────
        phases.push('mount');
        sailLog('mount start',
          `entry_water=${fmtPos(route.entry_water)}`,
          `entry_water_ctx=${fmtFootHead(route.entry_water)}`,
          `bot=${fmtPos(b.entity.position)}`,
        );
        try {
          const placeRes = await ACTIONS.place_boat({
            x: route.entry_water.x,
            y: route.entry_water.y,
            z: route.entry_water.z,
            _from_sail_to: true,
          });
          if (!placeRes?.ok) {
            sailLog('mount FAILED', `phase=place_boat`, `error=${placeRes?.error?.code || 'unknown'}`);
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
          // F35 (task #66, v48 gap 1): boat placement safety check.
          // place_boat may adjust the placement to a different cell
          // than entry_water (shore-water fallback, etc.). Before
          // committing to the mount, verify the boat is in a cell
          // where the RIDER won't suffocate. The rider sits at
          // boat.y + 1 (just above water surface) with head at +2.
          // circuit-v48 forensics: boat was placed under a cobble
          // wall at y=63; Steve mounted, got snapped to rider-Y=63
          // which was inside the cobble; suffocation. With this
          // check the boat is despawned BEFORE board() is called
          // and the agent gets a clean BOAT_PLACEMENT_UNSAFE refusal.
          const placedAt = Array.isArray(placeRes?.data?.boat_position)
            ? { x: placeRes.data.boat_position[0], y: placeRes.data.boat_position[1], z: placeRes.data.boat_position[2] }
            : null;
          if (placedAt) {
            const riderFootName = blockName(placedAt.x, placedAt.y + 1, placedAt.z);
            const riderHeadName = blockName(placedAt.x, placedAt.y + 2, placedAt.z);
            const isAirish = (n) => n === 'air' || n === 'cave_air' || n === 'void_air';
            // Water counts as occupiable for the rider — boats sit at the
            // water surface so foot/head being water is normal mid-lake.
            const isAirOrWater = (n) => isAirish(n) || n === 'water' || n === 'flowing_water';
            if (!isAirOrWater(riderFootName) || !isAirish(riderHeadName)) {
              sailLog('mount FAILED', `phase=placement_unsafe`,
                `boat=${fmtPos(placedAt)}`,
                `rider_foot_block=${riderFootName}`,
                `rider_head_block=${riderHeadName}`,
              );
              // Despawn the boat before returning so the agent's next
              // attempt isn't blocked by the wedged boat entity.
              try {
                await ACTIONS.disembark({ emergency: true });
              } catch { /* best-effort cleanup */ }
              return {
                ok: false,
                error: {
                  code: 'BOAT_PLACEMENT_UNSAFE',
                  message: `Boat landed at (${placedAt.x}, ${placedAt.y}, ${placedAt.z}) but the rider position is obstructed: foot=${riderFootName}, head=${riderHeadName}. Mounting here would suffocate the bot. Move to a different shore stance and re-call sail_to from there.`,
                  observed_state: {
                    boat_position: placedAt,
                    rider_foot_block: riderFootName,
                    rider_head_block: riderHeadName,
                    route,
                  },
                  next_action_hint: `mc bg_goto ${route.entry_shore.x} ${route.entry_shore.y} ${route.entry_shore.z}  # try a different shore stance`,
                  retry_safe: true,
                },
              };
            }
          }
          const boardRes = await ACTIONS.board({ _from_sail_to: true });
          if (!boardRes?.ok) {
            sailLog('mount FAILED', `phase=board`, `error=${boardRes?.error?.code || 'unknown'}`);
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
          // F36 (task #66, v48 gap 3): post-mount rider safety check.
          // Even with gap-1's placement check, server-side physics can
          // snap the rider to a slightly different cell than the boat
          // (boat hitbox vs rider hitbox). After board() returns ok,
          // re-check the rider's actual head block. If solid, the
          // mount is unsafe — disembark immediately and surface a
          // clean refusal instead of letting Steve take suffocation
          // damage during the sail leg.
          await sleep(150); // let physics settle so rider position is accurate
          const boatPos = b.vehicle?.position;
          const riderPos = b.entity?.position;
          const headSolidName = riderPos
            ? blockName(riderPos.x, Math.floor(riderPos.y + 1), riderPos.z)
            : '?';
          const footSolidName = riderPos
            ? blockName(riderPos.x, Math.floor(riderPos.y), riderPos.z)
            : '?';
          sailLog('mount done',
            `boat=${fmtPos(boatPos)}`,
            `rider=${fmtPos(riderPos)}`,
            `rider_foot=${footSolidName}`,
            `rider_head=${headSolidName}`,
            riderPos ? fmtFootHead(riderPos.floored()) : '',
          );
          const isAirish = (n) => n === 'air' || n === 'cave_air' || n === 'void_air';
          const isAirOrWater = (n) => isAirish(n) || n === 'water' || n === 'flowing_water';
          if (!isAirOrWater(footSolidName) || !isAirish(headSolidName)) {
            sailLog('mount UNSAFE — disembarking',
              `rider_foot=${footSolidName}`,
              `rider_head=${headSolidName}`,
            );
            try {
              await ACTIONS.disembark({ emergency: true });
            } catch { /* best-effort */ }
            return {
              ok: false,
              error: {
                code: 'MOUNT_UNSAFE',
                message: `Mount succeeded but rider hitbox is obstructed at (${Math.floor(riderPos.x)}, ${Math.floor(riderPos.y)}, ${Math.floor(riderPos.z)}): foot=${footSolidName}, head=${headSolidName}. Auto-disembarked before suffocation damage. Move to a different shore stance and re-call sail_to.`,
                observed_state: {
                  rider_position: riderPos ? { x: riderPos.x, y: riderPos.y, z: riderPos.z } : null,
                  rider_foot_block: footSolidName,
                  rider_head_block: headSolidName,
                  route,
                },
                next_action_hint: `mc bg_goto ${route.entry_shore.x} ${route.entry_shore.y} ${route.entry_shore.z}  # try a different shore stance`,
                retry_safe: true,
              },
            };
          }
        } catch (e) {
          sailLog('mount FAILED', `phase=throw`, `error=${e?.message || e}`);
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
        sailLog('sail start',
          `legs=${legs.length}`,
          `bot=${fmtPos(b.entity.position)}`,
          `boat=${fmtPos(b.vehicle?.position)}`,
        );
        try {
          const legsRes = await sailLegs(legs);
          if (!legsRes.ok) {
            sailLog('sail FAILED',
              `leg=${legsRes.leg_index + 1}/${legs.length}`,
              `waypoint=${fmtPos(legsRes.waypoint)}`,
              `bot=${fmtPos(b.entity.position)}`,
              fmtFootHead(b.entity.position.floored()),
              `inner=${legsRes.inner_error?.code || '?'}`,
            );
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
          sailLog('sail done',
            `bot=${fmtPos(b.entity.position)}`,
            `boat=${fmtPos(b.vehicle?.position)}`,
          );
        } catch (e) {
          sailLog('sail FAILED', `phase=throw`, `error=${e?.message || e}`);
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
        sailLog('disembark start',
          `exit_shore=${fmtPos(route.exit_shore)}`,
          `bot=${fmtPos(b.entity.position)}`,
          `boat=${fmtPos(b.vehicle?.position)}`,
        );
        try {
          const disRes = await ACTIONS.disembark({ target_shore: route.exit_shore });
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
        sailLog('walk_to_target start',
          `target=${fmtPos(target)}`,
          `bot=${fmtPos(here)}`,
        );
        try {
          const goal = new goals.GoalNear(target.x, target.y, target.z, 2);
          await b.pathfinder.goto(goal);
          sailLog('walk_to_target done', `bot=${fmtPos(b.entity.position)}`);
        } catch (e) {
          sailLog('walk_to_target FAILED', `bot=${fmtPos(b.entity.position)}`, `reason=${e?.message || e}`);
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
      // Task #66: when caller passes target_shore explicitly (sail_to's
      // disembark phase OR sail()'s failure recovery), we know EXACTLY
      // where Steve should end up. RCON-kill any nearby boat and TP
      // Steve directly onto the dry cell. This works whether the bot
      // is currently mounted, swimming on water surface, or actually
      // submerged — anywhere except deeply on land we want a clean
      // shore landing. Runs BEFORE the NOT_MOUNTED check so it also
      // handles "boat already died, Steve is in water" recovery.
      const targetShore = opts.target_shore;
      if (targetShore
          && Number.isFinite(targetShore.x)
          && Number.isFinite(targetShore.y)
          && Number.isFinite(targetShore.z)) {
        const pmcp = paperMcpConfig();
        const username = getMyName?.();
        if (pmcp && username) {
          const sx = Math.floor(targetShore.x);
          const sy = Math.floor(targetShore.y);
          const sz = Math.floor(targetShore.z);
          const vid = b.vehicle?.id;
          const vname = b.vehicle?.name || 'oak_boat';
          const bx = Math.floor(b.entity.position.x);
          const by = Math.floor(b.entity.position.y);
          const bz = Math.floor(b.entity.position.z);
          // Kill any boat at the bot's current position (no-op if none).
          const killCmd = `execute positioned ${bx} ${by} ${bz} run kill @e[type=#minecraft:boat,distance=..3,limit=1]`;
          const tpCmd = `tp ${username} ${sx + 0.5} ${sy} ${sz + 0.5}`;
          await executeServerCommand(pmcp, killCmd).catch(() => null);
          await sleep(150);
          const tpRes = await executeServerCommand(pmcp, tpCmd).catch(() => ({ ok: false }));
          await sleep(200);
          if (tpRes && tpRes.ok) {
            if (b.entity && b.entity.position) {
              b.entity.position.x = sx + 0.5;
              b.entity.position.y = sy;
              b.entity.position.z = sz + 0.5;
            }
            b.vehicle = null;
            return {
              ok: true,
              command: 'disembark',
              data: {
                dismounted_from: vname,
                vehicle_id: vid ?? null,
                landed_at: [sx, sy, sz],
                fallback: 'rcon_shore_tp',
              },
            };
          }
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

      // After dismount: detect any UNSAFE foot cell and recover before
      // handing back to the agent.
      //
      //   - foot=water  →  chain mc escape (drown-protection;
      //                    circuit-v5f original case).
      //   - foot=solid  →  bot is SUFFOCATING inside a block (F33,
      //                    task #66, v48 — boat wedged at (360.9, 63,
      //                    -541.7) under a pre-existing cobblestone
      //                    wall; force-disembark dropped Steve inside
      //                    the cobble; he took 1 dmg/0.5s with no
      //                    auto-recovery). TP up the same column to
      //                    the first air cell with air-above
      //                    (2-block standing clearance).
      let autoEscape = null;
      let autoRescue = null;
      await sleep(300); // let physics settle so foot block is accurate
      const footPos = b.entity.position.floored();
      const footBlk = b.blockAt(footPos);
      const stillInWater = !!footBlk && (footBlk.name === 'water' || footBlk.name === 'flowing_water');
      const suffocating = !!footBlk
        && footBlk.name !== 'air' && footBlk.name !== 'cave_air' && footBlk.name !== 'void_air'
        && footBlk.name !== 'water' && footBlk.name !== 'flowing_water'
        && footBlk.boundingBox === 'block';
      if (suffocating) {
        // Scan up the bot's column for the first air-foot + air-head
        // pair sitting on something solid. Cap at 8 blocks — any
        // deeper would be a different problem (mineshaft / chasm).
        let rescueY = null;
        for (let dy = 1; dy <= 8; dy++) {
          const ty = footPos.y + dy;
          const foot = b.blockAt(new Vec3(footPos.x, ty, footPos.z));
          const head = b.blockAt(new Vec3(footPos.x, ty + 1, footPos.z));
          const below = b.blockAt(new Vec3(footPos.x, ty - 1, footPos.z));
          const isAirish = (blk) => blk && (blk.name === 'air' || blk.name === 'cave_air' || blk.name === 'void_air');
          const isSolidStand = below && below.boundingBox === 'block'
            && below.name !== 'water' && below.name !== 'flowing_water' && below.name !== 'lava';
          if (isAirish(foot) && isAirish(head) && isSolidStand) {
            rescueY = ty;
            break;
          }
        }
        try {
          const pmcp = paperMcpConfig();
          const safeY = rescueY ?? (footPos.y + 4);
          if (pmcp) {
            await executeServerCommand(pmcp, `tp ${getMyName()} ${footPos.x + 0.5} ${safeY} ${footPos.z + 0.5}`);
          } else {
            await b.chat(`/tp ${getMyName()} ${footPos.x + 0.5} ${safeY} ${footPos.z + 0.5}`);
          }
          await sleep(300);
          autoRescue = {
            ok: true,
            from: { x: footPos.x, y: footPos.y, z: footPos.z, foot_block: footBlk.name },
            to: { x: footPos.x, y: safeY, z: footPos.z },
            rescue_strategy: rescueY != null ? 'air_column_scan' : 'tp_up_4',
          };
          log(`[disembark] suffocation rescue — TP from ${footPos.x},${footPos.y},${footPos.z} (${footBlk.name}) → ${footPos.x},${safeY},${footPos.z}`);
        } catch (e) {
          autoRescue = { ok: false, error: e?.message || String(e), from: { x: footPos.x, y: footPos.y, z: footPos.z, foot_block: footBlk.name } };
          log(`[disembark] suffocation rescue failed: ${e?.message || e}`);
        }
      }
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
          ...(autoRescue ? { auto_rescue: autoRescue } : {}),
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
        await pathfindGotoNear(b, goals, targetPos.x, targetPos.y, targetPos.z, 3, { opName: 'bucket_fill', capMs: ACTION_CAPS_MS.reach });
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
        await pathfindGotoNear(b, goals, targetPos.x, targetPos.y, targetPos.z, 3, { opName: 'bucket_fill', capMs: ACTION_CAPS_MS.reach });
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

  // Wire sail_to's wrapper to its impl. The wrapper (.sail_to above)
  // dispatches to sailToImplRef rather than `this._sailToImpl` because
  // the action registry detaches methods from the parent object before
  // invoking them — `this` is undefined at call time.
  sailToImplRef = actions._sailToImpl;

  return actions;
}
