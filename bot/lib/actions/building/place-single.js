import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { RELOCATABLE_INFRASTRUCTURE, suggestedToolForBlock, isDigProtected, recordRecentPlace } from '../../runtime/dig-tools.js';
import { raceWithTimeout, timeoutError, OperationTimeoutError, ACTION_CAPS_MS, pathfindGotoNear } from '../_helpers.js';
import { REPLACEABLE } from '../_block-sets.js';
import { coord3, itemName } from '../_args.js';
import { canSeeBlockFaces, standardBlockFacePoints } from '../_los.js';
import { fail, ok } from '../../shared/action-contract.js';

const { goals } = pathfinderPkg;

/**
 * @param {{
 *   services: any,
 *   ctx: any,
 *   ensureBot: () => any,
 *   posObj: (pos: any) => any,
 *   sleep: (ms: number) => Promise<void>,
 *   fairPlay: { hasLineOfSight?: (eye: any, p: any) => boolean, eyePosition?: () => any },
 * }} deps
 */
export function createBuildingPlaceSinglePart(deps) {
  const { services, ctx, ensureBot, posObj, sleep, fairPlay } = deps;
  const { hasLineOfSight, eyePosition } = fairPlay;

  return {
    // ─ Phase-2 action contract (see docs/design/phase-2/action-contracts.md mc place) ─
    // Soft failures return { ok: false, error: { code, message, observed_state, ... } }.
    // ok=true requires block to be at target coord AFTER placement (verified via blockAt).

    async place(args) {
      const itemParsed = itemName(args, { keys: ['block', 'item', 'name'] });
      if (!itemParsed.ok) return itemParsed.response;
      const blockName = itemParsed.name;
      const c = coord3(args);
      if (!c.ok) return c.response;
      const { x, y, z } = c;
      const b = ensureBot();
      const targetPos = new Vec3(x, y, z);
      const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

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
        const isDiggable = !isDigProtected(existing.name, { x, y, z }, ctx);
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
          await pathfindGotoNear(b, goals, x, y, z, 3, { opName: 'place', capMs: ACTION_CAPS_MS.place });
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
      // canSeeBlockFaces samples the 7 standard face points; it returns true
      // when LOS deps are unavailable so behaviour matches the pre-helper
      // guard. When LOS is blocked we also compute a blocker hint + nearest
      // clear-sight stand cell for next_action_hint.
      if (!canSeeBlockFaces(b, x, y, z, { hasLineOfSight, eyePosition })) {
        const eye = eyePosition?.();
        const cx = x + 0.5;
        const cy = y + 0.5;
        const cz = z + 0.5;
        const faceCandidates = standardBlockFacePoints(x, y, z);
        let blocker = null;
        if (eye) {
          try {
            const raw = b.world?.raycast?.(
              eye,
              { x: cx - eye.x, y: cy - eye.y, z: cz - eye.z },
              6,
            );
            blocker = raw?.name || null;
          } catch { /* ignore */ }
        }
        // F56: scan a 5-block ring around the target at the bot's foot
        // level to find a stand cell where LOS to the target would be
        // clear. Return that as next_action_hint so the brain can move
        // there instead of guessing. Costs ~24 cheap raycasts.
        let suggestedStand = null;
        if (typeof hasLineOfSight === 'function') {
          try {
            const ringRadius = 3;
            const standY = y - 1; // bot stands here, eye at standY+1.62
            const standCandidates = [];
            for (let dx = -ringRadius; dx <= ringRadius; dx++) {
              for (let dz = -ringRadius; dz <= ringRadius; dz++) {
                if (dx === 0 && dz === 0) continue;
                const sx = x + dx;
                const sz = z + dz;
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
        }
        return fail(
          'NO_LINE_OF_SIGHT',
          suggestedStand
            ? `Cannot place at ${x},${y},${z} — view blocked${blocker ? ` by ${blocker}` : ''}. Stand at (${suggestedStand.x}, ${suggestedStand.y}, ${suggestedStand.z}) for clear sight: mc move ${suggestedStand.x} ${suggestedStand.y} ${suggestedStand.z}`
            : `Cannot place at ${x},${y},${z} — your view to the target is blocked${blocker ? ` by ${blocker}` : ''} and no nearby stand position has clear sight. Dig the obstruction first, or approach the target from another side.`,
          {
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
        );
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

          recordRecentPlace(ctx, { x, y, z }, blockName);
          // #100: auto-mark a freshly-placed crafting_table so future
          // mc craft calls find it via the marks fallback (the existing
          // /craft/i regex match in crafting.js).
          if (blockName === 'crafting_table' && typeof services.autoMarkCraftingTable === 'function') {
            services.autoMarkCraftingTable({ x, y, z });
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
  };
}
