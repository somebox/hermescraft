/** Per-agent XZ motion from successive fleet polls (dashboard-side). */

const STATIONARY_BPS = 0.08;

/** @type {Map<string, { x: number, z: number, t: number, stillSince: number | null }>} */
const byAgent = new Map();

/**
 * @param {string} name
 * @param {{ x: number, z: number } | null} position
 * @returns {{ speed_bps: number | null, idle_sec: number | null }}
 */
export function updateAgentMotion(name, position) {
  const now = Date.now();
  if (!position || typeof position.x !== 'number' || typeof position.z !== 'number') {
    return { speed_bps: null, idle_sec: null };
  }
  const prev = byAgent.get(name);
  byAgent.set(name, {
    x: position.x,
    z: position.z,
    t: now,
    stillSince: prev?.stillSince ?? now,
  });
  if (!prev) return { speed_bps: 0, idle_sec: 0 };

  const dtSec = (now - prev.t) / 1000;
  if (dtSec < 0.3) {
    const idle =
      prev.stillSince != null ? Math.round((now - prev.stillSince) / 1000) : 0;
    return { speed_bps: 0, idle_sec: idle };
  }

  const dist = Math.hypot(position.x - prev.x, position.z - prev.z);
  const speed = dist / dtSec;
  const entry = byAgent.get(name);
  if (!entry) return { speed_bps: null, idle_sec: null };

  if (speed < STATIONARY_BPS) {
    if (entry.stillSince == null) entry.stillSince = now;
    const idleSec = Math.round((now - entry.stillSince) / 1000);
    byAgent.set(name, entry);
    return { speed_bps: 0, idle_sec: idleSec };
  }
  entry.stillSince = null;
  byAgent.set(name, entry);
  return { speed_bps: Math.round(speed * 100) / 100, idle_sec: 0 };
}
