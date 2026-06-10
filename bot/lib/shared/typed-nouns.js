/**
 * Typed world nouns for agent-facing JSON (observation-verb-grammar Block shape).
 * Legacy keys remain on handlers until a later migration; new fields use this module.
 *
 * @see docs/specs/mc/observation-verb-grammar.md
 * @see docs/architecture/embodied-control.md
 */

import { bearingFromDelta } from './perception.js';

/**
 * @typedef {Object} BlockRef
 * @property {string} name
 * @property {{ x: number, y: number, z: number }} pos
 * @property {number} [dist]
 * @property {string} [bearing]
 * @property {boolean} [reachable]
 * @property {{ x: number, y: number, z: number }} [approach_cell]
 */

/**
 * Future: Entity { kind, name, pos, dist, bearing, attrs } — not implemented.
 * Future: MarkRef — use GET /marks owner shapes.
 */

/**
 * @param {{ name: string, x: number, y: number, z: number }} block
 * @param {{ x: number, y: number, z: number }} [origin]
 * @param {{ reachable?: boolean, approach_cell?: { x: number, y: number, z: number } }} [extras]
 * @returns {BlockRef}
 */
export function blockRef(block, origin, extras = {}) {
  const pos = {
    x: Math.round(block.x),
    y: Math.round(block.y),
    z: Math.round(block.z),
  };
  /** @type {BlockRef} */
  const out = {
    name: block.name,
    pos,
  };
  if (origin && Number.isFinite(origin.x)) {
    const dx = pos.x - origin.x;
    const dy = pos.y - origin.y;
    const dz = pos.z - origin.z;
    out.dist = Math.round(Math.hypot(dx, dy, dz) * 10) / 10;
    out.bearing = bearingFromDelta(dx, dz);
  }
  if (extras.reachable !== undefined) out.reachable = extras.reachable;
  if (extras.approach_cell) out.approach_cell = extras.approach_cell;
  return out;
}

/**
 * @param {unknown} obj
 * @returns {{ valid: boolean, issues: string[] }}
 */
export function validateBlockRef(obj) {
  const issues = [];
  if (!obj || typeof obj !== 'object') {
    return { valid: false, issues: ['block_ref must be an object'] };
  }
  const o = /** @type {Record<string, unknown>} */ (obj);
  if (typeof o.name !== 'string' || !o.name) issues.push('name must be non-empty string');
  const pos = o.pos;
  if (!pos || typeof pos !== 'object') {
    issues.push('pos must be an object');
  } else {
    const p = /** @type {Record<string, unknown>} */ (pos);
    for (const k of ['x', 'y', 'z']) {
      if (typeof p[k] !== 'number' || !Number.isFinite(p[k])) issues.push(`pos.${k} must be finite number`);
    }
  }
  if (o.dist !== undefined && (typeof o.dist !== 'number' || !Number.isFinite(o.dist))) {
    issues.push('dist must be finite number when present');
  }
  if (o.bearing !== undefined && typeof o.bearing !== 'string') {
    issues.push('bearing must be string when present');
  }
  return { valid: issues.length === 0, issues };
}
