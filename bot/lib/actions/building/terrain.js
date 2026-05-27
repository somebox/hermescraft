import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { equipForDig, isDigProtected, recordRecentPlace, columnTopSolid } from '../../runtime/dig-tools.js';
import { shouldSkipDigAt, shouldSkipPlaceAt } from '../../runtime/regions/policy-guard.js';
import { cardinalDelta } from '../_directions.js';
import { pathfindGotoNear, ACTION_CAPS_MS } from '../_helpers.js';

const { goals } = pathfinderPkg;

/**
 * @param {{
 *   ctx: any,
 *   ensureBot: () => any,
 *   sleep: (ms: number) => Promise<void>,
 *   getActions: () => any,
 * }} deps
 */
export function createBuildingTerrainPart(deps) {
  const { ctx, ensureBot, sleep, getActions, config } = deps;

  return {
    async path({ x1, z1, x2, z2, y }) {
      const b = ensureBot();
      for (const [k, v] of Object.entries({ x1, z1, x2, z2 })) {
        if (!Number.isFinite(Number(v))) {
          return { ok: false, error: { code: 'INVALID_COORD', message: `mc path requires numeric ${k}`, retry_safe: false } };
        }
      }
      const minX = Math.min(Number(x1), Number(x2));
      const maxX = Math.max(Number(x1), Number(x2));
      const minZ = Math.min(Number(z1), Number(z2));
      const maxZ = Math.max(Number(z1), Number(z2));
      const pathY = Number.isFinite(Number(y)) ? Number(y) : Math.floor(b.entity.position.y) - 1;

      const shovel = b.inventory.items().find((i) => /shovel/.test(i.name));
      if (!shovel) {
        return { ok: false, error: { code: 'MISSING_SHOVEL', message: 'mc path requires a shovel in inventory', retry_safe: false } };
      }
      try { await b.equip(shovel, 'hand'); } catch (e) {
        return { ok: false, error: { code: 'MISSING_SHOVEL', message: `Could not equip shovel: ${e?.message || e}`, retry_safe: true } };
      }

      const PATHABLE = new Set(['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'mycelium', 'rooted_dirt']);
      let placed = 0, skipped = 0, failed = 0, missing = 0;
      const errors = [];

      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          const block = b.blockAt(new Vec3(x, pathY, z));
          if (!block) { missing++; continue; }
          if (block.name === 'dirt_path') { skipped++; continue; }
          if (!PATHABLE.has(block.name)) { skipped++; continue; }
          // Block above must be air-like for the conversion to be visible (and the bot must reach the top face).
          const above = b.blockAt(new Vec3(x, pathY + 1, z));
          if (above && above.name !== 'air' && above.name !== 'cave_air') { skipped++; continue; }

          // Bot must NOT stand on the target block — Paper rejects activation
          // when the player's bounding box covers the top face. Move to an
          // adjacent column at the same Y if so.
          const myFootX = Math.floor(b.entity.position.x);
          const myFootZ = Math.floor(b.entity.position.z);
          const myFootY = Math.floor(b.entity.position.y) - 1;
          const standingOnTarget = myFootX === x && myFootZ === z && myFootY === pathY;
          if (standingOnTarget || b.entity.position.distanceTo(block.position) > 4.5) {
            // Find an adjacent column with a solid floor at pathY and air above.
            const candidates = [
              { dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 },
            ];
            let target = null;
            for (const c of candidates) {
              const nx = x + c.dx, nz = z + c.dz;
              const floor = b.blockAt(new Vec3(nx, pathY, nz));
              const air = b.blockAt(new Vec3(nx, pathY + 1, nz));
              if (floor && floor.name !== 'air' && air && (air.name === 'air' || air.name === 'cave_air')) {
                target = { x: nx, y: pathY + 1, z: nz }; break;
              }
            }
            if (target) {
              try { await pathfindGotoNear(b, goals, target.x, target.y, target.z, 0, { opName: 'build_path', capMs: ACTION_CAPS_MS.reach }); } catch {}
            } else {
              try { await pathfindGotoNear(b, goals, x, pathY + 1, z, 2, { opName: 'build_path', capMs: ACTION_CAPS_MS.reach }); } catch {}
            }
          }
          try {
            await b.activateBlock(block);
            // Block updates arrive asynchronously; poll for up to 1s.
            let after = null;
            for (let attempt = 0; attempt < 10; attempt++) {
              await sleep(100);
              after = b.blockAt(new Vec3(x, pathY, z));
              if (after && after.name === 'dirt_path') break;
            }
            if (after && after.name === 'dirt_path') placed++;
            else { failed++; errors.push(`${x},${pathY},${z}: still ${after?.name || 'unknown'}`); }
          } catch (e) {
            failed++;
            errors.push(`${x},${pathY},${z}: ${e?.message || e}`);
          }
        }
      }

      if (placed === 0 && failed === 0 && skipped > 0) {
        return {
          ok: true,
          data: { paths_placed: 0, paths_skipped: skipped, paths_failed: 0, bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ, y: pathY } },
          result: `Path: nothing to convert (${skipped} columns already path or non-dirt)`,
        };
      }

      return {
        ok: true,
        data: {
          paths_placed: placed,
          paths_skipped: skipped,
          paths_failed: failed,
          missing_blocks: missing,
          errors: errors.slice(0, 5),
          bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ, y: pathY },
        },
        result: `Path: ${placed} placed, ${skipped} skipped, ${failed} failed at Y=${pathY}`,
      };
    },

    /**
     * Dig a W×L×D pit. The pit top is at the bot's existing surface (bot Y - 1)
     * unless `top_y` is given. Capped at 256 columns × 16 depth = 4096 blocks.
     * Thin wrapper over dig_area; stair-out is a separate verb (mc build_stairs).
     */
    async dig_pit({ x, z, w, l, d, top_y }) {
      const b = ensureBot();
      for (const [k, v] of Object.entries({ x, z, w, l, d })) {
        if (!Number.isFinite(Number(v))) {
          return { ok: false, error: { code: 'INVALID_COORD', message: `mc dig_pit requires numeric ${k}`, retry_safe: false } };
        }
      }
      const cornerX = Math.floor(Number(x));
      const cornerZ = Math.floor(Number(z));
      const W = parseInt(String(w), 10);
      const L = parseInt(String(l), 10);
      const D = parseInt(String(d), 10);
      for (const [k, v] of [['w', W], ['l', L], ['d', D]]) {
        if (!Number.isFinite(v) || v < 1) {
          return { ok: false, error: { code: 'INVALID_COORD', message: `mc dig_pit requires positive integer ${k}`, retry_safe: false } };
        }
      }
      const totalBlocks = W * L * D;
      // Cap lowered to 32 cells per re44 directive (2026-05-27).
      if (totalBlocks > 32) {
        return {
          ok: false,
          error: {
            code: 'OUT_OF_RANGE',
            message: `mc dig_pit: ${W}×${L}×${D} = ${totalBlocks} blocks is too many — the per-call limit is 32. Make ${Math.ceil(totalBlocks / 32)} smaller pits (e.g. halve the width or length).`,
            retry_safe: false,
          },
        };
      }

      const surfaceY = Number.isFinite(Number(top_y)) ? Math.floor(Number(top_y)) : Math.floor(b.entity.position.y) - 1;
      const x1 = cornerX, x2 = cornerX + W - 1;
      const z1 = cornerZ, z2 = cornerZ + L - 1;
      const y1 = surfaceY - D + 1, y2 = surfaceY;

      const res = await getActions().dig_area({ x1, y1, z1, x2, y2, z2, pickup: true, abort_on_fail: false, clear_stand: true });
      // dig_area uses an older response shape (top-level result/dug/etc.) and may
      // return { ok: false, error: "string" }. Map both into the action contract.
      if (res && res.ok === false) {
        return {
          ok: false,
          error: {
            code: 'DIG_AREA_FAILED',
            message: typeof res.error === 'string' ? res.error : (res.error?.message || 'dig_area failed'),
            observed_state: { bounds: { x1, y1, z1, x2, y2, z2 } },
            retry_safe: false,
          },
        };
      }
      return {
        ok: true,
        data: {
          dug: Number(res?.dug || 0),
          skipped: Number(res?.skipped || 0),
          errors_count: Array.isArray(res?.errors) ? res.errors.length : 0,
          bounds: { x1, y1, z1, x2, y2, z2 },
          size: { w: W, l: L, d: D },
          floor_y: y1 - 1,
        },
        result: `dig_pit ${W}×${L}×${D} at (${cornerX}, surface=${surfaceY}, ${cornerZ}): dug ${res?.dug || 0}, skipped ${res?.skipped || 0}. Floor Y=${y1 - 1}.`,
      };
    },

    /**
     * Flatten a rectangle to target Y: dig solid blocks above Y, place a
     * fill block at Y if the column is air at that level. Touches up to
     * `up` blocks above Y (default 8). Below Y is not touched.
     */
    async level({ x1, z1, x2, z2, y, block: fillBlockName, up }) {
      const b = ensureBot();
      for (const [k, v] of Object.entries({ x1, z1, x2, z2, y })) {
        if (!Number.isFinite(Number(v))) {
          return { ok: false, error: { code: 'INVALID_COORD', message: `mc level requires numeric ${k}`, retry_safe: false } };
        }
      }
      const minX = Math.min(Number(x1), Number(x2));
      const maxX = Math.max(Number(x1), Number(x2));
      const minZ = Math.min(Number(z1), Number(z2));
      const maxZ = Math.max(Number(z1), Number(z2));
      const targetY = Math.floor(Number(y));
      const upRange = Math.min(Math.max(parseInt(String(up || 8), 10) || 8, 1), 16);
      const w = maxX - minX + 1;
      const l = maxZ - minZ + 1;
      // Cap lowered 256 → 16 columns on 2026-05-27. Each column may do a
      // dig + a fill (≈2 ops), so 16 columns ≈ the dig family's 32-op
      // ceiling. Mason's 64-cell `mc level` call timed out at 20s.
      if (w * l > 16) {
        return { ok: false, error: {
          code: 'OUT_OF_RANGE',
          message: `mc level: ${w}×${l} = ${w * l} columns is too many — the per-call limit is 16 columns. Run ${Math.ceil(w * l / 16)} smaller calls instead, each with ≤16 columns (e.g. ${Math.min(w, 4)}×${Math.min(l, 4)}).`,
          observed_state: { requested_cols: w * l, max_cols: 16 },
          next_action_hint: `Split into ${Math.ceil(w * l / 16)} smaller rectangles (≤16 columns each).`,
          retry_safe: false,
        } };
      }

      const isAirLike = (blk) => blk && (blk.name === 'air' || blk.name === 'cave_air' || blk.name === 'void_air');
      const fillCascade = fillBlockName ? [fillBlockName] : ['dirt', 'cobblestone', 'stone', 'cobbled_deepslate', 'deepslate'];
      const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

      let dug = 0, placed = 0, skipped = 0, failed = 0;
      const errors = [];

      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          // 1) Dig blocks above targetY (top-down so debris doesn't fall on us).
          for (let dy = upRange; dy >= 1; dy--) {
            const py = targetY + dy;
            const blk = b.blockAt(new Vec3(x, py, z));
            if (!blk || isAirLike(blk)) continue;
            if (shouldSkipDigAt(ctx, config, blk.name, x, py, z, isDigProtected).skip) { skipped++; continue; }
            if (b.entity.position.distanceTo(blk.position) > 4.5) {
              try { await pathfindGotoNear(b, goals, x, py, z, 3, { opName: 'build_wall', capMs: ACTION_CAPS_MS.reach }); } catch {}
            }
            try {
              await equipForDig(b, blk);
              await b.dig(blk);
              dug++;
            } catch (e) {
              failed++;
              errors.push(`dig ${x},${py},${z}: ${e?.message || e}`);
            }
          }

          // 2) Fill air at targetY with a leveling block.
          const target = b.blockAt(new Vec3(x, targetY, z));
          if (target && !isAirLike(target)) { skipped++; continue; }

          let didPlace = false;
          for (const blockName of fillCascade) {
            const item = b.inventory.items().find((it) => it.name === blockName);
            if (!item) continue;
            try { await b.equip(item, 'hand'); } catch { continue; }
            if (b.entity.position.distanceTo(new Vec3(x, targetY, z)) > 4.5) {
              try { await pathfindGotoNear(b, goals, x, targetY + 1, z, 3, { opName: 'build_wall', capMs: ACTION_CAPS_MS.reach }); } catch {}
            }
            for (const [ox, oy, oz] of offsets) {
              const ref = b.blockAt(new Vec3(x + ox, targetY + oy, z + oz));
              if (ref && !isAirLike(ref) && ref.boundingBox === 'block') {
                if (shouldSkipPlaceAt(ctx, config, blockName, x, targetY, z).skip) {
                  failed++;
                  break;
                }
                try {
                  await b.placeBlock(ref, new Vec3(-ox, -oy, -oz));
                  recordRecentPlace(ctx, { x, y: targetY, z }, blockName);
                  didPlace = true;
                  placed++;
                  break;
                } catch { /* try next face */ }
              }
            }
            if (didPlace) break;
          }
          if (!didPlace) {
            // No fillable item in inventory — only count as failed if there was an air gap to fill.
            const present = fillCascade.some((nm) => b.inventory.items().find((it) => it.name === nm));
            if (!present) {
              return {
                ok: false,
                error: {
                  code: 'MISSING_INVENTORY',
                  message: `mc level: no fill block in inventory (tried ${fillCascade.join(', ')})`,
                  observed_state: { dug, placed, columns_remaining: (maxX - x + 1) * l + (maxZ - z), bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ, y: targetY } },
                  retry_safe: true,
                },
              };
            }
            failed++;
            errors.push(`fill ${x},${targetY},${z}: no solid neighbor`);
          }
        }
      }

      return {
        ok: true,
        data: {
          dug,
          placed,
          skipped,
          failed,
          bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ, y: targetY },
          up_range: upRange,
          errors: errors.slice(0, 5),
        },
        result: `level ${w}×${l} to Y=${targetY}: dug ${dug}, placed ${placed}${skipped ? `, ${skipped} skipped` : ''}${failed ? `, ${failed} failed` : ''}`,
      };
    },

    /**
     * Survey + flatten an area of "lumpy" terrain to a single target Y.
     *
     * Recipe (the operator-described "level ground" pattern, 2026-05-27):
     *   1. Survey the rectangle's column tops (terrain_top per cell).
     *   2. Pick a target Y — by default the median of the observed tops,
     *      so half the columns are dug down + half filled up (minimum total
     *      work). `--mode min` picks the lowest top (dig-only, no fill
     *      required), `--mode max` picks the highest (fill-only, no dig).
     *      Explicit `--target Y` overrides.
     *   3. Categorize each column: hole (top < target), level (top == target),
     *      pillar (top > target). Compute up_range = (max pillar height) + 1
     *      so the underlying `mc level` dig phase clears every pillar.
     *   4. Return a structured plan. With `--execute`, delegate to `mc level`
     *      to perform the work (which top-down digs above target then
     *      back-fills air at target — order designed to avoid the bot
     *      falling into a hole it just dug).
     *
     * Args:
     *   x1, z1, x2, z2   — rectangle bounds (inclusive)
     *   target           — explicit target Y (optional; auto-picks if absent)
     *   mode             — 'median' (default) | 'min' | 'max', only used
     *                      when target is auto
     *   block            — fill block name (defaults to dirt/cobble cascade)
     *   execute          — false (default): dry-run, returns plan only.
     *                      true: invokes the work via mc level.
     *
     * Returns:
     *   { ok: true, data: {
     *       target_y, mode, bounds, columns_n,
     *       summary: { holes_n, pillars_n, level_n, max_dig, max_fill, max_pillar_height },
     *       up_range_recommended,
     *       columns: [{ x, z, top_y, action: 'fill'|'dig'|'level', delta }],
     *       executed?: true | undefined,
     *       execute_result?: { dug, placed, skipped, failed }  // present iff execute=true
     *     } }
     */
    async level_ground({ x1, z1, x2, z2, target, mode, block: fillBlockName, execute }) {
      const b = ensureBot();
      for (const [k, v] of Object.entries({ x1, z1, x2, z2 })) {
        if (!Number.isFinite(Number(v))) {
          return { ok: false, error: { code: 'INVALID_COORD', message: `mc level_ground requires numeric ${k}`, retry_safe: false } };
        }
      }
      const minX = Math.min(Number(x1), Number(x2));
      const maxX = Math.max(Number(x1), Number(x2));
      const minZ = Math.min(Number(z1), Number(z2));
      const maxZ = Math.max(Number(z1), Number(z2));
      const w = maxX - minX + 1;
      const l = maxZ - minZ + 1;
      const totalCols = w * l;
      // Cap matches mc level (16 columns). level_ground delegates to mc
      // level on execute, so we enforce the same limit upstream for a
      // faster + clearer error.
      if (totalCols > 16) {
        return { ok: false, error: {
          code: 'OUT_OF_RANGE',
          message: `mc level_ground: ${w}×${l} = ${totalCols} columns is too many — the per-call limit is 16 columns. Run ${Math.ceil(totalCols / 16)} smaller calls instead, each with ≤16 columns (e.g. ${Math.min(w, 4)}×${Math.min(l, 4)}).`,
          observed_state: { requested_cols: totalCols, max_cols: 16 },
          next_action_hint: `Split into ${Math.ceil(totalCols / 16)} smaller rectangles (≤16 columns each).`,
          retry_safe: false,
        } };
      }
      const pickMode = String(mode || 'median').toLowerCase();
      if (!['median', 'min', 'max'].includes(pickMode)) {
        return { ok: false, error: { code: 'INVALID_VALUE', message: `mc level_ground --mode must be median|min|max (got ${mode})`, retry_safe: false } };
      }
      const doExecute = execute === true || execute === 'true' || execute === '1';

      // Phase 1 — survey
      /** @type {{ x: number, z: number, top_y: number | null, block: string | null }[]} */
      const surveys = [];
      const tops = [];
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          const top = columnTopSolid(b, x, z);
          if (top) {
            surveys.push({ x, z, top_y: top.topY, block: top.blockName });
            tops.push(top.topY);
          } else {
            surveys.push({ x, z, top_y: null, block: null });
          }
        }
      }
      if (tops.length === 0) {
        return { ok: false, error: {
          code: 'NO_SURFACE', message: `mc level_ground: every column in ${w}×${l} returned no solid block — chunks unloaded?`,
          observed_state: { bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ } },
          retry_safe: true,
        } };
      }

      // Phase 2 — pick target Y
      let targetY;
      if (Number.isFinite(Number(target))) {
        targetY = Math.floor(Number(target));
      } else if (pickMode === 'min') {
        targetY = Math.min(...tops);
      } else if (pickMode === 'max') {
        targetY = Math.max(...tops);
      } else {
        // median
        const sorted = [...tops].sort((a, c) => a - c);
        targetY = sorted[Math.floor(sorted.length / 2)];
      }

      // Phase 3 — categorize + summarize
      /** @type {{ x: number, z: number, top_y: number | null, action: string, delta: number | null }[]} */
      const columns = [];
      let holes_n = 0, pillars_n = 0, level_n = 0, no_data_n = 0;
      let max_dig = 0, max_fill = 0, max_pillar_height = 0;
      for (const s of surveys) {
        if (s.top_y == null) {
          columns.push({ x: s.x, z: s.z, top_y: null, action: 'unknown', delta: null });
          no_data_n++;
          continue;
        }
        const delta = s.top_y - targetY;
        if (delta === 0) {
          columns.push({ x: s.x, z: s.z, top_y: s.top_y, action: 'level', delta: 0 });
          level_n++;
        } else if (delta < 0) {
          columns.push({ x: s.x, z: s.z, top_y: s.top_y, action: 'fill', delta });
          holes_n++;
          if (-delta > max_fill) max_fill = -delta;
        } else {
          columns.push({ x: s.x, z: s.z, top_y: s.top_y, action: 'dig', delta });
          pillars_n++;
          if (delta > max_dig) max_dig = delta;
          if (delta > max_pillar_height) max_pillar_height = delta;
        }
      }

      // up_range used by `mc level`'s dig phase. Cap at 16 (level's own limit).
      const upRecommended = Math.min(Math.max(max_pillar_height + 1, 1), 16);

      const planSummary = `${w}×${l} target=Y${targetY} (${pickMode}): ${holes_n} holes (max fill ${max_fill}), ${pillars_n} pillars (max dig ${max_dig}), ${level_n} level${no_data_n ? `, ${no_data_n} unloaded` : ''}`;

      // Phase 4 — execute? (optional)
      let executeResult = null;
      let executeErrors = null;
      if (doExecute) {
        // Delegate to mc level. Pass our computed targetY + recommended up_range,
        // optionally the operator's preferred fill block. level handles
        // standpoint pathfinding, top-down ordering (debris-safe), and fill.
        try {
          const handlers = (typeof getActions === 'function' ? getActions() : null);
          const levelFn = handlers && typeof handlers.level === 'function'
            ? handlers.level
            : null;
          if (!levelFn) {
            executeErrors = 'level handler not exposed via getActions()';
          } else {
            const res = await levelFn({
              x1: minX, z1: minZ, x2: maxX, z2: maxZ,
              y: targetY, up: upRecommended,
              ...(fillBlockName ? { block: fillBlockName } : {}),
            });
            if (res && res.ok === false) {
              executeErrors = res.error?.message || 'level returned ok:false';
              executeResult = res.error?.observed_state || null;
            } else {
              executeResult = res?.data || null;
            }
          }
        } catch (e) {
          executeErrors = e?.message || String(e);
        }
      }

      const resultText = doExecute
        ? (executeErrors
          ? `level_ground ${planSummary} — execute FAILED: ${executeErrors}`
          : `level_ground ${planSummary} — executed: dug ${executeResult?.dug ?? 0}, placed ${executeResult?.placed ?? 0}${executeResult?.skipped ? `, ${executeResult.skipped} skipped` : ''}${executeResult?.failed ? `, ${executeResult.failed} failed` : ''}`)
        : `level_ground PLAN ${planSummary} — dry-run (pass execute=true to run, recommended up=${upRecommended})`;

      return {
        ok: !(doExecute && executeErrors),
        data: {
          target_y: targetY,
          mode: Number.isFinite(Number(target)) ? 'explicit' : pickMode,
          bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ },
          columns_n: surveys.length,
          summary: {
            holes_n,
            pillars_n,
            level_n,
            no_data_n,
            max_dig,
            max_fill,
            max_pillar_height,
          },
          up_range_recommended: upRecommended,
          columns,
          ...(doExecute ? { executed: true, execute_result: executeResult } : {}),
          ...(executeErrors ? { execute_error: executeErrors } : {}),
        },
        result: resultText,
      };
    },

    /**
     * Build an ascending triangular ramp of cubes the bot can climb.
     * Column i (1..LEN) is filled from the existing floor up to height i,
     * giving every block a solid face neighbor below to place against.
     * Block count grows as LEN*(LEN+1)/2 — keep LEN modest.
     */
    async build_stairs({ block: blockName, direction, length, x, y, z }) {
      const b = ensureBot();
      if (!blockName || typeof blockName !== 'string') {
        return { ok: false, error: { code: 'MISSING_BLOCK_TYPE', message: 'mc build_stairs requires a block type', retry_safe: false } };
      }
      let dirInfo;
      try { dirInfo = cardinalDelta(direction); }
      catch { return { ok: false, error: { code: 'INVALID_DIR', message: `direction must be north|south|east|west, got "${direction}"`, retry_safe: false } }; }
      const { dx, dz, key } = dirInfo;

      const L = Math.min(Math.max(parseInt(String(length), 10) || 0, 1), 16);
      const startX = Number.isFinite(Number(x)) ? Math.floor(Number(x)) : Math.floor(b.entity.position.x);
      const startY = Number.isFinite(Number(y)) ? Math.floor(Number(y)) : Math.floor(b.entity.position.y);
      const startZ = Number.isFinite(Number(z)) ? Math.floor(Number(z)) : Math.floor(b.entity.position.z);

      const isAirLike = (blk) => blk && (blk.name === 'air' || blk.name === 'cave_air' || blk.name === 'void_air');
      const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

      let placed = 0, skipped = 0, failed = 0;
      const errors = [];

      for (let i = 1; i <= L; i++) {
        const cx = startX + dx * i;
        const cz = startZ + dz * i;
        // Fill column from the existing-floor level up to height i.
        // h = 0 → placed at startY (one above existing floor), h = i-1 → top of step.
        for (let h = 0; h < i; h++) {
          const cy = startY + h;
          const target = b.blockAt(new Vec3(cx, cy, cz));
          if (target && !isAirLike(target)) {
            if (target.name === blockName) { skipped++; continue; }
            // Something else is already there — count as skipped (don't overwrite).
            skipped++; continue;
          }

          // Top of column needs head clearance (cy+1) for the bot to stand on it.
          if (h === i - 1) {
            const headBlock = b.blockAt(new Vec3(cx, cy + 1, cz));
            if (headBlock && !isAirLike(headBlock)) {
              failed++;
              errors.push(`step ${i} top: head clearance blocked by ${headBlock.name}`);
              continue;
            }
          }

          const item = b.inventory.items().find((it) => it.name === blockName);
          if (!item) {
            return {
              ok: false,
              error: {
                code: 'MISSING_INVENTORY',
                message: `Out of ${blockName} after placing ${placed} blocks (step ${i}/${L})`,
                observed_state: { blocks_placed: placed, current_step: i, total_steps: L, block: blockName },
                retry_safe: true,
              },
            };
          }
          try { await b.equip(item, 'hand'); } catch {}

          let didPlace = false;
          for (const [ox, oy, oz] of offsets) {
            const ref = b.blockAt(new Vec3(cx + ox, cy + oy, cz + oz));
            if (ref && !isAirLike(ref) && ref.boundingBox === 'block') {
              if (shouldSkipPlaceAt(ctx, config, blockName, cx, cy, cz).skip) {
                failed++;
                break;
              }
              try {
                await b.placeBlock(ref, new Vec3(-ox, -oy, -oz));
                recordRecentPlace(ctx, { x: cx, y: cy, z: cz }, blockName);
                didPlace = true;
                placed++;
                break;
              } catch (e) {
                errors.push(`step ${i} h=${h}: place failed: ${e?.message || e}`);
              }
            }
          }
          if (!didPlace) {
            failed++;
            errors.push(`step ${i} h=${h}: no solid neighbor at ${cx},${cy},${cz}`);
          }
        }

        // After completing column i, walk onto the top so next column's blocks are reachable.
        try { await pathfindGotoNear(b, goals, cx, startY + i, cz, 0, { opName: 'pillar_down', capMs: ACTION_CAPS_MS.reach }); } catch {}
      }

      const expectedBlocks = (L * (L + 1)) / 2;
      return {
        ok: true,
        data: {
          blocks_placed: placed,
          blocks_skipped: skipped,
          blocks_failed: failed,
          expected_blocks: expectedBlocks,
          block: blockName,
          direction: key,
          length: L,
          start: { x: startX, y: startY, z: startZ },
          end: { x: startX + dx * L, y: startY + L - 1, z: startZ + dz * L },
          errors: errors.slice(0, 5),
        },
        result: `build_stairs ${key} ${L} ${blockName}: ${placed}/${expectedBlocks} blocks placed${skipped ? `, ${skipped} skipped` : ''}${failed ? `, ${failed} failed` : ''}`,
      };
    },

  };
}
