/**
 * Named escape strategies extracted from queries.escape (Phase 5).
 * ADR: docs/design/action-contract.md
 */

import { AIR_NAMES } from '../../_block-sets.js';
import { DIR_VEC_4, DIR_VEC_8 } from '../../_directions.js';
import { pathfindGoalCapped } from '../../_helpers.js';
import { fail } from '../../../shared/action-contract.js';

export async function escapeStrategyInAir({ b, standingState, fail, recordEscapeSuccess, fromPos, cls }) {
  await new Promise((r) => setTimeout(r, 600));
  const after = standingState(b);
  if (after.classification !== 'in_air') {
    return recordEscapeSuccess({
      ok: true,
      data: {
        action_taken: 'wait_for_landing',
        from: fromPos,
        to: after.position,
        classification_before: cls,
        classification_after: after.classification,
        success: true,
      },
      result: `Waited 600ms for physics; now ${after.classification} at ${after.cell.x},${after.cell.y},${after.cell.z}.`,
    });
  }
  return fail(
    'ESCAPE_FAILED_AIRBORNE',
    `mc escape waited 600ms but bot is still in_air at ${after.cell.x},${after.cell.y},${after.cell.z} — wait for landing or use mc pillar_up with a block if over void.`,
    {
      observed_state: {
        classification_before: cls,
        classification_after: after.classification,
        from: fromPos,
        to: after.position,
        cell: after.cell,
      },
      next_action_hint: 'mc wait 2',
      retry_safe: true,
    },
  );
}

// Names that would kill or hurt-then-trap a bot if exposed by an auto-dig.
const LETHAL_NEIGHBORS = new Set([
  'lava', 'flowing_lava', 'fire', 'soul_fire', 'cactus', 'magma_block',
  'sweet_berry_bush', 'powder_snow', 'wither_rose',
]);

