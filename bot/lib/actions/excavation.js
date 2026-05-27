import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { equipForDig, DIG_PASSABLE_NAMES, nudgeOffStandPillar, detectDigHazards, isDigProtected } from '../runtime/dig-tools.js';
import { shouldSkipDigAt, createRegionSkipTracker } from '../runtime/regions/policy-guard.js';
import { ok, fail } from '../shared/action-contract.js';
import { cardinalDelta } from './_directions.js';
import { box6 } from './_args.js';
import { pathfindGotoNear, pathfindWithProgressWatchdog, ACTION_CAPS_MS } from './_helpers.js';

const { goals } = pathfinderPkg;

/**
 * createExcavationActions — extracted from former lib/actions/world.js (Phase 4 split).
 */
export function createExcavationActions(services) {
  const { state: ctx, config, ensureBot, utils, social, resolver, fairPlay, getActions } = services;
  const { fmt, posObj, sleep, log } = utils;
  const { resolveInventoryItem } = resolver;
  const { rememberSocialEvent, getMyName } = social;
  const { hasLineOfSight, eyePosition } = fairPlay;

  const cardinalDeltaOrFail = (direction) => {
    const r = cardinalDelta(direction);
    if (!r) {
      return {
        ok: false,
        response: fail('INVALID_VALUE', `Invalid direction "${direction}". Use north|south|east|west.`, { retry_safe: false }),
      };
    }
    return { ok: true, ...r, key: r.key.toLowerCase() };
  };

  const tunnelSliceBounds = ({ x, y, z, direction, width, height }) => {
    const parsed = cardinalDeltaOrFail(direction);
    if (!parsed.ok) return parsed;
    const { dx, dz } = parsed;
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
  async dig_area(args) {
    const boxParsed = box6(args);
    if (!boxParsed.ok) return boxParsed.response;
    const { x1, y1, z1, x2, y2, z2 } = boxParsed;
    const pickupRaw = args.pickup;
    const abort_on_fail = args.abort_on_fail;
    const clear_stand = args.clear_stand;
    const safe = args.safe;
    const doPickup = pickupRaw !== undefined ? pickupRaw : true;
    const abortOnFail = abort_on_fail === true || abort_on_fail === 'true';
    const clearStand = clear_stand !== false && clear_stand !== 'false';
    const safeDig = safe !== false && safe !== 'false';

    const b = ensureBot();
    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
    const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
    const total = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
    // Cap lowered from 500 → 32 on 2026-05-27.
    if (total > 32) {
      return fail('AREA_TOO_LARGE', `mc dig_area: ${total} blocks is too many — the per-call limit is 32. Run ${Math.ceil(total / 32)} smaller calls instead, each with ≤32 blocks.`, {
        observed_state: { requested_volume: total, max_volume: 32, x1, y1, z1, x2, y2, z2 },
        next_action_hint: `Pick a sub-box with ≤32 blocks (e.g. a ${Math.min(maxX - minX + 1, 4)}×${Math.min(maxY - minY + 1, 4)}×${Math.min(maxZ - minZ + 1, 2)} slice) and repeat for the rest.`,
        retry_safe: false,
      });
    }

    let dug = 0;
    let skipped = 0;
    /** @type {string[]} */
    const errors = [];
    /** @type {Set<string>} */
    const digHintSet = new Set();
    const regionSkips = createRegionSkipTracker();

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
        const skipDig = shouldSkipDigAt(ctx, config, target.name, pos.x, pos.y, pos.z, isDigProtected);
        if (skipDig.skip) {
          if (skipDig.regionId) regionSkips.noteSkip(skipDig.regionId);
          skipped++;
          continue;
        }

        // Hazard pre-check — abort the whole op if a hazard cell is encountered.
        // Caller opts out with safe: false.
        if (safeDig) {
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
              await pathfindGotoNear(b, goals, pos.x, pos.y, pos.z, 3, { opName: 'dig_area', capMs: ACTION_CAPS_MS.reach });
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
        const pu = await getActions().pickup();
        pickupResult = pu?.result ? ` ${pu.result}` : '';
      } catch {
        pickupResult = ' (pickup skipped)';
      }
    }

    const digHints = [...digHintSet];
    const tipsSuffix = digHints.length ? ` Tips: ${digHints.join(' | ')}` : '';
    return {
      result: `Dug ${dug} blocks (${skipped} skipped).${pickupResult}${regionSkips.suffix()}${tipsSuffix}${errors.length ? ` Errors: ${errors.slice(0, 3).join('; ')}` : ''}`,
      dug,
      skipped,
      ...regionSkips.dataFields(),
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
    const dirParsed = cardinalDeltaOrFail(direction);
    if (!dirParsed.ok) return dirParsed.response;
    const { dx, dz, key } = dirParsed;

    let totalDug = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    let abortReason = null;
    for (let i = 1; i <= L; i++) {
      const cx = startX + dx * i;
      const cz = startZ + dz * i;
      const box = tunnelSliceBounds({ x: cx, y: startY, z: cz, direction: key, width: W, height: H });
      const res = await getActions().dig_area({
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
        const pu = await getActions().pickup();
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
    // Anchor on the bot's CURRENT block, not the legacy x/y/z params
    // (which were rarely set and caused drift). The bot must already be
    // standing on the cell where the staircase begins.
    const startX = Math.floor(b.entity.position.x);
    const startY = Math.floor(b.entity.position.y);
    const startZ = Math.floor(b.entity.position.z);
    const L = Math.min(Math.max(parseInt(String(length), 10) || 12, 1), 64);
    const H = Math.min(Math.max(parseInt(String(height), 10) || 3, 2), 5);
    // `width` is no longer meaningful in the controlled-sequence
    // implementation — we always dig a 1-wide column directly in front.
    void width;
    const dirParsed = cardinalDeltaOrFail(direction);
    if (!dirParsed.ok) return dirParsed.response;
    const { dx, dz, key } = dirParsed;

    // Yaw values so the bot actually faces the dig direction. b.dig with
    // forceLook will then aim correctly at the column in front.
    // ROOT CAUSE FIX 2026-05-25: cardinalDeltaOrFail returns key as the
    // short-form lowercase (n/s/e/w) — it uppercases the input, looks up
    // DIR_VEC_4, then .toLowerCase()s before returning. So the key here is
    // ALWAYS one of {'n', 's', 'e', 'w'}, NEVER {'north', 'south', ...}.
    // The previous map keyed by full names → yawByKey[key] was undefined
    // for every call → `await b.look(undefined, 0)` made bot.entity.yaw
    // = undefined → mineflayer's 20Hz physics tick computed
    // `(undefined - lastSentYaw) = NaN` and shipped a NaN-yaw look packet
    // until something rewrote yaw. THE source of every NaN-cascade
    // disconnect this session. Identified by YAW_GUARD_TRACE on
    // mason's stair_down south at 22:15:39.
    const yawByKey = { n: Math.PI, s: 0, e: -Math.PI / 2, w: Math.PI / 2 };

    let totalDug = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    const errorMsgs = [];
    let stoppedAtStep = 0;
    const stoppedReason = { value: null };
    const regionSkips = createRegionSkipTracker();

    const digOne = async (px, py, pz) => {
      const blk = b.blockAt(new Vec3(px, py, pz));
      if (!blk) {
        totalSkipped++;
        return false;
      }
      if (DIG_PASSABLE_NAMES.has(blk.name)) {
        return false; // already air, no work needed
      }
      if (blk.name === 'bedrock') {
        totalSkipped++;
        return false;
      }
      const skipDig = shouldSkipDigAt(ctx, config, blk.name, px, py, pz, isDigProtected);
      if (skipDig.skip) {
        if (skipDig.regionId) regionSkips.noteSkip(skipDig.regionId);
        totalSkipped++;
        return false;
      }
      let digTimer = null;
      try {
        await equipForDig(b, blk);
        // Hard timeout — mineflayer's dig() awaits a server blockUpdate
        // and has no internal timeout, so a missing ack hangs forever.
        // CRITICAL: clearTimeout in the finally below, otherwise a stale
        // setTimeout fires later and calls b.stopDigging() during the
        // NEXT dig, cascading aborts across stair_down calls.
        await Promise.race([
          b.dig(blk, true),
          new Promise((_, rej) => {
            digTimer = setTimeout(() => {
              try { b.stopDigging?.(); } catch {}
              rej(new Error('dig timeout (15s)'));
            }, 15000);
          }),
        ]);
        totalDug++;
        await sleep(80);
        return true;
      } catch (err) {
        const msg = err?.message || String(err);
        errorMsgs.push(`(${px},${py},${pz}): ${msg}`);
        totalErrors++;
        return false;
      } finally {
        if (digTimer !== null) clearTimeout(digTimer);
      }
    };

    // Per-step loop: at iteration i, the bot is standing at
    // (startX + dx*(i-1), startY - (i-1), startZ + dz*(i-1)). We dig
    // the 3-tall column ONE block forward (cx = bot.x + dx), with the
    // bottom cell one below the bot's feet (so stepping forward = drop
    // 1). Then we manually walk into the new cell and re-anchor.
    // Capture the bot reference so we can detect mid-flight reconnects.
    // The watchdog's NaN-position recovery (manager.js) closes the old
    // socket and starts a fresh bot instance; the new instance is a
    // different object even if it's bound to the same ctx.world.bot key.
    // If we continue iterating against the stale `b`, our reads return
    // stale or null world data and every dig fails with `(N error)` —
    // the actual scenario observed 2026-05-25 21:42 on flint, where
    // step 1 dug 2 blocks, the watchdog forced a reconnect mid-flight,
    // and step 2 reported `no_progress_at_step_2 (3 error)` against the
    // unloaded post-reconnect chunks.
    const initialBot = ctx.world.bot;

    for (let i = 1; i <= L; i++) {
      // Mid-flight reconnect check. If the bot we started with is no
      // longer the live one, abort cleanly with a clear reason so the
      // worker can retry from a fresh state instead of grinding through
      // unloaded chunks.
      if (ctx.world.bot !== initialBot || !initialBot?.entity) {
        stoppedAtStep = i;
        stoppedReason.value = `reconnect_during_step_${i}`;
        errorMsgs.push(
          `bot reconnected mid-stair_down (probably watchdog NaN-recovery). World state ` +
          `is stale; retry mc stair_down from your current position once the bot is settled.`,
        );
        break;
      }
      // Wait for the bot to be on ground before starting the next step.
      // Without this, a still-falling bot will cancel the first dig
      // with "Digging aborted" because mineflayer aborts on movement.
      {
        let waited = 0;
        while (!b.entity.onGround && waited < 2000) {
          await sleep(100);
          waited += 100;
        }
      }
      // Face the dig direction so b.dig forceLook aims correctly.
      try { await b.look(yawByKey[key], 0, true); } catch {}

      const fx = Math.floor(b.entity.position.x) + dx;
      const fy = Math.floor(b.entity.position.y);
      const fz = Math.floor(b.entity.position.z) + dz;

      // Dig the H-tall column one block forward. h=-1 is the cell the
      // bot will LAND on after stepping forward (one below current feet
      // → descent of 1). h=0 is feet-level. h up to H-2 is head clearance
      // for an H-tall corridor. For default H=3 → 3 cells: 1, 0, -1.
      //
      // Order TOP → BOTTOM (head, body, floor) so we save the
      // support-removing dig for last. The bot's hitbox often straddles
      // the boundary into the forward block (at x=-4.3 the bot's right
      // edge sits at x=-4.0 — flush against block -4). Digging the
      // floor cell removes the support there and gravity pulls the bot
      // down; if that happens BEFORE the head/body cells, the
      // mid-fall b.dig() gets cancelled by mineflayer with
      // "Digging aborted". Doing floor last means the bot falls (or
      // shifts) only after all cells in this step are mined, and the
      // subsequent pathfinder.goto cleanly walks into the new column.
      const targets = [];
      for (let h = H - 2; h >= -1; h--) {
        targets.push({ x: fx, y: fy + h, z: fz });
      }
      let stepDug = 0;
      // Track WHY each target failed so the error envelope is actionable.
      // Without this, "no_progress_at_step_1: dug=0, skipped=0, errors=0"
      // is silent: the worker has no idea whether the targets were already
      // air, the wrong tool tier, region-protected, or what. Observed
      // 2026-05-25: mason tried stair_down south from a cliff edge where
      // the target column was open air; the loop returned dug=0 with no
      // counters, and mason concluded "stair_down is broken" and tried
      // increasingly desperate workarounds (manual dig-and-jump shafts).
      const reasons = { already_air: 0, bedrock: 0, protected: 0, error: 0 };
      for (const t of targets) {
        const blk = b.blockAt(new Vec3(t.x, t.y, t.z));
        const dugIt = await digOne(t.x, t.y, t.z);
        if (dugIt) {
          stepDug++;
          continue;
        }
        if (!blk) { reasons.error++; continue; }
        if (DIG_PASSABLE_NAMES.has(blk.name)) { reasons.already_air++; continue; }
        if (blk.name === 'bedrock') { reasons.bedrock++; continue; }
        // If we got here digOne returned false but block was diggable —
        // either region-protected (shouldSkipDigAt) or a dig error.
        // Region skips don't increment errorMsgs, so if errorMsgs grew
        // we attribute to error; otherwise protected.
        reasons.protected++;
      }
      if (stepDug === 0) {
        stoppedAtStep = i;
        const parts = Object.entries(reasons)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${n} ${k}`);
        const detail = parts.length ? ` (${parts.join(', ')})` : '';
        stoppedReason.value = `no_progress_at_step_${i}${detail}`;
        // If everything was already air, add an explicit hint to the
        // error envelope so the LLM understands the column is open.
        if (reasons.already_air === targets.length) {
          errorMsgs.push(
            `target column at (${fx},${fy - 1}..${fy + H - 2},${fz}) is fully air — you're at a cliff edge or existing tunnel. ` +
            `Move to solid ground first (mc move + mc terrain_top to find a fresh surface), then retry stair_down.`,
          );
        }
        break;
      }

      // CAVE-BELOW guard. The new stand cell is (fx, fy-1, fz); its
      // floor is the block at (fx, fy-2, fz). If that floor is air
      // (cave, chasm, void), stepping into the stand cell drops the bot
      // through. Pathfinder reports "arrived" but server physics
      // diverge: the bot's position packet says "stationary at Y=fy-1"
      // while the server simulation says "still falling" — the
      // mismatch is reported as `invalid_player_movement` and the bot
      // gets kicked, every single step-2 (observed 2026-05-25 on flint
      // when staircase descended into a cave at Y=62 from surface).
      // Abort cleanly with a clear reason so the worker picks a
      // different direction or uses `mc dig` to handle the void
      // manually (placing a support block, then continuing).
      const floorBlock = b.blockAt(new Vec3(fx, fy - 2, fz));
      const floorName = floorBlock?.name || 'unknown';
      const floorIsPassable = !floorBlock || DIG_PASSABLE_NAMES.has(floorName);
      if (floorIsPassable) {
        stoppedAtStep = i;
        stoppedReason.value = `cave_below_step_${i}_floor_is_${floorName}_at_${fx}_${fy - 2}_${fz}`;
        errorMsgs.push(
          `cave_below: floor under next stand cell (${fx},${fy - 1},${fz}) is ${floorName} at (${fx},${fy - 2},${fz}) — bot would fall through. Use mc place to bridge OR pick another direction.`,
        );
        break;
      }

      // Step into the new column. Use pathfinder with a tight goal +
      // short timeout — much smaller than dig_area's open-ended use,
      // because we know exactly which block we want the bot on.
      const standCell = { x: fx, y: fy - 1, z: fz };
      const stepGoal = new goals.GoalBlock(standCell.x, standCell.y, standCell.z);
      try {
        await pathfindWithProgressWatchdog({
          bot: b,
          pathfinderGoto: () => b.pathfinder.goto(stepGoal),
          opName: 'dig_tunnel_step',
          capMs: 5000,
          onStall: () => { try { b.pathfinder.setGoal?.(null); } catch {} },
        });
      } catch {}
      // CRITICAL: stop pathfinder unconditionally before next iteration.
      // Otherwise the next step's b.dig fires while the bot is still
      // walking, and mineflayer cancels with "Digging aborted".
      try { b.pathfinder.setGoal?.(null); } catch {}
      // Small settle so the position read is stable for the next step.
      await sleep(150);

      // Confirm progress: bot should be one block lower than before.
      // If not, the next iteration's dig will re-anchor anyway, but if
      // we don't move at all over two consecutive steps, bail.
      const nowY = Math.floor(b.entity.position.y);
      if (nowY > fy - 1 + 0.5 && i > 1) {
        // No descent — but only bail if the previous step also stalled.
        // Single-step glitches recover on the next iteration.
        stoppedAtStep = i;
        stoppedReason.value = `no_descent_after_step_${i}`;
        break;
      }
    }

    // No exit-ramp dig. The bot at the bottom is in a stone-walled
    // corner BY DESIGN — that's what makes the staircase walkable: the
    // back-direction's foot block IS the SUPPORT for the step-up to
    // the previous tread. Removing it (as an earlier version did)
    // dropped the support and made the staircase un-walkable. The
    // updated trap-detector recognises step-up escapes and classifies
    // this position as 'step_up_only' (not 'trapped'), so mc goto
    // routes the bot back up via pathfinder's jump-step.

    let pickupSuffix = '';
    if (doPickup) {
      try {
        const pu = await getActions().pickup();
        pickupSuffix = pu?.result ? ` ${pu.result}` : '';
      } catch {
        pickupSuffix = ' (pickup skipped)';
      }
    }

    const stepsCompleted = stoppedAtStep ? stoppedAtStep - 1 : L;
    const endX = startX + dx * stepsCompleted;
    const endY = startY - stepsCompleted;
    const endZ = startZ + dz * stepsCompleted;
    return {
      result: stoppedAtStep
        ? `Stair down ${key} stopped at step ${stoppedAtStep}/${L} (${stoppedReason.value}): dug ${totalDug}, skipped ${totalSkipped}, errors ${totalErrors}.${pickupSuffix}${regionSkips.suffix()}`.trim()
        : `Stair down ${key} length ${L}: dug ${totalDug}, skipped ${totalSkipped}, errors ${totalErrors}.${pickupSuffix}${regionSkips.suffix()}`.trim(),
      dug: totalDug,
      skipped: totalSkipped,
      errors: totalErrors,
      ...regionSkips.dataFields(),
      ...(errorMsgs.length ? { error_messages: errorMsgs.slice(0, 5) } : {}),
      ...(stoppedAtStep ? { stopped_at_step: stoppedAtStep, stopped_reason: stoppedReason.value } : {}),
      start: { x: startX, y: startY, z: startZ },
      end: { x: endX, y: endY, z: endZ },
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
    const dirParsed = cardinalDeltaOrFail(direction);
    if (!dirParsed.ok) return dirParsed.response;
    const { dx, dz, key } = dirParsed;

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

      // #88: clear the "ceiling" cell directly above the bot's CURRENT
      // head before each step. tunnelSliceBounds digs the slice at the
      // NEW position (offset horizontally), so the cell at (curX, curY+2,
      // curZ) — the cell the bot's head passes through during its jump —
      // is NOT covered. Without this, stair_up bonks into a low ceiling
      // a few steps in and hangs.
      const bx = Math.floor(b.entity.position.x);
      const by = Math.floor(b.entity.position.y);
      const bz = Math.floor(b.entity.position.z);
      const ceilingPos = new Vec3(bx, by + 2, bz);
      const ceilingBlk = b.blockAt(ceilingPos);
      if (ceilingBlk && ceilingBlk.boundingBox === 'block') {
        const skipDig = shouldSkipDigAt(ctx, config, ceilingBlk.name, bx, by + 2, bz, isDigProtected);
        if (!skipDig.skip) {
          try {
            await equipForDig(b, ceilingBlk);
            await b.dig(ceilingBlk, true);
            totalDug++;
          } catch { /* not catastrophic; dig_area may compensate */ }
        }
      }

      const box = tunnelSliceBounds({ x: cx, y: cy, z: cz, direction: key, width: W, height: H });
      const res = await getActions().dig_area({
        ...box,
        pickup: false,
        abort_on_fail: false,
        clear_stand: true,
      });
      if (res && res.ok === false) {
        return res;
      }
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
        await pathfindGotoNear(b, goals, cx, cy, cz, 1, { opName: 'dig_stair', capMs: ACTION_CAPS_MS.reach });
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
        const pu = await getActions().pickup();
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

  /**
   * #99: pillar_down — descend the column the bot is standing on.
   *
   * Iteratively dig the block directly underfoot, allow the bot to drop
   * one cell, then repeat. Inverse of mc pillar_step. Use when stuck on
   * top of a 1×1 column climbed with pillar_step (or any other reason
   * the bot ended up on an isolated platform).
   *
   * Safety:
   *   - Stops if the block 2 below is lava or void air (we don't drop
   *     into a hazard).
   *   - Stops on bedrock or any dig-protected block (we can't mine it).
   *   - Stops when the new foot level has solid ground in ≥3 cardinal
   *     directions (we've reached a surface, no longer pillar-stuck).
   *
   * Picks up drops after each step by default; set `pickup: false` to
   * skip (faster, but the agent has to call mc pickup later).
   */
  async pillar_down({ count: rawCount, pickup: doPickup = true } = {}) {
    const b = ensureBot();
    const maxSteps = Math.min(Math.max(parseInt(rawCount, 10) || 12, 1), 64);

    const isAirLike = (blk) => blk && (blk.name === 'air' || blk.name === 'cave_air' || blk.name === 'void_air');
    const isHazardBelow = (blk) => {
      if (!blk) return false;
      return blk.name === 'lava' || blk.name === 'void_air';
    };

    const startY = Math.floor(b.entity.position.y);
    let dugCount = 0;
    let stopReason = null;
    let lastDugBlock = null;

    for (let step = 0; step < maxSteps; step++) {
      const fx = Math.floor(b.entity.position.x);
      const fy = Math.floor(b.entity.position.y);
      const fz = Math.floor(b.entity.position.z);
      const underfoot = b.blockAt(new Vec3(fx, fy - 1, fz));

      if (!underfoot || isAirLike(underfoot)) {
        // Nothing to dig — bot is already in air, will fall naturally.
        stopReason = 'no_support_below';
        break;
      }
      // Refuse to dig if doing so drops the bot into lava / void.
      const twoBelow = b.blockAt(new Vec3(fx, fy - 2, fz));
      if (isHazardBelow(twoBelow)) {
        stopReason = `hazard_below:${twoBelow?.name || 'unknown'}`;
        break;
      }
      if (underfoot.name === 'bedrock') {
        stopReason = `cant_break:${underfoot.name}`;
        break;
      }
      const skipDig = shouldSkipDigAt(ctx, config, underfoot.name, fx, fy - 1, fz, isDigProtected);
      if (skipDig.skip) {
        stopReason = skipDig.regionId ? `region_protected:${skipDig.regionId}` : `cant_break:${underfoot.name}`;
        break;
      }

      try {
        await equipForDig(b, underfoot);
        await b.dig(underfoot, true);
        dugCount++;
        lastDugBlock = underfoot.name;
        // Let the bot settle on the new platform.
        await sleep(150);
      } catch (err) {
        stopReason = `dig_failed:${/** @type {Error} */ (err).message || 'unknown'}`;
        break;
      }

      // Check: did we reach a surface? If 3+ cardinal cells at the NEW
      // foot level have solid floor beneath, we've landed on real ground.
      const newFy = Math.floor(b.entity.position.y);
      let solidNeighbors = 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const neighborFloor = b.blockAt(new Vec3(fx + dx, newFy - 1, fz + dz));
        const neighborFoot = b.blockAt(new Vec3(fx + dx, newFy, fz + dz));
        if (neighborFloor && neighborFloor.boundingBox === 'block' && isAirLike(neighborFoot)) {
          solidNeighbors++;
        }
      }
      if (solidNeighbors >= 3) {
        stopReason = 'reached_surface';
        break;
      }
    }

    let pickupSuffix = '';
    if (doPickup && dugCount > 0) {
      try {
        const pu = await getActions().pickup();
        pickupSuffix = pu?.result ? ` ${pu.result}` : '';
      } catch {
        pickupSuffix = ' (pickup skipped)';
      }
    }

    const endY = Math.floor(b.entity.position.y);
    if (!stopReason && dugCount === maxSteps) stopReason = 'max_steps_reached';

    return {
      result: `pillar_down dug ${dugCount} block${dugCount === 1 ? '' : 's'}: Y ${startY} → ${endY}${lastDugBlock ? ` (last: ${lastDugBlock})` : ''}. Stop reason: ${stopReason || 'unknown'}.${pickupSuffix}`,
      dug: dugCount,
      startY,
      endY,
      stop_reason: stopReason,
      last_block: lastDugBlock,
      position: { x: Math.floor(b.entity.position.x), y: endY, z: Math.floor(b.entity.position.z) },
    };
  },

  // ── Interaction ─────────────────────────────────
  };
}
