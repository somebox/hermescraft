/**
 * Public capability domains shared by CLI categories ([bot/cli/registry.mjs])
 * and server-side action metadata ([bot/lib/server/action-registry.js]).
 */
export const DOMAINS = Object.freeze([
  'platform',
  'observe',
  'movement',
  'world',
  'craft',
  'combat',
  'social',
  'memory',
  'task',
  'goals',
]);

/** @param {string} d */
export function isDomain(d) {
  return typeof d === 'string' && DOMAINS.includes(d);
}
