import { Vec3 } from 'vec3';
import { findAdjustedTarget } from '../_nav-helpers.js';
import { executeServerCommand, paperMcpConfig } from '../../runtime/paper-mcp.js';
import { fail } from './_contract.js';

export function createDisembarkHandlers({ ensureBot, ACTIONS, sleep, log, getMyName }) {

  async function disembark(opts = {}) {
  const b = ensureBot();
  const emergency = !!opts.emergency;
  // Phase 6 follow-up (circuit-v8 postmortem): sail()'s BOAT_STUCK
  // fallback calls disembark, and if the boat is in water disembark
  // calls sail-to-shore — which can stall and recurse back into
  // disembark. The `fromSailFallback` opt breaks the loop by
  // skipping the auto-sail-to-shore step when sail is the caller.
  const fromSailFallback = !!opts.fromSailFallback;
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
  // Phase 6 follow-up: positional stale-vehicle reaper. mineflayer
  // sometimes keeps b.vehicle pointing at a boat the bot is no
  // longer riding (PaperMCP ride dismount races, server-side
  // teleports, packet corruption). If the bot's own position is
  // > 16 blocks horizontally from the vehicle, it's clearly not
  // riding — clear the stale ref instead of trying to dismount.
  if (b.vehicle && b.entity?.position && b.vehicle.position) {
    const dx = b.entity.position.x - b.vehicle.position.x;
    const dz = b.entity.position.z - b.vehicle.position.z;
    const horiz = Math.hypot(dx, dz);
    if (horiz > 16) {
      const stale = b.vehicle.name;
      const vpos = b.vehicle.position;
      b.vehicle = null;
      return {
        ok: true,
        command: 'disembark',
        data: {
          dismounted_from: stale,
          note: `bot was ${horiz.toFixed(1)}b from vehicle — cleared stale b.vehicle ref`,
          bot_pos: [Number(b.entity.position.x.toFixed(1)), Number(b.entity.position.y.toFixed(1)), Number(b.entity.position.z.toFixed(1))],
          vehicle_pos: [Number(vpos.x.toFixed(1)), Number(vpos.y.toFixed(1)), Number(vpos.z.toFixed(1))],
        },
      };
    }
  }
  // Task #66: when caller passes target_shore explicitly (sail_to's
  // disembark phase OR sail()'s failure recovery), we know EXACTLY
  // where Steve should end up. RCON-kill any nearby boat and TP
  // Steve directly onto the dry cell. This works whether the bot
  // is currently mounted, swimming on water surface, or actually
  // submerged — anywhere except deeply on land we want a clean
  // shore landing. Runs BEFORE the NOT_MOUNTED check so it also
  // handles "boat already died, Steve is in water" recovery.
  const targetShore = opts.target_shore;
  if (targetShore
      && Number.isFinite(targetShore.x)
      && Number.isFinite(targetShore.y)
      && Number.isFinite(targetShore.z)) {
    const pmcp = paperMcpConfig();
    const username = getMyName?.();
    if (pmcp && username) {
      const sx = Math.floor(targetShore.x);
      const sy = Math.floor(targetShore.y);
      const sz = Math.floor(targetShore.z);
      const vid = b.vehicle?.id;
      const vname = b.vehicle?.name || 'oak_boat';
      const bx = Math.floor(b.entity.position.x);
      const by = Math.floor(b.entity.position.y);
      const bz = Math.floor(b.entity.position.z);
      // Kill any boat at the bot's current position (no-op if none).
      const killCmd = `execute positioned ${bx} ${by} ${bz} run kill @e[type=#minecraft:boat,distance=..3,limit=1]`;
      const tpCmd = `tp ${username} ${sx + 0.5} ${sy} ${sz + 0.5}`;
      await executeServerCommand(pmcp, killCmd).catch(() => null);
      await sleep(150);
      const tpRes = await executeServerCommand(pmcp, tpCmd).catch(() => ({ ok: false }));
      await sleep(200);
      if (tpRes && tpRes.ok) {
        if (b.entity && b.entity.position) {
          b.entity.position.x = sx + 0.5;
          b.entity.position.y = sy;
          b.entity.position.z = sz + 0.5;
        }
        b.vehicle = null;
        return {
          ok: true,
          command: 'disembark',
          data: {
            dismounted_from: vname,
            vehicle_id: vid ?? null,
            landed_at: [sx, sy, sz],
            fallback: 'rcon_shore_tp',
          },
        };
      }
    }
  }

  if (!b.vehicle) {
            return fail('NOT_MOUNTED', 'Bot is not in a vehicle.', { retry_safe: false });
  }
  const wasVehicle = b.vehicle.name;
  let fallback = null;

  // High-level contract (task #19): if the boat is currently in open
  // water, scan for the nearest standable shore within 16 blocks and
  // sail there first so the agent doesn't disembark into deep water.
  // Skipped when called from sail's stall/collision fallback —
  // otherwise disembark → sail → disembark recurses forever.
  let autoSailed = null;
  {
    const boatPos = b.vehicle.position;
    const below = b.blockAt(boatPos.offset(0, -1, 0));
    const inOpenWater = !!below && (below.name === 'water' || below.name === 'flowing_water');
    if (inOpenWater && !fromSailFallback) {
      const isStandableLand = (bot, px, py, pz) => {
        const foot = bot?.blockAt && bot.blockAt(new Vec3(px, py, pz));
        const head = bot?.blockAt && bot.blockAt(new Vec3(px, py + 1, pz));
        const belowSolid = bot?.blockAt && bot.blockAt(new Vec3(px, py - 1, pz));
        if (!foot || !head || !belowSolid) return false;
        const isAirish = (n) => n === 'air' || n === 'cave_air' || n === 'void_air';
        const isWater = (n) => n === 'water' || n === 'flowing_water';
        if (!isAirish(foot.name)) return false;
        if (!isAirish(head.name)) return false;
        if (belowSolid.boundingBox !== 'block') return false;
        if (isWater(belowSolid.name)) return false;
        return true;
      };
      const shore = findAdjustedTarget(
        b,
        isStandableLand,
        Math.floor(boatPos.x),
        Math.floor(boatPos.y),
        Math.floor(boatPos.z),
        12,
      );
      if (shore && shore.adjusted && shore.distance >= 2) {
        log(`[disembark] in open water — auto-sailing to shore at ${shore.x},${shore.y},${shore.z} (distance ${shore.distance})`);
        try {
          const sailRes = await ACTIONS.sail({ x: shore.x, y: shore.y, z: shore.z, timeout_seconds: 30, _from_sail_to: true });
          autoSailed = {
            ok: !!sailRes?.ok,
            shore: { x: shore.x, y: shore.y, z: shore.z, distance: shore.distance },
            ...(sailRes?.data ? { sail_data: sailRes.data } : {}),
            ...(sailRes?.error ? { sail_error: sailRes.error } : {}),
          };
        } catch (e) {
          autoSailed = { ok: false, shore: { x: shore.x, y: shore.y, z: shore.z }, error: e?.message || String(e) };
        }
        await sleep(200);
      }
    }
  }
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
      const r = await executeServerCommand(pmcp, `ride ${username} dismount`).catch((e) => ({ ok: false, error: e?.message }));
      await sleep(400);
      if (r && r.ok) {
        // Server says we're not riding; clear stale mineflayer state.
        b.vehicle = null;
        fallback = 'papermcp_server_side';
      }
    }
  }
  if (b.vehicle) {
    // Last-resort: forcibly destroy the vehicle entity via RCON.
    // Vanilla MC drops riders when their boat breaks. We lose the
    // boat but free Steve. Originally gated on emergency=true (only
    // the reactive auto_disembark_low_hp path used it); circuit-v11
    // showed the agent's plain `mc disembark` getting stuck in a
    // DISMOUNT_REJECTED loop because every prior path silently
    // failed and the force-kill was skipped. Now any caller gets
    // the escalation — a free rider with no boat is always better
    // than a stranded mounted bot.
    const pmcp = paperMcpConfig();
    if (pmcp && b.vehicle) {
      const vid = b.vehicle.id;
      const vname = b.vehicle.name || 'boat';
      const bx = Math.floor(b.entity.position.x);
      const by = Math.floor(b.entity.position.y);
      const bz = Math.floor(b.entity.position.z);
      try {
        log(`[disembark] ${emergency ? 'EMERGENCY' : 'last-resort'} — force-killing vehicle ${vname}#${vid} via RCON`);
        const r = await executeServerCommand(
          pmcp,
          `execute positioned ${bx} ${by} ${bz} run kill @e[type=#minecraft:boat,distance=..3,limit=1]`,
        ).catch(() => ({ ok: false }));
        await sleep(400);
        // Vehicle entity dies → mineflayer's entityGone handler
        // clears b.vehicle. Trust the entity-list check first.
        // Only fall back to clearing manually if the RCON command
        // returned ok — otherwise we'd risk desyncing (server still
        // has Steve riding, mineflayer thinks not).
        if (b.vehicle && !b.entities[b.vehicle.id]) {
          b.vehicle = null;
          fallback = 'rcon_force_kill';
        } else if (b.vehicle && b.vehicle.id === vid && r && r.ok) {
          b.vehicle = null;
          fallback = 'rcon_force_kill';
        }
      } catch (e) {
        log(`[disembark] force-kill failed: ${e?.message || e}`);
      }
    }
  }
  if (b.vehicle) {
            return fail('DISMOUNT_REJECTED', 'Server did not confirm dismount even after RCON force-kill. Vehicle entity is sticky; agent should mc respawn or wait it out.', { retry_safe: true });
  }

  // After dismount: detect any UNSAFE foot cell and recover before
  // handing back to the agent.
  //
  //   - foot=water  →  chain mc escape (drown-protection;
  //                    circuit-v5f original case).
  //   - foot=solid  →  bot is SUFFOCATING inside a block (F33,
  //                    task #66, v48 — boat wedged at (360.9, 63,
  //                    -541.7) under a pre-existing cobblestone
  //                    wall; force-disembark dropped Steve inside
  //                    the cobble; he took 1 dmg/0.5s with no
  //                    auto-recovery). TP up the same column to
  //                    the first air cell with air-above
  //                    (2-block standing clearance).
  let autoEscape = null;
  let autoRescue = null;
  await sleep(300); // let physics settle so foot block is accurate
  const footPos = b.entity.position.floored();
  const footBlk = b.blockAt(footPos);
  const stillInWater = !!footBlk && (footBlk.name === 'water' || footBlk.name === 'flowing_water');
  const suffocating = !!footBlk
    && footBlk.name !== 'air' && footBlk.name !== 'cave_air' && footBlk.name !== 'void_air'
    && footBlk.name !== 'water' && footBlk.name !== 'flowing_water'
    && footBlk.boundingBox === 'block';
  if (suffocating) {
    // Scan up the bot's column for the first air-foot + air-head
    // pair sitting on something solid. Cap at 8 blocks — any
    // deeper would be a different problem (mineshaft / chasm).
    let rescueY = null;
    for (let dy = 1; dy <= 8; dy++) {
      const ty = footPos.y + dy;
      const foot = b.blockAt(new Vec3(footPos.x, ty, footPos.z));
      const head = b.blockAt(new Vec3(footPos.x, ty + 1, footPos.z));
      const below = b.blockAt(new Vec3(footPos.x, ty - 1, footPos.z));
      const isAirish = (blk) => blk && (blk.name === 'air' || blk.name === 'cave_air' || blk.name === 'void_air');
      const isSolidStand = below && below.boundingBox === 'block'
        && below.name !== 'water' && below.name !== 'flowing_water' && below.name !== 'lava';
      if (isAirish(foot) && isAirish(head) && isSolidStand) {
        rescueY = ty;
        break;
      }
    }
    try {
      const pmcp = paperMcpConfig();
      const safeY = rescueY ?? (footPos.y + 4);
      if (pmcp) {
        await executeServerCommand(pmcp, `tp ${getMyName()} ${footPos.x + 0.5} ${safeY} ${footPos.z + 0.5}`);
      } else {
        await b.chat(`/tp ${getMyName()} ${footPos.x + 0.5} ${safeY} ${footPos.z + 0.5}`);
      }
      await sleep(300);
      autoRescue = {
        ok: true,
        from: { x: footPos.x, y: footPos.y, z: footPos.z, foot_block: footBlk.name },
        to: { x: footPos.x, y: safeY, z: footPos.z },
        rescue_strategy: rescueY != null ? 'air_column_scan' : 'tp_up_4',
      };
      log(`[disembark] suffocation rescue — TP from ${footPos.x},${footPos.y},${footPos.z} (${footBlk.name}) → ${footPos.x},${safeY},${footPos.z}`);
    } catch (e) {
      autoRescue = { ok: false, error: e?.message || String(e), from: { x: footPos.x, y: footPos.y, z: footPos.z, foot_block: footBlk.name } };
      log(`[disembark] suffocation rescue failed: ${e?.message || e}`);
    }
  }
  if (stillInWater) {
    try {
      const escRes = await ACTIONS.escape({});
      autoEscape = {
        ok: !!escRes?.ok,
        ...(escRes?.data ? { details: escRes.data } : {}),
        ...(escRes?.error ? { error: escRes.error } : {}),
      };
    } catch (e) {
      autoEscape = { ok: false, error: e?.message || String(e) };
    }
  }

  return {
    ok: true,
    command: 'disembark',
    data: {
      dismounted_from: wasVehicle,
      bot_position: [Math.floor(b.entity.position.x), Math.floor(b.entity.position.y), Math.floor(b.entity.position.z)],
      ...(fallback ? { fallback } : {}),
      ...(autoSailed ? { auto_sailed: autoSailed } : {}),
      ...(autoEscape ? { auto_escape: autoEscape } : {}),
      ...(autoRescue ? { auto_rescue: autoRescue } : {}),
    },
  };

}

  return { disembark };
}