export async function escapeStrategyEnclosureInside(ctx) {
  // Auto-dig the nearest adjacent wall cell so the bot can step out. Mason
  // 2026-05-27 entombed himself by filling the shelter interior; the prior
  // strategy returned ESCAPE_ENCLOSURE and told him to "use mc dig", but
  // a bot with no tool / wedged in a 1×1 air pocket couldn't follow that
  // advice. The dig is itself the escape primitive.
  //
  // Strategy: scan the 8 cells adjacent to the bot (foot + head level, 4
  // cardinal dirs). For each candidate, verify the block BEHIND it (one
  // further out) is not lava/cactus/fire AND the cell 2 below isn't air
  // (fall risk). Pick the first SAFE solid block, dig with force=true.
  //
  // HP gate: refuse if HP < 8. At low HP any exposure to a damage source
  // (fall, mob aggro, lava splash) is fatal. Better to escalate than to
  // gamble. Mason died at HP 2.5 calling mc escape underground 2026-05-27
  // and lost his full inventory to the death + bad respawn.
  const { b, before, cls, fromPos, getActions, recordEscapeSuccess } = ctx;
  const hp = Number(b.health || 0);
  if (hp < 8) {
    return fail('ESCAPE_HP_TOO_LOW', `HP=${hp.toFixed(1)} is below the auto-dig threshold (8). Opening new terrain at low HP risks lava/fall/mob exposure with no recovery margin. Operator must teleport.`, {
      observed_state: { classification: cls, hp, blocked_dirs: before.blocked_dirs },
      next_action_hint: `tp ${b.username || 'bot'} <safe_coord>  # operator rcon`,
      retry_safe: false,
    });
  }
  const actions = getActions ? getActions() : null;
  if (!actions || typeof actions.dig !== 'function') {
    return fail('ESCAPE_ENCLOSURE_NO_DIG', `You're enclosed inside a built structure but mc dig action is unavailable. Operator intervention required.`, {
      observed_state: { classification: cls, blocked_dirs: before.blocked_dirs, ceiling_within: before.ceiling_within },
      retry_safe: false,
    });
  }
  const fx = Math.floor(b.entity.position.x);
  const fy = Math.floor(b.entity.position.y);
  const fz = Math.floor(b.entity.position.z);
  // Try each of the 8 adjacent wall cells. Bias toward foot level first
  // (lets the bot step horizontally — less drop risk than head-level dig).
  const candidates = [];
  for (const lvl of ['foot', 'head']) {
    const yy = fy + (lvl === 'head' ? 1 : 0);
    for (const [dx, dz, dir] of [[1,0,'east'],[-1,0,'west'],[0,1,'south'],[0,-1,'north']]) {
      candidates.push({ x: fx + dx, y: yy, z: fz + dz, dx, dz, dir, lvl });
    }
  }
  const tried = [];
  for (const c of candidates) {
    const blk = b.blockAt({ x: c.x, y: c.y, z: c.z });
    if (!blk || AIR_NAMES.has(blk.name)) continue;
    if (blk.name === 'bedrock') continue;

    // Safety scan A: block immediately BEHIND the candidate (one further
    // out in same dir). If that's lava/cactus/fire, digging exposes the
    // bot to it.
    const behind = b.blockAt({ x: c.x + c.dx, y: c.y, z: c.z + c.dz });
    if (behind && LETHAL_NEIGHBORS.has(behind.name)) {
      tried.push({ ...c, block: blk.name, result: `skipped: ${behind.name} behind` });
      continue;
    }
    // Safety scan B: cell at c.y below the candidate (foot-level only —
    // a head-level dig already drops bot down one block which is fine).
    if (c.lvl === 'foot') {
      const below = b.blockAt({ x: c.x, y: c.y - 1, z: c.z });
      const below2 = b.blockAt({ x: c.x, y: c.y - 2, z: c.z });
      // If both directly-below cells are air, the bot would fall ≥2 blocks
      // after stepping into the opening. Skip — find a less risky side.
      if (below && AIR_NAMES.has(below.name) && below2 && AIR_NAMES.has(below2.name)) {
        tried.push({ ...c, block: blk.name, result: 'skipped: 2+ block drop below' });
        continue;
      }
      // Lava directly below is instant death on step-out.
      if (below && LETHAL_NEIGHBORS.has(below.name)) {
        tried.push({ ...c, block: blk.name, result: `skipped: ${below.name} below` });
        continue;
      }
    }

    try {
      const r = await actions.dig({ x: c.x, y: c.y, z: c.z, force: true });
      tried.push({ ...c, block: blk.name, result: r?.ok ? 'dug' : (r?.error?.code || 'failed') });
      if (r?.ok) {
        return recordEscapeSuccess({
          ok: true,
          data: {
            action_taken: 'dig_out_of_enclosure',
            from: fromPos,
            dug: { x: c.x, y: c.y, z: c.z, dir: c.dir, level: c.lvl, block: blk.name },
            classification_before: cls,
            success: true,
          },
          result: `Escape: dug ${blk.name} at ${c.x},${c.y},${c.z} (${c.dir}, ${c.lvl}-level). Step out through the new opening.`,
        });
      }
    } catch (e) {
      tried.push({ ...c, block: blk?.name, result: `exception:${(e && e.message) || e}` });
    }
  }
  return fail('ESCAPE_ENCLOSURE_DIG_FAILED', `Bot enclosed inside built structure; tried ${tried.length} adjacent block(s) but none were both diggable AND safe (no lava/cactus behind, no 2-block drop below). Operator: rcon /tp <bot> to a clear cell.`, {
    observed_state: {
      classification: cls,
      blocked_dirs: before.blocked_dirs,
      ceiling_within: before.ceiling_within,
      attempts: tried,
    },
    next_action_hint: `tp ${ctx.b?.username || 'bot'} <safe_x> <safe_y> <safe_z>`,
    retry_safe: false,
  });
}

