/**
 * Resolve a human Minecraft username from a /nearby entity row.
 * @param {{ kind?: string, type?: string, username?: string }} e
 * @returns {string | null}
 */
export function nearbyPlayerName(e) {
  if (!e) return null;
  const u = typeof e.username === 'string' ? e.username.trim() : '';
  if (u && !isPlaceholderPlayerName(u)) return u;
  const kind = e.kind === 'player' || e.type === 'player';
  if (!kind) return null;
  const t = typeof e.type === 'string' ? e.type.trim() : '';
  if (t && !isPlaceholderPlayerName(t)) return t;
  return null;
}

/** @param {string} name */
export function isPlaceholderPlayerName(name) {
  const n = String(name || '').trim().toLowerCase();
  return !n || n === 'player' || n === 'unknown';
}
