/**
 * Tile world map (Dynmap / Squaremap-style): Hermes world name → plugin world key.
 * Single source of truth; registry `worldMap.hermesToTileWorld` overrides defaults.
 */

/** @typedef {{ baseUrl: string, hermesToTileWorld: Record<string, string>, iframeDefaults?: { zoom?: number }, tile?: { minZoom?: number, maxZoom?: number, tileSize?: number } }} WorldMapConfig */

const DEFAULT_HERMES_TO_TILE = {
  world: 'minecraft_overworld',
  'landfolk-test': 'minecraft_landfolk-test',
  testflat: 'minecraft_testflat',
  world_nether: 'minecraft_the_nether',
  world_the_end: 'minecraft_the_end',
};

/**
 * @param {import('./registry.js').Registry | null} registry
 * @returns {WorldMapConfig | null}
 */
export function getWorldMapConfig(registry) {
  const raw = registry?.worldMap;
  const baseUrl = (process.env.WORLD_MAP_BASE_URL || raw?.baseUrl || '').trim();
  if (!baseUrl) return null;
  const base = baseUrl.replace(/\/$/, '');
  const hermesToTileWorld = {
    ...DEFAULT_HERMES_TO_TILE,
    ...(raw?.hermesToTileWorld && typeof raw.hermesToTileWorld === 'object' ? raw.hermesToTileWorld : {}),
  };
  const iframeDefaults = {
    zoom: 4,
    ...(raw?.iframeDefaults && typeof raw.iframeDefaults === 'object' ? raw.iframeDefaults : {}),
  };
  const tile = {
    minZoom: 0,
    maxZoom: 3,
    tileSize: 512,
    ...(raw?.tile && typeof raw.tile === 'object' ? raw.tile : {}),
  };
  return { baseUrl: base, hermesToTileWorld, iframeDefaults, tile };
}

/**
 * @param {WorldMapConfig} config
 * @param {string} hermesWorld
 * @returns {string | null}
 */
export function tileWorldForHermes(config, hermesWorld) {
  const key = hermesToTileWorldKey(config, hermesWorld);
  return key || null;
}

/**
 * @param {WorldMapConfig} config
 * @param {string} hermesWorld
 */
export function hermesToTileWorldKey(config, hermesWorld) {
  if (!hermesWorld) return null;
  if (config.hermesToTileWorld[hermesWorld]) return config.hermesToTileWorld[hermesWorld];
  return null;
}

/**
 * @param {WorldMapConfig} config
 * @param {string} hermesWorld
 * @param {{ zoom?: number, x?: number, z?: number }} [opts]
 */
export function buildTerrainIframeUrl(config, hermesWorld, opts = {}) {
  const tileWorld = tileWorldForHermes(config, hermesWorld);
  if (!tileWorld) return null;
  const zoom = opts.zoom ?? config.iframeDefaults?.zoom ?? 4;
  const u = new URL('/', config.baseUrl);
  u.searchParams.set('world', tileWorld);
  u.searchParams.set('zoom', String(zoom));
  if (opts.x != null && Number.isFinite(opts.x)) u.searchParams.set('x', String(opts.x));
  if (opts.z != null && Number.isFinite(opts.z)) u.searchParams.set('z', String(opts.z));
  return u.toString();
}

/**
 * Leaflet L.tileLayer URL (future native map).
 * @param {WorldMapConfig} config
 * @param {string} tileWorld
 */
export function tileLayerUrlTemplate(config, tileWorld) {
  const w = encodeURIComponent(tileWorld);
  return `${config.baseUrl}/tiles/${w}/{z}/{x}_{y}.png`;
}

/**
 * @param {string} baseUrl
 * @param {string} tileWorld
 */
export function playersMarkersUrl(baseUrl, tileWorld) {
  const base = baseUrl.replace(/\/$/, '');
  const w = encodeURIComponent(tileWorld);
  return `${base}/tiles/${w}/markers/players.json`;
}

/**
 * Player display names from Squaremap/Dynmap-style players.json (layers + markers).
 * @param {unknown} body
 * @returns {string[]}
 */
export function playerNamesFromMarkersJson(body) {
  const names = new Set();
  const add = (n) => {
    if (typeof n !== 'string') return;
    const t = n.trim();
    if (t && t !== 'players' && t !== 'Players') names.add(t);
  };
  if (!body) return [];
  if (Array.isArray(body)) {
    for (const layer of body) {
      if (!layer || typeof layer !== 'object') continue;
      if (Array.isArray(layer.markers)) {
        for (const m of layer.markers) {
          if (m && typeof m === 'object') add(m.name ?? m.label ?? m.id);
        }
      }
      if (layer.x != null || layer.z != null) add(layer.name ?? layer.label);
    }
  } else if (typeof body === 'object' && Array.isArray(body.markers)) {
    for (const m of body.markers) {
      if (m && typeof m === 'object') add(m.name ?? m.label);
    }
  }
  return [...names];
}

/**
 * @param {string} baseUrl
 */
export function settingsJsonUrl(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  return `${base}/tiles/settings.json`;
}
