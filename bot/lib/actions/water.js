/**
 * Water-related verbs (Sprint 10): mc fish / place_boat / board / disembark.
 *
 * Fishing uses mineflayer's bot.fish() which handles the cast/bite/reel cycle
 * via packet sniffing. Boats are placed via bot.placeEntity (which spawns a
 * boat entity from a held boat item) and mounted with bot.mount/dismount.
 */

import { Vec3 } from 'vec3';
import { executeServerCommand, paperMcpConfig } from '../bot/paper-mcp.js';

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

      const refBlock = b.blockAt(targetPos);
      if (!refBlock) {
        return { ok: false, error: { code: 'NO_BLOCK', message: `No block at (${x},${y},${z})`, retry_safe: false }};
      }
      if (refBlock.name !== 'water') {
        return { ok: false, error: {
          code: 'NO_WATER_AT_TARGET',
          message: `Block at (${x},${y},${z}) is "${refBlock.name}" — boats need water under them.`,
          observed_state: { target_block: refBlock.name },
          retry_safe: false,
        }};
      }

      // Stand on solid ground ADJACENT to the water (not in it). Search
      // the 4 cardinal neighbors at refBlock+1y for a solid stance block.
      let stancePos = null;
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
          message: `No solid block adjacent to water at (${x},${y},${z}). Stand at the pond edge.`,
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
          const r2 = await executeServerCommand(pmcp, `execute in landfolk-test run summon minecraft:${summonName} ${refBlock.position.x + 0.5} ${summonY} ${refBlock.position.z + 0.5}`);
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
      const boats = Object.values(b.entities)
        .filter((e) => e && e.position && (e.name === 'boat' || e.name === 'oak_boat' || /boat/i.test(e.name || '')))
        .map((e) => ({ ent: e, dist: e.position.distanceTo(me) }))
        .filter((x) => x.dist <= 6)
        .sort((a, c) => a.dist - c.dist);
      if (boats.length === 0) {
        return { ok: false, error: {
          code: 'NO_BOAT',
          message: 'No boat within 6 blocks.',
          retry_safe: false,
        }};
      }
      const target = boats[0].ent;

      if (target.position.distanceTo(me) > 2.5) {
        try {
          await b.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1));
        } catch {
          return { ok: false, error: { code: 'OUT_OF_RANGE', message: 'pathfind to boat failed', retry_safe: false }};
        }
      }

      try {
        b.mount(target);
      } catch (err) {
        return { ok: false, error: { code: 'INTERRUPTED', message: `mount failed: ${err.message}`, retry_safe: true }};
      }
      // Mount is async on the server side; wait a beat and verify.
      await sleep(400);
      if (!b.vehicle) {
        return { ok: false, error: {
          code: 'MOUNT_REJECTED',
          message: 'Server did not confirm mount within 400ms. Boat may be already occupied or out of reach.',
          retry_safe: true,
        }};
      }

      return {
        ok: true,
        command: 'board',
        data: {
          vehicle: b.vehicle.name,
          vehicle_id: b.vehicle.id,
          boat_position: [Math.floor(target.position.x), Math.floor(target.position.y), Math.floor(target.position.z)],
        },
      };
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
          const r = await executeServerCommand(pmcp, `execute in landfolk-test run ride ${username} dismount`).catch((e) => ({ ok: false, error: e?.message }));
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
        },
      };
    },
  };
}
