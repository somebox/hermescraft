/**
 * F53.5 — Chat-banner injection.
 *
 * After a sync action completes, prepend a `[!]` line to `result.result`
 * when there are unread messages — especially direct ones or ones that
 * mention the bot by name. Brain can't easily miss this even if it ignores
 * `state.new_chat`.
 *
 * Skip the banner for `read_chat` / `chat` / `whisper` themselves to avoid
 * recursion and noise on chat-handling turns.
 *
 * Post-middleware:
 *   apply(services, body, actionName, result, meta) → newResult | undefined
 *     Returns a new result with the banner prepended, or undefined to keep
 *     the original. Requires `meta.briefState` to fetch state.new_chat.
 */

const NO_BANNER_VERBS = Object.freeze(new Set(['read_chat', 'chat', 'whisper']));
const NEW_CHAT_THRESHOLD = 3; // emit even without mentions when this many unread

/**
 * @param {{ state: { world: { bot: any } } }} services
 * @param {Record<string, any>} body
 * @param {string} actionName
 * @param {any} result
 * @param {{ briefState?: () => any, [k:string]: any }} meta
 */
export function apply(services, body, actionName, result, meta) {
  if (NO_BANNER_VERBS.has(actionName)) return undefined;
  if (!result || typeof meta.briefState !== 'function') return undefined;

  const state = meta.briefState();
  if (!state || !state.new_chat || state.new_chat.length === 0) return undefined;

  const myName = services.state.world.bot?.username || '';
  const myNameLower = myName.toLowerCase();
  const mentions = myName
    ? state.new_chat.filter((m) => {
        const msg = String(m.message || '').toLowerCase();
        return msg.includes(`@${myNameLower}`)
          || msg.includes(myNameLower + ':')
          || msg.includes(myNameLower + ',');
      })
    : [];
  const directCount = state.new_chat.filter((m) => m.direct).length;
  if (mentions.length === 0 && directCount === 0 && state.new_chat.length < NEW_CHAT_THRESHOLD) {
    return undefined;
  }

  const parts = [`[!] ${state.new_chat.length} unread chat`];
  if (mentions.length > 0) parts.push(`${mentions.length} mention you`);
  if (directCount > 0) parts.push(`${directCount} direct`);
  const banner = parts.join(', ') + ' — see state.new_chat or call mc read_chat';

  if (typeof result.result === 'string') {
    return { ...result, result: `${banner}\n${result.result}` };
  }
  return { ...result, result: banner };
}
