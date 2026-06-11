/**
 * Location marks persistence, container coordinate resolution, stale-flagging.
 * Extracted from server.js — each bot gets its own locations file.
 *
 * Fleet-prefix marks (chest_*, base_*, lt_*) are read with a shared
 * Steward-owned overlay at data/locations-base.json (see
 * docs/specs/kanban/plugin-landfolk.md Glossary: "Fleet-prefix mark"). The
 * overlay wins for fleet-prefix keys, so workers' private writes to those
 * names are proposal-only and never override the canonical coords.
 */
import fs from 'fs';
import path from 'path';
import { Vec3 } from 'vec3';

const CONTAINER_BLOCK_NAMES = new Set([
  'chest', 'trapped_chest', 'barrel', 'shulker_box',
  'ender_chest', 'hopper', 'dropper', 'dispenser',
  'smoker', 'blast_furnace', 'furnace',
]);

/** Names starting with any of these prefixes resolve through locations-base.json. */
// wp_* is the adaptive-road-planning waypoint family (§5.1): bots write
// the *private* mark via `mc waypoint`; `roadplan` is the sole writer of
// the shared projection, matching the reconciler-only-writer invariant
// above.
export const FLEET_MARK_PREFIXES = ['chest_', 'base_', 'lt_', 'wp_'];

export function isFleetMark(name) {
  if (!name || typeof name !== 'string') return false;
  return FLEET_MARK_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Merge private + shared mark entries with shared-wins for fleet-prefix names.
 * Non-fleet-prefix marks are private-only (shared entries with non-fleet names
 * are still merged, but they shouldn't exist if the reconciler is the only writer).
 */
export function mergeMarks(privateLocs, sharedLocs) {
  const out = { ...(privateLocs || {}) };
  for (const [name, entry] of Object.entries(sharedLocs || {})) {
    if (isFleetMark(name)) {
      // Tag with source so consumers can see the entry came from shared.
      out[name] = { ...entry, _source: 'shared' };
    } else if (!(name in out)) {
      // Non-fleet shared entries fill gaps but don't override private.
      out[name] = { ...entry, _source: 'shared' };
    }
  }
  return out;
}

/**
 * @param {{ dataDir: string, username: string, sharedFilePath?: string }} opts
 */
export function createLocationsStore({ dataDir, username, sharedFilePath }) {
  const filePath = path.join(dataDir, `locations-${(username || 'HermesBot').toLowerCase()}.json`);
  const sharedPath = sharedFilePath || path.join(dataDir, 'locations-base.json');

  function loadPrivate() {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { return {}; }
  }

  function loadShared() {
    try { return JSON.parse(fs.readFileSync(sharedPath, 'utf8')); }
    catch { return {}; }
  }

  function load() {
    return mergeMarks(loadPrivate(), loadShared());
  }

  function save(locs) {
    // Persist private only. Fleet-prefix marks written here become proposals
    // shadowed by shared on next read. The reconciler / future steward tool
    // is the sole writer to locations-base.json.
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Strip the synthetic _source field if it leaked in from a merged load.
    const cleaned = {};
    for (const [k, v] of Object.entries(locs || {})) {
      if (v && typeof v === 'object' && '_source' in v) {
        const { _source: _drop, ...rest } = v;
        cleaned[k] = rest;
      } else {
        cleaned[k] = v;
      }
    }
    fs.writeFileSync(filePath, JSON.stringify(cleaned, null, 2));
  }

  /** @param {Record<string, unknown>} locs @param {number} [maxKeep] */
  function pruneDeathMarks(locs, maxKeep = 3) {
    const deathKeys = Object.keys(locs)
      .filter((k) => /^death_\d+$/i.test(k))
      .sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]));
    if (deathKeys.length <= maxKeep) return locs;
    const drop = deathKeys.slice(0, deathKeys.length - maxKeep);
    for (const k of drop) delete locs[k];
    return locs;
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
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      // #94: enrich the error with what we received + a swap-detection hint.
      // Agents commonly call `mc withdraw 365 65 -597 oak_log 32` (coords
      // first) instead of the correct `mc withdraw oak_log 32 365 65 -597`
      // — the prior bare-bones error didn't surface the mistake.
      const bodyParts = [];
      if (body.item != null) bodyParts.push(`item='${body.item}'`);
      if (body.count != null) bodyParts.push(`count=${body.count}`);
      if (body.x != null) bodyParts.push(`x=${body.x}`);
      if (body.y != null) bodyParts.push(`y=${body.y}`);
      if (body.z != null) bodyParts.push(`z=${body.z}`);
      if (body.mark) bodyParts.push(`mark=${body.mark}`);
      const itemIsNumeric = body.item != null && Number.isFinite(Number(body.item));
      const yIsNonNumeric = body.y != null && !Number.isFinite(Number(body.y));
      let hint = '';
      if (itemIsNumeric && yIsNonNumeric) {
        hint = ` Args look swapped — try: mc <verb> ${body.y} ${body.z ?? '<count>'} ${body.item} <y> <z> (order is ITEM COUNT X Y Z).`;
      }
      throw new Error(
        `Need x,y,z or mark/at/at_mark. Usage: mc deposit/withdraw/chest ITEM COUNT X Y Z (or pass mark=NAME). Got: ${bodyParts.join(', ') || '(no args)'}.${hint}`,
      );
    }
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
          ...(l._source ? { source: l._source } : {}),
          ...(chest ? { chest_snapshot: chest } : {}),
        };
      })
      .sort((a, b) => a.name.localeCompare(b));
  }

  return {
    filePath,
    sharedPath,
    load,
    loadPrivate,
    loadShared,
    save,
    flagStale,
    clearStale,
    resolvePlace,
    resolveContainerCoords,
    normalizeDepositWithdrawItems,
    buildMarksList,
    pruneDeathMarks,
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
