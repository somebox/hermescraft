/**
 * Per-world mine registry (shared across bots on the same world).
 *
 * A flat annotated registry — NOT a navigable graph. Each mine is a record
 * with one-or-more `entrances` (routes to the surface) and a flat `points`
 * list of annotated locations. "Navigable & orderly" is enforced by mining
 * doctrine + the tread-preserving dig primitives, not by a topology stored
 * here. Return-to-mine = walk to an entrance, then to a point; resume-digging
 * = head to the nearest `frontier`.
 *
 * Mirrors the shape/lifecycle of createRegionStore (regions/index.js):
 * per-world JSON file, load-once cache, persist on every mutation, reload()
 * for operator hand-edits.
 */
import fs from 'fs';
import path from 'path';

export const POINT_KINDS = new Set([
  'landing',  // bottom of a stair_down
  'chamber',  // hollowed-out area for traversal/storage
  'junction', // tunnel intersection
  'station',  // placed furnace / crafting_table / chest
  'frontier', // open tunnel-end to resume digging (carries dir + target_y)
  'ore',      // ore pocket (open | extracted, with qty_estimate)
  'danger',   // hazard: lava | water | mob (with sealed flag)
]);

const MINE_STATUSES = new Set(['active', 'exhausted', 'abandoned', 'hazard_locked']);

/**
 * @param {{ dataDir: string, world: string }} opts
 */
export function createMineStore({ dataDir, world }) {
  const safeWorld = String(world || 'world').replace(/[^\w.-]/g, '_');
  const filePath = path.join(dataDir, `mines-${safeWorld}.json`);

  function loadRaw() {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(raw.mines)) return raw.mines;
      return [];
    } catch {
      return [];
    }
  }

  function saveRaw(mines) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ world: safeWorld, mines }, null, 2));
  }

  let cache = loadRaw();

  function persist() {
    saveRaw(cache);
  }

  function ref(id) {
    const key = normalizeMineId(id);
    return cache.find((m) => m.id === key) || null;
  }

  function list() {
    return cache.map(clone);
  }

  function get(id) {
    const m = ref(id);
    return m ? clone(m) : null;
  }

  /**
   * Register a new mine, or add an entrance / update fields on an existing
   * one. Idempotent on (id) and on entrance position.
   */
  function open({ id, entrance, dir, target_y, resource, note, by } = {}) {
    const key = normalizeMineId(id);
    if (!key) throw new Error('mine id required');
    const now = new Date().toISOString();
    const ent = entrance
      ? { pos: toPos(entrance), dir: dir || null, kind: 'stair', note: note || '', by: by || null }
      : null;
    let m = ref(key);
    if (!m) {
      m = {
        id: key,
        created: now,
        updated: now,
        status: 'active',
        resource: resource || null,
        target_y: target_y ?? null,
        entrances: ent ? [ent] : [],
        points: [],
      };
      cache.push(m);
    } else {
      if (resource) m.resource = resource;
      if (target_y != null) m.target_y = target_y;
      if (ent && !m.entrances.some((e) => samePos(e.pos, ent.pos))) m.entrances.push(ent);
      m.updated = now;
    }
    persist();
    return clone(m);
  }

  /**
   * Add (or update-in-place) a flat annotated point on a mine. Dedupes by
   * (kind, pos) — the reactive danger path can fire repeatedly on the same
   * lava cell, and a re-survey of a chamber shouldn't fork a duplicate.
   */
  function addPoint(mineId, point = {}) {
    const m = ref(mineId);
    if (!m) return null;
    const kind = String(point.kind || '').toLowerCase();
    if (!POINT_KINDS.has(kind)) throw new Error(`unknown point kind: ${kind}`);
    const now = new Date().toISOString();
    const pos = toPos(point.pos);
    const rec = {
      id: point.id || nextPointId(m),
      kind,
      pos,
      tags: Array.isArray(point.tags) ? point.tags : [],
      status: point.status || defaultStatus(kind),
      note: point.note || '',
      found: now,
      updated: now,
      by: point.by || null,
    };
    if (kind === 'frontier') {
      rec.dir = point.dir || null;
      rec.target_y = point.target_y ?? null;
    } else if (kind === 'ore') {
      rec.resource = point.resource || null;
      rec.qty_estimate = point.qty_estimate ?? null;
    } else if (kind === 'danger') {
      rec.hazard = point.hazard || null;
      rec.sealed = !!point.sealed;
    }
    const existing = m.points.find((p) => p.kind === kind && samePos(p.pos, pos));
    if (existing) {
      const keepId = existing.id;
      const keepFound = existing.found;
      Object.assign(existing, rec, { id: keepId, found: keepFound, updated: now });
      m.updated = now;
      persist();
      return clone(existing);
    }
    m.points.push(rec);
    m.updated = now;
    persist();
    return clone(rec);
  }

  function updatePoint(mineId, pointId, patch = {}) {
    const m = ref(mineId);
    if (!m) return null;
    const p = m.points.find((q) => q.id === pointId);
    if (!p) return null;
    const now = new Date().toISOString();
    const { id, kind, found, ...rest } = patch; // immutable identity fields
    Object.assign(p, rest, { updated: now });
    m.updated = now;
    persist();
    return clone(p);
  }

  function setStatus(id, status) {
    const m = ref(id);
    if (!m) return null;
    if (!MINE_STATUSES.has(status)) throw new Error(`unknown mine status: ${status}`);
    m.status = status;
    m.updated = new Date().toISOString();
    persist();
    return clone(m);
  }

  function removeById(id) {
    const key = normalizeMineId(id);
    const before = cache.length;
    cache = cache.filter((m) => m.id !== key);
    if (cache.length !== before) persist();
    return before !== cache.length;
  }

  function reload() {
    cache = loadRaw();
  }

  /**
   * Nearest mine entrance to a point, within maxDist. Used to bind a reactive
   * danger record (or an ad-hoc note) to the mine the bot is actually working.
   * Distance is HORIZONTAL (x/z only): a mine is a vertical column, so a
   * surface entrance sits ~50 blocks directly above deep workings — a 3D
   * metric would never bind a deep danger to its own entrance.
   * @returns {{ mineId: string, entrance: object, distance: number } | null}
   */
  function nearestEntrance(pos, maxDist = 48) {
    const p = toPos(pos);
    let best = null;
    for (const m of cache) {
      for (const e of m.entrances || []) {
        const d = hdist(p, e.pos);
        if (d <= maxDist && (!best || d < best.distance)) {
          best = { mineId: m.id, entrance: clone(e), distance: d };
        }
      }
    }
    return best;
  }

  function listForApi({ botPos } = {}) {
    return list()
      .map((m) => formatMineRow(m, botPos))
      .sort((a, b) => (a.distance_m ?? 9999) - (b.distance_m ?? 9999));
  }

  return {
    world: safeWorld,
    filePath,
    list,
    get,
    open,
    addPoint,
    updatePoint,
    setStatus,
    removeById,
    reload,
    persist,
    nearestEntrance,
    listForApi,
  };
}

