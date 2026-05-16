// @size-exempt: 10 read-only world queries from former world.js split (Phase 4)
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { RELOCATABLE_INFRASTRUCTURE, FALLING_BLOCK_NAMES, columnTopSolid, suggestedToolForBlock, isDigProtected } from '../runtime/dig-tools.js';
import { standabilityReason, findClosestStandable, standingState } from './_nav-helpers.js';
import { ok, fail } from '../shared/action-contract.js';

const { goals } = pathfinderPkg;

/**
 * createQueriesActions — extracted from former lib/actions/world.js (Phase 4 split).
 */
export function createQueriesActions(services) {
  const { state: ctx, config, ensureBot, utils, social, resolver, fairPlay, getActions } = services;
  const { fmt, posObj, sleep, log } = utils;
  const { resolveInventoryItem } = resolver;
  const { rememberSocialEvent, getMyName } = social;
  const { hasLineOfSight, eyePosition } = fairPlay;

  return {
  async scout({ x, y, z, radius }) {
    const b = ensureBot();
    const r = Math.min(Math.max(parseInt(String(radius ?? 8), 10) || 8, 1), 16);
    const me = b.entity.position;
    const cx = Number.isFinite(Number(x)) ? Math.floor(Number(x)) : Math.floor(me.x);
    const cy = Number.isFinite(Number(y)) ? Math.floor(Number(y)) : Math.floor(me.y);
    const cz = Number.isFinite(Number(z)) ? Math.floor(Number(z)) : Math.floor(me.z);
    const center = new Vec3(cx, cy, cz);

    const lavaPositions = b.findBlocks({
      matching: (block) => block.name === 'lava' || block.name === 'flowing_lava',
      maxDistance: r,
      count: 50,
      point: center,
    });
    const waterPositions = b.findBlocks({
      matching: (block) => block.name === 'water' || block.name === 'flowing_water',
      maxDistance: r,
      count: 50,
      point: center,
    });
    const fallingPositions = b.findBlocks({
      matching: (block) => FALLING_BLOCK_NAMES.has(block.name),
      maxDistance: r,
      count: 50,
      point: center,
    });
    const bedrockPositions = b.findBlocks({
      matching: (block) => block.name === 'bedrock',
      maxDistance: r,
      count: 1,
      point: center,
    });

    const fmtPos = (p) => ({ x: p.x, y: p.y, z: p.z });
    const lava = lavaPositions.map((p) => {
      const blk = b.blockAt(p);
      const props = (typeof blk?.getProperties === 'function') ? blk.getProperties() : {};
      const level = props.level !== undefined ? Number(props.level) : 0;
      return { ...fmtPos(p), source: level === 0, dist: Math.round(p.distanceTo(center) * 10) / 10 };
    });
    const water = waterPositions.map((p) => ({ ...fmtPos(p), dist: Math.round(p.distanceTo(center) * 10) / 10 }));
    const falling = fallingPositions.map((p) => {
      const blk = b.blockAt(p);
      return { ...fmtPos(p), name: blk?.name || 'unknown', dist: Math.round(p.distanceTo(center) * 10) / 10 };
    });
    let bedrock = null;
    if (bedrockPositions.length) {
      const bp = bedrockPositions[0];
      bedrock = { ...fmtPos(bp), dist: Math.round(bp.distanceTo(center) * 10) / 10 };
    }

    // Hostile mobs — common Minecraft hostile types within the radius.
    // Known limitation: in Multiverse non-default worlds, mineflayer's
    // entity tracker may report empty even when mobs are nearby. Use
    // mc scene as a fallback when scout reports 0 hostile.
    const HOSTILE = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'pillager', 'vindicator', 'evoker', 'drowned', 'husk', 'stray', 'phantom', 'cave_spider', 'silverfish', 'endermite', 'blaze', 'ghast', 'magma_cube', 'slime', 'wither_skeleton', 'piglin', 'piglin_brute', 'zoglin', 'hoglin']);
    const hostile = [];
    for (const e of Object.values(b.entities)) {
      if (!e.position || !HOSTILE.has(e.name)) continue;
      const d = e.position.distanceTo(center);
      if (d > r) continue;
      hostile.push({ name: e.name, x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z), dist: Math.round(d * 10) / 10 });
    }
    hostile.sort((a, b) => a.dist - b.dist);

    const counts = { lava: lava.length, water: water.length, falling: falling.length, hostile: hostile.length };
    const summary = [
      counts.lava ? `${counts.lava} lava` : null,
      counts.water ? `${counts.water} water` : null,
      counts.falling ? `${counts.falling} falling-block` : null,
      counts.hostile ? `${counts.hostile} hostile (${hostile[0].name} at ${hostile[0].dist})` : null,
      bedrock ? `bedrock at ${bedrock.dist}` : null,
    ].filter(Boolean).join(', ') || 'all clear';

    return {
      ok: true,
      data: {
        center: { x: cx, y: cy, z: cz },
        radius: r,
        lava,
        water,
        falling_blocks: falling,
        bedrock,
        hostile_mobs: hostile,
        counts,
      },
      result: `Scout r=${r} from ${cx},${cy},${cz}: ${summary}`,
    };
  },

  async terrain_top({ x, z, radius = 0 }) {
    const b = ensureBot();
    const cx = Math.floor(Number(x));
    const cz = Math.floor(Number(z));
    const r = Math.min(Math.max(parseInt(String(radius), 10) || 0, 0), 32);
    /** @type {{ x:number, z:number, topY:number, blockName:string }[]} */
    const columns = [];
    let maxTopY = Number.NEGATIVE_INFINITY;
    let maxBlock = '';
    let maxAt = { x: cx, z: cz };

    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const ix = cx + dx;
        const iz = cz + dz;
        const col = columnTopSolid(b, ix, iz);
        if (!col) continue;
        columns.push({ x: ix, z: iz, topY: col.topY, blockName: col.blockName });
        if (col.topY > maxTopY) {
          maxTopY = col.topY;
          maxBlock = col.blockName;
          maxAt = { x: ix, z: iz };
        }
      }
    }

    if (!columns.length) {
      return {
        result: `No solid blocks in column(s) around ${cx},${cz} (radius ${r}).`,
        topY: null,
        blockName: null,
        columns: [],
      };
    }

    const feetYHint = maxTopY + 1;
    return {
      result: `Top solid ≈Y${maxTopY} (${maxBlock}) at ${maxAt.x},${maxAt.z}${r ? ` (max over radius ${r})` : ''}`,
      topY: maxTopY,
      blockName: maxBlock,
      columnX: maxAt.x,
      columnZ: maxAt.z,
      feetYHint,
      ...(r > 0 ? { columns } : {}),
    };
  },

  /**
   * Clear a box of diggable blocks (inverse of place_fill): top Y down, stand-block deferred per layer.
   */
  async reachable({ x, y, z, range = 3 }) {
    const b = ensureBot();
    if (![x, y, z].every((v) => Number.isFinite(Number(v)))) {
      return {
        ok: false,
        error: {
          code: 'INVALID_COORD',
          message: 'mc reachable requires numeric x, y, z',
          retry_safe: false,
        },
      };
    }
    const ix = Math.floor(Number(x));
    const iy = Math.floor(Number(y));
    const iz = Math.floor(Number(z));
    const maxScan = Math.max(1, Math.min(6, Number(range) || 3));
    const target_reason = standabilityReason(b, ix, iy, iz);
    const target_standable = target_reason === 'ok';
    const best = findClosestStandable(b, ix, iy, iz, maxScan);

    let resultMsg;
    if (target_standable) {
      resultMsg = `Cell ${ix},${iy},${iz} is standable.`;
    } else if (best) {
      resultMsg = `Cell ${ix},${iy},${iz} is NOT standable (${target_reason}). Closest standable cell: ${best.x},${best.y},${best.z} (distance ${best.distance}).`;
    } else {
      resultMsg = `Cell ${ix},${iy},${iz} is NOT standable (${target_reason}), and no standable cell within range ${maxScan}.`;
    }

    return {
      ok: true,
      data: {
        target: { x: ix, y: iy, z: iz },
        target_standable,
        target_reason,
        best_stand: best ? { x: best.x, y: best.y, z: best.z, distance: best.distance } : null,
        bot_position: posObj(b.entity.position),
        scan_range: maxScan,
      },
      result: resultMsg,
    };
  },

  /**
   * F50.1: Classify the bot's current standing state. Returns the
   * classification ({open, alley, corner, trapped, three_walled,
   * enclosure_inside, wedge, edge, in_air}), the blocked/open cardinal
   * directions, and supporting detail (head_blocked, foot_support,
   * ceiling_within, wedge_offset). Building block for F50.2-50.8 — used
   * both internally (to enrich movement errors and decide escape
   * strategy) and externally (`mc standing` lets the brain self-check
   * before issuing a goto / place that's likely to fail).
   */
  async standing() {
    const b = ensureBot();
    const s = standingState(b);
    if (s.error === 'no_bot') {
      return { ok: false, error: { code: 'NO_BOT', message: 'bot not ready', retry_safe: true } };
    }
    const resultMsg = `${s.classification} at ${s.cell.x},${s.cell.y},${s.cell.z} — blocked: [${s.blocked_dirs.join(',') || '-'}] open: [${s.open_dirs.join(',') || '-'}]${s.cliff_dirs.length ? ` cliff: [${s.cliff_dirs.join(',')}]` : ''}${s.head_blocked ? ' head_blocked' : ''}${s.foot_support === false ? ' no_foot_support' : ''}${s.ceiling_within !== null ? ` ceiling_at_+${s.ceiling_within}` : ''}`;
    return { ok: true, data: s, result: resultMsg };
  },

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
      return { ok: false, error: { code: 'NO_BOT', message: 'bot not ready', retry_safe: true } };
    }
    const cls = before.classification;
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
      return {
        ok: false,
        error: {
          code: 'ESCAPE_RECURRING_LOOP',
          message: `mc escape called ${recent.length + 1}× in last ${ESCAPE_LOOP_WINDOW_MS / 1000}s — terrain or plan is re-trapping you (current: ${cls} at ${cell.x},${cell.y},${cell.z}). Don't escape-spam. Options: (a) mc dig at the wall/lip that keeps trapping you (mc inspect <neighbor> to identify it), (b) mc go_mark to a known-safe coord and approach the original target from a different side, (c) ask your partner for help.${lastFailed ? ` Stop retrying mc goto ${lastFailed.x} ${lastFailed.y} ${lastFailed.z} — pick a different destination.` : ''}`,
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
      };
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

    // Wait out airborne state.
    if (cls === 'in_air') {
      await new Promise(r => setTimeout(r, 600));
      const after = standingState(b);
      return recordEscapeSuccess({
        ok: true,
        data: { action_taken: 'wait_for_landing', from: fromPos, to: after.position, classification_before: cls, classification_after: after.classification, success: after.classification !== 'in_air' },
        result: `Waited 600ms for physics; now ${after.classification} at ${after.cell.x},${after.cell.y},${after.cell.z}.`,
      });
    }

    // Sidestep for corner/three_walled/wedge/edge.
    if (cls === 'corner' || cls === 'three_walled' || cls === 'wedge' || cls === 'edge') {
      const DIR_VEC = {
        N: { dx: 0, dz: -1 }, E: { dx: 1, dz: 0 }, S: { dx: 0, dz: 1 }, W: { dx: -1, dz: 0 },
      };
      const candidates = before.open_dirs.filter(d => DIR_VEC[d]);
      if (candidates.length === 0) {
        return {
          ok: false,
          error: {
            code: 'ESCAPE_NO_OPEN_DIR',
            message: `Classified ${cls} but no open cardinal direction to sidestep into. Try mc dig to break out, or mc inspect neighbors.`,
            observed_state: { classification: cls, blocked_dirs: before.blocked_dirs, cliff_dirs: before.cliff_dirs },
            retry_safe: false,
          },
        };
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
          await Promise.race([
            b.pathfinder.goto(goal),
            new Promise((_, rej) => setTimeout(() => rej(new Error('sidestep_to')), 1200)),
          ]);
        } catch {
          try { b.pathfinder.setGoal(null); } catch {}
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
      return {
        ok: false,
        error: {
          code: 'ESCAPE_STUCK',
          message: `Tried ${attempts.length} sidestep + burst attempt(s); still ${after.classification} at ${after.cell.x},${after.cell.y},${after.cell.z}. Dig a wall (mc dig) or pick a different angle (mc move).`,
          observed_state: {
            classification_before: cls,
            classification_after: after.classification,
            attempts,
            blocked_dirs: after.blocked_dirs,
            open_dirs: after.open_dirs,
            bot_position: after.position,
          },
          retry_safe: false,
        },
      };
    }

    // Trapped: pillar up if no ceiling, else fail (brain should mc dig).
    if (cls === 'trapped') {
      if (before.ceiling_within !== null && before.ceiling_within <= 2) {
        return {
          ok: false,
          error: {
            code: 'ESCAPE_CEILING_BLOCKED',
            message: `Trapped with ceiling at +${before.ceiling_within}. Cannot pillar up — mc dig the ceiling or a wall first.`,
            observed_state: { classification: cls, ceiling_within: before.ceiling_within, blocked_dirs: before.blocked_dirs },
            retry_safe: false,
          },
        };
      }
      // Look for a placeable pillar block in inventory (cobblestone, dirt,
      // stone, cobbled_deepslate, anything generic & cheap).
      const PILLAR_BLOCKS = ['cobblestone', 'dirt', 'stone', 'cobbled_deepslate', 'granite', 'andesite', 'diorite', 'netherrack'];
      const item = b.inventory.items().find(it => PILLAR_BLOCKS.includes(it.name));
      if (!item) {
        return {
          ok: false,
          error: {
            code: 'ESCAPE_NO_PILLAR_BLOCK',
            message: `Trapped and no pillar block (cobblestone/dirt/stone) in inventory. Get one of: ${PILLAR_BLOCKS.join(', ')}. Or mc dig a wall.`,
            observed_state: { classification: cls, blocked_dirs: before.blocked_dirs },
            retry_safe: false,
          },
        };
      }
      try {
        await b.equip(item, 'hand');
        // Look down and jump-place: stand at current cell, look at the block
        // directly below, jump, place. Mineflayer doesn't have a built-in
        // pillar, so we do it manually.
        const groundPos = new Vec3(cell.x, cell.y - 1, cell.z);
        const groundBlock = b.blockAt(groundPos);
        if (!groundBlock || groundBlock.boundingBox !== 'block') {
          return {
            ok: false,
            error: {
              code: 'ESCAPE_NO_GROUND',
              message: `No solid block below to pillar from. mc dig or jump to a solid spot first.`,
              observed_state: { classification: cls },
              retry_safe: true,
            },
          };
        }
        await b.lookAt(groundPos.offset(0.5, 0.5, 0.5));
        b.setControlState('jump', true);
        await new Promise(r => setTimeout(r, 250));
        try {
          await b.placeBlock(groundBlock, new Vec3(0, 1, 0));
        } catch (e) {
          // ignore place errors here; physics may have caught up
        }
        b.setControlState('jump', false);
        await new Promise(r => setTimeout(r, 500));
        const after = standingState(b);
        return recordEscapeSuccess({
          ok: true,
          data: {
            action_taken: `pillar_up_${item.name}`,
            from: fromPos,
            to: after.position,
            classification_before: cls,
            classification_after: after.classification,
            success: after.cell.y > cell.y,
          },
          result: `Pillared up with ${item.name}. Now ${after.classification} at ${after.cell.x},${after.cell.y},${after.cell.z}.`,
        });
      } catch (e) {
        return {
          ok: false,
          error: {
            code: 'ESCAPE_PILLAR_FAILED',
            message: `Pillar-up failed: ${e?.message || String(e)}. Try mc dig instead.`,
            observed_state: { classification: cls },
            retry_safe: true,
          },
        };
      }
    }

    // enclosure_inside: defer — brain should use mc dig to break out, or
    // navigate to the door slot if there is one.
    if (cls === 'enclosure_inside') {
      return {
        ok: false,
        error: {
          code: 'ESCAPE_ENCLOSURE',
          message: `You're inside a built structure (walls in all 4 dirs within 4 cells, ceiling within 4 cells). Use mc dig to break a wall, or mc move to a door slot if one exists. mc escape can't solve this case (yet).`,
          observed_state: { classification: cls, blocked_dirs: before.blocked_dirs, ceiling_within: before.ceiling_within },
          retry_safe: false,
        },
      };
    }

    // Fallback for unknown classification.
    return {
      ok: false,
      error: {
        code: 'ESCAPE_UNHANDLED',
        message: `No escape strategy for classification "${cls}". Try mc dig or mc move.`,
        observed_state: before,
        retry_safe: false,
      },
    };
  },

  /**
   * F53.4: mc find <resource> — unified resource finder. Aggregates sources
   * the bot already has access to, so it doesn't run off to mine a thing
   * that's already in its inventory or in a known chest.
   *
   * Sources scanned (in order of "cheapness"):
   *   1. inventory   — items in the bot's own inventory (free, count only)
   *   2. chest       — chest snapshots populated by prior list/deposit/
   *                    withdraw calls (cheap; needs prior knowledge)
   *   3. block       — visible blocks of that name within scan_range
   *                    (medium; requires walking + digging)
   *
   * Returns a flat ranked list: [{source, name, count, pos, distance, ...}].
   * Distance is from the bot's current position (0 for inventory).
   *
   * The brain calls this BEFORE deciding to mine. If `inventory` count >=
   * needed, no trip required. If `chest` has it, mc goto + mc withdraw.
   * If only `block`, mc collect.
   */
  async find({ resource, scan_range = 32, max_results = 12 }) {
    const b = ensureBot();
    const target = String(resource || '').toLowerCase();
    if (!target) {
      return {
        ok: false,
        error: {
          code: 'MISSING_RESOURCE',
          message: 'mc find requires a resource name (e.g. mc find cobblestone).',
          retry_safe: false,
        },
      };
    }
    const scanR = Math.max(4, Math.min(64, Number(scan_range) || 32));
    const maxN = Math.max(1, Math.min(50, Number(max_results) || 12));
    const botPos = b.entity.position;
    const sources = [];

    // 1. Own inventory.
    try {
      const inv = b.inventory.items();
      const matching = inv.filter(it => it.name === target);
      const total = matching.reduce((s, it) => s + it.count, 0);
      if (total > 0) {
        sources.push({
          source: 'inventory',
          name: target,
          count: total,
          pos: null,
          distance: 0,
        });
      }
    } catch { /* ignore */ }

    // 2. Chest snapshots (per chest mark).
    try {
      for (const [markName, snap] of Object.entries(ctx.goals.chestSnapshots || {})) {
        if (!snap?.items?.length) continue;
        const matching = snap.items.filter(it => it.name === target);
        const total = matching.reduce((s, it) => s + it.count, 0);
        if (total > 0) {
          const dist = snap.position
            ? Math.round(botPos.distanceTo(new Vec3(snap.position.x, snap.position.y, snap.position.z)) * 10) / 10
            : null;
          sources.push({
            source: 'chest',
            mark: markName,
            name: target,
            count: total,
            pos: snap.position || null,
            distance: dist,
            last_seen: snap.last_seen || null,
          });
        }
      }
    } catch { /* ignore */ }

    // 3. Visible blocks of that name within scan_range. Use mc-data to
    //    resolve the block ID; if `target` is an item name (like cobblestone)
    //    it usually matches a block name too. For items only obtainable
    //    by smelting/crafting (e.g. iron_ingot), block search finds nothing
    //    and the brain learns to smelt/craft instead.
    try {
      const blockId = ctx.world.mcData?.blocksByName?.[target]?.id;
      if (blockId != null) {
        const positions = b.findBlocks({
          matching: blockId,
          maxDistance: scanR,
          count: maxN,
        });
        // Group nearby blocks into a single source (clusters near same xz).
        // For now, list each one — brain can decide which cluster.
        for (const p of positions) {
          const dist = Math.round(botPos.distanceTo(p) * 10) / 10;
          sources.push({
            source: 'block',
            name: target,
            count: 1,
            pos: { x: p.x, y: p.y, z: p.z },
            distance: dist,
          });
        }
      }
    } catch { /* ignore */ }

    // Rank: inventory (distance 0) first, then chests by distance, then
    // blocks by distance. We already added them in that order — just sort
    // by distance within source class.
    const order = { inventory: 0, chest: 1, block: 2 };
    sources.sort((a, c) => {
      const oa = order[a.source] ?? 9;
      const oc = order[c.source] ?? 9;
      if (oa !== oc) return oa - oc;
      return (a.distance ?? Infinity) - (c.distance ?? Infinity);
    });
    const top = sources.slice(0, maxN);

    const totalAvailable = sources.reduce((s, e) => s + (e.count || 0), 0);
    let resultMsg;
    if (top.length === 0) {
      resultMsg = `No ${target} found in inventory, ${Object.keys(ctx.goals.chestSnapshots || {}).length} chest snapshots, or visible within ${scanR}m. Try mining/crafting/smelting.`;
    } else {
      const parts = [];
      const invSrc = top.find(e => e.source === 'inventory');
      if (invSrc) parts.push(`inventory:${invSrc.count}`);
      const chests = top.filter(e => e.source === 'chest');
      if (chests.length > 0) parts.push(`chests:${chests.map(c => `${c.count}@${c.mark}(${c.distance}m)`).join(',')}`);
      const blocks = top.filter(e => e.source === 'block');
      if (blocks.length > 0) {
        const nearest = blocks[0];
        parts.push(`blocks:${blocks.length} (nearest @ ${nearest.pos.x},${nearest.pos.y},${nearest.pos.z} ${nearest.distance}m)`);
      }
      resultMsg = `Found ${target} — total available ${totalAvailable}. ${parts.join('; ')}.`;
    }

    return {
      ok: true,
      data: {
        resource: target,
        total_available: totalAvailable,
        sources: top,
        scan_range: scanR,
      },
      result: resultMsg,
    };
  },

  /**
   * F45.6: Inspect a single cell — what's the block, can it be dug, is it
   * relocatable, what tool should be used, and which entities (players /
   * mobs) overlap that cell. Use proactively to avoid place-fail-then-recover.
   */
  async inspect({ x, y, z }) {
    const b = ensureBot();
    if (![x, y, z].every((v) => Number.isFinite(Number(v)))) {
      return {
        ok: false,
        error: {
          code: 'INVALID_COORD',
          message: 'mc inspect requires numeric x, y, z',
          retry_safe: false,
        },
      };
    }
    const ix = Math.floor(Number(x));
    const iy = Math.floor(Number(y));
    const iz = Math.floor(Number(z));
    const cellPos = new Vec3(ix, iy, iz);
    const blk = b.blockAt(cellPos);
    const blockName = blk?.name || 'unknown';
    const hardness = (typeof blk?.hardness === 'number') ? blk.hardness : null;
    const boundingBox = blk?.boundingBox || null;
    const isAir = blockName === 'air' || blockName === 'cave_air' || blockName === 'void_air';
    const isDiggable = !isAir && !isDigProtected(blockName);
    const isRelocatable = RELOCATABLE_INFRASTRUCTURE.has(blockName);
    const suggestedTool = isAir ? null : suggestedToolForBlock(blockName);

    // Entities occupying this cell (foot or head). 1.8-block tall entities
    // occupy floor(ey) and floor(ey)+1.
    const entitiesAt = [];
    for (const e of Object.values(b.entities || {})) {
      if (!e || !e.position) continue;
      const ex = Math.floor(e.position.x);
      const ez = Math.floor(e.position.z);
      const ey = Math.floor(e.position.y);
      if (ex !== ix || ez !== iz) continue;
      if (ey !== iy && ey + 1 !== iy) continue;
      entitiesAt.push({
        type: e.type || null,
        name: e.name || null,
        username: e.username || null,
        position: { x: e.position.x, y: e.position.y, z: e.position.z },
      });
    }

    const occupied = (!isAir) || entitiesAt.length > 0;
    return {
      ok: true,
      data: {
        coord: { x: ix, y: iy, z: iz },
        block: {
          name: blockName,
          is_air: isAir,
          is_diggable: isDiggable,
          is_relocatable: isRelocatable,
          is_protected: !isAir && !isDiggable,
          suggested_tool: suggestedTool,
          hardness,
          bounding_box: boundingBox,
        },
        entities_at: entitiesAt,
        occupied,
      },
      result: `Block at ${ix},${iy},${iz}: ${blockName}${entitiesAt.length ? ` (${entitiesAt.length} entity${entitiesAt.length > 1 ? 'ies' : ''} here)` : ''}`,
    };
  },

  /**
   * F45.7: Region predicate — is every cell in [x1..x2, y1..y2, z1..z2] air-like?
   * Returns up to 32 non-empty cells with their block names. Capped at 1000 cells.
   */
  async is_empty({ x1, y1, z1, x2, y2, z2 }) {
    const b = ensureBot();
    const coords = [x1, y1, z1, x2, y2, z2].map((v) => Number(v));
    if (!coords.every((v) => Number.isFinite(v))) {
      return {
        ok: false,
        error: { code: 'INVALID_COORD', message: 'mc is_empty requires numeric x1,y1,z1,x2,y2,z2', retry_safe: false },
      };
    }
    const [X1, Y1, Z1, X2, Y2, Z2] = [
      Math.min(Math.floor(coords[0]), Math.floor(coords[3])),
      Math.min(Math.floor(coords[1]), Math.floor(coords[4])),
      Math.min(Math.floor(coords[2]), Math.floor(coords[5])),
      Math.max(Math.floor(coords[0]), Math.floor(coords[3])),
      Math.max(Math.floor(coords[1]), Math.floor(coords[4])),
      Math.max(Math.floor(coords[2]), Math.floor(coords[5])),
    ];
    const cells = (X2 - X1 + 1) * (Y2 - Y1 + 1) * (Z2 - Z1 + 1);
    if (cells > 1000) {
      return {
        ok: false,
        error: {
          code: 'REGION_TOO_LARGE',
          message: `Region has ${cells} cells (max 1000). Shrink the bounds.`,
          observed_state: { total_cells: cells, max_cells: 1000 },
          retry_safe: false,
        },
      };
    }
    const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
    const nonEmpty = [];
    for (let yy = Y1; yy <= Y2; yy++) {
      for (let zz = Z1; zz <= Z2; zz++) {
        for (let xx = X1; xx <= X2; xx++) {
          const blk = b.blockAt(new Vec3(xx, yy, zz));
          const nm = blk?.name || 'unknown';
          if (!AIR_NAMES.has(nm)) {
            nonEmpty.push({ coord: { x: xx, y: yy, z: zz }, name: nm });
            if (nonEmpty.length >= 32) break;
          }
        }
        if (nonEmpty.length >= 32) break;
      }
      if (nonEmpty.length >= 32) break;
    }
    const empty = nonEmpty.length === 0;
    return {
      ok: true,
      data: {
        empty,
        non_empty_blocks: nonEmpty,
        total_cells: cells,
        sampled: nonEmpty.length >= 32,
        bounds: { x1: X1, y1: Y1, z1: Z1, x2: X2, y2: Y2, z2: Z2 },
      },
      result: empty ? `Region ${X1},${Y1},${Z1} → ${X2},${Y2},${Z2} (${cells} cells) is EMPTY` : `Region NOT empty: ${nonEmpty.length}${nonEmpty.length >= 32 ? '+' : ''} non-air cells (first: ${nonEmpty[0].name} at ${nonEmpty[0].coord.x},${nonEmpty[0].coord.y},${nonEmpty[0].coord.z})`,
    };
  },

  /**
   * F45.7: Region predicate — is every cell in [x1..x2, y1..y2, z1..z2]
   * filled with `material`? Returns up to 32 mismatching cells. Capped at 1000.
   */
  async is_filled({ x1, y1, z1, x2, y2, z2, material }) {
    const b = ensureBot();
    if (!material || typeof material !== 'string') {
      return {
        ok: false,
        error: { code: 'MISSING_MATERIAL', message: 'mc is_filled requires a material name (e.g. "cobblestone")', retry_safe: false },
      };
    }
    const coords = [x1, y1, z1, x2, y2, z2].map((v) => Number(v));
    if (!coords.every((v) => Number.isFinite(v))) {
      return {
        ok: false,
        error: { code: 'INVALID_COORD', message: 'mc is_filled requires numeric x1,y1,z1,x2,y2,z2', retry_safe: false },
      };
    }
    const [X1, Y1, Z1, X2, Y2, Z2] = [
      Math.min(Math.floor(coords[0]), Math.floor(coords[3])),
      Math.min(Math.floor(coords[1]), Math.floor(coords[4])),
      Math.min(Math.floor(coords[2]), Math.floor(coords[5])),
      Math.max(Math.floor(coords[0]), Math.floor(coords[3])),
      Math.max(Math.floor(coords[1]), Math.floor(coords[4])),
      Math.max(Math.floor(coords[2]), Math.floor(coords[5])),
    ];
    const cells = (X2 - X1 + 1) * (Y2 - Y1 + 1) * (Z2 - Z1 + 1);
    if (cells > 1000) {
      return {
        ok: false,
        error: {
          code: 'REGION_TOO_LARGE',
          message: `Region has ${cells} cells (max 1000). Shrink the bounds.`,
          observed_state: { total_cells: cells, max_cells: 1000 },
          retry_safe: false,
        },
      };
    }
    const missing = [];
    for (let yy = Y1; yy <= Y2; yy++) {
      for (let zz = Z1; zz <= Z2; zz++) {
        for (let xx = X1; xx <= X2; xx++) {
          const blk = b.blockAt(new Vec3(xx, yy, zz));
          const nm = blk?.name || 'unknown';
          if (nm !== material) {
            missing.push({ coord: { x: xx, y: yy, z: zz }, actual_name: nm });
            if (missing.length >= 32) break;
          }
        }
        if (missing.length >= 32) break;
      }
      if (missing.length >= 32) break;
    }
    const filled = missing.length === 0;
    return {
      ok: true,
      data: {
        filled,
        material,
        missing,
        total_cells: cells,
        sampled: missing.length >= 32,
        bounds: { x1: X1, y1: Y1, z1: Z1, x2: X2, y2: Y2, z2: Z2 },
      },
      result: filled ? `Region ${X1},${Y1},${Z1} → ${X2},${Y2},${Z2} (${cells} cells) is FILLED with ${material}` : `Region NOT fully ${material}: ${missing.length}${missing.length >= 32 ? '+' : ''} mismatching cells (first: ${missing[0].actual_name} at ${missing[0].coord.x},${missing[0].coord.y},${missing[0].coord.z})`,
    };
  },

  async is_sheltered({ radius = 20, walls } = {}) {
    const b = ensureBot();
    const start = b.entity.position;
    const movements = b.pathfinder.movements;
    if (!movements) {
      return {
        ok: false,
        error: {
          code: 'NO_MOVEMENTS',
          message: 'Pathfinder movements not configured. Cannot test enclosure.',
          retry_safe: false,
        },
      };
    }

    // F55.7: optional perimeter wall verification. When called with
    // walls={x1,y1,z1,x2,y2,z2}, sweep the box's perimeter at every Y in
    // [y1..y2] BEFORE the pathfinder check. If any cell is air, refuse
    // upfront with WALLS_INCOMPLETE listing the gap cells. This catches
    // the v6 case where Mason ran is_sheltered claiming the platform was
    // done, but blocks were missing — pathfinder alone said "sealed"
    // because adjacent walls existed but the verification didn't check
    // for COMPLETE coverage.
    if (walls && typeof walls === 'object') {
      const w = walls;
      const coords = ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'].map((k) => Number(w[k]));
      if (!coords.every(Number.isFinite)) {
        return {
          ok: false,
          error: {
            code: 'INVALID_WALLS',
            message: 'walls must be {x1,y1,z1,x2,y2,z2} all numeric',
            observed_state: { received: walls },
            retry_safe: false,
          },
        };
      }
      const [X1, Y1, Z1, X2, Y2, Z2] = [
        Math.min(Math.floor(coords[0]), Math.floor(coords[3])),
        Math.min(Math.floor(coords[1]), Math.floor(coords[4])),
        Math.min(Math.floor(coords[2]), Math.floor(coords[5])),
        Math.max(Math.floor(coords[0]), Math.floor(coords[3])),
        Math.max(Math.floor(coords[1]), Math.floor(coords[4])),
        Math.max(Math.floor(coords[2]), Math.floor(coords[5])),
      ];
      const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
      const missing = [];
      let totalPerimeter = 0;
      for (let yy = Y1; yy <= Y2; yy++) {
        for (let xx = X1; xx <= X2; xx++) {
          for (let zz = Z1; zz <= Z2; zz++) {
            // Perimeter only: cells on the box edge (x == X1 || x == X2 || z == Z1 || z == Z2).
            // Interior cells (between the walls) are not checked — those
            // should be air for a house.
            const onPerimeter = xx === X1 || xx === X2 || zz === Z1 || zz === Z2;
            if (!onPerimeter) continue;
            totalPerimeter++;
            const blk = b.blockAt(new Vec3(xx, yy, zz));
            const nm = blk?.name || 'unknown';
            if (AIR_NAMES.has(nm)) {
              if (missing.length < 16) missing.push({ x: xx, y: yy, z: zz });
            }
          }
        }
      }
      if (missing.length > 0) {
        return {
          ok: false,
          error: {
            code: 'WALLS_INCOMPLETE',
            message: `${missing.length} perimeter cell${missing.length > 1 ? 's' : ''} missing in walls region (${totalPerimeter} total). Fill the gaps before checking enclosure.`,
            observed_state: {
              walls_region: { x1: X1, y1: Y1, z1: Z1, x2: X2, y2: Y2, z2: Z2 },
              total_perimeter_cells: totalPerimeter,
              missing_cells: missing,
              total_missing: missing.length,
            },
            next_action_hint: `mc fill cobblestone ${missing[0].x} ${missing[0].y} ${missing[0].z} ${missing[0].x} ${missing[0].y} ${missing[0].z}`,
            retry_safe: false,
          },
        };
      }
    }

    // Try cardinal targets at `radius` blocks horizontally + one straight up.
    // Each direction gets a short timeout — total wall-clock is bounded.
    const r = Math.max(8, Math.min(48, Number(radius) || 20));
    const sx = Math.floor(start.x);
    const sy = Math.floor(start.y);
    const sz = Math.floor(start.z);
    const targets = [
      { name: 'east',  x: sx + r, y: sy, z: sz },
      { name: 'west',  x: sx - r, y: sy, z: sz },
      { name: 'south', x: sx,     y: sy, z: sz + r },
      { name: 'north', x: sx,     y: sy, z: sz - r },
      { name: 'up',    x: sx,     y: Math.min(sy + r, 250), z: sz },
    ];

    const checks = [];
    let firstLeak = null;
    for (const t of targets) {
      const goal = new goals.GoalNear(t.x, t.y, t.z, 1);
      let status = 'noPath';
      let firstStep = null;
      try {
        // 4000ms per direction: long enough that "noPath" actually means
        // no path, not "didn't finish searching in 1.5s". False-positive
        // SHELTERED reports were the worst case (agent trusts the seal,
        // waits, dies). 5 directions × 4s worst-case ≈ 20s total, still
        // tolerable as a one-shot verification call.
        const result = b.pathfinder.getPathTo(movements, goal, 4000);
        status = result.status;
        if (status === 'success' && result.path && result.path.length > 0) {
          // First step that's NOT the start cell — the "exit" through which
          // the bot would walk out (and mobs walk in).
          for (const node of result.path) {
            if (Math.floor(node.x) !== sx || Math.floor(node.y) !== sy || Math.floor(node.z) !== sz) {
              firstStep = { x: Math.floor(node.x), y: Math.floor(node.y), z: Math.floor(node.z) };
              break;
            }
          }
        }
      } catch (e) {
        status = `error:${(e && e.message) || e}`;
      }
      const leaked = status === 'success';
      checks.push({ direction: t.name, target: { x: t.x, y: t.y, z: t.z }, status, exit: firstStep });
      if (leaked && !firstLeak) firstLeak = { direction: t.name, exit: firstStep };
    }

    const pathfinderEnclosed = firstLeak === null;

    // Also report the immediate 6 wall cells (cardinal neighbours of bot's
    // foot and head). Pathfinder can be fooled by complex geometry but a
    // human can read this list directly. If any cell is air/water/etc
    // when pathfinder thinks the shelter's sealed, the seal is FALSE —
    // mobs in vanilla MC can attack-reach the player through any 1-block
    // hole adjacent to where the player stands, even if they can't walk
    // through it. v30 lost a bot to exactly this geometry: pathfinder
    // said enclosed because a crafting-table-blocked-foot + air-head
    // gap had no walkable path, but a zombie outside reached through
    // the head-level air gap and killed the bot.
    const botFootX = Math.floor(start.x), botFootY = Math.floor(start.y), botFootZ = Math.floor(start.z);
    const wallReport = {};
    for (const lvl of ['foot', 'head']) {
      const wy = botFootY + (lvl === 'head' ? 1 : 0);
      for (const [dx, dz, name] of [[1,0,'east'],[-1,0,'west'],[0,1,'south'],[0,-1,'north']]) {
        const blk = b.blockAt(start.offset(dx, lvl === 'head' ? 1 : 0, dz).floored());
        wallReport[`${lvl}_${name}`] = {
          pos: { x: botFootX + dx, y: wy, z: botFootZ + dz },
          block: blk?.name ?? 'unknown',
          solid: blk ? (blk.boundingBox === 'block') : false,
        };
      }
    }
    // Plus the roof (1 block above head).
    const roof = b.blockAt(start.offset(0, 2, 0).floored());
    wallReport.roof = {
      pos: { x: botFootX, y: botFootY + 2, z: botFootZ },
      block: roof?.name ?? 'unknown',
      solid: roof ? (roof.boundingBox === 'block') : false,
    };

    const openWalls = Object.entries(wallReport)
      .filter(([_, v]) => !v.solid)
      .map(([k, v]) => `${k}=${v.block}@(${v.pos.x},${v.pos.y},${v.pos.z})`);

    // Final verdict combines BOTH checks. Pathfinder says no walk-path,
    // AND every immediate-neighbour cell is solid → truly safe. Either
    // failing → not enclosed.
    const enclosed = pathfinderEnclosed && openWalls.length === 0;

    let resultMsg;
    if (enclosed) {
      resultMsg = `SHELTERED — pathfinder found no exit within ${r} blocks AND all 9 immediate-neighbour cells (4 foot, 4 head, roof) are solid blocks. Safe to wait out the night.`;
    } else if (pathfinderEnclosed && openWalls.length > 0) {
      resultMsg = `OPEN — pathfinder found no walk-path out, BUT ${openWalls.length} immediate cell(s) are not solid: ${openWalls.join(', ')}. Mobs can attack-reach you through these 1-block gaps even though they can't walk in. Seal every immediate-neighbour cell (foot, head, roof) before nightfall.`;
    } else {
      resultMsg = `OPEN — escape route via ${firstLeak.direction} starts at (${firstLeak.exit.x},${firstLeak.exit.y},${firstLeak.exit.z}). Mobs can use that path to reach you. Seal it before nightfall.${openWalls.length > 0 ? ' Immediate gaps: ' + openWalls.join(', ') : ''}`;
    }

    return {
      ok: true,
      data: {
        enclosed,
        // Sub-signals so callers can distinguish "walk-path leak" from
        // "attack-reach leak". Useful for nuanced agent reasoning.
        pathfinder_enclosed: pathfinderEnclosed,
        all_walls_solid: openWalls.length === 0,
        bot_position: { x: Math.round(start.x * 10) / 10, y: Math.round(start.y * 10) / 10, z: Math.round(start.z * 10) / 10 },
        radius: r,
        leak: firstLeak,
        checks,
        immediate_walls: wallReport,
        open_walls: openWalls,
      },
      result: resultMsg,
    };
  },
  };
}
