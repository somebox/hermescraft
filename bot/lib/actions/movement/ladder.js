/**
 * `mc ladder up [--to Y]` / `mc ladder down [--to Y]` — explicit ladder
 * climb primitive. Bypasses pathfinder's flaky climbable handling for
 * cases where the bot is already on (or adjacent to) a known ladder
 * column and just needs to ride it up/down and step off cleanly.
 *
 * Motivating incident: Mason on hut3 roof build (t_ce21f3ff, 2026-05-24)
 * could enter the ladder shaft and reach Y=68.7 but `mc move` kept
 * failing on the way to Y=71+. Pathfinder's `getMoveUp` only synthesises
 * a one-cell-at-a-time climb and trips over the top-of-ladder transition
 * because the cell above the highest ladder block isn't climbable.
 *
 * V1 scope (intentionally narrow):
 *   - dir: 'up' | 'down'  — required
 *   - to:  optional target Y (integer or float). If omitted, climbs to
 *     top (up) or bottom (down) of the contiguous ladder column the bot
 *     is currently standing in.
 *   - timeout_ms: hard cap (default 10000).
 *   - exit: 'auto' (default for up) | 'none'. Auto-step off forward at
 *     the top onto an adjacent solid block; 'none' holds the bot mid-
 *     climb instead (useful when --to is specified and caller intends
 *     to dig / place from the ladder).
 *
 * Bot must already be inside the ladder cell when called — this is NOT
 * `mc ladder enter` (a separate primitive that would pathfind to the
 * ladder first). For now agents are expected to `mc move <ladder x,y,z>`
 * before `mc ladder up`.
 *
 * Out of scope for v1: scaffolding, vines, twisting-vines (different
 * physics). They all share the climbable flag but exiting / clinging
 * differs enough to deserve their own primitives.
 */
import { Vec3 } from 'vec3';
import { fail } from '../../shared/action-contract.js';

const CLIMBABLE_NAMES = new Set(['ladder']);

const CLEAR_CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'];

function isClimbableBlock(block) {
  return !!block && CLIMBABLE_NAMES.has(block.name);
}

/**
 * Walk vertically from (x, startY, z) until the cell is no longer a
 * ladder. Returns { topY, bottomY } — the Y values of the topmost and
 * bottommost contiguous ladder blocks (inclusive). Returns nulls if
 * (x, startY, z) itself isn't a ladder.
 */
function findColumn(b, x, startY, z) {
  if (!isClimbableBlock(b.blockAt(new Vec3(x, startY, z)))) {
    return { topY: null, bottomY: null };
  }
  let topY = startY;
  let bottomY = startY;
  // Scan up
  for (let dy = 1; dy <= 64; dy++) {
    if (isClimbableBlock(b.blockAt(new Vec3(x, startY + dy, z)))) topY = startY + dy;
    else break;
  }
  // Scan down
  for (let dy = 1; dy <= 64; dy++) {
    if (isClimbableBlock(b.blockAt(new Vec3(x, startY - dy, z)))) bottomY = startY - dy;
    else break;
  }
  return { topY, bottomY };
}

/**
 * Ladder blockstate `facing` = direction the ladder's front face points
 * (where the player stands relative to the wall). To climb the player
 * must press against the wall, which is in the OPPOSITE direction.
 * Returns a Vec3 offset (unit vector) pointing toward the wall, or
 * null if facing can't be read.
 */
function wallDirectionFromLadder(block) {
  try {
    const facing = block?.getProperties?.()?.facing ?? block?._properties?.facing;
    switch (facing) {
      case 'north': return new Vec3(0, 0, 1);   // ladder front faces north → wall is south (+z)
      case 'south': return new Vec3(0, 0, -1);  // ladder front faces south → wall is north (-z)
      case 'east':  return new Vec3(-1, 0, 0);  // ladder front faces east → wall is west (-x)
      case 'west':  return new Vec3(1, 0, 0);   // ladder front faces west → wall is east (+x)
      default: return null;
    }
  } catch { return null; }
}

