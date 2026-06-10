import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { isStructural, tierOf } from '../../runtime/materials.js';
import { recordRecentPlace, equipForDig } from '../../runtime/dig-tools.js';
import { withYBoth, surfaceFromBlock } from '../../runtime/coordinates.js';
import { shouldSkipPlaceAt } from '../../runtime/regions/policy-guard.js';
import { pathfindGotoNear, ACTION_CAPS_MS, timeoutError } from '../_helpers.js';

const { goals } = pathfinderPkg;

// Suffix-based detection — multi-word species like dark_oak, pale_oak,
// and the nether-stem variants don't match a simple [a-z]+_log pattern.
const LOG_SUFFIXES = ['_log', '_wood', '_stem', '_hyphae'];
const LEAF_SUFFIXES = ['_leaves', '_wart_block'];
function endsWithAny(name, list) {
  for (const sfx of list) if (name.endsWith(sfx)) return true;
  return false;
}
function isLogBlock(name) {
  return typeof name === 'string' && endsWithAny(name, LOG_SUFFIXES);
}
function isLeafBlock(name) {
  return typeof name === 'string' && endsWithAny(name, LEAF_SUFFIXES);
}
function speciesOf(name) {
  if (!isLogBlock(name) && !isLeafBlock(name)) return null;
  let n = name;
  if (n.startsWith('stripped_')) n = n.slice('stripped_'.length);
  for (const sfx of [...LOG_SUFFIXES, ...LEAF_SUFFIXES]) {
    if (n.endsWith(sfx)) return n.slice(0, -sfx.length);
  }
  return null;
}

/**
 * Walk upward from each log in `logs` to find connected logs above the
 * input set. Used by clear_strip to extend its dig list with trunk parts
 * sitting ABOVE the clear rectangle (e.g. a 4-tall clear_strip with
 * height=4 only touches the lowest 4 trunk blocks; the top of a spruce
 * trunk + canopy sit above and would normally be left floating).
 *
 * Returns a NEW array containing the input logs plus any newly-discovered
 * connected logs above them. Max 16 extra blocks per starting log to
 * bound the worst-case tall-tree walk.
 */
function expandLogsUpward(b, logs, maxExtraHeight = 16) {
  const seen = new Set(logs.map((l) => `${l.x},${l.y},${l.z}`));
  const out = [...logs];
  for (const start of logs) {
    let y = start.y;
    for (let i = 0; i < maxExtraHeight; i++) {
      y += 1;
      const k = `${start.x},${y},${start.z}`;
      if (seen.has(k)) break;
      const above = b.blockAt(new Vec3(start.x, y, start.z));
      if (!above || !isLogBlock(above.name)) break;
      seen.add(k);
      out.push({ x: start.x, y, z: start.z, name: above.name });
    }
  }
  return out;
}

/**
 * BFS connected leaves attached to a log set via 6-face neighbors, gated
 * by Chebyshev distance from any log XZ. Pure read — does NOT dig.
 *
 * Extracted from fell_tree's Phase 3 (which previously inlined the same
 * logic). Both fell_tree and clear_strip-with-road_mode now share this
 * helper.
 */
function collectConnectedLeaves(b, logs, radius, cap) {
  const leaves = [];
  if (radius <= 0 || logs.length === 0) return leaves;
  const seen = new Set();
  const queue = [];
  const OFFS = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
  for (const log of logs) {
    for (const [dx, dy, dz] of OFFS) {
      const lx = log.x + dx, ly = log.y + dy, lz = log.z + dz;
      const k = `${lx},${ly},${lz}`;
      if (seen.has(k)) continue;
      const blk = b.blockAt(new Vec3(lx, ly, lz));
      if (blk && isLeafBlock(blk.name)) {
        seen.add(k);
        queue.push({ x: lx, y: ly, z: lz, name: blk.name });
      }
    }
  }
  while (queue.length && leaves.length < cap) {
    const cur = queue.shift();
    const inRadius = logs.some((lg) =>
      Math.max(Math.abs(cur.x - lg.x), Math.abs(cur.z - lg.z)) <= radius,
    );
    if (!inRadius) continue;
    leaves.push(cur);
    for (const [dx, dy, dz] of OFFS) {
      const nk = `${cur.x + dx},${cur.y + dy},${cur.z + dz}`;
      if (seen.has(nk)) continue;
      seen.add(nk);
      const blk = b.blockAt(new Vec3(cur.x + dx, cur.y + dy, cur.z + dz));
      if (blk && isLeafBlock(blk.name)) {
        queue.push({ x: cur.x + dx, y: cur.y + dy, z: cur.z + dz, name: blk.name });
      }
    }
  }
  return leaves;
}

/**
 * Road-building primitives. Composes lower-level dig / excavation verbs to
 * present road-tier semantics (corridor clearing, tree felling, bridge
 * decking) so the planner can emit one literal verb per intent instead of
 * hand-choreographing tens of low-level calls.
 *
 * @param {{
 *   ctx: any,
 *   config?: any,
 *   ensureBot: () => any,
 *   getActions: () => any,
 * }} deps
 */
