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

const BOAT_NAMES = new Set([
  'oak_boat', 'spruce_boat', 'birch_boat', 'jungle_boat',
  'acacia_boat', 'dark_oak_boat', 'cherry_boat', 'mangrove_boat',
  'bamboo_raft', 'pale_oak_boat',
]);

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
    async place_boat({ x, y, z }) {
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
      // Task #7 self-adjust: if exact target isn't water, find nearest
      // water within 3 blocks. circuit-v3 had Steve calling place_boat
      // 11 times with slightly wrong coords — each failed NO_WATER_AT_TARGET.
      // The adjust converts those into 1 successful call + data.adjusted_target.
      let adjustedTarget = null;
      if (refBlock.name !== 'water' && refBlock.name !== 'flowing_water') {
        const adj = findAdjustedTarget(
          b,
          (bot, px, py, pz) => {
            const blk = bot?.blockAt && bot.blockAt(new Vec3(px, py, pz));
            return !!blk && (blk.name === 'water' || blk.name === 'flowing_water');
          },
          Number(x), Number(y), Number(z),
          3,
        );
        if (!adj) {
          return { ok: false, error: {
            code: 'NO_WATER_AT_TARGET',
            message: `Block at (${x},${y},${z}) is "${refBlock.name}" and no water within 3 blocks — boats need water.`,
            observed_state: { target_block: refBlock.name, searched_radius: 3 },
            retry_safe: false,
          }};
        }
        // Use the adjusted cell.
        adjustedTarget = adj;
        refBlock = b.blockAt(new Vec3(adj.x, adj.y, adj.z));
        targetPos.x = adj.x; targetPos.y = adj.y; targetPos.z = adj.z;
        log(`[place_boat] adjusted target from (${x},${y},${z}) to (${adj.x},${adj.y},${adj.z}) — distance ${adj.distance}`);
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
          return { ok: false, error: {
            code: 'NO_STANCE',
            message: `No solid block adjacent to water at (${x},${y},${z}) and bot is not in water. Stand at the pond edge, or get into the water to place from there.`,
            retry_safe: false,
          }};
        }
        if (b.entity.position.distanceTo(stancePos) > 1.5) {
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
          .filter((e) => e && (e.name?.endsWith('_boat') || e.name === 'boat' || e.name === 'bamboo_raft'))
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
          if (e.name?.endsWith('_boat') || e.name === 'boat' || e.name === 'bamboo_raft') {
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
          await sleep(400);
          for (const e of Object.values(b.entities)) {
            if (!e || knownBoatIds.has(e.id)) continue;
            if (e.name?.endsWith('_boat') || e.name === 'boat' || e.name === 'bamboo_raft') {
              if (e.position && e.position.distanceTo(refBlock.position) < 4) {
                entity = e;
                break;
              }
            }
          }
        }
      }

      if (!entity) {
        return { ok: false, error: {
          code: 'PLACE_FAILED',
          message: 'No boat entity appeared near the target — water may be too shallow or the cast missed.',
          observed_state: { target: [Number(x), Number(y), Number(z)] },
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
    async board() {
      const b = ensureBot();

      // b.vehicle can be stale if the vehicle entity died — mineflayer
      // doesn't always null it out. Treat it as null if it isn't in the
      // current entity list.
      const currentVehicle = b.vehicle && b.entities[b.vehicle.id] === b.vehicle ? b.vehicle : null;
      if (currentVehicle) {
        return { ok: false, error: {
          code: 'ALREADY_MOUNTED',
          message: `Already mounted on ${currentVehicle.name || 'an entity'}.`,
          observed_state: { vehicle: currentVehicle.name, vehicle_id: currentVehicle.id },
          retry_safe: false,
        }};
      }
      // Clear the stale reference so mineflayer can mount again.
      if (b.vehicle && !b.entities[b.vehicle.id]) {
        b.vehicle = null;
      }

      const me = b.entity.position;
      const findNearbyBoats = () => Object.values(b.entities)
        .filter((e) => e && e.position && (e.name === 'boat' || e.name === 'oak_boat' || /boat/i.test(e.name || '')))
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
        const placeRes = await ACTIONS.place_boat({ x: water.x, y: water.y, z: water.z });
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
        await sleep(300);
        boats = findNearbyBoats();
        if (boats.length === 0) {
          return { ok: false, error: {
            code: 'AUTO_PLACE_FAILED',
            message: 'place_boat succeeded but no boat entity appeared within 6 blocks of the bot.',
            observed_state: { place_data: placeRes.data },
            retry_safe: true,
          }};
        }
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
    async sail({ x, y, z, timeout_seconds = 60 }) {
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
      const deadline = Date.now() + (Number(timeout_seconds) || 60) * 1000;

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

      // First, try native steering for 1.5s. If the boat moves at all,
      // keep going with native; otherwise switch to tp-step mode.
      let nativeWorks = false;
      try {
        const yaw0 = Math.atan2(target.x - startPos.x === 0 ? 0 : -(target.x - startPos.x), target.z - startPos.z);
        try { await b.look(yaw0, 0, true); } catch {}
        b.setControlState('forward', true);
        await sleep(1500);
        const liveAfter = b.entities[b.vehicle?.id];
        if (liveAfter && startPos.distanceTo(liveAfter.position) > 0.4) {
          nativeWorks = true;
        }
        if (!nativeWorks) b.setControlState('forward', false);
      } catch {}

      let lastDistance = (b.entities[b.vehicle?.id]?.position || boat.position).distanceTo(target);
      let stallTicks = 0;

      try {
        while (Date.now() < deadline) {
          const live = b.entities[b.vehicle?.id];
          if (!live || !b.vehicle) {
            try { b.setControlState('forward', false); } catch {}
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
            try { b.setControlState('forward', false); } catch {}
            await sleep(400);
            return {
              ok: true,
              command: 'sail',
              data: {
                from: [Math.floor(startPos.x), Math.floor(startPos.y), Math.floor(startPos.z)],
                to: [Math.floor(here.x), Math.floor(here.y), Math.floor(here.z)],
                target: [Number(x), Number(y), Number(z)],
                horizontal_distance_remaining: Number(horiz.toFixed(2)),
                ...(nativeWorks ? {} : { fallback: 'papermcp_tp_step' }),
              },
            };
          }

          if (nativeWorks) {
            const yaw = Math.atan2(-dx, dz);
            try { await b.look(yaw, 0, true); } catch {}
            b.setControlState('forward', true);
            await sleep(300);
          } else if (useTpFallback) {
            // Step the boat 1.5 blocks toward the target each tick.
            // Boats travel at ~0.4 blocks per tick under player input;
            // 1.5 per 400ms loop = ~3.75 b/s, similar to normal sailing
            // speed. Select the boat by a tight bbox centered on its
            // current position so we hit OUR boat, not some other one.
            const step = Math.min(1.5, horiz);
            const nx = here.x + (dx / horiz) * step;
            const nz = here.z + (dz / horiz) * step;
            const ny = here.y;
            const bx = Math.floor(here.x);
            const by = Math.floor(here.y);
            const bz = Math.floor(here.z);
            const cmd = `execute positioned ${bx} ${by} ${bz} run tp @e[type=oak_boat,distance=..2,limit=1] ${nx.toFixed(3)} ${ny.toFixed(3)} ${nz.toFixed(3)}`;
            const r = await executeServerCommand(pmcp, cmd).catch(() => ({ ok: false }));
            if (!r || !r.ok) log(`[sail] tp step failed`);
            await sleep(400);
          } else {
            // No fallback available; native isn't working. Bail.
            return { ok: false, error: {
              code: 'OUT_OF_RANGE',
              message: 'Boat not responding to rider input and no PaperMCP fallback configured.',
              retry_safe: false,
            }};
          }

          if (Math.abs(lastDistance - horiz) < 0.05) {
            stallTicks++;
            if (stallTicks >= 8) {
              try { b.setControlState('forward', false); } catch {}
              return { ok: false, error: {
                code: 'OUT_OF_RANGE',
                message: `Boat stuck — no progress in ~3s. Likely wedged against terrain at (${here.x.toFixed(1)}, ${here.y.toFixed(1)}, ${here.z.toFixed(1)}).`,
                observed_state: {
                  boat_pos: [Number(here.x.toFixed(2)), Number(here.y.toFixed(2)), Number(here.z.toFixed(2))],
                  horizontal_distance_remaining: Number(horiz.toFixed(2)),
                },
                retry_safe: false,
              }};
            }
          } else {
            stallTicks = 0;
          }
          lastDistance = horiz;
        }
      } finally {
        try { b.setControlState('forward', false); } catch {}
      }

      const here = b.entities[b.vehicle?.id]?.position || boat.position;
      return { ok: false, error: {
        code: 'TIMEOUT',
        message: `Did not reach (${x},${y},${z}) within ${timeout_seconds}s.`,
        observed_state: {
          boat_pos: [Number(here.x.toFixed(2)), Number(here.y.toFixed(2)), Number(here.z.toFixed(2))],
          horizontal_distance_remaining: Number(here.distanceTo(target).toFixed(2)),
        },
        retry_safe: true,
      }};
    },

    /**
     * Exit the current vehicle.
     * Action contract: NOT_MOUNTED.
     */
    async disembark() {
      const b = ensureBot();
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
      let autoSailed = null;
      {
        const boatPos = b.vehicle.position;
        const below = b.blockAt(boatPos.offset(0, -1, 0));
        const inOpenWater = !!below && (below.name === 'water' || below.name === 'flowing_water');
        if (inOpenWater) {
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
              const sailRes = await ACTIONS.sail({ x: shore.x, y: shore.y, z: shore.z, timeout_seconds: 30 });
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
        return { ok: false, error: {
          code: 'DISMOUNT_REJECTED',
          message: 'Server did not confirm dismount.',
          retry_safe: true,
        }};
      }
      return {
        ok: true,
        command: 'disembark',
        data: {
          dismounted_from: wasVehicle,
          bot_position: [Math.floor(b.entity.position.x), Math.floor(b.entity.position.y), Math.floor(b.entity.position.z)],
          ...(fallback ? { fallback } : {}),
          ...(autoSailed ? { auto_sailed: autoSailed } : {}),
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
