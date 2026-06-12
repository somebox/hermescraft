/**
 * Material tier + cascade lookup.
 *
 * Loads data/materials.json once at module init. See
 * docs/reference/world-coordinates.md for the related coordinate convention
 * and data/materials.json for the underlying data table.
 *
 * Naming:
 *   tier_1 = fill-grade (free, abundant — dirt, sand, cobble, stone)
 *   tier_2 = mid-value (crafted basics — planks, smooth_stone, bricks)
 *   tier_3 = scarce / structural (logs, doors, fences, stairs, slabs)
 *   tier_4 = irreplaceable (diamond/netherite blocks, beacon)
 *
 * `isStructural` returns true for tier >= 2 — the materials a worker should
 * never place as fill and the protection layer should refuse to dig under
 * a worksite grant. This is a strict superset of today's
 * STRUCTURAL_BY_PROFILE.base (see bot/lib/runtime/regions/profiles.js); the
 * C6 migration in the coordinates+materials plan replaces that set with a
 * call to isStructural().
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// bot/lib/runtime → bot/lib → bot → repo root → data/
const MATERIALS_PATH = path.resolve(__dirname, '..', '..', '..', 'data', 'materials.json');

/** @type {Record<string, number>} */
let TIER_BY_BLOCK = {};
/** @type {Record<string, string[]>} */
let CASCADES = {};
/** @type {Record<string, string[]>} */
let REGION_PALETTES = {};
/** @type {number} */
let VERSION = 0;

function loadOnce() {
  if (VERSION > 0) return;
  const raw = fs.readFileSync(MATERIALS_PATH, 'utf8');
  const data = JSON.parse(raw);
  if (typeof data !== 'object' || !data) {
    throw new Error('materials.json: top-level must be an object');
  }
  VERSION = Number(data.version) || 1;
  const tiers = data.tiers || {};
  for (const [tierKey, tierInfo] of Object.entries(tiers)) {
    const m = String(tierKey).match(/^tier_(\d+)$/);
    if (!m) continue;
    const tierNum = Number(m[1]);
    const blocks = Array.isArray(tierInfo?.blocks) ? tierInfo.blocks : [];
    for (const blockName of blocks) {
      if (typeof blockName !== 'string') continue;
      TIER_BY_BLOCK[blockName] = tierNum;
    }
  }
  CASCADES = {};
  for (const [name, arr] of Object.entries(data.cascades || {})) {
    if (Array.isArray(arr)) CASCADES[name] = arr.filter((b) => typeof b === 'string');
  }
  REGION_PALETTES = {};
  for (const [name, arr] of Object.entries(data.region_palettes || {})) {
    if (Array.isArray(arr)) REGION_PALETTES[name] = arr.filter((b) => typeof b === 'string');
  }
}

loadOnce();

/**
 * Look up the tier of a block name. Returns null for unknown blocks.
 * @param {string} blockName
 * @returns {number | null}
 */
export function tierOf(blockName) {
  if (!blockName) return null;
  const t = TIER_BY_BLOCK[blockName];
  return typeof t === 'number' ? t : null;
}

/**
 * Get a named cascade (block name list to try in order).
 * @param {string} name e.g. 'fill_default', 'pillar_rescue'
 * @returns {string[]}
 */
export function cascadeFor(name) {
  return CASCADES[name] ? [...CASCADES[name]] : [];
}

/**
 * Get the preferred fill palette for a region's profile. Region argument
 * is a normalized region object (the kind applyProfile returns) — we read
 * `region.profile`. Returns an empty array if no palette is defined.
 * @param {{profile?: string} | null | undefined} region
 * @returns {string[]}
 */
export function paletteForRegion(region) {
  if (!region || typeof region !== 'object') return [];
  const profile = region.profile;
  if (!profile || !REGION_PALETTES[profile]) return [];
  return [...REGION_PALETTES[profile]];
}

/**
 * A block is "structural" — must not be placed as fill and must not be
 * dug under a worksite grant — if it sits in tier 2 or higher.
 *
 * Strict superset of today's STRUCTURAL_BY_PROFILE.base; the C6 migration
 * replaces direct set membership tests with a call to this function.
 *
 * @param {string} blockName
 * @returns {boolean}
 */
export function isStructural(blockName) {
  const t = tierOf(blockName);
  return t !== null && t >= 2;
}

/**
 * Convenience: is this block free for fill use? Always tier_1.
 * @param {string} blockName
 * @returns {boolean}
 */
export function isTier1(blockName) {
  return tierOf(blockName) === 1;
}

/**
 * Force a fresh re-read of materials.json. Mainly useful for tests that
 * write to a temp materials.json — production code reads at import time
 * and stays consistent.
 *
 * Note: in production this is a no-op for the read path since callers
 * already received bindings. Use it sparingly.
 */
export function reloadMaterials() {
  VERSION = 0;
  TIER_BY_BLOCK = {};
  CASCADES = {};
  REGION_PALETTES = {};
  loadOnce();
}

/** Underlying data version, for debugging / observability. */
export function getVersion() {
  return VERSION;
}
