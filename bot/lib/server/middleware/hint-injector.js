/**
 * Inject P9 next_action_hint on selected failure codes when missing (#58 fallback / brief off).
 */
import { standingState } from '../../actions/_nav-helpers.js';
import { buildNavFrame } from '../../runtime/nav-brief.js';

const ALLOWED_ACTIONS = new Set(['move', 'goto', 'goto_near', 'collect', 'craft']);
const HINT_CODES = new Set(['NAV_BLOCKED', 'NAV_TARGET_UNSTANDABLE', 'BOT_ON_PILLAR', 'MISSING_INGREDIENTS']);

/** Per-process dedup store; keys include `config.mc.username` so distinct bot servers never share TTL (one Node process per profile in fleet). */
/** @type {Map<string, number>} */
const recentHints = new Map();
const DEDUP_MS = 60_000;

function dedupKey(ctx, services, actionName, code) {
  const profile = String(services.config?.mc?.username || 'unknown').toLowerCase();
  const pc = ctx.runtime?.playbook_context;
  if (pc?.playbook_id && pc?.phase) {
    return `${profile}|${pc.playbook_id}|${pc.phase}|${code}`;
  }
  return `${profile}|${actionName}|${code}`;
}

function hintFromBrief(ctx, services, actionName, code) {
  const bot = ctx?.world?.bot;
  if (!bot) return undefined;
  const frame = buildNavFrame(ctx, {
    getStandingState: (b) => standingState(b),
    loadLocations: services.locations?.load,
  });
  return frame.header?.suggested_hint;
}

export function apply(services, body, actionName, result) {
  if (!result || result.ok !== false || !result.error) return undefined;
  const code = String(result.error.code || '');
  if (!ALLOWED_ACTIONS.has(actionName) || !HINT_CODES.has(code)) return undefined;
  if (typeof result.error.next_action_hint === 'string' && result.error.next_action_hint.trim()) {
    return undefined;
  }
  const ctx = services.state;
  const key = dedupKey(ctx, services, actionName, code);
  const now = Date.now();
  const last = recentHints.get(key);
  if (last && now - last < DEDUP_MS) return undefined;

  const hint = hintFromBrief(ctx, services, actionName, code);
  if (!hint) return undefined;
  recentHints.set(key, now);
  return {
    ...result,
    error: {
      ...result.error,
      next_action_hint: hint,
    },
  };
}

/** Test hook */
export function _resetHintDedupForTests() {
  recentHints.clear();
}
