/**
 * Whether a block cell blocks mc place, and how to clear it — shared by
 * mc inspect, mc scene, and observe/status looking_at.
 */
import { AIR_NAMES, REPLACEABLE } from '../actions/_block-sets.js';
import {
  RELOCATABLE_INFRASTRUCTURE,
  suggestedToolForBlock,
  isDigProtected,
} from '../runtime/dig-tools.js';

/**
 * @param {string|null|undefined} blockName
 * @param {{ x: number, y: number, z: number }} cell floored placement cell
 * @param {Record<string, any>|null|undefined} ctx bot state (recentPlaces, config)
 */
export function placementCellInsight(blockName, cell, ctx) {
  const name = blockName || 'unknown';
  const isAir = AIR_NAMES.has(name);
  const replaceable = isAir || REPLACEABLE.has(name);
  if (replaceable) {
    return {
      blocks_placement: false,
      is_air: isAir,
    };
  }

  const isDiggable = !isDigProtected(name, cell, ctx);
  const isRelocatable = RELOCATABLE_INFRASTRUCTURE.has(name);
  const suggestedTool = suggestedToolForBlock(name);
  const { x, y, z } = cell;
  let placement_hint;
  if (isRelocatable) {
    placement_hint = `blocks mc place — mc dig ${x} ${y} ${z} then mc place ${name} at a new cell`;
  } else if (isDiggable) {
    placement_hint = `blocks mc place — mc dig ${x} ${y} ${z} (${suggestedTool}) or choose another cell`;
  } else {
    placement_hint = `blocks mc place — ${name} is protected; pick another cell`;
  }

  return {
    blocks_placement: true,
    is_air: false,
    is_diggable: isDiggable,
    is_relocatable: isRelocatable,
    is_protected: !isDiggable,
    suggested_tool: suggestedTool,
    placement_hint,
  };
}

/**
 * @param {{ name?: string, position?: { x: number, y: number, z: number } }} block mineflayer block or hit
 * @param {Record<string, any>|null|undefined} ctx
 */
export function placementInsightForBlock(block, ctx) {
  if (!block?.position) return null;
  const ix = Math.floor(block.position.x);
  const iy = Math.floor(block.position.y);
  const iz = Math.floor(block.position.z);
  const insight = placementCellInsight(block.name, { x: ix, y: iy, z: iz }, ctx);
  return {
    name: block.name,
    coord: { x: ix, y: iy, z: iz },
    ...insight,
  };
}

/**
 * Visible ray hits that occupy cells (chest, furnace, etc.) within reach.
 *
 * @param {Array<{ name: string, position?: { x: number, y: number, z: number }, distance?: string|number, sector?: string }>} hits
 * @param {Record<string, any>|null|undefined} ctx
 * @param {{ maxDistance?: number, limit?: number, excludeCoord?: { x: number, y: number, z: number }|null }} [opts]
 */
export function nearbyPlacementBlockersFromHits(hits, ctx, opts = {}) {
  const maxDist = opts.maxDistance ?? 5;
  const limit = opts.limit ?? 6;
  const exclude = opts.excludeCoord
    ? `${Math.floor(opts.excludeCoord.x)},${Math.floor(opts.excludeCoord.y)},${Math.floor(opts.excludeCoord.z)}`
    : null;
  const seen = new Set();
  const out = [];
  for (const hit of hits || []) {
    if (!hit?.position || !hit.name) continue;
    const dist = typeof hit.distance === 'number'
      ? hit.distance
      : parseFloat(String(hit.distance));
    if (!Number.isFinite(dist) || dist > maxDist) continue;
    const ix = Math.floor(hit.position.x);
    const iy = Math.floor(hit.position.y);
    const iz = Math.floor(hit.position.z);
    // Skip the crosshair cell — already surfaced via looking_at.
    if (exclude && `${ix},${iy},${iz}` === exclude) continue;
    const key = `${hit.name}@${ix},${iy},${iz}`;
    if (seen.has(key)) continue;
    const insight = placementCellInsight(hit.name, { x: ix, y: iy, z: iz }, ctx);
    if (!insight.blocks_placement) continue;
    seen.add(key);
    out.push({
      name: hit.name,
      coord: { x: ix, y: iy, z: iz },
      distance: dist,
      sector: hit.sector || null,
      ...insight,
    });
    if (out.length >= limit) break;
  }
  return out;
}
