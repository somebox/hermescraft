/**
 * Personal POI persistence — per-bot landmarks the agent owns.
 *
 * Distinct from `locations.js` (fleet marks). POIs are private-by-default
 * waypoints an agent declares while exploring: "this hilltop is named
 * spider_hill, I dropped a torch at the cairn and placed a sign on the
 * boulder." Pathfinder can resolve them like marks; dashboard plots them
 * as a separate overlay; reconcile-pois.py merges across bots into a
 * Steward-readable shared union.
 *
 * Mark storage stays in locations.js — these stores do not bleed into
 * each other. A POI named `spider_hill` and a mark named `spider_hill`
 * are different things (and fine to coexist).
 *
 * Schema per POI:
 *   { name, x, y, z, kind,
 *     sign_at:  {x,y,z} | null,
 *     torch_at: {x,y,z} | null,
 *     added_at, last_seen, last_torch_check,
 *     torch_missing_since: ISO | null,
 *     agent_owner, note }
 *
 * `_source: 'shared'` is injected on load when an entry came from the
 * reconciled shared file. Stripped before write.
 */
import fs from 'fs';
import path from 'path';

/**
 * Merge private + shared POI entries.
 *
 * Private wins for any name the local bot has — the agent owns their
 * personal view. Shared entries fill gaps (other bots' POIs that the
 * reconciler has surfaced to the local view).
 *
 * If a POI name appears in both with different coords, that's a
 * cross-bot conflict; reconcile-pois.py handles dedup. We don't try to
 * reconcile here.
 */
export function mergePois(privatePois, sharedPois) {
  const out = { ...(privatePois || {}) };
  for (const [name, entry] of Object.entries(sharedPois || {})) {
    if (!(name in out)) {
      out[name] = { ...entry, _source: 'shared' };
    }
  }
  return out;
}

/**
 * @param {{ dataDir: string, username: string, sharedFilePath?: string }} opts
 */
