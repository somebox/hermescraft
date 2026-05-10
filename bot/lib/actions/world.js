import { Vec3 } from 'vec3';
import { equipForDig, PROTECTED_DIG_BLOCKS, DIG_PASSABLE_NAMES, columnTopSolid, nudgeOffStandPillar } from '../bot/dig-tools.js';
import { executeServerCommand, paperMcpConfig } from '../bot/paper-mcp.js';

export function createWorldActions(deps) {
  const { ctx, ensureBot, goals, fmt, posObj, sleep, log, resolveInventoryItem, rememberSocialEvent, getMyName, ACTIONS } = deps;
  const cardinalDelta = (direction) => {
    const d = String(direction || '').toLowerCase();
    switch (d) {
      case 'north':
      case 'n':
        return { dx: 0, dz: -1, key: 'north' };
      case 'south':
      case 's':
        return { dx: 0, dz: 1, key: 'south' };
      case 'east':
      case 'e':
        return { dx: 1, dz: 0, key: 'east' };
      case 'west':
      case 'w':
        return { dx: -1, dz: 0, key: 'west' };
      default:
        throw new Error(`Invalid direction "${direction}". Use north|south|east|west.`);
    }
  };

  const tunnelSliceBounds = ({ x, y, z, direction, width, height }) => {
    const { dx, dz } = cardinalDelta(direction);
    const half = Math.floor(width / 2);
    let x1 = x;
    let x2 = x;
    let z1 = z;
    let z2 = z;
    if (dx !== 0) {
      z1 = z - half;
      z2 = z + half;
    } else {
      x1 = x - half;
      x2 = x + half;
    }
    return {
      x1: Math.min(x1, x2),
      y1: y,
      z1: Math.min(z1, z2),
      x2: Math.max(x1, x2),
      y2: y + height - 1,
      z2: Math.max(z1, z2),
    };
  };

  return {

  // ── Inventory ────────────────────────────────────
  async equip({ item, slot = 'hand' }) {
    const b = ensureBot();
    const invRows = b.inventory.items().map((i) => ({ name: i.name, count: i.count }));
    const er = resolveInventoryItem({
      mcData: ctx.mcData,
      inventory: invRows,
      query: String(item),
      policy: 'best_available',
    });
    if (!er.ok) throw new Error(er.message || `No ${item} in inventory.`);
    const invItem = b.inventory.items().find((i) => i.name === er.selected.name);
    if (!invItem) {
      const available = b.inventory.items().map((i) => i.name);
      throw new Error(`No ${er.selected.name} in inventory. Have: ${[...new Set(available)].join(', ')}`);
    }
    await b.equip(invItem, slot);
    return { result: `Equipped ${er.selected.name} to ${slot}` };
  },

  async unequip({ slot = 'hand' }) {
    const b = ensureBot();
    if (slot === 'hand') {
      const qbStart = b.QUICK_BAR_START ?? 36;
      let cleared = false;
      for (let s = 0; s < 9; s++) {
        if (!b.inventory.slots[qbStart + s]) {
          b.setQuickBarSlot(s);
          cleared = true;
          break;
        }
      }
      if (!cleared) {
        await b.unequip('hand');
      }
    } else {
      await b.unequip(slot);
    }
    const nowHeld = b.heldItem;
    return { result: nowHeld?.name ? `Hand now holds ${nowHeld.name}` : 'Hand is now empty.' };
  },

  async toss({ item, count }) {
    const b = ensureBot();
    const invItem = b.inventory.items().find(i => i.name === item);
    if (!invItem) throw new Error(`No ${item} in inventory.`);
    if (count && count > 0 && count < invItem.count) {
      await b.toss(invItem.type, null, count);
    } else {
      await b.tossStack(invItem);
    }
    return { result: `Tossed ${count || invItem.count} ${item}` };
  },

  /**
   * Climb pillar safely: place underfoot only (never above head), then jump.
   * Supports `count` to repeat N times in one call (max 64).
   * Use from holes when pathfinder cannot staircase to surface.
   */
  async pillar_step({ block: blockName, jump: doJump, count: rawCount } = {}) {
    // Stand pillar: jump straight up and place a block on the top face of the
    // block currently underfoot. Repeats up to `count` times. Auto-stops if a
    // horizontal neighbor becomes walkable (the bot has reached a platform top
    // and the caller can simply step laterally instead of building a spire).
    const b = ensureBot();
    const wantJump = doJump !== false && doJump !== 'false';
    const maxSteps = Math.min(Math.max(parseInt(rawCount, 10) || 1, 1), 64);

    const cascade = [];
    if (blockName) cascade.push(String(blockName));
    cascade.push(
      'cobblestone', 'stone', 'dirt', 'sand', 'gravel', 'netherrack',
      'granite', 'andesite', 'diorite', 'deepslate', 'cobbled_deepslate',
      'oak_planks', 'spruce_planks', 'birch_planks',
    );

    const isAirLike = (blk) => blk && (blk.name === 'air' || blk.name === 'cave_air' || blk.name === 'void_air');

    const equipBuildingBlock = async () => {
      let item = null;
      for (const nm of cascade) {
        item = b.inventory.items().find((it) => it.name === nm);
        if (item) break;
      }
      if (!item) throw new Error(`pillar_step needs a placing block (${cascade.join(', ')}).`);
      if (b.heldItem?.type !== item.type) await b.equip(item, 'hand');
      return item;
    };

    // Locate the block the bot is currently standing on. Walks down from feet
    // up to 2 cells (handles full blocks at floor(y) and partial blocks like
    // chests/slabs at floor(y) where pos.y is fractional).
    const findStandingBlock = () => {
      const ix = Math.floor(b.entity.position.x);
      const iz = Math.floor(b.entity.position.z);
      const feetY = Math.floor(b.entity.position.y - 0.001);
      for (let dy = 0; dy <= 1; dy++) {
        const y = feetY - dy;
        const blk = b.blockAt(new Vec3(ix, y, iz));
        if (blk && blk.boundingBox === 'block') return blk;
      }
      return null;
    };

    const canStepLaterally = () => {
      const feetY = Math.floor(b.entity.position.y + 0.001);
      const cx = Math.floor(b.entity.position.x);
      const cz = Math.floor(b.entity.position.z);
      for (const [hdx, hdz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const floor = b.blockAt(new Vec3(cx + hdx, feetY - 1, cz + hdz));
        const feet = b.blockAt(new Vec3(cx + hdx, feetY, cz + hdz));
        const head = b.blockAt(new Vec3(cx + hdx, feetY + 1, cz + hdz));
        if (floor && floor.boundingBox === 'block' && isAirLike(feet) && isAirLike(head)) {
          return {
            dx: hdx, dz: hdz,
            floor: floor.name,
            // Absolute coords of the walkable cell — pass directly to goto_near.
            x: cx + hdx, y: feetY, z: cz + hdz,
          };
        }
      }
      return null;
    };

    const waitForOnGround = async (maxMs = 600) => {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        if (b.entity.onGround) return true;
        await sleep(20);
      }
      return false;
    };

    // Dig overhead block(s) so the bot has clearance to jump and place.
    // Required for "pillar through a solid roof" to reach the surface above.
    const ensureHeadroom = async (ix, iz, baseFy) => {
      for (const y of [baseFy + 1, baseFy + 2]) {
        const blk = b.blockAt(new Vec3(ix, y, iz));
        if (!blk || isAirLike(blk) || blk.boundingBox !== 'block') continue;
        if (PROTECTED_DIG_BLOCKS.has(blk.name)) continue;
        try {
          await equipForDig(b, blk);
          await b.dig(blk, true);
          await sleep(80);
        } catch { /* couldn't dig (bedrock?); next loop iteration handles it */ }
      }
    };

    /** One pillar step: jump and place on top of standing block. Returns y of new block, or null. */
    const doOneStep = async () => {
      await waitForOnGround(600);

      const standing = findStandingBlock();
      if (!standing) return null;

      const targetY = standing.position.y + 1;
      const targetPos = new Vec3(standing.position.x, targetY, standing.position.z);
      const targetCell = b.blockAt(targetPos);
      if (targetCell && !isAirLike(targetCell) && targetCell.boundingBox === 'block') return null;

      // Bot needs ~2 cells of clearance above feet to jump-and-place. If a roof
      // is overhead, dig through it (this is the "pillar through ceiling" case).
      const ix = Math.floor(b.entity.position.x);
      const iz = Math.floor(b.entity.position.z);
      const feetY = Math.floor(b.entity.position.y + 0.001);
      await ensureHeadroom(ix, iz, feetY);

      // Build the candidate-reference list. The standing block is the canonical
      // pillar reference, but mineflayer's `placeBlock` against a chest's top
      // face times out (the chest's top is a partial collision box; server
      // rejects the place). Fallback to lateral walls at the target's level —
      // any solid block adjacent to (ix, targetY, iz) works as a reference.
      /** @type {{ block: any, face: import('vec3').Vec3 }[]} */
      const refCandidates = [
        { block: standing, face: new Vec3(0, 1, 0) },
      ];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const wall = b.blockAt(new Vec3(targetPos.x + dx, targetPos.y, targetPos.z + dz));
        if (wall && !isAirLike(wall) && wall.boundingBox === 'block') {
          refCandidates.push({ block: wall, face: new Vec3(-dx, 0, -dz) });
        }
      }

      await equipBuildingBlock();

      b.setControlState('forward', false);
      b.setControlState('back', false);
      b.setControlState('left', false);
      b.setControlState('right', false);
      b.setControlState('sprint', false);
      b.setControlState('jump', true);

      // mineflayer's `b.placeBlock` waits up to 5s for a `blockUpdate` event.
      // When the server rejects (bot's hitbox overlaps the new block, partial-
      // block reference, etc.), no event fires and we eat the full timeout —
      // catastrophic for retry loops. Wrap with a short timeout and verify via
      // blockAt instead.
      const tryPlace = async (refBlock, faceVec, timeoutMs = 600) => {
        const placePromise = b.placeBlock(refBlock, faceVec).catch((e) => { throw e; });
        const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs));
        try { await Promise.race([placePromise, timeoutPromise]); }
        catch { /* either thrown by placeBlock or by our timer; verify via blockAt */ }
        const after = b.blockAt(targetPos);
        return after && !isAirLike(after) && after.boundingBox === 'block';
      };

      const cycleDeadline = Date.now() + 1500;
      let placedY = null;
      // Threshold for "high enough to place": ideally targetY + 1.0 (bot fully
      // above new block), but jumping from a partial block (chest, slab) only
      // reaches ~targetY + 0.95. Use 0.92 so server-side tolerance covers the gap.
      const placeThreshold = targetY + 0.92;
      let candIdx = 0;
      try {
        while (Date.now() < cycleDeadline) {
          if (b.entity.position.y >= placeThreshold) {
            const cand = refCandidates[candIdx % refCandidates.length];
            const ok = await tryPlace(cand.block, cand.face, 600);
            if (ok) { placedY = targetY; break; }
            candIdx++;
          }
          await sleep(30);
        }
      } finally {
        b.setControlState('jump', false);
      }
      if (placedY !== null) await sleep(150);  // let bot settle on new block
      return placedY === null ? null : { y: placedY };
    };

    await equipBuildingBlock();
    const startY = Math.floor(b.entity.position.y);
    let placed = 0;
    let lateralExit = null;
    let consecutiveFails = 0;

    for (let step = 0; step < maxSteps; step++) {
      // Skip lateral-exit check on first step — caller may have just dropped
      // into a pit and the "exit" is the entry they came from.
      if (step > 0) {
        await waitForOnGround(400);
        const exit = canStepLaterally();
        if (exit) { lateralExit = exit; break; }
      }

      if (!wantJump) {
        // Sneak-place underfoot variant — fall through to the same logic but
        // skip the jump (rare path; supported for compatibility).
        const standing = findStandingBlock();
        if (!standing) { consecutiveFails++; if (consecutiveFails >= 2) break; continue; }
        try {
          await equipBuildingBlock();
          await b.placeBlock(standing, new Vec3(0, 1, 0));
          placed++;
          consecutiveFails = 0;
        } catch {
          consecutiveFails++;
          if (consecutiveFails >= 2) break;
        }
        continue;
      }

      const result = await doOneStep();
      if (result) {
        placed++;
        consecutiveFails = 0;
      } else {
        consecutiveFails++;
        if (consecutiveFails >= 2) break;
      }
    }

    const endY = Math.floor(b.entity.position.y);
    const pos = b.entity.position;

    if (placed === 0 && !lateralExit) {
      throw new Error(
        `pillar_step could not place any blocks. Y=${startY}, pos=(${Math.floor(pos.x)},${endY},${Math.floor(pos.z)}). Headroom may be blocked or no suitable blocks in inventory.`,
      );
    }

    const exitSuffix = lateralExit
      ? `. Lateral exit at ${lateralExit.x},${lateralExit.y},${lateralExit.z} (floor ${lateralExit.floor}) — caller should: mc goto_near ${lateralExit.x} ${lateralExit.y} ${lateralExit.z} 1.`
      : '';
    return {
      result: `pillar_step climbed ${placed} block${placed !== 1 ? 's' : ''}: Y ${startY} → ${endY} (pos ${Math.floor(pos.x)},${endY},${Math.floor(pos.z)})${exitSuffix}`,
      placed,
      startY,
      endY,
      position: { x: Math.floor(pos.x), y: endY, z: Math.floor(pos.z) },
      ...(lateralExit ? { lateral_exit: lateralExit } : {}),
    };
  },

  // ── Building ─────────────────────────────────────
  async place({ block: blockName, x, y, z }) {
    // ─ Phase-2 action contract (see docs/phase-2-architecture.md §8 mc place) ─
    // Soft failures return { ok: false, error: { code, message, observed_state, ... } }.
    // ok=true requires block to be at target coord AFTER placement (verified via blockAt).

    const b = ensureBot();
    const targetPos = new Vec3(x, y, z);
    const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

    // Replaceable blocks: place-into is allowed (the new block overwrites them).
    // Includes fluids (water/lava) so bridging-by-water-replacement works.
    const REPLACEABLE = new Set([
      'air', 'cave_air', 'void_air',
      'water', 'lava', 'bubble_column',
      'tall_grass', 'short_grass', 'grass', 'fern', 'large_fern',
      'vine', 'snow', 'snow_layer', 'fire', 'soul_fire',
      'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass',
      'dead_bush',
    ]);
    const isReplaceable = (blk) => !blk || REPLACEABLE.has(blk.name);
    // Solid neighbor = block with full collision box. Fluids have boundingBox === 'empty'.
    const isSolidNeighbor = (blk) => blk && !REPLACEABLE.has(blk.name) && blk.boundingBox === 'block';

    // Capture neighbor map once so all error paths see the same observed state.
    const neighborMap = offsets.reduce((acc, [dx, dy, dz]) => {
      const ref = b.blockAt(targetPos.offset(dx, dy, dz));
      acc[`${dx},${dy},${dz}`] = {
        block: ref?.name ?? null,
        is_solid: isSolidNeighbor(ref),
        position: { x: x + dx, y: y + dy, z: z + dz },
      };
      return acc;
    }, /** @type {Record<string, {block: string|null, is_solid: boolean, position: {x:number,y:number,z:number}}>} */ ({}));

    // ── INVENTORY_MISSING ──
    const item = b.inventory.items().find(i => i.name === blockName);
    if (!item) {
      return {
        ok: false,
        error: {
          code: 'INVENTORY_MISSING',
          message: `No ${blockName} in inventory.`,
          observed_state: {
            requested_block: blockName,
            requested_coord: { x, y, z },
            inventory_summary: b.inventory.items().reduce((acc, it) => {
              acc[it.name] = (acc[it.name] || 0) + it.count;
              return acc;
            }, /** @type {Record<string, number>} */ ({})),
          },
          retry_safe: false,
        },
      };
    }

    // ── TARGET_OCCUPIED ──
    // Only a non-replaceable block at target counts as occupied.
    const existing = b.blockAt(targetPos);
    if (existing && !isReplaceable(existing)) {
      return {
        ok: false,
        error: {
          code: 'TARGET_OCCUPIED',
          message: `Cannot place at ${x}, ${y}, ${z}: block is already ${existing.name}. Dig it first or choose another cell.`,
          observed_state: {
            requested_block: blockName,
            requested_coord: { x, y, z },
            existing_block: existing.name,
          },
          next_action_hint: `mc dig ${x} ${y} ${z}`,
          retry_safe: false,
        },
      };
    }

    // ── OUT_OF_RANGE (path or pathfind) ──
    const distance = b.entity.position.distanceTo(targetPos);
    if (distance > 4.5) {
      try {
        await b.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'OUT_OF_RANGE',
            message: `Target at (${x}, ${y}, ${z}) is ${Math.round(distance * 10) / 10} blocks away and pathfind failed: ${/** @type {Error} */ (err).message}`,
            observed_state: {
              requested_block: blockName,
              requested_coord: { x, y, z },
              distance: Math.round(distance * 10) / 10,
              bot_position: posObj(b.entity.position),
            },
            retry_safe: false,
          },
        };
      }
    }

    await b.equip(item, 'hand');

    // ── Try each face that has a solid neighbor ──
    // Fluids (water/lava) and other replaceables are NOT valid reference blocks
    // (mineflayer placeBlock against them is rejected by the server).
    let lastPlaceErr = null;
    let triedAnyNeighbor = false;
    for (const [dx, dy, dz] of offsets) {
      const ref = b.blockAt(targetPos.offset(dx, dy, dz));
      if (!isSolidNeighbor(ref)) continue;
      triedAnyNeighbor = true;
      try {
        await b.placeBlock(ref, new Vec3(-dx, -dy, -dz));

        // Verify placement actually landed (mineflayer can ack without the block landing).
        const after = b.blockAt(targetPos);
        if (!after || after.name !== blockName) {
          lastPlaceErr = `placeBlock returned but blockAt(${x},${y},${z}) is ${after?.name ?? 'null'}`;
          continue;
        }

        return {
          ok: true,
          data: {
            placed_block: blockName,
            face_used: { dx, dy, dz, neighbor_block: ref.name, neighbor_position: { x: x + dx, y: y + dy, z: z + dz } },
            position_after: posObj(b.entity.position),
            requested_coord: { x, y, z },
          },
          // Legacy field for callers that look for `result`.
          result: `Placed ${blockName} at ${x}, ${y}, ${z}`,
        };
      } catch (err) {
        lastPlaceErr = /** @type {Error} */ (err).message || String(err);
      }
    }

    // ── NO_SOLID_NEIGHBOR / INTERRUPTED ──
    // If we tried at least one neighbor but every attempt failed, that's an
    // INTERRUPTED-style failure (placement was attempted but server rejected
    // — bot facing wrong way, target out of reach mid-flight, anti-grief, etc.).
    // If no neighbor was even solid, that's NO_SOLID_NEIGHBOR.
    if (triedAnyNeighbor) {
      return {
        ok: false,
        error: {
          code: 'INTERRUPTED',
          message: `Placement attempts all rejected by server: ${lastPlaceErr}`,
          observed_state: {
            requested_block: blockName,
            requested_coord: { x, y, z },
            neighbors: neighborMap,
            bot_position: posObj(b.entity.position),
            distance: Math.round(distance * 10) / 10,
          },
          retry_safe: true,
        },
      };
    }

    return {
      ok: false,
      error: {
        code: 'NO_SOLID_NEIGHBOR',
        message: `No solid neighbor for ${blockName} at ${x},${y},${z}. Stand beside the face you want to extend (target cell must touch solid on one side).`,
        observed_state: {
          requested_block: blockName,
          requested_coord: { x, y, z },
          neighbors: neighborMap,
          bot_position: posObj(b.entity.position),
        },
        next_action_hint: `Place a block adjacent to (${x},${y},${z}) first, or use mc fill / mc pillar_step.`,
        retry_safe: false,
      },
    };
  },

  async place_fill({ block: blockName, x1, y1, z1, x2, y2, z2, hollow = false }) {
    const b = ensureBot();
    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
    const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
    const total = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
    if (total > 500) throw new Error(`Area too large (${total} blocks, max 500). Split into smaller fills.`);

    const positions = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          if (hollow) {
            const onEdge = x === minX || x === maxX || y === minY || y === maxY || z === minZ || z === maxZ;
            if (!onEdge) continue;
          }
          positions.push({ x, y, z });
        }
      }
    }

    const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    let placed = 0;
    for (const pos of positions) {
      const existing = b.blockAt(new Vec3(pos.x, pos.y, pos.z));
      if (existing && existing.name !== 'air' && existing.name !== 'cave_air') continue;

      const item = b.inventory.items().find(i => i.name === blockName);
      if (!item) throw new Error(`Out of ${blockName} (placed ${placed}/${positions.length})`);
      await b.equip(item, 'hand');

      if (b.entity.position.distanceTo(new Vec3(pos.x, pos.y, pos.z)) > 4.5) {
        try { await b.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)); } catch {}
      }

      for (const [dx, dy, dz] of offsets) {
        const ref = b.blockAt(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz));
        if (ref && ref.name !== 'air' && ref.name !== 'cave_air') {
          try {
            await b.placeBlock(ref, new Vec3(-dx, -dy, -dz));
            placed++;
          } catch {}
          break;
        }
      }
    }
    return { result: `Placed ${placed}/${positions.length} ${blockName} blocks (${hollow ? 'hollow' : 'solid'})` };
  },

  /**
   * Highest solid block per vertical column — for pit/site selection without N×find_blocks.
   * Optional `radius`: square (2r+1)² around (x,z), returns max top among sampled columns.
   */
  async terrain_top({ x, z, radius = 0 }) {
    const b = ensureBot();
    const cx = Math.floor(Number(x));
    const cz = Math.floor(Number(z));
    const r = Math.min(Math.max(parseInt(String(radius), 10) || 0, 0), 32);
    /** @type {{ x:number, z:number, topY:number, blockName:string }[]} */
    const columns = [];
    let maxTopY = Number.NEGATIVE_INFINITY;
    let maxBlock = '';
    let maxAt = { x: cx, z: cz };

    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const ix = cx + dx;
        const iz = cz + dz;
        const col = columnTopSolid(b, ix, iz);
        if (!col) continue;
        columns.push({ x: ix, z: iz, topY: col.topY, blockName: col.blockName });
        if (col.topY > maxTopY) {
          maxTopY = col.topY;
          maxBlock = col.blockName;
          maxAt = { x: ix, z: iz };
        }
      }
    }

    if (!columns.length) {
      return {
        result: `No solid blocks in column(s) around ${cx},${cz} (radius ${r}).`,
        topY: null,
        blockName: null,
        columns: [],
      };
    }

    const feetYHint = maxTopY + 1;
    return {
      result: `Top solid ≈Y${maxTopY} (${maxBlock}) at ${maxAt.x},${maxAt.z}${r ? ` (max over radius ${r})` : ''}`,
      topY: maxTopY,
      blockName: maxBlock,
      columnX: maxAt.x,
      columnZ: maxAt.z,
      feetYHint,
      ...(r > 0 ? { columns } : {}),
    };
  },

  /**
   * Clear a box of diggable blocks (inverse of place_fill): top Y down, stand-block deferred per layer.
   */
  async dig_area({
    x1, y1, z1, x2, y2, z2,
    pickup: doPickup = true,
    abort_on_fail: abortOnFail = false,
    clear_stand: clearStand = true,
  }) {
    const b = ensureBot();
    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
    const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
    const total = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
    if (total > 500) throw new Error(`Area too large (${total} blocks, max 500). Split into smaller digs.`);

    let dug = 0;
    let skipped = 0;
    /** @type {string[]} */
    const errors = [];
    /** @type {Set<string>} */
    const digHintSet = new Set();

    for (let y = maxY; y >= minY; y--) {
      const bx = Math.floor(b.entity.position.x);
      const bz = Math.floor(b.entity.position.z);
      const botFloorY = Math.floor(b.entity.position.y);
      const underFeetY = botFloorY - 1;

      /** @type {{ x:number, y:number, z:number }[]} */
      const cells = [];
      for (let xi = minX; xi <= maxX; xi++) {
        for (let zi = minZ; zi <= maxZ; zi++) {
          cells.push({ x: xi, y, z: zi });
        }
      }

      /** @type {{ x:number, y:number, z:number }[]} */
      const deferred = [];
      /** @type {{ x:number, y:number, z:number }[]} */
      const normal = [];
      for (const c of cells) {
        if (clearStand && c.x === bx && c.z === bz && c.y === underFeetY) deferred.push(c);
        else normal.push(c);
      }

      normal.sort((a, c) => {
        const da = Math.max(Math.abs(a.x - bx), Math.abs(a.z - bz));
        const dc = Math.max(Math.abs(c.x - bx), Math.abs(c.z - bz));
        if (da !== dc) return da - dc;
        const ma = Math.abs(a.x - bx) + Math.abs(a.z - bz);
        const mc = Math.abs(c.x - bx) + Math.abs(c.z - bz);
        return ma - mc;
      });

      const order = [...normal, ...deferred];

      for (const pos of order) {
        if (clearStand && pos.x === bx && pos.z === bz && pos.y === underFeetY) {
          await nudgeOffStandPillar(b, pos.x, pos.y, pos.z, goals);
          await sleep(120);
        }

        const target = b.blockAt(new Vec3(pos.x, pos.y, pos.z));
        if (!target || DIG_PASSABLE_NAMES.has(target.name)) continue;

        if (target.name === 'bedrock') {
          skipped++;
          continue;
        }
        if (PROTECTED_DIG_BLOCKS.has(target.name)) {
          skipped++;
          continue;
        }

        try {
          const { hints } = await equipForDig(b, target);
          for (const h of hints) digHintSet.add(h);
          if (b.entity.position.distanceTo(target.position) > 4.5) {
            try {
              await b.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3));
            } catch {}
          }
          await b.dig(target, true);
          dug++;
          await sleep(80);
        } catch (err) {
          const msg = /** @type {Error} */ (err).message || String(err);
          errors.push(`(${pos.x},${pos.y},${pos.z}): ${msg}`);
          skipped++;
          if (abortOnFail) throw /** @type {Error} */ (err);
        }
      }
    }

    let pickupResult = '';
    if (doPickup) {
      try {
        const pu = await ACTIONS.pickup();
        pickupResult = pu?.result ? ` ${pu.result}` : '';
      } catch {
        pickupResult = ' (pickup skipped)';
      }
    }

    const digHints = [...digHintSet];
    const tipsSuffix = digHints.length ? ` Tips: ${digHints.join(' | ')}` : '';
    return {
      result: `Dug ${dug} blocks (${skipped} skipped).${pickupResult}${tipsSuffix}${errors.length ? ` Errors: ${errors.slice(0, 3).join('; ')}` : ''}`,
      dug,
      skipped,
      ...(digHints.length ? { hints: digHints } : {}),
      ...(errors.length ? { errors: errors.slice(0, 20) } : {}),
    };
  },

  /**
   * Dig a straight tunnel segment at feet-level Y using dig_area slices.
   * Intended for industrial mining corridors.
   */
  async tunnel({
    x,
    y,
    z,
    direction = 'north',
    length = 12,
    width = 2,
    height = 3,
    pickup: doPickup = true,
  }) {
    const b = ensureBot();
    const startX = Number.isFinite(Number(x)) ? Math.floor(Number(x)) : Math.floor(b.entity.position.x);
    const startY = Number.isFinite(Number(y)) ? Math.floor(Number(y)) : Math.floor(b.entity.position.y);
    const startZ = Number.isFinite(Number(z)) ? Math.floor(Number(z)) : Math.floor(b.entity.position.z);
    const L = Math.min(Math.max(parseInt(String(length), 10) || 12, 1), 64);
    const W = Math.min(Math.max(parseInt(String(width), 10) || 2, 1), 5);
    const H = Math.min(Math.max(parseInt(String(height), 10) || 3, 2), 5);
    const { dx, dz, key } = cardinalDelta(direction);

    let totalDug = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (let i = 1; i <= L; i++) {
      const cx = startX + dx * i;
      const cz = startZ + dz * i;
      const box = tunnelSliceBounds({ x: cx, y: startY, z: cz, direction: key, width: W, height: H });
      const res = await ACTIONS.dig_area({
        ...box,
        pickup: false,
        abort_on_fail: false,
        clear_stand: true,
      });
      totalDug += Number(res?.dug || 0);
      totalSkipped += Number(res?.skipped || 0);
      totalErrors += Array.isArray(res?.errors) ? res.errors.length : 0;
    }

    let pickupSuffix = '';
    if (doPickup) {
      try {
        const pu = await ACTIONS.pickup();
        pickupSuffix = pu?.result ? ` ${pu.result}` : '';
      } catch {
        pickupSuffix = ' (pickup skipped)';
      }
    }

    return {
      result: `Tunnel ${key} length ${L} width ${W} height ${H}: dug ${totalDug}, skipped ${totalSkipped}, errors ${totalErrors}.${pickupSuffix}`.trim(),
      dug: totalDug,
      skipped: totalSkipped,
      errors: totalErrors,
      start: { x: startX, y: startY, z: startZ },
      end: { x: startX + dx * L, y: startY, z: startZ + dz * L },
    };
  },

  /**
   * Dig a descending staircase (one down per forward step).
   */
  async stair_down({
    x,
    y,
    z,
    direction = 'north',
    length = 12,
    width = 1,
    height = 3,
    pickup: doPickup = true,
  }) {
    const b = ensureBot();
    const startX = Number.isFinite(Number(x)) ? Math.floor(Number(x)) : Math.floor(b.entity.position.x);
    const startY = Number.isFinite(Number(y)) ? Math.floor(Number(y)) : Math.floor(b.entity.position.y);
    const startZ = Number.isFinite(Number(z)) ? Math.floor(Number(z)) : Math.floor(b.entity.position.z);
    const L = Math.min(Math.max(parseInt(String(length), 10) || 12, 1), 64);
    const W = Math.min(Math.max(parseInt(String(width), 10) || 1, 1), 3);
    const H = Math.min(Math.max(parseInt(String(height), 10) || 3, 2), 5);
    const { dx, dz, key } = cardinalDelta(direction);

    let totalDug = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (let i = 1; i <= L; i++) {
      const cx = startX + dx * i;
      const cy = startY - i;
      const cz = startZ + dz * i;
      const box = tunnelSliceBounds({ x: cx, y: cy, z: cz, direction: key, width: W, height: H });
      const res = await ACTIONS.dig_area({
        ...box,
        pickup: false,
        abort_on_fail: false,
        clear_stand: true,
      });
      totalDug += Number(res?.dug || 0);
      totalSkipped += Number(res?.skipped || 0);
      totalErrors += Array.isArray(res?.errors) ? res.errors.length : 0;
    }

    let pickupSuffix = '';
    if (doPickup) {
      try {
        const pu = await ACTIONS.pickup();
        pickupSuffix = pu?.result ? ` ${pu.result}` : '';
      } catch {
        pickupSuffix = ' (pickup skipped)';
      }
    }

    return {
      result: `Stair down ${key} length ${L} width ${W} height ${H}: dug ${totalDug}, skipped ${totalSkipped}, errors ${totalErrors}.${pickupSuffix}`.trim(),
      dug: totalDug,
      skipped: totalSkipped,
      errors: totalErrors,
      start: { x: startX, y: startY, z: startZ },
      end: { x: startX + dx * L, y: startY - L, z: startZ + dz * L },
    };
  },

  /**
   * Dig an ascending staircase (one up per forward step).
   * Each step: move forward one block in `direction` and up one block,
   * clearing a W x H slice for headroom.
   * Optionally places a floor block underfoot on each step to guarantee
   * a walkable path even through open cave voids.
   */
  async stair_up({
    x,
    y,
    z,
    direction = 'north',
    length = 12,
    width = 1,
    height = 3,
    pickup: doPickup = true,
  }) {
    const b = ensureBot();
    const startX = Number.isFinite(Number(x)) ? Math.floor(Number(x)) : Math.floor(b.entity.position.x);
    const startY = Number.isFinite(Number(y)) ? Math.floor(Number(y)) : Math.floor(b.entity.position.y);
    const startZ = Number.isFinite(Number(z)) ? Math.floor(Number(z)) : Math.floor(b.entity.position.z);
    const L = Math.min(Math.max(parseInt(String(length), 10) || 12, 1), 64);
    const W = Math.min(Math.max(parseInt(String(width), 10) || 1, 1), 3);
    const H = Math.min(Math.max(parseInt(String(height), 10) || 3, 2), 5);
    const { dx, dz, key } = cardinalDelta(direction);

    let totalDug = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let totalPlaced = 0;

    const isAirLike = (blk) => blk && (blk.name === 'air' || blk.name === 'cave_air' || blk.name === 'void_air');
    const floorCascade = [
      'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'dirt',
      'granite', 'andesite', 'diorite', 'netherrack',
    ];

    for (let i = 1; i <= L; i++) {
      const cx = startX + dx * i;
      const cy = startY + i;
      const cz = startZ + dz * i;

      const box = tunnelSliceBounds({ x: cx, y: cy, z: cz, direction: key, width: W, height: H });
      const res = await ACTIONS.dig_area({
        ...box,
        pickup: false,
        abort_on_fail: false,
        clear_stand: true,
      });
      totalDug += Number(res?.dug || 0);
      totalSkipped += Number(res?.skipped || 0);
      totalErrors += Array.isArray(res?.errors) ? res.errors.length : 0;

      // Place floor block if the step position is air (open cave)
      const floorPos = new Vec3(cx, cy - 1, cz);
      const floorBlk = b.blockAt(floorPos);
      if (isAirLike(floorBlk)) {
        let placed = false;
        for (const nm of floorCascade) {
          const item = b.inventory.items().find((it) => it.name === nm);
          if (!item) continue;
          try {
            await b.equip(item, 'hand');
            // Find an adjacent solid face to place against
            const faceOffsets = [[0,-1,0],[0,1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]];
            for (const [fdx, fdy, fdz] of faceOffsets) {
              const ref = b.blockAt(floorPos.offset(fdx, fdy, fdz));
              if (ref && !isAirLike(ref) && ref.boundingBox === 'block') {
                await b.placeBlock(ref, new Vec3(-fdx, -fdy, -fdz));
                totalPlaced++;
                placed = true;
                break;
              }
            }
            if (placed) break;
          } catch { /* try next block type */ }
        }
      }

      // Walk to the step position so pathfinder stays anchored
      try {
        await b.pathfinder.goto(new goals.GoalNear(cx, cy, cz, 1));
      } catch {
        // If pathfinder fails on a single step, try direct movement
        try {
          const targetPos = new Vec3(cx + 0.5, cy, cz + 0.5);
          await b.lookAt(targetPos);
          b.setControlState('forward', true);
          await sleep(400);
          b.setControlState('forward', false);
          b.setControlState('jump', true);
          await sleep(200);
          b.setControlState('jump', false);
        } catch { /* continue anyway */ }
      }
    }

    let pickupSuffix = '';
    if (doPickup) {
      try {
        const pu = await ACTIONS.pickup();
        pickupSuffix = pu?.result ? ` ${pu.result}` : '';
      } catch {
        pickupSuffix = ' (pickup skipped)';
      }
    }

    const endY = startY + L;
    return {
      result: `Stair up ${key} length ${L} width ${W} height ${H}: dug ${totalDug}, placed ${totalPlaced} floor blocks, skipped ${totalSkipped}, errors ${totalErrors}. Y ${startY} → ${endY}.${pickupSuffix}`.trim(),
      dug: totalDug,
      placed: totalPlaced,
      skipped: totalSkipped,
      errors: totalErrors,
      start: { x: startX, y: startY, z: startZ },
      end: { x: startX + dx * L, y: endY, z: startZ + dz * L },
    };
  },

  // ── Interaction ─────────────────────────────────
  async interact({ x, y, z }) {
    const b = ensureBot();
    const block = b.blockAt(new Vec3(x, y, z));
    if (!block) throw new Error(`No block at ${x}, ${y}, ${z}`);
    if (b.entity.position.distanceTo(block.position) > 4.5) {
      await b.pathfinder.goto(new goals.GoalNear(x, y, z, 2));
    }
    await b.activateBlock(block);
    return { result: `Interacted with ${block.name} at ${x}, ${y}, ${z}` };
  },

  async close_screen() {
    const b = ensureBot();
    if (b.currentWindow) b.closeWindow(b.currentWindow);
    return { result: 'Closed screen.' };
  },

  // ── Utility ──────────────────────────────────────
  async chat({ message }) {
    const b = ensureBot();
    b.chat(message);
    rememberSocialEvent({ actor: getMyName(), kind: 'sent', channel: 'public', message });
    return { result: `Sent: ${message}` };
  },

  async wait({ seconds = 5 }) {
    ensureBot();
    await sleep(Math.min(seconds, 60) * 1000);
    return { result: `Waited ${seconds}s` };
  },

  async use() {
    const b = ensureBot();
    await b.activateItem();
    return { result: `Used ${b.heldItem?.name || 'hand'}` };
  },

  async sleep_bed() {
    const b = ensureBot();
    let bed = b.findBlock({ matching: block => block.name?.includes('bed'), maxDistance: 6 });
    if (!bed) {
      bed = b.findBlock({ matching: block => block.name?.includes('bed'), maxDistance: 32 });
      if (!bed) throw new Error('No bed within 32 blocks. Craft one (3 wool + 3 planks) or move closer.');
      try { await b.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2)); }
      catch { throw new Error(`Found bed at ${bed.position.x},${bed.position.y},${bed.position.z} but cannot reach it.`); }
    }
    await b.sleep(bed);
    return { result: `Sleeping in ${bed.name} at ${bed.position.x},${bed.position.y},${bed.position.z}. Spawn point set here.` };
  },

  async set_home({ x, y, z } = {}) {
    const b = ensureBot();
    const username = getMyName();
    const px = Number.isFinite(Number(x)) ? Math.floor(Number(x)) : Math.floor(b.entity.position.x);
    const py = Number.isFinite(Number(y)) ? Math.floor(Number(y)) : Math.floor(b.entity.position.y);
    const pz = Number.isFinite(Number(z)) ? Math.floor(Number(z)) : Math.floor(b.entity.position.z);

    const pmcpCfg = paperMcpConfig();
    if (pmcpCfg) {
      const res = await executeServerCommand(pmcpCfg, `spawnpoint ${username} ${px} ${py} ${pz}`);
      if (res.ok) return { result: `Spawn point set to ${px},${py},${pz} via server command.`, x: px, y: py, z: pz };
      log(`PaperMCP set_home failed: ${res.error}, trying bed fallback`);
    }

    // Fallback: find and sleep in a bed
    const bed = b.findBlock({ matching: block => block.name?.includes('bed'), maxDistance: 32 });
    if (bed) {
      try {
        await b.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2));
        await b.sleep(bed);
        return { result: `Spawn point set by sleeping in bed at ${bed.position.x},${bed.position.y},${bed.position.z}.` };
      } catch (err) {
        throw new Error(`Cannot set home: PaperMCP unavailable and bed at ${bed.position.x},${bed.position.y},${bed.position.z} unreachable: ${/** @type {Error} */ (err).message}`);
      }
    }
    throw new Error('Cannot set home: PaperMCP unavailable and no bed within 32 blocks. Craft a bed (3 wool + 3 planks) and place it, then run mc sleep.');
  },

  // ── Chat / Whisper ──────────────────────────────
  async chat_to({ player, message }) {
    const b = ensureBot();
    b.chat(`/msg ${player} ${message}`);
    rememberSocialEvent({ actor: getMyName(), target: player, kind: 'sent', channel: 'whisper', message });
    return { result: `[→${player}]: ${message}` };
  },

  async whisper({ player, message }) {
    const b = ensureBot();
    b.chat(`/msg ${player} ${message}`);
    rememberSocialEvent({ actor: getMyName(), target: player, kind: 'sent', channel: 'whisper', message });
    return { result: `[→${player}]: ${message}` };
  },

  // ── Death / Respawn ─────────────────────────────────
  async respawn({ confirm } = {}) {
    if (String(confirm) !== 'yes') {
      return { error: 'Respawn uses /kill — you die and drop all items. Pass confirm=yes to proceed.' };
    }
    const b = ensureBot();
    const pos = posObj();
    const username = getMyName();
    const items = b.inventory.items().map((i) => `${i.name}x${i.count}`);
    log(`Voluntary respawn at ${pos.x},${pos.y},${pos.z}. Dropping: ${items.join(', ') || 'nothing'}`);

    // Primary: use PaperMCP to run /kill server-side (bypasses chat protocol issues)
    const pmcpCfg = paperMcpConfig();
    if (pmcpCfg) {
      log('Respawn: using PaperMCP server-side /kill');
      const res = await executeServerCommand(pmcpCfg, `kill ${username}`);
      if (!res.ok) log(`PaperMCP kill failed: ${res.error}, falling back to chat`);
    }

    // Fallback: send /kill through bot chat (may not work on all server configs)
    if (!pmcpCfg) {
      if (b._client._signedChat) {
        b._client._signedChat('/kill');
      } else {
        b.chat('/kill');
      }
    }

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      b.once('death', () => { clearTimeout(timer); resolve(); });
    });
    // mineflayer health.js auto-respawns; nudge once in case /kill + respawn screen lagged.
    try {
      if (typeof b.respawn === 'function' && b.isAlive === false) b.respawn();
    } catch { /* ignore */ }
    await sleep(2000);
    ctx.positionHistory = [];

    const newPos = posObj();
    return {
      result: `Respawned via /kill. Old pos: ${pos.x},${pos.y},${pos.z}. New pos: ${newPos.x},${newPos.y},${newPos.z}. Dropped items: ${items.join(', ') || 'none'}.`,
      old_position: pos,
      new_position: newPos,
      dropped_items: items,
    };
  },

  async deathpoint() {
    if (!ctx.lastDeath) return { result: 'No deaths recorded.' };
    const pos = ctx.lastDeath.position;
    const age = Math.round((Date.now() - ctx.lastDeath.time) / 1000);
    const b = ensureBot();
    await b.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3));
    return { result: `At death #${ctx.lastDeath.deathNumber} (${age}s ago). Lost: ${ctx.lastDeath.inventory.map(i=>`${i.name}x${i.count}`).join(', ')}` };
  },

  };
}
