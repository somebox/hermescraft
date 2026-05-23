/**
 * F51.2 — Position-dependent verb guard.
 *
 * After a failed `mc move`/`goto`/`goto_near`, the bot's position model is
 * unreliable. Subsequent verbs that target a coordinate *near* the
 * failed-move target are highly likely to fail too — in prior runs they
 * cascaded into 5–10 wasted commands per failure. This guard short-circuits
 * them with a structured `MOVEMENT_PRECONDITION_FAILED` diagnostic.
 *
 * Passive verbs (chat, status, inventory, scene, etc.) are always allowed
 * so the brain can recover.
 *
 * The flag (`ctx.runtime.lastMoveFailed`) clears on:
 *   - next successful move (set by the movement handlers themselves)
 *   - `mc status` call (explicit acknowledgement — handled in http-app.js)
 *   - 30s decay (handled by this middleware)
 *
 * Middleware contract (per docs/archive/refactor-plan-2026.md § Assembly rules):
 *   check(services, body, actionName) → { intercept: true, response } | { intercept: false }
 *
 * The function may mutate `services.state.runtime.lastMoveFailed` as a
 * side effect of the 30s decay; this matches the pre-extraction behaviour.
 */

import { fail } from '../../shared/action-contract.js';

/** Verbs that read the bot's position and target a coordinate. Editing this
 *  set widens or narrows the guard's blast radius. */
export const POSITION_DEPENDENT_VERBS = Object.freeze(new Set([
  'place', 'dig', 'safe_dig', 'fill',
  'interact', 'through',
  'deposit', 'withdraw', 'chest_search',
  'place_at_mark',
  'fence', 'tunnel', 'stair_up', 'stair_down',
]));

const FAILURE_TTL_MS = 30_000;
const NEAR_RADIUS = 5;

/**
 * Extract the primary target coord from a request body. Most verbs use
 * `{x, y, z}`; `fill`/`place_fill` use `x1/y1/z1`.
 * @param {Record<string, any>} body
 * @returns {{x:number, y:number, z:number} | null}
 */
function targetFromBody(body) {
  if (!body) return null;
  const x = Number.isFinite(Number(body.x)) ? Number(body.x)
    : (Number.isFinite(Number(body.x1)) ? Number(body.x1) : null);
  const y = Number.isFinite(Number(body.y)) ? Number(body.y)
    : (Number.isFinite(Number(body.y1)) ? Number(body.y1) : null);
  const z = Number.isFinite(Number(body.z)) ? Number(body.z)
    : (Number.isFinite(Number(body.z1)) ? Number(body.z1) : null);
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

/**
 * Pre-action check.
 *
 * @param {{ state: { runtime: { lastMoveFailed: any } } }} services
 * @param {Record<string, any>} body
 * @param {string} actionName
 * @returns {{ intercept: true, response: any } | { intercept: false }}
 */
export function check(services, body, actionName) {
  const { state } = services;
  // 30s decay: drop stale failures regardless of which verb is calling.
  if (state.runtime.lastMoveFailed && (Date.now() - state.runtime.lastMoveFailed.ts) > FAILURE_TTL_MS) {
    state.runtime.lastMoveFailed = null;
  }
  if (!POSITION_DEPENDENT_VERBS.has(actionName)) return { intercept: false };
  if (!state.runtime.lastMoveFailed) return { intercept: false };

  const target = targetFromBody(body);
  if (!target) return { intercept: false };

  const lmf = state.runtime.lastMoveFailed;
  const dx = target.x - lmf.intended_target.x;
  const dy = target.y - lmf.intended_target.y;
  const dz = target.z - lmf.intended_target.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist > NEAR_RADIUS) return { intercept: false };

  const ageS = Math.round((Date.now() - lmf.ts) / 100) / 10;
  const response = fail(
    'MOVEMENT_PRECONDITION_FAILED',
    `Can't run mc ${actionName} at ${target.x},${target.y},${target.z} — your previous mc ${lmf.verb} to ${lmf.intended_target.x},${lmf.intended_target.y},${lmf.intended_target.z} failed ${ageS}s ago (${lmf.reason}). You're at ${lmf.actual_pos?.x ?? '?'},${lmf.actual_pos?.y ?? '?'},${lmf.actual_pos?.z ?? '?'}, not where you intended. Run \`mc status\` to recheck your position, or retry \`mc move\` first. (Flag clears on next successful move OR mc status OR 30s.)`,
    {
      observed_state: {
        attempted_verb: actionName,
        attempted_target: target,
        last_failed_move: lmf,
      },
      retry_safe: false,
    },
  );
  return { intercept: true, response };
}