export function createPersonalPoiStore({ dataDir, username, sharedFilePath }) {
  const filePath = path.join(
    dataDir,
    `personal-pois-${(username || 'HermesBot').toLowerCase()}.json`,
  );
  const sharedPath = sharedFilePath || path.join(dataDir, 'personal-pois-shared.json');

  function loadPrivate() {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { return {}; }
  }

  function loadShared() {
    try { return JSON.parse(fs.readFileSync(sharedPath, 'utf8')); }
    catch { return {}; }
  }

  function load() {
    return mergePois(loadPrivate(), loadShared());
  }

  function save(pois) {
    // Persist private only. The reconciler is the sole writer to the
    // shared file. Strip the synthetic _source field if it leaked in
    // from a merged load — same pattern as locations.js.
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const cleaned = {};
    for (const [k, v] of Object.entries(pois || {})) {
      if (v && typeof v === 'object' && '_source' in v) {
        const { _source: _drop, ...rest } = v;
        cleaned[k] = rest;
      } else {
        cleaned[k] = v;
      }
    }
    fs.writeFileSync(filePath, JSON.stringify(cleaned, null, 2));
  }

  function flagStale(poiName, reason) {
    if (!poiName) return;
    const pois = load();
    const p = pois[poiName];
    if (!p) return;
    p.stale = true;
    p.stale_reason = reason || 'verification failed';
    p.stale_since = new Date().toISOString();
    save(pois);
  }

  function clearStale(poiName) {
    if (!poiName) return;
    const pois = load();
    const p = pois[poiName];
    if (!p || !p.stale) return;
    p.stale = false;
    delete p.stale_reason;
    delete p.stale_since;
    save(pois);
  }

  /**
   * Mark a POI's torch as missing. Used by `poi_check_torch` and the
   * observe-side `nearby_missing_torches` sweep. Idempotent — sets
   * `torch_missing_since` only if it isn't already set, so the
   * first-noticed timestamp survives repeated checks.
   */
  function flagTorchMissing(poiName) {
    if (!poiName) return;
    const pois = load();
    const p = pois[poiName];
    if (!p) return;
    p.last_torch_check = new Date().toISOString();
    if (!p.torch_missing_since) {
      p.torch_missing_since = p.last_torch_check;
    }
    save(pois);
  }

  /**
   * Clear the torch-missing flag (e.g. after `poi_check_torch` confirms
   * a torch is back at `torch_at`, or after `place_torch` replaces it).
   * Sets `torch_missing_since` to `null` (matching the documented schema)
   * rather than deleting the key.
   */
  function clearTorchMissing(poiName) {
    if (!poiName) return;
    const pois = load();
    const p = pois[poiName];
    if (!p) return;
    p.last_torch_check = new Date().toISOString();
    p.torch_missing_since = null;
    save(pois);
  }

  /**
   * Add (or upsert) a POI. Stamps added_at on first write and last_seen
   * on every write. Caller passes name + coords + optional metadata.
   *
   * @param {{ name: string, x: number, y: number, z: number,
   *           kind?: string|null, sign_at?: {x,y,z}|null, torch_at?: {x,y,z}|null,
   *           note?: string, agent_owner?: string }} spec
   * @returns {Record<string, unknown>} the stored POI entry
   */
  function addPoi(spec) {
    if (!spec || !spec.name) throw new Error('addPoi: name required');
    if (!Number.isFinite(spec.x) || !Number.isFinite(spec.y) || !Number.isFinite(spec.z)) {
      throw new Error('addPoi: x,y,z must be finite numbers');
    }
    const pois = load();
    const now = new Date().toISOString();
    const existing = pois[spec.name];
    const next = {
      ...(existing || {}),
      name: spec.name,
      x: Math.round(spec.x),
      y: Math.round(spec.y),
      z: Math.round(spec.z),
      kind: spec.kind ?? existing?.kind ?? null,
      sign_at: spec.sign_at ?? existing?.sign_at ?? null,
      torch_at: spec.torch_at ?? existing?.torch_at ?? null,
      note: spec.note ?? existing?.note ?? '',
      agent_owner: spec.agent_owner ?? existing?.agent_owner ?? (username || null),
      added_at: existing?.added_at ?? now,
      last_seen: now,
      last_torch_check: existing?.last_torch_check ?? null,
      torch_missing_since: existing?.torch_missing_since ?? null,
    };
    // Drop the _source tag if upserting on top of a shared-overlay entry.
    if ('_source' in next) delete next._source;
    pois[spec.name] = next;
    save(pois);
    return next;
  }

  /**
   * Build the POI list for API responses, with distance from the bot.
   * Mirrors locations.js#buildMarksList.
   *
   * @param {{ botPos: import('vec3').Vec3 | null }} opts
   */
  function buildPoisList({ botPos }) {
    const pois = load();
    return Object.entries(pois)
      .map(([name, p]) => {
        const dist = botPos != null
          ? Math.round(Math.sqrt((botPos.x - p.x) ** 2 + (botPos.y - p.y) ** 2 + (botPos.z - p.z) ** 2))
          : null;
        return {
          name,
          x: p.x,
          y: p.y,
          z: p.z,
          kind: p.kind ?? null,
          sign_at: p.sign_at ?? null,
          torch_at: p.torch_at ?? null,
          note: p.note ?? '',
          agent_owner: p.agent_owner ?? null,
          added_at: p.added_at ?? null,
          last_seen: p.last_seen ?? null,
          last_torch_check: p.last_torch_check ?? null,
          torch_missing_since: p.torch_missing_since ?? null,
          stale: Boolean(p.stale),
          ...(p.stale_reason ? { stale_reason: p.stale_reason } : {}),
          distance_m: dist,
          ...(p._source ? { source: p._source } : {}),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    filePath,
    sharedPath,
    load,
    loadPrivate,
    loadShared,
    save,
    addPoi,
    flagStale,
    clearStale,
    flagTorchMissing,
    clearTorchMissing,
    buildPoisList,
  };
}