export async function escapeStrategyStepUpOnly({ b, before, cell, fromPos, cls, standingState, recordEscapeSuccess, goals }) {
      const DIR_VEC = DIR_VEC_4;
      const candidates = (before.step_up_dirs || []).filter((d) => DIR_VEC[d]);
      if (candidates.length === 0) {
                return fail('ESCAPE_STEP_UP_NO_DIR', `Classified step_up_only but no step_up_dirs to follow. Try mc dig to break out.`, {
          observed_state: { classification: cls, blocked_dirs: before.blocked_dirs, step_up_dirs: before.step_up_dirs },
          retry_safe: false,
        });
      }
      const attempts = [];
      for (const pickDir of candidates) {
        const v = DIR_VEC[pickDir];
        const targetCell = { x: cell.x + v.dx, y: cell.y + 1, z: cell.z + v.dz };
        try {
          const goal = new goals.GoalBlock(targetCell.x, targetCell.y, targetCell.z);
          await pathfindGoalCapped(b, () => b.pathfinder.goto(goal), 1500, 'step_up_to');
        } catch {
          /* goal cleared in pathfindGoalCapped */
        }
        const after = standingState(b);
        attempts.push({ dir: pickDir, target: targetCell, after: after.classification });
        // Success if we're no longer in step_up_only — moving onto the
        // higher step typically lands us in open/alley/edge, but legitimate
        // outcomes also include on_pillar (we climbed onto a 1×1 wall top —
        // a follow-up mc pillar_down resolves that) or step_up_only-pointing-
        // a-new-direction. Anything ≠ original classification means the
        // jump landed somewhere different.
        if (after.classification !== 'step_up_only') {
          return recordEscapeSuccess({
            ok: true,
            data: {
              action_taken: `step_up_${pickDir}`,
              from: fromPos,
              to: after.position,
              classification_before: cls,
              classification_after: after.classification,
              attempts,
              success: true,
            },
            result: `Stepped up ${pickDir} from step_up_only. Now ${after.classification} at ${after.cell.x},${after.cell.y},${after.cell.z}.`,
          });
        }
      }
              return fail('ESCAPE_STEP_UP_FAILED', `Tried step-up in ${candidates.join(', ')} but pathfinder couldn't complete the jump. Try mc dig or mc move directly.`, {
          observed_state: { classification: cls, attempts, step_up_dirs: before.step_up_dirs },
          retry_safe: true,
        });
}

