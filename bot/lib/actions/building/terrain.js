import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { equipForDig, isDigProtected, recordRecentPlace, columnTopSolid } from '../../runtime/dig-tools.js';
import { shouldSkipDigAt, shouldSkipPlaceAt } from '../../runtime/regions/policy-guard.js';
import { cardinalDelta } from '../_directions.js';
import { pathfindGotoNear, ACTION_CAPS_MS, timeoutError } from '../_helpers.js';
import { parseYInput, withYBoth } from '../../runtime/coordinates.js';
import { cascadeFor, paletteForRegion, tierOf, isStructural } from '../../runtime/materials.js';

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
  // Wallclock caps — injectable for tests (deps.capsMs), default shared caps.
  const capsMs = deps.capsMs || ACTION_CAPS_MS;

  return {
    async path({ x1, z1, x2, z2, y, surface_y }) {
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
      // Y input: y (= block_y of the path tile, legacy) or surface_y (= one
      // above, where bots walk). Default: bot's foot block.
      const parsedPathY = parseYInput({ y, surface_y });
      const pathY = parsedPathY !== null ? parsedPathY : Math.floor(b.entity.position.y) - 1;

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
          data: { paths_placed: 0, paths_skipped: skipped, paths_failed: 0, bounds: withYBoth({ x1: minX, z1: minZ, x2: maxX, z2: maxZ, y: pathY }, pathY) },
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
          bounds: withYBoth({ x1: minX, z1: minZ, x2: maxX, z2: maxZ, y: pathY }, pathY),
        },
        result: `Path: ${placed} placed, ${skipped} skipped, ${failed} failed at Y=${pathY}`,
      };
    },

    /**
     * Dig a W×L×D pit. The pit top is at the bot's existing surface (bot Y - 1)
     * unless `top_y` is given. Capped at 32 blocks (W×L×D) per call.
     * Thin wrapper over dig_area; stair-out is a separate verb (mc build_stairs).
     */
    async dig_pit({ x, z, w, l, d, top_y, surface_y }) {
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

      // Y input: top_y (= block_y of the pit's top surface block, legacy) or
      // surface_y (= the walk-on Y above it). Default: bot's foot block.
      const parsedTopY = parseYInput({ y: top_y, surface_y });
      const surfaceY = parsedTopY !== null ? parsedTopY : Math.floor(b.entity.position.y) - 1;
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
          // Floor of the pit is the block below y1 — bots stand on its top.
          floor_block_y: y1 - 1,
          floor_surface_y: y1,
          // Top opening of the pit (the original surface).
          top_block_y: surfaceY,
          top_surface_y: surfaceY + 1,
          // Legacy alias:
          floor_y: y1 - 1,
        },
        result: `dig_pit ${W}×${L}×${D} at (${cornerX}, top_block_y=${surfaceY}, ${cornerZ}): dug ${res?.dug || 0}, skipped ${res?.skipped || 0}. Pit floor block_y=${y1 - 1}, walk surface_y=${y1}.`,
      };
    },

    /**
     * Flatten a rectangle to target Y: dig solid blocks above Y, place a
     * fill block at Y if the column is air at that level. Touches up to
     * `up` blocks above Y (default 8). Below Y is not touched.
     *
     * Y inputs: pass either `y` (= block_y of the fill block, legacy) or
     * `surface_y` (= where bots walk = block_y + 1). When both are passed,
     * `surface_y` wins. See docs/reference/world-coordinates.md.
     *
     * Block selection: explicit `block=NAME` wins; otherwise picks the
     * region's profile palette (e.g. cobblestone inside :base:) if the
     * bbox center is in a protect region; otherwise falls back to the
     * tier_1 `fill_default` cascade. See data/materials.json.
     */
    async level({ x1, z1, x2, z2, y, surface_y, block: fillBlockName, up }) {
      const b = ensureBot();
      for (const [k, v] of Object.entries({ x1, z1, x2, z2 })) {
        if (!Number.isFinite(Number(v))) {
          return { ok: false, error: { code: 'INVALID_COORD', message: `mc level requires numeric ${k}`, retry_safe: false } };
        }
      }
      const parsedY = parseYInput({ y, surface_y });
      if (parsedY === null) {
        return { ok: false, error: { code: 'INVALID_COORD', message: `mc level requires y or surface_y`, retry_safe: false } };
      }
      const minX = Math.min(Number(x1), Number(x2));
      const maxX = Math.max(Number(x1), Number(x2));
      const minZ = Math.min(Number(z1), Number(z2));
      const maxZ = Math.max(Number(z1), Number(z2));
      const targetY = parsedY;
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
      // Cascade selection — explicit > region palette > tier_1 default.
      // Region detection: sample at bbox center; if a protect region wins,
      // use its profile palette (base→cobble, farm→dirt, dock→planks).
      let fillCascade;
      let cascadeReason;
      if (fillBlockName) {
        fillCascade = [fillBlockName];
        cascadeReason = 'explicit';
      } else {
        const midX = Math.floor((minX + maxX) / 2);
        const midZ = Math.floor((minZ + maxZ) / 2);
        const regionsHere = ctx?.runtime?.regions?.at?.(midX, targetY, midZ) || [];
        const protectRegion = regionsHere.find((r) => r.intent === 'protect') || null;
        const palette = protectRegion ? paletteForRegion(protectRegion) : [];
        const defaultCascade = cascadeFor('fill_default');
        if (palette.length > 0) {
          // Palette items first, then fall back to defaults the palette omits.
          const seen = new Set(palette);
          fillCascade = [...palette, ...defaultCascade.filter((nm) => !seen.has(nm))];
          cascadeReason = `region:${protectRegion.id}`;
        } else {
          fillCascade = defaultCascade;
          cascadeReason = 'fill_default';
        }
      }
      const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

      let dug = 0, placed = 0, skipped = 0, failed = 0;
      // proc-nav-1781079999 hyp G: bridge-fill (placing a pillar from a
      // deep floor up to targetY) happens when the column has no solid
      // neighbor at targetY but has solid ground deeper. Track scaffold
      // placements separately so the agent sees them in the result.
      let bridge_filled = 0;
      const errors = [];
      // Track per-block placements so we can detect tier_2 fallback (= a
      // placement happened because tier_1 was unavailable in inventory).
      /** @type {Record<string, number>} */
      const placedByBlock = {};

      const capMs = Number(capsMs.level) || ACTION_CAPS_MS.level;
      const deadline = Date.now() + capMs;
      const cols = [];
      for (let cx = minX; cx <= maxX; cx++) {
        for (let cz = minZ; cz <= maxZ; cz++) cols.push({ x: cx, z: cz });
      }
      const partialTimeout = (colIdx) => timeoutError('level', capMs, {
        dug,
        placed,
        skipped,
        failed,
        columns_done: colIdx,
        columns_remaining: cols.length - colIdx,
        next_unfilled: cols.slice(colIdx, colIdx + 8).map((c) => [c.x, c.z]),
        bounds: withYBoth({ x1: minX, z1: minZ, x2: maxX, z2: maxZ, y: targetY }, targetY),
      }, `Partial completion: ${colIdx}/${cols.length} columns done. Re-run the same mc level command — already-leveled columns are skipped quickly.`);

      for (let ci = 0; ci < cols.length; ci++) {
        const { x, z } = cols[ci];
        if (Date.now() > deadline) return partialTimeout(ci);
        {
          // 1) Dig blocks above targetY (top-down so debris doesn't fall on us).
          for (let dy = upRange; dy >= 1; dy--) {
            if (Date.now() > deadline) return partialTimeout(ci);
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
                // Snowy-biome fix (W2-NAV-016): snow_layer reports
                // boundingBox=block when layers ≥ 2 but is not a stable
                // place-against face — mineflayer's placeBlock against it
                // fails with "Cannot place against {snow}". Skip if the
                // candidate ref is snow_layer ABOVE target_y (decorative
                // snow on the bed). Snow_block (full block) and snow_layer
                // BELOW target_y are still valid floors.
                if ((ref.name === 'snow' || ref.name === 'snow_layer') &&
                    (targetY + oy) >= targetY) {
                  continue;
                }
                if (shouldSkipPlaceAt(ctx, config, blockName, x, targetY, z).skip) {
                  failed++;
                  break;
                }
                try {
                  await b.placeBlock(ref, new Vec3(-ox, -oy, -oz));
                  recordRecentPlace(ctx, { x, y: targetY, z }, blockName);
                  didPlace = true;
                  placed++;
                  placedByBlock[blockName] = (placedByBlock[blockName] || 0) + 1;
                  break;
                } catch { /* try next face */ }
              }
            }
            if (didPlace) break;
          }
          if (!didPlace) {
            // Bridge-gap fallback (proc-nav-1781079999 hyp G).
            // When no face had a solid anchor, the column is a "fill_deep":
            // air all the way down to a deep floor. Walk down to find the
            // floor, then build a pillar up to targetY using the just-placed
            // block as the anchor for the next placement.
            // Builder-mox on seg 2 of proc-nav-1781079999 hit this exact
            // shape — ground at y=61, target y=63, level execute couldn't
            // anchor at targetY and bailed; they had to manual `mc place`.
            const MAX_BRIDGE = 8;
            let floor_y = null;
            for (let dy = -1; dy >= -MAX_BRIDGE; dy--) {
              const probe = b.blockAt(new Vec3(x, targetY + dy, z));
              if (probe && probe.boundingBox === 'block' && !isAirLike(probe)) {
                floor_y = targetY + dy;
                break;
              }
            }
            if (floor_y !== null && floor_y < targetY - 1) {
              if (b.entity.position.distanceTo(new Vec3(x, targetY, z)) > 4.5) {
                try {
                  await pathfindGotoNear(
                    b, goals, x, targetY + 1, z, 3,
                    { opName: 'bridge_fill', capMs: ACTION_CAPS_MS.reach },
                  );
                } catch {}
              }
              // Place from floor_y+1 up to targetY. Each iteration's anchor
              // is the cell we just placed (or the original floor).
              for (let by = floor_y + 1; by <= targetY; by++) {
                let placed_here = false;
                for (const blockName of fillCascade) {
                  const item = b.inventory.items().find((it) => it.name === blockName);
                  if (!item) continue;
                  try { await b.equip(item, 'hand'); } catch { continue; }
                  const ref = b.blockAt(new Vec3(x, by - 1, z));
                  if (!ref || isAirLike(ref) || ref.boundingBox !== 'block') break;
                  if (shouldSkipPlaceAt(ctx, config, blockName, x, by, z).skip) break;
                  try {
                    await b.placeBlock(ref, new Vec3(0, 1, 0));
                    recordRecentPlace(ctx, { x, y: by, z }, blockName);
                    placed_here = true;
                    if (by === targetY) {
                      placed++;
                      placedByBlock[blockName] = (placedByBlock[blockName] || 0) + 1;
                      didPlace = true;
                    } else {
                      bridge_filled++;
                      placedByBlock[blockName] = (placedByBlock[blockName] || 0) + 1;
                    }
                    break;
                  } catch { /* try next block */ }
                }
                if (!placed_here) break;
              }
            }
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
                  observed_state: { dug, placed, columns_done: ci, columns_remaining: cols.length - ci, next_unfilled: cols.slice(ci, ci + 8).map((c) => [c.x, c.z]), bounds: withYBoth({ x1: minX, z1: minZ, x2: maxX, z2: maxZ, y: targetY }, targetY), fill_cascade: fillCascade },
                  retry_safe: true,
                },
              };
            }
            failed++;
            errors.push(`fill ${x},${targetY},${z}: no solid neighbor`);
          }
        }
      }

      // Phase C7: tier-2 fallback hint. If any placement used a non-tier_1
      // block (planks, smooth_stone, etc.), that's the patchwork failure
      // mode in miniature — the agent should know it ran out of cheap fill.
      const tier2PlacedBlocks = Object.entries(placedByBlock).filter(
        ([nm, n]) => n > 0 && tierOf(nm) !== null && tierOf(nm) >= 2,
      );
      let fillFallbackHint = null;
      if (tier2PlacedBlocks.length > 0) {
        const summary = tier2PlacedBlocks.map(([nm, n]) => `${n}× ${nm} (tier_${tierOf(nm)})`).join(', ');
        fillFallbackHint = `⚠ tier_2+ fallback fill used (${summary}). Restock tier_1 (dirt/sand/cobble) before the next cleanup card — these placements stand out visually.`;
      }

      return {
        ok: true,
        data: {
          dug,
          placed,
          skipped,
          failed,
          bridge_filled,
          bounds: withYBoth({ x1: minX, z1: minZ, x2: maxX, z2: maxZ, y: targetY }, targetY),
          block_y: targetY,
          surface_y: targetY + 1,
          fill_cascade: fillCascade,
          fill_cascade_reason: cascadeReason,
          placed_by_block: placedByBlock,
          ...(fillFallbackHint ? { fill_fallback_hint: fillFallbackHint } : {}),
          up_range: upRange,
          errors: errors.slice(0, 5),
        },
        result: `level ${w}×${l} block_y=${targetY} (surface_y=${targetY + 1}): dug ${dug}, placed ${placed}${bridge_filled ? ` (+${bridge_filled} bridge-fill below)` : ''}${skipped ? `, ${skipped} skipped` : ''}${failed ? `, ${failed} failed` : ''} [cascade=${cascadeReason}]${fillFallbackHint ? ` ${fillFallbackHint}` : ''}`,
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
     *   target           — explicit target Y (block_y, legacy)
     *   surface_y        — alternative to `target`: the Y a bot walks on
     *                      (= block_y + 1). When both given, surface_y wins.
     *                      See docs/reference/world-coordinates.md.
     *   mode             — 'median' (default) | 'min' | 'max', only used
     *                      when neither target nor surface_y is given
     *   block            — fill block name; otherwise picks the region's
     *                      profile palette (base→cobble) or the tier_1
     *                      `fill_default` cascade. See data/materials.json.
     *   execute          — false (default): dry-run, returns plan only.
     *                      true: invokes the work via mc level.
     *
     * Returns:
     *   { ok: true, data: {
     *       block_y, surface_y, mode, bounds, columns_n,
     *       summary: { holes_n, pillars_n, level_n, preserved_n,
     *                  max_dig, max_fill, max_pillar_height },
     *       palette_observed: { dirt: N, oak_log: M, ... },
     *       structural_columns: [{ x, z, block_y, block_name }],
     *       up_range_recommended,
     *       columns: [{ x, z, top_block_y, top_surface_y, top_block,
     *                   action: 'fill'|'dig'|'level'|'preserve'|'unknown',
     *                   delta }],
     *       executed?: true | undefined,
     *       execute_result?: { dug, placed, skipped, failed }  // present iff execute=true
     *     } }
     */
    async level_ground({ x1, z1, x2, z2, target, surface_y, mode, block: fillBlockName, execute, exclude_foliage }) {
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
      // Foliage-aware survey: when set, columnTopSolid skips *_leaves and
      // snow_layer. Default true (proc-nav-1781079999) — every production
      // caller wants ground Y, not canopy Y. Pass exclude_foliage=false to
      // include leaves as topY (rare — canopy-inspection callers only).
      const excludeFoliage = exclude_foliage !== false && exclude_foliage !== 'false' && exclude_foliage !== '0' && exclude_foliage !== 0;

      // Phase 1 — survey
      /** @type {{ x: number, z: number, top_y: number | null, block: string | null }[]} */
      const surveys = [];
      const tops = [];
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          const top = columnTopSolid(b, x, z, { excludeFoliage });
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

      // Phase 2 — pick target Y. Accept surface_y (preferred) or target (legacy).
      const explicitBlockY = parseYInput({ y: target, surface_y });
      let targetY;
      let targetMode;
      if (explicitBlockY !== null) {
        targetY = explicitBlockY;
        targetMode = 'explicit';
      } else if (pickMode === 'min') {
        targetY = Math.min(...tops);
        targetMode = 'min';
      } else if (pickMode === 'max') {
        targetY = Math.max(...tops);
        targetMode = 'max';
      } else {
        const sorted = [...tops].sort((a, c) => a - c);
        targetY = sorted[Math.floor(sorted.length / 2)];
        targetMode = 'median';
      }

      // Phase 3 — categorize + summarize. Structural blocks (oak_log,
      // fences, doors, planks…) get action='preserve' instead of 'dig'
      // even when they sit above target — they're built infrastructure,
      // not orphan terrain. See data/materials.json tier_2+.
      //
      // Fill columns also get a fill_kind sub-classification:
      //   - 'shallow' (hole_depth ≤ 3): `level` execute will plant a cap;
      //     cavity below is invisible from above but present.
      //   - 'deep' (4 ≤ hole_depth < 16): cap-only is structurally weak +
      //     visually wrong; recommend deck primitive or reroute.
      //   - 'no_floor' (hole_depth ≥ 16): ravine / cliff. Reroute is the
      //     normal answer; bridging requires multi-segment planning.
      // Connected fill cells get bucketed into dip_spans (BFS) so the
      // planner can decide per-pocket, not per-column.
      const FILL_SHALLOW_MAX_DEPTH = 3;
      const NO_FLOOR_MIN_DEPTH = 16;
      /** @type {{ x: number, z: number, top_block_y: number | null, top_surface_y: number | null, top_block: string | null, action: string, delta: number | null, hole_depth?: number, fill_kind?: string }[]} */
      const columns = [];
      const palette_observed = {};
      const structural_columns = [];
      let holes_n = 0, pillars_n = 0, level_n = 0, no_data_n = 0, preserved_n = 0;
      let fill_shallow_n = 0, fill_deep_n = 0, no_floor_n = 0;
      let max_dig = 0, max_fill = 0, max_pillar_height = 0;
      let max_hole_depth = 0;
      for (const s of surveys) {
        if (s.block) {
          palette_observed[s.block] = (palette_observed[s.block] || 0) + 1;
        }
        if (s.top_y == null) {
          columns.push({ x: s.x, z: s.z, top_y: null, top_block_y: null, top_surface_y: null, top_block: null, action: 'unknown', delta: null });
          no_data_n++;
          continue;
        }
        const delta = s.top_y - targetY;
        const baseCol = {
          x: s.x,
          z: s.z,
          // Canonical fields:
          top_block_y: s.top_y,
          top_surface_y: s.top_y + 1,
          top_block: s.block,
          // Legacy alias for one release:
          top_y: s.top_y,
        };
        if (delta === 0) {
          columns.push({ ...baseCol, action: 'level', delta: 0 });
          level_n++;
        } else if (delta < 0) {
          // hole_depth = number of air cells between the live floor and the
          // target cap. Example: targetY=80, top_y=77 → air at 78,79 → depth=2.
          const hole_depth = -delta - 1;
          if (hole_depth > max_hole_depth) max_hole_depth = hole_depth;
          let fill_kind;
          if (hole_depth >= NO_FLOOR_MIN_DEPTH) {
            fill_kind = 'no_floor';
            no_floor_n++;
          } else if (hole_depth > FILL_SHALLOW_MAX_DEPTH) {
            fill_kind = 'deep';
            fill_deep_n++;
          } else {
            fill_kind = 'shallow';
            fill_shallow_n++;
          }
          columns.push({ ...baseCol, action: 'fill', delta, hole_depth, fill_kind });
          holes_n++;
          if (-delta > max_fill) max_fill = -delta;
        } else if (s.block && isStructural(s.block)) {
          // Structural infrastructure above target — never dig.
          columns.push({ ...baseCol, action: 'preserve', delta });
          structural_columns.push({ x: s.x, z: s.z, block_y: s.top_y, block_name: s.block });
          preserved_n++;
        } else {
          columns.push({ ...baseCol, action: 'dig', delta });
          pillars_n++;
          if (delta > max_dig) max_dig = delta;
          if (delta > max_pillar_height) max_pillar_height = delta;
        }
      }

      // Connected-component bucketing of fill cells into dip spans. Two fill
      // cells are connected if they share a face in x or z. We classify each
      // span by its worst fill_kind + max hole_depth so the planner can choose
      // per-pocket. Spans of size 1–2 with shallow depth are "level caps
      // these"; anything else gets a deck/reroute recommendation.
      const DECK_MIN_SPAN_N = 3;
      const cellByKey = new Map();
      for (const c of columns) {
        if (c.action === 'fill') cellByKey.set(`${c.x},${c.z}`, c);
      }
      const visited = new Set();
      /** @type {{ cells: {x:number,z:number}[], n: number, max_depth: number, min_depth: number, contains_no_floor: boolean, suggestion: 'level_caps'|'deck'|'reroute' }[]} */
      const dip_spans = [];
      for (const start of cellByKey.values()) {
        const startKey = `${start.x},${start.z}`;
        if (visited.has(startKey)) continue;
        const queue = [start];
        visited.add(startKey);
        const span = { cells: [], n: 0, max_depth: 0, min_depth: Infinity, contains_no_floor: false, suggestion: 'level_caps' };
        while (queue.length) {
          const cur = queue.shift();
          span.cells.push({ x: cur.x, z: cur.z });
          span.n++;
          if (cur.hole_depth > span.max_depth) span.max_depth = cur.hole_depth;
          if (cur.hole_depth < span.min_depth) span.min_depth = cur.hole_depth;
          if (cur.fill_kind === 'no_floor') span.contains_no_floor = true;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nk = `${cur.x + dx},${cur.z + dz}`;
            if (visited.has(nk)) continue;
            const nb = cellByKey.get(nk);
            if (!nb) continue;
            visited.add(nk);
            queue.push(nb);
          }
        }
        if (span.min_depth === Infinity) span.min_depth = 0;
        // Suggestion ladder (proc-nav-1781079999 fix — drop OR span_n trigger):
        //   contains_no_floor → reroute (ravine; bridging is a separate plan)
        //   max_depth > shallow → deck (cells need deep fill, level execute
        //     can't reliably handle multi-block depth)
        //   else → level_caps (level execute fills shallow dips of any width)
        //
        // Pre-fix, the condition was `max_depth > shallow OR n ≥ wide`.
        // The OR-span_n branch wrongly classified wide-but-shallow dips
        // (10-cell span at max_depth=1) as decks, when in fact a flat
        // fill handles them. Builder-mox on seg 2 of proc-nav-1781079999
        // had to manually reject the classification before proceeding.
        // DECK_MIN_SPAN_N is retained for future use (e.g. choosing
        // between deck and reroute on deep spans).
        if (span.contains_no_floor) span.suggestion = 'reroute';
        else if (span.max_depth > FILL_SHALLOW_MAX_DEPTH) span.suggestion = 'deck';
        else span.suggestion = 'level_caps';
        dip_spans.push(span);
      }

      // Recommended actions: human-readable strings for the planner / agent
      // to consume. Use them to decide whether to emit a level execute card,
      // a deck card (when ready), or a reroute / segment-split.
      const recommended_actions = [];
      if (level_n + pillars_n + fill_shallow_n + preserved_n + no_data_n === surveys.length
          && (fill_shallow_n > 0 || pillars_n > 0) && fill_deep_n === 0 && no_floor_n === 0) {
        recommended_actions.push(
          `Standard terrain — \`mc level_ground ${minX} ${minZ} ${maxX} ${maxZ} target=${targetY} execute=true\` will handle ${fill_shallow_n + pillars_n + level_n} cells. ${preserved_n ? `${preserved_n} structural preserved.` : ''}`.trim(),
        );
      }
      for (const span of dip_spans) {
        if (span.suggestion === 'level_caps') continue;
        const xs = span.cells.map((c) => c.x);
        const zs = span.cells.map((c) => c.z);
        const sx1 = Math.min(...xs), sx2 = Math.max(...xs);
        const sz1 = Math.min(...zs), sz2 = Math.max(...zs);
        if (span.suggestion === 'deck') {
          recommended_actions.push(
            `Dip span (${sx1},${sz1})..(${sx2},${sz2}): ${span.n} cells, depth ${span.min_depth}..${span.max_depth} — too deep/wide for level cap. Use \`mc deck\` (when available) or reroute corridor around it. Until deck lands: shift this segment ±3 X to avoid.`,
          );
        } else {
          recommended_actions.push(
            `No-floor span (${sx1},${sz1})..(${sx2},${sz2}): ${span.n} cells, depth ≥${NO_FLOOR_MIN_DEPTH} — ravine/cliff. Reroute corridor around this section, OR mark the segment as [BRIDGE] for a multi-segment crossing plan.`,
          );
        }
      }
      if (no_data_n > 0) {
        recommended_actions.push(
          `${no_data_n} columns returned no terrain top — chunks unloaded or below build limit. Retry after \`mc map\` or shrink the rectangle.`,
        );
      }
      const deck_required_n = dip_spans.filter((s) => s.suggestion === 'deck').length;
      const reroute_required_n = dip_spans.filter((s) => s.suggestion === 'reroute').length;

      // up_range used by `mc level`'s dig phase. Cap at 16 (level's own limit).
      const upRecommended = Math.min(Math.max(max_pillar_height + 1, 1), 16);

      const preservedNote = preserved_n > 0 ? `, ${preserved_n} preserved (structural)` : '';
      const fillBreakdown = holes_n > 0
        ? ` [shallow=${fill_shallow_n}${fill_deep_n ? `, deep=${fill_deep_n}` : ''}${no_floor_n ? `, no_floor=${no_floor_n}` : ''}]`
        : '';
      const dispositionNote = (deck_required_n + reroute_required_n) > 0
        ? `; ${deck_required_n ? `${deck_required_n} span(s) need deck` : ''}${deck_required_n && reroute_required_n ? ', ' : ''}${reroute_required_n ? `${reroute_required_n} span(s) need reroute` : ''}`
        : '';
      const planSummary = `${w}×${l} block_y=${targetY} surface_y=${targetY + 1} (${targetMode}): ${holes_n} holes${fillBreakdown} (max fill ${max_fill}, max hole_depth ${max_hole_depth}), ${pillars_n} pillars (max dig ${max_dig}), ${level_n} level${preservedNote}${no_data_n ? `, ${no_data_n} unloaded` : ''}${dispositionNote}`;

      // Phase 4 — execute? (optional)
      let executeResult = null;
      let executeErrors = null;
      if (doExecute) {
        // Delegate to mc level. Pass block_y target + recommended up_range,
        // optionally the operator's preferred fill block. level handles
        // standpoint pathfinding, top-down ordering (debris-safe), and fill;
        // and picks region-palette default when no explicit block given.
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
          // Canonical Y vocabulary (docs/reference/world-coordinates.md):
          block_y: targetY,
          surface_y: targetY + 1,
          // Legacy alias for back-compat (same as block_y).
          target_y: targetY,
          mode: targetMode,
          bounds: withYBoth({ x1: minX, z1: minZ, x2: maxX, z2: maxZ }, targetY),
          columns_n: surveys.length,
          summary: {
            holes_n,
            pillars_n,
            level_n,
            preserved_n,
            no_data_n,
            max_dig,
            max_fill,
            max_pillar_height,
            // Fill-kind breakdown — lets the planner detect deep holes
            // before issuing an execute that would only cap them.
            fill_shallow_n,
            fill_deep_n,
            no_floor_n,
            max_hole_depth,
            deck_required_n,
            reroute_required_n,
          },
          dispositions: {
            // Planner-facing rollup: what each cell wants done. Use this
            // to choose between level execute, deck (when available),
            // reroute, or split the segment.
            level: level_n,
            cut: pillars_n,
            fill_shallow: fill_shallow_n,
            fill_deep: fill_deep_n,
            no_floor: no_floor_n,
            preserved: preserved_n,
            unknown: no_data_n,
          },
          dip_spans,
          recommended_actions,
          palette_observed,
          structural_columns,
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
    async build_stairs({ block: blockName, direction, length, x, y, surface_y, z }) {
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
      // Y input: accept either y (= block_y, legacy) or surface_y (= block_y + 1).
      // Default: bot's current block_y (foot Y).
      const parsedStartY = parseYInput({ y, surface_y });
      const startY = parsedStartY !== null ? parsedStartY : Math.floor(b.entity.position.y);
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
          start: withYBoth({ x: startX, y: startY, z: startZ }, startY),
          end: withYBoth({ x: startX + dx * L, y: startY + L - 1, z: startZ + dz * L }, startY + L - 1),
          errors: errors.slice(0, 5),
        },
        result: `build_stairs ${key} ${L} ${blockName}: ${placed}/${expectedBlocks} blocks placed${skipped ? `, ${skipped} skipped` : ''}${failed ? `, ${failed} failed` : ''}`,
      };
    },

  };
}
