import { Vec3 } from 'vec3';
import { executeServerCommand, paperMcpConfig } from '../../runtime/paper-mcp.js';
import { findAdjustedTarget } from '../_nav-helpers.js';
import { pathfindGotoNear, pathfindWithProgressWatchdog, ACTION_CAPS_MS } from '../_helpers.js';
import { BOAT_NAMES, isBoatEntity } from './_water-blocks.js';
import { useSailToInsteadRefusal } from './_refusal.js';
import { fail } from './_contract.js';

export function createPlaceBoatHandlers({ ensureBot, goals, ACTIONS, log, sleep, getMyName }) {

  function findBoatItem(b) {
    for (const it of b.inventory.items()) {
      if (BOAT_NAMES.has(it.name)) return it;
    }
    return null;
  }

async function place_boat({ x, y, z, _from_sail_to, _rescue_from_water } = {}) {
  if (!_from_sail_to) return useSailToInsteadRefusal('place_boat');
  const b = ensureBot();
  const targetPos = new Vec3(Number(x), Number(y), Number(z));

  const boat = findBoatItem(b);
  if (!boat) {
            return fail('NO_BOAT', 'No boat in inventory. Craft one with 5 planks (any overworld wood).', {
          observed_state: { boats: b.inventory.items().filter((i) => i.name.endsWith('_boat') || i.name === 'bamboo_raft').map((i) => i.name) },
          retry_safe: false,
        });
  }

  let refBlock = b.blockAt(targetPos);
  if (!refBlock) {
            return fail('NO_BLOCK', `No block at (${x},${y},${z})`, { retry_safe: false });
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
                return fail('NO_WATER_AT_TARGET', `Block at (${x},${y},${z}) is "${refBlock.name}" and no water within 3 blocks — boats need water.`, {
          observed_state: { target_block: refBlock.name, searched_radius: 6 },
          retry_safe: false,
        });
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
              return fail('BOT_IN_WATER', `Cannot place a boat — bot is submerged at (${botFootPos.x}, ${botFootPos.y}, ${botFootPos.z}). A boat needs a dry stance to mount cleanly; placing from-water leaves the boat unreachable. Escape water first, then sail_to can pick a fresh entry shore from your new position.`, {
          observed_state: {
          bot_position: { x: botFootPos.x, y: botFootPos.y, z: botFootPos.z },
          foot_block: botFootBlock.name,
          target_water: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
        },
          next_action_hint: 'mc escape   # then mc sail_to <target> again',
          retry_safe: true,
        });
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
                  return fail('OUT_OF_RANGE', `No dry stance at (${x},${y},${z}) and pathfinder couldn't reach the water cell next door (bot still at ${newFoot.x},${newFoot.y},${newFoot.z} on ${newFootBlk?.name || 'unknown'}). The boat target may be open water far from any shore.`, {
          observed_state: { target: [Number(x), Number(y), Number(z)], adjacent_water: [waterAdj.x, waterAdj.y, waterAdj.z], bot_foot: { x: newFoot.x, y: newFoot.y, z: newFoot.z, block: newFootBlk?.name } },
          retry_safe: true,
        });
        }
      }
      if (!stancePos) {
                return fail('NO_STANCE', `No solid block adjacent to water at (${x},${y},${z}) and bot is not in water. Stand at the pond edge, or get into the water to place from there.`, {
          observed_state: { target: [Number(x), Number(y), Number(z)], adjacent_water: waterAdj ? [waterAdj.x, waterAdj.y, waterAdj.z] : null },
          retry_safe: false,
        });
      }
    } else if (b.entity.position.distanceTo(stancePos) > 1.5) {
      try {
        await pathfindGotoNear(b, goals, stancePos.x, stancePos.y, stancePos.z, 1, { opName: 'place_boat_stance', capMs: ACTION_CAPS_MS.reach });
      } catch {
                return fail('OUT_OF_RANGE', 'pathfind to stance failed', { retry_safe: false });
      }
    }
  }

  try { await b.equip(boat, 'hand'); } catch (err) {
            return fail('INTERRUPTED', `equip boat failed: ${err.message}`, { retry_safe: true });
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
            return fail('PLACE_FAILED', 'No boat entity appeared near the target after native cast', {
          observed_state: {
        target: [Number(x), Number(y), Number(z)],
        target_used: [refBlock.position.x, refBlock.position.y, refBlock.position.z],
        ref_block: refBlock.name,
        fallback_attempted: fallback || null,
        ...(adjustedTarget ? { adjusted_target: adjustedTarget } : {}),
      },
          retry_safe: true,
        });
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
}

  return { place_boat };
}

