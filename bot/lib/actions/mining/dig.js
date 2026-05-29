import { Vec3 } from 'vec3';
import {
  equipForDig,
  detectDigHazards,
  isDigProtected,
  getSupportedDoorAbove,
  detectPostDigBreach,
} from '../../runtime/dig-tools.js';
import { OperationTimeoutError, ACTION_CAPS_MS, timeoutError } from '../_helpers.js';
import { gotoWithTimeout } from './goto-with-timeout.js';
import { coord3 } from '../_args.js';
import { canSeeBlockFaces } from '../_los.js';
import { ok, fail } from '../../shared/action-contract.js';
import { evaluateRegionPolicy, regionProtectedFailure } from '../../runtime/regions/policy-guard.js';
import { createDigFailureTracker } from '../../runtime/dig-failure-ring.js';
import { egressTreadCells, isEgressProtectedCell, clearEgressTrail } from '../../runtime/egress-guard.js';

// Plug-block selection for water/lava breach next-action hints. Sand/gravel
// are excluded because they fall through a fluid column instead of plugging
// it. Order = preference (cobblestone is the cheapest universal plug).
const PLUG_PRIORITY = ['cobblestone', 'stone', 'dirt', 'coarse_dirt', 'netherrack'];
const PLUG_PLANKS_RE = /_planks$/;

const PLACEABLE_RE = /^(dirt|coarse_dirt|cobblestone|stone|sand|gravel|.*_planks|netherrack)$/;

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

// ─ Pure helpers (no closure dependencies) ──────────────────────────────

function pickPlugItem(b) {
  const inv = b.inventory?.items?.() || [];
  for (const name of PLUG_PRIORITY) {
    if (inv.some((it) => it.name === name)) return name;
  }
  const planks = inv.find((it) => PLUG_PLANKS_RE.test(it.name));
  return planks ? planks.name : null;
}

function buildBreachFields(b, breach) {
  const { x, y, z } = breach.breach_cell;
  const plug = pickPlugItem(b);
  if (breach.severity === 'critical') {
    // Lava: retreat first, plug second. Don't suggest standing next to it.
    return {
      severity: 'critical',
      hint: plug
        ? `back away first, then \`mc place ${plug} ${x} ${y} ${z}\``
        : `back away — no non-falling plug block in inventory (need cobble/stone/dirt/planks/netherrack)`,
      next_action_hint: plug
        ? `mc move <safe coord> then mc place ${plug} ${x} ${y} ${z}`
        : `mc move <safe coord> then craft/fetch a plug block`,
    };
  }
  // Water: plug the dug cell.
  return {
    severity: 'warn',
    hint: plug
      ? `plug with \`mc place ${plug} ${x} ${y} ${z}\``
      : `no non-falling plug block in inventory — fetch cobble/dirt/planks before retrying`,
    next_action_hint: plug
      ? `mc place ${plug} ${x} ${y} ${z}`
      : `mc inventory to confirm; need cobble/stone/dirt/planks/netherrack to plug ${x},${y},${z}`,
  };
}