function clearAllControls(b) {
  for (const c of CLEAR_CONTROLS) {
    try { b.setControlState(c, false); } catch { /* ignore */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
const isAirLike = (blk) => !blk || AIR_NAMES.has(blk.name);

/**
 * Scan 4 horizontal neighbors at foot.y and foot.y-1 for a ladder cell.
 * If one is found and the intervening "step destination" cell is air
 * (bot can step into it without colliding), turn the bot to face that
 * direction and press forward briefly. The bot walks off the edge, falls
 * one cell, and the ladder physics catches it.
 *
 * Returns { x, y, z, dx, dz } pointing at the ladder cell entered,
 * or null if no entry path was found or the entry didn't land in a ladder.
 *
 * Used for `mc ladder down` when the bot starts on a tower roof beside
 * an enclosed ladder shaft (Flint, 2026-05-26).
 */
async function tryEnterShaftFromAbove(b, fx, fy, fz) {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = fx + dx;
    const nz = fz + dz;
    // Candidate ladder Y values: same y (lateral walk into ladder), or
    // one below (step off edge and fall onto the topmost ladder cell).
    for (const dy of [0, -1]) {
      const ny = fy + dy;
      const cand = b.blockAt(new Vec3(nx, ny, nz));
      if (cand?.name !== 'ladder') continue;
      // The step destination at (nx, fy, nz) must be air (foot) and
      // (nx, fy+1, nz) must be air (head) so the bot can walk there.
      const stepFoot = b.blockAt(new Vec3(nx, fy, nz));
      const stepHead = b.blockAt(new Vec3(nx, fy + 1, nz));
      if (!isAirLike(stepFoot) || !isAirLike(stepHead)) continue;

      // Turn to face the step direction so forward pressure moves the
      // bot correctly. Same yaw convention as the climb code.
      const yaw = Math.atan2(-dx, -dz);
      try { await b.look(yaw, 0, true); } catch { /* tolerate */ }
      await sleep(120);

      // Sneak + forward — slow approach (~1.3 m/s vs sprint's 4.3 m/s).
      // Without sneak, the forward press carries the bot OVER the 1-cell
      // shaft hole at full walk speed, landing it on the far side of
      // the tower roof. With sneak the bot creeps to the edge; once its
      // foot cell is empty (over the shaft), it falls straight down into
      // the ladder cell below. Vanilla sneak does NOT prevent falling
      // off the edge for AI controls — only for player controls — so
      // pressing sneak here just slows movement, not edge-blocking.
      try { b.setControlState('sneak', true); } catch { /* */ }
      try { b.setControlState('forward', true); } catch { /* */ }
      const entryDeadline = Date.now() + 2400;
      let landedInLadder = false;
      try {
        while (Date.now() < entryDeadline) {
          await sleep(80);
          const p = b.entity.position;
          const cx = Math.floor(p.x);
          const cy = Math.floor(p.y);
          const cz = Math.floor(p.z);
          const here = b.blockAt(new Vec3(cx, cy, cz));
          if (here?.name === 'ladder') { landedInLadder = true; break; }
          // Also check head cell — bot may have its feet just below.
          const head = b.blockAt(new Vec3(cx, cy + 1, cz));
          if (head?.name === 'ladder') { landedInLadder = true; break; }
        }
      } finally {
        try { b.setControlState('forward', false); } catch { /* */ }
        try { b.setControlState('sneak', false); } catch { /* */ }
      }
      if (landedInLadder) return { x: nx, y: ny, z: nz, dx, dz };
      // Entry attempt failed — try the next neighbor direction.
    }
  }
  return null;
}

/**
 * @param {{ ensureBot: () => any, posObj: (p?: any) => any }} deps
 */
export function createLadder({ ensureBot, posObj }) {
  return async function ladder({
    dir,
    to,
    timeout_ms,
    exit,
  } = {}) {
    const b = ensureBot();

    const direction = String(dir || 'up').toLowerCase();
    if (direction !== 'up' && direction !== 'down') {
      return fail('INVALID_ARG', `ladder dir must be "up" or "down", got "${dir}"`, {
        retry_safe: false,
        next_action_hint: 'mc ladder up   OR   mc ladder down',
      });
    }
    const timeoutMs = Math.max(1000, Math.min(60000, parseInt(String(timeout_ms ?? 10000), 10) || 10000));
    const exitMode = exit === 'none' ? 'none' : 'auto';

    const startPos = b.entity.position.clone();
    let startCellX = Math.floor(startPos.x);
    let startCellY = Math.floor(startPos.y);
    let startCellZ = Math.floor(startPos.z);

    let hereBlock = b.blockAt(new Vec3(startCellX, startCellY, startCellZ));
    /** Audit field — set if the descent maneuvered into the shaft from above. */
    let enteredFromAbove = null;

    if (!isClimbableBlock(hereBlock)) {
      // Check one cell up — bot's head may be in the ladder while feet
      // are on a block-below.
      const headBlock = b.blockAt(new Vec3(startCellX, startCellY + 1, startCellZ));
      if (!isClimbableBlock(headBlock)) {
        // ── Entry-from-above for dir=down (Flint, 2026-05-26) ────────────
        // Bot is not in a ladder cell. For DESCENT only, scan the 4
        // horizontal neighbors at foot.y and foot.y-1 for a ladder block.
        // If one is found AND the bot can step horizontally into the
        // intervening cell (foot+head air), execute a sneak-step toward
        // the shaft: bot's foot leaves the roof, drops onto the ladder
        // cell below, the climbable physics catches it. Then we fall
        // through to the normal descent loop.
        //
        // Why dir=down only: entering from BELOW is `mc move` territory
        // (pathfinder handles walking up to a ladder base just fine).
        // Drop-from-above is the only entry geometry pathfinder can't
        // do (it won't voluntarily step off an edge into a ladder).
        if (direction === 'down') {
          const entry = await tryEnterShaftFromAbove(b, startCellX, startCellY, startCellZ);
          if (entry) {
            enteredFromAbove = entry;
            // Re-read position; bot is now inside the ladder cell.
            const pos2 = b.entity.position;
            startCellX = Math.floor(pos2.x);
            startCellY = Math.floor(pos2.y);
            startCellZ = Math.floor(pos2.z);
            hereBlock = b.blockAt(new Vec3(startCellX, startCellY, startCellZ));
            // If the entry maneuver didn't actually land the bot in a
            // ladder, fall through to the LADDER_NOT_FOUND error below.
          }
        }
        if (!enteredFromAbove && !isClimbableBlock(hereBlock)) {
          const head2 = b.blockAt(new Vec3(startCellX, startCellY + 1, startCellZ));
          if (!isClimbableBlock(head2)) {
            return fail(
              'LADDER_NOT_FOUND',
              `No ladder at bot's current cell (${startCellX},${startCellY},${startCellZ}). Pathfind to the ladder first (mc move <x> <y> <z>).`,
              {
                observed_state: {
                  bot_position: posObj(startPos),
                  here_block: hereBlock?.name || 'air',
                  head_block: headBlock?.name || 'air',
                },
                next_action_hint: 'mc find_blocks ladder 16   # locate nearest ladder',
                retry_safe: false,
              },
            );
          }
        }
      }
    }

    // Find the ladder column from a known ladder cell (prefer hereBlock,
    // else headBlock if feet weren't in a ladder).
    const ladderCellY = isClimbableBlock(hereBlock) ? startCellY : startCellY + 1;
    const ladderBlock = b.blockAt(new Vec3(startCellX, ladderCellY, startCellZ));
    const { topY, bottomY } = findColumn(b, startCellX, ladderCellY, startCellZ);

    // Determine target Y. For `up` without --to we aim ONE ABOVE the
    // top ladder block (so the bot lands on whatever's above the column);
    // exit=none caps at topY itself (hold the top ladder cell).
    let targetY;
    const explicitToY = to !== undefined && to !== null && to !== '';
    if (explicitToY) {
      targetY = parseFloat(String(to));
      if (!Number.isFinite(targetY)) {
        return fail('INVALID_ARG', `ladder --to must be a number, got "${to}"`, { retry_safe: false });
      }
    } else if (direction === 'up') {
      targetY = exitMode === 'none' ? topY : topY + 1;
    } else {
      targetY = bottomY;
    }

    // Face the wall (yaw only — pitch stays at 0 so the bot looks straight
    // into the wall regardless of its Y). Earlier `lookAt(centerOfWall)`
    // pitched the bot down whenever the target's Y was below the bot's eye
    // and that downward pitch caused mid-climb stalls.
    //
    // Yaw formula matches mineflayer-pathfinder's own driver
    // (mineflayer-pathfinder/index.js:646): `atan2(-dx, -dz)` where
    // (dx, dz) is the offset TOWARD the target. Using `+dz` (the obvious
    // form) gave the OPPOSITE yaw and the bot pressed forward off the
    // ladder instead of into the wall — caused mid-climb stalls
    // (test_ladder_up_climbs_to_top_and_exits, first iteration).
    const wallDir = wallDirectionFromLadder(ladderBlock);
    let targetYaw = null;
    if (wallDir) {
      targetYaw = Math.atan2(-wallDir.x, -wallDir.z);
      try { await b.look(targetYaw, 0, true); } catch { /* tolerate */ }
    }

    // Climb loop. Strategy:
    //   - up:   forward=true ONLY. On MC 1.21+ the `climbUsingJump`
    //           feature is OFF (prismarine-physics/lib/features.json
    //           lists climbUsingJump as 1.14–1.20). Climbing requires
    //           `isCollidedHorizontally` against the wall — forward
    //           press into the ladder face provides exactly that.
    //           Pressing jump during the climb made the bot launch
    //           up off the ladder briefly, lose climbable contact,
    //           and stall mid-column (Y=68.4 regression on 6-block
    //           ladder, test_ladder_up_to_specific_y_holds_position).
    //   - down: clear all controls; ladder physics slides bot down
    //           gently (no forward = nothing pressing against wall,
    //           gravity drops at the clamped ladder speed).
    clearAllControls(b);
    if (direction === 'up') {
      try { b.setControlState('forward', true); } catch {}
    }

    const deadline = Date.now() + timeoutMs;
    let lastY = startPos.y;
    let lastChangeTs = Date.now();
    const POLL_MS = 200;
    const STALL_MS = 5200; // ~26 polls — mid-shaft --to stops need headroom on laggy servers
    let reachedTarget = false;
    let stalled = false;

    try {
      while (Date.now() < deadline) {
        await sleep(POLL_MS);
        const py = b.entity.position.y;
        // Note: don't re-issue b.look() mid-climb. Each look() call is
        // an async packet round-trip that pauses the bot's physics
        // step and was breaking the climb at predictable Y values
        // (Y=68.4 reproducibly on a 6-block ladder). The initial
        // look() before the loop is enough — yaw doesn't drift on its
        // own.

        const upTol = (explicitToY && exitMode === 'none') ? 0.5 : 0.05;
        if (direction === 'up' && py >= targetY - upTol) { reachedTarget = true; break; }
        if (direction === 'down' && py <= targetY + 0.05) { reachedTarget = true; break; }

        if (Math.abs(py - lastY) > 0.02) {
          lastY = py;
          lastChangeTs = Date.now();
        } else {
          const nearToStop = direction === 'up' && exitMode === 'none'
            && Number.isFinite(targetY) && (targetY - py) <= 2.5 && (targetY - py) > 0.05;
          const stallCap = nearToStop ? STALL_MS * 2 : STALL_MS;
          if (Date.now() - lastChangeTs > stallCap) {
            stalled = true;
            break;
          }
        }
      }
    } finally {
      // exit=auto on dir=up: keep forward for the step-off phase below.
      // exit=none after reaching --to: keep forward into the wall so the
      // bot stays on the ladder (clearing controls made it slide down
      // before we sampled end position — test_ladder_up_to_specific_y).
      if (direction === 'up' && exitMode === 'auto') {
        /* forward held for exit translation */
      } else if (direction === 'up' && exitMode === 'none' && reachedTarget) {
        try { b.setControlState('forward', true); } catch {}
      } else {
        clearAllControls(b);
      }
    }

    // Exit translation phase: only for dir=up with exit=auto, only if we
    // actually reached the climb target.
    //
    // Why: when the climb terminates the bot is at feet ≈ topY+1 in mid-
    // air above the ladder column. With forward still pressed, ladder
    // physics no longer applies (bot is above the climbable), gravity
    // takes over, but horizontal velocity carries the bot one cell
    // forward — landing on the adjacent solid block (e.g. top of the
    // pillar the ladder was attached to). Releasing all controls
    // immediately at climb-target lets the bot fall straight back down
    // onto the ladder (test_ladder_up_exits_onto_top_of_pillar: bot
    // reached Y=72 but X stayed at 1.6 when controls were released too
    // early).
    if (direction === 'up' && exitMode === 'auto' && reachedTarget) {
      // Press jump for the leap-off boost. Residual ladderClimbSpeed
      // momentum carries the bot ~0.3-0.5 blocks above the top of
      // the column before gravity dominates; jump adds to that brief
      // window. Sprint was tried and made things worse (it disturbs
      // the ladder-physics velocity clamp).
      try { b.setControlState('jump', true); } catch {}

      const EXIT_BUDGET_MS = 1500;
      const EXIT_POLL_MS = 100;
      const exitDeadline = Date.now() + EXIT_BUDGET_MS;
      try {
        while (Date.now() < exitDeadline) {
          await sleep(EXIT_POLL_MS);
          const fpos = b.entity.position;
          const fcx = Math.floor(fpos.x);
          const fcz = Math.floor(fpos.z);
          // Done when bot translates out of the ladder column's XZ
          // cell. Don't gate on onGround — bot may still be airborne
          // briefly above the landing block; the post-exit settle
          // sleep below lets gravity finish the landing.
          const translated = (fcx !== startCellX || fcz !== startCellZ);
          if (translated) break;
        }
      } finally {
        clearAllControls(b);
      }
    } else if (!(direction === 'up' && exitMode === 'none' && reachedTarget)) {
      clearAllControls(b);
    }

    // After releasing controls, give physics time to settle (the bot may
    // be airborne at exit). exit=none holds forward — short settle only.
    await sleep(direction === 'up' && exitMode === 'none' && reachedTarget ? 200 : 600);

    const endPos = b.entity.position.clone();
    const dy = Math.round((endPos.y - startPos.y) * 10) / 10;

    const endCell = {
      x: Math.floor(endPos.x),
      y: Math.floor(endPos.y),
      z: Math.floor(endPos.z),
    };
    const endBlock = b.blockAt(new Vec3(endCell.x, endCell.y, endCell.z));
    const stillOnLadder = isClimbableBlock(endBlock);

    if (!reachedTarget) {
      return fail(
        stalled ? 'LADDER_STALLED' : 'LADDER_TIMEOUT',
        stalled
          ? `Climb ${direction} stalled at Y=${endPos.y.toFixed(2)} (target Y=${targetY}). Bot didn't move for ${STALL_MS}ms — wrong facing, no climbable above/below, or blocked by ceiling.`
          : `Climb ${direction} timed out after ${timeoutMs}ms at Y=${endPos.y.toFixed(2)} (target Y=${targetY}).`,
        {
          observed_state: {
            start: posObj(startPos),
            end: posObj(endPos),
            target_y: targetY,
            column_top_y: topY,
            column_bottom_y: bottomY,
            still_on_ladder: stillOnLadder,
            dy,
          },
          next_action_hint:
            direction === 'up'
              ? 'Check: is there a solid block above the ladder top to step onto? mc inspect <x> <topY+1> <z>'
              : 'Check: is there a solid landing block at the bottom of the column? mc inspect <x> <bottomY-1> <z>',
          retry_safe: true,
        },
      );
    }

    return {
      ok: true,
      command: 'ladder',
      data: {
        dir: direction,
        start: posObj(startPos),
        end: posObj(endPos),
        target_y: targetY,
        column_top_y: topY,
        column_bottom_y: bottomY,
        dy,
        still_on_ladder: stillOnLadder,
        ...(enteredFromAbove ? { entered_from_above: enteredFromAbove } : {}),
      },
      result: `Ladder ${direction}: Y ${startPos.y.toFixed(1)} → ${endPos.y.toFixed(1)} (Δy=${dy >= 0 ? '+' : ''}${dy})${enteredFromAbove ? ' [entered shaft from above]' : ''}${stillOnLadder ? ' [still on ladder]' : ''}.`,
    };
  };
}
