import { createHash } from 'node:crypto';

/**
 * @param {number} x
 * @param {number} y
 * @param {number} z
 */
export function cellId(x, y, z) {
  return `${x},${y},${z}`;
}

/**
 * @param {{ x: number, y: number, z: number, id?: string }} c
 */
export function normalizeUnit(c) {
  const id = c.id || cellId(c.x, c.y, c.z);
  return { ...c, id };
}

/**
 * Reference X/Z for row ordering (bot feet, else anchor, else box centroid).
 * @param {{ x?: number, y?: number, z?: number } | null | undefined} botPos
 * @param {{ x?: number, z?: number } | null | undefined} anchor
 * @param {{ x: number, z: number }[]} cells
 */
function refXZ(botPos, anchor, cells) {
  if (botPos && Number.isFinite(botPos.x) && Number.isFinite(botPos.z)) {
    return { refX: Math.floor(botPos.x), refZ: Math.floor(botPos.z) };
  }
  if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.z)) {
    return { refX: anchor.x, refZ: anchor.z };
  }
  if (cells.length === 0) return { refX: 0, refZ: 0 };
  let sx = 0; let sz = 0;
  for (const c of cells) { sx += c.x; sz += c.z; }
  return { refX: Math.floor(sx / cells.length), refZ: Math.floor(sz / cells.length) };
}

/**
 * Boustrophedon sweep on one Y layer (or column footprint points sharing x/z).
 * Rows keyed by Z; within row sort X; nearest row to refZ first; alternate row direction.
 *
 * @param {{ x: number, y: number, z: number }[]} layerCells
 * @param {number} refX
 * @param {number} refZ
 */
export function boustrophedonXZ(layerCells, refX, refZ) {
  if (layerCells.length === 0) return [];
  /** @type {Map<number, { x: number, y: number, z: number }[]>} */
  const byZ = new Map();
  for (const c of layerCells) {
    const row = byZ.get(c.z) || [];
    row.push(c);
    byZ.set(c.z, row);
  }
  const rowKeys = [...byZ.keys()].sort((a, b) => {
    const da = Math.abs(a - refZ);
    const db = Math.abs(b - refZ);
    if (da !== db) return da - db;
    return a - b;
  });
  /** @type {{ x: number, y: number, z: number }[]} */
  const out = [];
  let reverse = false;
  for (let ri = 0; ri < rowKeys.length; ri++) {
    const z = rowKeys[ri];
    const row = byZ.get(z).slice().sort((a, c) => a.x - c.x);
    if (row.length === 0) continue;
    if (ri === 0) {
      const lo = row[0].x;
      const hi = row[row.length - 1].x;
      reverse = Math.abs(hi - refX) < Math.abs(lo - refX);
    }
    if (reverse) row.reverse();
    out.push(...row);
    reverse = !reverse;
  }
  return out;
}

/**
 * @param {{ x: number, y: number, z: number }[]} cells
 */
function inferShape(cells) {
  if (cells.length === 0) return 'volume';
  const x0 = cells[0].x;
  const z0 = cells[0].z;
  for (const c of cells) {
    if (c.x !== x0 || c.z !== z0) return 'volume';
  }
  return 'column';
}

/**
 * @param {Set<string>} deferSet
 * @param {{ x: number, y: number, z: number, id?: string }[]} ordered
 */
function appendDeferred(deferSet, ordered) {
  if (deferSet.size === 0) return ordered;
  const normal = [];
  const deferred = [];
  for (const c of ordered) {
    const id = c.id || cellId(c.x, c.y, c.z);
    if (deferSet.has(id)) deferred.push(normalizeUnit({ ...c, id }));
    else normal.push(normalizeUnit({ ...c, id }));
  }
  return [...normal, ...deferred];
}

/**
 * @param {{ x: number, y: number, z: number, id?: string, meta?: object }[]} cells
 * @param {object} opts
 * @param {'remove'|'add'} opts.mode
 * @param {'auto'|'volume'|'column'} [opts.shape]
 * @param {{ x?: number, y?: number, z?: number }} [opts.botPos]
 * @param {{ x?: number, z?: number }} [opts.anchor]
 * @param {boolean} [opts.preserveOrder]
 * @param {string[]} [opts.deferIds]
 */
export function orderCells(cells, opts) {
  const {
    mode,
    shape: shapeIn = 'auto',
    botPos,
    anchor,
    preserveOrder = false,
    deferIds = [],
  } = opts;
  const deferSet = new Set(deferIds);
  const normalized = cells.map((c) => normalizeUnit(c));

  if (preserveOrder) {
    return appendDeferred(deferSet, normalized);
  }

  const shape = shapeIn === 'auto' ? inferShape(normalized) : shapeIn;
  const { refX, refZ } = refXZ(botPos, anchor, normalized);
  const yAsc = mode === 'add';

  if (shape === 'column') {
    /** @type {Map<string, { x: number, y: number, z: number, id?: string, meta?: object }[]>} */
    const byCol = new Map();
    for (const c of normalized) {
      const k = `${c.x},${c.z}`;
      const col = byCol.get(k) || [];
      col.push(c);
      byCol.set(k, col);
    }
    const colKeys = [...byCol.keys()].map((k) => {
      const [xs, zs] = k.split(',').map(Number);
      return { x: xs, z: zs, key: k };
    });
    const colPoints = colKeys.map((p) => ({ x: p.x, y: 0, z: p.z }));
    const colOrder = boustrophedonXZ(colPoints, refX, refZ);
    /** @type {typeof normalized} */
    const out = [];
    for (const cp of colOrder) {
      const col = byCol.get(`${cp.x},${cp.z}`) || [];
      col.sort((a, c) => (yAsc ? a.y - c.y : c.y - a.y));
      out.push(...col.map((c) => normalizeUnit(c)));
    }
    return appendDeferred(deferSet, out);
  }

  /** volume */
  const ys = [...new Set(normalized.map((c) => c.y))].sort((a, b) => (yAsc ? a - b : b - a));
  /** @type {typeof normalized} */
  const out = [];
  for (const y of ys) {
    const layer = normalized.filter((c) => c.y === y);
    const layerOrdered = boustrophedonXZ(layer, refX, refZ);
    out.push(...layerOrdered.map((c) => normalizeUnit(c)));
  }
  return appendDeferred(deferSet, out);
}

/**
 * Stable hash for resume idempotency.
 * @param {'remove'|'add'} mode
 * @param {'auto'|'volume'|'column'} shape
 * @param {string[]} orderedIds
 */
export function computePlanHash(mode, shape, orderedIds) {
  const h = createHash('sha256');
  h.update(`${mode}|${shape}|`);
  for (const id of orderedIds) h.update(`${id};`);
  return h.digest('hex').slice(0, 16);
}

/**
 * Order column visit points (x,z only) for level / similar outer loops.
 * @param {{ x: number, z: number }[]} cols
 * @param {{ x?: number, z?: number }} [botPos]
 */
export function orderColumnsBoustrophedon(cols, botPos) {
  const points = cols.map((c) => ({ x: c.x, y: 0, z: c.z }));
  const refX = botPos && Number.isFinite(botPos.x) ? Math.floor(botPos.x) : (cols[0]?.x ?? 0);
  const refZ = botPos && Number.isFinite(botPos.z) ? Math.floor(botPos.z) : (cols[0]?.z ?? 0);
  const ordered = boustrophedonXZ(points, refX, refZ);
  const keyOrder = ordered.map((p) => `${p.x},${p.z}`);
  const map = new Map(cols.map((c) => [`${c.x},${c.z}`, c]));
  return keyOrder.map((k) => map.get(k)).filter(Boolean);
}
