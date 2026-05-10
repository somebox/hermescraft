/**
 * Movement action handlers: goto, goto_near, follow, look, stop.
 */
import { Vec3 } from 'vec3';

export function createMovementActions({ ensureBot, goals, fmt, posObj }) {
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
  };
}
