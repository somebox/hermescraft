import fs from 'fs';
import path from 'path';

/**
 * Personal POI aggregation helpers — extracted from server.js so unit
 * tests can import the pure logic without spinning up the HTTP server.
 *
 * The route `/api/personal-pois` fans `GET /personal-pois` to every
 * assignable bot, tags each entry with the observing agent, and runs
 * `dedupePersonalPois` to collapse same-(world,name) duplicates keeping
 * whichever observation is freshest by `last_seen` (falling back to
 * `added_at`).
 */

/**
 * Collapse personal-POI rows by `(world, name)`. Newest `last_seen`
 * wins; if neither row has a timestamp, the earlier-arriving entry
 * keeps the slot (Map.set semantics).
 *
 * @param {Array<{
 *   world: string,
 *   name: string,
 *   last_seen?: string|null,
 *   added_at?: string|null,
 *   [k: string]: unknown,
 * }>} list
 */
export function dedupePersonalPois(list) {
  const byKey = new Map();
  for (const p of list) {
    const k = `${p.world}|${p.name}`;
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, p);
      continue;
    }
    const prevTs = Date.parse(prev.last_seen || prev.added_at || '') || 0;
    const curTs = Date.parse(p.last_seen || p.added_at || '') || 0;
    if (curTs > prevTs) byKey.set(k, p);
  }
  return [...byKey.values()];
}

/**
 * Read `data/personal-pois-shared.json` (mapping grader source).
 * @param {string} repoRoot
 * @param {string} world
 */
export function loadSharedPersonalPois(repoRoot, world) {
  const file = path.join(repoRoot, 'data', 'personal-pois-shared.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    return Object.entries(raw)
      .filter(([, e]) => e && typeof e === 'object')
      .map(([name, e]) => ({
        world,
        name,
        x: e.x,
        y: e.y,
        z: e.z,
        kind: e.kind ?? null,
        sign_at: e.sign_at ?? null,
        torch_at: e.torch_at ?? null,
        torch_missing_since: e.torch_missing_since ?? null,
        note: e.note ?? '',
        agent_owner: e.agent_owner ?? null,
        last_seen: e.last_seen ?? null,
        added_at: e.added_at ?? null,
        source: 'shared',
        observed_by: (e.reconciled_from && e.reconciled_from[0]) || e.agent_owner || 'shared',
      }));
  } catch {
    return [];
  }
}

/**
 * @param {ReturnType<typeof dedupePersonalPois>} live
 * @param {ReturnType<typeof loadSharedPersonalPois>} shared
 * @param {'live'|'shared'|'merge'} mode
 */
export function personalPoisForSource(live, shared, mode) {
  if (mode === 'live') return live;
  if (mode === 'shared') return shared;
  return dedupePersonalPois([...live, ...shared]);
}
