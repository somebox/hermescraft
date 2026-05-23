import { fail } from './_contract.js';

/**
 * v26 deprecation gate. Direct external calls to mc sail / mc board /
 * mc place_boat are footguns: agents fall back to them when sail_to
 * returns a partial route, then crash through obstacles BFS deliberately
 * routed around. Refuse external calls with a USE_SAIL_TO_INSTEAD
 * redirect. sail_to calls these methods in-process with _from_sail_to:true
 * to bypass — the bodyFn in cli/registry.mjs never includes that key, so
 * HTTP /action/sail etc. can't spoof it from the agent's CLI surface.
 *
 * mc disembark stays open — it's a legitimate recovery verb (force-free
 * the bot from any vehicle without needing a destination).
 */
export function useSailToInsteadRefusal(verb) {
  return fail(
    'USE_SAIL_TO_INSTEAD',
    `Direct mc ${verb} is deprecated. For water journeys call mc sail_to X Y Z — the body handles place_boat / board / sail / disembark internally with BFS routing, partial-journey support, and resumability. Don't compose this primitive manually.`,
    {
      next_action_hint: 'mc sail_to <target_x> <target_y> <target_z>',
      retry_safe: false,
    },
  );
}
