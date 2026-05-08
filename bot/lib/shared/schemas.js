/**
 * Shared API shapes and small helpers for consistent envelopes.
 * Full runtime validation can grow here (e.g. zod) without changing call sites.
 */

import { DOMAINS, isDomain } from './domains.js';

export { DOMAINS, isDomain };

/** @typedef {'observe' | 'action' | 'task'} ActionKind */

/**
 * @param {object} opts
 * @param {string} [opts.result]
 * @param {Record<string, unknown>} [opts.data]
 * @param {unknown} [opts.state]
 */
export function okEnvelope(opts = {}) {
  const out = { ok: true };
  if (opts.result != null) out.result = opts.result;
  if (opts.data != null) out.data = opts.data;
  if (opts.state !== undefined) out.state = opts.state;
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.code
 * @param {string} opts.message
 * @param {Record<string, unknown>} [opts.details]
 * @param {unknown} [opts.state]
 */
export function errEnvelope(opts) {
  return {
    ok: false,
    code: opts.code,
    message: opts.message,
    ...(opts.details ? { details: opts.details } : {}),
    ...(opts.state !== undefined ? { state: opts.state } : {}),
  };
}

/**
 * @param {unknown} d
 */
export function assertDomain(d) {
  if (!isDomain(String(d))) throw new Error(`invalid_domain:${d}`);
  return true;
}
