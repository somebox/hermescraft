/**
 * HTTP transport-layer errors (routing, infra) — separate from handler P9 envelopes.
 * See docs/reference/bot/code-style-standards.md
 */

/**
 * @param {unknown} err
 * @param {{ fallbackCode?: string }} [opts]
 * @returns {{ code: string, message: string, retry_safe: boolean }}
 */
export function normalizeTransportError(err, { fallbackCode = 'INTERNAL_ERROR' } = {}) {
  const message = err?.message ? String(err.message) : String(err);
  const lower = message.toLowerCase();
  if (lower.includes('bot not connected') || lower.includes('not connected')) {
    return { code: 'BOT_NOT_CONNECTED', message, retry_safe: true };
  }
  if (lower.includes('respawn')) {
    return { code: 'BOT_RESPAWNING', message, retry_safe: true };
  }
  return { code: fallbackCode, message, retry_safe: false };
}

/**
 * @param {string} code
 * @param {string} message
 * @param {{ retry_safe?: boolean }} [opts]
 */
export function transportErrorBody(code, message, { retry_safe = false } = {}) {
  return { ok: false, error: { code, message, retry_safe } };
}
