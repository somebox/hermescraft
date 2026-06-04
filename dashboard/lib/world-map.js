/**
 * Tile world map (Dynmap / Squaremap-style): Hermes world name → plugin world key.
 * Single source of truth; registry `worldMap.hermesToTileWorld` overrides defaults.
 */

/** @typedef {{ baseUrl: string, hermesToTileWorld: Record<string, string>, iframeDefaults?: { zoom?: number }, tile?: { minZoom?: number, maxZoom?: number, tileSize?: number } }} WorldMapConfig */

const DEFAULT_HERMES_TO_TILE = {
  world: 'minecraft_overworld',
  'landfolk-test': 'minecraft_landfolk-test',
  'proc-lab': 'minecraft_proc-lab',
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
 * @param {{ zoom?: number, x?: number, z?: number, squaremapZoom?: { uiMax: number, def: number, max: number, extra: number } | null }} [opts]
 */
export function buildTerrainIframeUrl(config, hermesWorld, opts = {}) {
  const tileWorld = tileWorldForHermes(config, hermesWorld);
  if (!tileWorld) return null;
  const zoom = initialMapZoom(config, opts.squaremapZoom);
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
    if (!t || t === 'players' || t === 'Players') return;
    if (/^[0-9a-f-]{36}$/i.test(t)) return;
    names.add(t);
  };
  if (!body) return [];

  if (body.type === 'FeatureCollection' && Array.isArray(body.features)) {
    for (const f of body.features) {
      if (!f || typeof f !== 'object') continue;
      const p = f.properties;
      if (p && typeof p === 'object') add(p.name ?? p.label ?? p.displayName);
      else add(f.id);
    }
    return [...names];
  }

  if (Array.isArray(body)) {
    for (const layer of body) {
      if (!layer || typeof layer !== 'object') continue;
      if (Array.isArray(layer.markers)) {
        for (const m of layer.markers) {
          if (m && typeof m === 'object') add(m.name ?? m.label ?? m.displayName);
        }
      }
      if (layer.x != null || layer.z != null) add(layer.name ?? layer.label);
    }
    return [...names];
  }

  if (typeof body === 'object') {
    if (Array.isArray(body.markers)) {
      for (const m of body.markers) {
        if (m && typeof m === 'object') add(m.name ?? m.label ?? m.displayName);
      }
    }
    if (Array.isArray(body.players)) {
      for (const p of body.players) {
        if (typeof p === 'string') add(p);
        else if (p && typeof p === 'object') add(p.name ?? p.label);
      }
    }
    for (const v of Object.values(body)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        add(v.name ?? v.label ?? v.displayName);
      }
    }
  }
  return [...names];
}

/** Alternate Squaremap player marker URLs (version/layout differences). */
export function playersMarkerUrls(baseUrl, tileWorld) {
  const base = baseUrl.replace(/\/$/, '');
  const w = encodeURIComponent(tileWorld);
  return [
    `${base}/tiles/${w}/markers/players.json`,
    `${base}/tiles/${w}/live/players.json`,
    `${base}/tiles/${w}/players.json`,
  ];
}

/**
 * @param {string} baseUrl
 */
export function settingsJsonUrl(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  return `${base}/tiles/settings.json`;
}

/**
 * Per-world Squaremap UI settings (includes zoom limits served to the web map).
 * @param {string} baseUrl
 * @param {string} tileWorld
 */
export function worldSettingsJsonUrl(baseUrl, tileWorld) {
  const base = baseUrl.replace(/\/$/, '');
  const w = encodeURIComponent(tileWorld);
  return `${base}/tiles/${w}/settings.json`;
}

/**
 * @param {unknown} body — Squaremap `tiles/{world}/settings.json`
 * @returns {{ def: number, max: number, extra: number, uiMax: number } | null}
 */
export function parseSquaremapWorldZoom(body) {
  const z = body && typeof body === 'object' ? body.zoom : null;
  if (!z || typeof z !== 'object') return null;
  const max = Number(z.max);
  if (!Number.isFinite(max)) return null;
  const def = Number(z.def);
  const extra = Number(z.extra);
  return {
    def: Number.isFinite(def) ? def : max,
    max,
    extra: Number.isFinite(extra) ? extra : 0,
    uiMax: max + (Number.isFinite(extra) ? extra : 0),
  };
}

/**
 * Initial iframe zoom: registry default clamped to Squaremap's allowed UI range.
 * @param {WorldMapConfig} config
 * @param {{ def: number, max: number, extra: number, uiMax: number } | null | undefined} squaremapZoom
 */
export function initialMapZoom(config, squaremapZoom) {
  const requested = config.iframeDefaults?.zoom ?? 4;
  if (!squaremapZoom) return requested;
  return Math.min(Math.max(requested, squaremapZoom.def), squaremapZoom.uiMax);
}
