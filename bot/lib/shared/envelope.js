/**
 * Internal Envelope helpers (P9 wire format stays `error.next_action_hint: string`).
 * Routers and telemetry use typed suggested-next; HTTP boundary uses formatSuggested().
 */

/**
 * @typedef {{ verb: string, args?: string | string[], why?: string }} SuggestedNext
 */

/**
 * @typedef {{
 *   ok: true,
 *   data?: Record<string, unknown>,
 *   extras?: Record<string, unknown>,
 * }} EnvelopeOk
 */

/**
 * @typedef {{
 *   ok: false,
 *   code: string,
 *   message: string,
 *   suggested?: SuggestedNext | string,
 *   retry_safe?: boolean,
 *   observed_state?: Record<string, unknown>,
 * }} EnvelopeFail
 */

/** @typedef {EnvelopeOk | EnvelopeFail} Envelope */

/**
 * Normalize an action-contract result into an internal envelope.
 * @param {import('./action-contract.js').ActionResult | Record<string, unknown>} actionResult
 * @returns {Envelope}
 */
export function fromAction(actionResult) {
  if (!actionResult || typeof actionResult !== 'object') {
    return { ok: false, code: 'INVALID_RESULT', message: 'Action result is not an object', retry_safe: false };
  }
  const r = /** @type {Record<string, unknown>} */ (actionResult);
  if (r.ok === true) {
    const { data, result, error, ok: _ok, ...extras } = r;
    /** @type {EnvelopeOk} */
    const out = { ok: true, extras: { ...extras } };
    if (data !== undefined && typeof data === 'object' && data !== null) {
      out.data = /** @type {Record<string, unknown>} */ (data);
    }
    if (result !== undefined) out.extras.result = result;
    return out;
  }
  if (r.ok === false) {
    const err = /** @type {Record<string, unknown>} */ (r.error || {});
    /** @type {EnvelopeFail} */
    const out = {
      ok: false,
      code: String(err.code || 'UNKNOWN'),
      message: String(err.message || 'failure'),
      retry_safe: Boolean(err.retry_safe),
    };
    if (err.observed_state !== undefined && typeof err.observed_state === 'object') {
      out.observed_state = /** @type {Record<string, unknown>} */ (err.observed_state);
    }
    if (typeof err.next_action_hint === 'string' && err.next_action_hint.trim()) {
      out.suggested = err.next_action_hint.trim();
    }
    return out;
  }
  return { ok: false, code: 'INVALID_RESULT', message: 'result.ok must be boolean', retry_safe: false };
}

/**
 * Serialize structured or string suggested-next to P9 one-line hint.
 * @param {SuggestedNext | string | null | undefined} suggested
 * @returns {string | undefined}
 */
export function formatSuggested(suggested) {
  if (suggested == null) return undefined;
  if (typeof suggested === 'string') {
    const t = suggested.trim();
    return t || undefined;
  }
  if (typeof suggested !== 'object') return undefined;
  const verb = String(suggested.verb || '').trim();
  if (!verb) return undefined;
  let line = verb.startsWith('mc ') ? verb : `mc ${verb}`;
  const args = suggested.args;
  if (args !== undefined && args !== null) {
    if (Array.isArray(args)) {
      const parts = args.map((a) => String(a)).filter(Boolean);
      if (parts.length) line += ` ${parts.join(' ')}`;
    } else {
      const a = String(args).trim();
      if (a) line += ` ${a}`;
    }
  }
  const why = suggested.why != null ? String(suggested.why).trim() : '';
  if (why) line += `  # ${why}`;
  return line;
}

/**
 * Attach P9 next_action_hint on a fail() options bag from structured suggested.
 * @param {SuggestedNext | string | null | undefined} suggested
 * @returns {{ next_action_hint?: string }}
 */
export function suggestedToFailOpts(suggested) {
  const hint = formatSuggested(suggested);
  return hint ? { next_action_hint: hint } : {};
}
