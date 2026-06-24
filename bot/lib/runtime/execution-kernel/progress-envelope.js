import { computePlanHash } from './order.js';

/**
 * @typedef {object} ProgressEnvelope
 * @property {boolean} ok
 * @property {boolean} partial
 * @property {{ next_index: number, last_unit_id?: string, units_done: number, units_total: number }} cursor
 * @property {Record<string, number>} counters
 * @property {{ same_command: boolean, next_units: object[], plan_hash: string, anchor?: object }} resume
 * @property {object} [construct]
 * @property {{ code: string, message: string, retry_safe?: boolean, observed_state?: object }} [error]
 */

/**
 * @param {object} cfg
 * @param {boolean} cfg.ok
 * @param {boolean} [cfg.partial]
 * @param {number} cfg.nextIndex
 * @param {number} cfg.unitsTotal
 * @param {string} [cfg.lastUnitId]
 * @param {Record<string, number>} [cfg.counters]
 * @param {'remove'|'add'} cfg.mode
 * @param {'auto'|'volume'|'column'} cfg.shape
 * @param {string[]} cfg.orderedIds
 * @param {object[]} [cfg.remainingUnits]
 * @param {object} [cfg.anchor]
 * @param {object} [cfg.error]
 * @param {object} [cfg.construct]
 * @returns {ProgressEnvelope}
 */
export function progressEnvelope(cfg) {
  const {
    ok,
    partial = false,
    nextIndex,
    unitsTotal,
    lastUnitId,
    counters = {},
    mode,
    shape,
    orderedIds,
    remainingUnits = [],
    anchor,
    error,
    construct,
  } = cfg;
  const plan_hash = computePlanHash(mode, shape, orderedIds);
  const units_done = nextIndex;
  return {
    ok,
    partial,
    cursor: {
      next_index: nextIndex,
      ...(lastUnitId ? { last_unit_id: lastUnitId } : {}),
      units_done,
      units_total: unitsTotal,
    },
    counters,
    resume: {
      same_command: true,
      next_units: remainingUnits.slice(0, 8),
      plan_hash,
      ...(anchor ? { anchor } : {}),
    },
    ...(construct ? { construct } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * Map envelope fields into handler observed_state conventions.
 * @param {ProgressEnvelope} env
 * @param {Record<string, unknown>} [extra]
 */
export function envelopeToObservedState(env, extra = {}) {
  return {
    ...extra,
    cursor: env.cursor,
    plan_hash: env.resume.plan_hash,
    ...env.counters,
  };
}

/**
 * @param {ProgressEnvelope} env
 * @param {string} opName
 * @param {number} capMs
 * @param {string} [hint]
 */
export function envelopeToTimeoutError(env, opName, capMs, hint = '') {
  const base = `${opName} exceeded ${capMs}ms wallclock cap — operation was canceled.`;
  const message = hint ? `${base} ${hint}` : base;
  return {
    ok: false,
    error: {
      code: 'OPERATION_TIMEOUT',
      message,
      observed_state: {
        op: opName,
        cap_ms: capMs,
        ...envelopeToObservedState(env),
      },
      retry_safe: true,
    },
  };
}

/**
 * @param {ProgressEnvelope} env
 * @param {string} code
 * @param {string} message
 * @param {boolean} [retrySafe]
 */
export function envelopeToFail(env, code, message, retrySafe = false) {
  return {
    ok: false,
    error: {
      code,
      message,
      observed_state: envelopeToObservedState(env),
      retry_safe: retrySafe,
    },
  };
}
