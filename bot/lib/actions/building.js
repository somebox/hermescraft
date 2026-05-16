// @size-exempt: all block-placement verbs from former world.js split (Phase 4)
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { equipForDig, RELOCATABLE_INFRASTRUCTURE, suggestedToolForBlock, isDigProtected } from '../runtime/dig-tools.js';
import { raceWithTimeout, timeoutError, OperationTimeoutError, ACTION_CAPS_MS } from './_helpers.js';
import { ok } from '../shared/action-contract.js';

const { goals } = pathfinderPkg;

/**
 * createBuildingActions — extracted from former lib/actions/world.js (Phase 4 split).
 */
export function createBuildingActions(services) {
  const { state: ctx, config, ensureBot, utils, social, resolver, fairPlay, getActions } = services;
  const { fmt, posObj, sleep, log } = utils;
  const { resolveInventoryItem } = resolver;
  const { rememberSocialEvent, getMyName } = social;
  const { hasLineOfSight, eyePosition } = fairPlay;

  return {
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

    const res = await getActions().dig_area({ x1, y1, z1, x2, y2, z2, pickup: true, abort_on_fail: false, clear_stand: true });
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
  };
}
