/**
 * Cardinal direction vectors and name parsing for excavation / movement / escape.
 */

export const DIR_VEC_4 = {
  N: { dx: 0, dz: -1 },
  E: { dx: 1, dz: 0 },
  S: { dx: 0, dz: 1 },
  W: { dx: -1, dz: 0 },
};

export const DIR_VEC_8 = {
  ...DIR_VEC_4,
  NE: { dx: 1, dz: -1 },
  NW: { dx: -1, dz: -1 },
  SE: { dx: 1, dz: 1 },
  SW: { dx: -1, dz: 1 },
};

const ALIAS = {
  n: 'N', north: 'N',
  e: 'E', east: 'E',
  s: 'S', south: 'S',
  w: 'W', west: 'W',
  ne: 'NE', northeast: 'NE',
  nw: 'NW', northwest: 'NW',
  se: 'SE', southeast: 'SE',
  sw: 'SW', southwest: 'SW',
};

/**
 * @param {string} name
 * @param {{ eight?: boolean }} [opts]
 * @returns {{ dx: number, dz: number, key: string } | null}
 */
export function cardinalDelta(name, { eight = false } = {}) {
  if (name == null || name === '') return null;
  const raw = String(name).trim();
  const upper = raw.toUpperCase();
  let key = upper;
  if (!DIR_VEC_4[key] && !DIR_VEC_8[key]) {
    key = ALIAS[raw.toLowerCase()];
    if (!key) return null;
  }
  const table = eight ? DIR_VEC_8 : DIR_VEC_4;
  const v = table[key];
  if (!v) return null;
  return { dx: v.dx, dz: v.dz, key };
}

/**
 * @param {string} key N|E|S|W|NE|…
 */
export function oppositeDir(key) {
  const k = String(key).toUpperCase();
  const map = {
    N: 'S', S: 'N', E: 'W', W: 'E',
    NE: 'SW', SW: 'NE', NW: 'SE', SE: 'NW',
  };
  return map[k] || null;
}

/**
 * @param {number} dx
 * @param {number} dz
 * @returns {string | null}
 */
export function dirFromDelta(dx, dz) {
  const sx = Math.sign(dx);
  const sz = Math.sign(dz);
  if (sx === 0 && sz === -1) return 'N';
  if (sx === 0 && sz === 1) return 'S';
  if (sx === 1 && sz === 0) return 'E';
  if (sx === -1 && sz === 0) return 'W';
  if (sx === 1 && sz === -1) return 'NE';
  if (sx === -1 && sz === -1) return 'NW';
  if (sx === 1 && sz === 1) return 'SE';
  if (sx === -1 && sz === 1) return 'SW';
  return null;
}