export async function escapeStrategyInWater({ b, before, cell, fromPos, cls, standingState, recordEscapeSuccess, getActions, goals, Vec3, sleep }) {
      const DIR_VEC = DIR_VEC_8;
      const CARDINAL_DIRS = DIR_VEC_4;
      const attempts = [];
      const diag = {}; // structured per-phase diagnostics for the brain

      // Step 0: if submerged (head_in_water), swim to surface BEFORE
      // anything else. Buoyancy from `jump` lifts ~0.4b per 150ms tick.
      // Extended from the old 25-tick cap to 80 ticks (~12s) — circuit-v1
      // showed bot at y=51 with ~12 blocks of water above; old loop
      // didn't reach surface. New loop bails the moment head clears
      // water OR HP falls below 8 (drowning burning HP — abort and
      // try the next strategy instead of drowning silently).
      let curState = before;
      let curCell = { x: cell.x, y: cell.y, z: cell.z };
      let surfacedBy = null;
      if (before.head_in_water) {
        try {
          for (let i = 0; i < 80; i++) {
            b.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 150));
            const s = standingState(b);
            if (s && s.cell) {
              curState = s;
              curCell = { x: s.cell.x, y: s.cell.y, z: s.cell.z };
            }
            if (s && !s.head_in_water) { surfacedBy = i + 1; break; }
            // Drowning-abort guard: if HP drops below 8 we're losing
            // fast; cut losses and try a different strategy.
            if (b.health !== undefined && b.health < 8) {
              attempts.push({ method: 'swim_up', surfaced: false, aborted_low_hp: true, ticks: i + 1, hp: b.health });
              break;
            }
          }
        } finally {
          try { b.setControlState('jump', false); } catch {}
        }
        if (surfacedBy !== null) {
          attempts.push({ method: 'swim_up', surfaced: true, ticks: surfacedBy });
        }
        diag.swim_up = { surfaced: surfacedBy !== null, ticks: surfacedBy ?? 80, hp_at_end: b.health };
        // Brief settle for buoyancy oscillation.
        await new Promise(r => setTimeout(r, 200));
      }
      // After potentially surfacing, the bot might already be open/alley.
      const postSwim = standingState(b);
      if (postSwim && !postSwim.foot_in_water) {
        return recordEscapeSuccess({
          ok: true,
          data: { action_taken: 'swim_up', from: fromPos, to: postSwim.position, classification_before: cls, classification_after: postSwim.classification, attempts, diag, success: true },
          result: `Surfaced from submerged water. Now ${postSwim.classification} at ${postSwim.cell.x},${postSwim.cell.y},${postSwim.cell.z}.`,
        });
      }
      if (postSwim && postSwim.cell) {
        curCell = { x: postSwim.cell.x, y: postSwim.cell.y, z: postSwim.cell.z };
      }

      // 1. Scan 8 directions for a dry standable cell. Spiral by radius
      // (1, 2, 3, ...) so we try near cells first. Radius 32 if
      // surfaced (we have time once head is clear); 6 if still
      // submerged (don't pathfind far while drowning). Cardinal-only
      // 4-block scan in the old code missed diagonal shores entirely —
      // circuit-v1 was in deep ocean where the nearest shore was NE,
      // not N/E/S/W.
      const scanRadius = (surfacedBy !== null || !before.head_in_water) ? 32 : 6;
      const dirSearch = (surfacedBy !== null || !before.head_in_water) ? DIR_VEC : CARDINAL_DIRS;
      let bestDry = null;
      // BFS-by-radius across all 8 directions so we find the closest hit.
      outer: for (let r = 1; r <= scanRadius; r++) {
        for (const [dirName, v] of Object.entries(dirSearch)) {
          const tx = curCell.x + v.dx * r;
          const ty = curCell.y;
          const tz = curCell.z + v.dz * r;
          const floor = b.blockAt(new Vec3(tx, ty - 1, tz));
          const footAt = b.blockAt(new Vec3(tx, ty, tz));
          const headAt = b.blockAt(new Vec3(tx, ty + 1, tz));
          if (!floor || !footAt || !headAt) continue;
          const solidFloor = floor.boundingBox === 'block' && floor.name !== 'water' && floor.name !== 'flowing_water';
          const openFoot = AIR_NAMES.has(footAt.name);
          const openHead = AIR_NAMES.has(headAt.name);
          if (solidFloor && openFoot && openHead) {
            bestDry = { dir: dirName, r, target: { x: tx, y: ty, z: tz } };
            break outer;
          }
        }
      }
      diag.land_scan = { radius: scanRadius, dirs: Object.keys(dirSearch).length, found: !!bestDry, ...(bestDry && { nearest_dry: bestDry }) };
      // Keep using `cell` for the rest of the existing pillar/place
      // logic — re-bind it to current location so the place-floor and
      // pillar-up branches probe the right cells.
      cell.x = curCell.x;
      cell.y = curCell.y;
      cell.z = curCell.z;

      // Step-up rescue. Common circuit-v3 trap: 1×1 water well surrounded
      // by solid blocks at FOOT LEVEL (cardinal neighbors are foot_solid).
      // Land scan rejects these because the foot cell isn't air — but the
      // bot can JUMP UP onto the block at neighbor.y+1 (which is air).
      // This is exactly what `standingState` reports in step_up_dirs.
      //
      // Mirror the existing step_up_only branch (line ~980): for each
      // step-up direction, pathfind to (cell + dir, cell.y + 1).
      const stepUpDirs = (() => {
        // Re-read standing state since the bot may have moved during
        // swim_up. Use the current cardinal map (4 dirs) for step-up
        // candidates.
        const cur = standingState(b);
        return (cur?.step_up_dirs || before.step_up_dirs || []).filter((d) => CARDINAL_DIRS[d]);
      })();
      if (stepUpDirs.length > 0) {
        diag.step_up = { candidates: stepUpDirs };
        for (const pickDir of stepUpDirs) {
          const v = CARDINAL_DIRS[pickDir];
          const targetCell = { x: cell.x + v.dx, y: cell.y + 1, z: cell.z + v.dz };
          try {
            const goal = new goals.GoalBlock(targetCell.x, targetCell.y, targetCell.z);
            await pathfindGoalCapped(b, () => b.pathfinder.goto(goal), 1500, 'step_up_to');
          } catch {
            /* goal cleared in pathfindGoalCapped */
          }
          const after = standingState(b);
          attempts.push({ method: 'step_up', dir: pickDir, target: targetCell, after: after.classification });
          if (!after.foot_in_water) {
            diag.step_up.succeeded_dir = pickDir;
            return recordEscapeSuccess({
              ok: true,
              data: { action_taken: `step_up_${pickDir}`, from: fromPos, to: after.position, classification_before: cls, classification_after: after.classification, target: targetCell, attempts, diag, success: true },
              result: `Stepped up ${pickDir} from water onto adjacent solid. Now ${after.classification} at ${after.cell.x},${after.cell.y},${after.cell.z}.`,
            });
          }
        }
        diag.step_up.succeeded_dir = null;
      } else {
        diag.step_up = { candidates: [] };
      }
      // 2. Try pathfinder + sprint toward nearest dry cell.
      if (bestDry) {
        try {
          const goal = new goals.GoalBlock(bestDry.target.x, bestDry.target.y, bestDry.target.z);
          await pathfindGoalCapped(b, () => b.pathfinder.goto(goal), 2500, 'water_to');
        } catch {
          /* goal cleared in pathfindGoalCapped */
        }
        let after = standingState(b);
        attempts.push({ method: 'pathfinder', dir: bestDry.dir, after: after.classification });
        if (!after.foot_in_water) {
          return recordEscapeSuccess({
            ok: true,
            data: { action_taken: `swim_${bestDry.dir}`, from: fromPos, to: after.position, classification_before: cls, classification_after: after.classification, target: bestDry.target, attempts, success: true },
            result: `Swam to dry ground ${bestDry.dir} (${bestDry.r} blocks). Now ${after.classification} at ${after.cell.x},${after.cell.y},${after.cell.z}.`,
          });
        }
        // Brute-force: look at the dry target and burst forward+sprint+jump
        try {
          await b.lookAt(new Vec3(bestDry.target.x + 0.5, cell.y + 1.6, bestDry.target.z + 0.5));
          b.setControlState('forward', true);
          b.setControlState('sprint', true);
          b.setControlState('jump', true);
          await new Promise(r => setTimeout(r, 900));
        } finally {
          try { b.setControlState('forward', false); b.setControlState('sprint', false); b.setControlState('jump', false); } catch {}
        }
        after = standingState(b);
        attempts.push({ method: 'sprint_jump', dir: bestDry.dir, after: after.classification });
        if (!after.foot_in_water) {
          return recordEscapeSuccess({
            ok: true,
            data: { action_taken: `sprint_${bestDry.dir}`, from: fromPos, to: after.position, classification_before: cls, classification_after: after.classification, target: bestDry.target, attempts, success: true },
            result: `Sprinted out to dry ground ${bestDry.dir}. Now ${after.classification} at ${after.cell.x},${after.cell.y},${after.cell.z}.`,
          });
        }
      }
      // 3. Place a block under feet or pillar up.
      const PLACEABLE_RE = /^(dirt|coarse_dirt|cobblestone|stone|sand|gravel|.*_planks|netherrack)$/;
      const placeable = b.inventory.items().find(i => PLACEABLE_RE.test(i.name));
      if (placeable) {
        try {
          await b.equip(placeable, 'hand');
          // Look down at the block below us; place block on its top face.
          const refBlock = b.blockAt(new Vec3(cell.x, cell.y - 1, cell.z));
          if (refBlock && refBlock.boundingBox === 'block') {
            await b.placeBlock(refBlock, new Vec3(0, 1, 0));
          } else {
            // Floor is also water — try side-place from a solid neighbor below
            for (const v of Object.values(DIR_VEC)) {
              const sideBlock = b.blockAt(new Vec3(cell.x + v.dx, cell.y - 1, cell.z + v.dz));
              if (sideBlock && sideBlock.boundingBox === 'block') {
                try {
                  await b.placeBlock(sideBlock, new Vec3(-v.dx, 1, -v.dz));
                  break;
                } catch {}
              }
            }
          }
          await new Promise(r => setTimeout(r, 400));
        } catch (e) {
          attempts.push({ method: 'place_floor', error: e?.message || String(e) });
        }
        let after = standingState(b);
        attempts.push({ method: 'place_floor', after: after.classification, placed: placeable.name });
        if (!after.foot_in_water) {
          return recordEscapeSuccess({
            ok: true,
            data: { action_taken: 'place_floor', from: fromPos, to: after.position, classification_before: cls, classification_after: after.classification, placed: placeable.name, attempts, success: true },
            result: `Placed ${placeable.name} as foothold. Now ${after.classification} at ${after.cell.x},${after.cell.y},${after.cell.z}.`,
          });
        }
        // Pillar up: jump+place under feet repeatedly.
        try {
          for (let i = 0; i < 3; i++) {
            // Look straight down so place targets the block we're standing on
            await b.lookAt(new Vec3(cell.x + 0.5, cell.y - 0.5, cell.z + 0.5));
            b.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 300));
            const ref = b.blockAt(new Vec3(cell.x, cell.y, cell.z));
            // After the jump the bot's foot cell becomes air briefly;
            // place targets a solid neighbor 1 below the jump apex.
            const refBelow = b.blockAt(new Vec3(cell.x, cell.y - 1, cell.z));
            if (refBelow && refBelow.boundingBox === 'block') {
              try { await b.placeBlock(refBelow, new Vec3(0, 1, 0)); } catch {}
            }
            b.setControlState('jump', false);
            await new Promise(r => setTimeout(r, 200));
          }
        } catch {
          try { b.setControlState('jump', false); } catch {}
        }
        after = standingState(b);
        attempts.push({ method: 'pillar_up', after: after.classification });
        if (!after.foot_in_water) {
          return recordEscapeSuccess({
            ok: true,
            data: { action_taken: 'pillar_up', from: fromPos, to: after.position, classification_before: cls, classification_after: after.classification, placed: placeable.name, attempts, success: true },
            result: `Pillared up out of water with ${placeable.name}. Now ${after.classification} at ${after.cell.x},${after.cell.y},${after.cell.z}.`,
          });
        }
      }
      // 4. Boat fallback. If bot has any *_boat AND no land was reached,
      // place a boat at current position. Boats float on water — a placed
      // boat at our foot cell means the bot can mount and effectively
      // "stand" on the boat at the water surface. From there it can
      // sail to shore. This is the FINAL water-escape strategy before
      // giving up, added after circuit-v1 showed deep ocean stuck for
      // 22 minutes with no working primitive.
      const BOAT_NAMES = new Set([
        'oak_boat', 'spruce_boat', 'birch_boat', 'jungle_boat',
        'acacia_boat', 'dark_oak_boat', 'cherry_boat', 'mangrove_boat',
        'bamboo_raft', 'pale_oak_boat',
      ]);
      const boatItem = b.inventory.items().find(i => BOAT_NAMES.has(i.name));
      if (boatItem) {
        diag.boat_fallback = { has_boat: boatItem.name };
        // circuit-v13 (2026-05-22): native b.activateItem() is a silent
        // no-op on Paper 1.21+ for boat placement (same Paper-1.21+
        // packet routing as place_boat / mount). Delegate to
        // ACTIONS.board() which already has the full PaperMCP place +
        // mount fallback chain — and the b.vehicle force-sync that
        // landed in 6b1e5b3. Steve's agent recovered from this exact
        // STUCK_IN_WATER scenario by calling mc board manually; we just
        // need the escape primitive to do it inline.
        try {
          const actions = typeof getActions === 'function' ? getActions() : null;
          if (actions && typeof actions.board === 'function') {
            const boardRes = await actions.board({});
            diag.boat_fallback.board_ok = !!boardRes?.ok;
            diag.boat_fallback.board_data = boardRes?.data || null;
            if (boardRes?.error) diag.boat_fallback.board_error = boardRes.error;
            await sleep(300);
            const after = standingState(b);
            attempts.push({ method: 'boat_fallback', via: 'ACTIONS.board', after: after.classification, mounted: !!b.vehicle, board_ok: !!boardRes?.ok });
            diag.boat_fallback.placed = !!boardRes?.ok;
            diag.boat_fallback.mounted = !!b.vehicle;
            if (boardRes?.ok || !after.foot_in_water || b.vehicle) {
              return recordEscapeSuccess({
                ok: true,
                data: { action_taken: 'boat_fallback', from: fromPos, to: after.position, classification_before: cls, classification_after: after.classification, boat: boatItem.name, mounted: !!b.vehicle, attempts, diag, success: true },
                result: `Placed a ${boatItem.name} and ${b.vehicle ? 'boarded' : 'spawned next to'} it. Use mc sail_to X Y Z to travel to shore.`,
              });
            }
          } else {
            // Fall back to the legacy native path (covered by tests).
            await b.equip(boatItem, 'hand');
            await b.lookAt(new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5));
            await sleep(150);
            try { b.activateItem(); } catch {}
            await sleep(800);
            let newBoat = null;
            for (const e of Object.values(b.entities)) {
              if (e && (e.name?.endsWith('_boat') || e.name === 'boat' || e.name === 'bamboo_raft')) {
                if (e.position && e.position.distanceTo(b.entity.position) < 4) {
                  newBoat = e;
                  break;
                }
              }
            }
            if (newBoat) {
              try { await b.mount(newBoat); } catch {}
              await sleep(300);
              const after = standingState(b);
              attempts.push({ method: 'boat_fallback', after: after.classification, boat_id: newBoat.id, mounted: !!b.vehicle });
              diag.boat_fallback.placed = true;
              diag.boat_fallback.mounted = !!b.vehicle;
              if (!after.foot_in_water || b.vehicle) {
                return recordEscapeSuccess({
                  ok: true,
                  data: { action_taken: 'boat_fallback', from: fromPos, to: after.position, classification_before: cls, classification_after: after.classification, boat: boatItem.name, mounted: !!b.vehicle, attempts, diag, success: true },
                  result: `Placed a ${boatItem.name} and ${b.vehicle ? 'boarded' : 'spawned next to'} it. Use mc sail_to X Y Z to travel to shore.`,
                });
              }
            } else {
              diag.boat_fallback.placed = false;
              diag.boat_fallback.reason = 'no boat entity appeared (no ACTIONS.board available + native activateItem silent on Paper 1.21+)';
              attempts.push({ method: 'boat_fallback', placed: false });
            }
          }
        } catch (e) {
          diag.boat_fallback.error = e?.message || String(e);
          attempts.push({ method: 'boat_fallback', error: e?.message || String(e) });
        }
      } else {
        diag.boat_fallback = { has_boat: null };
      }

      // Nothing worked. Surface ALL diagnostic data so the brain can see
      // exactly which phases ran and which failed.
      const hpNow = b.health;
      return fail(
        'STUCK_IN_WATER',
        `Stuck in ${cls === 'in_flowing_water' ? 'flowing ' : ''}water at (${cell.x},${cell.y},${cell.z}). swim_up: ${diag.swim_up ? (diag.swim_up.surfaced ? 'surfaced' : 'did not surface') : 'not needed'}. land_scan: searched ${diag.land_scan?.radius || 0} blocks in ${diag.land_scan?.dirs || 0} dirs, ${diag.land_scan?.found ? 'found shore' : 'no shore'}. ${placeable ? 'pillar_up: tried, still in water.' : 'pillar_up: no placeable blocks.'} ${diag.boat_fallback?.has_boat ? `boat_fallback: ${diag.boat_fallback.placed ? 'placed but did not lift bot' : (diag.boat_fallback.reason || 'failed')}.` : 'boat_fallback: no boat in inventory.'} HP=${hpNow}.`,
        {
          observed_state: {
            classification: cls,
            foot_in_water: before.foot_in_water,
            head_in_water: before.head_in_water,
            nearest_dry: bestDry,
            has_placeable: !!placeable,
            has_boat: diag.boat_fallback?.has_boat || null,
            diag,
            attempts,
          },
          next_action_hint: diag.boat_fallback?.has_boat
            ? 'Call mc sail_to <shore_x> <shore_y> <shore_z> — the ferry primitive places + boards + sails to shore.'
            : placeable
              ? 'Pillar up further with mc place. Or chat for help.'
              : 'No tools or boats to escape. mc chat for steward help — DO NOT /kill.',
          retry_safe: false,
        },
      );
}
