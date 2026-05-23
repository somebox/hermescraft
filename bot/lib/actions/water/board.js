import { Vec3 } from 'vec3';
import { executeServerCommand, paperMcpConfig } from '../../runtime/paper-mcp.js';
import { pathfindGotoNear, ACTION_CAPS_MS } from '../_helpers.js';
import { fail } from './_contract.js';
import { BOAT_NAMES, isBoatEntity } from './_water-blocks.js';
import { useSailToInsteadRefusal } from './_refusal.js';

export function createBoardHandlers({ ensureBot, goals, ACTIONS, log, sleep, getMyName }) {

async function board({ _from_sail_to } = {}) {
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
      return fail(
        'ALREADY_MOUNTED',
        `Already mounted on ${live.name || 'an entity'}. Call mc disembark before re-boarding.`,
        {
          observed_state: {
            vehicle: live.name,
            vehicle_id: live.id,
            passenger_confirmed: passengerHasBot,
          },
          next_action_hint: 'mc sail_to X Y Z  # already on a boat — sail_to resumes from current mount',
          retry_safe: false,
        },
      );
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
              return fail('NO_BOAT', 'No boat within 6 blocks and no boat item in inventory.', { retry_safe: false });
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
              return fail('CHUNK_NOT_LOADED', `Bot's local chunk cache is empty at (${fx},${fy},${fz}) — mineflayer hasn't received chunk data for this area. This is a known mineflayer / Paper 1.21+ packet-corruption case. Move 1 block (mc move ${fx + 1} ${fy} ${fz}) or wait 2-3s and retry — that usually triggers a chunk resync.`, {
          observed_state: {
          bot_position: { x: fx, y: fy, z: fz },
          boat_in_inventory: boatItem.name,
          probed_cells: 27,
          non_null_cells: 0,
        },
          next_action_hint: `mc bg_goto ${fx + 1} ${fy} ${fz}; mc sail_to <target>`,
          retry_safe: true,
        });
    }
    // Find nearest water source within 12 blocks of the bot.
    const waterPositions = b.findBlocks({
      matching: (blk) => blk && blk.name === 'water' && Number(blk.getProperties?.()?.level ?? 0) === 0,
      maxDistance: 12,
      count: 8,
    });
    if (!waterPositions || waterPositions.length === 0) {
              return fail('NO_BOAT', 'No boat within 6 blocks and no water within 12 blocks to place one.', {
          observed_state: { boat_in_inventory: boatItem.name },
          retry_safe: false,
        });
    }
    const water = waterPositions[0];
    log(`[board] auto-place: no boat nearby — placing ${boatItem.name} on water at ${water.x},${water.y},${water.z}`);
    const placeRes = await ACTIONS.place_boat({ x: water.x, y: water.y, z: water.z, _from_sail_to: true });
    if (!placeRes?.ok) {
              return fail('AUTO_PLACE_FAILED', `Tried to auto-place boat at water (${water.x},${water.y},${water.z}) but place_boat failed: ${placeRes?.error?.code || 'unknown'}.`, {
          observed_state: { place_boat_error: placeRes?.error, boat_in_inventory: boatItem.name },
          retry_safe: true,
        });
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
              return fail('AUTO_PLACE_FAILED', 'place_boat succeeded but no boat entity appeared within 6 blocks of the bot after 5s (even after 2 chunk-refresh nudges).', {
          observed_state: { place_data: placeRes.data, placed_boat_id: placedBoatId },
          next_action_hint: 'mc nearby # check what boats exist; mc sail_to <target> again to retry',
          retry_safe: true,
        });
    }
    boats = [{ ent: foundBoat, dist: foundBoat.position.distanceTo(b.entity.position) }];
  }
  const target = boats[0].ent;

  if (target.position.distanceTo(me) > 2.5) {
    try {
      await pathfindGotoNear(b, goals, target.position.x, target.position.y, target.position.z, 1, { opName: 'board', capMs: ACTION_CAPS_MS.reach });
    } catch {
              return fail('OUT_OF_RANGE', 'pathfind to boat failed', { retry_safe: false });
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
            return fail('MOUNT_REJECTED', 'Server did not confirm mount. Boat may be occupied, the bot may be on top of (not in) the boat, or the entity selector missed it.', {
          observed_state: {
        bot_pos: [Number(b.entity.position.x.toFixed(2)), Number(b.entity.position.y.toFixed(2)), Number(b.entity.position.z.toFixed(2))],
        boat_pos: live ? [Number(live.position.x.toFixed(2)), Number(live.position.y.toFixed(2)), Number(live.position.z.toFixed(2))] : null,
        boat_passengers: live && Array.isArray(live.passengers) ? live.passengers.length : null,
      },
          retry_safe: true,
        });
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
}

  return { board };
}

