import { Vec3 } from 'vec3';
import { findAdjustedTarget } from '../_nav-helpers.js';
import { executeServerCommand, paperMcpConfig } from '../../runtime/paper-mcp.js';
import { planBoatPath, executeBoatPath, bestEffortSail } from '../../runtime/boat-path.js';
import { useSailToInsteadRefusal } from './_refusal.js';
import { fail } from './_contract.js';

export function createSailLegHandlers({ ensureBot, sleep, log, ACTIONS }) {

async function sail({ x, y, z, timeout_seconds: _ts, allow_shore_early_exit: _ase, _from_sail_to, precomputed_path } = {}) {
  if (!_from_sail_to) return useSailToInsteadRefusal('sail');
  const b = ensureBot();
  const target = new Vec3(Number(x), Number(y), Number(z));

  if (!b.vehicle) {
    return fail('NOT_MOUNTED', 'Bot is not in a vehicle. Run mc board first.', { retry_safe: false });
  }
  const boat = b.entities[b.vehicle.id] || b.vehicle;
  const isBoat = boat?.name?.endsWith?.('_boat') || boat?.name === 'boat' || boat?.name === 'bamboo_raft';
  if (!isBoat) {
    return fail('NOT_A_BOAT', `Mounted on ${boat?.name || 'unknown'}, not a boat.`, { retry_safe: false });
  }

  const startPos = boat.position.clone();
  // Two planning paths:
  //   precomputed_path  → the caller (sail_to) already has the dense
  //     BFS water-cell path; we convert each cell to a boat waypoint
  //     and follow it directly. Guaranteed cell-by-cell navigable
  //     because the BFS only expanded into sailable cells.
  //   no precomputed_path  → fall back to planBoatPath's straight-line
  //     planner with perpendicular shifts. Useful for ad-hoc legs.
  let plan;
  let drive;
  let usedFallback = false;
  if (Array.isArray(precomputed_path) && precomputed_path.length > 0) {
    // Convert water-cell coords to boat waypoints (cell-center XZ +
    // boat float offset). Then check the first cell matches the
    // boat's current column (otherwise the caller has a stale path).
    const dy = 1.0625; // boat float offset above water_cell.y
    const boatPath = precomputed_path.map((c) => ({
      x: Math.floor(c.x) + 0.5,
      y: Math.floor(c.y) + dy,
      z: Math.floor(c.z) + 0.5,
    }));
    plan = { ok: true, path: boatPath, water_y: Math.floor(precomputed_path[0].y), source: 'precomputed' };
    drive = await executeBoatPath(b, boatPath, {
      executeServerCommand,
      paperMcpConfig,
      sleep,
      log,
    });
  } else {
    // Plan a collision-safe boat path from current boat position to
    // target. The planner snaps to cell centers, checks each step's
    // hitbox against blockAt, and shifts ±1/±2 perpendicular around
    // y=water_y obstacles.
    plan = planBoatPath(b, startPos, target);
    if (plan.ok) {
    // Easy case: drive the boat along the precomputed path.
    drive = await executeBoatPath(b, plan.path, {
      executeServerCommand,
      paperMcpConfig,
      sleep,
      log,
    });
  } else if (plan.reason === 'NARROW_CHANNEL') {
    // Precomputed path threads through a corridor too tight for
    // the ±2 perpendicular shift to clear. Drop into best-effort
    // packet-steering: same vehicle_move + player_input mechanism,
    // but with per-tick collision probes that refuse to push the
    // boat into a solid block. Vanilla physics handles drift around
    // small obstacles; we just halt if walled in.
    if (log) log(`[sail] planBoatPath returned NARROW_CHANNEL — falling back to bestEffortSail`);
    usedFallback = true;
    drive = await bestEffortSail(b, target, { sleep, log });
  } else {
    // NOT_ON_WATER or other unrecoverable plan failures — auto-
    // disembark so Steve isn't stranded mid-ocean.
    let autoDisembark = null;
    if (ACTIONS && typeof ACTIONS.disembark === 'function') {
      try {
        const dis = await ACTIONS.disembark({ fromSailFallback: true });
        autoDisembark = { ok: !!dis?.ok, ...(dis?.data ? { data: dis.data } : {}), ...(dis?.error ? { error: dis.error } : {}) };
      } catch (e) {
        autoDisembark = { ok: false, error: e?.message || String(e) };
      }
    }
    return fail(
      'PATH_BLOCKED',
      `Could not find a collision-safe boat path to (${Math.floor(target.x)},${Math.floor(target.y)},${Math.floor(target.z)}): ${plan.message || plan.reason}.${autoDisembark?.ok ? ' Auto-disembarked.' : ''}`,
      {
        observed_state: {
          boat_pos: [Number(startPos.x.toFixed(2)), Number(startPos.y.toFixed(2)), Number(startPos.z.toFixed(2))],
          target: [Number(target.x), Number(target.y), Number(target.z)],
          plan_reason: plan.reason,
          blockers: plan.blockers || [],
          water_y: plan.water_y ?? null,
          ...(autoDisembark ? { auto_disembark: autoDisembark } : {}),
        },
        next_action_hint: autoDisembark?.ok ? 'mc status' : 'mc disembark',
        retry_safe: false,
      },
    );
  }
  } // close outer else (precomputed_path)

  if (!drive.ok) {
    // Boat died mid-sail (entity attacked, despawn, etc.) or tp
    // failed. Either way Steve is in water — try to auto-disembark
    // so the recovery path swims him to shore.
    //
    // Task #66: scan for the nearest standable dry shore around
    // wherever the boat died and pass it as target_shore to
    // disembark. This avoids the failure mode where vanilla MC
    // drops the rider at the boat's last position (often over
    // water) and Steve ends up swimming with no recovery path.
    const broke = drive.broke_at;
    let nearbyDryShore = null;
    if (broke) {
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
      try {
        const r = findAdjustedTarget(
          b,
          isStandableLand,
          Math.floor(broke.x),
          Math.floor(broke.y),
          Math.floor(broke.z),
          12,
        );
        if (r && r.adjusted) {
          nearbyDryShore = { x: r.x, y: r.y, z: r.z };
        }
      } catch { /* no shore in range — fall back to legacy disembark */ }
    }
    let autoDisembark = null;
    if (ACTIONS && typeof ACTIONS.disembark === 'function') {
      try {
        const dis = await ACTIONS.disembark({
          fromSailFallback: true,
          ...(nearbyDryShore ? { target_shore: nearbyDryShore } : {}),
        });
        autoDisembark = { ok: !!dis?.ok, ...(dis?.data ? { data: dis.data } : {}), ...(dis?.error ? { error: dis.error } : {}) };
      } catch (e) {
        autoDisembark = { ok: false, error: e?.message || String(e) };
      }
    }
    // Map driver-level error to action-level code:
    //   STALLED  → PATH_BLOCKED (boat is fine; corridor doesn't progress)
    //   TIMEOUT  → PATH_BLOCKED (gave up before reaching target)
    //   NO_PAPERMCP → NO_PAPERMCP
    //   anything else (BOAT_LOST / TP_FAILED) → BOAT_LOST
    let code;
    if (drive.error === 'NO_PAPERMCP') code = 'NO_PAPERMCP';
    else if (drive.error === 'STALLED' || drive.error === 'TIMEOUT') code = 'PATH_BLOCKED';
    else code = 'BOAT_LOST';
    const message = code === 'NO_PAPERMCP'
      ? 'PaperMCP unavailable — cannot drive the boat. Sail requires the PaperMCP server-side tp fallback.'
      : code === 'PATH_BLOCKED'
      ? `Sail could not reach (${Math.floor(target.x)},${Math.floor(target.y)},${Math.floor(target.z)}): boat ${drive.error.toLowerCase()} after ${drive.after_steps || 0} steps near (${drive.broke_at ? `${Math.floor(drive.broke_at.x)},${Math.floor(drive.broke_at.y)},${Math.floor(drive.broke_at.z)}` : 'unknown'}).${drive.blocker ? ` Blocker: ${drive.blocker.name} at (${drive.blocker.x},${drive.blocker.y},${drive.blocker.z}).` : ''}${autoDisembark?.ok ? ' Auto-disembarked.' : ''}`
      : `Boat lost mid-sail (${drive.error || 'unknown'}) after ${drive.after_steps || 0} steps near (${drive.broke_at ? `${Math.floor(drive.broke_at.x)},${Math.floor(drive.broke_at.y)},${Math.floor(drive.broke_at.z)}` : 'unknown'}).${autoDisembark?.ok ? ' Auto-disembarked.' : ''}`;
    return fail(code, message, {
      observed_state: {
        boat_pos_start: [Number(startPos.x.toFixed(2)), Number(startPos.y.toFixed(2)), Number(startPos.z.toFixed(2))],
        broke_at: drive.broke_at,
        after_steps: drive.after_steps,
        mechanism: drive.mechanism || (usedFallback ? 'best_effort' : 'precomputed'),
        ...(drive.blocker ? { blocker: drive.blocker } : {}),
        ...(autoDisembark ? { auto_disembark: autoDisembark } : {}),
      },
      next_action_hint: autoDisembark?.ok ? 'mc status' : 'mc disembark',
      retry_safe: code !== 'NO_PAPERMCP',
    });
  }

  // Success — boat is at the final waypoint.
  const finalPos = drive.final || { x: target.x, y: startPos.y, z: target.z };
  const remaining = Math.hypot(target.x - finalPos.x, target.z - finalPos.z);
  return {
    ok: true,
    command: 'sail',
    data: {
      from: [Math.floor(startPos.x), Math.floor(startPos.y), Math.floor(startPos.z)],
      to: [Math.floor(finalPos.x), Math.floor(finalPos.y), Math.floor(finalPos.z)],
      target: [Number(x), Number(y), Number(z)],
      horizontal_distance_remaining: Number(remaining.toFixed(2)),
      steps: drive.steps,
      mechanism: drive.mechanism || (usedFallback ? 'best_effort' : 'precomputed'),
      ...(plan.ok ? { path_blockers_avoided: plan.path.length - drive.steps } : {}),
    },
  };
}

  return { sail };
}

