import { getConfig } from '../config/index.js';

/**
 * Volatile navigation crumbs derived from positionHistory (Phase 2).
 * Single-writer: only this module mutates ctx.runtime.navTrail.
 */

const TRAIL_CAP = 64;
const MIN_SPACING = 2;
const TRAIL_TTL_MS = 30 * 60 * 1000;

/**
 * @param {Record<string, any>|null|undefined} ctx
 */
export function clearNavTrail(ctx, reason = 'unknown') {
  if (!ctx?.runtime) return;
  ctx.runtime.navTrail = null;
  ctx.runtime.navTrailClearedAt = { ts: Date.now(), reason };
}

/**
 * Floor cell for bot feet position.
 * @param {{ x: number, y: number, z: number }} pos
 */
export function floorCellFromPos(pos) {
  return {
    x: Math.floor(pos.x),
    y: Math.floor(pos.y),
    z: Math.floor(pos.z),
  };
}

/**
 * @param {{ x: number, y: number, z: number }} a
 * @param {{ x: number, y: number, z: number }} b
 */
function cellDist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Sample a crumb if the bot moved enough and is on ground.
 * @param {Record<string, any>} ctx
 * @param {any} bot
 * @param {{ onGround?: boolean }} [opts]
 */
export function sampleNavTrailCrumb(ctx, bot, opts = {}) {
  if (!ctx?.runtime || !bot?.entity?.position) return;
  const pos = bot.entity.position;
  const prev = ctx.runtime._navTrailLastPos;
  if (prev) {
    const jump = Math.hypot(pos.x - prev.x, pos.y - prev.y, pos.z - prev.z);
    if (jump > 8) clearNavTrail(ctx, 'teleport');
  }
  ctx.runtime._navTrailLastPos = { x: pos.x, y: pos.y, z: pos.z };
  const onGround = opts.onGround ?? bot.entity.onGround;
  if (!onGround) return;
  const cell = floorCellFromPos(pos);
  const now = Date.now();
  let trail = ctx.runtime.navTrail;
  if (!trail || !Array.isArray(trail.crumbs)) {
    trail = { crumbs: [], ts: now, session: ctx.runtime.navTrailSession || now };
    ctx.runtime.navTrail = trail;
  }
  const crumbs = trail.crumbs;
  const last = crumbs[crumbs.length - 1];
  if (last && cellDist(last, cell) < MIN_SPACING) return;
  if (last && last.x === cell.x && last.y === cell.y && last.z === cell.z) return;
  crumbs.push({ ...cell, ts: now });
  while (crumbs.length > TRAIL_CAP) crumbs.shift();
  trail.ts = now;
  if (getConfig().behaviors.navRetraceTrailShape) {
    mergeCollinearNavTrailCrumbs(ctx);
  }
}

/**
 * Tag the latest crumb (or current cell) as a named junction.
 * @param {Record<string, any>} ctx
 * @param {any} bot
 * @param {string} [label]
 */
export function promoteNavTrailJunction(ctx, bot, label = 'last_dig_site') {
  if (!ctx?.runtime || !bot?.entity?.position) return;
  sampleNavTrailCrumb(ctx, bot, { onGround: bot.entity.onGround ?? true });
  const crumbs = ctx.runtime.navTrail?.crumbs;
  if (!Array.isArray(crumbs) || crumbs.length === 0) return;
  const last = crumbs[crumbs.length - 1];
  last.junction = label;
  last.junction_ts = Date.now();
}

/**
 * Drop middle crumbs that are collinear between neighbors (same Y, on segment).
 * @param {Record<string, any>} ctx
 */
export function mergeCollinearNavTrailCrumbs(ctx) {
  const crumbs = ctx?.runtime?.navTrail?.crumbs;
  if (!Array.isArray(crumbs) || crumbs.length < 3) return;
  let changed = true;
  while (changed && crumbs.length >= 3) {
    changed = false;
    for (let i = 1; i < crumbs.length - 1; i++) {
      const a = crumbs[i - 1];
      const b = crumbs[i];
      const c = crumbs[i + 1];
      if (a.y !== b.y || b.y !== c.y) continue;
      const cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
      if (Math.abs(cross) > 0.01) continue;
      const minX = Math.min(a.x, c.x);
      const maxX = Math.max(a.x, c.x);
      const minZ = Math.min(a.z, c.z);
      const maxZ = Math.max(a.z, c.z);
      if (b.x >= minX && b.x <= maxX && b.z >= minZ && b.z <= maxZ) {
        if (b.junction) {
          c.junction = c.junction || b.junction;
          c.junction_ts = c.junction_ts || b.junction_ts;
        }
        crumbs.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
}

/**
 * Crumbs newest-first toward oldest (for walking back).
 * @param {Record<string, any>|null|undefined} ctx
 * @returns {Array<{ x: number, y: number, z: number, ts?: number }>}
 */
export function navTrailCrumbsNewestFirst(ctx) {
  const crumbs = ctx?.runtime?.navTrail?.crumbs;
  if (!Array.isArray(crumbs) || crumbs.length === 0) return [];
  const cutoff = Date.now() - TRAIL_TTL_MS;
  return crumbs.filter((c) => (c.ts || 0) > cutoff).slice().reverse();
}

/**
 * @param {Record<string, any>} ctx
 * @param {Array<{ time: number, x: number, y: number, z: number }>} positionHistory
 * @param {any} bot
 */
export function refreshNavTrailFromHistory(ctx, bot) {
  if (!ctx?.runtime || !Array.isArray(positionHistory)) return;
  const recent = positionHistory.filter((p) => Date.now() - p.time < 120_000);
  for (const p of recent) {
    if (!bot?.entity) break;
    bot.entity.position.x = p.x;
    bot.entity.position.y = p.y;
    bot.entity.position.z = p.z;
    sampleNavTrailCrumb(ctx, bot, { onGround: true });
  }
}
