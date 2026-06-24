/**
 * Shared boolean coercion for CLI and action handlers (_args.bool).
 * @param {unknown} v
 * @param {boolean} [def]
 * @returns {boolean}
 */
export function coerceBool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (s === 'false' || s === 'no' || s === '0' || s === 'off') return false;
  if (s === 'true' || s === 'yes' || s === '1' || s === 'on') return true;
  return Boolean(v);
}
