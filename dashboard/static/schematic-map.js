/**
 * Lightweight XZ schematic map (no Squaremap tiles): agents, POIs, regions, establish anchors.
 */

import { boundsXZ, worldToCanvas } from './map2d.js';
import { regionBoundsPoints } from './regions-map.js';

const COLORS = {
  grid: '#21262d',
  agent: '#58a6ff',
  human: '#d2a8ff',
  poi: '#3fb950',
  personalPoi: '#f7c948',          // Phase A4.1: agent-owned, distinct from fleet poi
  personalPoiMissing: '#db6e6e',   // POI whose torch_at went missing
  spawn: '#f0883e',
  muster: '#ffa657',
  arena: 'rgba(88, 166, 255, 0.15)',
  arenaStroke: '#58a6ff',
  regionProtect: '#58a6ff',
  regionResource: '#3fb950',
  regionMarker: '#8b949e',
};

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ minX: number, maxX: number, minZ: number, maxZ: number }} b
 * @param {number} w
 * @param {number} h
 */
function drawGrid(ctx, b, w, h) {
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  const spanX = b.maxX - b.minX;
  const spanZ = b.maxZ - b.minZ;
  let step = 16;
  if (spanX > 400 || spanZ > 400) step = 32;
  if (spanX > 800 || spanZ > 800) step = 64;
  const x0 = Math.floor(b.minX / step) * step;
  const z0 = Math.floor(b.minZ / step) * step;
  for (let x = x0; x <= b.maxX; x += step) {
    const { cx } = worldToCanvas(x, b.minZ, b, w, h);
    const { cx: cx2 } = worldToCanvas(x, b.maxZ, b, w, h);
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx2, h);
    ctx.stroke();
  }
  for (let z = z0; z <= b.maxZ; z += step) {
    const { cy } = worldToCanvas(b.minX, z, b, w, h);
    const { cy: cy2 } = worldToCanvas(b.maxX, z, b, w, h);
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(w, cy2);
    ctx.stroke();
  }
}

/**
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas
 * @param {object[]} opts.agents
 * @param {object[]} opts.humans
 * @param {object[]} opts.pois
 * @param {object[]} [opts.personalPois]  Phase A4.1: per-bot waypoints (diamond glyph)
 * @param {object[]} opts.regions
 * @param {object | null} opts.establish
 * @param {{ name: string, crumbs: { x: number, y?: number, z: number }[] }[]} [opts.trails]
 */
