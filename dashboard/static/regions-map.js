/**
 * Browser + test-shared region map helpers.
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

export function regionDiscLayouts(regions, worldToCanvas, bounds, cw, ch) {
  const out = [];
  for (const r of regions || []) {
    if (!r.anchor) continue;
    const rad = r.shape?.radius ?? 16;
    const { cx, cy } = worldToCanvas(r.anchor.x, r.anchor.z, bounds, cw, ch);
    const span = Math.max(bounds.maxX - bounds.minX, 1);
    const discR = Math.max(6, (rad / span) * cw);
    out.push({
      kind: 'region',
      id: r.id,
      cx,
      cy,
      discR,
      stroke: INTENT_STROKE[r.intent] || INTENT_STROKE.protect,
      dash: STATUS_DASH[r.status] || STATUS_DASH.active,
      label: `:${r.id}:`,
    });
    for (const s of r.sites || []) {
      const sx = s.x ?? s.coords?.x;
      const sz = s.z ?? s.coords?.z;
      if (!Number.isFinite(sx) || !Number.isFinite(sz)) continue;
      const sitePt = worldToCanvas(sx, sz, bounds, cw, ch);
      out.push({
        kind: 'site',
        id: `${r.id}/${s.name || 'site'}`,
        cx: sitePt.cx,
        cy: sitePt.cy,
        discR: 4,
        stroke: INTENT_STROKE[r.intent] || INTENT_STROKE.protect,
        dash: [],
        label: s.name || 'site',
      });
    }
  }
  return out;
}

export function regionHitTargetsFromLayout(regions, layout) {
  const { worldToCanvas, bounds, cw, ch } = layout;
  return regionDiscLayouts(regions, worldToCanvas, bounds, cw, ch).map((d) => ({
    kind: d.kind,
    id: d.id,
    cx: d.cx,
    cy: d.cy,
    r: d.discR + 4,
    label: d.label,
  }));
}
