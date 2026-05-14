/**
 * Movement action handlers: goto, goto_near, follow, look, stop, move.
 */
import { Vec3 } from 'vec3';
import { raceWithTimeout, timeoutError, OperationTimeoutError, NoProgressError, pathfindWithProgressWatchdog, ACTION_CAPS_MS } from './_helpers.js';
import { findClosestStandable, standabilityReason, standingState, isStandableCell } from './_nav-helpers.js';

export function createMovementActions({ ctx, ensureBot, goals, fmt, posObj, ACTIONS, hasLineOfSight, eyePosition }) {
  // F51.2: mark a movement failure so the position-dependent verb guard
  // can short-circuit dependent commands until the bot acknowledges.
  const recordMoveFailure = (verb, x, y, z, actualPos, reason) => {
    if (!ctx) return;
    ctx.lastMoveFailed = {
      ts: Date.now(),
      intended_target: { x: Math.floor(Number(x)), y: Math.floor(Number(y)), z: Math.floor(Number(z)) },
      actual_pos: actualPos ? { x: Math.round(actualPos.x * 10) / 10, y: Math.round(actualPos.y * 10) / 10, z: Math.round(actualPos.z * 10) / 10 } : null,
      reason,
      verb,
    };
  };
  // Clear the failure flag — called on successful moves.
  // F57.2: on success, also expire any stuck-cell entries near the bot's
  // current position. A successful pathfind that crossed (or skirted) a
  // previously-stuck cell is good evidence that the route is workable
  // again; keep the rest of the registry for unrelated regions.
  const clearMoveFailure = () => {
    if (!ctx) return;
    ctx.lastMoveFailed = null;
    if (!Array.isArray(ctx.recentStuckCells) || ctx.recentStuckCells.length === 0) return;
    try {
      const p = ctx.bot?.entity?.position;
      if (!p) return;
      ctx.recentStuckCells = ctx.recentStuckCells.filter(e => {
        const dx = e.cell.x - p.x;
        const dy = e.cell.y - p.y;
        const dz = e.cell.z - p.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz) > 2.5;
      });
    } catch { /* never let cleanup break success */ }
  };
  // F48: When a nav verb fails, scan a small region around the target
  // for a standable cell and include it in observed_state. Mason in
  // G21 v2 sat through three 15s OPERATION_TIMEOUTs at the same
  // (0,65,12) because every adjacent cell had a wall block at head
  // height — but the error gave him no signal about (0,65,13) being
  // 1 block away and valid. With the closest_standable hint the brain
  // can immediately retry with a working target instead of looping.
  //
  // F50.6: also include `your_standing_state` so the brain sees its
  // own corner/trapped classification on every movement failure.
  const enrichWithStand = (b, observedState, x, y, z) => {
    try {
      const tx = Math.floor(Number(x));
      const ty = Math.floor(Number(y));
      const tz = Math.floor(Number(z));
      const reason = standabilityReason(b, tx, ty, tz);
      const best = findClosestStandable(b, tx, ty, tz, 3);
      observedState.target_standable = (reason === 'ok');
      observedState.target_reason = reason;
      observedState.closest_standable = best
        ? { x: best.x, y: best.y, z: best.z, distance: best.distance }
        : null;
      const ss = standingState(b);
      observedState.your_standing_state = {
        classification: ss.classification,
        blocked_dirs: ss.blocked_dirs,
        open_dirs: ss.open_dirs,
      };
    } catch { /* never let diagnostic enrichment break the error path */ }
    return observedState;
  };

  // F57.2: stuck-cell registry helpers. After a NoProgressError (or
  // after `mc escape` runs), the cell where the bot stalled gets pushed
  // here so future pathfinds toward the same region can short-circuit
  // instead of repeating the same failed attempt. 90s TTL.
  const RECENT_STUCK_TTL_MS = 90_000;
  const pushStuckCell = (cell, source) => {
    if (!ctx || !cell) return;
    if (!Array.isArray(ctx.recentStuckCells)) ctx.recentStuckCells = [];
    const cutoff = Date.now() - RECENT_STUCK_TTL_MS;
    ctx.recentStuckCells = ctx.recentStuckCells.filter(e => e.ts > cutoff);
    const cx = Math.floor(Number(cell.x));
    const cy = Math.floor(Number(cell.y));
    const cz = Math.floor(Number(cell.z));
    const existing = ctx.recentStuckCells.find(e => e.cell.x === cx && e.cell.y === cy && e.cell.z === cz);
    if (existing) {
      existing.ts = Date.now();
      existing.hit_count += 1;
    } else {
      ctx.recentStuckCells.push({ ts: Date.now(), cell: { x: cx, y: cy, z: cz }, source, hit_count: 1 });
      if (ctx.recentStuckCells.length > 12) ctx.recentStuckCells.shift();
    }
  };
  // Find any recent-stuck cell within `radius` of (tx,ty,tz). Used by
  // the pre-pathfind blackball check. Returns the entry or null.
  const recentStuckNear = (tx, ty, tz, radius = 1) => {
    if (!ctx || !Array.isArray(ctx.recentStuckCells) || ctx.recentStuckCells.length === 0) return null;
    const cutoff = Date.now() - RECENT_STUCK_TTL_MS;
    let best = null;
    for (const e of ctx.recentStuckCells) {
      if (e.ts <= cutoff) continue;
      const dx = e.cell.x - tx;
      const dy = e.cell.y - ty;
      const dz = e.cell.z - tz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d <= radius && (!best || e.hit_count > best.hit_count)) best = e;
    }
    return best;
  };

  // F50.2: Pre-flight checks before invoking the pathfinder. Catches
  // doomed calls in <5ms (one classify + one closest-standable scan)
  // instead of paying the 5-15s wallclock cap to discover the same
  // thing. Returns null if the call should proceed; otherwise an
  // error response ready to be returned to the caller.
  //
  // Reasons we short-circuit:
  //   1. BOT_TRAPPED — bot has all 4 cardinal dirs blocked at foot or
  //      head level. With parkour disabled (F49) pathfinder cannot
  //      escape; brain must dig/escape first.
  //   2. NAV_TARGET_UNSTANDABLE — no standable cell exists within
  //      `range` of the target (target is in solid rock / floating).
  //      No path possible regardless of where bot is.
  //   3. F57.2 NAV_RECURRING_STUCK — target is within 1 block of a cell
  //      where the bot stalled twice or more in the last 90s. Refuse the
  //      attempt and direct the brain to mc dig or alternative route.
  const preflightNav = (b, x, y, z, range) => {
    let ss;
    try { ss = standingState(b); } catch { return null; }
    if (ss && ss.classification === 'trapped') {
      const tx = Math.floor(Number(x));
      const ty = Math.floor(Number(y));
      const tz = Math.floor(Number(z));
      return {
        ok: false,
        error: {
          code: 'BOT_TRAPPED',
          message: `Cannot navigate — you are trapped at ${ss.cell.x},${ss.cell.y},${ss.cell.z}. All 4 cardinal dirs blocked at foot or head. Use mc dig <coord> to break out, or mc escape if available.`,
          observed_state: {
            your_standing_state: ss,
            target: { x: tx, y: ty, z: tz },
          },
          retry_safe: false,
        },
      };
    }
    const tx = Math.floor(Number(x));
    const ty = Math.floor(Number(y));
    const tz = Math.floor(Number(z));
    // F57.2 blackball: if the brain is sending the bot back to a place
    // it just stalled in (hit_count >= 2), refuse early.
    const stuck = recentStuckNear(tx, ty, tz, 1);
    if (stuck && stuck.hit_count >= 2) {
      const ageS = Math.round((Date.now() - stuck.ts) / 100) / 10;
      return {
        ok: false,
        error: {
          code: 'NAV_RECURRING_STUCK',
          message: `Refusing to pathfind to ${tx},${ty},${tz} — the bot has stalled near ${stuck.cell.x},${stuck.cell.y},${stuck.cell.z} ${stuck.hit_count}× in the last ${ageS}s. The route is trapping you. Options: (a) mc dig at the blocking cell — run mc inspect to identify it; (b) approach from a different side via mc go_mark; (c) call mc status to clear this flag if you've moved.`,
          observed_state: {
            target: { x: tx, y: ty, z: tz },
            recurring_cell: stuck.cell,
            hit_count: stuck.hit_count,
            source: stuck.source,
            age_s: ageS,
            your_standing_state: ss ? {
              classification: ss.classification,
              blocked_dirs: ss.blocked_dirs,
              open_dirs: ss.open_dirs,
            } : null,
          },
          next_action_hint: `mc inspect ${stuck.cell.x} ${stuck.cell.y} ${stuck.cell.z}`,
          retry_safe: false,
        },
      };
    }
    const scan = Math.max(1, Math.min(4, Number.isFinite(range) ? range : 1));
    let best;
    try { best = findClosestStandable(b, tx, ty, tz, scan); } catch { return null; }
    if (!best) {
      return {
        ok: false,
        error: {
          code: 'NAV_TARGET_UNSTANDABLE',
          message: `No standable cell within ${scan} of ${tx},${ty},${tz}. Target area is solid or floating. Pick a different destination, or mc dig to clear blocks first.`,
          observed_state: {
            target: { x: tx, y: ty, z: tz },
            scan_range: scan,
            your_standing_state: ss ? {
              classification: ss.classification,
              blocked_dirs: ss.blocked_dirs,
              open_dirs: ss.open_dirs,
            } : null,
          },
          retry_safe: false,
        },
      };
    }
    return null;
  };

  // F51.1: Pre-nudge from sticky starting positions. When the bot is in
  // a corner/wedge/edge/three_walled state, pathfinder often hangs or
  // chooses bad routes because the search space is asymmetric. This
  // function attempts a tiny pre-move to an open cardinal neighbor in
  // the rough direction of the target, BEFORE the main pathfind.
  // Silent — caller doesn't annotate. If pre-nudge fails, main pathfind
  // proceeds anyway (worst case we waste 3s + try the original plan).
  const DIR_VEC = {
    N: { dx: 0, dz: -1 },
    E: { dx: 1, dz: 0 },
    S: { dx: 0, dz: 1 },
    W: { dx: -1, dz: 0 },
  };
  const STICKY_CLASSIFICATIONS = new Set(['corner', 'wedge', 'edge', 'three_walled']);
  const pickSteppingStone = (sNow, tx, ty, tz) => {
    if (!sNow || !sNow.open_dirs || !sNow.cell) return null;
    if (sNow.open_dirs.length === 0) return null;
    // Direction from bot toward target on XZ plane (ignore Y — pre-nudge
    // doesn't try to fix elevation issues).
    const cx = sNow.cell.x, cz = sNow.cell.z;
    const dxToT = Math.sign(tx - cx);
    const dzToT = Math.sign(tz - cz);
    const candidates = [];
    for (const dirName of sNow.open_dirs) {
      const v = DIR_VEC[dirName];
      if (!v) continue;
      const dotProd = (v.dx * dxToT) + (v.dz * dzToT);
      candidates.push({
        cell: { x: cx + v.dx, y: sNow.cell.y, z: cz + v.dz },
        score: dotProd,
        dir: dirName,
      });
    }
    candidates.sort((a, c) => c.score - a.score);
    // Only return if best score is non-negative — don't move AWAY from target.
    // For wedge specifically (sNow.cell is already the bot's cell), score=0
    // is still useful: any cardinal step away from the wedge edge helps.
    if (candidates.length === 0) return null;
    if (candidates[0].score < 0 && sNow.classification !== 'wedge') return null;
    return candidates[0];
  };
  const preNudgeIfSticky = async (b, tx, ty, tz) => {
    let sNow;
    try { sNow = standingState(b); } catch { return; }
    if (!sNow || !STICKY_CLASSIFICATIONS.has(sNow.classification)) return;
    const stone = pickSteppingStone(sNow, tx, ty, tz);
    if (!stone) return;
    try {
      const goal = new goals.GoalBlock(stone.cell.x, stone.cell.y, stone.cell.z);
      await raceWithTimeout(b.pathfinder.goto(goal), 3000, 'stepping_stone');
    } catch {
      // Pre-nudge failed (timeout or no path). That's fine — continue
      // with the main pathfind. The brain doesn't see this attempt;
      // worst case we paid 3s and the main pathfind still happens.
      try { b.pathfinder.setGoal(null); } catch {}
    }
  };

  // Pathfinder is read-only (no canDig, no scaffolding). When it can't find
  // a path, it returns "No path to the goal!" — that's the agent's signal
  // that the route is blocked and intentional action is needed (mc through
  // for a door, mc tunnel/dig_area to clear terrain). These helpers shape
  // those failures into a consistent action-contract response.
  const navBlockedError = (b, pos, x, y, z, dist) => ({
    ok: false,
    error: {
      code: 'NAV_BLOCKED',
      message: `Pathfinder gave up at ${pos.x},${pos.y},${pos.z} — ${dist.toFixed(1)} blocks from target ${fmt(x)},${fmt(y)},${fmt(z)}. The path is blocked. Try mc through GX GY GZ for a door/gate, or mc tunnel / mc dig_area to clear terrain explicitly.`,
      observed_state: enrichWithStand(b, { current: pos, target: { x, y, z }, distance: Number(dist.toFixed(1)) }, x, y, z),
      retry_safe: false,
    },
  });
  const navFailureError = (b, pos, x, y, z, msg) => {
    if (msg === 'timeout') {
      return {
        ok: false,
        error: {
          code: 'NAV_TIMEOUT',
          message: `Walked toward ${fmt(x)},${fmt(y)},${fmt(z)} for 15s, now at ${pos.x},${pos.y},${pos.z}. Use mc bg_goto for long distances or mc through for doors.`,
          observed_state: enrichWithStand(b, { current: pos, target: { x, y, z } }, x, y, z),
          retry_safe: true,
        },
      };
    }
    if (/no path/i.test(msg)) {
      return {
        ok: false,
        error: {
          code: 'NAV_BLOCKED',
          message: `No path to ${fmt(x)},${fmt(y)},${fmt(z)} from ${pos.x},${pos.y},${pos.z}. Pathfinder is non-destructive — if a door blocks the path use mc through GX GY GZ; if terrain blocks it use mc tunnel or mc dig_area to clear it explicitly.`,
          observed_state: enrichWithStand(b, { current: pos, target: { x, y, z } }, x, y, z),
          retry_safe: false,
        },
      };
    }
    return {
      ok: false,
      error: { code: 'NAV_FAILED', message: `Navigation failed: ${msg}`, observed_state: enrichWithStand(b, { current: pos, target: { x, y, z } }, x, y, z), retry_safe: false },
    };
  };

  return {
    async goto({ x, y, z }) {
      const b = ensureBot();
      // F50.2: bot-trapped + target-unstandable pre-flight.
      const pre = preflightNav(b, x, y, z, 1);
      if (pre) {
        recordMoveFailure('goto', x, y, z, posObj(), pre.error?.code || 'preflight');
        return pre;
      }
      // F51.1: silent pre-nudge from sticky start position.
      await preNudgeIfSticky(b, Math.floor(x), Math.floor(y), Math.floor(z));
      // Pre-check: GoalBlock requires the bot to stand AT (x,y,z). If the
      // target tile or the head tile above it is a solid block, GoalBlock
      // is impossible by construction (you can't occupy a solid cell).
      // Common case: agent calls `mc goto 1 65 1` to reach a crafting
      // table at (1,65,1) — pathfinder spends 15s before giving up.
      // Catch it early with an actionable hint pointing at goto_near.
      const tx = Math.floor(x), ty = Math.floor(y), tz = Math.floor(z);
      const blockAtTarget = b.blockAt(new Vec3(tx, ty, tz));
      const blockAtHead = b.blockAt(new Vec3(tx, ty + 1, tz));
      const isSolid = (blk) => blk && blk.name !== 'air' && blk.name !== 'cave_air'
        && blk.name !== 'void_air' && blk.boundingBox === 'block';
      if (isSolid(blockAtTarget) || isSolid(blockAtHead)) {
        const blocker = isSolid(blockAtTarget) ? blockAtTarget : blockAtHead;
        const pos = posObj();
        return {
          ok: false,
          error: {
            code: 'NAV_TARGET_OCCUPIED',
            message: `Target ${tx},${ty},${tz} is inside a solid block (${blocker.name}). You can't stand there. Use \`mc goto_near ${tx} ${ty} ${tz}\` to reach an adjacent walkable tile instead.`,
            observed_state: enrichWithStand(b, { target: { x: tx, y: ty, z: tz }, blocker: blocker.name, current: pos }, tx, ty, tz),
            retry_safe: false,
          },
        };
      }
      const goal = new goals.GoalBlock(tx, ty, tz);
      try {
        await pathfindWithProgressWatchdog({
          bot: b,
          pathfinderGoto: () => b.pathfinder.goto(goal),
          onStall: () => { try { b.pathfinder.setGoal(null); } catch {} },
          opName: 'goto',
          capMs: ACTION_CAPS_MS.goto,
        });
        const pos = posObj();
        const dist = Math.hypot(pos.x - x, pos.y - y, pos.z - z);
        if (dist > 2) {
          recordMoveFailure('goto', x, y, z, pos, 'pathfinder_gave_up');
          return navBlockedError(b, pos, x, y, z, dist);
        }
        clearMoveFailure();
        return { result: `Arrived at ${fmt(x)}, ${fmt(y)}, ${fmt(z)}` };
      } catch (e) {
        try { b.pathfinder.setGoal(null); } catch {}
        if (e instanceof NoProgressError) {
          recordMoveFailure('goto', x, y, z, posObj(), 'no_progress');
          pushStuckCell(e.info?.stalled_position, 'no_progress');
          return {
            ok: false,
            error: {
              code: 'NAV_NO_PROGRESS',
              message: `Pathfinder stalled — bot stopped moving for ${e.info?.no_progress_for_ms}ms while heading to ${fmt(x)},${fmt(y)},${fmt(z)}. Often means a 1-block lip, a wedged corner, or a sealed route. Try mc escape, mc dig at the blocker, or pick a different target.`,
              observed_state: enrichWithStand(b, { target: { x, y, z }, current: posObj(), ...e.info }, x, y, z),
              retry_safe: false,
            },
          };
        }
        if (e instanceof OperationTimeoutError) {
          recordMoveFailure('goto', x, y, z, posObj(), 'wallclock_timeout');
          return timeoutError('goto', ACTION_CAPS_MS.goto,
            enrichWithStand(b, { target: { x, y, z }, current: posObj() }, x, y, z),
            `Pathfinder didn't finish in time. If observed_state.closest_standable is set, retry mc goto there instead.`);
        }
        const pos = posObj();
        recordMoveFailure('goto', x, y, z, pos, 'pathfinder_error');
        return navFailureError(b, pos, x, y, z, e?.message || String(e));
      }
    },

    async goto_near({ x, y, z, range = 2, los = undefined }) {
      const b = ensureBot();
      // F50.2: pre-flight checks (bot-trapped, target-unstandable).
      const pre = preflightNav(b, x, y, z, range);
      if (pre) {
        recordMoveFailure('goto_near', x, y, z, posObj(), pre.error?.code || 'preflight');
        return pre;
      }
      // F51.1: silent pre-nudge from sticky start position.
      await preNudgeIfSticky(b, Math.floor(x), Math.floor(y), Math.floor(z));
      const tx = Math.floor(x), ty = Math.floor(y), tz = Math.floor(z);

      // F71: LOS-aware landing for solid targets. Plain GoalNear can land
      // the bot 'within range' but on the wrong side of a wall — distance
      // 2.0 with a cobble wall in between still counts as success, then
      // the follow-up dig/place/interact trips its LOS guard. When the
      // target cell is a solid block, pick the closest standable cell
      // *within range* that has LOS to at least one face of the target,
      // and pathfind exactly there. Opt out via `los=false` for callers
      // that explicitly want raw "be near this air cell" behavior.
      let goal = new goals.GoalNear(tx, ty, tz, range);
      let losPicked = null;
      if (los !== false && typeof hasLineOfSight === 'function') {
        const targetBlock = b.blockAt(new Vec3(tx, ty, tz));
        const targetIsSolid = !!(targetBlock
          && targetBlock.boundingBox === 'block'
          && targetBlock.name !== 'air'
          && targetBlock.name !== 'cave_air');
        if (targetIsSolid) {
          const cBx = tx + 0.5, cBy = ty + 0.5, cBz = tz + 0.5;
          const faces = [
            { x: cBx, y: cBy, z: cBz - 0.48 },
            { x: cBx, y: cBy, z: cBz + 0.48 },
            { x: cBx - 0.48, y: cBy, z: cBz },
            { x: cBx + 0.48, y: cBy, z: cBz },
            { x: cBx, y: cBy - 0.48, z: cBz },
            { x: cBx, y: cBy + 0.48, z: cBz },
            { x: cBx, y: cBy, z: cBz },
          ];
          const cands = [];
          const R = Math.max(1, Math.floor(range));
          for (let dx = -R; dx <= R; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              for (let dz = -R; dz <= R; dz++) {
                if (dx === 0 && dy === 0 && dz === 0) continue;
                const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (d > range) continue;
                const cx = tx + dx, cy = ty + dy, cz = tz + dz;
                if (!isStandableCell(b, cx, cy, cz)) continue;
                // Hypothetical eye position at this candidate cell.
                // Use the same height scaling as eyePosition() (1.377m).
                const candEye = { x: cx + 0.5, y: cy + 1.377, z: cz + 0.5 };
                if (faces.some((p) => hasLineOfSight(candEye, p))) {
                  cands.push({ cx, cy, cz, d });
                }
              }
            }
          }
          if (cands.length > 0) {
            cands.sort((a, c) => a.d - c.d);
            losPicked = cands[0];
            goal = new goals.GoalBlock(losPicked.cx, losPicked.cy, losPicked.cz);
          }
        }
      }
      try {
        await pathfindWithProgressWatchdog({
          bot: b,
          pathfinderGoto: () => b.pathfinder.goto(goal),
          onStall: () => { try { b.pathfinder.setGoal(null); } catch {} },
          opName: 'goto_near',
          capMs: ACTION_CAPS_MS.goto_near,
        });
        const pos = posObj();
        const dist = Math.hypot(pos.x - x, pos.y - y, pos.z - z);
        if (dist > range + 1.5) {
          recordMoveFailure('goto_near', x, y, z, pos, 'pathfinder_gave_up');
          return navBlockedError(b, pos, x, y, z, dist);
        }
        clearMoveFailure();
        // F50.5: landing-state check. GoalNear lands the bot at SOME cell
        // within `range` of target, often a fractional position next to a
        // wall (Mason in G21 v2 routinely ended up in wedge/corner). If
        // the landing is suboptimal, scan for a cleaner cell still in
        // range and report it via observed_state.suggested_correction.
        // We don't auto-move — silent corrections would drift the brain's
        // model of position. Brain can mc move <suggested> if it wants.
        let landingInfo;
        try {
          const ss = standingState(b);
          const ugly = ['corner', 'wedge', 'edge', 'three_walled'];
          if (ugly.includes(ss.classification)) {
            // Find candidate cells around target within range
            let suggested = null;
            const candidates = [];
            for (let dx = -range; dx <= range; dx++) {
              for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -range; dz <= range; dz++) {
                  if (dx === 0 && dy === 0 && dz === 0) continue;
                  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                  if (dist > range) continue;
                  candidates.push({ cx: tx + dx, cy: ty + dy, cz: tz + dz, dist });
                }
              }
            }
            candidates.sort((a, c) => a.dist - c.dist);
            // Score: walk classifier across each candidate; pick first
            // 'open' or 'alley'. Avoid re-classifying via setting bot
            // position — instead infer from neighbor block state.
            const myCellX = ss.cell.x, myCellY = ss.cell.y, myCellZ = ss.cell.z;
            for (const c of candidates) {
              if (c.cx === myCellX && c.cy === myCellY && c.cz === myCellZ) continue;
              if (!isStandableCell(b, c.cx, c.cy, c.cz)) continue;
              // Quick proxy: count blocked dirs at this candidate
              const checks = [
                b.blockAt(new Vec3(c.cx + 1, c.cy, c.cz)),
                b.blockAt(new Vec3(c.cx - 1, c.cy, c.cz)),
                b.blockAt(new Vec3(c.cx, c.cy, c.cz + 1)),
                b.blockAt(new Vec3(c.cx, c.cy, c.cz - 1)),
              ];
              const blocked = checks.filter(blk => blk && blk.boundingBox === 'block').length;
              if (blocked <= 1) {
                suggested = { x: c.cx, y: c.cy, z: c.cz, blocked_neighbors: blocked, distance_from_target: Number(c.dist.toFixed(2)) };
                break;
              }
            }
            landingInfo = {
              landed_in: ss.classification,
              landing_position: ss.position,
              suggested_correction: suggested,
            };
          }
        } catch { /* never let landing inspection break success */ }
        if (landingInfo) {
          const note = landingInfo.suggested_correction
            ? ` (landed in ${landingInfo.landed_in} — observed_state.suggested_correction shows a cleaner cell within range)`
            : ` (landed in ${landingInfo.landed_in} — no cleaner cell within range)`;
          if (losPicked) {
            landingInfo.los_cell_picked = { x: losPicked.cx, y: losPicked.cy, z: losPicked.cz };
          }
          return {
            result: `Arrived near ${fmt(x)}, ${fmt(y)}, ${fmt(z)}${note}`,
            observed_state: landingInfo,
          };
        }
        if (losPicked) {
          return {
            result: `Arrived at LOS cell ${losPicked.cx}, ${losPicked.cy}, ${losPicked.cz} (clear sight to target ${fmt(x)}, ${fmt(y)}, ${fmt(z)})`,
            observed_state: { los_cell_picked: { x: losPicked.cx, y: losPicked.cy, z: losPicked.cz } },
          };
        }
        return { result: `Arrived near ${fmt(x)}, ${fmt(y)}, ${fmt(z)}` };
      } catch (e) {
        try { b.pathfinder.setGoal(null); } catch {}
        if (e instanceof NoProgressError) {
          recordMoveFailure('goto_near', x, y, z, posObj(), 'no_progress');
          pushStuckCell(e.info?.stalled_position, 'no_progress');
          return {
            ok: false,
            error: {
              code: 'NAV_NO_PROGRESS',
              message: `Pathfinder stalled — bot stopped moving for ${e.info?.no_progress_for_ms}ms while heading to ${fmt(x)},${fmt(y)},${fmt(z)} (range ${range}). Likely a 1-block lip, wedge, or sealed route. Try mc escape, mc dig at the blocker, or use mc goto_near with different coords.`,
              observed_state: enrichWithStand(b, { target: { x, y, z }, range, current: posObj(), ...e.info }, x, y, z),
              retry_safe: false,
            },
          };
        }
        if (e instanceof OperationTimeoutError) {
          recordMoveFailure('goto_near', x, y, z, posObj(), 'wallclock_timeout');
          return timeoutError('goto_near', ACTION_CAPS_MS.goto_near,
            enrichWithStand(b, { target: { x, y, z }, current: posObj(), range }, x, y, z),
            `Pathfinder didn't finish in time. If observed_state.closest_standable is set, retry mc goto_near with those coords.`);
        }
        const pos = posObj();
        recordMoveFailure('goto_near', x, y, z, pos, 'pathfinder_error');
        return navFailureError(b, pos, x, y, z, e?.message || String(e));
      }
    },

    async follow({ player }) {
      const b = ensureBot();
      const entity = Object.values(b.entities).find(e =>
        e !== b.entity && (
          (e.username || '').toLowerCase() === player.toLowerCase() ||
          (e.name || '').toLowerCase() === player.toLowerCase()
        )
      );
      if (!entity) throw new Error(`Player/entity "${player}" not found nearby.`);
      b.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true);
      return { result: `Following ${player}. Use /action/stop to stop.` };
    },

    async look({ x, y, z }) {
      const b = ensureBot();
      await b.lookAt(new Vec3(x, y, z));
      return { result: `Looking at ${x}, ${y}, ${z}` };
    },

    async stop() {
      const b = ensureBot();
      b.pathfinder.setGoal(null);
      try { b.stopDigging(); } catch {}
      if (b.pvp) try { b.pvp.stop(); } catch {}
      return { result: 'Stopped all actions.' };
    },

    /**
     * Smart non-destructive navigation. Like mc goto, but on NAV_BLOCKED
     * automatically detects a door/gate between the bot and the target,
     * opens it via mc through (which closes it behind), and recurses from
     * the new position. Up to max_doors legs (default 5).
     *
     * Args:
     *   x, y, z              — destination
     *   max_doors            — optional, default 5, capped at 10
     *   door: {x,y,z}        — optional explicit override; use this door first
     */
    async move({ x, y, z, max_doors, door }) {
      const b = ensureBot();
      if (![x, y, z].every((v) => Number.isFinite(Number(v)))) {
        return { ok: false, error: { code: 'INVALID_COORD', message: 'mc move requires numeric x, y, z', retry_safe: false } };
      }
      // F50.2: pre-flight (bot-trapped, target-unstandable). mc move uses
      // pathfinder for each leg, so the same protections apply.
      const pre = preflightNav(b, x, y, z, 1);
      if (pre) {
        recordMoveFailure('move', x, y, z, posObj(), pre.error?.code || 'preflight');
        return pre;
      }
      // F51.1: silent pre-nudge from sticky start position.
      await preNudgeIfSticky(b, Math.floor(Number(x)), Math.floor(Number(y)), Math.floor(Number(z)));
      const target = { x: Number(x), y: Number(y), z: Number(z) };
      const maxDoors = Math.min(Math.max(parseInt(String(max_doors ?? 5), 10) || 5, 1), 10);

      // Find passable doors (wooden _door + *_fence_gate; skip iron_door and trapdoors).
      const isPassable = (name) =>
        (/(_door|_fence_gate)$/.test(name)) && !name.startsWith('iron_') && !name.endsWith('_trapdoor');

      const findBestDoor = () => {
        const me = b.entity.position;
        const targetVec = new Vec3(target.x, target.y, target.z);
        const myDist = me.distanceTo(targetVec);
        const positions = b.findBlocks({
          matching: (block) => isPassable(block.name),
          maxDistance: 32,
          count: 30,
        });
        let best = null;
        let bestScore = Infinity;
        for (const dPos of positions) {
          const dBlock = b.blockAt(dPos);
          if (!dBlock) continue;
          // Skip upper halves of doors so we don't pick the same door twice.
          const props = (typeof dBlock.getProperties === 'function') ? dBlock.getProperties() : {};
          if (props.half === 'upper') continue;
          // Compute far_side (toward target) and near_side (away from target)
          // along the dominant axis between door and target.
          const ddx = target.x - dPos.x;
          const ddz = target.z - dPos.z;
          let farSide, nearSide;
          if (Math.abs(ddx) >= Math.abs(ddz)) {
            const dir = Math.sign(ddx || 1);
            farSide = new Vec3(dPos.x + dir * 2, target.y, dPos.z);
            nearSide = new Vec3(dPos.x - dir * 2, target.y, dPos.z);
          } else {
            const dir = Math.sign(ddz || 1);
            farSide = new Vec3(dPos.x, target.y, dPos.z + dir * 2);
            nearSide = new Vec3(dPos.x, target.y, dPos.z - dir * 2);
          }
          // Far side must be strictly closer to target than the bot currently is.
          const farDist = farSide.distanceTo(targetVec);
          if (farDist >= myDist - 0.5) continue;
          // Score by dist(bot, near_side) — closest reachable door wins.
          // In multi-door buildings this picks the door in the bot's current
          // room first; later legs pick deeper doors as bot advances.
          const nearDist = me.distanceTo(nearSide);
          if (nearDist < bestScore) {
            bestScore = nearDist;
            best = { pos: dPos, block: dBlock.name, near_side: nearSide, far_side: farSide, near_dist: nearDist, far_dist: farDist };
          }
        }
        return best;
      };

      const nearbyDoorList = () =>
        b.findBlocks({
          matching: (block) => isPassable(block.name),
          maxDistance: 32,
          count: 8,
        }).map((p) => {
          const blk = b.blockAt(p);
          const props = (typeof blk?.getProperties === 'function') ? blk.getProperties() : {};
          return { x: p.x, y: p.y, z: p.z, block: blk?.name || 'unknown', open: props.open === 'true' || props.open === true };
        }).filter((d) => {
          const blk = b.blockAt(new Vec3(d.x, d.y, d.z));
          const props = (typeof blk?.getProperties === 'function') ? blk.getProperties() : {};
          return props.half !== 'upper';
        });

      const doors_used = [];
      let lastPathfinderError = null;

      for (let leg = 1; leg <= maxDoors + 1; leg++) {
        // Try direct pathfinder.goto.
        const goal = new goals.GoalBlock(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z));
        try {
          await pathfindWithProgressWatchdog({
            bot: b,
            pathfinderGoto: () => b.pathfinder.goto(goal),
            onStall: () => { try { b.pathfinder.setGoal(null); } catch {} },
            opName: 'move',
            capMs: ACTION_CAPS_MS.move,
          });
        } catch (e) {
          if (e instanceof NoProgressError) {
            lastPathfinderError = `no_progress:${e.info?.no_progress_for_ms || '?'}ms`;
            pushStuckCell(e.info?.stalled_position, 'no_progress');
          } else if (e instanceof OperationTimeoutError) lastPathfinderError = 'timeout';
          else lastPathfinderError = e?.message || String(e);
          try { b.pathfinder.setGoal(null); } catch {}
        }

        const pos = posObj();
        const dist = Math.hypot(pos.x - target.x, pos.y - target.y, pos.z - target.z);
        if (dist <= 2) {
          clearMoveFailure();
          return {
            ok: true,
            data: {
              doors_used,
              legs: leg,
              end_position: pos,
            },
            result: `Arrived at ${fmt(target.x)}, ${fmt(target.y)}, ${fmt(target.z)}${doors_used.length ? ` via ${doors_used.length} door${doors_used.length > 1 ? 's' : ''}` : ''}`,
          };
        }

        // Pick a door to traverse.
        let chosen;
        if (leg === 1 && door && Number.isFinite(Number(door.x)) && Number.isFinite(Number(door.y)) && Number.isFinite(Number(door.z))) {
          const dPos = new Vec3(Number(door.x), Number(door.y), Number(door.z));
          const dBlock = b.blockAt(dPos);
          if (!dBlock || !isPassable(dBlock.name)) {
            return {
              ok: false,
              error: {
                code: 'NAV_BLOCKED',
                message: `--door at ${door.x},${door.y},${door.z} is not a passable door/gate (block: ${dBlock?.name || 'unknown'})`,
                observed_state: { current: pos, target, doors_used, requested_door: door },
                retry_safe: false,
              },
            };
          }
          const ddx = target.x - dPos.x;
          const ddz = target.z - dPos.z;
          const farSide = (Math.abs(ddx) >= Math.abs(ddz))
            ? new Vec3(dPos.x + Math.sign(ddx || 1) * 2, target.y, dPos.z)
            : new Vec3(dPos.x, target.y, dPos.z + Math.sign(ddz || 1) * 2);
          chosen = { pos: dPos, block: dBlock.name, far_side: farSide };
        } else {
          chosen = findBestDoor();
        }

        if (!chosen) {
          recordMoveFailure('move', target.x, target.y, target.z, pos, lastPathfinderError || 'no_door');
          return {
            ok: false,
            error: {
              code: 'NAV_BLOCKED',
              message: `No path to ${fmt(target.x)},${fmt(target.y)},${fmt(target.z)} from ${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)} and no door/gate between to use. Use mc tunnel or mc dig_area to clear terrain explicitly.`,
              observed_state: enrichWithStand(b, { current: pos, target, doors_used, nearby_doors: nearbyDoorList(), pathfinder_error: lastPathfinderError }, target.x, target.y, target.z),
              retry_safe: false,
            },
          };
        }

        // Traverse via mc through (opens + walks + closes).
        const through = await ACTIONS.through({
          gx: chosen.pos.x, gy: chosen.pos.y, gz: chosen.pos.z,
          dx: chosen.far_side.x, dy: chosen.far_side.y, dz: chosen.far_side.z,
        });

        if (!through.ok) {
          return {
            ok: false,
            error: {
              code: 'NAV_BLOCKED',
              message: `Could not traverse ${chosen.block} at ${chosen.pos.x},${chosen.pos.y},${chosen.pos.z}: ${through.error?.message || 'through failed'}`,
              observed_state: enrichWithStand(b, { current: posObj(), target, doors_used, failed_door: { x: chosen.pos.x, y: chosen.pos.y, z: chosen.pos.z, block: chosen.block }, through_error: through.error }, target.x, target.y, target.z),
              retry_safe: through.error?.retry_safe ?? false,
            },
          };
        }

        doors_used.push({
          x: chosen.pos.x, y: chosen.pos.y, z: chosen.pos.z,
          block: chosen.block,
          closed: through.data?.closed ?? false,
        });
      }

      return {
        ok: false,
        error: {
          code: 'TOO_MANY_DOORS',
          message: `Used max ${maxDoors} doors without reaching ${fmt(target.x)},${fmt(target.y)},${fmt(target.z)}. Building may have a routing loop or be too complex; try mc move --door X Y Z to pick a specific door.`,
          observed_state: enrichWithStand(b, { doors_used, target, current: posObj() }, target.x, target.y, target.z),
          retry_safe: false,
        },
      };
    },
  };
}
