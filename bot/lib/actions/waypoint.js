/**
 * mc waypoint <name> <x> <y> <z> — adaptive-road-planning §7.1.
 *
 * Sets the bot's PRIVATE mark `<name>` and places a torch at the surface
 * block under (x,y,z). Fleet-wide visibility is *not* this verb's job:
 * `roadplan` is the sole writer to locations-base.json (§5.1). When the
 * waypoint moves, the OLD torch is dug if reachable; otherwise a
 * cleanup hint comes back so the planner can queue it.
 *
 * Placement-fallback decision table (water / leaves / slab / air):
 * see `pickTorchAnchor` below — pure, fixture-tested.
 *
 * Idempotency rules:
 *   - re-call at the same coord with a torch already present     → ok, no placement
 *   - re-call after the torch was knocked out (popped)           → ok, re-places
 *   - re-call at a NEW coord (move)                              → mark updated +
 *                                                                  new torch placed +
 *                                                                  old torch dug (if reachable)
 *                                                                  or next_action_hint
 */
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ok, fail } from '../shared/action-contract.js';

const { goals } = pathfinderPkg;

// Move the bot OFF (tx, ty, tz) onto an adjacent standable cell, so a torch
// can be placed in the cell the bot was occupying. Uses an exact GoalBlock
// (not GoalNear) so "already within range of the original cell" can't be a
// no-op. Returns true once the bot's foot cell differs from the target.
async function stepOffCell(b, tx, ty, tz) {
  const isStandable = (x, y, z) => {
    const at = b.blockAt(new Vec3(x, y, z));
    const head = b.blockAt(new Vec3(x, y + 1, z));
    const below = b.blockAt(new Vec3(x, y - 1, z));
    const clear = (blk) => !blk || blk.boundingBox === 'empty';
    return below && below.boundingBox === 'block' && clear(at) && clear(head);
  };
  const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  const timeout = () => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000));
  for (const [ox, oz] of offsets) {
    const gx = tx + ox, gz = tz + oz;
    if (!isStandable(gx, ty, gz)) continue;
    try {
      await Promise.race([b.pathfinder.goto(new goals.GoalBlock(gx, ty, gz)), timeout()]);
    } catch { try { b.pathfinder.setGoal(null); } catch { /* ignore */ } continue; }
    const f = b.entity.position.floored();
    if (f.x !== tx || f.y !== ty || f.z !== tz) return true;
  }
  return false;
}

// Names safe to overwrite when placing a torch. Vegetation and snow_layer
// are sticky in the K1 walk-classify kernel for a reason (they're walkable);
// they're also safe to break for a torch.
const TORCH_OVERWRITE = new Set([
  'air', 'cave_air', 'void_air',
  'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow_layer',
]);
const FLUID_NAMES = new Set([
  'water', 'flowing_water', 'lava', 'flowing_lava', 'bubble_column',
]);
const SLAB_SUFFIX = '_slab';
const LEAVES_SUFFIX = '_leaves';
const TORCH_NAMES = new Set(['torch', 'wall_torch', 'soul_torch', 'soul_wall_torch']);

/**
 * Pure decision: which solid cell anchors the torch for waypoint (x, y, z)?
 *
 * Scans down from (x, y-1, z) up to `maxScanDown` blocks; returns the first
 * full-cube / top-of-slab cell. Leaves and replaceable plants are skipped
 * (a torch atop decaying leaves will pop); fluids hard-fail (you can't
 * stand-and-light a swamp cell).
 *
 * @param {{x:number, y:number, z:number,
 *          blockAtFn: (p: {x:number,y:number,z:number}) => any|null,
 *          maxScanDown?: number}} opts
 */
export function pickTorchAnchor({ x, y, z, blockAtFn, maxScanDown = 3 }) {
  const torchCellBlock = blockAtFn({ x, y, z });
  if (torchCellBlock && TORCH_NAMES.has(torchCellBlock.name)) {
    // Already lit at the requested coord — caller treats this as idempotent.
    return {
      ok: true,
      already_lit: true,
      torch_at: { x, y, z },
      anchor_at: { x, y: y - 1, z },
      anchor_block: torchCellBlock.name,
      face: [0, 1, 0],
    };
  }
  if (torchCellBlock && !TORCH_OVERWRITE.has(torchCellBlock.name)) {
    return {
      ok: false,
      reason: 'torch_cell_obstructed',
      torch_cell: { x, y, z },
      torch_cell_block: torchCellBlock.name,
    };
  }
  for (let dy = 1; dy <= maxScanDown; dy++) {
    const anchor = blockAtFn({ x, y: y - dy, z });
    if (!anchor) {
      return {
        ok: false, reason: 'unloaded_chunk',
        anchor_at: { x, y: y - dy, z },
      };
    }
    if (FLUID_NAMES.has(anchor.name)) {
      return {
        ok: false, reason: 'fluid_below',
        anchor_at: { x, y: y - dy, z }, anchor_block: anchor.name,
      };
    }
    if (anchor.name.endsWith(LEAVES_SUFFIX)) continue;
    if (TORCH_OVERWRITE.has(anchor.name)) continue;
    if (anchor.boundingBox === 'block' || anchor.name.endsWith(SLAB_SUFFIX)) {
      return {
        ok: true,
        torch_at: { x, y: y - dy + 1, z },
        anchor_at: { x, y: y - dy, z },
        anchor_block: anchor.name,
        face: [0, 1, 0],
      };
    }
    // Non-replaceable, non-full (fence, glass-pane, etc.) — keep scanning.
  }
  return {
    ok: false, reason: 'no_solid_floor_within_scan',
    scanned_to: { x, y: y - maxScanDown, z },
  };
}

