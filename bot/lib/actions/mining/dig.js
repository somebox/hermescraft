// @size-exempt: dig handler oversized; inherited from legacy mining.js
import { Vec3 } from 'vec3';
import { equipForDig, detectDigHazards, isDigProtected, getSupportedDoorAbove } from '../../runtime/dig-tools.js';
import { OperationTimeoutError, ACTION_CAPS_MS, timeoutError } from '../_helpers.js';
import { gotoWithTimeout } from './goto-with-timeout.js';
import { coord3 } from '../_args.js';
import { canSeeBlockFaces } from '../_los.js';
import { fail } from '../../shared/action-contract.js';

export function createDigHandlers(deps) {
  const {
    ctx,
    config,
    ensureBot,
    goals,
    posObj,
    sleep,
    hasLineOfSight,
    eyePosition,
  } = deps;

  async function dig(args) {
        const c = coord3(args);
        if (!c.ok) return c.response;
        const { x, y, z } = c;
        const force = args.force;
        const b = ensureBot();
        const target = b.blockAt(new Vec3(x, y, z));
    
        // ─ Phase-2 action contract (see docs/design/phase-2/action-contracts.md mc dig) ─
        // Soft failures return { ok: false, error: { code, message, observed_state, ... } }.
        // The HTTP wrapper spreads result over { ok: true, ... }, so ok=false propagates.
    
        // circuit-v8 followup: repeat-fail detector. If the agent keeps
        // hammering the same cell with mc dig and the body keeps refusing,
        // surface a DIG_BLOCKED_REPEAT envelope so the postmortem (and the
        // agent itself) sees the "stuck pattern" clearly. Tracked in
        // ctx.runtime.recentDigFailures (60s window, 12-entry cap).
        const DIG_FAIL_WINDOW_MS = 60_000;
        const DIG_FAIL_REPEAT_THRESHOLD = 3;
        const cell = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
        const recordDigFailure = (code) => {
          if (!ctx?.runtime) return;
          if (!Array.isArray(ctx.runtime.recentDigFailures)) ctx.runtime.recentDigFailures = [];
          const cutoff = Date.now() - DIG_FAIL_WINDOW_MS;
          ctx.runtime.recentDigFailures = ctx.runtime.recentDigFailures.filter(e => e.ts > cutoff);
          const existing = ctx.runtime.recentDigFailures.find(e =>
            e.cell.x === cell.x && e.cell.y === cell.y && e.cell.z === cell.z);
          if (existing) {
            existing.hit_count = (existing.hit_count || 1) + 1;
            existing.ts = Date.now();
            existing.code = code;
          } else {
            ctx.runtime.recentDigFailures.push({
              ts: Date.now(),
              cell: { ...cell },
              block: target?.name || null,
              code,
              hit_count: 1,
            });
            if (ctx.runtime.recentDigFailures.length > 12) ctx.runtime.recentDigFailures.shift();
          }
        };
        // Pre-check: have we already hit the repeat threshold for this cell?
        if (ctx?.runtime && Array.isArray(ctx.runtime.recentDigFailures)) {
          const cutoff = Date.now() - DIG_FAIL_WINDOW_MS;
          ctx.runtime.recentDigFailures = ctx.runtime.recentDigFailures.filter(e => e.ts > cutoff);
          const prior = ctx.runtime.recentDigFailures.find(e =>
            e.cell.x === cell.x && e.cell.y === cell.y && e.cell.z === cell.z);
          if (prior && prior.hit_count >= DIG_FAIL_REPEAT_THRESHOLD) {
            return {
              ok: false,
              error: {
                code: 'DIG_BLOCKED_REPEAT',
                message: `Failed to dig (${cell.x},${cell.y},${cell.z}) ${prior.hit_count}× in the last 60s (last code: ${prior.code}). The block is genuinely unreachable from your current angle. Stop retrying — pillar away, approach from a different side, or call mc advise.`,
                observed_state: {
                  failed_count: prior.hit_count,
                  last_error_code: prior.code,
                  block_at_target: prior.block,
                  requested_coord: cell,
                  bot_position: posObj(b.entity.position),
                },
                next_action_hint: `mc advise --reason="dig blocked at ${cell.x},${cell.y},${cell.z}"`,
                retry_safe: false,
              },
            };
          }
        }
    
        if (!target || target.name === 'air' || target.name === 'cave_air' || target.name === 'void_air') {
          recordDigFailure('NO_BLOCK_AT_COORD');
          return {
            ok: false,
            error: {
              code: 'NO_BLOCK_AT_COORD',
              message: `No block at ${x}, ${y}, ${z} — target is ${target?.name || 'unknown'}`,
              observed_state: { block_at_target: target?.name || null, requested_coord: { x, y, z } },
              retry_safe: false,
            },
          };
        }
    
        if (isDigProtected(target.name, { x, y, z }, ctx)) {
          recordDigFailure('PROTECTED_BLOCK');
          return {
            ok: false,
            error: {
              code: 'PROTECTED_BLOCK',
              message: `Cannot dig ${target.name} — it is part of a building. Use doors to enter buildings.`,
              observed_state: { block_at_target: target.name, requested_coord: { x, y, z } },
              retry_safe: false,
            },
          };
        }
    
        // circuit-v8 + v11 self-dig safety: refuse to dig the block
        // directly under the bot's feet — that drops the bot into a
        // hole it can't always climb out of (especially with no
        // pillar-up materials). The block one Y below the bot's foot
        // position is what the bot is currently standing on. Force
        // flag overrides for callers who know what they're doing
        // (mc stair_down already requests cells away from the bot).
        if (!force && b.entity?.position) {
          const fx = Math.floor(b.entity.position.x);
          const fy = Math.floor(b.entity.position.y);
          const fz = Math.floor(b.entity.position.z);
          if (cell.x === fx && cell.z === fz && cell.y === fy - 1) {
            recordDigFailure('DIG_UNDER_FEET');
            // Does the bot have a placeable block to pillar back up?
            const PLACEABLE_RE = /^(dirt|coarse_dirt|cobblestone|stone|sand|gravel|.*_planks|netherrack)$/;
            const hasPlaceable = b.inventory?.items?.().some((i) => PLACEABLE_RE.test(i.name));
            return {
              ok: false,
              error: {
                code: 'DIG_UNDER_FEET',
                message: hasPlaceable
                  ? `Refusing to dig (${cell.x},${cell.y},${cell.z}) — that's the block under your feet. You'd drop into a 1-cell pit. Move 1 block away first (mc move) and dig from beside. If you actually want to pillar-down, use mc dig --force.`
                  : `Refusing to dig (${cell.x},${cell.y},${cell.z}) — that's the block under your feet AND you have no placeable blocks (dirt/cobble/sand/planks/etc.) to climb back out. Move beside the block first, or get a pillar-up resource. Force with mc dig --force if you really mean it.`,
                observed_state: {
                  block_at_target: target.name,
                  requested_coord: { x, y, z },
                  bot_foot: { x: fx, y: fy, z: fz },
                  has_placeable: hasPlaceable,
                },
                next_action_hint: `mc move ${fx + 1} ${fy} ${fz}  # step beside, then dig from the side`,
                retry_safe: false,
              },
            };
          }
        }
    
        // F54.4: refuse to dig while the bot is submerged. mineflayer's
        // b.dig with the bot's head/feet in water either silently times
        // out (G21 v5 Mason in pond) or drowns the bot mid-swing. Force
        // flag overrides for power-users who know they have breathing room.
        if (!force && b.entity?.isInWater === true) {
          recordDigFailure('SUBMERGED');
          return {
            ok: false,
            error: {
              code: 'SUBMERGED',
              message: `Cannot dig at (${x}, ${y}, ${z}) — bot is submerged in water. Swim to the surface (mc escape, or place a block under your feet to pillar up) before digging. Re-run with --force if you have breathing room.`,
              observed_state: {
                block_at_target: target.name,
                bot_in_water: true,
                requested_coord: { x, y, z },
              },
              next_action_hint: 'mc escape',
              retry_safe: false,
            },
          };
        }
    
        // F54.1: refuse to dig a block that supports a door/fence_gate above —
        // doing so drops the door as a loose item, an expensive recovery the
        // brain rarely realizes happened. Honors force flag.
        if (!force) {
          const supported = getSupportedDoorAbove(b, x, y, z);
          if (supported) {
            recordDigFailure('SUPPORT_BLOCK');
            return {
              ok: false,
              error: {
                code: 'SUPPORT_BLOCK',
                message: `Cannot dig ${target.name} at (${x}, ${y}, ${z}) — it supports ${supported.name} at (${supported.x}, ${supported.y}, ${supported.z}). Digging will drop the door/gate as a loose item. Re-run with --force if intentional.`,
                observed_state: {
                  block_at_target: target.name,
                  supported_block: supported,
                  requested_coord: { x, y, z },
                },
                next_action_hint: `mc dig ${x} ${y} ${z} --force`,
                retry_safe: false,
              },
            };
          }
        }
    
        const distance = b.entity.position.distanceTo(target.position);
    
        let hints = [];
        try {
          const ed = await equipForDig(b, target);
          hints = ed.hints || [];
        } catch (err) {
          recordDigFailure('TOOL_INADEQUATE');
          return {
            ok: false,
            error: {
              code: 'TOOL_INADEQUATE',
              message: err.message,
              observed_state: {
                block_at_target: target.name,
                held: b.tool?.itemInHand()?.name ?? null,
                distance: Math.round(distance * 10) / 10,
              },
              next_action_hint: err.message,
              retry_safe: false,
            },
          };
        }
    
        if (distance > 4.5) {
          try {
            await gotoWithTimeout(b, new goals.GoalNear(x, y, z, 3), ACTION_CAPS_MS.dig);
          } catch (err) {
            if (err instanceof OperationTimeoutError || err.code === 'OPERATION_TIMEOUT') {
              recordDigFailure('OPERATION_TIMEOUT');
              return timeoutError('dig', ACTION_CAPS_MS.dig, {
                block_at_target: target.name,
                requested_coord: { x, y, z },
                distance: Math.round(distance * 10) / 10,
                bot_position: posObj(b.entity.position),
              }, 'Pathfind to dig target was canceled. Move closer manually or try a different cell.');
            }
            recordDigFailure('OUT_OF_RANGE');
            return {
              ok: false,
              error: {
                code: 'OUT_OF_RANGE',
                message: `Target at (${x}, ${y}, ${z}) is ${Math.round(distance * 10) / 10} blocks away and pathfind failed: ${err.message}`,
                observed_state: {
                  block_at_target: target.name,
                  distance: Math.round(distance * 10) / 10,
                  bot_position: posObj(b.entity.position),
                },
                retry_safe: false,
              },
            };
          }
        }
    
        const targetPos = target.position;
    
        // F67: LOS raycast guard. Mirrors F45.3 / F64 / F65 — bot can't dig
        // a block it can't see (no mining through walls / through its own
        // body / through floors). Uses the same 7-face raycast pattern.
        if (!canSeeBlockFaces(b, x, y, z, { hasLineOfSight, eyePosition })) {
              recordDigFailure('NO_LINE_OF_SIGHT');
              return fail(
                'NO_LINE_OF_SIGHT',
                `Cannot see ${target.name} at ${x},${y},${z} — a block is between you and the target.`,
                {
                  observed_state: {
                    block_at_target: target.name,
                    requested_coord: { x, y, z },
                    bot_position: posObj(b.entity.position),
                    distance: Math.round(b.entity.position.distanceTo(target.position) * 10) / 10,
                  },
                  next_action_hint: `Navigate around the obstruction; try mc goto_near ${x} ${y} ${z} range=2`,
                  retry_safe: false,
                },
              );
            }
    
        const beforeDropIds = new Set(
          Object.values(b.entities)
            .filter((e) => e.name === 'item' || e.displayName === 'Item')
            .map((e) => e.id),
        );
    
        try {
          await b.dig(target, true);
        } catch (err) {
          recordDigFailure('INTERRUPTED');
          return {
            ok: false,
            error: {
              code: 'INTERRUPTED',
              message: `Dig interrupted: ${err.message}`,
              observed_state: { block_at_target: target.name, requested_coord: { x, y, z } },
              retry_safe: true,
            },
          };
        }
    
        // ─ Success: scan for drop entities at/near the target for data.dropped_items ─
        // Drops appear ~1-3 server ticks after the block break packet. Wait briefly
        // (default 300ms; tunable via MC_DIG_DROP_SCAN_MS) then collect any item
        // entities that weren't there before, restricted to ≤2.5 blocks of the
        // broken coord (drops can scatter slightly with falling-block physics).
        const dropScanMs = config.behaviors.digDropScanMs;
        await sleep(dropScanMs);
        const dropped = [];
        for (const e of Object.values(b.entities)) {
          if (e.name !== 'item' && e.displayName !== 'Item') continue;
          if (beforeDropIds.has(e.id)) continue;
          if (!e.position || e.position.distanceTo(targetPos) > 2.5) continue;
          // mineflayer exposes the held item via metadata index 8 (1.16+) or 7 (older).
          // Both shapes carry { itemId, itemCount } as the slot data.
          const meta = e.metadata?.[8] || e.metadata?.[7];
          const itemName = meta?.itemId
            ? (ctx.world.mcData.items[meta.itemId]?.name || `item:${meta.itemId}`)
            : (e.displayName || 'unknown');
          const count = meta?.itemCount ?? meta?.count ?? 1;
          dropped.push({
            name: itemName,
            count,
            position: posObj(e.position),
          });
        }
    
        // F72: push the dig's drops to ctx.runtime.recentPickups. The auto-pickup
        // magnet (1.5-block radius) typically grabs these within a tick
        // or two after the drop appears — earlier than this handler can
        // reliably snapshot inventory. The collect-side handler will
        // double-check that the bot's current inventory actually has the
        // item before short-circuiting, so a drop that lands outside
        // pickup range won't lead to a false success.
        const _now = Date.now();
        if (Array.isArray(ctx.runtime.recentPickups)) {
          ctx.runtime.recentPickups = ctx.runtime.recentPickups
            .filter((p) => (_now - p.ts) < 30_000)
            .slice(-11);
        } else {
          ctx.runtime.recentPickups = [];
        }
        for (const d of dropped) {
          if (!d?.name || !(d.count > 0)) continue;
          ctx.runtime.recentPickups.push({ ts: _now, item: d.name, count: d.count, source: 'dig' });
        }
    
        const tips = [...new Set(hints)];
    
        // Success: clear any stale dig-failure record for this cell so the
        // repeat-blocked detector doesn't fire on later attempts at the
        // same spot (e.g. agent unblocked itself and is mining a new
        // block in the same coord).
        if (ctx?.runtime?.recentDigFailures?.length) {
          ctx.runtime.recentDigFailures = ctx.runtime.recentDigFailures.filter(e =>
            !(e.cell.x === cell.x && e.cell.y === cell.y && e.cell.z === cell.z));
        }
    
        return {
          ok: true,
          data: {
            block_name: target.name,
            dropped_items: dropped,
            position_after: posObj(b.entity.position),
          },
          // Preserve legacy fields so existing callers (goal engine, older tests) still see them.
          result: `Mined ${target.name} at ${x}, ${y}, ${z}${tips.length ? ` Tips: ${tips.join(' | ')}` : ''}`,
          ...(tips.length ? { hints: tips } : {}),
        };
  }

  function createSafeDig(invokeDig) {
    return async function safe_dig({ x, y, z, force }) {
          const b = ensureBot();
          if (![x, y, z].every((v) => Number.isFinite(Number(v)))) {
            return { ok: false, error: { code: 'INVALID_COORD', message: 'mc safe_dig requires numeric x, y, z', retry_safe: false } };
          }
          const tx = Math.floor(Number(x)), ty = Math.floor(Number(y)), tz = Math.floor(Number(z));
          if (force) return invokeDig({ x: tx, y: ty, z: tz, force: true });
      
          const target = b.blockAt(new Vec3(tx, ty, tz));
          if (!target || target.name === 'air' || target.name === 'cave_air' || target.name === 'void_air') {
            return {
              ok: false,
              error: {
                code: 'NO_BLOCK_AT_COORD',
                message: `No block at ${tx}, ${ty}, ${tz} — target is ${target?.name || 'unknown'}`,
                observed_state: { block_at_target: target?.name || null, requested_coord: { x: tx, y: ty, z: tz } },
                retry_safe: false,
              },
            };
          }
      
          const hazard = detectDigHazards(b, tx, ty, tz);
          if (hazard) {
            const code =
              hazard.kind === 'lava' ? 'HAZARD_LAVA' :
              hazard.kind === 'fall' ? 'HAZARD_FALL' :
              'HAZARD_SUFFOCATE';
            const messages = {
              HAZARD_LAVA: `Lava at ${hazard.at?.x},${hazard.at?.y},${hazard.at?.z} would flow on the bot if ${target.name} at ${tx},${ty},${tz} is broken. Use mc seal to wall it off, or mc safe_dig --force to override.`,
              HAZARD_FALL: `Block at ${tx},${ty},${tz} is the floor under the bot — digging it would drop the bot ${hazard.drop} blocks. Step away first, or mc safe_dig --force to override.`,
              HAZARD_SUFFOCATE: `Falling-block column (${hazard.falling_block} × ${hazard.column_height}) above ${tx},${ty},${tz} would fall on the bot if dug. Approach from a side, or mc safe_dig --force to override.`,
            };
            return {
              ok: false,
              error: {
                code,
                message: messages[code],
                observed_state: { block_at_target: target.name, requested_coord: { x: tx, y: ty, z: tz }, hazard },
                retry_safe: false,
              },
            };
          }
      
          return invokeDig({ x: tx, y: ty, z: tz });
    };
  }

  return { dig, createSafeDig };
}
