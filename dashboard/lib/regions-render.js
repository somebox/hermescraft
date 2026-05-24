/**
 * Helpers for dashboard region discs (unit-tested without canvas).
 */

const INTENT_STROKE = {
  protect: '#58a6ff',
  resource: '#3fb950',
  marker: '#8b949e',
};

const STATUS_DASH = {
  active: [],
  orphaned: [6, 4],
  unanchored: [2, 3],
};

/**
 * @param {object[]} regions
 * @returns {{ x: number, z: number }[]}
 */
export function regionBoundsPoints(regions) {
  const points = [];
  for (const r of regions || []) {
    if (!r.anchor) continue;
    const rad = r.shape?.radius ?? 16;
    const ax = r.anchor.x;
    const az = r.anchor.z;
    points.push({ x: ax, z: az });
    for (const d of [-1, 1]) {
      points.push({ x: ax + d * rad, z: az });
      points.push({ x: ax, z: az + d * rad });
    }
    for (const s of r.sites || []) {
      const sx = s.x ?? s.coords?.x;
      const sz = s.z ?? s.coords?.z;
      if (Number.isFinite(sx) && Number.isFinite(sz)) points.push({ x: sx, z: sz });
    }
  }
  return points;
}

/**
 * @param {object[]} regions
 * @returns {Array<{ kind: string, id: string, cx: number, cy: number, r: number }>}
 */
export function regionHitTargetsFromLayout(regions, layout) {
  const { worldToCanvas, bounds, cw, ch } = layout;
  const out = [];
  for (const r of regions || []) {
    if (!r.anchor) continue;
    const rad = r.shape?.radius ?? 16;
    const { cx, cy } = worldToCanvas(r.anchor.x, r.anchor.z, bounds, cw, ch);
    out.push({
      kind: 'region',
      id: r.id,
      cx,
      cy,
      r: Math.max(8, (rad / Math.max(bounds.maxX - bounds.minX, 1)) * cw),
      stroke: INTENT_STROKE[r.intent] || INTENT_STROKE.protect,
      dash: STATUS_DASH[r.status] || STATUS_DASH.active,
    });
  }
  return out;
}
