/**
 * F53.6 — `reason=` auto-announce.
 *
 * If the request body has a `reason` string AND the action is in the
 * LONG_VERBS set (expected to take >5s), emit a chat
 * `"<name>: starting <verb> — <reason>"` before the action runs. After the
 * action returns, if it took >3s, emit a completion line. Brain doesn't
 * have to remember to announce — passing `reason='intent'` gets it for free.
 *
 * Pre-middleware:
 *   check(services, body, actionName, meta) → { intercept: false }
 *     Side effect: emits the start chat line if applicable. Records
 *     `meta.announceStart = true` (and `meta.announceStartedAt`) so the
 *     post phase can decide whether to fire the completion line.
 *
 * Post-middleware:
 *   apply(services, body, actionName, result, meta) → undefined
 *     Fires the completion chat if the start was fired AND elapsed >3s.
 *     Never mutates result.
 */

const LONG_VERBS = Object.freeze(new Set([
  'collect', 'goto', 'goto_near', 'go_mark', 'move',
  'fill', 'place_fill', 'wall',
  'craft', 'smelt',
  'dig', 'tunnel', 'stair_up', 'stair_down',
]));

const REASON_MAX_LEN = 120;
const ANNOUNCE_COMPLETE_THRESHOLD_MS = 3000;

function takeReason(body) {
  return (typeof body?.reason === 'string' && body.reason.trim().length > 0)
    ? body.reason.trim().slice(0, REASON_MAX_LEN)
    : null;
}

/**
 * @param {{ ensureBot: () => any, state: { world: { bot: any } } }} services
 * @param {Record<string, any>} body
 * @param {string} actionName
 * @param {{ announceStart?: boolean, announceStartedAt?: number, [k:string]:any }} meta
 */
export function check(services, body, actionName, meta) {
  const reason = takeReason(body);
  if (!reason || !LONG_VERBS.has(actionName)) {
    return { intercept: false };
  }
  meta.announceReason = reason;
  meta.announceStart = true;
  meta.announceStartedAt = Date.now();
  try {
    const myName = services.state.world.bot?.username || 'bot';
    services.ensureBot().chat(`${myName}: starting ${actionName} — ${reason}`);
  } catch { /* never block the action on the announce */ }
  return { intercept: false };
}

/**
 * @param {{ ensureBot: () => any, state: { world: { bot: any } } }} services
 * @param {Record<string, any>} body
 * @param {string} actionName
 * @param {any} result
 * @param {{ announceStart?: boolean, announceStartedAt?: number }} meta
 */
export function apply(services, body, actionName, result, meta) {
  if (!meta.announceStart) return undefined;
  const elapsedMs = Date.now() - meta.announceStartedAt;
  if (elapsedMs <= ANNOUNCE_COMPLETE_THRESHOLD_MS) return undefined;
  try {
    const myName = services.state.world.bot?.username || 'bot';
    const elapsedS = Math.round(elapsedMs / 100) / 10;
    const softFailure = result && typeof result === 'object' && result.ok === false;
    const verb = softFailure
      ? `${actionName} failed (${result.error?.code || 'error'}) after ${elapsedS}s`
      : `done ${actionName} (${elapsedS}s)`;
    services.ensureBot().chat(`${myName}: ${verb}`);
  } catch { /* ignore */ }
  return undefined;
}

export { LONG_VERBS };
