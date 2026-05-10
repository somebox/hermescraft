/**
 * Movement action handlers: goto, goto_near, follow, look, stop, move.
 */
import { Vec3 } from 'vec3';

export function createMovementActions({ ensureBot, goals, fmt, posObj, ACTIONS }) {
  // Pathfinder is read-only (no canDig, no scaffolding). When it can't find
  // a path, it returns "No path to the goal!" — that's the agent's signal
  // that the route is blocked and intentional action is needed (mc through
  // for a door, mc tunnel/dig_area to clear terrain). These helpers shape
  // those failures into a consistent action-contract response.
  const navBlockedError = (pos, x, y, z, dist) => ({
    ok: false,
    error: {
      code: 'NAV_BLOCKED',
      message: `Pathfinder gave up at ${pos.x},${pos.y},${pos.z} — ${dist.toFixed(1)} blocks from target ${fmt(x)},${fmt(y)},${fmt(z)}. The path is blocked. Try mc through GX GY GZ for a door/gate, or mc tunnel / mc dig_area to clear terrain explicitly.`,
      observed_state: { current: pos, target: { x, y, z }, distance: Number(dist.toFixed(1)) },
      retry_safe: false,
    },
  });
  const navFailureError = (pos, x, y, z, msg) => {
    if (msg === 'timeout') {
      return {
        ok: false,
        error: {
          code: 'NAV_TIMEOUT',
          message: `Walked toward ${fmt(x)},${fmt(y)},${fmt(z)} for 15s, now at ${pos.x},${pos.y},${pos.z}. Use mc bg_goto for long distances or mc through for doors.`,
          observed_state: { current: pos, target: { x, y, z } },
          retry_safe: true,
        },
      };
    }
    if (/no path/i.test(msg)) {
      return {
        ok: false,
        error: {
          code: 'NAV_BLOCKED',
          message: `No path to ${fmt(x)},${fmt(y)},${fmt(z)} from ${pos.x},${pos.y},${pos.z}. Pathfinder is non-destructive — if a door blocks the path use mc through GX GY GZ; if terrain blocks it use mc tunnel or mc dig_area to clear it explicitly.`,
          observed_state: { current: pos, target: { x, y, z } },
          retry_safe: false,
        },
      };
    }
    return {
      ok: false,
      error: { code: 'NAV_FAILED', message: `Navigation failed: ${msg}`, observed_state: { current: pos, target: { x, y, z } }, retry_safe: false },
    };
  };

  return {
    async goto({ x, y, z }) {
      const b = ensureBot();
      const goal = new goals.GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z));
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000));
      try {
        await Promise.race([b.pathfinder.goto(goal), timeout]);
        const pos = posObj();
        const dist = Math.hypot(pos.x - x, pos.y - y, pos.z - z);
        if (dist > 2) {
          return navBlockedError(pos, x, y, z, dist);
        }
        return { result: `Arrived at ${fmt(x)}, ${fmt(y)}, ${fmt(z)}` };
      } catch (e) {
        try { b.pathfinder.setGoal(null); } catch {}
        const pos = posObj();
        return navFailureError(pos, x, y, z, e?.message || String(e));
      }
    },

    async goto_near({ x, y, z, range = 2 }) {
      const b = ensureBot();
      const goal = new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), range);
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000));
      try {
        await Promise.race([b.pathfinder.goto(goal), timeout]);
        const pos = posObj();
        const dist = Math.hypot(pos.x - x, pos.y - y, pos.z - z);
        if (dist > range + 1.5) {
          return navBlockedError(pos, x, y, z, dist);
        }
        return { result: `Arrived near ${fmt(x)}, ${fmt(y)}, ${fmt(z)}` };
      } catch (e) {
        try { b.pathfinder.setGoal(null); } catch {}
        const pos = posObj();
        return navFailureError(pos, x, y, z, e?.message || String(e));
      }
    },

    async follow({ player }) {
      const b = ensureBot();
      const entity = Object.values(b.entities).find(e =>
        e !== b.entity && (
          (e.username || '').toLowerCase() === player.toLowerCase() ||
          (e.name || '').toLowerCase() === player.toLowerCase()
        )
      );
      if (!entity) throw new Error(`Player/entity "${player}" not found nearby.`);
      b.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true);
      return { result: `Following ${player}. Use /action/stop to stop.` };
    },

    async look({ x, y, z }) {
      const b = ensureBot();
      await b.lookAt(new Vec3(x, y, z));
      return { result: `Looking at ${x}, ${y}, ${z}` };
    },

    async stop() {
      const b = ensureBot();
      b.pathfinder.setGoal(null);
      try { b.stopDigging(); } catch {}
      if (b.pvp) try { b.pvp.stop(); } catch {}
      return { result: 'Stopped all actions.' };
    },

    /**
     * Smart non-destructive navigation. Like mc goto, but on NAV_BLOCKED
     * automatically detects a door/gate between the bot and the target,
     * opens it via mc through (which closes it behind), and recurses from
     * the new position. Up to max_doors legs (default 5).
     *
     * Args:
     *   x, y, z              — destination
     *   max_doors            — optional, default 5, capped at 10
     *   door: {x,y,z}        — optional explicit override; use this door first
     */
    async move({ x, y, z, max_doors, door }) {
      const b = ensureBot();
      if (![x, y, z].every((v) => Number.isFinite(Number(v)))) {
        return { ok: false, error: { code: 'INVALID_COORD', message: 'mc move requires numeric x, y, z', retry_safe: false } };
      }
      const target = { x: Number(x), y: Number(y), z: Number(z) };
      const maxDoors = Math.min(Math.max(parseInt(String(max_doors ?? 5), 10) || 5, 1), 10);

      // Find passable doors (wooden _door + *_fence_gate; skip iron_door and trapdoors).
      const isPassable = (name) =>
        (/(_door|_fence_gate)$/.test(name)) && !name.startsWith('iron_') && !name.endsWith('_trapdoor');

      const findBestDoor = () => {
        const me = b.entity.position;
        const targetVec = new Vec3(target.x, target.y, target.z);
        const myDist = me.distanceTo(targetVec);
        const positions = b.findBlocks({
          matching: (block) => isPassable(block.name),
          maxDistance: 32,
          count: 30,
        });
        let best = null;
        let bestScore = Infinity;
        for (const dPos of positions) {
          const dBlock = b.blockAt(dPos);
          if (!dBlock) continue;
          // Skip upper halves of doors so we don't pick the same door twice.
          const props = (typeof dBlock.getProperties === 'function') ? dBlock.getProperties() : {};
          if (props.half === 'upper') continue;
          // Compute far_side (toward target) and near_side (away from target)
          // along the dominant axis between door and target.
          const ddx = target.x - dPos.x;
          const ddz = target.z - dPos.z;
          let farSide, nearSide;
          if (Math.abs(ddx) >= Math.abs(ddz)) {
            const dir = Math.sign(ddx || 1);
            farSide = new Vec3(dPos.x + dir * 2, target.y, dPos.z);
            nearSide = new Vec3(dPos.x - dir * 2, target.y, dPos.z);
          } else {
            const dir = Math.sign(ddz || 1);
            farSide = new Vec3(dPos.x, target.y, dPos.z + dir * 2);
            nearSide = new Vec3(dPos.x, target.y, dPos.z - dir * 2);
          }
          // Far side must be strictly closer to target than the bot currently is.
          const farDist = farSide.distanceTo(targetVec);
          if (farDist >= myDist - 0.5) continue;
          // Score by dist(bot, near_side) — closest reachable door wins.
          // In multi-door buildings this picks the door in the bot's current
          // room first; later legs pick deeper doors as bot advances.
          const nearDist = me.distanceTo(nearSide);
          if (nearDist < bestScore) {
            bestScore = nearDist;
            best = { pos: dPos, block: dBlock.name, near_side: nearSide, far_side: farSide, near_dist: nearDist, far_dist: farDist };
          }
        }
        return best;
      };

      const nearbyDoorList = () =>
        b.findBlocks({
          matching: (block) => isPassable(block.name),
          maxDistance: 32,
          count: 8,
        }).map((p) => {
          const blk = b.blockAt(p);
          const props = (typeof blk?.getProperties === 'function') ? blk.getProperties() : {};
          return { x: p.x, y: p.y, z: p.z, block: blk?.name || 'unknown', open: props.open === 'true' || props.open === true };
        }).filter((d) => {
          const blk = b.blockAt(new Vec3(d.x, d.y, d.z));
          const props = (typeof blk?.getProperties === 'function') ? blk.getProperties() : {};
          return props.half !== 'upper';
        });

      const doors_used = [];
      let lastPathfinderError = null;

      for (let leg = 1; leg <= maxDoors + 1; leg++) {
        // Try direct pathfinder.goto.
        const goal = new goals.GoalBlock(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z));
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000));
        try {
          await Promise.race([b.pathfinder.goto(goal), timeout]);
        } catch (e) {
          lastPathfinderError = e?.message || String(e);
          try { b.pathfinder.setGoal(null); } catch {}
        }

        const pos = posObj();
        const dist = Math.hypot(pos.x - target.x, pos.y - target.y, pos.z - target.z);
        if (dist <= 2) {
          return {
            ok: true,
            data: {
              doors_used,
              legs: leg,
              end_position: pos,
            },
            result: `Arrived at ${fmt(target.x)}, ${fmt(target.y)}, ${fmt(target.z)}${doors_used.length ? ` via ${doors_used.length} door${doors_used.length > 1 ? 's' : ''}` : ''}`,
          };
        }

        // Pick a door to traverse.
        let chosen;
        if (leg === 1 && door && Number.isFinite(Number(door.x)) && Number.isFinite(Number(door.y)) && Number.isFinite(Number(door.z))) {
          const dPos = new Vec3(Number(door.x), Number(door.y), Number(door.z));
          const dBlock = b.blockAt(dPos);
          if (!dBlock || !isPassable(dBlock.name)) {
            return {
              ok: false,
              error: {
                code: 'NAV_BLOCKED',
                message: `--door at ${door.x},${door.y},${door.z} is not a passable door/gate (block: ${dBlock?.name || 'unknown'})`,
                observed_state: { current: pos, target, doors_used, requested_door: door },
                retry_safe: false,
              },
            };
          }
          const ddx = target.x - dPos.x;
          const ddz = target.z - dPos.z;
          const farSide = (Math.abs(ddx) >= Math.abs(ddz))
            ? new Vec3(dPos.x + Math.sign(ddx || 1) * 2, target.y, dPos.z)
            : new Vec3(dPos.x, target.y, dPos.z + Math.sign(ddz || 1) * 2);
          chosen = { pos: dPos, block: dBlock.name, far_side: farSide };
        } else {
          chosen = findBestDoor();
        }

        if (!chosen) {
          return {
            ok: false,
            error: {
              code: 'NAV_BLOCKED',
              message: `No path to ${fmt(target.x)},${fmt(target.y)},${fmt(target.z)} from ${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)} and no door/gate between to use. Use mc tunnel or mc dig_area to clear terrain explicitly.`,
              observed_state: { current: pos, target, doors_used, nearby_doors: nearbyDoorList(), pathfinder_error: lastPathfinderError },
              retry_safe: false,
            },
          };
        }

        // Traverse via mc through (opens + walks + closes).
        const through = await ACTIONS.through({
          gx: chosen.pos.x, gy: chosen.pos.y, gz: chosen.pos.z,
          dx: chosen.far_side.x, dy: chosen.far_side.y, dz: chosen.far_side.z,
        });

        if (!through.ok) {
          return {
            ok: false,
            error: {
              code: 'NAV_BLOCKED',
              message: `Could not traverse ${chosen.block} at ${chosen.pos.x},${chosen.pos.y},${chosen.pos.z}: ${through.error?.message || 'through failed'}`,
              observed_state: { current: posObj(), target, doors_used, failed_door: { x: chosen.pos.x, y: chosen.pos.y, z: chosen.pos.z, block: chosen.block }, through_error: through.error },
              retry_safe: through.error?.retry_safe ?? false,
            },
          };
        }

        doors_used.push({
          x: chosen.pos.x, y: chosen.pos.y, z: chosen.pos.z,
          block: chosen.block,
          closed: through.data?.closed ?? false,
        });
      }

      return {
        ok: false,
        error: {
          code: 'TOO_MANY_DOORS',
          message: `Used max ${maxDoors} doors without reaching ${fmt(target.x)},${fmt(target.y)},${fmt(target.z)}. Building may have a routing loop or be too complex; try mc move --door X Y Z to pick a specific door.`,
          observed_state: { doors_used, target, current: posObj() },
          retry_safe: false,
        },
      };
    },
  };
}
