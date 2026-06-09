import { Vec3 } from 'vec3';
import { columnTopSolid } from '../../runtime/dig-tools.js';
import { standabilityReason, findClosestStandable } from '../_nav-helpers.js';
import { AIR_NAMES } from '../_block-sets.js';
import { withYBoth, parseYInput } from '../../runtime/coordinates.js';

export function createRegionQueries({ ensureBot, posObj, goals }) {
  return {
  async terrain_top({ x, z, radius = 0, full = false, exclude_foliage = false }) {
    const b = ensureBot();
    const cx = Math.floor(Number(x));
    const cz = Math.floor(Number(z));
    const r = Math.min(Math.max(parseInt(String(radius), 10) || 0, 0), 32);
    const excludeFoliage = exclude_foliage === true || exclude_foliage === 'true' || exclude_foliage === '1';
    /** @type {{ x:number, z:number, topY:number, blockName:string }[]} */
    const columns = [];
    let maxTopY = Number.NEGATIVE_INFINITY;
    let maxBlock = '';
    let maxAt = { x: cx, z: cz };

    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const ix = cx + dx;
        const iz = cz + dz;
        const col = columnTopSolid(b, ix, iz, { excludeFoliage });
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
        block_y: null,
        surface_y: null,
        blockName: null,
        block_name: null,
        columns: [],
      };
    }

    // Canonical Y vocabulary (docs/reference/world-coordinates.md):
    //   block_y = topmost solid block's Y
    //   surface_y = where a bot stands on top (= block_y + 1)
    // `feetYHint` kept as a back-compat alias for one release.
    const surface_y = maxTopY + 1;
    return {
      result: `Top solid block_y=${maxTopY} (${maxBlock}) at ${maxAt.x},${maxAt.z}; surface_y=${surface_y}${r ? ` (max over radius ${r})` : ''}`,
      block_y: maxTopY,
      surface_y,
      block_name: maxBlock,
      columnX: maxAt.x,
      columnZ: maxAt.z,
      // Legacy aliases:
      topY: maxTopY,
      blockName: maxBlock,
      feetYHint: surface_y,
      columns_omitted: !full && r > 0 ? columns.length : undefined,
      // Per-column entries also surfaced with canonical names + legacy.
      ...(r > 0 && full ? {
        columns: columns.map((c) => ({
          x: c.x, z: c.z,
          block_y: c.topY, surface_y: c.topY + 1,
          block_name: c.blockName,
          topY: c.topY, blockName: c.blockName,  // legacy
        })),
      } : {}),
    };
  },

  /**
   * Batch terrain_top over a rectangle. Returns per-cell samples + the
   * elevation aggregate (median/min/max/delta) in one HTTP round-trip.
   * Pure read — no bot movement, no dig, no place.
   *
   * Use case: road scout + measure cards. Sampling a 3-wide corridor at
   * 2-block intervals takes ~24 individual mc terrain_top calls (each a
   * 100-300ms round-trip); mc corridor_sample collapses them into 1.
   *
   * Args:
   *   x1, z1, x2, z2   — rectangle bounds (inclusive). Order doesn't matter.
   *   step             — z-step within the rectangle (1 = every cell,
   *                      2 = every other). Default 1. Applied to z only;
   *                      every x is sampled.
   *   exclude_foliage  — pass through to columnTopSolid. When true, skips
   *                      *_leaves and snow_layer so a tree canopy doesn't
   *                      register as ground. Default false (legacy).
   *   full             — when true, returns the full samples[] array.
   *                      When false (default), samples[] is omitted to
   *                      keep the response small; only aggregates returned.
   */
  async corridor_sample({ x1, z1, x2, z2, step = 1, exclude_foliage = false, full = false }) {
    const b = ensureBot();
    for (const [k, v] of Object.entries({ x1, z1, x2, z2 })) {
      if (!Number.isFinite(Number(v))) {
        return {
          ok: false,
          error: {
            code: 'INVALID_COORD',
            message: `mc corridor_sample requires numeric ${k}`,
            retry_safe: false,
          },
        };
      }
    }
    const minX = Math.min(Number(x1), Number(x2));
    const maxX = Math.max(Number(x1), Number(x2));
    const minZ = Math.min(Number(z1), Number(z2));
    const maxZ = Math.max(Number(z1), Number(z2));
    const s = Math.max(1, Math.min(parseInt(String(step), 10) || 1, 16));
    const excludeFoliage = exclude_foliage === true || exclude_foliage === 'true' || exclude_foliage === '1';
    const includeFull = full === true || full === 'true' || full === '1';
    const w = maxX - minX + 1;
    const lFull = maxZ - minZ + 1;
    // Cap inputs at 256 sampled cells (the per-step count, not the
    // rectangle size). A 3×85 corridor at step=1 = 255; tight enough.
    const sampledZ = Math.ceil(lFull / s);
    const totalSamples = w * sampledZ;
    if (totalSamples > 256) {
      return {
        ok: false,
        error: {
          code: 'OUT_OF_RANGE',
          message: `mc corridor_sample: ${w}×${sampledZ} = ${totalSamples} samples > 256 cap. Increase step or split the rectangle.`,
          observed_state: { requested_samples: totalSamples, max_samples: 256, bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ }, step: s },
          retry_safe: false,
        },
      };
    }
    const samples = [];
    let unknownN = 0;
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z += s) {
        const col = columnTopSolid(b, x, z, { excludeFoliage });
        if (!col) {
          unknownN++;
          samples.push({ x, z, block_y: null, surface_y: null, block_name: null });
          continue;
        }
        samples.push({
          x, z,
          block_y: col.topY,
          surface_y: col.topY + 1,
          block_name: col.blockName,
        });
      }
    }
    const knownYs = samples.filter((s2) => s2.block_y !== null).map((s2) => s2.block_y);
    if (knownYs.length === 0) {
      return {
        ok: false,
        error: {
          code: 'NO_SURFACE',
          message: `mc corridor_sample: every column returned no solid block — chunks unloaded?`,
          observed_state: { samples_n: samples.length, bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ }, exclude_foliage: excludeFoliage },
          retry_safe: true,
        },
      };
    }
    const sortedYs = [...knownYs].sort((a, b2) => a - b2);
    const median = sortedYs[Math.floor(sortedYs.length / 2)];
    const minY = sortedYs[0];
    const maxY = sortedYs[sortedYs.length - 1];
    return {
      ok: true,
      data: {
        bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ },
        step: s,
        exclude_foliage: excludeFoliage,
        columns_n: samples.length,
        known_n: knownYs.length,
        unknown_n: unknownN,
        elevation_median: median,
        elevation_min: minY,
        elevation_max: maxY,
        elevation_delta: maxY - minY,
        ...(includeFull ? { samples } : {}),
      },
      result: `corridor_sample ${w}×${sampledZ} (step=${s}${excludeFoliage ? ', exclude_foliage' : ''}): median=${median} delta=${maxY - minY} min=${minY} max=${maxY} (${knownYs.length}/${samples.length} cells with data)`,
    };
  },

  /**
   * Reachability pre-flight: is (x, y, z) standable? If not, find the
   * closest standable cell within range. Accepts y or surface_y on input;
   * returns both forms on `target` and `best_stand`.
   */
  async reachable({ x, y, surface_y, z, range = 3 }) {
    const b = ensureBot();
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(z))) {
      return {
        ok: false,
        error: {
          code: 'INVALID_COORD',
          message: 'mc reachable requires numeric x, z',
          retry_safe: false,
        },
      };
    }
    const parsedY = parseYInput({ y, surface_y });
    if (parsedY === null) {
      return {
        ok: false,
        error: {
          code: 'INVALID_COORD',
          message: 'mc reachable requires y or surface_y',
          retry_safe: false,
        },
      };
    }
    const ix = Math.floor(Number(x));
    const iy = parsedY;
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
        target: withYBoth({ x: ix, y: iy, z: iz }, iy),
        target_standable,
        target_reason,
        best_stand: best
          ? withYBoth({ x: best.x, y: best.y, z: best.z, distance: best.distance }, best.y)
          : null,
        bot_position: posObj(b.entity.position),
        scan_range: maxScan,
      },
      result: resultMsg,
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
            message: `${missing.length} perimeter cell${missing.length > 1 ? 's' : ''} missing in walls region (${totalPerimeter} total). Place blocks at the listed coords with mc place, then re-verify.`,
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

      // Walls verified intact AND caller provided explicit walls= bbox —
      // return a clean walls-only result. Previously we fell through to the
      // pathfinder enclosure check, which reports `enclosed: false` whenever
      // a door is operable in the perimeter. Mason 2026-05-27: spent ~30min
      // chasing `pathfinder_enclosed: false` and eventually entombed himself
      // trying to make pathfinder say "trapped". For a shelter you WANT the
      // door to be operable; usability is `mc move <inside_coord>` +
      // `mc move <outside_coord>` from the caller, not this verb.
      return {
        ok: true,
        data: {
          walls_complete: true,
          walls_region: { x1: X1, y1: Y1, z1: Z1, x2: X2, y2: Y2, z2: Z2 },
          total_perimeter_cells: totalPerimeter,
        },
        result: `Walls intact: all ${totalPerimeter} perimeter cells solid. Run mc move <inside_coord> and mc move <outside_coord> to verify ingress/egress separately.`,
      };
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
    // ─── Immediate-neighbor (6-direction) attack-reach check ───
    //
    // Names use the `neighbor_*` prefix and explicit warning text so a caller
    // does NOT confuse these cells with structural wall positions. They are
    // the bot's IMMEDIATE adjacent cells regardless of which shelter (if any)
    // the bot is inside. For a bot standing in the interior of a 5x5 shelter,
    // these cells are interior air BY DESIGN — that does NOT mean the
    // shelter's walls have gaps. Use the `walls={x1,y1,z1,x2,y2,z2}` form
    // for structural verification.
    //
    // The naming `foot_east` was renamed (g-2026-05-28-5 postmortem): Steward
    // read the original keys as wall positions, filed a [FIX] card with the
    // bot's interior-adjacent cells listed as gaps, Mason sealed himself in.
    const botFootX = Math.floor(start.x), botFootY = Math.floor(start.y), botFootZ = Math.floor(start.z);
    const neighborReport = {};
    for (const lvl of ['foot', 'head']) {
      const wy = botFootY + (lvl === 'head' ? 1 : 0);
      for (const [dx, dz, name] of [[1,0,'east'],[-1,0,'west'],[0,1,'south'],[0,-1,'north']]) {
        const blk = b.blockAt(start.offset(dx, lvl === 'head' ? 1 : 0, dz).floored());
        neighborReport[`neighbor_${lvl}_${name}`] = {
          pos: { x: botFootX + dx, y: wy, z: botFootZ + dz },
          block: blk?.name ?? 'unknown',
          solid: blk ? (blk.boundingBox === 'block') : false,
        };
      }
    }
    // Plus the roof (1 block above head).
    const roof = b.blockAt(start.offset(0, 2, 0).floored());
    neighborReport.neighbor_roof = {
      pos: { x: botFootX, y: botFootY + 2, z: botFootZ },
      block: roof?.name ?? 'unknown',
      solid: roof ? (roof.boundingBox === 'block') : false,
    };

    const openNeighbors = Object.entries(neighborReport)
      .filter(([_, v]) => !v.solid)
      .map(([k, v]) => `${k}=${v.block}@(${v.pos.x},${v.pos.y},${v.pos.z})`);

    // Final verdict combines BOTH checks. Pathfinder says no walk-path,
    // AND every immediate-neighbour cell is solid → truly safe. Either
    // failing → not enclosed.
    const enclosed = pathfinderEnclosed && openNeighbors.length === 0;

    let resultMsg;
    if (enclosed) {
      resultMsg = `SHELTERED — pathfinder found no exit within ${r} blocks AND all 9 immediate neighbor cells (4 foot, 4 head, roof) are solid. Safe to wait out the night. (For structural wall verification of a built shelter, re-run with walls={x1,y1,z1,x2,y2,z2}.)`;
    } else if (pathfinderEnclosed && openNeighbors.length > 0) {
      resultMsg = `EXPOSED at bot's adjacent cells — pathfinder found no walk-path out, BUT ${openNeighbors.length} of the bot's 9 immediate neighbor cells are not solid: ${openNeighbors.join(', ')}. Mobs can attack-reach you through these 1-block gaps. NOTE: these are the bot's neighbors, NOT shelter wall positions — for wall structure verification use walls={...}.`;
    } else {
      resultMsg = `OPEN — escape route via ${firstLeak.direction} starts at (${firstLeak.exit.x},${firstLeak.exit.y},${firstLeak.exit.z}). Mobs can use that path to reach you. Seal it before nightfall.${openNeighbors.length > 0 ? ' Adjacent neighbor cells exposed: ' + openNeighbors.join(', ') : ''}`;
    }

    return {
      ok: true,
      data: {
        enclosed,
        // Sub-signals so callers can distinguish "walk-path leak" from
        // "attack-reach leak". Useful for nuanced agent reasoning.
        pathfinder_enclosed: pathfinderEnclosed,
        all_neighbors_solid: openNeighbors.length === 0,
        bot_position: { x: Math.round(start.x * 10) / 10, y: Math.round(start.y * 10) / 10, z: Math.round(start.z * 10) / 10 },
        radius: r,
        leak: firstLeak,
        checks,
        // The bot's IMMEDIATE adjacent cells — NOT to be confused with
        // shelter wall positions. Use walls={...} form for structural checks.
        immediate_neighbors: neighborReport,
        open_neighbors: openNeighbors,
      },
      result: resultMsg,
    };
  },
  };
}
