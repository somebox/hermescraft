import { Vec3 } from 'vec3';
import { equipForDig, PROTECTED_DIG_BLOCKS, RELOCATABLE_INFRASTRUCTURE, DIG_PASSABLE_NAMES, FALLING_BLOCK_NAMES, columnTopSolid, nudgeOffStandPillar, detectDigHazards, suggestedToolForBlock, isDigProtected } from '../bot/dig-tools.js';
import { executeServerCommand, paperMcpConfig } from '../bot/paper-mcp.js';
import { raceWithTimeout, timeoutError, OperationTimeoutError, ACTION_CAPS_MS, ensureWithinReach } from './_helpers.js';
import { isStandableCell, standabilityReason, findClosestStandable, standingState } from './_nav-helpers.js';

export function createWorldActions(deps) {
  const { ctx, ensureBot, goals, fmt, posObj, sleep, log, resolveInventoryItem, rememberSocialEvent, getMyName, ACTIONS, hasLineOfSight, eyePosition } = deps;
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
        if (isDigProtected(blk.name)) continue;
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
    // ─ Phase-2 action contract (see docs/phase-2/action-contracts.md mc place) ─
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

    // ── TARGET_SELF_OCCUPIED ──
    // The bot itself occupies 2 cells: foot (floor(botY)) and head
    // (floor(botY)+1). Server silently rejects placement in either —
    // mineflayer waits 5s for a blockUpdate event that never fires.
    // Pre-flight catch returns an actionable error immediately so the
    // agent doesn't waste a turn (and 5s) on the timeout.
    const botY = Math.floor(b.entity.position.y);
    const botBlockX = Math.floor(b.entity.position.x);
    const botBlockZ = Math.floor(b.entity.position.z);
    if (x === botBlockX && z === botBlockZ && (y === botY || y === botY + 1)) {
      return {
        ok: false,
        error: {
          code: 'TARGET_SELF_OCCUPIED',
          message: `Cannot place at ${x},${y},${z}: that's your ${y === botY ? 'foot' : 'head'} cell. Step aside (e.g. mc goto_near ${x + 1} ${y} ${z}) or pick an adjacent cell.`,
          retry_safe: false,
        },
      };
    }

    // ── TARGET_OCCUPIED ──
    // Only a non-replaceable block at target counts as occupied.
    const existing = b.blockAt(targetPos);
    if (existing && !isReplaceable(existing)) {
      // F45.4: enrich with diggability + relocatability + suggested tool.
      const isDiggable = !isDigProtected(existing.name);
      const isRelocatable = RELOCATABLE_INFRASTRUCTURE.has(existing.name);
      const suggestedTool = suggestedToolForBlock(existing.name);
      let hint;
      let nextActionHint;
      if (isRelocatable) {
        hint = `${existing.name} is relocatable — dig it (mc dig ${x} ${y} ${z}) and re-place it somewhere else (mc place ${existing.name} <X> <Y> <Z>).`;
        nextActionHint = `mc dig ${x} ${y} ${z}`;
      } else if (isDiggable) {
        hint = `Block is diggable — clear with mc dig ${x} ${y} ${z} (use ${suggestedTool}).`;
        nextActionHint = `mc dig ${x} ${y} ${z}`;
      } else {
        hint = `Block is protected (part of a building). Choose another cell.`;
        nextActionHint = null;
      }
      return {
        ok: false,
        error: {
          code: 'TARGET_OCCUPIED',
          message: `Cannot place at ${x}, ${y}, ${z}: block is already ${existing.name}. ${hint}`,
          observed_state: {
            requested_block: blockName,
            requested_coord: { x, y, z },
            existing_block: existing.name,
            is_diggable: isDiggable,
            is_relocatable: isRelocatable,
            suggested_tool: suggestedTool,
          },
          ...(nextActionHint ? { next_action_hint: nextActionHint } : {}),
          retry_safe: false,
        },
      };
    }

    // ── TARGET_ENTITY_OCCUPIED ──
    // Another player or mob is standing in the target cell. The server
    // silently rejects placement (no error event fires), so we'd otherwise
    // sit for 5s on placeBlock's timeout with no useful feedback. Detect
    // it pre-flight and tell the agent exactly who is in the way so they
    // can ask via chat — critical for multi-bot coordination (G21).
    // Entities occupy their foot block AND the block above (height ~1.8).
    const blockingEntity = Object.values(b.entities || {}).find((e) => {
      if (!e || !e.position || e === b.entity) return false;
      const ex = Math.floor(e.position.x);
      const ey = Math.floor(e.position.y);
      const ez = Math.floor(e.position.z);
      if (ex !== x || ez !== z) return false;
      // The cell is occupied if it matches the entity's feet OR head cell.
      return ey === y || ey + 1 === y;
    });
    if (blockingEntity) {
      const isPlayer = blockingEntity.type === 'player';
      const who = blockingEntity.username || blockingEntity.name || blockingEntity.displayName || blockingEntity.type || 'entity';
      const kind = isPlayer ? 'player' : (blockingEntity.name || blockingEntity.type || 'entity');
      const hintTo = isPlayer
        ? `mc chat_to ${who} "please step aside, I need to place at ${x},${y},${z}"`
        : `mc attack ${who}`;
      return {
        ok: false,
        error: {
          code: 'TARGET_ENTITY_OCCUPIED',
          message: `Cannot place at ${x},${y},${z}: ${kind} '${who}' is standing there. Ask them to move (or wait).`,
          observed_state: {
            requested_block: blockName,
            requested_coord: { x, y, z },
            blocked_by: {
              kind,
              name: who,
              position: { x: blockingEntity.position.x, y: blockingEntity.position.y, z: blockingEntity.position.z },
              is_player: isPlayer,
            },
          },
          next_action_hint: hintTo,
          retry_safe: true,
        },
      };
    }

    // ── OUT_OF_RANGE (path or pathfind) ──
    const distance = b.entity.position.distanceTo(targetPos);
    if (distance > 4.5) {
      try {
        await raceWithTimeout(
          b.pathfinder.goto(new goals.GoalNear(x, y, z, 3)),
          ACTION_CAPS_MS.place,
          'place',
        );
      } catch (err) {
        if (err instanceof OperationTimeoutError || err.code === 'OPERATION_TIMEOUT') {
          try { b.pathfinder.setGoal(null); } catch { /* ignore */ }
          return timeoutError('place', ACTION_CAPS_MS.place, {
            requested_block: blockName,
            requested_coord: { x, y, z },
            distance: Math.round(distance * 10) / 10,
            bot_position: posObj(b.entity.position),
          }, 'Pathfind to target was canceled. Re-evaluate route or try a closer cell.');
        }
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

    // ── NO_LINE_OF_SIGHT ──
    // F45.3: Without LOS, bot can place blocks through walls / through its
    // own body (parallel to the G20 attack-through-walls hole F42 closed).
    // Raycast from bot eye toward each candidate face of the target cell;
    // accept if ANY face is visible. Aim 0.02 inward so the ray endpoint
    // sits in air, not inside the target — avoids false-negative where
    // the ray ends inside the block itself.
    if (typeof hasLineOfSight === 'function' && typeof eyePosition === 'function') {
      const eye = eyePosition();
      if (!eye) {
        // Bot not yet spawned with a position — skip the LOS check and
        // fall through to the place loop. Should not happen in practice.
      } else {
      const cx = x + 0.5;
      const cy = y + 0.5;
      const cz = z + 0.5;
      const faceCandidates = [
        { x: cx, y: cy, z: cz - 0.48 },
        { x: cx, y: cy, z: cz + 0.48 },
        { x: cx - 0.48, y: cy, z: cz },
        { x: cx + 0.48, y: cy, z: cz },
        { x: cx, y: cy - 0.48, z: cz },
        { x: cx, y: cy + 0.48, z: cz },
        { x: cx, y: cy, z: cz },
      ];
      const seesAnyFace = faceCandidates.some((p) => hasLineOfSight(eye, p));
      if (!seesAnyFace) {
        // Identify the blocker on the center ray for the message.
        let blocker = null;
        try {
          const raw = b.world?.raycast?.(
            eye,
            { x: cx - eye.x, y: cy - eye.y, z: cz - eye.z },
            6,
          );
          blocker = raw?.name || null;
        } catch { /* ignore */ }
        // F56: scan a 5-block ring around the target at the bot's foot
        // level to find a stand cell where LOS to the target would be
        // clear. Return that as next_action_hint so the brain can move
        // there instead of guessing. Costs ~24 cheap raycasts.
        let suggestedStand = null;
        try {
          const ringRadius = 3;
          const standY = y - 1; // bot stands here, eye at standY+1.62
          const standCandidates = [];
          for (let dx = -ringRadius; dx <= ringRadius; dx++) {
            for (let dz = -ringRadius; dz <= ringRadius; dz++) {
              if (dx === 0 && dz === 0) continue;
              const sx = x + dx;
              const sz = z + dz;
              // Must have a solid floor to stand on, and air at head/foot.
              const floor = b.blockAt(new Vec3(sx, standY, sz));
              const feet = b.blockAt(new Vec3(sx, standY + 1, sz));
              const head = b.blockAt(new Vec3(sx, standY + 2, sz));
              if (!floor || floor.boundingBox !== 'block') continue;
              if (feet && feet.boundingBox === 'block') continue;
              if (head && head.boundingBox === 'block') continue;
              const fakeEye = { x: sx + 0.5, y: standY + 1 + 1.62, z: sz + 0.5 };
              const sees = faceCandidates.some((p) => hasLineOfSight(fakeEye, p));
              if (sees) {
                const dist = Math.abs(dx) + Math.abs(dz);
                standCandidates.push({ x: sx, y: standY + 1, z: sz, dist });
              }
            }
          }
          standCandidates.sort((a, c) => a.dist - c.dist);
          suggestedStand = standCandidates[0] || null;
        } catch { /* ignore */ }
        return {
          ok: false,
          error: {
            code: 'NO_LINE_OF_SIGHT',
            message: suggestedStand
              ? `Cannot place at ${x},${y},${z} — view blocked${blocker ? ` by ${blocker}` : ''}. Stand at (${suggestedStand.x}, ${suggestedStand.y}, ${suggestedStand.z}) for clear sight: mc move ${suggestedStand.x} ${suggestedStand.y} ${suggestedStand.z}`
              : `Cannot place at ${x},${y},${z} — your view to the target is blocked${blocker ? ` by ${blocker}` : ''} and no nearby stand position has clear sight. Dig the obstruction first, or approach the target from another side.`,
            observed_state: {
              requested_block: blockName,
              requested_coord: { x, y, z },
              bot_position: posObj(b.entity.position),
              blocker: blocker || null,
              suggested_stand: suggestedStand,
            },
            ...(suggestedStand ? { next_action_hint: `mc move ${suggestedStand.x} ${suggestedStand.y} ${suggestedStand.z}` } : {}),
            retry_safe: false,
          },
        };
      }
      } // end if (eye)
    }

    // F55.1: verify equip actually landed. mineflayer's equip can no-op
    // silently when an item reference is stale (just-crafted items have
    // a different slot id than the snapshot we passed). Verify; if held
    // item still doesn't match, re-resolve from a fresh inventory pass
    // and retry once. Failing both, return EQUIP_FAILED so the brain
    // knows what to fix instead of seeing a generic placement timeout.
    try {
      await b.equip(item, 'hand');
    } catch (err) {
      // Fall through to re-resolve check below.
    }
    if (b.heldItem?.name !== blockName) {
      await sleep(200);
      const fresh = b.inventory.items().find((i) => i.name === blockName);
      if (fresh) {
        try { await b.equip(fresh, 'hand'); } catch { /* swallow */ }
      }
      if (b.heldItem?.name !== blockName) {
        return {
          ok: false,
          error: {
            code: 'EQUIP_FAILED',
            message: `${blockName} is in inventory but couldn't be equipped to hand (held=${b.heldItem?.name ?? 'empty'}). Try mc equip ${blockName} then mc place again.`,
            observed_state: {
              requested_block: blockName,
              held: b.heldItem?.name ?? null,
              inv_count: b.inventory.items().filter((i) => i.name === blockName).reduce((s, i) => s + i.count, 0),
            },
            next_action_hint: `mc equip ${blockName}`,
            retry_safe: true,
          },
        };
      }
    }

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
            at: { x, y, z },
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

    // F60+F62: cluster cells by reach-from-a-safe-standpoint. The bot
    // walks to a standpoint (a safe cell OUTSIDE the fill region),
    // places every cell reachable from there, then walks to the next
    // standpoint. This is both more realistic-looking (visible bursts
    // separated by short walks instead of one motionless 26-block dump)
    // AND fixes the F55.2 self-blocking case at the source — by
    // construction the bot is never standing inside the region. We also
    // pace placements with a small inter-cell delay so the server has
    // time to confirm each placeBlock packet (mineflayer otherwise
    // times out waiting for blockUpdate on long bursts).
    const STANDPOINT_REACH = 4.0;        // mineflayer placeBlock reach limit ≈ 4.5
    const INTER_PLACE_DELAY_MS = 180;
    const inFillRegion = (x, y, z) =>
      x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ;
    const airy = (blk) => blk && (blk.name === 'air' || blk.name === 'cave_air');
    const solid = (blk) => blk && blk.boundingBox === 'block';
    const isStandpoint = (sx, sy, sz) => {
      // Bot occupies feet (sx, sy) and head (sx, sy+1). Neither may be in
      // the fill region (would block placement of own foot/head cell).
      if (inFillRegion(sx, sy, sz) || inFillRegion(sx, sy + 1, sz)) return false;
      const feet = b.blockAt(new Vec3(sx, sy, sz));
      const head = b.blockAt(new Vec3(sx, sy + 1, sz));
      const below = b.blockAt(new Vec3(sx, sy - 1, sz));
      return airy(feet) && airy(head) && solid(below);
    };
    const findStandpointFor = (cell) => {
      // Spiral search around the target cell at multiple y offsets.
      for (let r = 1; r <= 4; r++) {
        for (const dy of [0, -1, 1, -2]) {
          for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
              if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;  // ring at radius r
              const sx = cell.x + dx, sy = cell.y + dy, sz = cell.z + dz;
              if (!isStandpoint(sx, sy, sz)) continue;
              const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
              if (d <= STANDPOINT_REACH) return [sx, sy, sz];
            }
          }
        }
      }
      return null;
    };

    // Greedy cluster assignment: each remaining cell seeds a new cluster
    // with its standpoint; all remaining cells within reach get assigned
    // to it. Same standpoint serves multiple cells, so we visibly walk
    // O(positions / cluster_size) times instead of pathfinding per cell.
    const cellKey = (p) => `${p.x},${p.y},${p.z}`;
    const assigned = new Set();
    const clusters = [];  // [{ standpoint: [x,y,z]|null, cells: [pos] }]
    for (const seed of positions) {
      if (assigned.has(cellKey(seed))) continue;
      const sp = findStandpointFor(seed);
      const cluster = { standpoint: sp, cells: [] };
      if (!sp) {
        // No reachable standpoint — keep the seed alone; per-cell loop
        // will pathfind closest-fit and rely on F55.2 detection if it
        // ends up self-blocking.
        cluster.cells.push(seed);
        assigned.add(cellKey(seed));
      } else {
        for (const p of positions) {
          if (assigned.has(cellKey(p))) continue;
          const d = Math.sqrt(
            (sp[0] - p.x) * (sp[0] - p.x) +
            (sp[1] - p.y) * (sp[1] - p.y) +
            (sp[2] - p.z) * (sp[2] - p.z)
          );
          if (d <= STANDPOINT_REACH + 0.5) {
            cluster.cells.push(p);
            assigned.add(cellKey(p));
          }
        }
      }
      clusters.push(cluster);
    }
    let autoDisplaced = null;

    // F53.1: track structured fill outcomes instead of silently swallowing.
    // - placed_count = blocks newly placed
    // - skipped_already_blockname = cell already had the desired block (idempotent)
    // - skipped_occupied = cell had a different non-air block; the brain
    //   needs to know about this so it doesn't think the fill is done.
    //   For each skipped cell we record the blocker's name so the brain
    //   can recognize "ah, a crafting_table is in the way".
    // - place_failures = cells we tried to place but b.placeBlock threw
    //   (typically LOS or face-availability problems).
    const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    let placed = 0;
    let skipped_already = 0;
    const skipped_occupied = [];  // [{x,y,z,by:blockname}]
    const place_failures = [];    // [{x,y,z,reason}]
    const occupied_by_counts = {}; // {block_name: count}
    for (const cluster of clusters) {
      // Walk to the cluster's standpoint (skip if at one already).
      if (cluster.standpoint) {
        const [sx, sy, sz] = cluster.standpoint;
        const cur = b.entity.position;
        const d = Math.sqrt((cur.x - sx) ** 2 + (cur.y - sy) ** 2 + (cur.z - sz) ** 2);
        if (d > 1.5) {
          try {
            await b.pathfinder.goto(new goals.GoalBlock(sx, sy, sz));
            if (!autoDisplaced) {
              autoDisplaced = { from: { x: Math.floor(cur.x), y: Math.floor(cur.y), z: Math.floor(cur.z) }, to: { x: sx, y: sy, z: sz } };
            }
          } catch {}
        }
      }
      for (const pos of cluster.cells) {
        const existing = b.blockAt(new Vec3(pos.x, pos.y, pos.z));
        if (existing && existing.name !== 'air' && existing.name !== 'cave_air') {
          if (existing.name === blockName) {
            skipped_already++;
          } else {
            skipped_occupied.push({ x: pos.x, y: pos.y, z: pos.z, by: existing.name });
            occupied_by_counts[existing.name] = (occupied_by_counts[existing.name] || 0) + 1;
          }
          continue;
        }

        const item = b.inventory.items().find(i => i.name === blockName);
        if (!item) throw new Error(`Out of ${blockName} (placed ${placed}/${positions.length})`);
        await b.equip(item, 'hand');

        // Fallback per-cell pathfind only if no standpoint was found for this cluster.
        if (!cluster.standpoint && b.entity.position.distanceTo(new Vec3(pos.x, pos.y, pos.z)) > 4.5) {
          try { await b.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)); } catch {}
        }

        let placedThis = false;
        let lastErr = null;
        for (const [dx, dy, dz] of offsets) {
          const ref = b.blockAt(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz));
          if (ref && ref.name !== 'air' && ref.name !== 'cave_air') {
            try {
              await b.placeBlock(ref, new Vec3(-dx, -dy, -dz));
              placed++;
              placedThis = true;
            } catch (e) {
              lastErr = e?.message || String(e);
            }
            break;
          }
        }
        if (!placedThis) {
          place_failures.push({ x: pos.x, y: pos.y, z: pos.z, reason: lastErr || 'no_adjacent_face' });
        }
        // Small delay between placements — looks more natural AND gives
        // the server time to confirm blockUpdate before the next packet.
        await sleep(INTER_PLACE_DELAY_MS);
      }
    }

    const skipped_total = skipped_occupied.length + place_failures.length;
    // F55.2: detect when the bot was standing inside the fill region
    // (their foot/head cells block placement, mineflayer fails silently).
    // Tag the offending place_failures and surface a top-level flag so
    // the brain can't misread "FILL_PARTIAL because of me" as "complete".
    const botFootX = Math.floor(b.entity.position.x);
    const botFootY = Math.floor(b.entity.position.y);
    const botFootZ = Math.floor(b.entity.position.z);
    const botBlockedCells = [];
    for (const f of place_failures) {
      if (f.x === botFootX && f.z === botFootZ && (f.y === botFootY || f.y === botFootY + 1)) {
        f.reason = 'bot_self_blocking';
        botBlockedCells.push({ x: f.x, y: f.y, z: f.z });
      }
    }
    const botWasInsideRegion = botBlockedCells.length > 0;

    // Result message: if anything was skipped or failed, surface it loudly.
    // Brain should not mistake a 15/16 fill for a 16/16 success.
    const occupied_summary = Object.entries(occupied_by_counts)
      .sort((a, c) => c[1] - a[1])
      .slice(0, 3)
      .map(([name, n]) => `${n}× ${name}`)
      .join(', ');
    let resultMsg;
    if (skipped_total === 0) {
      resultMsg = `Placed ${placed}/${positions.length} ${blockName} blocks (${hollow ? 'hollow' : 'solid'})`;
    } else {
      const parts = [`Placed ${placed}/${positions.length} ${blockName}`];
      if (skipped_already > 0) parts.push(`${skipped_already} already-correct`);
      if (skipped_occupied.length > 0) parts.push(`${skipped_occupied.length} occupied (${occupied_summary})`);
      if (place_failures.length > 0) parts.push(`${place_failures.length} placement-failed`);
      const selfNote = botWasInsideRegion
        ? ` — YOU were standing inside the region (${botBlockedCells.length} cell${botBlockedCells.length > 1 ? 's' : ''} blocked by your body). Move outside the region and re-run mc fill to complete it.`
        : '';
      resultMsg = `FILL_PARTIAL: ${parts.join('; ')}.${selfNote} Check observed_state.skipped_occupied to see what's blocking.`;
    }
    return {
      result: resultMsg,
      data: {
        placed,
        skipped_already,
        skipped_occupied,
        place_failures,
        occupied_by_counts,
        total: positions.length,
        partial: skipped_total > 0,
        ...(autoDisplaced ? { auto_displaced: autoDisplaced } : {}),
        ...(botWasInsideRegion ? {
          bot_was_inside_region: true,
          bot_blocked_cells: botBlockedCells,
          next_action_hint: `Move outside the region (mc goto_near <outside coord>), then mc fill ${blockName} ${x1} ${y1} ${z1} ${x2} ${y2} ${z2}`,
        } : {}),
      },
    };
  },

  /**
   * Build a wall: vertical line/rectangle of blocks. Sugar over place_fill
   * with action-contract shape and a "must have height" guard so a flat
   * single-Y rectangle (= floor) gets a clear error instead of silently
   * placing a slab. See docs/phase-2/sprints.md (Sprint 5 — Building primitives).
   * — Phase-2 action contract (see docs/phase-2/action-contracts.md mc wall) —
   */
  async wall({ block: blockName, x1, y1, z1, x2, y2, z2 }) {
    const b = ensureBot();

    if (!blockName || typeof blockName !== 'string') {
      return {
        ok: false,
        error: {
          code: 'MISSING_BLOCK_TYPE',
          message: 'mc wall requires a block name (e.g. cobblestone, oak_planks)',
          observed_state: { received: blockName },
          retry_safe: false,
        },
      };
    }

    const coords = ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'];
    const args = { x1, y1, z1, x2, y2, z2 };
    for (const k of coords) {
      const n = Number(args[k]);
      if (!Number.isFinite(n)) {
        return {
          ok: false,
          error: {
            code: 'INVALID_COORD',
            message: `mc wall requires numeric ${k}, got ${args[k]}`,
            observed_state: { received: args },
            retry_safe: false,
          },
        };
      }
      args[k] = n;
    }

    const minX = Math.min(args.x1, args.x2);
    const maxX = Math.max(args.x1, args.x2);
    const minY = Math.min(args.y1, args.y2);
    const maxY = Math.max(args.y1, args.y2);
    const minZ = Math.min(args.z1, args.z2);
    const maxZ = Math.max(args.z1, args.z2);

    if (minY === maxY) {
      return {
        ok: false,
        error: {
          code: 'NOT_A_WALL',
          message: `y1=y2=${minY}: walls need vertical height. Use mc fill for a flat slab.`,
          observed_state: { y1: args.y1, y2: args.y2 },
          retry_safe: false,
        },
      };
    }

    const total = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
    if (total > 200) {
      return {
        ok: false,
        error: {
          code: 'OUT_OF_RANGE',
          message: `Wall too large (${total} blocks, max 200). Split into smaller walls.`,
          observed_state: { total, max: 200 },
          retry_safe: false,
        },
      };
    }

    const positions = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          positions.push({ x, y, z });
        }
      }
    }

    const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    let placed = 0;
    let skipped_existing = 0;
    let failed = 0;

    for (const pos of positions) {
      const existing = b.blockAt(new Vec3(pos.x, pos.y, pos.z));
      if (existing && existing.name !== 'air' && existing.name !== 'cave_air') {
        skipped_existing++;
        continue;
      }

      const item = b.inventory.items().find((i) => i.name === blockName);
      if (!item) {
        return {
          ok: false,
          error: {
            code: 'MISSING_INVENTORY',
            message: `Out of ${blockName} after placing ${placed}/${positions.length}`,
            observed_state: { blocks_placed: placed, blocks_remaining: positions.length - placed - skipped_existing, block: blockName },
            retry_safe: true,
          },
        };
      }
      try { await b.equip(item, 'hand'); } catch {}

      if (b.entity.position.distanceTo(new Vec3(pos.x, pos.y, pos.z)) > 4.5) {
        try { await b.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)); } catch {}
      }

      let success = false;
      for (const [dx, dy, dz] of offsets) {
        const ref = b.blockAt(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz));
        if (ref && ref.name !== 'air' && ref.name !== 'cave_air') {
          try {
            await b.placeBlock(ref, new Vec3(-dx, -dy, -dz));
            placed++;
            success = true;
          } catch {}
          break;
        }
      }
      if (!success) failed++;
    }

    return {
      ok: true,
      data: {
        blocks_placed: placed,
        blocks_attempted: positions.length,
        skipped_existing,
        failed,
        bounds: { x1: minX, y1: minY, z1: minZ, x2: maxX, y2: maxY, z2: maxZ },
        block: blockName,
      },
      result: `Wall: ${placed}/${positions.length} ${blockName} placed${skipped_existing ? ` (${skipped_existing} skipped — existing block)` : ''}${failed ? ` (${failed} failed)` : ''}`,
    };
  },

  /**
   * Build a fence enclosure: rectangle perimeter at current Y. Optional
   * --gate DIR places a matching fence_gate at the midpoint of the named
   * side (north|south|east|west), inferring gate type from fence type
   * (e.g. oak_fence → oak_fence_gate).
   * — Phase-2 action contract (see docs/phase-2/action-contracts.md mc fence) —
   */
  async fence({ block: blockName, x1, z1, x2, z2, gate, y }) {
    const b = ensureBot();

    if (!blockName || typeof blockName !== 'string') {
      return { ok: false, error: { code: 'MISSING_FENCE_BLOCK', message: 'mc fence requires a fence block (e.g. oak_fence)', retry_safe: false } };
    }
    if (!blockName.endsWith('_fence')) {
      return { ok: false, error: { code: 'NOT_A_FENCE', message: `Block "${blockName}" is not a fence type (must end in _fence)`, retry_safe: false } };
    }

    const args = { x1, z1, x2, z2 };
    for (const k of ['x1', 'z1', 'x2', 'z2']) {
      const n = Number(args[k]);
      if (!Number.isFinite(n)) {
        return { ok: false, error: { code: 'INVALID_COORD', message: `mc fence requires numeric ${k}`, retry_safe: false } };
      }
      args[k] = n;
    }

    const minX = Math.min(args.x1, args.x2);
    const maxX = Math.max(args.x1, args.x2);
    const minZ = Math.min(args.z1, args.z2);
    const maxZ = Math.max(args.z1, args.z2);
    const w = maxX - minX + 1;
    const l = maxZ - minZ + 1;

    if (w < 3 || l < 3) {
      return { ok: false, error: { code: 'ENCLOSURE_TOO_SMALL', message: `Enclosure ${w}×${l} too small (min 3×3 to have an interior)`, retry_safe: false } };
    }

    // Use bot's current Y if not specified (fences need a solid block beneath, so picking the bot's standing Y is usually right).
    const fenceY = Number.isFinite(Number(y)) ? Number(y) : Math.floor(b.entity.position.y);

    // Compute perimeter positions (top + bottom rows + left + right columns, no duplicates).
    const positions = [];
    for (let x = minX; x <= maxX; x++) {
      positions.push({ x, y: fenceY, z: minZ }); // north edge
      positions.push({ x, y: fenceY, z: maxZ }); // south edge
    }
    for (let z = minZ + 1; z <= maxZ - 1; z++) {
      positions.push({ x: minX, y: fenceY, z }); // west edge
      positions.push({ x: maxX, y: fenceY, z }); // east edge
    }

    // Gate: midpoint of the requested side. Replaces one fence with a gate.
    let gatePos = null;
    let gateType = null;
    let gateFacing = null;
    if (gate) {
      const dir = String(gate).toLowerCase();
      if (!['north', 'south', 'east', 'west'].includes(dir)) {
        return { ok: false, error: { code: 'INVALID_GATE_DIR', message: `gate must be north|south|east|west, got "${gate}"`, retry_safe: false } };
      }
      const midX = Math.floor((minX + maxX) / 2);
      const midZ = Math.floor((minZ + maxZ) / 2);
      switch (dir) {
        case 'north': gatePos = { x: midX, y: fenceY, z: minZ }; gateFacing = 'south'; break;
        case 'south': gatePos = { x: midX, y: fenceY, z: maxZ }; gateFacing = 'north'; break;
        case 'west':  gatePos = { x: minX, y: fenceY, z: midZ }; gateFacing = 'east';  break;
        case 'east':  gatePos = { x: maxX, y: fenceY, z: midZ }; gateFacing = 'west';  break;
      }
      gateType = blockName.replace(/_fence$/, '_fence_gate');
    }

    // Filter perimeter to remove the gate position (we'll place the gate separately).
    const fencePositions = gatePos
      ? positions.filter((p) => !(p.x === gatePos.x && p.z === gatePos.z))
      : positions;

    const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    let placed = 0;
    let skipped = 0;
    let failed = 0;

    async function placeOne(pos, itemName) {
      const existing = b.blockAt(new Vec3(pos.x, pos.y, pos.z));
      if (existing && existing.name !== 'air' && existing.name !== 'cave_air') return 'skipped';
      const item = b.inventory.items().find((i) => i.name === itemName);
      if (!item) return 'no_item';
      try { await b.equip(item, 'hand'); } catch {}
      if (b.entity.position.distanceTo(new Vec3(pos.x, pos.y, pos.z)) > 4.5) {
        try { await b.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)); } catch {}
      }
      for (const [dx, dy, dz] of offsets) {
        const ref = b.blockAt(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz));
        if (ref && ref.name !== 'air' && ref.name !== 'cave_air') {
          try {
            await b.placeBlock(ref, new Vec3(-dx, -dy, -dz));
            return 'placed';
          } catch {}
          break;
        }
      }
      return 'failed';
    }

    for (const pos of fencePositions) {
      const r = await placeOne(pos, blockName);
      if (r === 'placed') placed++;
      else if (r === 'skipped') skipped++;
      else if (r === 'no_item') {
        return {
          ok: false,
          error: {
            code: 'MISSING_INVENTORY',
            message: `Out of ${blockName} after placing ${placed}/${fencePositions.length}`,
            observed_state: { fences_placed: placed, fences_remaining: fencePositions.length - placed - skipped, block: blockName },
            retry_safe: true,
          },
        };
      } else failed++;
    }

    let gatePlaced = false;
    if (gatePos) {
      const r = await placeOne(gatePos, gateType);
      if (r === 'placed') gatePlaced = true;
      else if (r === 'no_item') {
        // Gate item missing — fence is still valid, just no gate. Return partial success.
        return {
          ok: true,
          data: {
            fences_placed: placed,
            fences_attempted: fencePositions.length,
            skipped_existing: skipped,
            failed,
            gate_placed: false,
            gate_skipped_reason: `no ${gateType} in inventory`,
            bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ, y: fenceY },
            block: blockName,
          },
          result: `Fence: ${placed}/${fencePositions.length} ${blockName} placed; gate skipped (no ${gateType})`,
        };
      }
    }

    return {
      ok: true,
      data: {
        fences_placed: placed,
        fences_attempted: fencePositions.length,
        skipped_existing: skipped,
        failed,
        gate_placed: gatePlaced,
        gate_position: gatePos,
        gate_facing: gateFacing,
        gate_type: gateType,
        bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ, y: fenceY },
        block: blockName,
      },
      result: `Fence: ${placed}/${fencePositions.length} ${blockName} placed${gatePlaced ? `, gate placed (${gateType}) on ${gate} side` : ''}${skipped ? ` (${skipped} skipped)` : ''}${failed ? ` (${failed} failed)` : ''}`,
    };
  },

  async path({ x1, z1, x2, z2, y }) {
    const b = ensureBot();
    for (const [k, v] of Object.entries({ x1, z1, x2, z2 })) {
      if (!Number.isFinite(Number(v))) {
        return { ok: false, error: { code: 'INVALID_COORD', message: `mc path requires numeric ${k}`, retry_safe: false } };
      }
    }
    const minX = Math.min(Number(x1), Number(x2));
    const maxX = Math.max(Number(x1), Number(x2));
    const minZ = Math.min(Number(z1), Number(z2));
    const maxZ = Math.max(Number(z1), Number(z2));
    const pathY = Number.isFinite(Number(y)) ? Number(y) : Math.floor(b.entity.position.y) - 1;

    const shovel = b.inventory.items().find((i) => /shovel/.test(i.name));
    if (!shovel) {
      return { ok: false, error: { code: 'MISSING_SHOVEL', message: 'mc path requires a shovel in inventory', retry_safe: false } };
    }
    try { await b.equip(shovel, 'hand'); } catch (e) {
      return { ok: false, error: { code: 'MISSING_SHOVEL', message: `Could not equip shovel: ${e?.message || e}`, retry_safe: true } };
    }

    const PATHABLE = new Set(['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'mycelium', 'rooted_dirt']);
    let placed = 0, skipped = 0, failed = 0, missing = 0;
    const errors = [];

    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        const block = b.blockAt(new Vec3(x, pathY, z));
        if (!block) { missing++; continue; }
        if (block.name === 'dirt_path') { skipped++; continue; }
        if (!PATHABLE.has(block.name)) { skipped++; continue; }
        // Block above must be air-like for the conversion to be visible (and the bot must reach the top face).
        const above = b.blockAt(new Vec3(x, pathY + 1, z));
        if (above && above.name !== 'air' && above.name !== 'cave_air') { skipped++; continue; }

        // Bot must NOT stand on the target block — Paper rejects activation
        // when the player's bounding box covers the top face. Move to an
        // adjacent column at the same Y if so.
        const myFootX = Math.floor(b.entity.position.x);
        const myFootZ = Math.floor(b.entity.position.z);
        const myFootY = Math.floor(b.entity.position.y) - 1;
        const standingOnTarget = myFootX === x && myFootZ === z && myFootY === pathY;
        if (standingOnTarget || b.entity.position.distanceTo(block.position) > 4.5) {
          // Find an adjacent column with a solid floor at pathY and air above.
          const candidates = [
            { dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 },
          ];
          let target = null;
          for (const c of candidates) {
            const nx = x + c.dx, nz = z + c.dz;
            const floor = b.blockAt(new Vec3(nx, pathY, nz));
            const air = b.blockAt(new Vec3(nx, pathY + 1, nz));
            if (floor && floor.name !== 'air' && air && (air.name === 'air' || air.name === 'cave_air')) {
              target = { x: nx, y: pathY + 1, z: nz }; break;
            }
          }
          if (target) {
            try { await b.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 0)); } catch {}
          } else {
            try { await b.pathfinder.goto(new goals.GoalNear(x, pathY + 1, z, 2)); } catch {}
          }
        }
        try {
          await b.activateBlock(block);
          // Block updates arrive asynchronously; poll for up to 1s.
          let after = null;
          for (let attempt = 0; attempt < 10; attempt++) {
            await sleep(100);
            after = b.blockAt(new Vec3(x, pathY, z));
            if (after && after.name === 'dirt_path') break;
          }
          if (after && after.name === 'dirt_path') placed++;
          else { failed++; errors.push(`${x},${pathY},${z}: still ${after?.name || 'unknown'}`); }
        } catch (e) {
          failed++;
          errors.push(`${x},${pathY},${z}: ${e?.message || e}`);
        }
      }
    }

    if (placed === 0 && failed === 0 && skipped > 0) {
      return {
        ok: true,
        data: { paths_placed: 0, paths_skipped: skipped, paths_failed: 0, bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ, y: pathY } },
        result: `Path: nothing to convert (${skipped} columns already path or non-dirt)`,
      };
    }

    return {
      ok: true,
      data: {
        paths_placed: placed,
        paths_skipped: skipped,
        paths_failed: failed,
        missing_blocks: missing,
        errors: errors.slice(0, 5),
        bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ, y: pathY },
      },
      result: `Path: ${placed} placed, ${skipped} skipped, ${failed} failed at Y=${pathY}`,
    };
  },

  /**
   * Dig a W×L×D pit. The pit top is at the bot's existing surface (bot Y - 1)
   * unless `top_y` is given. Capped at 256 columns × 16 depth = 4096 blocks.
   * Thin wrapper over dig_area; stair-out is a separate verb (mc build_stairs).
   */
  async dig_pit({ x, z, w, l, d, top_y }) {
    const b = ensureBot();
    for (const [k, v] of Object.entries({ x, z, w, l, d })) {
      if (!Number.isFinite(Number(v))) {
        return { ok: false, error: { code: 'INVALID_COORD', message: `mc dig_pit requires numeric ${k}`, retry_safe: false } };
      }
    }
    const cornerX = Math.floor(Number(x));
    const cornerZ = Math.floor(Number(z));
    const W = parseInt(String(w), 10);
    const L = parseInt(String(l), 10);
    const D = parseInt(String(d), 10);
    for (const [k, v] of [['w', W], ['l', L], ['d', D]]) {
      if (!Number.isFinite(v) || v < 1) {
        return { ok: false, error: { code: 'INVALID_COORD', message: `mc dig_pit requires positive integer ${k}`, retry_safe: false } };
      }
    }
    const totalBlocks = W * L * D;
    if (totalBlocks > 500) {
      return {
        ok: false,
        error: {
          code: 'OUT_OF_RANGE',
          message: `mc dig_pit ${W}×${L}×${D} = ${totalBlocks} blocks exceeds 500-block limit; split into smaller pits`,
          retry_safe: false,
        },
      };
    }

    const surfaceY = Number.isFinite(Number(top_y)) ? Math.floor(Number(top_y)) : Math.floor(b.entity.position.y) - 1;
    const x1 = cornerX, x2 = cornerX + W - 1;
    const z1 = cornerZ, z2 = cornerZ + L - 1;
    const y1 = surfaceY - D + 1, y2 = surfaceY;

    const res = await ACTIONS.dig_area({ x1, y1, z1, x2, y2, z2, pickup: true, abort_on_fail: false, clear_stand: true });
    // dig_area uses an older response shape (top-level result/dug/etc.) and may
    // return { ok: false, error: "string" }. Map both into the action contract.
    if (res && res.ok === false) {
      return {
        ok: false,
        error: {
          code: 'DIG_AREA_FAILED',
          message: typeof res.error === 'string' ? res.error : (res.error?.message || 'dig_area failed'),
          observed_state: { bounds: { x1, y1, z1, x2, y2, z2 } },
          retry_safe: false,
        },
      };
    }
    return {
      ok: true,
      data: {
        dug: Number(res?.dug || 0),
        skipped: Number(res?.skipped || 0),
        errors_count: Array.isArray(res?.errors) ? res.errors.length : 0,
        bounds: { x1, y1, z1, x2, y2, z2 },
        size: { w: W, l: L, d: D },
        floor_y: y1 - 1,
      },
      result: `dig_pit ${W}×${L}×${D} at (${cornerX}, surface=${surfaceY}, ${cornerZ}): dug ${res?.dug || 0}, skipped ${res?.skipped || 0}. Floor Y=${y1 - 1}.`,
    };
  },

  /**
   * Flatten a rectangle to target Y: dig solid blocks above Y, place a
   * fill block at Y if the column is air at that level. Touches up to
   * `up` blocks above Y (default 8). Below Y is not touched.
   */
  async level({ x1, z1, x2, z2, y, block: fillBlockName, up }) {
    const b = ensureBot();
    for (const [k, v] of Object.entries({ x1, z1, x2, z2, y })) {
      if (!Number.isFinite(Number(v))) {
        return { ok: false, error: { code: 'INVALID_COORD', message: `mc level requires numeric ${k}`, retry_safe: false } };
      }
    }
    const minX = Math.min(Number(x1), Number(x2));
    const maxX = Math.max(Number(x1), Number(x2));
    const minZ = Math.min(Number(z1), Number(z2));
    const maxZ = Math.max(Number(z1), Number(z2));
    const targetY = Math.floor(Number(y));
    const upRange = Math.min(Math.max(parseInt(String(up || 8), 10) || 8, 1), 16);
    const w = maxX - minX + 1;
    const l = maxZ - minZ + 1;
    if (w * l > 256) {
      return { ok: false, error: { code: 'OUT_OF_RANGE', message: `mc level area ${w}×${l}=${w * l} exceeds 256-column limit`, retry_safe: false } };
    }

    const isAirLike = (blk) => blk && (blk.name === 'air' || blk.name === 'cave_air' || blk.name === 'void_air');
    const fillCascade = fillBlockName ? [fillBlockName] : ['dirt', 'cobblestone', 'stone', 'cobbled_deepslate', 'deepslate'];
    const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

    let dug = 0, placed = 0, skipped = 0, failed = 0;
    const errors = [];

    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        // 1) Dig blocks above targetY (top-down so debris doesn't fall on us).
        for (let dy = upRange; dy >= 1; dy--) {
          const py = targetY + dy;
          const blk = b.blockAt(new Vec3(x, py, z));
          if (!blk || isAirLike(blk)) continue;
          if (isDigProtected(blk.name)) { skipped++; continue; }
          if (b.entity.position.distanceTo(blk.position) > 4.5) {
            try { await b.pathfinder.goto(new goals.GoalNear(x, py, z, 3)); } catch {}
          }
          try {
            await equipForDig(b, blk);
            await b.dig(blk);
            dug++;
          } catch (e) {
            failed++;
            errors.push(`dig ${x},${py},${z}: ${e?.message || e}`);
          }
        }

        // 2) Fill air at targetY with a leveling block.
        const target = b.blockAt(new Vec3(x, targetY, z));
        if (target && !isAirLike(target)) { skipped++; continue; }

        let didPlace = false;
        for (const blockName of fillCascade) {
          const item = b.inventory.items().find((it) => it.name === blockName);
          if (!item) continue;
          try { await b.equip(item, 'hand'); } catch { continue; }
          if (b.entity.position.distanceTo(new Vec3(x, targetY, z)) > 4.5) {
            try { await b.pathfinder.goto(new goals.GoalNear(x, targetY + 1, z, 3)); } catch {}
          }
          for (const [ox, oy, oz] of offsets) {
            const ref = b.blockAt(new Vec3(x + ox, targetY + oy, z + oz));
            if (ref && !isAirLike(ref) && ref.boundingBox === 'block') {
              try {
                await b.placeBlock(ref, new Vec3(-ox, -oy, -oz));
                didPlace = true;
                placed++;
                break;
              } catch { /* try next face */ }
            }
          }
          if (didPlace) break;
        }
        if (!didPlace) {
          // No fillable item in inventory — only count as failed if there was an air gap to fill.
          const present = fillCascade.some((nm) => b.inventory.items().find((it) => it.name === nm));
          if (!present) {
            return {
              ok: false,
              error: {
                code: 'MISSING_INVENTORY',
                message: `mc level: no fill block in inventory (tried ${fillCascade.join(', ')})`,
                observed_state: { dug, placed, columns_remaining: (maxX - x + 1) * l + (maxZ - z), bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ, y: targetY } },
                retry_safe: true,
              },
            };
          }
          failed++;
          errors.push(`fill ${x},${targetY},${z}: no solid neighbor`);
        }
      }
    }

    return {
      ok: true,
      data: {
        dug,
        placed,
        skipped,
        failed,
        bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ, y: targetY },
        up_range: upRange,
        errors: errors.slice(0, 5),
      },
      result: `level ${w}×${l} to Y=${targetY}: dug ${dug}, placed ${placed}${skipped ? `, ${skipped} skipped` : ''}${failed ? `, ${failed} failed` : ''}`,
    };
  },

  /**
   * Build an ascending triangular ramp of cubes the bot can climb.
   * Column i (1..LEN) is filled from the existing floor up to height i,
   * giving every block a solid face neighbor below to place against.
   * Block count grows as LEN*(LEN+1)/2 — keep LEN modest.
   */
  async build_stairs({ block: blockName, direction, length, x, y, z }) {
    const b = ensureBot();
    if (!blockName || typeof blockName !== 'string') {
      return { ok: false, error: { code: 'MISSING_BLOCK_TYPE', message: 'mc build_stairs requires a block type', retry_safe: false } };
    }
    let dirInfo;
    try { dirInfo = cardinalDelta(direction); }
    catch { return { ok: false, error: { code: 'INVALID_DIR', message: `direction must be north|south|east|west, got "${direction}"`, retry_safe: false } }; }
    const { dx, dz, key } = dirInfo;

    const L = Math.min(Math.max(parseInt(String(length), 10) || 0, 1), 16);
    const startX = Number.isFinite(Number(x)) ? Math.floor(Number(x)) : Math.floor(b.entity.position.x);
    const startY = Number.isFinite(Number(y)) ? Math.floor(Number(y)) : Math.floor(b.entity.position.y);
    const startZ = Number.isFinite(Number(z)) ? Math.floor(Number(z)) : Math.floor(b.entity.position.z);

    const isAirLike = (blk) => blk && (blk.name === 'air' || blk.name === 'cave_air' || blk.name === 'void_air');
    const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

    let placed = 0, skipped = 0, failed = 0;
    const errors = [];

    for (let i = 1; i <= L; i++) {
      const cx = startX + dx * i;
      const cz = startZ + dz * i;
      // Fill column from the existing-floor level up to height i.
      // h = 0 → placed at startY (one above existing floor), h = i-1 → top of step.
      for (let h = 0; h < i; h++) {
        const cy = startY + h;
        const target = b.blockAt(new Vec3(cx, cy, cz));
        if (target && !isAirLike(target)) {
          if (target.name === blockName) { skipped++; continue; }
          // Something else is already there — count as skipped (don't overwrite).
          skipped++; continue;
        }

        // Top of column needs head clearance (cy+1) for the bot to stand on it.
        if (h === i - 1) {
          const headBlock = b.blockAt(new Vec3(cx, cy + 1, cz));
          if (headBlock && !isAirLike(headBlock)) {
            failed++;
            errors.push(`step ${i} top: head clearance blocked by ${headBlock.name}`);
            continue;
          }
        }

        const item = b.inventory.items().find((it) => it.name === blockName);
        if (!item) {
          return {
            ok: false,
            error: {
              code: 'MISSING_INVENTORY',
              message: `Out of ${blockName} after placing ${placed} blocks (step ${i}/${L})`,
              observed_state: { blocks_placed: placed, current_step: i, total_steps: L, block: blockName },
              retry_safe: true,
            },
          };
        }
        try { await b.equip(item, 'hand'); } catch {}

        let didPlace = false;
        for (const [ox, oy, oz] of offsets) {
          const ref = b.blockAt(new Vec3(cx + ox, cy + oy, cz + oz));
          if (ref && !isAirLike(ref) && ref.boundingBox === 'block') {
            try {
              await b.placeBlock(ref, new Vec3(-ox, -oy, -oz));
              didPlace = true;
              placed++;
              break;
            } catch (e) {
              errors.push(`step ${i} h=${h}: place failed: ${e?.message || e}`);
            }
          }
        }
        if (!didPlace) {
          failed++;
          errors.push(`step ${i} h=${h}: no solid neighbor at ${cx},${cy},${cz}`);
        }
      }

      // After completing column i, walk onto the top so next column's blocks are reachable.
      try { await b.pathfinder.goto(new goals.GoalNear(cx, startY + i, cz, 0)); } catch {}
    }

    const expectedBlocks = (L * (L + 1)) / 2;
    return {
      ok: true,
      data: {
        blocks_placed: placed,
        blocks_skipped: skipped,
        blocks_failed: failed,
        expected_blocks: expectedBlocks,
        block: blockName,
        direction: key,
        length: L,
        start: { x: startX, y: startY, z: startZ },
        end: { x: startX + dx * L, y: startY + L - 1, z: startZ + dz * L },
        errors: errors.slice(0, 5),
      },
      result: `build_stairs ${key} ${L} ${blockName}: ${placed}/${expectedBlocks} blocks placed${skipped ? `, ${skipped} skipped` : ''}${failed ? `, ${failed} failed` : ''}`,
    };
  },

  /**
   * Highest solid block per vertical column — for pit/site selection without N×find_blocks.
   * Optional `radius`: square (2r+1)² around (x,z), returns max top among sampled columns.
   */
  /**
   * Hazard observation in a radius. Read-only; no movement, no digging.
   * Useful for "look before you mine" — agent runs scout, plans around
   * lava and gravity columns, then issues mc safe_dig calls.
   *
   * Args:
   *   x, y, z   — center; defaults to bot position
   *   radius    — search radius; default 8, capped at 16
   */
  async scout({ x, y, z, radius }) {
    const b = ensureBot();
    const r = Math.min(Math.max(parseInt(String(radius ?? 8), 10) || 8, 1), 16);
    const me = b.entity.position;
    const cx = Number.isFinite(Number(x)) ? Math.floor(Number(x)) : Math.floor(me.x);
    const cy = Number.isFinite(Number(y)) ? Math.floor(Number(y)) : Math.floor(me.y);
    const cz = Number.isFinite(Number(z)) ? Math.floor(Number(z)) : Math.floor(me.z);
    const center = new Vec3(cx, cy, cz);

    const lavaPositions = b.findBlocks({
      matching: (block) => block.name === 'lava' || block.name === 'flowing_lava',
      maxDistance: r,
      count: 50,
      point: center,
    });
    const waterPositions = b.findBlocks({
      matching: (block) => block.name === 'water' || block.name === 'flowing_water',
      maxDistance: r,
      count: 50,
      point: center,
    });
    const fallingPositions = b.findBlocks({
      matching: (block) => FALLING_BLOCK_NAMES.has(block.name),
      maxDistance: r,
      count: 50,
      point: center,
    });
    const bedrockPositions = b.findBlocks({
      matching: (block) => block.name === 'bedrock',
      maxDistance: r,
      count: 1,
      point: center,
    });

    const fmtPos = (p) => ({ x: p.x, y: p.y, z: p.z });
    const lava = lavaPositions.map((p) => {
      const blk = b.blockAt(p);
      const props = (typeof blk?.getProperties === 'function') ? blk.getProperties() : {};
      const level = props.level !== undefined ? Number(props.level) : 0;
      return { ...fmtPos(p), source: level === 0, dist: Math.round(p.distanceTo(center) * 10) / 10 };
    });
    const water = waterPositions.map((p) => ({ ...fmtPos(p), dist: Math.round(p.distanceTo(center) * 10) / 10 }));
    const falling = fallingPositions.map((p) => {
      const blk = b.blockAt(p);
      return { ...fmtPos(p), name: blk?.name || 'unknown', dist: Math.round(p.distanceTo(center) * 10) / 10 };
    });
    let bedrock = null;
    if (bedrockPositions.length) {
      const bp = bedrockPositions[0];
      bedrock = { ...fmtPos(bp), dist: Math.round(bp.distanceTo(center) * 10) / 10 };
    }

    // Hostile mobs — common Minecraft hostile types within the radius.
    // Known limitation: in Multiverse non-default worlds, mineflayer's
    // entity tracker may report empty even when mobs are nearby. Use
    // mc scene as a fallback when scout reports 0 hostile.
    const HOSTILE = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'pillager', 'vindicator', 'evoker', 'drowned', 'husk', 'stray', 'phantom', 'cave_spider', 'silverfish', 'endermite', 'blaze', 'ghast', 'magma_cube', 'slime', 'wither_skeleton', 'piglin', 'piglin_brute', 'zoglin', 'hoglin']);
    const hostile = [];
    for (const e of Object.values(b.entities)) {
      if (!e.position || !HOSTILE.has(e.name)) continue;
      const d = e.position.distanceTo(center);
      if (d > r) continue;
      hostile.push({ name: e.name, x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z), dist: Math.round(d * 10) / 10 });
    }
    hostile.sort((a, b) => a.dist - b.dist);

    const counts = { lava: lava.length, water: water.length, falling: falling.length, hostile: hostile.length };
    const summary = [
      counts.lava ? `${counts.lava} lava` : null,
      counts.water ? `${counts.water} water` : null,
      counts.falling ? `${counts.falling} falling-block` : null,
      counts.hostile ? `${counts.hostile} hostile (${hostile[0].name} at ${hostile[0].dist})` : null,
      bedrock ? `bedrock at ${bedrock.dist}` : null,
    ].filter(Boolean).join(', ') || 'all clear';

    return {
      ok: true,
      data: {
        center: { x: cx, y: cy, z: cz },
        radius: r,
        lava,
        water,
        falling_blocks: falling,
        bedrock,
        hostile_mobs: hostile,
        counts,
      },
      result: `Scout r=${r} from ${cx},${cy},${cz}: ${summary}`,
    };
  },

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
    safe = true,
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
        if (isDigProtected(target.name)) {
          skipped++;
          continue;
        }

        // Hazard pre-check — abort the whole op if a hazard cell is encountered.
        // Caller opts out with safe: false.
        if (safe) {
          const hazard = detectDigHazards(b, pos.x, pos.y, pos.z);
          if (hazard) {
            const code =
              hazard.kind === 'lava' ? 'HAZARD_LAVA' :
              hazard.kind === 'fall' ? 'HAZARD_FALL' :
              'HAZARD_SUFFOCATE';
            return {
              ok: false,
              error: {
                code,
                message: `dig_area aborted at ${pos.x},${pos.y},${pos.z}: ${hazard.kind} hazard. ${dug} blocks dug so far. Pass safe:false to override, or clear the hazard explicitly.`,
                observed_state: { hazard_at: { x: pos.x, y: pos.y, z: pos.z }, hazard, dug_so_far: dug, skipped_so_far: skipped },
                retry_safe: false,
              },
            };
          }
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

    let abortReason = null;
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
      // Propagate a hazard abort from dig_area instead of silently continuing.
      if (res && res.ok === false) {
        totalDug += Number(res.error?.observed_state?.dug_so_far || 0);
        totalSkipped += Number(res.error?.observed_state?.skipped_so_far || 0);
        abortReason = { slice: i, hazard: res.error };
        break;
      }
      totalDug += Number(res?.dug || 0);
      totalSkipped += Number(res?.skipped || 0);
      totalErrors += Array.isArray(res?.errors) ? res.errors.length : 0;
    }
    if (abortReason) {
      return {
        ok: false,
        error: {
          code: abortReason.hazard.code || 'HAZARD',
          message: `tunnel aborted at slice ${abortReason.slice}/${L}: ${abortReason.hazard.message}`,
          observed_state: {
            slice: abortReason.slice,
            total_slices: L,
            dug_so_far: totalDug,
            skipped_so_far: totalSkipped,
            ...(abortReason.hazard.observed_state || {}),
          },
          retry_safe: false,
        },
      };
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
    if (!block) {
      return {
        ok: false,
        error: {
          code: 'NO_BLOCK_AT_COORD',
          message: `No block at ${x}, ${y}, ${z}`,
          observed_state: { requested_coord: { x, y, z } },
          retry_safe: false,
        },
      };
    }
    // F55.3: uniform reach precheck.
    const reach = await ensureWithinReach({ bot: b, goals }, { x, y, z }, {
      range: 4.5,
      observed: { block_at_target: block.name },
    });
    if (!reach.ok) return reach;
    // F65: line-of-sight guard. Mirrors F45.3 (mc place) and F64 (chest
    // open). Bot must be able to see the target block to interact with
    // it — no opening doors through walls.
    if (typeof hasLineOfSight === 'function' && typeof eyePosition === 'function') {
      const eye = eyePosition();
      if (eye) {
        const cx = x + 0.5, cy = y + 0.5, cz = z + 0.5;
        const faces = [
          { x: cx, y: cy, z: cz - 0.48 },
          { x: cx, y: cy, z: cz + 0.48 },
          { x: cx - 0.48, y: cy, z: cz },
          { x: cx + 0.48, y: cy, z: cz },
          { x: cx, y: cy - 0.48, z: cz },
          { x: cx, y: cy + 0.48, z: cz },
          { x: cx, y: cy, z: cz },
        ];
        if (!faces.some((p) => hasLineOfSight(eye, p))) {
          return {
            ok: false,
            error: {
              code: 'NO_LINE_OF_SIGHT',
              message: `Cannot see ${block.name} at ${x},${y},${z} — a block is between you and the target.`,
              observed_state: {
                target: { x, y, z },
                block_at_target: block.name,
                bot_position: { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z },
              },
              next_action_hint: `Navigate around the obstruction; try mc goto_near ${x} ${y} ${z} range=2`,
              retry_safe: false,
            },
          };
        }
      }
    }
    await b.activateBlock(block);
    return { result: `Interacted with ${block.name} at ${x}, ${y}, ${z}` };
  },

  /**
   * Traverse a gate/door: open it, walk to the far side, close it behind.
   * Args:
   *   gx, gy, gz — gate position.
   *   dx, dy, dz — destination on the far side (optional; auto-inferred if absent).
   * Returns action contract: { ok, data:{ gate_block, opened, traversed_to, closed }, result }.
   */
  async through({ gx, gy, gz, dx, dy, dz }) {
    const b = ensureBot();
    const gateVec = new Vec3(Number(gx), Number(gy), Number(gz));
    if (![gx, gy, gz].every((v) => Number.isFinite(Number(v)))) {
      return { ok: false, error: { code: 'INVALID_COORD', message: 'mc through requires numeric gate coords', retry_safe: false } };
    }

    let gate = b.blockAt(gateVec);
    // F55.4: when the first blockAt returns air, the door may have just
    // been placed by a partner (G21 v6 case: Mason called through right
    // after Flint placed). Mineflayer's block snapshot occasionally lags
    // a tick or two behind the server. Re-fetch once after a short delay
    // before deciding it's truly absent.
    if (gate && /^(?:air|cave_air|void_air)$/.test(gate.name)) {
      await sleep(150);
      gate = b.blockAt(gateVec);
    }
    if (!gate) {
      return { ok: false, error: { code: 'GATE_NOT_FOUND', message: `No block at gate position ${gx}, ${gy}, ${gz}`, retry_safe: false } };
    }
    const isPassable = /(_fence_gate|_door|_trapdoor)$/.test(gate.name);
    if (!isPassable) {
      // F54.5: when the target isn't a door, give the brain a concrete
      // next-step. The G21 v5 case was "I dug the door's support block,
      // door fell out, now mc through fails on air" — bots looped on the
      // command instead of placing a new door. If we hold a door in
      // inventory AND the target is air, suggest the exact place call.
      // For a wall-block, suggest dig or pick a real door coord.
      const isAir = /^(?:air|cave_air|void_air)$/.test(gate.name);
      let nextActionHint = `Block is "${gate.name}", not a door. Find a real door/gate coord, or mc dig to clear an obstacle.`;
      let inventoryDoor = null;
      if (isAir) {
        const doorItem = b.inventory.items().find((it) =>
          /(_door|_fence_gate|_trapdoor)$/.test(it.name),
        );
        if (doorItem) {
          inventoryDoor = doorItem.name;
          nextActionHint = `No door at (${gx}, ${gy}, ${gz}) — block is air. You have ${doorItem.name} in inventory. Try: mc place ${doorItem.name} ${gx} ${gy} ${gz}`;
        } else {
          nextActionHint = `No door at (${gx}, ${gy}, ${gz}) — block is air. Either pick a different door/gate coord, or craft a door (mc craft oak_door) and mc place it here.`;
        }
      }
      return {
        ok: false,
        error: {
          code: 'NOT_A_DOOR',
          message: `Block at ${gx}, ${gy}, ${gz} is "${gate.name}", not a fence_gate/door/trapdoor. ${nextActionHint}`,
          observed_state: {
            block_at_target: gate.name,
            requested_coord: { x: Number(gx), y: Number(gy), z: Number(gz) },
            inventory_door: inventoryDoor,
            is_air: isAir,
          },
          next_action_hint: nextActionHint,
          retry_safe: false,
        },
      };
    }

    // Infer destination if not provided: 2 blocks past the gate, opposite side from bot.
    let destX = Number(dx), destY = Number(dy), destZ = Number(dz);
    if (![destX, destY, destZ].every(Number.isFinite)) {
      const me = b.entity.position;
      const vx = gate.position.x + 0.5 - me.x;
      const vz = gate.position.z + 0.5 - me.z;
      // Pick dominant axis; step 2 blocks past the gate in that direction.
      const stepX = Math.abs(vx) >= Math.abs(vz) ? Math.sign(vx) : 0;
      const stepZ = stepX === 0 ? Math.sign(vz) : 0;
      destX = gate.position.x + stepX * 2;
      destY = gate.position.y;
      destZ = gate.position.z + stepZ * 2;
    }

    // Approach the gate so it's reachable.
    // F55.3 + F55.4: uniform reach precheck with wallclock cap. On
    // failure, surface door_state and gate distance so the brain has
    // structured signal (not just "could not approach").
    const reach = await ensureWithinReach({ bot: b, goals }, { x: gate.position.x, y: gate.position.y, z: gate.position.z }, {
      range: 4.5,
      observed: {
        gate_pos: { x: gate.position.x, y: gate.position.y, z: gate.position.z },
        gate_block: gate.name,
        door_state: (typeof gate.getProperties === 'function') ? (gate.getProperties().open === 'true' || gate.getProperties().open === true ? 'open' : 'closed') : null,
      },
    });
    if (!reach.ok) {
      // Re-frame OUT_OF_RANGE from the reach helper as TRAVERSAL_FAILED so
      // it stays in the `mc through` contract that callers already handle.
      const inner = reach.error || {};
      return {
        ok: false,
        error: {
          code: 'TRAVERSAL_FAILED',
          message: `Could not approach gate at (${gx}, ${gy}, ${gz}): ${inner.message || 'unreachable'}`,
          observed_state: inner.observed_state || {},
          next_action_hint: inner.next_action_hint || null,
          retry_safe: true,
        },
      };
    }

    // F68: line-of-sight guard. Reach is only euclidean distance, so the
    // bot can be 4.5 blocks away with a solid wall between it and the
    // gate and still pass reach. Require LOS to at least one face of the
    // gate before activating — no opening doors/gates through walls.
    if (typeof hasLineOfSight === 'function' && typeof eyePosition === 'function') {
      const eye = eyePosition();
      if (eye) {
        const cx = gate.position.x + 0.5;
        const cy = gate.position.y + 0.5;
        const cz = gate.position.z + 0.5;
        const faces = [
          { x: cx, y: cy, z: cz - 0.48 },
          { x: cx, y: cy, z: cz + 0.48 },
          { x: cx - 0.48, y: cy, z: cz },
          { x: cx + 0.48, y: cy, z: cz },
          { x: cx, y: cy - 0.48, z: cz },
          { x: cx, y: cy + 0.48, z: cz },
          { x: cx, y: cy, z: cz },
        ];
        if (!faces.some((p) => hasLineOfSight(eye, p))) {
          return {
            ok: false,
            error: {
              code: 'NO_LINE_OF_SIGHT',
              message: `Cannot see ${gate.name} at ${gx},${gy},${gz} — a block is between you and the gate.`,
              observed_state: {
                gate: { x: gate.position.x, y: gate.position.y, z: gate.position.z },
                gate_block: gate.name,
                bot_position: { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z },
              },
              next_action_hint: `Navigate to a cell with direct sight to the gate first; mc goto_near ${gx} ${gy} ${gz} range=2`,
              retry_safe: false,
            },
          };
        }
      }
    }

    // Safety: before opening the gate, check for passive animals adjacent
    // to it. If any are within 1.5 blocks of the gate centerline, opening
    // exposes a window for them to escape through. Return ANIMAL_AT_GATE
    // and let the caller decide what to do (push them back, hunt them,
    // wait and retry).
    const passiveSpecies = new Set([
      'chicken', 'cow', 'sheep', 'pig', 'rabbit', 'horse', 'donkey',
      'mule', 'mooshroom', 'llama', 'goat',
    ]);
    const gateCenter = gate.position.offset(0.5, 0.5, 0.5);
    const blockingAnimals = Object.values(b.entities)
      .filter((e) => e && e !== b.entity && e.position && passiveSpecies.has((e.name || '').toLowerCase()))
      .filter((e) => e.position.distanceTo(gateCenter) <= 1.5);
    if (blockingAnimals.length > 0) {
      return {
        ok: false,
        error: {
          code: 'ANIMAL_AT_GATE',
          message: `Cannot open ${gate.name}: ${blockingAnimals.length} animal(s) within 1.5 blocks of the gate would escape.`,
          observed_state: {
            gate: { x: gate.position.x, y: gate.position.y, z: gate.position.z },
            blocking: blockingAnimals.map((e) => ({
              species: e.name,
              pos: [Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z)],
              distance: Number(e.position.distanceTo(gateCenter).toFixed(2)),
            })),
          },
          next_action_hint: 'Wait for animals to wander away, or push them back, then retry.',
          retry_safe: true,
        },
      };
    }

    // Open. activateBlock toggles, so check shape state first via _properties when available.
    let opened = false;
    try {
      const props = (typeof gate.getProperties === 'function') ? gate.getProperties() : {};
      const wasOpen = props.open === 'true' || props.open === true;
      if (!wasOpen) {
        await b.activateBlock(gate);
        opened = true;
      }
    } catch (e) {
      return { ok: false, error: { code: 'TRAVERSAL_FAILED', message: `Failed to open ${gate.name}: ${e?.message || e}`, retry_safe: true } };
    }

    // Walk through the gate using direct movement, NOT pathfinder.
    // Pathfinder treats closed doors as impassable and (with canDig=true) will
    // tunnel through walls/floor to bypass them — destructive and wrong here.
    // The door is right in front of us; just hold "forward" toward dest.
    try { b.pathfinder.setGoal(null); } catch {}
    const destPos = new Vec3(destX + 0.5, destY, destZ + 0.5);
    await b.lookAt(destPos);

    const traverseStart = Date.now();
    // Slightly longer than 2.5s so a step-up + walk + step-down has time.
    // F56: doors sit on raised platforms in real builds; the bot often
    // needs to jump up 1 block to enter the doorway. Detection-based
    // jump nudges handle this without flailing.
    const TRAVERSAL_TIMEOUT_MS = 3500;
    let crossedGate = false;
    let reached = false;
    b.setControlState('forward', true);
    let lastPos = { x: b.entity.position.x, z: b.entity.position.z };
    let stallStart = 0;
    let jumpUntil = 0;
    try {
      while (Date.now() - traverseStart < TRAVERSAL_TIMEOUT_MS) {
        await sleep(100);
        const now = Date.now();
        const me = b.entity.position;
        const dist = me.distanceTo(destPos);
        // Detect when we've crossed the gate plane (so we can close it after).
        if (!crossedGate) {
          const sx = Math.sign(destX - me.x);
          const sz = Math.sign(destZ - me.z);
          const passedX = Math.abs(sx) > 0.01 ? (sx > 0 ? me.x > gate.position.x + 0.5 : me.x < gate.position.x + 0.5) : true;
          const passedZ = Math.abs(sz) > 0.01 ? (sz > 0 ? me.z > gate.position.z + 0.5 : me.z < gate.position.z + 0.5) : true;
          if (passedX && passedZ) crossedGate = true;
        }
        if (dist < 1.0) { reached = true; break; }

        // F56: stall + jump-nudge. If bot's XZ has barely changed over
        // 250ms, it's collided with the doorframe / platform edge.
        // Trigger a 400ms jump pulse to step up 1 block. Repeat at most
        // every 600ms to avoid jump-spam.
        const dx = me.x - lastPos.x;
        const dz = me.z - lastPos.z;
        const moved = Math.hypot(dx, dz);
        if (moved < 0.05) {
          if (stallStart === 0) stallStart = now;
          else if (now - stallStart >= 250 && now >= jumpUntil) {
            b.setControlState('jump', true);
            jumpUntil = now + 600;
            stallStart = 0;
          }
        } else {
          stallStart = 0;
        }
        if (now >= jumpUntil) {
          try { b.setControlState('jump', false); } catch { /* ignore */ }
        }
        lastPos = { x: me.x, z: me.z };
      }
    } finally {
      b.setControlState('forward', false);
      try { b.setControlState('jump', false); } catch { /* ignore */ }
    }

    if (!reached) {
      // Try to close gate before returning the failure (best-effort).
      try { const g2 = b.blockAt(gateVec); if (g2) await b.activateBlock(g2); } catch {}
      const me = b.entity.position;
      return {
        ok: false,
        error: {
          code: 'TRAVERSAL_FAILED',
          message: `Opened ${gate.name} but bot stalled at ${me.x.toFixed(1)},${me.y.toFixed(1)},${me.z.toFixed(1)} (target ${destX},${destY},${destZ}). The doorway may be obstructed or the destination wrong.`,
          observed_state: { gate_block: gate.name, opened, crossed_gate: crossedGate, current: { x: me.x, y: me.y, z: me.z }, dest: { x: destX, y: destY, z: destZ } },
          retry_safe: true,
        },
      };
    }

    // Close behind. Re-fetch the block (state may have changed).
    let closed = false;
    try {
      const after = b.blockAt(gateVec);
      if (after) {
        const props = (typeof after.getProperties === 'function') ? after.getProperties() : {};
        const isOpen = props.open === 'true' || props.open === true;
        if (isOpen) {
          // We may be slightly out of activate range; turn back briefly if so.
          if (b.entity.position.distanceTo(after.position) > 4.5) {
            await b.lookAt(after.position.offset(0.5, 0.5, 0.5));
          }
          await b.activateBlock(after);
          closed = true;
        }
      }
    } catch {
      // Non-fatal: traversal succeeded; closing is best-effort.
    }

    return {
      ok: true,
      data: {
        gate_block: gate.name,
        gate_position: { x: gate.position.x, y: gate.position.y, z: gate.position.z },
        opened,
        traversed_to: { x: destX, y: destY, z: destZ },
        closed,
      },
      result: `Through ${gate.name} at ${gate.position.x},${gate.position.y},${gate.position.z}: ${opened ? 'opened' : 'already open'}, walked to ${destX},${destY},${destZ}, ${closed ? 'closed' : 'left open'}`,
    };
  },

  async close_screen() {
    const b = ensureBot();
    if (b.currentWindow) b.closeWindow(b.currentWindow);
    return { result: 'Closed screen.' };
  },

  // ── Utility ──────────────────────────────────────
  async chat({ message }) {
    const b = ensureBot();
    // F59: chat rate limiter. G26 showed bots emitting 4-6 chat lines in a
    // single burst (within 200ms of each other), faster than partners
    // could read or respond. We auto-sleep to enforce a minimum interval
    // between sent chats. This is transparent — the brain still calls
    // `mc chat "..."` and gets ok=true; it just takes a bit longer when
    // the bot is chatting rapidly. Override with MC_CHAT_MIN_INTERVAL_MS
    // env var if needed.
    const MIN_INTERVAL_MS = Number(process.env.MC_CHAT_MIN_INTERVAL_MS) || 2500;
    if (ctx) {
      const now = Date.now();
      const elapsed = now - (ctx.lastChatTs || 0);
      if (elapsed < MIN_INTERVAL_MS) {
        const wait = MIN_INTERVAL_MS - elapsed;
        await new Promise((r) => setTimeout(r, wait));
      }
      ctx.lastChatTs = Date.now();
    }
    b.chat(message);
    // Mineflayer's 'chat' event early-returns on the bot's own username, so
    // self-sent messages never reach ctx.chatLog via the normal handler.
    // That's invisible in 2-bot tests (the other bot sees you) but breaks
    // solo-bot tests where the orchestrator polls THIS bot's /chat endpoint
    // for keyword acks. Echo it back here so /chat reflects what we said.
    if (ctx) {
      ctx.chatLog.push({
        time: Date.now(),
        from: getMyName(),
        message,
        private: false,
        channel: 'public',
        self: true,
      });
      if (ctx.chatLog.length > ctx.MAX_LOG) ctx.chatLog.shift();
    }
    rememberSocialEvent({ actor: getMyName(), kind: 'sent', channel: 'public', message });
    return { result: `Sent: ${message}` };
  },

  async wait({ seconds = 5, until_mention, until_direct, interrupt }) {
    const b = ensureBot();
    const cap = Math.min(Number(seconds) || 5, 60) * 1000;
    // F55.5: opt-out via `interrupt=false` (or both flags false). Default
    // is to interrupt on @-mention or direct/whisper — see G21 v6 finding
    // that bots couldn't coordinate because chat arrived during waits.
    const optOut = interrupt === false || interrupt === 'false';
    const wantMention = !optOut && (until_mention === undefined || until_mention === true || until_mention === 'true');
    const wantDirect = !optOut && (until_direct === undefined || until_direct === true || until_direct === 'true');
    const start = Date.now();
    const myName = String(b.username || '').toLowerCase();
    const chatLogLenAtStart = (ctx.chatLog || []).length;
    if (!wantMention && !wantDirect) {
      await sleep(cap);
      return { result: `Waited ${Math.round(cap / 100) / 10}s`, data: { interrupted: false, elapsed_s: Math.round(cap / 100) / 10 } };
    }
    while (Date.now() - start < cap) {
      await sleep(250);
      const log = ctx.chatLog || [];
      if (log.length <= chatLogLenAtStart) continue;
      for (let i = chatLogLenAtStart; i < log.length; i++) {
        const m = log[i];
        if (!m || m.from === b.username || m.from === 'Server') continue;
        const msg = String(m.message || '').toLowerCase();
        const isMention = wantMention && myName && (msg.includes(`@${myName}`) || msg.includes(`${myName}:`) || msg.includes(`${myName},`));
        const isDirect = wantDirect && (m.private === true || m.whisper === true);
        if (isMention || isDirect) {
          const elapsed_s = Math.round((Date.now() - start) / 100) / 10;
          return {
            result: `Wait interrupted by chat after ${elapsed_s}s — ${m.from}: ${m.message}`,
            data: {
              interrupted: true,
              by: m.from,
              message: m.message,
              elapsed_s,
              reason: isMention ? 'mention' : 'direct',
            },
          };
        }
      }
    }
    const elapsed_s = Math.round((Date.now() - start) / 100) / 10;
    return { result: `Waited ${elapsed_s}s`, data: { interrupted: false, elapsed_s } };
  },

  async use() {
    const b = ensureBot();
    await b.activateItem();
    return { result: `Used ${b.heldItem?.name || 'hand'}` };
  },

  /**
   * Swim up to the water surface. Holds jump (swim-up while submerged) until
   * the bot's head is in air or 30s elapse. Used to escape water columns the
   * bot pours on itself (G9 scenario). No-op if the bot isn't in water.
   */
  async surface() {
    const b = ensureBot();
    if (!b.entity.isInWater) {
      return { result: `Not in water — already at surface.`, data: { in_water: false } };
    }
    const start = Date.now();
    const startY = b.entity.position.y;
    let ticks = 0;
    try {
      b.setControlState('jump', true);
      // Tick loop: every 200ms check if head is out of water. Bound to 30s.
      while (Date.now() - start < 30000) {
        await sleep(200);
        ticks++;
        // Mineflayer caches isInWater on the entity object, updated each
        // physics tick. Check the EYE level too — head out of water = surfaced.
        const eyePos = b.entity.position.offset(0, 1.62, 0);
        const eyeBlock = b.blockAt(eyePos.floored());
        const surfaced = !b.entity.isInWater || (eyeBlock && eyeBlock.name !== 'water');
        if (surfaced) break;
      }
    } finally {
      b.setControlState('jump', false);
    }
    const endY = b.entity.position.y;
    return {
      result: `Surfaced from y=${startY.toFixed(1)} to y=${endY.toFixed(1)} in ${ticks * 0.2}s.`,
      data: { start_y: startY, end_y: endY, ticks, in_water: !!b.entity.isInWater },
    };
  },

  /**
   * Fill an empty bucket from a water/lava source block at (x,y,z).
   * ── Phase-2 action contract (Sprint 7) ──
   *   MISSING_BUCKET   no empty bucket in inventory
   *   NOT_A_LIQUID     target block isn't water/lava
   *   NOT_A_SOURCE     target is flowing (level > 0), not a source
   *   OUT_OF_RANGE     bot couldn't reach within 4.5 blocks
   *   UNCHANGED        server rejected — inventory delta is zero
   */
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

    const targetPos = new Vec3(x, y, z);
    const target = b.blockAt(targetPos);
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
        await b.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
      } catch {
        return { ok: false, error: {
          code: 'OUT_OF_RANGE',
          message: `Target at (${x}, ${y}, ${z}) is ${Math.round(b.entity.position.distanceTo(targetPos) * 10) / 10} blocks away and pathfind failed.`,
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
        const r3 = await executeServerCommand(pmcp, `execute in landfolk-test run setblock ${x} ${y} ${z} minecraft:air`);
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
        source_coord: { x, y, z },
        started_inventory: before,
        ended_inventory: after,
        ...(fallback ? { fallback } : {}),
      },
      result: fallback
        ? `Filled ${liquidName} from ${target.name} at ${x},${y},${z} (server-side fallback).`
        : `Filled ${liquidName} from ${target.name} at ${x},${y},${z}.`,
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
    const existing = b.blockAt(targetPos);
    const REPLACEABLE = new Set([
      'air', 'cave_air', 'void_air',
      'tall_grass', 'short_grass', 'grass', 'fern', 'large_fern',
      'vine', 'snow', 'snow_layer', 'fire', 'soul_fire',
      'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'dead_bush',
    ]);
    const oppositeLiquid = liquid === 'water' ? 'lava' : 'water';
    // Pouring opposite liquid IS the test case for the seal/cobble/obsidian
    // reaction — treat as a valid target. Otherwise enforce replaceable.
    if (existing && !REPLACEABLE.has(existing.name) && existing.name !== oppositeLiquid) {
      return { ok: false, error: {
        code: 'BLOCKED',
        message: `Target (${x}, ${y}, ${z}) is ${existing.name}, not replaceable. Dig it first.`,
        observed_state: { target_block: existing.name, requested_coord: { x, y, z } },
        next_action_hint: `mc dig ${x} ${y} ${z}`,
        retry_safe: false,
      }};
    }

    // Find a solid OR fluid neighbor to anchor the activateBlock call.
    // Fluid neighbors are acceptable because in MC you can right-click on
    // a lava/water face to place a bucket's liquid in the adjacent cell.
    const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    let refBlock = null;
    let refOffset = null;
    for (const [dx, dy, dz] of offsets) {
      const nb = b.blockAt(targetPos.offset(dx, dy, dz));
      if (nb && (nb.boundingBox === 'block' || nb.name === 'water' || nb.name === 'lava')) {
        refBlock = nb;
        refOffset = [dx, dy, dz];
        break;
      }
    }
    if (!refBlock) {
      return { ok: false, error: {
        code: 'BLOCKED',
        message: `Target (${x}, ${y}, ${z}) has no solid or fluid neighbor — bucket placement needs a face to click on.`,
        observed_state: { requested_coord: { x, y, z } },
        retry_safe: false,
      }};
    }

    if (b.entity.position.distanceTo(targetPos) > 4.5) {
      try {
        await b.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
      } catch {
        return { ok: false, error: {
          code: 'OUT_OF_RANGE',
          message: `Target at (${x}, ${y}, ${z}) is ${Math.round(b.entity.position.distanceTo(targetPos) * 10) / 10} blocks away and pathfind failed.`,
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
        const r3 = await executeServerCommand(pmcp, `execute in landfolk-test run setblock ${x} ${y} ${z} minecraft:${placedBlock}`);
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
        message: `bucket_empty did not place ${liquid} at (${x}, ${y}, ${z}); block is ${placed?.name ?? 'unloaded'}.`,
        observed_state: { target_block_after: placed?.name ?? null, started_inventory: before, ended_inventory: after, fallback_attempted: !!paperMcpConfig() },
        retry_safe: true,
      }};
    }
    return {
      ok: true,
      data: {
        emptied: filled.name,
        placed_block: placed.name,
        target_coord: { x, y, z },
        reacted: liquidReacted ? placed.name : null,
        started_inventory: before,
        ended_inventory: after,
        ...(fallback ? { fallback } : {}),
      },
      result: liquidReacted
        ? `Emptied ${filled.name} — water/lava reaction produced ${placed.name} at ${x},${y},${z}${fallback ? ' (server-side fallback)' : ''}.`
        : `Emptied ${filled.name} — ${liquid} placed at ${x},${y},${z}${fallback ? ' (server-side fallback)' : ''}.`,
    };
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
  // F55.6: route addressed messages through public chat with @<player>
  // prefix. The /msg private system on Paper doesn't reliably surface to
  // mineflayer chat listeners — partner bots missed Flint's "roof done"
  // whisper in G21 v6. Public @-mention is captured by the standard chat
  // log AND triggers F55.5's wait-interrupt. Same behavior for chat_to
  // and whisper — both are "address one player".
  async chat_to({ player, message }) {
    const b = ensureBot();
    const text = `@${player} ${message}`;
    // F59 rate limit (shared budget with mc chat — these all emit to the
    // same public chat channel).
    const MIN_INTERVAL_MS = Number(process.env.MC_CHAT_MIN_INTERVAL_MS) || 2500;
    if (ctx) {
      const elapsed = Date.now() - (ctx.lastChatTs || 0);
      if (elapsed < MIN_INTERVAL_MS) await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - elapsed));
      ctx.lastChatTs = Date.now();
    }
    b.chat(text);
    if (ctx) {
      ctx.chatLog.push({
        time: Date.now(), from: getMyName(), message: text,
        private: false, channel: 'public', self: true,
      });
      if (ctx.chatLog.length > ctx.MAX_LOG) ctx.chatLog.shift();
    }
    rememberSocialEvent({ actor: getMyName(), target: player, kind: 'sent', channel: 'public_mention', message: text });
    return { result: `[@${player}]: ${message}` };
  },

  async whisper({ player, message }) {
    const b = ensureBot();
    const text = `@${player} ${message}`;
    const MIN_INTERVAL_MS = Number(process.env.MC_CHAT_MIN_INTERVAL_MS) || 2500;
    if (ctx) {
      const elapsed = Date.now() - (ctx.lastChatTs || 0);
      if (elapsed < MIN_INTERVAL_MS) await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - elapsed));
      ctx.lastChatTs = Date.now();
    }
    b.chat(text);
    if (ctx) {
      ctx.chatLog.push({
        time: Date.now(), from: getMyName(), message: text,
        private: false, channel: 'public', self: true,
      });
      if (ctx.chatLog.length > ctx.MAX_LOG) ctx.chatLog.shift();
    }
    rememberSocialEvent({ actor: getMyName(), target: player, kind: 'sent', channel: 'public_mention', message: text });
    return { result: `[@${player}]: ${message}` };
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

  /**
   * Enclosure test: can the bot pathfind OUT of its current position?
   * Pathfinding is symmetric — if the bot can walk out, mobs can walk in.
   * Uses the same non-destructive movements pathfinder normally uses
   * (closed doors/gates count as walls; fences are 1.5 tall so pathfinder
   * treats them as impassable).
   *
   * Tests several distant cardinal+vertical targets. If ANY succeeds, the
   * bot is NOT fully enclosed — returns the first leak's exit cell
   * (the first block the path would walk into, i.e. the gap).
   *
   * Use after building a shelter to verify it's actually sealed before
   * settling in for the night.
   */
  /**
   * F48: Reachability pre-flight. Given a target cell, report whether
   * the bot could physically STAND there (foot air, head air, ground
   * solid below). If not, find the closest cell that IS standable and
   * report its coords + distance + the reason the original cell failed.
   *
   * This is the cure for the G21 v2 Mason stuck pattern: `goto_near`
   * was failing on a cell whose head was a wall block, and the bot
   * had no signal about which nearby cell DID work. After F48 the
   * brain can just call `mc reachable X Y Z` first and pick the
   * suggested `best_stand` for the actual goto.
   *
   * Note: this is geometry-only — does NOT verify a PATH exists from
   * the bot's current position. A cell can be standable but cut off
   * by walls. For path verification, follow up with the actual `goto`.
   */
  async reachable({ x, y, z, range = 3 }) {
    const b = ensureBot();
    if (![x, y, z].every((v) => Number.isFinite(Number(v)))) {
      return {
        ok: false,
        error: {
          code: 'INVALID_COORD',
          message: 'mc reachable requires numeric x, y, z',
          retry_safe: false,
        },
      };
    }
    const ix = Math.floor(Number(x));
    const iy = Math.floor(Number(y));
    const iz = Math.floor(Number(z));
    const maxScan = Math.max(1, Math.min(6, Number(range) || 3));
    const target_reason = standabilityReason(b, ix, iy, iz);
    const target_standable = target_reason === 'ok';
    const best = findClosestStandable(b, ix, iy, iz, maxScan);

    let resultMsg;
    if (target_standable) {
      resultMsg = `Cell ${ix},${iy},${iz} is standable.`;
    } else if (best) {
      resultMsg = `Cell ${ix},${iy},${iz} is NOT standable (${target_reason}). Closest standable cell: ${best.x},${best.y},${best.z} (distance ${best.distance}).`;
    } else {
      resultMsg = `Cell ${ix},${iy},${iz} is NOT standable (${target_reason}), and no standable cell within range ${maxScan}.`;
    }

    return {
      ok: true,
      data: {
        target: { x: ix, y: iy, z: iz },
        target_standable,
        target_reason,
        best_stand: best ? { x: best.x, y: best.y, z: best.z, distance: best.distance } : null,
        bot_position: posObj(b.entity.position),
        scan_range: maxScan,
      },
      result: resultMsg,
    };
  },

  /**
   * F50.1: Classify the bot's current standing state. Returns the
   * classification ({open, alley, corner, trapped, three_walled,
   * enclosure_inside, wedge, edge, in_air}), the blocked/open cardinal
   * directions, and supporting detail (head_blocked, foot_support,
   * ceiling_within, wedge_offset). Building block for F50.2-50.8 — used
   * both internally (to enrich movement errors and decide escape
   * strategy) and externally (`mc standing` lets the brain self-check
   * before issuing a goto / place that's likely to fail).
   */
  async standing() {
    const b = ensureBot();
    const s = standingState(b);
    if (s.error === 'no_bot') {
      return { ok: false, error: { code: 'NO_BOT', message: 'bot not ready', retry_safe: true } };
    }
    const resultMsg = `${s.classification} at ${s.cell.x},${s.cell.y},${s.cell.z} — blocked: [${s.blocked_dirs.join(',') || '-'}] open: [${s.open_dirs.join(',') || '-'}]${s.cliff_dirs.length ? ` cliff: [${s.cliff_dirs.join(',')}]` : ''}${s.head_blocked ? ' head_blocked' : ''}${s.foot_support === false ? ' no_foot_support' : ''}${s.ceiling_within !== null ? ` ceiling_at_+${s.ceiling_within}` : ''}`;
    return { ok: true, data: s, result: resultMsg };
  },

  /**
   * F53.3: mc escape — "get me unstuck" primitive. Reads the standing-state
   * classifier and picks a recovery strategy:
   *   corner / three_walled / wedge → sidestep to the most-open dir
   *   trapped (4 walls, no ceiling)  → pillar up with held cobble / dirt
   *   edge                            → step away from cliff
   *   in_air                          → wait briefly (let physics settle)
   *   enclosure_inside                → return error (defer to mc dig)
   *   open / alley                    → no-op success
   *
   * Returns {action_taken, from, to, classification_before, classification_after, success}.
   * Brain can call this proactively when it sees a sticky standing state,
   * or after MOVEMENT_PRECONDITION_FAILED to recover.
   */
  async escape() {
    const b = ensureBot();
    const before = standingState(b);
    if (before.error === 'no_bot') {
      return { ok: false, error: { code: 'NO_BOT', message: 'bot not ready', retry_safe: true } };
    }
    const cls = before.classification;
    const cell = before.cell;
    const fromPos = { ...before.position };

    // F57.1 — escape-loop detector. If the brain has been hammering
    // mc escape because every subsequent attempt re-traps the bot, calling
    // escape a 3rd time inside 90s tells us the terrain (or the brain's
    // plan) keeps routing back to the same trap. Surface a strong error
    // pointing at root-cause options instead of doing another sidestep.
    const ESCAPE_LOOP_WINDOW_MS = 90_000;
    const recentEscapes = Array.isArray(ctx?.recentEscapes) ? ctx.recentEscapes : [];
    const cutoff = Date.now() - ESCAPE_LOOP_WINDOW_MS;
    const recent = recentEscapes.filter(e => e.ts > cutoff);
    if (cls !== 'open' && cls !== 'alley' && recent.length >= 2) {
      const lastFailed = ctx?.lastMoveFailed?.intended_target || null;
      const ages = recent.map(e => Math.round((Date.now() - e.ts) / 100) / 10);
      return {
        ok: false,
        error: {
          code: 'ESCAPE_RECURRING_LOOP',
          message: `mc escape called ${recent.length + 1}× in last ${ESCAPE_LOOP_WINDOW_MS / 1000}s — terrain or plan is re-trapping you (current: ${cls} at ${cell.x},${cell.y},${cell.z}). Don't escape-spam. Options: (a) mc dig at the wall/lip that keeps trapping you (mc inspect <neighbor> to identify it), (b) mc go_mark to a known-safe coord and approach the original target from a different side, (c) ask your partner for help.${lastFailed ? ` Stop retrying mc goto ${lastFailed.x} ${lastFailed.y} ${lastFailed.z} — pick a different destination.` : ''}`,
          observed_state: {
            classification: cls,
            blocked_dirs: before.blocked_dirs,
            open_dirs: before.open_dirs,
            recent_escape_ages_s: ages,
            do_not_retry_goto: lastFailed,
            your_cell: cell,
          },
          next_action_hint: lastFailed
            ? `mc inspect ${lastFailed.x} ${lastFailed.y} ${lastFailed.z}`
            : `mc inspect ${cell.x} ${cell.y} ${cell.z}`,
          retry_safe: false,
        },
      };
    }

    // Trivial: already free.
    if (cls === 'open' || cls === 'alley') {
      return {
        ok: true,
        data: { action_taken: 'none', from: fromPos, to: fromPos, classification_before: cls, classification_after: cls, success: true },
        result: `Already ${cls} at ${cell.x},${cell.y},${cell.z} — no escape needed.`,
      };
    }

    // F57.1 + F57.2 success bookkeeping. Push the pre-escape cell into
    // the stuck-cell registry (so pathfind preflight blackballs it on
    // any subsequent goto whose target lands within 1 of it) and append
    // to recentEscapes for the loop detector.
    const recordEscapeSuccess = (resp) => {
      if (ctx) {
        if (!Array.isArray(ctx.recentStuckCells)) ctx.recentStuckCells = [];
        const cx = cell.x, cy = cell.y, cz = cell.z;
        const existing = ctx.recentStuckCells.find(e => e.cell.x === cx && e.cell.y === cy && e.cell.z === cz);
        if (existing) { existing.ts = Date.now(); existing.hit_count += 1; }
        else {
          ctx.recentStuckCells.push({ ts: Date.now(), cell: { x: cx, y: cy, z: cz }, source: 'escape', hit_count: 1 });
          if (ctx.recentStuckCells.length > 12) ctx.recentStuckCells.shift();
        }
        if (!Array.isArray(ctx.recentEscapes)) ctx.recentEscapes = [];
        ctx.recentEscapes.push({ ts: Date.now(), cell: { x: cx, y: cy, z: cz }, classification_before: cls });
        if (ctx.recentEscapes.length > 6) ctx.recentEscapes.shift();
      }
      // Surface do_not_retry_goto on success too — telling the brain to
      // plan a fresh approach instead of re-firing the failed coord.
      const lastFailed = ctx?.lastMoveFailed?.intended_target || null;
      if (lastFailed && resp?.data && typeof resp.data === 'object') {
        resp.data.do_not_retry_goto = lastFailed;
      }
      return resp;
    };

    // Wait out airborne state.
    if (cls === 'in_air') {
      await new Promise(r => setTimeout(r, 600));
      const after = standingState(b);
      return recordEscapeSuccess({
        ok: true,
        data: { action_taken: 'wait_for_landing', from: fromPos, to: after.position, classification_before: cls, classification_after: after.classification, success: after.classification !== 'in_air' },
        result: `Waited 600ms for physics; now ${after.classification} at ${after.cell.x},${after.cell.y},${after.cell.z}.`,
      });
    }

    // Sidestep for corner/three_walled/wedge/edge.
    if (cls === 'corner' || cls === 'three_walled' || cls === 'wedge' || cls === 'edge') {
      const DIR_VEC = {
        N: { dx: 0, dz: -1 }, E: { dx: 1, dz: 0 }, S: { dx: 0, dz: 1 }, W: { dx: -1, dz: 0 },
      };
      const candidates = before.open_dirs.filter(d => DIR_VEC[d]);
      if (candidates.length === 0) {
        return {
          ok: false,
          error: {
            code: 'ESCAPE_NO_OPEN_DIR',
            message: `Classified ${cls} but no open cardinal direction to sidestep into. Try mc dig to break out, or mc inspect neighbors.`,
            observed_state: { classification: cls, blocked_dirs: before.blocked_dirs, cliff_dirs: before.cliff_dirs },
            retry_safe: false,
          },
        };
      }
      // F56: try EACH open direction in order (was just the first). Each
      // attempt gets a tight 1.2s pathfinder cap. After each, re-classify;
      // bail out as soon as we reach open/alley. If pathfinder fails ALL
      // directions, fall through to a brute-force jump+forward sweep —
      // catches the 0.3-block-ledge / door-frame-stub geometry that
      // pathfinder mis-models.
      const attempts = [];
      for (const pickDir of candidates) {
        const v = DIR_VEC[pickDir];
        const targetCell = { x: cell.x + v.dx, y: cell.y, z: cell.z + v.dz };
        try {
          const goal = new goals.GoalBlock(targetCell.x, targetCell.y, targetCell.z);
          await Promise.race([
            b.pathfinder.goto(goal),
            new Promise((_, rej) => setTimeout(() => rej(new Error('sidestep_to')), 1200)),
          ]);
        } catch {
          try { b.pathfinder.setGoal(null); } catch {}
        }
        const intermediate = standingState(b);
        attempts.push({ dir: pickDir, after: intermediate.classification });
        if (intermediate.classification === 'open' || intermediate.classification === 'alley') {
          return recordEscapeSuccess({
            ok: true,
            data: {
              action_taken: `sidestep_${pickDir}`,
              from: fromPos,
              to: intermediate.position,
              classification_before: cls,
              classification_after: intermediate.classification,
              attempts,
              success: true,
            },
            result: `Sidestepped ${pickDir} from ${cls} cell. Now ${intermediate.classification} at ${intermediate.cell.x},${intermediate.cell.y},${intermediate.cell.z}.`,
          });
        }
      }
      // Pathfinder failed every direction. Brute-force fallback: face each
      // open dir and burst forward+jump for 400ms. Mineflayer-pathfinder
      // can't model the "step over a 0.3-block-tall door-frame stub" case,
      // but the bot's physics can usually carry it across with a jump.
      for (const pickDir of candidates) {
        const v = DIR_VEC[pickDir];
        try {
          await b.lookAt(new Vec3(cell.x + 0.5 + v.dx * 1.5, cell.y + 1.62, cell.z + 0.5 + v.dz * 1.5));
          b.setControlState('forward', true);
          b.setControlState('jump', true);
          await new Promise(r => setTimeout(r, 450));
          b.setControlState('forward', false);
          b.setControlState('jump', false);
          await new Promise(r => setTimeout(r, 150));
        } catch {
          try { b.setControlState('forward', false); b.setControlState('jump', false); } catch {}
        }
        const intermediate = standingState(b);
        attempts.push({ dir: pickDir, after: intermediate.classification, mode: 'burst' });
        if (intermediate.classification === 'open' || intermediate.classification === 'alley') {
          return recordEscapeSuccess({
            ok: true,
            data: {
              action_taken: `burst_${pickDir}`,
              from: fromPos,
              to: intermediate.position,
              classification_before: cls,
              classification_after: intermediate.classification,
              attempts,
              success: true,
            },
            result: `Brute-force burst ${pickDir} from ${cls} cell. Now ${intermediate.classification} at ${intermediate.cell.x},${intermediate.cell.y},${intermediate.cell.z}.`,
          });
        }
      }
      // Nothing worked. Report the final state with the full attempt
      // breakdown so the brain knows escape exhausted its options.
      const after = standingState(b);
      return {
        ok: false,
        error: {
          code: 'ESCAPE_STUCK',
          message: `Tried ${attempts.length} sidestep + burst attempt(s); still ${after.classification} at ${after.cell.x},${after.cell.y},${after.cell.z}. Dig a wall (mc dig) or pick a different angle (mc move).`,
          observed_state: {
            classification_before: cls,
            classification_after: after.classification,
            attempts,
            blocked_dirs: after.blocked_dirs,
            open_dirs: after.open_dirs,
            bot_position: after.position,
          },
          retry_safe: false,
        },
      };
    }

    // Trapped: pillar up if no ceiling, else fail (brain should mc dig).
    if (cls === 'trapped') {
      if (before.ceiling_within !== null && before.ceiling_within <= 2) {
        return {
          ok: false,
          error: {
            code: 'ESCAPE_CEILING_BLOCKED',
            message: `Trapped with ceiling at +${before.ceiling_within}. Cannot pillar up — mc dig the ceiling or a wall first.`,
            observed_state: { classification: cls, ceiling_within: before.ceiling_within, blocked_dirs: before.blocked_dirs },
            retry_safe: false,
          },
        };
      }
      // Look for a placeable pillar block in inventory (cobblestone, dirt,
      // stone, cobbled_deepslate, anything generic & cheap).
      const PILLAR_BLOCKS = ['cobblestone', 'dirt', 'stone', 'cobbled_deepslate', 'granite', 'andesite', 'diorite', 'netherrack'];
      const item = b.inventory.items().find(it => PILLAR_BLOCKS.includes(it.name));
      if (!item) {
        return {
          ok: false,
          error: {
            code: 'ESCAPE_NO_PILLAR_BLOCK',
            message: `Trapped and no pillar block (cobblestone/dirt/stone) in inventory. Get one of: ${PILLAR_BLOCKS.join(', ')}. Or mc dig a wall.`,
            observed_state: { classification: cls, blocked_dirs: before.blocked_dirs },
            retry_safe: false,
          },
        };
      }
      try {
        await b.equip(item, 'hand');
        // Look down and jump-place: stand at current cell, look at the block
        // directly below, jump, place. Mineflayer doesn't have a built-in
        // pillar, so we do it manually.
        const groundPos = new Vec3(cell.x, cell.y - 1, cell.z);
        const groundBlock = b.blockAt(groundPos);
        if (!groundBlock || groundBlock.boundingBox !== 'block') {
          return {
            ok: false,
            error: {
              code: 'ESCAPE_NO_GROUND',
              message: `No solid block below to pillar from. mc dig or jump to a solid spot first.`,
              observed_state: { classification: cls },
              retry_safe: true,
            },
          };
        }
        await b.lookAt(groundPos.offset(0.5, 0.5, 0.5));
        b.setControlState('jump', true);
        await new Promise(r => setTimeout(r, 250));
        try {
          await b.placeBlock(groundBlock, new Vec3(0, 1, 0));
        } catch (e) {
          // ignore place errors here; physics may have caught up
        }
        b.setControlState('jump', false);
        await new Promise(r => setTimeout(r, 500));
        const after = standingState(b);
        return recordEscapeSuccess({
          ok: true,
          data: {
            action_taken: `pillar_up_${item.name}`,
            from: fromPos,
            to: after.position,
            classification_before: cls,
            classification_after: after.classification,
            success: after.cell.y > cell.y,
          },
          result: `Pillared up with ${item.name}. Now ${after.classification} at ${after.cell.x},${after.cell.y},${after.cell.z}.`,
        });
      } catch (e) {
        return {
          ok: false,
          error: {
            code: 'ESCAPE_PILLAR_FAILED',
            message: `Pillar-up failed: ${e?.message || String(e)}. Try mc dig instead.`,
            observed_state: { classification: cls },
            retry_safe: true,
          },
        };
      }
    }

    // enclosure_inside: defer — brain should use mc dig to break out, or
    // navigate to the door slot if there is one.
    if (cls === 'enclosure_inside') {
      return {
        ok: false,
        error: {
          code: 'ESCAPE_ENCLOSURE',
          message: `You're inside a built structure (walls in all 4 dirs within 4 cells, ceiling within 4 cells). Use mc dig to break a wall, or mc move to a door slot if one exists. mc escape can't solve this case (yet).`,
          observed_state: { classification: cls, blocked_dirs: before.blocked_dirs, ceiling_within: before.ceiling_within },
          retry_safe: false,
        },
      };
    }

    // Fallback for unknown classification.
    return {
      ok: false,
      error: {
        code: 'ESCAPE_UNHANDLED',
        message: `No escape strategy for classification "${cls}". Try mc dig or mc move.`,
        observed_state: before,
        retry_safe: false,
      },
    };
  },

  /**
   * F53.4: mc find <resource> — unified resource finder. Aggregates sources
   * the bot already has access to, so it doesn't run off to mine a thing
   * that's already in its inventory or in a known chest.
   *
   * Sources scanned (in order of "cheapness"):
   *   1. inventory   — items in the bot's own inventory (free, count only)
   *   2. chest       — chest snapshots populated by prior list/deposit/
   *                    withdraw calls (cheap; needs prior knowledge)
   *   3. block       — visible blocks of that name within scan_range
   *                    (medium; requires walking + digging)
   *
   * Returns a flat ranked list: [{source, name, count, pos, distance, ...}].
   * Distance is from the bot's current position (0 for inventory).
   *
   * The brain calls this BEFORE deciding to mine. If `inventory` count >=
   * needed, no trip required. If `chest` has it, mc goto + mc withdraw.
   * If only `block`, mc collect.
   */
  async find({ resource, scan_range = 32, max_results = 12 }) {
    const b = ensureBot();
    const target = String(resource || '').toLowerCase();
    if (!target) {
      return {
        ok: false,
        error: {
          code: 'MISSING_RESOURCE',
          message: 'mc find requires a resource name (e.g. mc find cobblestone).',
          retry_safe: false,
        },
      };
    }
    const scanR = Math.max(4, Math.min(64, Number(scan_range) || 32));
    const maxN = Math.max(1, Math.min(50, Number(max_results) || 12));
    const botPos = b.entity.position;
    const sources = [];

    // 1. Own inventory.
    try {
      const inv = b.inventory.items();
      const matching = inv.filter(it => it.name === target);
      const total = matching.reduce((s, it) => s + it.count, 0);
      if (total > 0) {
        sources.push({
          source: 'inventory',
          name: target,
          count: total,
          pos: null,
          distance: 0,
        });
      }
    } catch { /* ignore */ }

    // 2. Chest snapshots (per chest mark).
    try {
      for (const [markName, snap] of Object.entries(ctx.chestSnapshots || {})) {
        if (!snap?.items?.length) continue;
        const matching = snap.items.filter(it => it.name === target);
        const total = matching.reduce((s, it) => s + it.count, 0);
        if (total > 0) {
          const dist = snap.position
            ? Math.round(botPos.distanceTo(new Vec3(snap.position.x, snap.position.y, snap.position.z)) * 10) / 10
            : null;
          sources.push({
            source: 'chest',
            mark: markName,
            name: target,
            count: total,
            pos: snap.position || null,
            distance: dist,
            last_seen: snap.last_seen || null,
          });
        }
      }
    } catch { /* ignore */ }

    // 3. Visible blocks of that name within scan_range. Use mc-data to
    //    resolve the block ID; if `target` is an item name (like cobblestone)
    //    it usually matches a block name too. For items only obtainable
    //    by smelting/crafting (e.g. iron_ingot), block search finds nothing
    //    and the brain learns to smelt/craft instead.
    try {
      const blockId = ctx.mcData?.blocksByName?.[target]?.id;
      if (blockId != null) {
        const positions = b.findBlocks({
          matching: blockId,
          maxDistance: scanR,
          count: maxN,
        });
        // Group nearby blocks into a single source (clusters near same xz).
        // For now, list each one — brain can decide which cluster.
        for (const p of positions) {
          const dist = Math.round(botPos.distanceTo(p) * 10) / 10;
          sources.push({
            source: 'block',
            name: target,
            count: 1,
            pos: { x: p.x, y: p.y, z: p.z },
            distance: dist,
          });
        }
      }
    } catch { /* ignore */ }

    // Rank: inventory (distance 0) first, then chests by distance, then
    // blocks by distance. We already added them in that order — just sort
    // by distance within source class.
    const order = { inventory: 0, chest: 1, block: 2 };
    sources.sort((a, c) => {
      const oa = order[a.source] ?? 9;
      const oc = order[c.source] ?? 9;
      if (oa !== oc) return oa - oc;
      return (a.distance ?? Infinity) - (c.distance ?? Infinity);
    });
    const top = sources.slice(0, maxN);

    const totalAvailable = sources.reduce((s, e) => s + (e.count || 0), 0);
    let resultMsg;
    if (top.length === 0) {
      resultMsg = `No ${target} found in inventory, ${Object.keys(ctx.chestSnapshots || {}).length} chest snapshots, or visible within ${scanR}m. Try mining/crafting/smelting.`;
    } else {
      const parts = [];
      const invSrc = top.find(e => e.source === 'inventory');
      if (invSrc) parts.push(`inventory:${invSrc.count}`);
      const chests = top.filter(e => e.source === 'chest');
      if (chests.length > 0) parts.push(`chests:${chests.map(c => `${c.count}@${c.mark}(${c.distance}m)`).join(',')}`);
      const blocks = top.filter(e => e.source === 'block');
      if (blocks.length > 0) {
        const nearest = blocks[0];
        parts.push(`blocks:${blocks.length} (nearest @ ${nearest.pos.x},${nearest.pos.y},${nearest.pos.z} ${nearest.distance}m)`);
      }
      resultMsg = `Found ${target} — total available ${totalAvailable}. ${parts.join('; ')}.`;
    }

    return {
      ok: true,
      data: {
        resource: target,
        total_available: totalAvailable,
        sources: top,
        scan_range: scanR,
      },
      result: resultMsg,
    };
  },

  /**
   * F45.6: Inspect a single cell — what's the block, can it be dug, is it
   * relocatable, what tool should be used, and which entities (players /
   * mobs) overlap that cell. Use proactively to avoid place-fail-then-recover.
   */
  async inspect({ x, y, z }) {
    const b = ensureBot();
    if (![x, y, z].every((v) => Number.isFinite(Number(v)))) {
      return {
        ok: false,
        error: {
          code: 'INVALID_COORD',
          message: 'mc inspect requires numeric x, y, z',
          retry_safe: false,
        },
      };
    }
    const ix = Math.floor(Number(x));
    const iy = Math.floor(Number(y));
    const iz = Math.floor(Number(z));
    const cellPos = new Vec3(ix, iy, iz);
    const blk = b.blockAt(cellPos);
    const blockName = blk?.name || 'unknown';
    const hardness = (typeof blk?.hardness === 'number') ? blk.hardness : null;
    const boundingBox = blk?.boundingBox || null;
    const isAir = blockName === 'air' || blockName === 'cave_air' || blockName === 'void_air';
    const isDiggable = !isAir && !isDigProtected(blockName);
    const isRelocatable = RELOCATABLE_INFRASTRUCTURE.has(blockName);
    const suggestedTool = isAir ? null : suggestedToolForBlock(blockName);

    // Entities occupying this cell (foot or head). 1.8-block tall entities
    // occupy floor(ey) and floor(ey)+1.
    const entitiesAt = [];
    for (const e of Object.values(b.entities || {})) {
      if (!e || !e.position) continue;
      const ex = Math.floor(e.position.x);
      const ez = Math.floor(e.position.z);
      const ey = Math.floor(e.position.y);
      if (ex !== ix || ez !== iz) continue;
      if (ey !== iy && ey + 1 !== iy) continue;
      entitiesAt.push({
        type: e.type || null,
        name: e.name || null,
        username: e.username || null,
        position: { x: e.position.x, y: e.position.y, z: e.position.z },
      });
    }

    const occupied = (!isAir) || entitiesAt.length > 0;
    return {
      ok: true,
      data: {
        coord: { x: ix, y: iy, z: iz },
        block: {
          name: blockName,
          is_air: isAir,
          is_diggable: isDiggable,
          is_relocatable: isRelocatable,
          is_protected: !isAir && !isDiggable,
          suggested_tool: suggestedTool,
          hardness,
          bounding_box: boundingBox,
        },
        entities_at: entitiesAt,
        occupied,
      },
      result: `Block at ${ix},${iy},${iz}: ${blockName}${entitiesAt.length ? ` (${entitiesAt.length} entity${entitiesAt.length > 1 ? 'ies' : ''} here)` : ''}`,
    };
  },

  /**
   * F45.7: Region predicate — is every cell in [x1..x2, y1..y2, z1..z2] air-like?
   * Returns up to 32 non-empty cells with their block names. Capped at 1000 cells.
   */
  async is_empty({ x1, y1, z1, x2, y2, z2 }) {
    const b = ensureBot();
    const coords = [x1, y1, z1, x2, y2, z2].map((v) => Number(v));
    if (!coords.every((v) => Number.isFinite(v))) {
      return {
        ok: false,
        error: { code: 'INVALID_COORD', message: 'mc is_empty requires numeric x1,y1,z1,x2,y2,z2', retry_safe: false },
      };
    }
    const [X1, Y1, Z1, X2, Y2, Z2] = [
      Math.min(Math.floor(coords[0]), Math.floor(coords[3])),
      Math.min(Math.floor(coords[1]), Math.floor(coords[4])),
      Math.min(Math.floor(coords[2]), Math.floor(coords[5])),
      Math.max(Math.floor(coords[0]), Math.floor(coords[3])),
      Math.max(Math.floor(coords[1]), Math.floor(coords[4])),
      Math.max(Math.floor(coords[2]), Math.floor(coords[5])),
    ];
    const cells = (X2 - X1 + 1) * (Y2 - Y1 + 1) * (Z2 - Z1 + 1);
    if (cells > 1000) {
      return {
        ok: false,
        error: {
          code: 'REGION_TOO_LARGE',
          message: `Region has ${cells} cells (max 1000). Shrink the bounds.`,
          observed_state: { total_cells: cells, max_cells: 1000 },
          retry_safe: false,
        },
      };
    }
    const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
    const nonEmpty = [];
    for (let yy = Y1; yy <= Y2; yy++) {
      for (let zz = Z1; zz <= Z2; zz++) {
        for (let xx = X1; xx <= X2; xx++) {
          const blk = b.blockAt(new Vec3(xx, yy, zz));
          const nm = blk?.name || 'unknown';
          if (!AIR_NAMES.has(nm)) {
            nonEmpty.push({ coord: { x: xx, y: yy, z: zz }, name: nm });
            if (nonEmpty.length >= 32) break;
          }
        }
        if (nonEmpty.length >= 32) break;
      }
      if (nonEmpty.length >= 32) break;
    }
    const empty = nonEmpty.length === 0;
    return {
      ok: true,
      data: {
        empty,
        non_empty_blocks: nonEmpty,
        total_cells: cells,
        sampled: nonEmpty.length >= 32,
        bounds: { x1: X1, y1: Y1, z1: Z1, x2: X2, y2: Y2, z2: Z2 },
      },
      result: empty ? `Region ${X1},${Y1},${Z1} → ${X2},${Y2},${Z2} (${cells} cells) is EMPTY` : `Region NOT empty: ${nonEmpty.length}${nonEmpty.length >= 32 ? '+' : ''} non-air cells (first: ${nonEmpty[0].name} at ${nonEmpty[0].coord.x},${nonEmpty[0].coord.y},${nonEmpty[0].coord.z})`,
    };
  },

  /**
   * F45.7: Region predicate — is every cell in [x1..x2, y1..y2, z1..z2]
   * filled with `material`? Returns up to 32 mismatching cells. Capped at 1000.
   */
  async is_filled({ x1, y1, z1, x2, y2, z2, material }) {
    const b = ensureBot();
    if (!material || typeof material !== 'string') {
      return {
        ok: false,
        error: { code: 'MISSING_MATERIAL', message: 'mc is_filled requires a material name (e.g. "cobblestone")', retry_safe: false },
      };
    }
    const coords = [x1, y1, z1, x2, y2, z2].map((v) => Number(v));
    if (!coords.every((v) => Number.isFinite(v))) {
      return {
        ok: false,
        error: { code: 'INVALID_COORD', message: 'mc is_filled requires numeric x1,y1,z1,x2,y2,z2', retry_safe: false },
      };
    }
    const [X1, Y1, Z1, X2, Y2, Z2] = [
      Math.min(Math.floor(coords[0]), Math.floor(coords[3])),
      Math.min(Math.floor(coords[1]), Math.floor(coords[4])),
      Math.min(Math.floor(coords[2]), Math.floor(coords[5])),
      Math.max(Math.floor(coords[0]), Math.floor(coords[3])),
      Math.max(Math.floor(coords[1]), Math.floor(coords[4])),
      Math.max(Math.floor(coords[2]), Math.floor(coords[5])),
    ];
    const cells = (X2 - X1 + 1) * (Y2 - Y1 + 1) * (Z2 - Z1 + 1);
    if (cells > 1000) {
      return {
        ok: false,
        error: {
          code: 'REGION_TOO_LARGE',
          message: `Region has ${cells} cells (max 1000). Shrink the bounds.`,
          observed_state: { total_cells: cells, max_cells: 1000 },
          retry_safe: false,
        },
      };
    }
    const missing = [];
    for (let yy = Y1; yy <= Y2; yy++) {
      for (let zz = Z1; zz <= Z2; zz++) {
        for (let xx = X1; xx <= X2; xx++) {
          const blk = b.blockAt(new Vec3(xx, yy, zz));
          const nm = blk?.name || 'unknown';
          if (nm !== material) {
            missing.push({ coord: { x: xx, y: yy, z: zz }, actual_name: nm });
            if (missing.length >= 32) break;
          }
        }
        if (missing.length >= 32) break;
      }
      if (missing.length >= 32) break;
    }
    const filled = missing.length === 0;
    return {
      ok: true,
      data: {
        filled,
        material,
        missing,
        total_cells: cells,
        sampled: missing.length >= 32,
        bounds: { x1: X1, y1: Y1, z1: Z1, x2: X2, y2: Y2, z2: Z2 },
      },
      result: filled ? `Region ${X1},${Y1},${Z1} → ${X2},${Y2},${Z2} (${cells} cells) is FILLED with ${material}` : `Region NOT fully ${material}: ${missing.length}${missing.length >= 32 ? '+' : ''} mismatching cells (first: ${missing[0].actual_name} at ${missing[0].coord.x},${missing[0].coord.y},${missing[0].coord.z})`,
    };
  },

  async is_sheltered({ radius = 20, walls } = {}) {
    const b = ensureBot();
    const start = b.entity.position;
    const movements = b.pathfinder.movements;
    if (!movements) {
      return {
        ok: false,
        error: {
          code: 'NO_MOVEMENTS',
          message: 'Pathfinder movements not configured. Cannot test enclosure.',
          retry_safe: false,
        },
      };
    }

    // F55.7: optional perimeter wall verification. When called with
    // walls={x1,y1,z1,x2,y2,z2}, sweep the box's perimeter at every Y in
    // [y1..y2] BEFORE the pathfinder check. If any cell is air, refuse
    // upfront with WALLS_INCOMPLETE listing the gap cells. This catches
    // the v6 case where Mason ran is_sheltered claiming the platform was
    // done, but blocks were missing — pathfinder alone said "sealed"
    // because adjacent walls existed but the verification didn't check
    // for COMPLETE coverage.
    if (walls && typeof walls === 'object') {
      const w = walls;
      const coords = ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'].map((k) => Number(w[k]));
      if (!coords.every(Number.isFinite)) {
        return {
          ok: false,
          error: {
            code: 'INVALID_WALLS',
            message: 'walls must be {x1,y1,z1,x2,y2,z2} all numeric',
            observed_state: { received: walls },
            retry_safe: false,
          },
        };
      }
      const [X1, Y1, Z1, X2, Y2, Z2] = [
        Math.min(Math.floor(coords[0]), Math.floor(coords[3])),
        Math.min(Math.floor(coords[1]), Math.floor(coords[4])),
        Math.min(Math.floor(coords[2]), Math.floor(coords[5])),
        Math.max(Math.floor(coords[0]), Math.floor(coords[3])),
        Math.max(Math.floor(coords[1]), Math.floor(coords[4])),
        Math.max(Math.floor(coords[2]), Math.floor(coords[5])),
      ];
      const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
      const missing = [];
      let totalPerimeter = 0;
      for (let yy = Y1; yy <= Y2; yy++) {
        for (let xx = X1; xx <= X2; xx++) {
          for (let zz = Z1; zz <= Z2; zz++) {
            // Perimeter only: cells on the box edge (x == X1 || x == X2 || z == Z1 || z == Z2).
            // Interior cells (between the walls) are not checked — those
            // should be air for a house.
            const onPerimeter = xx === X1 || xx === X2 || zz === Z1 || zz === Z2;
            if (!onPerimeter) continue;
            totalPerimeter++;
            const blk = b.blockAt(new Vec3(xx, yy, zz));
            const nm = blk?.name || 'unknown';
            if (AIR_NAMES.has(nm)) {
              if (missing.length < 16) missing.push({ x: xx, y: yy, z: zz });
            }
          }
        }
      }
      if (missing.length > 0) {
        return {
          ok: false,
          error: {
            code: 'WALLS_INCOMPLETE',
            message: `${missing.length} perimeter cell${missing.length > 1 ? 's' : ''} missing in walls region (${totalPerimeter} total). Fill the gaps before checking enclosure.`,
            observed_state: {
              walls_region: { x1: X1, y1: Y1, z1: Z1, x2: X2, y2: Y2, z2: Z2 },
              total_perimeter_cells: totalPerimeter,
              missing_cells: missing,
              total_missing: missing.length,
            },
            next_action_hint: `mc fill cobblestone ${missing[0].x} ${missing[0].y} ${missing[0].z} ${missing[0].x} ${missing[0].y} ${missing[0].z}`,
            retry_safe: false,
          },
        };
      }
    }

    // Try cardinal targets at `radius` blocks horizontally + one straight up.
    // Each direction gets a short timeout — total wall-clock is bounded.
    const r = Math.max(8, Math.min(48, Number(radius) || 20));
    const sx = Math.floor(start.x);
    const sy = Math.floor(start.y);
    const sz = Math.floor(start.z);
    const targets = [
      { name: 'east',  x: sx + r, y: sy, z: sz },
      { name: 'west',  x: sx - r, y: sy, z: sz },
      { name: 'south', x: sx,     y: sy, z: sz + r },
      { name: 'north', x: sx,     y: sy, z: sz - r },
      { name: 'up',    x: sx,     y: Math.min(sy + r, 250), z: sz },
    ];

    const checks = [];
    let firstLeak = null;
    for (const t of targets) {
      const goal = new goals.GoalNear(t.x, t.y, t.z, 1);
      let status = 'noPath';
      let firstStep = null;
      try {
        // 4000ms per direction: long enough that "noPath" actually means
        // no path, not "didn't finish searching in 1.5s". False-positive
        // SHELTERED reports were the worst case (agent trusts the seal,
        // waits, dies). 5 directions × 4s worst-case ≈ 20s total, still
        // tolerable as a one-shot verification call.
        const result = b.pathfinder.getPathTo(movements, goal, 4000);
        status = result.status;
        if (status === 'success' && result.path && result.path.length > 0) {
          // First step that's NOT the start cell — the "exit" through which
          // the bot would walk out (and mobs walk in).
          for (const node of result.path) {
            if (Math.floor(node.x) !== sx || Math.floor(node.y) !== sy || Math.floor(node.z) !== sz) {
              firstStep = { x: Math.floor(node.x), y: Math.floor(node.y), z: Math.floor(node.z) };
              break;
            }
          }
        }
      } catch (e) {
        status = `error:${(e && e.message) || e}`;
      }
      const leaked = status === 'success';
      checks.push({ direction: t.name, target: { x: t.x, y: t.y, z: t.z }, status, exit: firstStep });
      if (leaked && !firstLeak) firstLeak = { direction: t.name, exit: firstStep };
    }

    const pathfinderEnclosed = firstLeak === null;

    // Also report the immediate 6 wall cells (cardinal neighbours of bot's
    // foot and head). Pathfinder can be fooled by complex geometry but a
    // human can read this list directly. If any cell is air/water/etc
    // when pathfinder thinks the shelter's sealed, the seal is FALSE —
    // mobs in vanilla MC can attack-reach the player through any 1-block
    // hole adjacent to where the player stands, even if they can't walk
    // through it. v30 lost a bot to exactly this geometry: pathfinder
    // said enclosed because a crafting-table-blocked-foot + air-head
    // gap had no walkable path, but a zombie outside reached through
    // the head-level air gap and killed the bot.
    const botFootX = Math.floor(start.x), botFootY = Math.floor(start.y), botFootZ = Math.floor(start.z);
    const wallReport = {};
    for (const lvl of ['foot', 'head']) {
      const wy = botFootY + (lvl === 'head' ? 1 : 0);
      for (const [dx, dz, name] of [[1,0,'east'],[-1,0,'west'],[0,1,'south'],[0,-1,'north']]) {
        const blk = b.blockAt(start.offset(dx, lvl === 'head' ? 1 : 0, dz).floored());
        wallReport[`${lvl}_${name}`] = {
          pos: { x: botFootX + dx, y: wy, z: botFootZ + dz },
          block: blk?.name ?? 'unknown',
          solid: blk ? (blk.boundingBox === 'block') : false,
        };
      }
    }
    // Plus the roof (1 block above head).
    const roof = b.blockAt(start.offset(0, 2, 0).floored());
    wallReport.roof = {
      pos: { x: botFootX, y: botFootY + 2, z: botFootZ },
      block: roof?.name ?? 'unknown',
      solid: roof ? (roof.boundingBox === 'block') : false,
    };

    const openWalls = Object.entries(wallReport)
      .filter(([_, v]) => !v.solid)
      .map(([k, v]) => `${k}=${v.block}@(${v.pos.x},${v.pos.y},${v.pos.z})`);

    // Final verdict combines BOTH checks. Pathfinder says no walk-path,
    // AND every immediate-neighbour cell is solid → truly safe. Either
    // failing → not enclosed.
    const enclosed = pathfinderEnclosed && openWalls.length === 0;

    let resultMsg;
    if (enclosed) {
      resultMsg = `SHELTERED — pathfinder found no exit within ${r} blocks AND all 9 immediate-neighbour cells (4 foot, 4 head, roof) are solid blocks. Safe to wait out the night.`;
    } else if (pathfinderEnclosed && openWalls.length > 0) {
      resultMsg = `OPEN — pathfinder found no walk-path out, BUT ${openWalls.length} immediate cell(s) are not solid: ${openWalls.join(', ')}. Mobs can attack-reach you through these 1-block gaps even though they can't walk in. Seal every immediate-neighbour cell (foot, head, roof) before nightfall.`;
    } else {
      resultMsg = `OPEN — escape route via ${firstLeak.direction} starts at (${firstLeak.exit.x},${firstLeak.exit.y},${firstLeak.exit.z}). Mobs can use that path to reach you. Seal it before nightfall.${openWalls.length > 0 ? ' Immediate gaps: ' + openWalls.join(', ') : ''}`;
    }

    return {
      ok: true,
      data: {
        enclosed,
        // Sub-signals so callers can distinguish "walk-path leak" from
        // "attack-reach leak". Useful for nuanced agent reasoning.
        pathfinder_enclosed: pathfinderEnclosed,
        all_walls_solid: openWalls.length === 0,
        bot_position: { x: Math.round(start.x * 10) / 10, y: Math.round(start.y * 10) / 10, z: Math.round(start.z * 10) / 10 },
        radius: r,
        leak: firstLeak,
        checks,
        immediate_walls: wallReport,
        open_walls: openWalls,
      },
      result: resultMsg,
    };
  },

  };
}
