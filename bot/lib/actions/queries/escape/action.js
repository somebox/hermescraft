import { Vec3 } from 'vec3';
import { fail } from '../../../shared/action-contract.js';
import { pathfindGoalCapped } from '../../_helpers.js';
import { standingState } from '../../_nav-helpers.js';
import { DIR_VEC_4 as DIR_VEC } from '../../_directions.js';
import {
  escapeStrategyEnclosureInside,
  escapeStrategyInAir,
  escapeStrategyInWater,
  escapeStrategyStepUpOnly,
} from './strategies.js';

export function createEscapeQueries({ ctx, ensureBot, getActions, utils, goals }) {
  const { sleep } = utils;

  return {
  /**
   * F53.3: mc escape — "get me unstuck" primitive. Reads the standing-state
   * classifier and picks a recovery strategy:
   *   corner / three_walled / wedge → sidestep to the most-open dir
   *   trapped (4 walls, no ceiling)  → pillar up with held cobble / dirt
   *   edge                            → step away from cliff
   *   in_air                          → wait briefly (let physics settle)
   *   enclosure_inside                → return error (defer to mc dig)
   *   open / alley                    → no-op success
   *
   * Returns {action_taken, from, to, classification_before, classification_after, success}.
   * Brain can call this proactively when it sees a sticky standing state,
   * or after MOVEMENT_PRECONDITION_FAILED to recover.
   */
  async escape() {
    const b = ensureBot();
    const before = standingState(b);
    if (before.error === 'no_bot') {
              return fail('NO_BOT', 'bot not ready', { retry_safe: true });
    }
    // circuit-v12 (2026-05-22): the standingState classifier checks
    // foot_in_water at the foot cell only. At a beach edge the foot
    // cell may be solid sand while the bot's body/head are submerged
    // in the adjacent water column — classification comes back as
    // step_up_only, and escape's step_up branch then fails to climb
    // (pathfinder can't reliably do "swim up + step onto land" via
    // a GoalBlock alone). Steve hit ESCAPE_STEP_UP_FAILED 15× over
    // 5 minutes in v12. Mineflayer's bot.entity.isInWater reports
    // "any part of the player is touching water", which is the true
    // signal for "needs water-escape strategy." When that's true,
    // route through the water-escape branch regardless of foot-cell
    // classification — that branch has swim-up + 8-way land scan +
    // sprint+jump + place-block-and-pillar fallbacks.
    let cls = before.classification;
    const reallyInWater = !!(b.entity?.isInWater) || before.head_in_water || before.foot_in_water;
    if (reallyInWater && cls !== 'in_water' && cls !== 'in_flowing_water') {
      cls = 'in_water';
    }
    const cell = before.cell;
    const fromPos = { ...before.position };

    // F57.1 — escape-loop detector. If the brain has been hammering
    // mc escape because every subsequent attempt re-traps the bot, calling
    // escape a 3rd time inside 90s tells us the terrain (or the brain's
    // plan) keeps routing back to the same trap. Surface a strong error
    // pointing at root-cause options instead of doing another sidestep.
    const ESCAPE_LOOP_WINDOW_MS = 90_000;
    const recentEscapes = Array.isArray(ctx?.runtime?.recentEscapes) ? ctx.runtime.recentEscapes : [];
    const cutoff = Date.now() - ESCAPE_LOOP_WINDOW_MS;
    const recent = recentEscapes.filter(e => e.ts > cutoff);
    if (cls !== 'open' && cls !== 'alley' && recent.length >= 2) {
      const lastFailed = ctx?.runtime?.lastMoveFailed?.intended_target || null;
      const ages = recent.map(e => Math.round((Date.now() - e.ts) / 100) / 10);
      return fail(
        'ESCAPE_RECURRING_LOOP',
        `mc escape called ${recent.length + 1}× in last ${ESCAPE_LOOP_WINDOW_MS / 1000}s — terrain or plan is re-trapping you (current: ${cls} at ${cell.x},${cell.y},${cell.z}). Don't escape-spam. Options: (a) mc dig at the wall/lip that keeps trapping you (mc inspect <neighbor> to identify it), (b) mc go_mark to a known-safe coord and approach the original target from a different side, (c) ask your partner for help.${lastFailed ? ` Stop retrying mc goto ${lastFailed.x} ${lastFailed.y} ${lastFailed.z} — pick a different destination.` : ''}`,
        {
          observed_state: {
            classification: cls,
            blocked_dirs: before.blocked_dirs,
            open_dirs: before.open_dirs,
            recent_escape_ages_s: ages,
            do_not_retry_goto: lastFailed,
            your_cell: cell,
          },
          next_action_hint: lastFailed
            ? `mc inspect ${lastFailed.x} ${lastFailed.y} ${lastFailed.z}`
            : `mc inspect ${cell.x} ${cell.y} ${cell.z}`,
          retry_safe: false,
        },
      );
    }

    // Trivial: already free.
    if (cls === 'open' || cls === 'alley') {
      return {
        ok: true,
        data: { action_taken: 'none', from: fromPos, to: fromPos, classification_before: cls, classification_after: cls, success: true },
        result: `Already ${cls} at ${cell.x},${cell.y},${cell.z} — no escape needed.`,
      };
    }

    // F57.1 + F57.2 success bookkeeping. Push the pre-escape cell into
    // the stuck-cell registry (so pathfind preflight blackballs it on
    // any subsequent goto whose target lands within 1 of it) and append
    // to recentEscapes for the loop detector.
    const recordEscapeSuccess = (resp) => {
      if (ctx) {
        if (!Array.isArray(ctx.runtime.recentStuckCells)) ctx.runtime.recentStuckCells = [];
        const cx = cell.x, cy = cell.y, cz = cell.z;
        const existing = ctx.runtime.recentStuckCells.find(e => e.cell.x === cx && e.cell.y === cy && e.cell.z === cz);
        if (existing) { existing.ts = Date.now(); existing.hit_count += 1; }
        else {
          ctx.runtime.recentStuckCells.push({ ts: Date.now(), cell: { x: cx, y: cy, z: cz }, source: 'escape', hit_count: 1 });
          if (ctx.runtime.recentStuckCells.length > 12) ctx.runtime.recentStuckCells.shift();
        }
        if (!Array.isArray(ctx.runtime.recentEscapes)) ctx.runtime.recentEscapes = [];
        ctx.runtime.recentEscapes.push({ ts: Date.now(), cell: { x: cx, y: cy, z: cz }, classification_before: cls });
        if (ctx.runtime.recentEscapes.length > 6) ctx.runtime.recentEscapes.shift();
      }
      // Surface do_not_retry_goto on success too — telling the brain to
      // plan a fresh approach instead of re-firing the failed coord.
      const lastFailed = ctx?.runtime?.lastMoveFailed?.intended_target || null;
      if (lastFailed && resp?.data && typeof resp.data === 'object') {
        resp.data.do_not_retry_goto = lastFailed;
      }
      return resp;
    };

    const escapeCtx = { b, before, cell, fromPos, cls, standingState, recordEscapeSuccess, getActions, goals, Vec3, sleep };
    const escapeDispatch = {
      in_air: () => escapeStrategyInAir({ b, standingState, fail, recordEscapeSuccess, fromPos, cls }),
      in_water: () => escapeStrategyInWater(escapeCtx),
      in_flowing_water: () => escapeStrategyInWater(escapeCtx),
      step_up_only: () => escapeStrategyStepUpOnly(escapeCtx),
      enclosure_inside: () => escapeStrategyEnclosureInside(escapeCtx),
    };
    if (escapeDispatch[cls]) {
      return escapeDispatch[cls]();
    }


    // Sidestep for corner/three_walled/wedge/edge.
    if (cls === 'corner' || cls === 'three_walled' || cls === 'wedge' || cls === 'edge') {
      const candidates = before.open_dirs.filter(d => DIR_VEC[d]);
      if (candidates.length === 0) {
                return fail('ESCAPE_NO_OPEN_DIR', `Classified ${cls} but no open cardinal direction to sidestep into. Try mc dig to break out, or mc inspect neighbors.`, {
          observed_state: { classification: cls, blocked_dirs: before.blocked_dirs, cliff_dirs: before.cliff_dirs },
          retry_safe: false,
        });
      }
      // F56: try EACH open direction in order (was just the first). Each
      // attempt gets a tight 1.2s pathfinder cap. After each, re-classify;
      // bail out as soon as we reach open/alley. If pathfinder fails ALL
      // directions, fall through to a brute-force jump+forward sweep —
      // catches the 0.3-block-ledge / door-frame-stub geometry that
      // pathfinder mis-models.
      const attempts = [];
      for (const pickDir of candidates) {
        const v = DIR_VEC[pickDir];
        const targetCell = { x: cell.x + v.dx, y: cell.y, z: cell.z + v.dz };
        try {
          const goal = new goals.GoalBlock(targetCell.x, targetCell.y, targetCell.z);
          await pathfindGoalCapped(b, () => b.pathfinder.goto(goal), 1200, 'sidestep_to');
        } catch {
          /* goal cleared in pathfindGoalCapped */
        }
        const intermediate = standingState(b);
        attempts.push({ dir: pickDir, after: intermediate.classification });
        if (intermediate.classification === 'open' || intermediate.classification === 'alley') {
          return recordEscapeSuccess({
            ok: true,
            data: {
              action_taken: `sidestep_${pickDir}`,
              from: fromPos,
              to: intermediate.position,
              classification_before: cls,
              classification_after: intermediate.classification,
              attempts,
              success: true,
            },
            result: `Sidestepped ${pickDir} from ${cls} cell. Now ${intermediate.classification} at ${intermediate.cell.x},${intermediate.cell.y},${intermediate.cell.z}.`,
          });
        }
      }
      // Pathfinder failed every direction. Brute-force fallback: face each
      // open dir and burst forward+jump for 400ms. Mineflayer-pathfinder
      // can't model the "step over a 0.3-block-tall door-frame stub" case,
      // but the bot's physics can usually carry it across with a jump.
      for (const pickDir of candidates) {
        const v = DIR_VEC[pickDir];
        try {
          await b.lookAt(new Vec3(cell.x + 0.5 + v.dx * 1.5, cell.y + 1.62, cell.z + 0.5 + v.dz * 1.5));
          b.setControlState('forward', true);
          b.setControlState('jump', true);
          await new Promise(r => setTimeout(r, 450));
          b.setControlState('forward', false);
          b.setControlState('jump', false);
          await new Promise(r => setTimeout(r, 150));
        } catch {
          try { b.setControlState('forward', false); b.setControlState('jump', false); } catch {}
        }
        const intermediate = standingState(b);
        attempts.push({ dir: pickDir, after: intermediate.classification, mode: 'burst' });
        if (intermediate.classification === 'open' || intermediate.classification === 'alley') {
          return recordEscapeSuccess({
            ok: true,
            data: {
              action_taken: `burst_${pickDir}`,
              from: fromPos,
              to: intermediate.position,
              classification_before: cls,
              classification_after: intermediate.classification,
              attempts,
              success: true,
            },
            result: `Brute-force burst ${pickDir} from ${cls} cell. Now ${intermediate.classification} at ${intermediate.cell.x},${intermediate.cell.y},${intermediate.cell.z}.`,
          });
        }
      }
      // Nothing worked. Report the final state with the full attempt
      // breakdown so the brain knows escape exhausted its options.
      const after = standingState(b);
              return fail('ESCAPE_STUCK', `Tried ${attempts.length} sidestep + burst attempt(s); still ${after.classification} at ${after.cell.x},${after.cell.y},${after.cell.z}. Dig a wall (mc dig) or pick a different angle (mc move).`, {
          observed_state: {
            classification_before: cls,
            classification_after: after.classification,
            attempts,
            blocked_dirs: after.blocked_dirs,
            open_dirs: after.open_dirs,
            bot_position: after.position,
          },
          retry_safe: false,
        });
    }

    // Trapped: pillar up if no ceiling, else fail (brain should mc dig).
    // Round-4 in-game QA: Steve mined cobblestone straight down to Y=57,
    // then needed 8 pillars to return to surface. The pre-fix handler did
    // ONE jump-place per escape call, so the 3rd call tripped the
    // escape-loop guard (recent.length >= 2) and refused. Now we delegate
    // to mc pillar_step internally — same primitive the agent could call
    // explicitly — which handles the multi-step loop, auto-stops when a
    // lateral step becomes walkable, and uses the cascade of placeable
    // blocks (preferring re-mineable dirt/sand over cobblestone/stone).
    if (cls === 'trapped') {
      if (before.ceiling_within !== null && before.ceiling_within <= 2) {
                return fail('ESCAPE_CEILING_BLOCKED', `Trapped with ceiling at +${before.ceiling_within}. Cannot pillar up — mc dig the ceiling or a wall first.`, {
          observed_state: { classification: cls, ceiling_within: before.ceiling_within, blocked_dirs: before.blocked_dirs },
          retry_safe: false,
        });
      }
      // pillar_step's cascade is broader than the inline PILLAR_BLOCKS
      // list this used to use — kept just for the empty-inventory error
      // path. (sand/gravel/planks/netherrack also pillar fine.)
      const PILLAR_BLOCKS = [
        'dirt', 'sand', 'gravel', 'netherrack',
        'cobblestone', 'stone', 'cobbled_deepslate',
        'granite', 'andesite', 'diorite',
        'oak_planks', 'spruce_planks', 'birch_planks',
      ];
      const item = b.inventory.items().find((it) => PILLAR_BLOCKS.includes(it.name));
      if (!item) {
                return fail('ESCAPE_NO_PILLAR_BLOCK', `Trapped and no pillar block (${PILLAR_BLOCKS.join(', ')}) in inventory. mc dig a wall to break out.`, {
          observed_state: { classification: cls, blocked_dirs: before.blocked_dirs },
          retry_safe: false,
        });
      }
      try {
        const pillarRes = await getActions().pillar_step({ count: 16, jump: true });
        const after = standingState(b);
        const placed = pillarRes?.data?.placed ?? 0;
        if (placed > 0) {
          return recordEscapeSuccess({
            ok: true,
            data: {
              action_taken: `pillar_up_x${placed}`,
              from: fromPos,
              to: after.position,
              classification_before: cls,
              classification_after: after.classification,
              placed_blocks: placed,
              pillar_block: item.name,
              success: after.cell.y > cell.y,
            },
            result: `Pillared up ${placed} block${placed === 1 ? '' : 's'} (Y ${cell.y} → ${after.cell.y}). Now ${after.classification} at ${after.cell.x},${after.cell.y},${after.cell.z}.`,
          });
        }
        // pillar_step couldn't place even one block — surface the underlying
        // reason so the brain knows whether to dig, get blocks, etc.
        const pillarErr = pillarRes?.error?.message
          || pillarRes?.result
          || 'pillar_step placed 0 blocks';
                return fail('ESCAPE_PILLAR_FAILED', `Pillar-up placed 0 blocks. ${pillarErr}. Try mc dig instead.`, {
          observed_state: { classification: cls, pillar_response: pillarRes?.result || null },
          retry_safe: true,
        });
      } catch (e) {
                return fail('ESCAPE_PILLAR_FAILED', `Pillar-up failed: ${e?.message || String(e)}. Try mc dig instead.`, {
          observed_state: { classification: cls },
          retry_safe: true,
        });
      }
    }



    // Fallback for unknown classification.
    return fail('ESCAPE_UNHANDLED', `No escape strategy for classification "${cls}". Try mc dig or mc move.`, {
      observed_state: before,
      retry_safe: false,
    });
  },
  };
}
