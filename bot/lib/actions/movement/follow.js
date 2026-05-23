import { ok, fail } from '../../shared/action-contract.js';

/**
 * @param {object} deps
 */
export function createFollow({ ensureBot, goals }) {
  return async function follow({ player }) {
    const b = ensureBot();
    const entity = Object.values(b.entities).find(e =>
      e !== b.entity && (
        (e.username || '').toLowerCase() === player.toLowerCase() ||
        (e.name || '').toLowerCase() === player.toLowerCase()
      ),
    );
    if (!entity) return fail('NO_TARGET', `Player/entity "${player}" not found nearby.`, { retry_safe: false });
    b.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true);
    return ok({ result: `Following ${player}. Use /action/stop to stop.` });
  };
}