/**
 * When the requested cell can't anchor a torch, scan a small lateral ring
 * for a cell that CAN (natural ground, clear torch cell) near the planned
 * elevation. Returns the nearest workable torch_at {x,y,z}, or null. This is
 * the §11.1-compliant "snap laterally within ~1 cell" suggestion — the
 * planner uses it to nudge the waypoint, never to fabricate a base.
 *
 * @param {{x:number,y:number,z:number,
 *          blockAtFn:(p:{x:number,y:number,z:number})=>any|null,
 *          maxRing?:number}} opts
 */
export function suggestNearbyAnchor({ x, y, z, blockAtFn, maxRing = 2 }) {
  let best = null, bestD = Infinity;
  for (let dx = -maxRing; dx <= maxRing; dx++) {
    for (let dz = -maxRing; dz <= maxRing; dz++) {
      if (dx === 0 && dz === 0) continue;
      const d = Math.abs(dx) + Math.abs(dz);
      if (d >= bestD) continue;
      const cand = pickTorchAnchor({ x: x + dx, y, z: z + dz, blockAtFn });
      if (cand.ok && Math.abs(cand.torch_at.y - y) <= 2) {
        best = cand.torch_at;
        bestD = d;
      }
    }
  }
  return best;
}

export function createWaypointActions(deps) {
  const { ensureBot, loadLocations, saveLocations, services } = deps;
  return {
    /**
     * @param {{name?:string, x?:number, y?:number, z?:number, block?:string}} body
     */
    async waypoint(body) {
      const b = ensureBot();
      const name = body?.name != null ? String(body.name).trim() : '';
      if (!name) {
        return fail('INVALID_ARGS', 'Missing waypoint name',
          { retry_safe: false });
      }
      const xRaw = Number(body?.x), yRaw = Number(body?.y), zRaw = Number(body?.z);
      if (![xRaw, yRaw, zRaw].every(Number.isFinite)) {
        return fail('INVALID_ARGS',
          'mc waypoint requires numeric x y z (use the planner-supplied coord)',
          { retry_safe: false });
      }
      const x = Math.round(xRaw), y = Math.round(yRaw), z = Math.round(zRaw);
      const blockName = body?.block ? String(body.block) : 'torch';

      const decision = pickTorchAnchor({
        x, y, z,
        blockAtFn: (p) => b.blockAt(new Vec3(p.x, p.y, p.z)),
      });
      if (!decision.ok) {
        // The planned cell won't take a torch on natural ground. Don't just
        // fail — scan a small ring for a cell that WOULD work and suggest it,
        // so the planner can nudge the waypoint there (§11.1 lateral snap)
        // instead of looping. unloaded_chunk is a move-closer problem, not a
        // route problem, so skip the suggestion there.
        const suggested = decision.reason === 'unloaded_chunk' ? null
          : suggestNearbyAnchor({
              x, y, z,
              blockAtFn: (p) => b.blockAt(new Vec3(p.x, p.y, p.z)),
            });
        const hint = decision.reason === 'fluid_below'
          ? 'Pick a dry cell (the K2 solver should not route a torchable point onto water/lava).'
          : decision.reason === 'unloaded_chunk'
            ? `mc move ${x} ${y} ${z}   # load the chunk first`
            : suggested
              ? `Cell blocked. A nearby cell takes a torch on natural ground: `
                + `mc waypoint ${name} ${suggested.x} ${suggested.y} ${suggested.z}`
              : 'No natural torch cell nearby — this span needs the build role '
                + '(clear/grade it), or re-solve. Do not retry as-is.';
        return fail('NO_TORCH_ANCHOR',
          `Cannot anchor a torch for waypoint '${name}' at (${x},${y},${z}): ${decision.reason}.`,
          {
            observed_state: {
              waypoint: name, requested: { x, y, z }, decision,
              ...(suggested ? { suggested_anchor: suggested } : {}),
            },
            next_action_hint: hint,
            retry_safe: false,
          });
      }

      // ── Persist the private mark FIRST (planner only learns the waypoint
      //    exists by reading the ledger after surveying); torch placement is
      //    best-effort and may need a retry.
      const locs = loadLocations();
      const prev = locs[name];
      const now = new Date().toISOString();
      const moved = !!(prev && (prev.x !== x || prev.y !== y || prev.z !== z));
      const entry = {
        x, y, z,
        saved: prev?.saved ?? now,
        updated: now,
        category: 'waypoint',
        note: prev?.note ?? '',
        radius: prev?.radius ?? null,
        mode: prev?.mode ?? null,
        stale: false,
        stale_reason: null,
        last_visited: prev?.last_visited ?? null,
        visit_count: typeof prev?.visit_count === 'number' ? prev.visit_count : 0,
        torch_at: decision.torch_at,
        ...(moved
          ? { prev_pos: { x: prev.x, y: prev.y, z: prev.z } }
          : prev?.prev_pos
            ? { prev_pos: prev.prev_pos }
            : {}),
      };
      locs[name] = entry;
      saveLocations(locs);

      // ── Place (or no-op if already lit) ──
      let placement;
      if (decision.already_lit) {
        placement = { kind: 'already_lit', placed: false, at: decision.torch_at };
      } else {
        const placeFn = services?.getActions?.()?.place;
        if (typeof placeFn !== 'function') {
          return fail('INTERNAL_ERROR',
            'place action unavailable — waypoint cannot place its torch',
            { retry_safe: true });
        }
        // The torch goes in the route's standable feet cell; if the bot
        // walked onto that exact cell to reach the waypoint, it now blocks
        // its own placement (TARGET_SELF_OCCUPIED). Step aside first so the
        // torch cell is clear. The bot can place from an adjacent cell.
        const t = decision.torch_at;
        const foot = b.entity.position.floored();
        if (foot.x === t.x && foot.y === t.y && foot.z === t.z) {
          await stepOffCell(b, t.x, t.y, t.z);
        }
        const result = await placeFn({
          block: blockName,
          x: decision.torch_at.x,
          y: decision.torch_at.y,
          z: decision.torch_at.z,
        });
        if (!result?.ok) {
          // Mark is already saved; surface place's failure verbatim, augment
          // observed_state so the planner sees this is a waypoint torch.
          return {
            ok: false,
            error: {
              ...result.error,
              observed_state: {
                ...(result.error?.observed_state || {}),
                waypoint: name,
                waypoint_saved: true,
                anchor_at: decision.anchor_at,
                torch_cell: decision.torch_at,
              },
            },
          };
        }
        placement = { kind: 'placed', placed: true, at: decision.torch_at, block: blockName };
      }

      // ── Old-torch cleanup when the waypoint moved ──
      let nextHint = null;
      let oldTorch = null;
      if (moved) {
        const old = entry.prev_pos;
        const oldBlk = b.blockAt(new Vec3(old.x, old.y, old.z));
        const dist = b.entity.position.distanceTo(new Vec3(old.x, old.y, old.z));
        if (oldBlk && TORCH_NAMES.has(oldBlk.name) && dist <= 4.5) {
          try {
            await b.dig(oldBlk, true);
            oldTorch = { at: old, kind: 'dug' };
          } catch {
            oldTorch = { at: old, kind: 'dig_failed' };
            nextHint = `old torch at (${old.x},${old.y},${old.z}) — remove when nearby (mc dig ${old.x} ${old.y} ${old.z})`;
          }
        } else if (oldBlk && TORCH_NAMES.has(oldBlk.name)) {
          oldTorch = { at: old, kind: 'out_of_reach' };
          nextHint = `old torch at (${old.x},${old.y},${old.z}) — remove when nearby (mc dig ${old.x} ${old.y} ${old.z})`;
        } else {
          oldTorch = { at: old, kind: oldBlk ? 'already_gone' : 'unloaded' };
        }
      }

      return ok({
        result: `Waypoint '${name}' at (${x},${y},${z}); torch ${
          placement.kind === 'placed' ? 'placed' : 'already lit'
        } at (${placement.at.x},${placement.at.y},${placement.at.z})${
          oldTorch && oldTorch.kind === 'dug' ? ` (old torch dug)` : ''}`,
        data: {
          waypoint: name,
          position: { x, y, z },
          torch_at: placement.at,
          anchor_at: decision.anchor_at,
          anchor_block: decision.anchor_block,
          placement: placement.kind,
          moved,
          ...(oldTorch ? { old_torch: oldTorch } : {}),
          mark: entry,
        },
        ...(nextHint ? { next_action_hint: nextHint } : {}),
      });
    },
  };
}