export function normalizeMineId(id) {
  return String(id || '')
    .trim()
    .replace(/^:/, '')
    .replace(/:$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function defaultStatus(kind) {
  if (kind === 'ore') return 'open';
  if (kind === 'frontier') return 'open';
  return 'active';
}

function nextPointId(mine) {
  let max = 0;
  for (const p of mine.points || []) {
    const m = /^p(\d+)$/.exec(p.id || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `p${max + 1}`;
}

function toPos(p) {
  if (Array.isArray(p)) return { x: int(p[0]), y: int(p[1]), z: int(p[2]) };
  if (p && typeof p === 'object') return { x: int(p.x), y: int(p.y), z: int(p.z) };
  throw new Error('point requires a pos ([x,y,z] or {x,y,z})');
}

function int(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) throw new Error(`invalid coordinate: ${n}`);
  return v;
}

function samePos(a, b) {
  return a && b && a.x === b.x && a.y === b.y && a.z === b.z;
}

function dist(a, b) {
  return Math.round(Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2));
}

function hdist(a, b) {
  return Math.round(Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2));
}

function formatMineRow(m, botPos) {
  const entrance = (m.entrances && m.entrances[0]) || null;
  let distance_m = null;
  if (botPos && entrance) distance_m = dist(botPos, entrance.pos);
  const counts = {};
  for (const p of m.points || []) counts[p.kind] = (counts[p.kind] || 0) + 1;
  return {
    id: m.id,
    status: m.status || 'active',
    resource: m.resource || null,
    target_y: m.target_y ?? null,
    entrances: m.entrances || [],
    point_counts: counts,
    points: m.points || [],
    distance_m,
  };
}

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}