export function createBuildingRoadPart(deps) {
  const { ctx, config, ensureBot, getActions } = deps;
  // Wallclock caps — injectable for tests (deps.capsMs), default shared caps.
  const capsMs = deps.capsMs || ACTION_CAPS_MS;

  function parseFlag(v) {
    return v === true || v === 'true' || v === '1' || v === 1;
  }

  function isAirLike(name) {
    return name === 'air' || name === 'cave_air' || name === 'void_air';
  }

  return {
    /**
     * Clear an axis-aligned corridor strip above a road bed.
     *
     * Surveys every cell in [x1..x2] × [y+1..y+height] × [z1..z2] and
     * removes any non-air block in that volume. The road-bed block (at y)
     * and everything below it are never touched. Auto-batches the work into
     * ≤32-cell dig_area calls so the caller is not exposed to the per-call
     * cap.
     *
     * Y MIGRATION (phase 1): `surface_y` is REJECTED with INVALID_COORD —
     * its historical meaning here ("ground block Y") clashed with the
     * canonical vocabulary (surface_y = feet = block_y + 1, see
     * docs/reference/world-coordinates.md). Pass `y` (= block_y of the road
     * bed) instead; phase 2 reintroduces `surface_y` as true feet via
     * parseYInput.
     *
     * Args:
     *   x1, z1, x2, z2  — rectangle bounds (inclusive)
     *   y               — block_y of the road bed. Volume cleared is the H
     *                     cells ABOVE this block (y+1 .. y+H — the feet +
     *                     head cells of a bot walking on the bed).
     *   height          — H, the headroom to clear. Default 4 (walkable).
     *                     Use 8 to fully clear small trees / pillar tops.
     *   road_mode       — true: dig wood (oak_log, planks, fences, stairs…)
     *                     and other tier_3 "structural" blocks anyway.
     *                     Region-deny is still honored.
     *   dry_run         — true: survey only, don't dig. Returns the same
     *                     accounting (would_dig, removed_by_block, skipped_*).
     *   max_cells       — soft cap on total volume (w × l × H). Default 1024.
     *
     * Returns:
     *   { ok: true, data: { dug, skipped, errors, batches, columns_n,
     *       cells_total, would_dig, removed_by_block, skipped_tier4,
     *       skipped_structural, bounds, block_y, surface_y, height,
     *       road_mode, mode } }
     *   block_y/surface_y are the canonical pair for the road bed
     *   (surface_y = block_y + 1 = where a bot stands on the bed).
     *
     * Skip semantics:
     *   - tier_4 (diamond_block, beacon, dragon_egg…) is ALWAYS skipped.
     *   - tier_3 / structural (wood, fences, doors…) is skipped UNLESS
     *     road_mode=true, then it's diggable.
     *   - air / cave_air / void_air are no-ops in the survey.
     *   - bedrock is skipped at the dig_area layer.
     */
    async clear_strip({
      x1, z1, x2, z2,
      y,
      surface_y,
      height,
      road_mode,
      dry_run,
      max_cells,
    }) {
      const b = ensureBot();
      if (surface_y !== undefined && surface_y !== null) {
        return {
          ok: false,
          error: {
            code: 'INVALID_COORD',
            message: `mc clear_strip: surface_y is temporarily rejected — its meaning here is migrating from "ground block Y" to the canonical feet Y (= block_y + 1). Pass y=<block_y of the road bed> instead (terrain_top block_y / corridor_sample elevation_median).`,
            next_action_hint: 'Re-issue with y=<ground block Y>; surface_y returns next release meaning feet.',
            retry_safe: false,
          },
        };
      }
      for (const [k, v] of Object.entries({ x1, z1, x2, z2, y })) {
        if (!Number.isFinite(Number(v))) {
          return {
            ok: false,
            error: {
              code: 'INVALID_COORD',
              message: `mc clear_strip requires numeric ${k}`,
              retry_safe: false,
            },
          };
        }
      }
      const minX = Math.min(Number(x1), Number(x2));
      const maxX = Math.max(Number(x1), Number(x2));
      const minZ = Math.min(Number(z1), Number(z2));
      const maxZ = Math.max(Number(z1), Number(z2));
      const sy = Math.floor(Number(y)); // block_y of the road bed
      const H = Math.max(1, Math.min(parseInt(String(height ?? 4), 10) || 4, 16));
      const cap = Math.max(32, Math.min(parseInt(String(max_cells ?? 1024), 10) || 1024, 4096));
      const isRoad = parseFlag(road_mode);
      const isDry = parseFlag(dry_run);
      const w = maxX - minX + 1;
      const l = maxZ - minZ + 1;
      const total = w * l * H;
      if (total > cap) {
        return {
          ok: false,
          error: {
            code: 'OUT_OF_RANGE',
            message: `mc clear_strip: ${w}×${l}×${H} = ${total} cells exceeds the per-call cap of ${cap}. Split into smaller rectangles.`,
            observed_state: { requested_volume: total, max_volume: cap, bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ } },
            next_action_hint: `Halve the longer axis or reduce height; aim for ≤${cap} cells per call.`,
            retry_safe: false,
          },
        };
      }

      const y1 = surfaceFromBlock(sy); // first cleared cell = feet cell on the bed
      const y2 = sy + H;

      // Phase 1 — survey every cell in the volume. We do this whether dry-run
      // or live; the survey produces the accounting that the caller needs
      // (which blocks are about to disappear) and lets us short-circuit the
      // dig phase when there's nothing to do.
      const removedByBlock = {};
      let wouldDig = 0;
      let skippedTier4 = 0;
      let skippedStructural = 0;
      let presentNonAir = 0;
      // Track logs touched in road_mode so we can extend the dig to the
      // canopy above the rectangle (W2-NAV-015 follow-up: foliage
      // persisted after clear_strip removed in-rect logs but left the
      // upper trunk + crown floating). Highest log per xz column wins
      // (the seed for expandLogsUpward).
      const touchedLogTops = new Map(); // key='x,z' → {x, y, z, name}
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          for (let y = y1; y <= y2; y++) {
            const blk = b.blockAt(new Vec3(x, y, z));
            if (!blk) continue;
            const name = blk.name;
            if (name === 'air' || name === 'cave_air' || name === 'void_air') continue;
            presentNonAir++;
            const tier = tierOf(name);
            if (tier === 4) { skippedTier4++; continue; }
            if (!isRoad && isStructural(name)) { skippedStructural++; continue; }
            wouldDig++;
            removedByBlock[name] = (removedByBlock[name] || 0) + 1;
            if (isRoad && isLogBlock(name)) {
              const k = `${x},${z}`;
              const prev = touchedLogTops.get(k);
              if (!prev || y > prev.y) {
                touchedLogTops.set(k, { x, y, z, name });
              }
            }
          }
        }
      }

      const baseData = {
        columns_n: w * l,
        cells_total: total,
        present_non_air: presentNonAir,
        would_dig: wouldDig,
        removed_by_block: removedByBlock,
        skipped_tier4: skippedTier4,
        skipped_structural: skippedStructural,
        bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ, y1, y2 },
        ...withYBoth({}, sy),
        height: H,
        road_mode: isRoad,
      };

      if (isDry) {
        return {
          ok: true,
          data: { ...baseData, mode: 'dry_run' },
          result: `clear_strip ${w}×${l}×${H} y=${sy} dry_run: would dig ${wouldDig}/${presentNonAir} cells${skippedTier4 ? `, ${skippedTier4} tier_4 protected` : ''}${skippedStructural ? `, ${skippedStructural} structural preserved (pass road_mode=true to cut wood)` : ''}`,
        };
      }

      if (wouldDig === 0) {
        // Counters defaulted to 0 so the response shape is stable across
        // the "already clear" early-return and the live execute path.
        return {
          ok: true,
          data: {
            ...baseData,
            mode: 'live',
            dug: 0, skipped: presentNonAir, errors: 0, batches: 0,
            wood_blocks_removed: 0, leaf_blocks_removed: 0,
          },
          result: `clear_strip ${w}×${l}×${H} y=${sy}: already clear (${presentNonAir} cells skipped${skippedStructural ? `, ${skippedStructural} structural preserved` : ''})`,
        };
      }

      // Phase 2 — execute. Batch dig_area calls under the 32-cell cap.
      //
      // Two issues from the 2026-06-09 in-world trial drove this rewrite:
      //   1. Earlier batching used 4×8 sub-boxes (~32 cells). Bot can only
      //      reach ~4.5 blocks from its standpoint, so cells in the far
      //      corner of a 4×8 batch were unreachable and got skipped after
      //      pathfindGotoNear timed out. Solution: cap batch to 3×3 = 9
      //      cells so the diagonal half-radius is ~2.1 — every cell is
      //      within reach.
      //   2. Bot wandered between batches because the loop always swept
      //      +Z. Solution: snake across Z (alternate +Z and -Z per X
      //      chunk) so the bot's next batch is adjacent to where it just
      //      finished. Drops also stay near it, so per-batch pickup
      //      collects them before they despawn.
      //
      // Per-Y layer: top-down so debris doesn't fall on the bot.
      // Per-batch: pathfindGotoNear to centroid → dig_area → pickup.
      const handlers = getActions();
      const digArea = handlers?.dig_area;
      if (typeof digArea !== 'function') {
        return {
          ok: false,
          error: {
            code: 'WIRING',
            message: 'mc clear_strip: dig_area handler not available — actions registry incomplete',
            retry_safe: false,
          },
        };
      }
      const CHUNK_MAX = 3; // 3×3 = 9 cells fits well within 4.5-block bot reach
      const chunkW = Math.min(w, CHUNK_MAX);
      const chunkL = Math.min(l, CHUNK_MAX);
      let dug = 0;
      let skipped = 0;
      let errors = 0;
      let batches = 0;
      const errorHints = []; // first ≤3 dig_area error strings we see
      const pickup = handlers.pickup;

      const capMs = Number(capsMs.clear_strip) || ACTION_CAPS_MS.clear_strip;
      const deadline = Date.now() + capMs;
      const partialTimeout = (extra = {}) => timeoutError('clear_strip', capMs, {
        dug,
        skipped,
        errors,
        batches,
        would_dig: wouldDig,
        bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ, y1, y2 },
        ...extra,
      }, `Partial completion: dug ${dug}/${wouldDig} across ${batches} batches. Re-run the same mc clear_strip command — already-clear cells are skipped quickly.`);

      // Build X-chunk starts once: minX, minX+chunkW, minX+2*chunkW, ...
      const xChunkStarts = [];
      for (let cx1 = minX; cx1 <= maxX; cx1 += chunkW) xChunkStarts.push(cx1);
      // Z-chunk starts: same. We'll iterate in reverse for odd X-chunks
      // to give a snake walk across the rectangle.
      const zChunkStarts = [];
      for (let cz1 = minZ; cz1 <= maxZ; cz1 += chunkL) zChunkStarts.push(cz1);

      for (let y = y2; y >= y1; y--) {
        for (let xi = 0; xi < xChunkStarts.length; xi++) {
          const cx1 = xChunkStarts[xi];
          const cx2 = Math.min(cx1 + chunkW - 1, maxX);
          // Snake: even X-chunks scan +Z, odd scan -Z. Combined with the
          // outer Y loop (top-down) this means after each batch the bot's
          // next target is at most one chunk away in any axis.
          const zOrder = xi % 2 === 0 ? zChunkStarts : [...zChunkStarts].reverse();
          for (const cz1 of zOrder) {
            const cz2 = Math.min(cz1 + chunkL - 1, maxZ);
            if (Date.now() > deadline) {
              return partialTimeout({ next_batch: { x1: cx1, y1: y, z1: cz1, x2: cx2, y2: y, z2: cz2 } });
            }
            // Pre-position to batch centroid (one cell above the deck Y so
            // the bot stands on the surface, not the dig layer). Skip if
            // already in reach. pathfindGotoNear is best-effort — if it
            // can't path, the per-cell pathfinding inside dig_area still
            // runs as a fallback.
            const ccx = Math.floor((cx1 + cx2) / 2);
            const ccz = Math.floor((cz1 + cz2) / 2);
            const standY = sy + 1;
            try {
              const b = ensureBot();
              const dx = b.entity.position.x - ccx;
              const dz = b.entity.position.z - ccz;
              const dy = b.entity.position.y - standY;
              const distSq = dx * dx + dy * dy + dz * dz;
              if (distSq > 9 /* 3-block radius */) {
                // eslint-disable-next-line no-await-in-loop
                await pathfindGotoNear(b, goals, ccx, standY, ccz, 2, {
                  opName: 'clear_strip', capMs: ACTION_CAPS_MS.reach,
                });
              }
            } catch { /* best-effort — fall through to per-cell pathfind */ }
            // eslint-disable-next-line no-await-in-loop
            const res = await digArea({
              x1: cx1, y1: y, z1: cz1,
              x2: cx2, y2: y, z2: cz2,
              pickup: false,
              abort_on_fail: false,
              clear_stand: false,
              safe: true,
              force_structural: isRoad,
            });
            batches++;
            if (res && res.ok === false) {
              errors++;
              if (errorHints.length < 3 && res.error?.message) {
                errorHints.push(res.error.message);
              }
              continue;
            }
            dug += Number(res?.dug || 0);
            skipped += Number(res?.skipped || 0);
            // dig_area exposes the first few errors from its per-cell loop
            // as data.errors[]. The most common ones are slow-dig refusals
            // ("Refusing to dig X with Y") — surfacing them up tells the
            // agent it's missing a shovel/axe/shears rather than that the
            // cells are protected.
            const subErrors = res?.data?.errors || res?.errors;
            if (Array.isArray(subErrors)) {
              for (const e of subErrors) {
                if (errorHints.length >= 3) break;
                if (typeof e === 'string' && e.length > 0) errorHints.push(e);
              }
            }
            if (typeof pickup === 'function') {
              try { await pickup(); } catch { /* best-effort */ }
            }
          }
        }
      }
      // Final pickup catches anything that drifted out of per-batch range.
      if (typeof pickup === 'function') {
        try { await pickup(); } catch { /* best-effort */ }
      }

      // Phase 3 — road_mode tree extension. When a log was cut inside the
      // rectangle, the rest of the trunk (above the height window) and the
      // connected canopy can be left floating. Walk each touched trunk
      // upward to find the rest of the logs, then BFS attached leaves.
      // Dig the extras one cell at a time via dig_area 1×1×1 calls.
      // Inventory: needs an axe for logs (existing equipForDig handles
      // selection); shears or empty hand for leaves.
      let extraLogsRemoved = 0;
      let extraLeavesRemoved = 0;
      if (isRoad && touchedLogTops.size > 0) {
        const seedLogs = Array.from(touchedLogTops.values());
        const expandedLogs = expandLogsUpward(b, seedLogs, 16);
        // Leaves: BFS from full extended trunk set. Default radius 4 (same
        // as fell_tree). Cap 256 leaves total to bound runtime.
        const allLeaves = collectConnectedLeaves(b, expandedLogs, 4, 256);
        // Filter: only cells OUTSIDE the original clear_strip rectangle
        // (cells inside were already dug in Phase 2). The y check uses the
        // inclusive [y1, y2] bounds.
        function isInsideRect(c) {
          return c.x >= minX && c.x <= maxX && c.z >= minZ && c.z <= maxZ
                 && c.y >= y1 && c.y <= y2;
        }
        const extras = [
          ...expandedLogs.filter((c) => !isInsideRect(c)),
          ...allLeaves.filter((c) => !isInsideRect(c)),
        ];
        // Dig top-down (debris-safe).
        extras.sort((a, c) => c.y - a.y);
        for (let ei = 0; ei < extras.length; ei++) {
          const cell = extras[ei];
          if (Date.now() > deadline) {
            return partialTimeout({
              phase: 'tree_extension',
              extra_logs_removed: extraLogsRemoved,
              extra_leaves_removed: extraLeavesRemoved,
              extension_cells_remaining: extras.length - ei,
            });
          }
          // eslint-disable-next-line no-await-in-loop
          const res = await digArea({
            x1: cell.x, y1: cell.y, z1: cell.z,
            x2: cell.x, y2: cell.y, z2: cell.z,
            pickup: false,
            abort_on_fail: false,
            clear_stand: false,
            safe: true,
            force_structural: true, // wood/leaves are structural; bypass
          });
          if (res && res.ok === false) continue;
          const cellDug = Number(res?.dug || 0);
          if (cellDug > 0) {
            if (isLogBlock(cell.name)) extraLogsRemoved += cellDug;
            else if (isLeafBlock(cell.name)) extraLeavesRemoved += cellDug;
          }
        }
        if (typeof pickup === 'function' && extras.length > 0) {
          try { await pickup(); } catch { /* best-effort */ }
        }
      }

      // Tally wood/leaves counters across both Phase 2 (in-rect) and
      // Phase 3 (extended) so the agent sees one unified number per
      // category (Mox-builder feedback requested this).
      const inRectLogs = Object.entries(removedByBlock)
        .filter(([n]) => isLogBlock(n))
        .reduce((sum, [, c]) => sum + c, 0);
      const inRectLeaves = Object.entries(removedByBlock)
        .filter(([n]) => isLeafBlock(n))
        .reduce((sum, [, c]) => sum + c, 0);
      const woodBlocksRemoved = inRectLogs + extraLogsRemoved;
      const leafBlocksRemoved = inRectLeaves + extraLeavesRemoved;

      const data = {
        ...baseData,
        mode: 'live',
        dug,
        skipped,
        errors,
        batches,
        wood_blocks_removed: woodBlocksRemoved,
        leaf_blocks_removed: leafBlocksRemoved,
      };
      if (extraLogsRemoved + extraLeavesRemoved > 0) {
        data.extension = {
          extra_logs_removed: extraLogsRemoved,
          extra_leaves_removed: extraLeavesRemoved,
        };
      }
      if (errorHints.length > 0) data.first_hints = errorHints;
      return {
        ok: true,
        data,
        result: `clear_strip ${w}×${l}×${H} y=${sy}: dug ${dug}${extraLogsRemoved + extraLeavesRemoved > 0 ? ` +${extraLogsRemoved + extraLeavesRemoved} canopy ext` : ''}, skipped ${skipped}${errors ? `, ${errors} batch errors` : ''}, ${batches} batches${isRoad ? ' [road_mode]' : ''}${woodBlocksRemoved ? ` wood=${woodBlocksRemoved}` : ''}${leafBlocksRemoved ? ` leaves=${leafBlocksRemoved}` : ''}${errorHints.length ? ` — first hint: ${errorHints[0]}` : ''}`,
      };
    },

    /**
     * Build a flat horizontal deck across an air-gap span.
     *
     * Places `block` at every air cell in [x1..x2] × {y} × [z1..z2],
     * using a **BFS edge-inward** order so each placement anchors against a
     * cell that's already solid — either pre-existing terrain on the rim,
     * or a deck cell placed earlier in this same call. This is the standard
     * Minecraft "bridge from the bank" pattern; ordinary `mc fill` over an
     * open gap fails at interior cells with `no_adjacent_face` because all
     * neighbors are air at start.
     *
     * Y MIGRATION (phase 1): `surface_y` is REJECTED with INVALID_COORD —
     * its historical meaning here ("the deck block's Y") clashed with the
     * canonical vocabulary (surface_y = feet = block_y + 1, see
     * docs/reference/world-coordinates.md). Pass `y` (= block_y of the deck
     * layer) instead; phase 2 reintroduces `surface_y` as true feet via
     * parseYInput. Bots walk ON the deck at y + 1.
     *
     * Args:
     *   x1, z1, x2, z2  — rectangle bounds (inclusive)
     *   y               — block_y of the deck (single horizontal layer);
     *                     match the road bed's block_y so the deck is flush
     *   block           — fill block name (e.g. 'cobblestone'; doctrine
     *                     prefers cobblestone for spans over water/ravines)
     *   max_cells       — soft cap on rectangle size. Default 256.
     *   dry_run         — true: report the BFS placement plan + count of
     *                     cells that are unanchored (no path from a rim).
     *                     No placement occurs.
     *
     * Returns:
     *   { ok: true, data: { mode, placed, failed, unanchored,
     *       already_solid, tier4_skipped, errors, bounds, block_y,
     *       surface_y, block, would_place?, would_place_order? } }
     *   block_y/surface_y are the canonical pair for the deck layer
     *   (surface_y = block_y + 1 = where a bot walks on the deck).
     *
     * Note: `ok` stays `true` even on partial completion (some cells could
     * not be anchored). Inspect `data.unanchored.length` + `data.failed` to
     * decide whether to retry or accept the partial deck. This mirrors the
     * `mc level` convention.
     */
    async deck({
      x1, z1, x2, z2,
      y,
      surface_y,
      block,
      max_cells,
      dry_run,
    }) {
      const b = ensureBot();
      if (surface_y !== undefined && surface_y !== null) {
        return {
          ok: false,
          error: {
            code: 'INVALID_COORD',
            message: `mc deck: surface_y is temporarily rejected — its meaning here is migrating from "deck block Y" to the canonical feet Y (= block_y + 1). Pass y=<block_y of the deck layer> instead.`,
            next_action_hint: 'Re-issue with y=<deck block Y>; surface_y returns next release meaning feet.',
            retry_safe: false,
          },
        };
      }
      for (const [k, v] of Object.entries({ x1, z1, x2, z2, y })) {
        if (!Number.isFinite(Number(v))) {
          return {
            ok: false,
            error: {
              code: 'INVALID_COORD',
              message: `mc deck requires numeric ${k}`,
              retry_safe: false,
            },
          };
        }
      }
      if (typeof block !== 'string' || !block) {
        return {
          ok: false,
          error: {
            code: 'INVALID_VALUE',
            message: `mc deck requires a block name (e.g. block=cobblestone)`,
            retry_safe: false,
          },
        };
      }
      const minX = Math.min(Number(x1), Number(x2));
      const maxX = Math.max(Number(x1), Number(x2));
      const minZ = Math.min(Number(z1), Number(z2));
      const maxZ = Math.max(Number(z1), Number(z2));
      const sy = Math.floor(Number(y)); // block_y of the deck layer
      const cap = Math.max(8, Math.min(parseInt(String(max_cells ?? 256), 10) || 256, 1024));
      const isDry = parseFlag(dry_run);
      const w = maxX - minX + 1;
      const l = maxZ - minZ + 1;
      const total = w * l;
      if (total > cap) {
        return {
          ok: false,
          error: {
            code: 'OUT_OF_RANGE',
            message: `mc deck: ${w}×${l} = ${total} cells exceeds the per-call cap of ${cap}. Split into smaller rectangles.`,
            observed_state: { requested: total, max: cap, bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ } },
            retry_safe: false,
          },
        };
      }

      // Phase 1 — classify the deck plane.
      const cellState = new Map(); // 'x,z' → 'solid' | 'tier4' | 'air'
      let alreadySolid = 0;
      let tier4Skipped = 0;
      const airCells = new Map(); // 'x,z' → { x, z }
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          const k = `${x},${z}`;
          const blk = b.blockAt(new Vec3(x, sy, z));
          if (!blk || isAirLike(blk.name)) {
            cellState.set(k, 'air');
            airCells.set(k, { x, z });
            continue;
          }
          const tier = tierOf(blk.name);
          if (tier === 4) {
            cellState.set(k, 'tier4');
            tier4Skipped++;
            continue;
          }
          cellState.set(k, 'solid');
          alreadySolid++;
        }
      }

      // Anchor test: is there ANY solid neighbor on a placeable face?
      // For a deck plane, the candidates are: 4 horizontal neighbors at sy
      // (including cells outside the rectangle = bank), the cell below at
      // sy-1 (pier or column), the cell above at sy+1 (rare).
      const HORIZ = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      function isAnchored(x, z) {
        for (const [dx, dz] of HORIZ) {
          const nkey = `${x + dx},${z + dz}`;
          const state = cellState.get(nkey);
          if (state === 'solid') return true;
          if (state === undefined) {
            // Outside the rectangle — check live world (the bank).
            const blk = b.blockAt(new Vec3(x + dx, sy, z + dz));
            if (blk && !isAirLike(blk.name)) return true;
          }
        }
        const below = b.blockAt(new Vec3(x, sy - 1, z));
        if (below && !isAirLike(below.name)) return true;
        const above = b.blockAt(new Vec3(x, sy + 1, z));
        if (above && !isAirLike(above.name)) return true;
        return false;
      }

      const baseData = {
        air_cells: airCells.size,
        already_solid: alreadySolid,
        tier4_skipped: tier4Skipped,
        bounds: { x1: minX, z1: minZ, x2: maxX, z2: maxZ, y: sy },
        ...withYBoth({}, sy),
        block,
      };

      // Phase 2 — dry-run: simulate BFS without placing.
      if (isDry) {
        const placed_sim = new Set();
        const order = [];
        const queue = [];
        for (const cell of airCells.values()) {
          if (isAnchored(cell.x, cell.z)) queue.push(cell);
        }
        while (queue.length) {
          const cur = queue.shift();
          const k = `${cur.x},${cur.z}`;
          if (placed_sim.has(k)) continue;
          placed_sim.add(k);
          order.push(cur);
          for (const [dx, dz] of HORIZ) {
            const nk = `${cur.x + dx},${cur.z + dz}`;
            if (!airCells.has(nk) || placed_sim.has(nk)) continue;
            queue.push({ x: cur.x + dx, z: cur.z + dz });
          }
        }
        const unanchored = [];
        for (const cell of airCells.values()) {
          if (!placed_sim.has(`${cell.x},${cell.z}`)) unanchored.push(cell);
        }
        return {
          ok: true,
          data: {
            ...baseData,
            mode: 'dry_run',
            would_place: order.length,
            would_place_order: order,
            unanchored,
          },
          result: `deck ${w}×${l} y=${sy} ${block} dry_run: would place ${order.length}/${airCells.size}${unanchored.length ? ` (${unanchored.length} unanchored — no path from rim)` : ''}${alreadySolid ? `, ${alreadySolid} already solid` : ''}${tier4Skipped ? `, ${tier4Skipped} tier_4 skipped` : ''}`,
        };
      }

      // Phase 3 — live BFS placement.
      const OFFSETS6 = [
        [0, -1, 0], [0, 1, 0],
        [1, 0, 0], [-1, 0, 0],
        [0, 0, 1], [0, 0, -1],
      ];
      const placedThisRun = new Set();
      const placeQueue = [];
      const queuedSet = new Set();
      for (const cell of airCells.values()) {
        if (isAnchored(cell.x, cell.z)) {
          const k = `${cell.x},${cell.z}`;
          if (!queuedSet.has(k)) {
            placeQueue.push(cell);
            queuedSet.add(k);
          }
        }
      }

      let placed = 0;
      let failed = 0;
      const errors = [];

      while (placeQueue.length) {
        const cur = placeQueue.shift();
        const key = `${cur.x},${cur.z}`;
        queuedSet.delete(key);
        if (placedThisRun.has(key)) continue;

        const live = b.blockAt(new Vec3(cur.x, sy, cur.z));
        if (live && !isAirLike(live.name)) {
          // Got filled by something between survey + now; treat as placed.
          placedThisRun.add(key);
          continue;
        }
        if (shouldSkipPlaceAt(ctx, config, block, cur.x, sy, cur.z).skip) {
          failed++;
          errors.push(`place ${cur.x},${sy},${cur.z}: region denied`);
          continue;
        }

        // Find a reference block on any placeable face.
        let refBlock = null;
        let faceVec = null;
        for (const [ox, oy, oz] of OFFSETS6) {
          const ref = b.blockAt(new Vec3(cur.x + ox, sy + oy, cur.z + oz));
          if (ref && !isAirLike(ref.name) && ref.boundingBox === 'block') {
            refBlock = ref;
            faceVec = new Vec3(-ox, -oy, -oz);
            break;
          }
        }
        if (!refBlock) {
          // Was anchored when enqueued; an earlier-placed neighbor must've
          // been digged or rolled back. Defer — re-enqueue at the back so
          // any pending placements can refresh the anchor; bail if it cycles.
          failed++;
          errors.push(`place ${cur.x},${sy},${cur.z}: anchor lost mid-flight`);
          continue;
        }

        const item = b.inventory.items().find((it) => it.name === block);
        if (!item) {
          return {
            ok: false,
            error: {
              code: 'MISSING_INVENTORY',
              message: `mc deck: ${block} not in inventory (placed ${placed}/${airCells.size})`,
              observed_state: { placed, remaining: airCells.size - placed, block, bounds: baseData.bounds },
              retry_safe: true,
            },
          };
        }
        try { await b.equip(item, 'hand'); } catch (e) {
          failed++;
          errors.push(`equip ${block}: ${e?.message || e}`);
          continue;
        }
        if (b.entity.position.distanceTo(refBlock.position) > 4.5) {
          try {
            await pathfindGotoNear(b, goals, cur.x, sy + 1, cur.z, 3, { opName: 'deck', capMs: ACTION_CAPS_MS.reach });
          } catch { /* placement may still succeed if close enough */ }
        }
        try {
          await b.placeBlock(refBlock, faceVec);
          recordRecentPlace(ctx, { x: cur.x, y: sy, z: cur.z }, block);
          placed++;
          placedThisRun.add(key);
          // Enqueue in-rectangle air neighbors — they may now be anchorable
          // (this cell just became solid). isAnchored() will be re-checked
          // at dequeue; we just gate by "is in queue already".
          for (const [dx, dz] of HORIZ) {
            const nk = `${cur.x + dx},${cur.z + dz}`;
            if (!airCells.has(nk) || placedThisRun.has(nk) || queuedSet.has(nk)) continue;
            placeQueue.push({ x: cur.x + dx, z: cur.z + dz });
            queuedSet.add(nk);
          }
        } catch (e) {
          failed++;
          errors.push(`place ${cur.x},${sy},${cur.z}: ${e?.message || e}`);
        }
      }

      const unanchored = [];
      for (const cell of airCells.values()) {
        if (placedThisRun.has(`${cell.x},${cell.z}`)) continue;
        const live = b.blockAt(new Vec3(cell.x, sy, cell.z));
        if (live && !isAirLike(live.name)) continue;
        unanchored.push(cell);
      }

      return {
        ok: true,
        data: {
          ...baseData,
          mode: 'live',
          placed,
          failed,
          unanchored,
          errors: errors.slice(0, 5),
        },
        result: `deck ${w}×${l} y=${sy} ${block}: placed ${placed}/${airCells.size}${failed ? `, ${failed} failed` : ''}${unanchored.length ? `, ${unanchored.length} unanchored` : ''}`,
      };
    },

    /**
     * Fell a tree rooted at column (x, z): remove the connected trunk
     * column + the connected leaves attached to it. Picks up drops at the
     * end. Composes cleanly with `mc clear_strip road_mode=true` — that
     * verb handles wide-corridor canopy clears, fell_tree handles "one
     * specific tree the planner identified by coords".
     *
     * Args:
     *   x, z              — column coords of the tree (any column the
     *                       trunk passes through; the trunk is found by
     *                       scanning the vertical Y window around the bot).
     *   y_hint            — optional starting Y for the trunk scan. If
     *                       omitted, scans bot.y - 4 .. bot.y + 24.
     *   leaves_radius     — XZ radius for leaf cleanup around the trunk.
     *                       Default 4. Set 0 to skip leaf cleanup.
     *   max_logs          — soft cap on trunk-block count. Default 24.
     *   max_leaves        — soft cap on leaf-block count. Default 256.
     *   dry_run           — true: just survey + return counts/coords.
     *
     * Returns:
     *   { ok, data: { mode, species, trunk_base_y, trunk_top_y, logs,
     *                 logs_removed, leaves, leaves_removed, errors } }
     *
     * Failure modes:
     *   - NO_TREE_AT_COORD if no log block is found in the Y scan window
     *   - OUT_OF_RANGE if logs_n + leaves_n exceeds soft cap
     */
    async fell_tree({ x, z, y_hint, leaves_radius, max_logs, max_leaves, dry_run }) {
      const b = ensureBot();
      for (const [k, v] of Object.entries({ x, z })) {
        if (!Number.isFinite(Number(v))) {
          return {
            ok: false,
            error: { code: 'INVALID_COORD', message: `mc fell_tree requires numeric ${k}`, retry_safe: false },
          };
        }
      }
      const tx = Math.floor(Number(x));
      const tz = Math.floor(Number(z));
      const isDry = parseFlag(dry_run);
      // Use Number.isFinite + ternary to keep 0 as a valid value (parsed||4
      // would turn an explicit 0 into the default).
      const lrParsed = parseInt(String(leaves_radius ?? 4), 10);
      const lr = Math.max(0, Math.min(Number.isFinite(lrParsed) ? lrParsed : 4, 8));
      const logCapParsed = parseInt(String(max_logs ?? 24), 10);
      const logCap = Math.max(1, Math.min(Number.isFinite(logCapParsed) && logCapParsed > 0 ? logCapParsed : 24, 64));
      const leafCapParsed = parseInt(String(max_leaves ?? 256), 10);
      const leafCap = Math.max(0, Math.min(Number.isFinite(leafCapParsed) ? leafCapParsed : 256, 1024));

      // Phase 1 — locate the lowest log block in the column.
      const startY = Number.isFinite(Number(y_hint))
        ? Math.floor(Number(y_hint))
        : Math.floor(b.entity.position.y);
      const SCAN_BELOW = 4;
      const SCAN_ABOVE = 28;
      let trunkBaseY = null;
      let trunkBaseBlock = null;
      for (let y = startY - SCAN_BELOW; y <= startY + SCAN_ABOVE; y++) {
        const blk = b.blockAt(new Vec3(tx, y, tz));
        if (blk && isLogBlock(blk.name)) {
          trunkBaseY = y;
          trunkBaseBlock = blk;
          break;
        }
      }
      if (trunkBaseY === null) {
        return {
          ok: false,
          error: {
            code: 'NO_TREE_AT_COORD',
            message: `mc fell_tree: no log block at column (${tx}, ${tz}) within y=[${startY - SCAN_BELOW}..${startY + SCAN_ABOVE}]. Pass y_hint=N to scan around a different Y.`,
            observed_state: { x: tx, z: tz, scanned_y_range: [startY - SCAN_BELOW, startY + SCAN_ABOVE] },
            retry_safe: false,
          },
        };
      }
      const species = speciesOf(trunkBaseBlock.name);

      // Phase 2 — BFS the connected log set from trunkBase. Multi-stem
      // trees (e.g. dark_oak 2×2) connect horizontally too, so we allow
      // 6-face connectivity but cap to logCap.
      const logs = []; // [{x,y,z,name}]
      const logSeen = new Set();
      {
        const q = [{ x: tx, y: trunkBaseY, z: tz }];
        logSeen.add(`${tx},${trunkBaseY},${tz}`);
        const OFFS = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
        while (q.length && logs.length < logCap) {
          const cur = q.shift();
          const blk = b.blockAt(new Vec3(cur.x, cur.y, cur.z));
          if (!blk || !isLogBlock(blk.name)) continue;
          logs.push({ x: cur.x, y: cur.y, z: cur.z, name: blk.name });
          for (const [dx, dy, dz] of OFFS) {
            const nk = `${cur.x + dx},${cur.y + dy},${cur.z + dz}`;
            if (logSeen.has(nk)) continue;
            logSeen.add(nk);
            q.push({ x: cur.x + dx, y: cur.y + dy, z: cur.z + dz });
          }
        }
      }
      const trunkTopY = logs.reduce((m, c) => (c.y > m ? c.y : m), trunkBaseY);

      // Phase 3 — BFS connected leaves attached to the trunk (radius gate
      // by Chebyshev distance from the closest log). Shared helper at
      // module top so clear_strip (road_mode) can call it too.
      const leaves = collectConnectedLeaves(b, logs, lr, leafCap);

      const baseData = {
        species,
        trunk_base_y: trunkBaseY,
        trunk_top_y: trunkTopY,
        x: tx, z: tz,
        logs_n: logs.length,
        leaves_n: leaves.length,
        leaves_radius: lr,
      };

      if (isDry) {
        return {
          ok: true,
          data: {
            ...baseData,
            mode: 'dry_run',
            logs,
            leaves,
          },
          result: `fell_tree ${species || '?'} at (${tx},${trunkBaseY},${tz}) dry_run: trunk ${logs.length} logs (y=${trunkBaseY}..${trunkTopY}), ${leaves.length} leaves within radius ${lr}`,
        };
      }

      // Phase 4 — execute. Top-down so debris doesn't fall on us. Cells
      // are grouped into spatial clusters; we pre-position once per cluster
      // (next to the cluster centroid at trunk-base Y) so per-cell reach is
      // guaranteed and the bot doesn't crisscross between distant cells.
      // After each cluster we pickup() so drops are collected before they
      // fall out of pickup range. Lesson from the 2026-06-09 trial: the
      // pre-pre-position version fell on 7/17 leaves because each "out of
      // reach" pathfind cap-timeout-ed individually.
      //
      // Clustering: trunk forms one cluster (all logs). Leaves cluster by
      // BFS over horizontal (X,Z) neighbors within 2 cells of each other,
      // so each canopy quadrant becomes its own cluster the bot can sweep
      // from one standpoint.
      function buildClusters(cells) {
        if (cells.length === 0) return [];
        // BFS connected components on horizontal proximity ≤ 2.
        const seen = new Set();
        const clusters = [];
        const key = (c) => `${c.x},${c.y},${c.z}`;
        for (const start of cells) {
          if (seen.has(key(start))) continue;
          const queue = [start];
          seen.add(key(start));
          const cluster = [];
          while (queue.length) {
            const cur = queue.shift();
            cluster.push(cur);
            for (const other of cells) {
              const k = key(other);
              if (seen.has(k)) continue;
              if (Math.max(Math.abs(other.x - cur.x), Math.abs(other.z - cur.z)) <= 2) {
                seen.add(k);
                queue.push(other);
              }
            }
          }
          clusters.push(cluster);
        }
        return clusters;
      }
      const trunkCluster = logs.slice(); // logs are already connected by BFS
      const leafClusters = buildClusters(leaves);
      // Sort within each cluster top-down; sort cluster list so trunk is
      // first, then leaf clusters nearest the trunk base first (so bot's
      // motion is continuous).
      trunkCluster.sort((a, c) => c.y - a.y);
      for (const cl of leafClusters) cl.sort((a, c) => c.y - a.y);
      function clusterCentroid(cells) {
        let sx = 0, sy = 0, sz = 0;
        for (const c of cells) { sx += c.x; sy += c.y; sz += c.z; }
        return { x: Math.floor(sx / cells.length), y: Math.floor(sy / cells.length), z: Math.floor(sz / cells.length) };
      }
      leafClusters.sort((a, c) => {
        const ca = clusterCentroid(a);
        const cc = clusterCentroid(c);
        const da = Math.max(Math.abs(ca.x - tx), Math.abs(ca.z - tz));
        const dc = Math.max(Math.abs(cc.x - tx), Math.abs(cc.z - tz));
        return da - dc;
      });
      const allClusters = [trunkCluster, ...leafClusters].filter((c) => c.length > 0);

      const handlers = getActions();
      const pickup = handlers?.pickup;
      let logsRemoved = 0;
      let leavesRemoved = 0;
      let failed = 0;
      const errors = [];
      for (const cluster of allClusters) {
        // Pre-position next to the cluster centroid. Stand at trunk base Y
        // (or cluster's lowest Y) so the bot has solid ground under it.
        const centroid = clusterCentroid(cluster);
        const standY = Math.min(trunkBaseY, cluster.reduce((m, c) => Math.min(m, c.y), Infinity));
        try {
          const dx = b.entity.position.x - centroid.x;
          const dz = b.entity.position.z - centroid.z;
          const distSq = dx * dx + dz * dz;
          if (distSq > 4 /* >2 horizontal */) {
            // eslint-disable-next-line no-await-in-loop
            await pathfindGotoNear(b, goals, centroid.x, standY, centroid.z, 2, {
              opName: 'fell_tree', capMs: ACTION_CAPS_MS.reach,
            });
          }
        } catch { /* best-effort */ }
        for (const cell of cluster) {
          const live = b.blockAt(new Vec3(cell.x, cell.y, cell.z));
          if (!live || (live.name !== cell.name && !isLogBlock(live.name) && !isLeafBlock(live.name))) {
            continue;
          }
          try {
            // eslint-disable-next-line no-await-in-loop
            await equipForDig(b, live);
            if (b.entity.position.distanceTo(live.position) > 4.5) {
              try {
                // eslint-disable-next-line no-await-in-loop
                await pathfindGotoNear(b, goals, cell.x, cell.y + 1, cell.z, 3, { opName: 'fell_tree', capMs: ACTION_CAPS_MS.reach });
              } catch { /* dig may still succeed if close enough */ }
            }
            // eslint-disable-next-line no-await-in-loop
            await b.dig(live, true);
            if (isLogBlock(live.name)) logsRemoved++;
            else if (isLeafBlock(live.name)) leavesRemoved++;
          } catch (err) {
            failed++;
            errors.push(`(${cell.x},${cell.y},${cell.z}): ${err?.message || err}`);
          }
        }
        // Per-cluster pickup so drops are collected before bot moves on.
        if (typeof pickup === 'function') {
          try { await pickup(); } catch { /* best-effort */ }
        }
      }
      // Final pickup catches anything drifted out of per-cluster range.
      if (typeof pickup === 'function') {
        try { await pickup(); } catch { /* best-effort */ }
      }

      return {
        ok: true,
        data: {
          ...baseData,
          mode: 'live',
          logs_removed: logsRemoved,
          leaves_removed: leavesRemoved,
          failed,
          errors: errors.slice(0, 5),
        },
        result: `fell_tree ${species || '?'} at (${tx},${trunkBaseY},${tz}): removed ${logsRemoved} logs + ${leavesRemoved} leaves${failed ? `, ${failed} failed` : ''}`,
      };
    },
  };
}