// ─ Handler factory ─────────────────────────────────────────────────────

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

  /**
   * Run the sequence of pre-dig refusal guards. Returns a `fail()` envelope
   * on the first failing guard, or `null` if every guard passes.
   * Honors the `force` flag for guards that opt-in to bypass (DIG_UNDER_FEET,
   * SUBMERGED, SUPPORT_BLOCK, PROTECTED_BLOCK via regionPolicy.skipGlobalDeny).
   */
  function runPreDigGuards(b, x, y, z, cell, target, force, tracker) {
    if (!target || AIR_NAMES.has(target.name)) {
      tracker.record('NO_BLOCK_AT_COORD');
      return fail(
        'NO_BLOCK_AT_COORD',
        `No block at ${x}, ${y}, ${z} — target is ${target?.name || 'unknown'}`,
        {
          observed_state: { block_at_target: target?.name || null, requested_coord: { x, y, z } },
          retry_safe: false,
        },
      );
    }

    const regionDig = evaluateRegionPolicy(ctx, config, 'dig', x, y, z, target.name);
    if (regionDig.deny) {
      tracker.record('REGION_PROTECTED');
      return regionProtectedFailure('dig', target.name, x, y, z, regionDig.regionResult);
    }

    if (!regionDig.skipGlobalDeny && isDigProtected(target.name, { x, y, z }, ctx)) {
      tracker.record('PROTECTED_BLOCK');
      return fail(
        'PROTECTED_BLOCK',
        `Cannot dig ${target.name} — it is part of a building. Use doors to enter buildings.`,
        {
          observed_state: { block_at_target: target.name, requested_coord: { x, y, z } },
          retry_safe: false,
        },
      );
    }

    // Protect the bot's own staircase egress (stair_down treads). Removing a
    // tread support turns the staircase into an un-climbable shaft and mc
    // retrace can no longer get the bot out. Force overrides (and invalidates
    // the trail afterward, in dig()).
    if (!force) {
      const egress = egressTreadCells(ctx);
      if (egress && isEgressProtectedCell(egress, x, y, z)) {
        tracker.record('STAIRCASE_EGRESS');
        return fail(
          'STAIRCASE_EGRESS',
          `Refusing to dig ${target.name} at (${x}, ${y}, ${z}) — it's a tread of the staircase you dug with mc stair_down (your way back up). Digging it would strand you below. Re-run with --force to remove it anyway (this invalidates the retrace trail — build a new way up first).`,
          {
            observed_state: {
              block_at_target: target.name,
              requested_coord: { x, y, z },
              trail_source: egress.trail?.source || 'stair_down',
            },
            next_action_hint: `mc retrace   # walk back up your stairs, OR mc dig ${x} ${y} ${z} --force to remove this tread`,
            retry_safe: false,
          },
        );
      }
    }

    // circuit-v8 + v11 self-dig safety: refuse to dig the block directly
    // under the bot's feet — that drops the bot into a hole it can't always
    // climb out of (especially with no pillar-up materials). Force flag
    // overrides for callers who know what they're doing (mc stair_down
    // already requests cells away from the bot).
    if (!force && b.entity?.position) {
      const fx = Math.floor(b.entity.position.x);
      const fy = Math.floor(b.entity.position.y);
      const fz = Math.floor(b.entity.position.z);
      if (cell.x === fx && cell.z === fz && cell.y === fy - 1) {
        tracker.record('DIG_UNDER_FEET');
        const hasPlaceable = b.inventory?.items?.().some((i) => PLACEABLE_RE.test(i.name));
        return fail(
          'DIG_UNDER_FEET',
          hasPlaceable
            ? `Refusing to dig (${cell.x},${cell.y},${cell.z}) — that's the block under your feet. You'd drop into a 1-cell pit. Move 1 block away first (mc move) and dig from beside. If you actually want to pillar-down, use mc dig --force.`
            : `Refusing to dig (${cell.x},${cell.y},${cell.z}) — that's the block under your feet AND you have no placeable blocks (dirt/cobble/sand/planks/etc.) to climb back out. Move beside the block first, or get a pillar-up resource. Force with mc dig --force if you really mean it.`,
          {
            observed_state: {
              block_at_target: target.name,
              requested_coord: { x, y, z },
              bot_foot: { x: fx, y: fy, z: fz },
              has_placeable: hasPlaceable,
            },
            next_action_hint: `mc move ${fx + 1} ${fy} ${fz}  # step beside, then dig from the side`,
            retry_safe: false,
          },
        );
      }
    }

    // F54.4: refuse to dig while the bot is submerged. mineflayer's b.dig
    // with the bot's head/feet in water either silently times out (G21 v5
    // Mason in pond) or drowns the bot mid-swing. Force flag overrides for
    // power-users who know they have breathing room.
    if (!force && b.entity?.isInWater === true) {
      tracker.record('SUBMERGED');
      return fail(
        'SUBMERGED',
        `Cannot dig at (${x}, ${y}, ${z}) — bot is submerged in water. Swim to the surface (mc escape, or place a block under your feet to pillar up) before digging. Re-run with --force if you have breathing room.`,
        {
          observed_state: {
            block_at_target: target.name,
            bot_in_water: true,
            requested_coord: { x, y, z },
          },
          next_action_hint: 'mc escape',
          retry_safe: false,
        },
      );
    }

    // F54.1: refuse to dig a block that supports a door/fence_gate above —
    // doing so drops the door as a loose item, an expensive recovery the
    // brain rarely realizes happened. Honors force flag.
    if (!force) {
      const supported = getSupportedDoorAbove(b, x, y, z);
      if (supported) {
        tracker.record('SUPPORT_BLOCK');
        return fail(
          'SUPPORT_BLOCK',
          `Cannot dig ${target.name} at (${x}, ${y}, ${z}) — it supports ${supported.name} at (${supported.x}, ${supported.y}, ${supported.z}). Digging will drop the door/gate as a loose item. Re-run with --force if intentional.`,
          {
            observed_state: {
              block_at_target: target.name,
              supported_block: supported,
              requested_coord: { x, y, z },
            },
            next_action_hint: `mc dig ${x} ${y} ${z} --force`,
            retry_safe: false,
          },
        );
      }
    }

    return null;
  }

  /**
   * Equip the right tool for the target. On equipForDig failure (no
   * appropriate tool + slow-dig refusal), returns a TOOL_INADEQUATE fail
   * envelope. On success, returns `{ hints }`.
   *
   * When `force` is true (e.g. `mc dig --force` for a trapped bot escape),
   * the slow-dig guard is bypassed — the bot will attempt the dig even
   * with bare hands on stone. In vanilla MC bare-hand digs on stone are
   * legal but slow (~5s/block); the guard exists to catch agents wasting
   * iteration budget on the slow path when a pickaxe is on hand. For an
   * actual emergency (sealed in own shelter, no pickaxe), `--force` is
   * the right escape hatch.
   */
  async function equipOrFail(b, target, distance, tracker, force = false) {
    try {
      const ed = await equipForDig(b, target, { force });
      return { hints: ed.hints || [], err: null };
    } catch (err) {
      tracker.record('TOOL_INADEQUATE');
      return {
        hints: [],
        err: fail('TOOL_INADEQUATE', err.message, {
          observed_state: {
            block_at_target: target.name,
            held: b.tool?.itemInHand()?.name ?? null,
            distance: Math.round(distance * 10) / 10,
          },
          next_action_hint: `${err.message} (or re-run with --force for bare-hand emergency dig)`,
          retry_safe: false,
        }),
      };
    }
  }

  /**
   * Pathfind to within dig range when the bot is further than 4.5 blocks
   * away. Returns null on success, or a fail envelope on timeout/path-fail.
   */
  async function approachOrFail(b, target, x, y, z, distance, tracker) {
    if (distance <= 4.5) return null;
    try {
      await gotoWithTimeout(b, new goals.GoalNear(x, y, z, 3), ACTION_CAPS_MS.dig);
      return null;
    } catch (err) {
      if (err instanceof OperationTimeoutError || err.code === 'OPERATION_TIMEOUT') {
        tracker.record('OPERATION_TIMEOUT');
        return timeoutError(
          'dig',
          ACTION_CAPS_MS.dig,
          {
            block_at_target: target.name,
            requested_coord: { x, y, z },
            distance: Math.round(distance * 10) / 10,
            bot_position: posObj(b.entity.position),
          },
          'Pathfind to dig target was canceled. Move closer manually or try a different cell.',
        );
      }
      tracker.record('OUT_OF_RANGE');
      return fail(
        'OUT_OF_RANGE',
        `Target at (${x}, ${y}, ${z}) is ${Math.round(distance * 10) / 10} blocks away and pathfind failed: ${err.message}`,
        {
          observed_state: {
            block_at_target: target.name,
            distance: Math.round(distance * 10) / 10,
            bot_position: posObj(b.entity.position),
          },
          retry_safe: false,
        },
      );
    }
  }

  /**
   * F67 LOS raycast guard. Mirrors F45.3 / F64 / F65 — bot can't dig a
   * block it can't see (no mining through walls / through its own body /
   * through floors). Uses the 7-face raycast pattern.
   */
  function assertLineOfSight(b, x, y, z, target, tracker) {
    if (canSeeBlockFaces(b, x, y, z, { hasLineOfSight, eyePosition })) return null;
    tracker.record('NO_LINE_OF_SIGHT');
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

  /**
   * Run b.dig() and translate any throw into an INTERRUPTED envelope.
   * Returns null on success.
   */
  async function performDig(b, target, x, y, z, tracker) {
    try {
      await b.dig(target, true);
      return null;
    } catch (err) {
      tracker.record('INTERRUPTED');
      return fail('INTERRUPTED', `Dig interrupted: ${err.message}`, {
        observed_state: { block_at_target: target.name, requested_coord: { x, y, z } },
        retry_safe: true,
      });
    }
  }

  /**
   * Scan for new item entities within 2.5 blocks of the broken coord after
   * a configurable settle delay. Drops appear ~1-3 server ticks after the
   * break packet; mineflayer exposes the held item via metadata index 8
   * (1.16+) or 7 (older).
   */
  async function scanDrops(b, targetPos, beforeDropIds) {
    const dropScanMs = config.behaviors.digDropScanMs;
    await sleep(dropScanMs);
    const dropped = [];
    for (const e of Object.values(b.entities)) {
      if (e.name !== 'item' && e.displayName !== 'Item') continue;
      if (beforeDropIds.has(e.id)) continue;
      if (!e.position || e.position.distanceTo(targetPos) > 2.5) continue;
      const meta = e.metadata?.[8] || e.metadata?.[7];
      const itemName = meta?.itemId
        ? (ctx.world.mcData.items[meta.itemId]?.name || `item:${meta.itemId}`)
        : (e.displayName || 'unknown');
      const count = meta?.itemCount ?? meta?.count ?? 1;
      dropped.push({ name: itemName, count, position: posObj(e.position) });
    }
    return dropped;
  }

  /**
   * F72: push the dig's drops to ctx.runtime.recentPickups. The auto-pickup
   * magnet (1.5-block radius) typically grabs these within a tick or two,
   * earlier than this handler can reliably snapshot inventory. The collect-
   * side handler double-checks inventory before short-circuiting, so a drop
   * outside pickup range won't lead to a false success.
   */
  function pushRecentPickups(dropped) {
    const now = Date.now();
    if (Array.isArray(ctx.runtime.recentPickups)) {
      ctx.runtime.recentPickups = ctx.runtime.recentPickups
        .filter((p) => (now - p.ts) < 30_000)
        .slice(-11);
    } else {
      ctx.runtime.recentPickups = [];
    }
    for (const d of dropped) {
      if (!d?.name || !(d.count > 0)) continue;
      ctx.runtime.recentPickups.push({ ts: now, item: d.name, count: d.count, source: 'dig' });
    }
  }

  /** Compose the ok() success envelope for a completed dig. */
  function buildSuccessEnvelope(b, target, x, y, z, dropped, breach, tipSet) {
    const tips = [...tipSet];
    const breachFields = breach ? buildBreachFields(b, breach) : null;
    const breachSuffix = breachFields
      ? ` ⚠ ${breachFields.severity === 'critical' ? 'LAVA' : 'WATER'} BREACH at ${breach.breach_cell.x},${breach.breach_cell.y},${breach.breach_cell.z} — ${breachFields.hint}`
      : '';
    return ok({
      data: {
        block_name: target.name,
        dropped_items: dropped,
        position_after: posObj(b.entity.position),
        ...(breach ? { breach } : {}),
      },
      // Preserve legacy field so existing callers (goal engine, older tests) still see it.
      result: `Mined ${target.name} at ${x}, ${y}, ${z}${tips.length ? ` Tips: ${tips.join(' | ')}` : ''}${breachSuffix}`,
      ...(tips.length ? { hints: tips } : {}),
      ...(breachFields ? { next_action_hint: breachFields.next_action_hint } : {}),
    });
  }

  // ─ Phase-2 action contract:
  //   success: { ok: true, data?, result?, ... }
  //   failure: { ok: false, error: { code, message, observed_state?, ..., retry_safe } }
  // The HTTP wrapper spreads results, so ok=false propagates intact.
  async function dig(args) {
    const c = coord3(args);
    if (!c.ok) return c.response;
    const { x, y, z } = c;
    const force = args.force;
    const b = ensureBot();
    const target = b.blockAt(new Vec3(x, y, z));
    const cell = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
    const tracker = createDigFailureTracker(ctx, cell, () => target?.name);
    // Was this a stair_down tread? (Only reachable past the guard when forced.)
    const forcedThroughEgress = !!force && isEgressProtectedCell(egressTreadCells(ctx), x, y, z);

    // 1) Repeat-fail short-circuit — stop hammering a genuinely-stuck cell.
    const prior = tracker.priorRepeat();
    if (prior) {
      return fail(
        'DIG_BLOCKED_REPEAT',
        `Failed to dig (${cell.x},${cell.y},${cell.z}) ${prior.hit_count}× in the last 60s (last code: ${prior.code}). The block is genuinely unreachable from your current angle. Stop retrying — pillar away, approach from a different side, or call mc advise.`,
        {
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
      );
    }

    // 2) Sequential pre-dig guards (region, protection, self-block, water, door support).
    const guardFail = runPreDigGuards(b, x, y, z, cell, target, force, tracker);
    if (guardFail) return guardFail;

    const distance = b.entity.position.distanceTo(target.position);

    // 3) Equip the right tool, or bail with TOOL_INADEQUATE. force=true
    // (mc dig --force) bypasses the slow-dig refusal so a trapped bot can
    // bare-hand its way out — stone bare-hand is legal in MC, just slow.
    const equipResult = await equipOrFail(b, target, distance, tracker, force);
    if (equipResult.err) return equipResult.err;

    // 4) Approach if out of reach.
    const approachFail = await approachOrFail(b, target, x, y, z, distance, tracker);
    if (approachFail) return approachFail;

    // 5) Verify line-of-sight from the (possibly new) position.
    const losFail = assertLineOfSight(b, x, y, z, target, tracker);
    if (losFail) return losFail;

    // 6) Snapshot drop-entity ids so we can diff after the dig.
    const beforeDropIds = new Set(
      Object.values(b.entities)
        .filter((e) => e.name === 'item' || e.displayName === 'Item')
        .map((e) => e.id),
    );

    // 7) The dig itself.
    const digFail = await performDig(b, target, x, y, z, tracker);
    if (digFail) return digFail;

    // 8) Post-dig: drop scan, recentPickups push, breach detection, clear failure ring.
    const dropped = await scanDrops(b, target.position, beforeDropIds);
    pushRecentPickups(dropped);
    // detectPostDigBreach uses settleMs:0 because scanDrops already slept
    // ~digDropScanMs — that gives flowing water 1-3 cells of spread, enough
    // for a face-neighbour source to reach the dug cell. Lava is slower
    // (~30 ticks/cell) but face-adjacent lava still flows in within window.
    const breach = await detectPostDigBreach(b, { x, y, z }, { settleMs: 0 });
    tracker.clearForCell();
    // Forced through our own staircase: the retrace trail is now broken.
    if (forcedThroughEgress) clearEgressTrail(ctx, 'dig_force_through_tread');

    return buildSuccessEnvelope(b, target, x, y, z, dropped, breach, new Set(equipResult.hints));
  }

  function createSafeDig(invokeDig) {
    return async function safe_dig({ x, y, z, force }) {
      const b = ensureBot();
      if (![x, y, z].every((v) => Number.isFinite(Number(v)))) {
        return fail('INVALID_COORD', 'mc safe_dig requires numeric x, y, z', { retry_safe: false });
      }
      const tx = Math.floor(Number(x)), ty = Math.floor(Number(y)), tz = Math.floor(Number(z));
      if (force) return invokeDig({ x: tx, y: ty, z: tz, force: true });

      const target = b.blockAt(new Vec3(tx, ty, tz));
      if (!target || AIR_NAMES.has(target.name)) {
        return fail(
          'NO_BLOCK_AT_COORD',
          `No block at ${tx}, ${ty}, ${tz} — target is ${target?.name || 'unknown'}`,
          {
            observed_state: { block_at_target: target?.name || null, requested_coord: { x: tx, y: ty, z: tz } },
            retry_safe: false,
          },
        );
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
        return fail(code, messages[code], {
          observed_state: { block_at_target: target.name, requested_coord: { x: tx, y: ty, z: tz }, hazard },
          retry_safe: false,
        });
      }

      return invokeDig({ x: tx, y: ty, z: tz });
    };
  }

  return { dig, createSafeDig };
}
