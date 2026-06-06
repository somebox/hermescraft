/**
 * Resolve Hermes/Multiverse world name for dashboard fleet filtering.
 */

import { fetchWithTimeout } from './poll.js';
import { loadMapContext } from './map-context.js';

/**
 * When bots are in proc-lab for establish, /regions still reports the
 * configured store world (often `world`). If the bot is inside the active
 * establish arena, treat it as proc-lab so Players/Agents match the UI world.
 *
 * @param {string} repoRoot
 * @param {{ x: number, y?: number, z: number } | null | undefined} position
 * @param {string | null} regionsWorld
 */
export function inferHermesWorldFromPosition(repoRoot, position, regionsWorld) {
  if (!position || typeof position.x !== 'number' || typeof position.z !== 'number') {
    return regionsWorld;
  }
  const ctx = loadMapContext(repoRoot, 'proc-lab');
  const est = ctx.establish;
  if (!est) return regionsWorld;
  const muster = est.muster || est.spawn;
  if (!Array.isArray(muster) || muster.length < 3) return regionsWorld;
  const center = est.arena?.center;
  const cx = Array.isArray(center) ? center[0] : muster[0];
  const cz = Array.isArray(center) ? center[2] : muster[2];
  const radius = (est.arena?.radius ?? 64) + 24;
  const dx = position.x - cx;
  const dz = position.z - cz;
  if (Math.hypot(dx, dz) <= radius) return 'proc-lab';
  return regionsWorld;
}

/**
 * @param {(port: number, path: string) => string} botUrl
 * @param {number} apiPort
 * @param {{ repoRoot?: string, position?: { x: number, y?: number, z: number } | null }} [opts]
 * @returns {Promise<string | null>}
 */
export async function fetchLiveWorldFromBot(botUrl, apiPort, opts = {}) {
  const url = botUrl(apiPort, '/regions');
  let regionsWorld = null;
  try {
    const r = await fetchWithTimeout(url, { timeout: 4000 });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) return null;
    const w = j?.data?.world;
    if (typeof w === 'string' && w.trim()) regionsWorld = w.trim();
  } catch {
    return null;
  }
  if (opts.repoRoot) {
    return inferHermesWorldFromPosition(opts.repoRoot, opts.position, regionsWorld);
  }
  return regionsWorld;
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