export function drawSchematicMap(opts) {
  const {
    canvas,
    agents = [],
    humans = [],
    pois = [],
    personalPois = [],
    regions = [],
    establish = null,
    trails = [],
  } = opts;
  const parent = canvas.parentElement;
  const w = Math.max(200, parent?.clientWidth || 400);
  const h = Math.max(160, parent?.clientHeight || 280);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return { hits: [], bounds: null };
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, w, h);

  const points = [];
  for (const a of agents) {
    if (a.position) points.push({ x: a.position.x, z: a.position.z });
  }
  for (const h of humans) {
    if (h.position) points.push({ x: h.position.x, z: h.position.z });
  }
  for (const p of pois) {
    if (Number.isFinite(p.x) && Number.isFinite(p.z)) points.push({ x: p.x, z: p.z });
  }
  for (const p of personalPois) {
    if (Number.isFinite(p.x) && Number.isFinite(p.z)) points.push({ x: p.x, z: p.z });
  }
  points.push(...regionBoundsPoints(regions));

  if (establish?.arena?.center) {
    const [cx, cz] = establish.arena.center;
    const r = establish.arena.radius ?? 32;
    points.push({ x: cx - r, z: cz - r }, { x: cx + r, z: cz + r });
  }
  const place = (arr, key) => {
    const v = establish?.[key] ?? establish?.placements?.[key];
    if (Array.isArray(v) && v.length >= 2) points.push({ x: v[0], z: v[2] ?? v[1] });
  };
  place(null, 'spawn');
  place(null, 'muster');

  const bounds = boundsXZ(points, 32, 0.25);
  drawGrid(ctx, bounds, w, h);

  const muster =
    establish?.muster ||
    establish?.placements?.muster ||
    (Array.isArray(establish?.spawn) ? establish.spawn : null);
  if (muster && muster.length >= 3 && establish?.mission === 'mapping') {
    const mx = muster[0];
    const mz = muster[2] ?? muster[1];
    const { cx: cx0, cy: cy0 } = worldToCanvas(mx, mz, bounds, w, h);
    const { cx: cx1 } = worldToCanvas(mx + 80, mz, bounds, w, h);
    const { cy: cy1 } = worldToCanvas(mx, mz + 80, bounds, w, h);
    ctx.strokeStyle = 'rgba(139, 148, 158, 0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(cx0, 0);
    ctx.lineTo(cx0, h);
    ctx.moveTo(0, cy0);
    ctx.lineTo(w, cy0);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(139, 148, 158, 0.5)';
    ctx.font = '10px system-ui';
    ctx.fillText('N', cx0 + 4, 10);
    ctx.fillText('E', cx1 - 10, cy0 - 4);
  }

  for (const tr of trails) {
    const crumbs = tr.crumbs || [];
    if (crumbs.length < 2) continue;
    ctx.strokeStyle = 'rgba(247, 201, 72, 0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = crumbs.length - 1; i >= 0; i--) {
      const c = crumbs[i];
      if (!Number.isFinite(c.x) || !Number.isFinite(c.z)) continue;
      const { cx, cy } = worldToCanvas(c.x, c.z, bounds, w, h);
      if (i === crumbs.length - 1) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    }
    ctx.stroke();
  }

  if (establish?.arena?.center) {
    const [cx, cz] = establish.arena.center;
    const r = establish.arena.radius ?? 32;
    const p1 = worldToCanvas(cx - r, cz - r, bounds, w, h);
    const p2 = worldToCanvas(cx + r, cz + r, bounds, w, h);
    ctx.fillStyle = COLORS.arena;
    ctx.strokeStyle = COLORS.arenaStroke;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.fillRect(p1.cx, p1.cy, p2.cx - p1.cx, p2.cy - p1.cy);
    ctx.strokeRect(p1.cx, p1.cy, p2.cx - p1.cx, p2.cy - p1.cy);
    ctx.setLineDash([]);
  }

  const intentStroke = {
    protect: COLORS.regionProtect,
    resource: COLORS.regionResource,
    marker: COLORS.regionMarker,
  };
  for (const reg of regions) {
    if (!reg.anchor) continue;
    const rad = reg.shape?.radius ?? 16;
    const { cx, cy } = worldToCanvas(reg.anchor.x, reg.anchor.z, bounds, w, h);
    const edge = worldToCanvas(reg.anchor.x + rad, reg.anchor.z, bounds, w, h);
    const rPx = Math.max(6, Math.abs(edge.cx - cx));
    ctx.beginPath();
    ctx.strokeStyle = intentStroke[reg.intent] || intentStroke.protect;
    ctx.setLineDash(reg.status === 'orphaned' ? [6, 4] : []);
    ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** @type {Array<{ kind: string, id: string, cx: number, cy: number, r: number, label?: string }>} */
  const hits = [];

  function dot(x, z, color, kind, id, label, r = 6) {
    const { cx, cy } = worldToCanvas(x, z, bounds, w, h);
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#0d1117';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    hits.push({ kind, id, cx, cy, r: r + 4, label });
  }

  /**
   * Diamond glyph for personal POIs — distinguishes per-bot waypoints
   * from the green-circle fleet marks at a glance.
   */
  function diamond(x, z, color, kind, id, label, r = 5) {
    const { cx, cy } = worldToCanvas(x, z, bounds, w, h);
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#0d1117';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    hits.push({ kind, id, cx, cy, r: r + 4, label });
  }

  const anchor = (key, color, kind) => {
    const v = establish?.[key];
    if (!Array.isArray(v) || v.length < 3) return;
    dot(v[0], v[2], color, kind, key, key, 7);
  };
  anchor('spawn', COLORS.spawn, 'establish');
  anchor('muster', COLORS.muster, 'establish');

  for (const p of pois) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    const id = `${p.world}|${p.name}|${Math.round(p.x)}|${Math.round(p.y ?? 0)}|${Math.round(p.z)}`;
    dot(p.x, p.z, COLORS.poi, 'poi', id, p.name, 5);
  }
  for (const p of personalPois) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    const id = `${p.world}|${p.name}`;
    const color = p.torch_missing_since ? COLORS.personalPoiMissing : COLORS.personalPoi;
    const bits = [];
    if (p.sign_at) bits.push('S');
    if (p.torch_at) bits.push('T');
    const label = `${p.name}${bits.length ? ` ${bits.join('')}` : ''}${p.kind ? ` (${p.kind})` : ''}`;
    diamond(p.x, p.z, color, 'personal_poi', id, label, 5);
  }
  for (const h of humans) {
    if (!h.position) continue;
    dot(h.position.x, h.position.z, COLORS.human, 'human', h.name, h.name, 5);
  }
  for (const a of agents) {
    if (!a.position) continue;
    dot(a.position.x, a.position.z, COLORS.agent, 'player', a.name, a.name, 7);
  }

  return { hits, bounds };
}
