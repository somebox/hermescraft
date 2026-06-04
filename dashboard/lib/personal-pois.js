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
