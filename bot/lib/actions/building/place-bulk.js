import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { recordRecentPlace, equipForDig, isDigProtected } from '../../runtime/dig-tools.js';
import { markBriefRefreshRequired } from '../../runtime/nav-brief.js';
import { shouldSkipPlaceAt, shouldSkipDigAt, createRegionSkipTracker } from '../../runtime/regions/policy-guard.js';
import { fail, ok } from '../../shared/action-contract.js';
import { pathfindGotoNear, pathfindWithProgressWatchdog, ACTION_CAPS_MS } from '../_helpers.js';
import { box6, itemName, bool } from '../_args.js';
import { withYBoth, parseYInput, normalizeBoxYArgs } from '../../runtime/coordinates.js';

const { goals } = pathfinderPkg;

/**
 * @param {{ ctx: any, ensureBot: () => any, sleep: (ms: number) => Promise<void> }} deps
 */
export function createBuildingPlaceBulkPart(deps) {
  const { ctx, ensureBot, sleep, config } = deps;

  return {
    async place_fill(args) {
      // Y inputs: y1/y2 are block_y (legacy); surface_y1/surface_y2 are
      // an alternative perspective (= block_y + 1, where bots stand).
      // See docs/conventions/coordinates.md.
      const box = box6(normalizeBoxYArgs(args));
      if (!box.ok) return box.response;
      const { x1, y1, z1, x2, y2, z2 } = box;
      const blockParsed = itemName(args);
      if (!blockParsed.ok) return blockParsed.response;
      const blockName = blockParsed.name;
      const hollow = bool(args.hollow, false);
      const overwrite = bool(args.overwrite, false);
      const b = ensureBot();
      const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
      const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
      const total = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
      // Cap lowered from 500 → 32 cells (2026-05-27).
      if (total > 32) {
        return fail(
          'AREA_TOO_LARGE',
          `mc fill: ${total} blocks is too many — the per-call limit is 32. Run ${Math.ceil(total / 32)} smaller calls instead, each with ≤32 blocks (e.g. a ${Math.min(maxX - minX + 1, 4)}×${Math.min(maxY - minY + 1, 4)}×${Math.min(maxZ - minZ + 1, 2)} slice).`,
          {
            observed_state: { requested_volume: total, max_volume: 32, x1, y1, z1, x2, y2, z2 },
            next_action_hint: `Pick a sub-box with ≤32 blocks and repeat for the rest.`,
            retry_safe: false,
          },
        );
      }

      const positions = [];
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          for (let z = minZ; z <= maxZ; z++) {
            if (hollow) {
              const onEdge = x === minX || x === maxX || y === minY || y === maxY || z === minZ || z === maxZ;
              if (!onEdge) continue;
            }
            positions.push({ x, y, z });
          }
        }
      }

      // Pre-check: detect cells already occupied by something other than
      // the target block. Default `overwrite=false` returns a clear
      // FILL_BLOCKED_BY_EXISTING error so the worker knows to either
      // `mc dig_area` first OR retry with `overwrite=true`. Pre-fix
      // (2026-05-27 session): Mason's `mc fill oak_log` over a
      // site-prep cobblestone layer silently returned FILL_PARTIAL with
      // 5/5 occupied — looked like "we tried but nothing happened",
      // sent Mason into a patchwork retry loop. Clear error +
      // overwrite flag eliminate that surprise.
      const occupiedByOther = [];
      for (const pos of positions) {
        const existing = b.blockAt(new Vec3(pos.x, pos.y, pos.z));
        if (existing && existing.name !== 'air' && existing.name !== 'cave_air'
            && existing.name !== 'void_air' && existing.name !== blockName) {
          occupiedByOther.push({ x: pos.x, y: pos.y, z: pos.z, by: existing.name });
        }
      }
      if (occupiedByOther.length > 0 && !overwrite) {
        // Summarize by occupying block name so the worker can pick a
        // strategy (one big dig_area for cobble vs. several for mixed).
        const byKind = {};
        for (const c of occupiedByOther) byKind[c.by] = (byKind[c.by] || 0) + 1;
        const summary = Object.entries(byKind)
          .map(([n, c]) => `${c}× ${n}`).join(', ');
        return fail(
          'FILL_BLOCKED_BY_EXISTING',
          `mc fill ${blockName}: ${occupiedByOther.length}/${positions.length} cells already occupied by other blocks (${summary}). Pass overwrite=true to dig-then-fill, or run mc dig_area first.`,
          {
            observed_state: {
              block: blockName,
              total_cells: positions.length,
              occupied_count: occupiedByOther.length,
              occupied_by: byKind,
              first_5_blockers: occupiedByOther.slice(0, 5),
            },
            next_action_hint: `Retry as: mc fill ${blockName} ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} overwrite=true`,
            retry_safe: false,
          },
        );
      }

      // Overwrite path: dig the blocking cells before the place pass.
      // Inline-iterate to keep this primitive self-contained (avoids the
      // async-task surprise that motivated this fix). Hazard checks per
      // cell so we don't release lava/water into a fill area.
      const dugForOverwrite = [];
      const overwriteSkipped = [];
      if (overwrite && occupiedByOther.length > 0) {
        for (const c of occupiedByOther) {
          const blk = b.blockAt(new Vec3(c.x, c.y, c.z));
          if (!blk) continue;
          if (shouldSkipDigAt(ctx, config, blk.name, c.x, c.y, c.z, isDigProtected).skip) {
            overwriteSkipped.push({ x: c.x, y: c.y, z: c.z, reason: 'region_or_global_protect' });
            continue;
          }
          try {
            if (b.entity.position.distanceTo(blk.position) > 4.5) {
              try { await pathfindGotoNear(b, goals, c.x, c.y, c.z, 3, { opName: 'fill_overwrite', capMs: ACTION_CAPS_MS.reach }); } catch {}
            }
            await equipForDig(b, blk);
            await b.dig(blk);
            dugForOverwrite.push({ x: c.x, y: c.y, z: c.z, was: c.by });
          } catch (e) {
            overwriteSkipped.push({ x: c.x, y: c.y, z: c.z, reason: e?.message || String(e) });
          }
        }
      }

      // F60+F62: cluster cells by reach-from-a-safe-standpoint. The bot
      // walks to a standpoint (a safe cell OUTSIDE the fill region),
      // places every cell reachable from there, then walks to the next
      // standpoint. This is both more realistic-looking (visible bursts
      // separated by short walks instead of one motionless 26-block dump)
      // AND fixes the F55.2 self-blocking case at the source — by
      // construction the bot is never standing inside the region. We also
      // pace placements with a small inter-cell delay so the server has
      // time to confirm each placeBlock packet (mineflayer otherwise
      // times out waiting for blockUpdate on long bursts).
      const STANDPOINT_REACH = 4.0;        // mineflayer placeBlock reach limit ≈ 4.5
      const INTER_PLACE_DELAY_MS = 180;
      const inFillRegion = (x, y, z) =>
        x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ;
      const airy = (blk) => blk && (blk.name === 'air' || blk.name === 'cave_air');
      const solid = (blk) => blk && blk.boundingBox === 'block';
      const isStandpoint = (sx, sy, sz) => {
        // Bot occupies feet (sx, sy) and head (sx, sy+1). Neither may be in
        // the fill region (would block placement of own foot/head cell).
        if (inFillRegion(sx, sy, sz) || inFillRegion(sx, sy + 1, sz)) return false;
        const feet = b.blockAt(new Vec3(sx, sy, sz));
        const head = b.blockAt(new Vec3(sx, sy + 1, sz));
        const below = b.blockAt(new Vec3(sx, sy - 1, sz));
        return airy(feet) && airy(head) && solid(below);
      };
      const findStandpointFor = (cell) => {
        // Spiral search around the target cell at multiple y offsets.
        for (let r = 1; r <= 4; r++) {
          for (const dy of [0, -1, 1, -2]) {
            for (let dx = -r; dx <= r; dx++) {
              for (let dz = -r; dz <= r; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;  // ring at radius r
                const sx = cell.x + dx, sy = cell.y + dy, sz = cell.z + dz;
                if (!isStandpoint(sx, sy, sz)) continue;
                const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (d <= STANDPOINT_REACH) return [sx, sy, sz];
              }
            }
          }
        }
        return null;
      };

      // Greedy cluster assignment: each remaining cell seeds a new cluster
      // with its standpoint; all remaining cells within reach get assigned
      // to it. Same standpoint serves multiple cells, so we visibly walk
      // O(positions / cluster_size) times instead of pathfinding per cell.
      const cellKey = (p) => `${p.x},${p.y},${p.z}`;
      const assigned = new Set();
      const clusters = [];  // [{ standpoint: [x,y,z]|null, cells: [pos] }]
      for (const seed of positions) {
        if (assigned.has(cellKey(seed))) continue;
        const sp = findStandpointFor(seed);
        const cluster = { standpoint: sp, cells: [] };
        if (!sp) {
          // No reachable standpoint — keep the seed alone; per-cell loop
          // will pathfind closest-fit and rely on F55.2 detection if it
          // ends up self-blocking.
          cluster.cells.push(seed);
          assigned.add(cellKey(seed));
        } else {
          for (const p of positions) {
            if (assigned.has(cellKey(p))) continue;
            const d = Math.sqrt(
              (sp[0] - p.x) * (sp[0] - p.x) +
              (sp[1] - p.y) * (sp[1] - p.y) +
              (sp[2] - p.z) * (sp[2] - p.z)
            );
            if (d <= STANDPOINT_REACH + 0.5) {
              cluster.cells.push(p);
              assigned.add(cellKey(p));
            }
          }
        }
        clusters.push(cluster);
      }
      let autoDisplaced = null;

      // F53.1: track structured fill outcomes instead of silently swallowing.
      // - placed_count = blocks newly placed
      // - skipped_already_blockname = cell already had the desired block (idempotent)
      // - skipped_occupied = cell had a different non-air block; the brain
      //   needs to know about this so it doesn't think the fill is done.
      //   For each skipped cell we record the blocker's name so the brain
      //   can recognize "ah, a crafting_table is in the way".
      // - place_failures = cells we tried to place but b.placeBlock threw
      //   (typically LOS or face-availability problems).
      const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
      let placed = 0;
      let skipped_already = 0;
      const skipped_occupied = [];  // [{x,y,z,by:blockname}]
      const place_failures = [];    // [{x,y,z,reason}]
      const occupied_by_counts = {}; // {block_name: count}
      const regionSkips = createRegionSkipTracker();
      for (const cluster of clusters) {
        // Walk to the cluster's standpoint (skip if at one already).
        if (cluster.standpoint) {
          const [sx, sy, sz] = cluster.standpoint;
          const cur = b.entity.position;
          const d = Math.sqrt((cur.x - sx) ** 2 + (cur.y - sy) ** 2 + (cur.z - sz) ** 2);
          if (d > 1.5) {
            try {
              await pathfindWithProgressWatchdog({
                bot: b,
                pathfinderGoto: () => b.pathfinder.goto(new goals.GoalBlock(sx, sy, sz)),
                opName: 'place_fill_stand',
                capMs: ACTION_CAPS_MS.reach,
                onStall: () => { try { b.pathfinder.setGoal(null); } catch {} },
              });
              if (!autoDisplaced) {
                autoDisplaced = { from: { x: Math.floor(cur.x), y: Math.floor(cur.y), z: Math.floor(cur.z) }, to: { x: sx, y: sy, z: sz } };
              }
            } catch {}
          }
        }
        for (const pos of cluster.cells) {
          const skipPl = shouldSkipPlaceAt(ctx, config, blockName, pos.x, pos.y, pos.z);
          if (skipPl.skip) {
            regionSkips.noteSkip(skipPl.regionId);
            continue;
          }
          const existing = b.blockAt(new Vec3(pos.x, pos.y, pos.z));
          if (existing && existing.name !== 'air' && existing.name !== 'cave_air') {
            if (existing.name === blockName) {
              skipped_already++;
            } else {
              skipped_occupied.push({ x: pos.x, y: pos.y, z: pos.z, by: existing.name });
              occupied_by_counts[existing.name] = (occupied_by_counts[existing.name] || 0) + 1;
            }
            continue;
          }

          const item = b.inventory.items().find(i => i.name === blockName);
          if (!item) {
            return fail(
              'OUT_OF_STOCK',
              `Out of ${blockName} (placed ${placed}/${positions.length})`,
              {
                observed_state: { block: blockName, placed, requested: positions.length },
                retry_safe: false,
              },
            );
          }
          await b.equip(item, 'hand');

          // Fallback per-cell pathfind only if no standpoint was found for this cluster.
          if (!cluster.standpoint && b.entity.position.distanceTo(new Vec3(pos.x, pos.y, pos.z)) > 4.5) {
            try { await pathfindGotoNear(b, goals, pos.x, pos.y, pos.z, 3, { opName: 'place_fill', capMs: ACTION_CAPS_MS.reach }); } catch {}
          }

          let placedThis = false;
          let lastErr = null;
          for (const [dx, dy, dz] of offsets) {
            const ref = b.blockAt(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz));
            if (ref && ref.name !== 'air' && ref.name !== 'cave_air') {
              try {
                await b.placeBlock(ref, new Vec3(-dx, -dy, -dz));
                recordRecentPlace(ctx, pos, blockName);
                markBriefRefreshRequired(ctx, { cells: [{ x: pos.x, y: pos.y, z: pos.z }] });
                placed++;
                placedThis = true;
              } catch (e) {
                lastErr = e?.message || String(e);
              }
              break;
            }
          }
          if (!placedThis) {
            place_failures.push({ x: pos.x, y: pos.y, z: pos.z, reason: lastErr || 'no_adjacent_face' });
          }
          // Small delay between placements — looks more natural AND gives
          // the server time to confirm blockUpdate before the next packet.
          await sleep(INTER_PLACE_DELAY_MS);
        }
      }

      const skipped_total = skipped_occupied.length + place_failures.length;
      // F55.2: detect when the bot was standing inside the fill region
      // (their foot/head cells block placement, mineflayer fails silently).
      // Tag the offending place_failures and surface a top-level flag so
      // the brain can't misread "FILL_PARTIAL because of me" as "complete".
      const botFootX = Math.floor(b.entity.position.x);
      const botFootY = Math.floor(b.entity.position.y);
      const botFootZ = Math.floor(b.entity.position.z);
      const botBlockedCells = [];
      for (const f of place_failures) {
        if (f.x === botFootX && f.z === botFootZ && (f.y === botFootY || f.y === botFootY + 1)) {
          f.reason = 'bot_self_blocking';
          botBlockedCells.push({ x: f.x, y: f.y, z: f.z });
        }
      }
      const botWasInsideRegion = botBlockedCells.length > 0;

      // Result message: if anything was skipped or failed, surface it loudly.
      // Brain should not mistake a 15/16 fill for a 16/16 success.
      const occupied_summary = Object.entries(occupied_by_counts)
        .sort((a, c) => c[1] - a[1])
        .slice(0, 3)
        .map(([name, n]) => `${n}× ${name}`)
        .join(', ');
      let resultMsg;
      if (skipped_total === 0) {
        resultMsg = `Placed ${placed}/${positions.length} ${blockName} blocks (${hollow ? 'hollow' : 'solid'})`;
      } else {
        const parts = [`Placed ${placed}/${positions.length} ${blockName}`];
        if (skipped_already > 0) parts.push(`${skipped_already} already-correct`);
        if (skipped_occupied.length > 0) parts.push(`${skipped_occupied.length} occupied (${occupied_summary})`);
        if (place_failures.length > 0) parts.push(`${place_failures.length} placement-failed`);
        const selfNote = botWasInsideRegion
          ? ` — YOU were standing inside the region (${botBlockedCells.length} cell${botBlockedCells.length > 1 ? 's' : ''} blocked by your body). Move outside the region and re-run mc fill to complete it.`
          : '';
        resultMsg = `FILL_PARTIAL: ${parts.join('; ')}.${selfNote} Check observed_state.skipped_occupied to see what's blocking.`;
      }
      resultMsg += regionSkips.suffix();

      const bounds = {
        x1: minX, x2: maxX,
        z1: minZ, z2: maxZ,
        block_y1: minY, block_y2: maxY,
        surface_y1: minY + 1, surface_y2: maxY + 1,
        y1: minY, y2: maxY,
      };
      const sharedData = {
        placed,
        skipped_already,
        skipped_occupied,
        place_failures,
        occupied_by_counts,
        total: positions.length,
        bounds,
        ...regionSkips.dataFields(),
        ...(autoDisplaced ? { auto_displaced: autoDisplaced } : {}),
        ...(dugForOverwrite.length || overwriteSkipped.length ? {
          overwrite_summary: {
            dug: dugForOverwrite.length,
            dug_cells: dugForOverwrite.slice(0, 10),
            skipped: overwriteSkipped.length,
            skipped_cells: overwriteSkipped.slice(0, 5),
          },
        } : {}),
      };

      if (skipped_total === 0) {
        return ok({
          result: resultMsg,
          data: { ...sharedData, partial: false },
        });
      }

      const remaining_cells = [
        ...skipped_occupied.map((c) => ({ x: c.x, y: c.y, z: c.z, kind: 'occupied', by: c.by })),
        ...place_failures.map((c) => ({ x: c.x, y: c.y, z: c.z, kind: 'place_failed', reason: c.reason })),
      ].slice(0, 32);
      const fillHint = botWasInsideRegion
        ? `mc goto_near ${minX} ${minY} ${minZ} range=3 (step outside box), then mc fill ${blockName} ${x1} ${y1} ${z1} ${x2} ${y2} ${z2}`
        : (skipped_occupied.length > 0 && !overwrite)
          ? `mc dig_area or mc fill … overwrite=true for blockers, then re-run same fill box`
          : `Re-run mc fill ${blockName} ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} for remaining cells (no inspect grid needed)`;

      return fail('FILL_PARTIAL', resultMsg, {
        observed_state: {
          ...sharedData,
          partial: true,
          remaining_count: skipped_total,
          remaining_cells,
          ...(botWasInsideRegion ? {
            bot_was_inside_region: true,
            bot_blocked_cells: botBlockedCells,
          } : {}),
        },
        next_action_hint: fillHint,
        retry_safe: true,
      });
    },

    /**
     * Build a wall: vertical line/rectangle of blocks. Sugar over place_fill
     * with action-contract shape and a "must have height" guard so a flat
     * single-Y rectangle (= floor) gets a clear error instead of silently
     * placing a slab. See docs/design/phase-2/sprints.md (Sprint 5 — Building primitives).
     * — Phase-2 action contract (see docs/design/phase-2/action-contracts.md mc wall) —
     */
    async wall(args) {
      const normalized = normalizeBoxYArgs(args);
      const { block: blockName, x1, y1, z1, x2, y2, z2 } = normalized;
      const b = ensureBot();

      if (!blockName || typeof blockName !== 'string') {
        return {
          ok: false,
          error: {
            code: 'MISSING_BLOCK_TYPE',
            message: 'mc wall requires a block name (e.g. cobblestone, oak_planks)',
            observed_state: { received: blockName },
            retry_safe: false,
          },
        };
      }

      const coords = ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'];
      const boxArgs = { x1, y1, z1, x2, y2, z2 };
      for (const k of coords) {
        const n = Number(boxArgs[k]);
        if (!Number.isFinite(n)) {
          return {
            ok: false,
            error: {
              code: 'INVALID_COORD',
              message: `mc wall requires numeric ${k}, got ${boxArgs[k]}`,
              observed_state: { received: boxArgs },
              retry_safe: false,
            },
          };
        }
        boxArgs[k] = n;
      }

      const minX = Math.min(boxArgs.x1, boxArgs.x2);
      const maxX = Math.max(boxArgs.x1, boxArgs.x2);
      const minY = Math.min(boxArgs.y1, boxArgs.y2);
      const maxY = Math.max(boxArgs.y1, boxArgs.y2);
      const minZ = Math.min(boxArgs.z1, boxArgs.z2);
      const maxZ = Math.max(boxArgs.z1, boxArgs.z2);

      if (minY === maxY) {
        return {
          ok: false,
          error: {
            code: 'NOT_A_WALL',
            message: `y1=y2=${minY}: walls need vertical height. Use mc fill for a flat slab.`,
            observed_state: { y1: boxArgs.y1, y2: boxArgs.y2 },
            retry_safe: false,
          },
        };
      }

      const total = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
      if (total > 200) {
        return {
          ok: false,
          error: {
            code: 'OUT_OF_RANGE',
            message: `Wall too large (${total} blocks, max 200). Split into smaller walls.`,
            observed_state: { total, max: 200 },
            retry_safe: false,
          },
        };
      }

      const positions = [];
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          for (let z = minZ; z <= maxZ; z++) {
            positions.push({ x, y, z });
          }
        }
      }

      const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
      let placed = 0;
      let skipped_existing = 0;
      let failed = 0;
      const regionSkips = createRegionSkipTracker();

      for (const pos of positions) {
        const skipPl = shouldSkipPlaceAt(ctx, config, blockName, pos.x, pos.y, pos.z);
        if (skipPl.skip) {
          regionSkips.noteSkip(skipPl.regionId);
          continue;
        }
        const existing = b.blockAt(new Vec3(pos.x, pos.y, pos.z));
        if (existing && existing.name !== 'air' && existing.name !== 'cave_air') {
          skipped_existing++;
          continue;
        }

        const item = b.inventory.items().find((i) => i.name === blockName);
        if (!item) {
          return {
            ok: false,
            error: {
              code: 'MISSING_INVENTORY',
              message: `Out of ${blockName} after placing ${placed}/${positions.length}`,
              observed_state: { blocks_placed: placed, blocks_remaining: positions.length - placed - skipped_existing, block: blockName },
              retry_safe: true,
            },
          };
        }
        try { await b.equip(item, 'hand'); } catch {}

        if (b.entity.position.distanceTo(new Vec3(pos.x, pos.y, pos.z)) > 4.5) {
          try { await pathfindGotoNear(b, goals, pos.x, pos.y, pos.z, 3, { opName: 'place_fill', capMs: ACTION_CAPS_MS.reach }); } catch {}
        }

        let success = false;
        for (const [dx, dy, dz] of offsets) {
          const ref = b.blockAt(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz));
          if (ref && ref.name !== 'air' && ref.name !== 'cave_air') {
            try {
              await b.placeBlock(ref, new Vec3(-dx, -dy, -dz));
              recordRecentPlace(ctx, pos, blockName);
              placed++;
              success = true;
            } catch {}
            break;
          }
        }
        if (!success) failed++;
      }

      return {
        ok: true,
        data: {
          blocks_placed: placed,
          blocks_attempted: positions.length,
          skipped_existing,
          failed,
          bounds: {
            x1: minX, x2: maxX,
            z1: minZ, z2: maxZ,
            block_y1: minY, block_y2: maxY,
            surface_y1: minY + 1, surface_y2: maxY + 1,
            y1: minY, y2: maxY,  // legacy
          },
          block: blockName,
          ...regionSkips.dataFields(),
        },
        result: `Wall: ${placed}/${positions.length} ${blockName} placed${skipped_existing ? ` (${skipped_existing} skipped — existing block)` : ''}${failed ? ` (${failed} failed)` : ''}${regionSkips.suffix()}`,
      };
    },

    /**
     * Build a fence enclosure: rectangle perimeter at current Y. Optional
     * --gate DIR places a matching fence_gate at the midpoint of the named
     * side (north|south|east|west), inferring gate type from fence type
     * (e.g. oak_fence → oak_fence_gate).
     * — Phase-2 action contract (see docs/design/phase-2/action-contracts.md mc fence) —
     */
    async fence({ block: blockName, x1, z1, x2, z2, gate, y, surface_y }) {
      const b = ensureBot();

      if (!blockName || typeof blockName !== 'string') {
        return { ok: false, error: { code: 'MISSING_FENCE_BLOCK', message: 'mc fence requires a fence block (e.g. oak_fence)', retry_safe: false } };
      }
      if (!blockName.endsWith('_fence')) {
        return { ok: false, error: { code: 'NOT_A_FENCE', message: `Block "${blockName}" is not a fence type (must end in _fence)`, retry_safe: false } };
      }

      const args = { x1, z1, x2, z2 };
      for (const k of ['x1', 'z1', 'x2', 'z2']) {
        const n = Number(args[k]);
        if (!Number.isFinite(n)) {
          return { ok: false, error: { code: 'INVALID_COORD', message: `mc fence requires numeric ${k}`, retry_safe: false } };
        }
        args[k] = n;
      }

      const minX = Math.min(args.x1, args.x2);
      const maxX = Math.max(args.x1, args.x2);
      const minZ = Math.min(args.z1, args.z2);
      const maxZ = Math.max(args.z1, args.z2);
      const w = maxX - minX + 1;
      const l = maxZ - minZ + 1;

      if (w < 3 || l < 3) {
        return { ok: false, error: { code: 'ENCLOSURE_TOO_SMALL', message: `Enclosure ${w}×${l} too small (min 3×3 to have an interior)`, retry_safe: false } };
      }

      // Y input: y (= block_y of the fence post, legacy) or surface_y
      // (= one above where the fence top stands). Default to bot's current
      // block_y (foot Y), where a fence will sit at body height.
      const parsedFenceY = parseYInput({ y, surface_y });
      const fenceY = parsedFenceY !== null ? parsedFenceY : Math.floor(b.entity.position.y);

      // Compute perimeter positions (top + bottom rows + left + right columns, no duplicates).
      const positions = [];
      for (let x = minX; x <= maxX; x++) {
        positions.push({ x, y: fenceY, z: minZ }); // north edge
        positions.push({ x, y: fenceY, z: maxZ }); // south edge
      }
      for (let z = minZ + 1; z <= maxZ - 1; z++) {
        positions.push({ x: minX, y: fenceY, z }); // west edge
        positions.push({ x: maxX, y: fenceY, z }); // east edge
      }

      // Gate: midpoint of the requested side. Replaces one fence with a gate.
      let gatePos = null;
      let gateType = null;
      let gateFacing = null;
      if (gate) {
        const dir = String(gate).toLowerCase();
        if (!['north', 'south', 'east', 'west'].includes(dir)) {
          return { ok: false, error: { code: 'INVALID_GATE_DIR', message: `gate must be north|south|east|west, got "${gate}"`, retry_safe: false } };
        }
        const midX = Math.floor((minX + maxX) / 2);
        const midZ = Math.floor((minZ + maxZ) / 2);
        switch (dir) {
          case 'north': gatePos = { x: midX, y: fenceY, z: minZ }; gateFacing = 'south'; break;
          case 'south': gatePos = { x: midX, y: fenceY, z: maxZ }; gateFacing = 'north'; break;
          case 'west':  gatePos = { x: minX, y: fenceY, z: midZ }; gateFacing = 'east';  break;
          case 'east':  gatePos = { x: maxX, y: fenceY, z: midZ }; gateFacing = 'west';  break;
        }
        gateType = blockName.replace(/_fence$/, '_fence_gate');
      }

      // Filter perimeter to remove the gate position (we'll place the gate separately).
      const fencePositions = gatePos
        ? positions.filter((p) => !(p.x === gatePos.x && p.z === gatePos.z))
        : positions;

      const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
      let placed = 0;
      let skipped = 0;
      let failed = 0;
      const regionSkips = createRegionSkipTracker();

      async function placeOne(pos, itemName) {
        const skipPl = shouldSkipPlaceAt(ctx, config, itemName, pos.x, pos.y, pos.z);
        if (skipPl.skip) {
          regionSkips.noteSkip(skipPl.regionId);
          return 'region_skipped';
        }
        const existing = b.blockAt(new Vec3(pos.x, pos.y, pos.z));
        if (existing && existing.name !== 'air' && existing.name !== 'cave_air') return 'skipped';
        const item = b.inventory.items().find((i) => i.name === itemName);
        if (!item) return 'no_item';
        try { await b.equip(item, 'hand'); } catch {}
        if (b.entity.position.distanceTo(new Vec3(pos.x, pos.y, pos.z)) > 4.5) {
          try { await pathfindGotoNear(b, goals, pos.x, pos.y, pos.z, 3, { opName: 'place_fill', capMs: ACTION_CAPS_MS.reach }); } catch {}
        }
        for (const [dx, dy, dz] of offsets) {
          const ref = b.blockAt(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz));
          if (ref && ref.name !== 'air' && ref.name !== 'cave_air') {
            try {
              await b.placeBlock(ref, new Vec3(-dx, -dy, -dz));
              recordRecentPlace(ctx, pos, itemName);
              return 'placed';
            } catch {}
            break;
          }
        }
        return 'failed';
      }

      for (const pos of fencePositions) {
        const r = await placeOne(pos, blockName);
        if (r === 'placed') placed++;
        else if (r === 'skipped' || r === 'region_skipped') skipped++;
        else if (r === 'no_item') {
          return {
            ok: false,
            error: {
              code: 'MISSING_INVENTORY',
              message: `Out of ${blockName} after placing ${placed}/${fencePositions.length}`,
              observed_state: { fences_placed: placed, fences_remaining: fencePositions.length - placed - skipped, block: blockName },
              retry_safe: true,
            },
          };
        } else failed++;
      }

      let gatePlaced = false;
      if (gatePos) {
        const r = await placeOne(gatePos, gateType);
        if (r === 'placed') gatePlaced = true;
        else if (r === 'no_item') {
          // Gate item missing — fence is still valid, just no gate. Return partial success.
          return {
            ok: true,
            data: {
              fences_placed: placed,
              fences_attempted: fencePositions.length,
              skipped_existing: skipped,
              failed,
              gate_placed: false,
              gate_skipped_reason: `no ${gateType} in inventory`,
              bounds: withYBoth({ x1: minX, z1: minZ, x2: maxX, z2: maxZ, y: fenceY }, fenceY),
              block: blockName,
            },
            result: `Fence: ${placed}/${fencePositions.length} ${blockName} placed; gate skipped (no ${gateType})`,
          };
        }
      }

      return {
        ok: true,
        data: {
          fences_placed: placed,
          fences_attempted: fencePositions.length,
          skipped_existing: skipped,
          failed,
          gate_placed: gatePlaced,
          gate_position: gatePos,
          gate_facing: gateFacing,
          gate_type: gateType,
          bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ, y: fenceY },
          block: blockName,
          ...regionSkips.dataFields(),
        },
        result: `Fence: ${placed}/${fencePositions.length} ${blockName} placed${gatePlaced ? `, gate placed (${gateType}) on ${gate} side` : ''}${skipped ? ` (${skipped} skipped)` : ''}${failed ? ` (${failed} failed)` : ''}${regionSkips.suffix()}`,
      };
    },
  };
}
