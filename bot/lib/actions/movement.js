/**
 * Movement action handlers: goto, goto_near, follow, look, stop.
 */
import { Vec3 } from 'vec3';

export function createMovementActions({ ensureBot, goals, fmt, posObj }) {
  return {
    async goto({ x, y, z }) {
      const b = ensureBot();
      const goal = new goals.GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z));
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000));
      try {
        await Promise.race([b.pathfinder.goto(goal), timeout]);
        return { result: `Arrived at ${fmt(x)}, ${fmt(y)}, ${fmt(z)}` };
      } catch (e) {
        try { b.pathfinder.setGoal(null); } catch {}
        const pos = posObj();
        if (e.message === 'timeout') return { result: `Walked toward ${fmt(x)},${fmt(y)},${fmt(z)} for 15s, now at ${pos.x},${pos.y},${pos.z}. Use mc bg_goto for long distances.` };
        return { result: `Navigation failed: ${e.message}. Try mc bg_goto instead.` };
      }
    },

    async goto_near({ x, y, z, range = 2 }) {
      const b = ensureBot();
      const goal = new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), range);
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000));
      try {
        await Promise.race([b.pathfinder.goto(goal), timeout]);
        return { result: `Arrived near ${fmt(x)}, ${fmt(y)}, ${fmt(z)}` };
      } catch (e) {
        try { b.pathfinder.setGoal(null); } catch {}
        const pos = posObj();
        if (e.message === 'timeout') return { result: `Walked toward ${fmt(x)},${fmt(y)},${fmt(z)} for 15s, now at ${pos.x},${pos.y},${pos.z}. Use mc bg_goto for long distances.` };
        return { result: `Navigation failed: ${e.message}. Try mc bg_goto instead.` };
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
