/**
 * Parse region directives from placemark sign text (line-oriented).
 */

const PLACEMARK_ID = /^:([a-z0-9]{2,12}):/i;

/**
 * @param {string} text full sign text (may include placemark header)
 * @returns {{ id: string|null, directives: Record<string, string>, sites: Record<string, {x:number,y:number,z:number}> }}
 */
export function parseRegionSignText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let id = null;
  const directives = {};
  const sites = {};

  for (const line of lines) {
    const pm = line.match(PLACEMARK_ID);
    if (pm && !id) id = pm[1].toLowerCase();

    const kv = line.match(/^([a-z_]+)\s*=\s*(.+)$/i);
    if (kv) {
      directives[kv[1].toLowerCase()] = kv[2].trim();
      continue;
    }

    const site = line.match(/^site:([a-z0-9_]{2,16})\s*=\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)$/i);
    if (site) {
      sites[site[1].toLowerCase()] = {
        x: Number(site[2]),
        y: Number(site[3]),
        z: Number(site[4]),
      };
    }
  }

  return { id, directives, sites };
}

/**
 * Build a region row patch from parsed sign + block position.
 * @param {{ id: string, directives: object, sites: object }} parsed
 * @param {{ x: number, y: number, z: number }} blockPos
 */
export function regionRowFromSign(parsed, blockPos) {
  const profile = String(parsed.directives.region || parsed.directives.profile || 'base').toLowerCase();
  const radius = parsed.directives.r != null ? Number(parsed.directives.r) : 16;
  const intent = parsed.directives.intent ? String(parsed.directives.intent).toLowerCase() : undefined;
  const shapeKind = parsed.directives.shape === 'sphere' ? 'sphere' : 'column';
  const shape = {
    kind: shapeKind,
    radius: Number.isFinite(radius) ? radius : 16,
  };
  const ySpec = parsed.directives.y;
  if (ySpec) {
    const m = String(ySpec).match(/^(-?\d+)\.\.(-?\d+)$/);
    if (m) {
      shape.y_min = Number(m[1]);
      shape.y_max = Number(m[2]);
    }
  }

  return {
    id: parsed.id,
    profile,
    intent,
    status: 'active',
    anchor: { x: blockPos.x, y: blockPos.y, z: blockPos.z },
    shape,
    sites: parsed.sites,
    plan: parsed.directives.plan ? String(parsed.directives.plan).trim().toLowerCase() : undefined,
  };
}

export function signHasRegionDirectives(parsed) {
  return Boolean(parsed.directives.region || parsed.directives.r || parsed.directives.intent || parsed.directives.y);
}
