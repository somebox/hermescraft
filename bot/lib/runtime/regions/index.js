/**
 * Per-world region registry (shared across bots on the same world).
 */
import fs from 'fs';
import path from 'path';
import { applyProfile } from './profiles.js';
import { regionsAt, resolve, containsPoint } from './resolver.js';

/**
 * @param {{ dataDir: string, world: string }} opts
 */
export function createRegionStore({ dataDir, world }) {
  const safeWorld = String(world || 'world').replace(/[^\w.-]/g, '_');
  const filePath = path.join(dataDir, `regions-${safeWorld}.json`);

  function loadRaw() {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(raw.regions)) return raw.regions;
      if (raw && typeof raw === 'object') {
        return Object.values(raw);
      }
      return [];
    } catch {
      return [];
    }
  }

  function saveRaw(regions) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ world: safeWorld, regions }, null, 2));
  }

  let cache = loadRaw().map((r) => applyProfile({ ...r }));

  function persist() {
    saveRaw(cache);
  }

  function list() {
    return cache.map((r) => ({ ...r }));
  }

  function get(id) {
    const key = normalizeId(id);
    return cache.find((r) => r.id === key) || null;
  }

  function at(x, y, z) {
    return regionsAt(x, y, z, cache);
  }

  function resolvePolicy(verb, args, position, blockName) {
    return resolve(verb, args, position, blockName, cache);
  }

  function upsert(region) {
    const normalized = applyProfile({ ...region, id: normalizeId(region.id) });
    if (normalized.sites != null) {
      normalized.sites = normalizeSitesForStorage(normalized.sites);
    }
    const idx = cache.findIndex((r) => r.id === normalized.id);
    const now = new Date().toISOString();
    if (idx >= 0) {
      cache[idx] = { ...cache[idx], ...normalized, updated: now };
    } else {
      cache.push({ ...normalized, created: normalized.created || now, updated: now });
    }
    persist();
    return get(normalized.id);
  }

  function removeById(id) {
    const key = normalizeId(id);
    const before = cache.length;
    cache = cache.filter((r) => r.id !== key);
    if (cache.length !== before) persist();
    return before !== cache.length;
  }

  function setStatus(id, status) {
    const r = get(id);
    if (!r) return null;
    return upsert({ ...r, status });
  }

  /**
   * @param {{ botPos?: { x: number, y: number, z: number } | null }} [opts]
   */
  function listForApi(opts = {}) {
    const botPos = opts.botPos;
    return list()
      .map((r) => formatRegionRow(r, botPos))
      .sort((a, b) => (a.distance_m ?? 9999) - (b.distance_m ?? 9999));
  }

  function regionsHere(botPos) {
    if (!botPos) return [];
    const ix = Math.floor(botPos.x);
    const iy = Math.floor(botPos.y);
    const iz = Math.floor(botPos.z);
    return at(ix, iy, iz).map((r) => ({
      id: r.id,
      intent: r.intent,
      profile: r.profile,
      status: r.status,
      capabilities: r.capabilities,
    }));
  }

  function reload() {
    cache = loadRaw().map((r) => applyProfile({ ...r }));
  }

  return {
    world: safeWorld,
    filePath,
    list,
    get,
    at,
    resolve: resolvePolicy,
    upsert,
    removeById,
    setStatus,
    listForApi,
    regionsHere,
    reload,
    persist,
    containsPoint,
  };
}

export function normalizeSitesForStorage(sites) {
  if (!sites) return {};
  if (Array.isArray(sites)) {
    return Object.fromEntries(
      sites.filter((s) => s && s.name).map((s) => [s.name, { x: s.x, y: s.y, z: s.z }]),
    );
  }
  return sites;
}

export function normalizeId(id) {
  const s = String(id || '').trim();
  const m = s.match(/^:([a-z0-9]{2,12}):$/i) || s.match(/^:([a-z0-9]{2,12})$/i);
  if (m) return m[1].toLowerCase();
  return s.replace(/^:/, '').replace(/:$/, '').toLowerCase();
}

export function parseSiteRef(ref) {
  const m = String(ref || '').match(/^:([a-z0-9]{2,12}):\/([a-z0-9]{2,12})$/i);
  if (!m) return null;
  return { regionId: m[1].toLowerCase(), siteName: m[2].toLowerCase() };
}

function formatRegionRow(r, botPos) {
  const sites = normalizeSites(r.sites);
  let distance_m = null;
  if (botPos && r.anchor) {
    distance_m = Math.round(
      Math.sqrt(
        (botPos.x - r.anchor.x) ** 2 +
          (botPos.y - r.anchor.y) ** 2 +
          (botPos.z - r.anchor.z) ** 2,
      ),
    );
  }
  return {
    id: r.id,
    intent: r.intent,
    profile: r.profile,
    status: r.status || 'active',
    anchor: r.anchor,
    shape: r.shape,
    capabilities: r.capabilities,
    sites,
    notes: r.notes || '',
    distance_m,
  };
}

function normalizeSites(sites) {
  if (!sites) return [];
  if (Array.isArray(sites)) return sites;
  return Object.entries(sites).map(([name, coords]) => ({
    name,
    x: coords.x,
    y: coords.y,
    z: coords.z,
  }));
}
