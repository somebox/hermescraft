/**
 * Location marks persistence, container coordinate resolution, stale-flagging.
 * Extracted from server.js — each bot gets its own locations file.
 */
import fs from 'fs';
import path from 'path';
import { Vec3 } from 'vec3';

const CONTAINER_BLOCK_NAMES = new Set([
  'chest', 'trapped_chest', 'barrel', 'shulker_box',
  'ender_chest', 'hopper', 'dropper', 'dispenser',
  'smoker', 'blast_furnace', 'furnace',
]);

/**
 * @param {{ dataDir: string, username: string }} opts
 */
export function createLocationsStore({ dataDir, username }) {
  const filePath = path.join(dataDir, `locations-${(username || 'HermesBot').toLowerCase()}.json`);

  function load() {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { return {}; }
  }

  function save(locs) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(locs, null, 2));
  }

  function flagStale(markName, reason) {
    if (!markName) return;
    const locs = load();
    const m = locs[markName];
    if (!m) return;
    m.stale = true;
    m.stale_reason = reason || 'verification failed';
    m.stale_since = new Date().toISOString();
    save(locs);
  }

  function clearStale(markName) {
    if (!markName) return;
    const locs = load();
    const m = locs[markName];
    if (!m || !m.stale) return;
    m.stale = false;
    delete m.stale_reason;
    delete m.stale_since;
    save(locs);
  }

  /**
   * Resolve a place from body.at (xyz object), body.at_mark, or body.from_mark.
   * @param {Record<string, unknown>} body
   * @param {Record<string, any>} [locsPreload]
   * @returns {{ x: number, y: number, z: number } | null}
   */
  function resolvePlace(body, locsPreload) {
    const locs = locsPreload || load();
    if (body.at && typeof body.at === 'object' && body.at !== null) {
      const ax = /** @type {any} */ (body.at);
      return {
        x: Math.round(Number(ax.x)),
        y: Math.round(Number(ax.y)),
        z: Math.round(Number(ax.z)),
      };
    }
    const mk = body.at_mark ?? body.from_mark;
    if (mk) {
      const m = locs[String(mk)];
      if (!m) throw new Error(`Unknown mark '${mk}'`);
      return { x: m.x, y: m.y, z: m.z };
    }
    return null;
  }

  /**
   * Resolve container x/y/z from body.x/y/z, body.mark, body.at, or body.at_mark.
   * @returns {{ ix: number, iy: number, iz: number }}
   */
  function resolveContainerCoords(body) {
    let x = body.x != null ? Number(body.x) : NaN;
    let y = body.y != null ? Number(body.y) : NaN;
    let z = body.z != null ? Number(body.z) : NaN;
    const locs = load();
    if (body.mark) {
      const m = locs[String(body.mark)];
      if (!m) throw new Error(`Unknown mark '${body.mark}'`);
      x = m.x;
      y = m.y;
      z = m.z;
    }
    const place = resolvePlace(body, locs);
    if ((!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) && place) {
      x = place.x;
      y = place.y;
      z = place.z;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new Error('Need x,y,z or mark/at/at_mark');
    return { ix: Math.floor(x), iy: Math.floor(y), iz: Math.floor(z) };
  }

  /** @returns {{ item: string, count: number }[]} */
  function normalizeDepositWithdrawItems(body) {
    if (Array.isArray(body.items))
      return body.items.map((it) => {
        const raw = /** @type {any} */ (it);
        return { item: String(raw.item ?? raw.name), count: Number(raw.count ?? raw.qty ?? 0) };
      });
    const oneItem = /** @type {any} */ (body).item;
    if (!oneItem) throw new Error('Missing item — pass item + count or an items array');
    const count = Number(/** @type {any} */ (body).count ?? 0);
    return [{ item: String(oneItem), count }];
  }

  /**
   * Build marks list for API responses, with distance from bot position.
   * @param {{ botPos: import('vec3').Vec3 | null, chestSnapshots: Record<string, any> }} opts
   */
  function buildMarksList({ botPos, chestSnapshots }) {
    const locs = load();
    return Object.entries(locs)
      .map(([name, l]) => {
        const lx = l.x;
        const ly = l.y;
        const lz = l.z;
        const dist =
          botPos != null ? Math.round(Math.sqrt((botPos.x - lx) ** 2 + (botPos.y - ly) ** 2 + (botPos.z - lz) ** 2)) : null;
        const key = `${lx},${ly},${lz}`;
        const chest = chestSnapshots[name] ?? chestSnapshots[key];
        return {
          name,
          x: lx,
          y: ly,
          z: lz,
          note: l.note ?? '',
          category: l.category ?? null,
          radius: l.radius ?? null,
          mode: l.mode ?? null,
          stale: Boolean(l.stale),
          ...(l.stale_reason ? { stale_reason: l.stale_reason } : {}),
          saved: l.saved ?? null,
          updated: l.updated ?? null,
          last_visited: l.last_visited ?? null,
          visit_count: l.visit_count ?? 0,
          distance_m: dist,
          ...(chest ? { chest_snapshot: chest } : {}),
        };
      })
      .sort((a, b) => a.name.localeCompare(b));
  }

  return {
    filePath,
    load,
    save,
    flagStale,
    clearStale,
    resolvePlace,
    resolveContainerCoords,
    normalizeDepositWithdrawItems,
    buildMarksList,
  };
}

export function isContainerBlock(block) {
  if (!block) return false;
  const n = block.name || '';
  if (CONTAINER_BLOCK_NAMES.has(n)) return true;
  if (n.includes('shulker_box')) return true;
  return false;
}

export function findNearbyContainer(b, cx, cy, cz) {
  const exact = b.blockAt(new Vec3(cx, cy, cz));
  if (isContainerBlock(exact)) return exact;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const bl = b.blockAt(new Vec3(cx + dx, cy + dy, cz + dz));
        if (isContainerBlock(bl)) return bl;
      }
    }
  }
  return exact;
}
