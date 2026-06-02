/**
 * Compact terrain cues for mc scene / nav_header (#58 relief-based hint).
 */

import { Vec3 } from 'vec3';

const CARDINALS = [
  { key: 'N', label: 'north', dx: 0, dz: -1 },
  { key: 'E', label: 'east', dx: 1, dz: 0 },
  { key: 'S', label: 'south', dx: 0, dz: 1 },
  { key: 'W', label: 'west', dx: -1, dz: 0 },
];

/** @param {number} y */
export function yBandLabel(y) {
  const fy = Math.floor(Number(y) || 64);
  if (fy >= 95) return 'high (95+)';
  if (fy >= 72) return 'mid (72-95)';
  if (fy >= 60) return 'low (60-72)';
  return `deep (${fy})`;
}

function surfaceYAt(bot, wx, wz) {
  const bx = Math.floor(wx);
  const bz = Math.floor(wz);
  const startY = Math.floor(bot.entity.position.y) + 32;
  for (let dy = startY; dy >= startY - 64; dy--) {
    const block = bot.blockAt(new Vec3(bx, dy, bz));
    if (!block) continue;
    const n = block.name;
    if (n === 'air' || n === 'cave_air' || n === 'void_air') continue;
    if (n === 'water' || n === 'flowing_water') continue;
    return dy;
  }
  return null;
}

/**
 * Δ surface Y at radius vs feet (integer blocks, signed).
 * @returns {{ N: number, E: number, S: number, W: number, formatted: string }}
 */
export function cardinalReliefDeltas(bot, radius = 16) {
  const pos = bot.entity.position;
  const feetY = Math.floor(pos.y);
  const out = { N: 0, E: 0, S: 0, W: 0 };
  for (const c of CARDINALS) {
    const sy = surfaceYAt(bot, pos.x + c.dx * radius, pos.z + c.dz * radius);
    out[c.key] = sy == null ? 0 : sy - feetY;
  }
  const formatted = CARDINALS.map((c) => `${c.key}${out[c.key] >= 0 ? '+' : ''}${out[c.key]}`).join(' ');
  return { ...out, formatted };
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {number} [radius]
 */
/**
 * Resolve a biome ID (numeric) to its registered name via prismarine-registry.
 * Returns null if the bot's registry or the ID is missing.
 */
function biomeIdToName(bot, biomeId) {
  if (typeof biomeId !== 'number') return null;
  try {
    const entry = bot.registry?.biomes?.[biomeId];
    return entry?.name || null;
  } catch {
    return null;
  }
}

export function biomeAtFeet(bot) {
  const pos = bot.entity.position;
  const cell = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
  // PR-1 followup (Phase 4 / item 4.1, 2026-06-02): `block.biome.name` is
  // often empty on mineflayer 1.21.x because the chunk loader doesn't
  // populate Block.biome by default — observed in the postmortem run
  // where every mc scene returned `biome: unknown`. Use the sync world
  // getBiome to fetch the biome ID for the feet cell, then look up the
  // name via the bot's prismarine-registry. Fall back to the legacy
  // `block.biome.name` path on any failure to preserve existing behavior.
  let name = null;
  try {
    const sync = bot.world?.sync || bot.worldSync;
    if (sync?.getBiome) {
      const id = sync.getBiome(cell);
      name = biomeIdToName(bot, id);
    }
  } catch {
    /* fall through to legacy path */
  }
  if (!name) {
    const block = bot.blockAt(cell);
    name = block?.biome?.name || null;
  }
  return String(name || 'unknown').replace(/_/g, ' ');
}

/**
 * Rough log-block count in sphere for tree cue.
 * @returns {{ count: number, species: string | null, text: string }}
 */
export function treeClusterSummary(bot, radius = 12) {
  const pos = bot.entity.position;
  const counts = new Map();
  const r = Math.max(4, Math.min(radius, 16));
  const cx = Math.floor(pos.x);
  const cy = Math.floor(pos.y);
  const cz = Math.floor(pos.z);
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -3; dy <= 8; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        if (dx * dx + dy * dy + dz * dz > r * r) continue;
        const block = bot.blockAt(new Vec3(cx + dx, cy + dy, cz + dz));
        if (!block?.name?.includes('_log')) continue;
        const species = block.name.replace('_log', '');
        counts.set(species, (counts.get(species) || 0) + 1);
      }
    }
  }
  let total = 0;
  let topSpecies = null;
  let top = 0;
  for (const [sp, n] of counts) {
    total += n;
    if (n > top) {
      top = n;
      topSpecies = sp;
    }
  }
  if (total === 0) return { count: 0, species: null, text: 'trees: 0 (bare)' };
  return {
    count: total,
    species: topSpecies,
    text: `trees: ${total} nearby (${topSpecies || 'wood'})`,
  };
}

/**
 * @param {{ biome: string, yBand: string, reliefFormatted: string, treesText: string }} parts
 */
export function formatLandscapeClause(parts) {
  return `${parts.biome}, Y ${parts.yBand} — ${parts.reliefFormatted} — ${parts.treesText}`;
}

/**
 * Pick NE/N/… label for nav hint: prefer cardinal with largest downward step (easier walk)
 * or upward if all flat pick dir with most logs (future: trees).
 * @param {{ N: number, E: number, S: number, W: number }} relief
 */
export function pickSuggestedCardinalLabel(relief) {
  const entries = CARDINALS.map((c) => ({ key: c.key, delta: relief[c.key] ?? 0 }));
  const minDown = entries.reduce((best, e) => (e.delta < best.delta ? e : best), entries[0]);
  if (minDown && minDown.delta <= -2) return minDown.key;
  const maxUp = entries.reduce((best, e) => (e.delta > best.delta ? e : best), entries[0]);
  if (maxUp && maxUp.delta >= 3) return maxUp.key;
  const flat = entries.filter((e) => Math.abs(e.delta) <= 1);
  if (flat.length) return flat[0].key;
  return entries.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))[0]?.key || 'N';
}

/** @param {import('mineflayer').Bot} bot */
export function buildLandscapeContext(bot) {
  const relief = cardinalReliefDeltas(bot, 16);
  const trees = treeClusterSummary(bot, 12);
  return {
    biome: biomeAtFeet(bot),
    y_band: yBandLabel(bot.entity.position.y),
    relief,
    trees,
    clause: formatLandscapeClause({
      biome: biomeAtFeet(bot),
      yBand: yBandLabel(bot.entity.position.y),
      reliefFormatted: relief.formatted,
      treesText: trees.text,
    }),
    suggested_cardinal: pickSuggestedCardinalLabel(relief),
  };
}
