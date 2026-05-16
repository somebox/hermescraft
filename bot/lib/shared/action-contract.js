/**
 * Action contract — uniform success/failure shape for every `mc <verb>` handler.
 *
 * Per docs/patterns.md P9 and docs/phase-2/action-contracts.md. Every action
 * handler returns an ActionResult:
 *
 *   success: { ok: true, data?, result?, ...extras }
 *   failure: { ok: false, error: { code, message, observed_state?, next_action_hint?, retry_safe } }
 *
 * @typedef {{ ok: true } & Record<string, any>} ActionOk
 * @typedef {{
 *   code: string,
 *   message: string,
 *   observed_state?: Record<string, any>,
 *   next_action_hint?: string,
 *   retry_safe: boolean,
 * }} ActionError
 * @typedef {{ ok: false, error: ActionError } & Record<string, any>} ActionFail
 * @typedef {ActionOk | ActionFail} ActionResult
 */

/**
 * Build a success result. Any extra keys are spread onto the result alongside
 * `data` and `result` so callers can keep returning verb-specific fields
 * (e.g. `state`, `partial_failure`) without us having to enumerate them.
 *
 * @param {{ data?: object, result?: string, [k: string]: any }} [body]
 * @returns {ActionOk}
 */
export function ok(body = {}) {
  const { data, result, ...extras } = body;
  const out = { ok: true, ...extras };
  if (data !== undefined) out.data = data;
  if (result !== undefined) out.result = result;
  return out;
}

/**
 * Build a failure result.
 *
 * @param {string} code  SCREAMING_SNAKE constant, e.g. 'OUT_OF_RANGE'.
 * @param {string} message  Human-readable explanation.
 * @param {{
 *   observed_state?: Record<string, any>,
 *   next_action_hint?: string,
 *   retry_safe?: boolean,
 * }} [opts]
 * @returns {ActionFail}
 */
export function fail(code, message, opts = {}) {
  const { observed_state, next_action_hint, retry_safe = false } = opts;
  const error = { code: String(code), message: String(message), retry_safe: Boolean(retry_safe) };
  if (observed_state !== undefined) error.observed_state = observed_state;
  if (next_action_hint !== undefined) error.next_action_hint = next_action_hint;
  return { ok: false, error };
}

/**
 * Validate that a value conforms to the ActionResult contract. Returns
 * { valid: true } on conformance, or { valid: false, issues: [...] } with a
 * list of contract violations. Used by tests and the dev-mode validator
 * (HERMES_VALIDATE=1) — handlers themselves should use ok()/fail() so
 * they conform by construction.
 *
 * @param {unknown} result
 * @returns {{ valid: true, issues: [] } | { valid: false, issues: string[] }}
 */
export function validate(result) {
  const issues = [];
  if (result === null || typeof result !== 'object') {
    return { valid: false, issues: ['result is not an object'] };
  }
  const r = /** @type {Record<string, any>} */ (result);
  if (typeof r.ok !== 'boolean') {
    issues.push('result.ok must be a boolean');
  }
  if (r.ok === false) {
    const err = r.error;
    if (err === null || typeof err !== 'object') {
      issues.push('result.error must be an object when ok=false');
    } else {
      if (typeof err.code !== 'string' || !err.code) {
        issues.push('result.error.code must be a non-empty string');
      } else if (err.code !== err.code.toUpperCase() || /\s/.test(err.code)) {
        issues.push('result.error.code must be SCREAMING_SNAKE_CASE');
      }
      if (typeof err.message !== 'string' || !err.message) {
        issues.push('result.error.message must be a non-empty string');
      }
      if (typeof err.retry_safe !== 'boolean') {
        issues.push('result.error.retry_safe must be a boolean');
      }
      if (err.observed_state !== undefined && (err.observed_state === null || typeof err.observed_state !== 'object')) {
        issues.push('result.error.observed_state must be an object when present');
      }
      if (err.next_action_hint !== undefined && typeof err.next_action_hint !== 'string') {
        issues.push('result.error.next_action_hint must be a string when present');
      }
    }
  } else if (r.ok === true) {
    if (r.error !== undefined) {
      issues.push('result.error must be absent when ok=true');
    }
    if (r.data !== undefined && (r.data === null || typeof r.data !== 'object')) {
      issues.push('result.data must be an object when present');
    }
    if (r.result !== undefined && typeof r.result !== 'string') {
      issues.push('result.result must be a string when present');
    }
  }
  return issues.length === 0
    ? { valid: true, issues: [] }
    : { valid: false, issues };
}
