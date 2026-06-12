/**
 * Pure argument normalizers for action handler entry.
 * See docs/reference/mc-command-reference.md Section B and Assumption A2/A4 in actions refactor plan.
 */

import { fail } from '../shared/action-contract.js';

function finiteNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {Record<string, unknown>} args
 * @returns {{ ok: true, x: number, y: number, z: number } | { ok: false, response: import('../shared/action-contract.js').ActionFail }}
 */
export function coord3(args) {
  const x = finiteNum(args?.x);
  const y = finiteNum(args?.y);
  const z = finiteNum(args?.z);
  if (x == null || y == null || z == null) {
    return {
      ok: false,
      response: fail('INVALID_ARGS', 'Expected numeric x, y, z coordinates', {
        observed_state: { x: args?.x, y: args?.y, z: args?.z },
        retry_safe: false,
      }),
    };
  }
  return { ok: true, x, y, z };
}

/**
 * @param {Record<string, unknown>} args
 */
export function box6(args) {
  const x1 = finiteNum(args?.x1);
  const y1 = finiteNum(args?.y1);
  const z1 = finiteNum(args?.z1);
  const x2 = finiteNum(args?.x2);
  const y2 = finiteNum(args?.y2);
  const z2 = finiteNum(args?.z2);
  if ([x1, y1, z1, x2, y2, z2].some((n) => n == null)) {
    return {
      ok: false,
      response: fail('INVALID_ARGS', 'Expected numeric x1,y1,z1,x2,y2,z2', {
        observed_state: { keys: Object.keys(args || {}) },
        retry_safe: false,
      }),
    };
  }
  return { ok: true, x1, y1, z1, x2, y2, z2 };
}

/**
 * @param {Record<string, unknown>} args
 */
export function boxXZ(args) {
  if (args?.x1 != null || args?.z1 != null || args?.x2 != null || args?.z2 != null) {
    const x1 = finiteNum(args.x1);
    const z1 = finiteNum(args.z1);
    const x2 = finiteNum(args.x2);
    const z2 = finiteNum(args.z2);
    const y = args.y != null ? finiteNum(args.y) : undefined;
    if (x1 == null || z1 == null || x2 == null || z2 == null) {
      return {
        ok: false,
        response: fail('INVALID_ARGS', 'Expected numeric x1,z1,x2,z2 (optional y)', { retry_safe: false }),
      };
    }
    return { ok: true, x1, z1, x2, z2, y: y ?? undefined };
  }
  const x = finiteNum(args?.x);
  const z = finiteNum(args?.z);
  const w = finiteNum(args?.w);
  const l = finiteNum(args?.l);
  if (x != null && z != null && w != null && l != null) {
    const y = args.y != null ? finiteNum(args.y) : undefined;
    const d = args.d != null ? finiteNum(args.d) : undefined;
    return {
      ok: true,
      x1: x,
      z1: z,
      x2: x + w - 1,
      z2: z + l - 1,
      y: y ?? undefined,
      depth: d ?? undefined,
      style: 'pit',
    };
  }
  return {
    ok: false,
    response: fail('INVALID_ARGS', 'Expected box x1,z1,x2,z2 or pit x,z,w,l', { retry_safe: false }),
  };
}

/**
 * @param {Record<string, unknown>} args
 * @param {{ keys?: string[] }} [opts]
 */
export function itemName(args, { keys = ['item', 'block', 'name'] } = {}) {
  for (const k of keys) {
    const v = args?.[k];
    if (v != null && String(v).trim() !== '') {
      return { ok: true, name: String(v).trim() };
    }
  }
  return {
    ok: false,
    response: fail('INVALID_ARGS', `Expected one of: ${keys.join(', ')}`, { retry_safe: false }),
  };
}

/**
 * Tolerant boolean coercion for CLI/HTTP args.
 * `undefined` / `null` / `''` → default. `'false' | 'no' | '0' | 0 | false` → false.
 * Anything else truthy → true. Lets handlers accept `hollow=1`, `hollow=yes`,
 * `hollow=true`, `hollow=false` consistently.
 *
 * @param {unknown} v
 * @param {boolean} [def]
 */
export function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (s === 'false' || s === 'no' || s === '0' || s === 'off') return false;
  if (s === 'true' || s === 'yes' || s === '1' || s === 'on') return true;
  return Boolean(v);
}

/**
 * @param {Record<string, unknown>} args
 * @param {{ default?: number, key?: string }} [opts]
 */
export function count(args, { default: def = 1, key = 'count' } = {}) {
  if (args?.[key] == null || args[key] === '') {
    return { ok: true, count: def };
  }
  const n = finiteNum(args[key]);
  if (n == null || !Number.isInteger(n) || n < 1) {
    return {
      ok: false,
      response: fail('INVALID_ARGS', `Expected positive integer ${key}`, {
        observed_state: { [key]: args[key] },
        retry_safe: false,
      }),
    };
  }
  return { ok: true, count: n };
}
