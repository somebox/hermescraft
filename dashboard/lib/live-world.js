/**
 * Resolve Hermes/Multiverse world name from bot HTTP API (regions store).
 */

import { fetchWithTimeout } from './poll.js';

/**
 * @param {(port: number, path: string) => string} botUrl
 * @param {number} apiPort
 * @returns {Promise<string | null>}
 */
export async function fetchLiveWorldFromBot(botUrl, apiPort) {
  const url = botUrl(apiPort, '/regions');
  try {
    const r = await fetchWithTimeout(url, { timeout: 4000 });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) return null;
    const w = j?.data?.world;
    if (typeof w === 'string' && w.trim()) return w.trim();
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {string | null | undefined} live
 * @param {string | null | undefined} registryWorld
 * @param {string} defaultWorld
 */
export function mergeAgentWorld(live, registryWorld, defaultWorld) {
  if (live) return live;
  if (registryWorld) return registryWorld;
  return defaultWorld;
}
