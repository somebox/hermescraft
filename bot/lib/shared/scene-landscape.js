/**
 * Compact terrain cues for mc scene / nav_header (#58 relief-based hint).
 */

import { Vec3 } from 'vec3';
import { surfaceFromBlock } from '../runtime/coordinates.js';

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

// Canopy guard for Phase 9 PR-E terrain classification: leaves/logs above
// the bot's head are not "the ground" — they're tree canopy. Without
// this guard, groundBlockYAt picks the leaf Y as ground, classifyTerrain
// reads it as 'mound' or 'on_structure', and Steward gets wrong advice.
const CANOPY_BLOCK_RE = /(_leaves|_log|vine|cocoa|bamboo)$/;
/** Actionable sky band above feet — distant canopy (e.g. Y=95 over feet≈79) must not force `unknown`. */
const CANOPY_DY_MIN = 2;
const CANOPY_DY_MAX = 8;
function isCanopyBlock(name) {
  return !!name && CANOPY_BLOCK_RE.test(name);
}
function isCanopyBandDy(feetY, dy) {
  return dy > feetY + CANOPY_DY_MIN && dy <= feetY + CANOPY_DY_MAX;
}

// Common worker-placed blocks for the on_structure heuristic. Conservative:
// stone-family + planks + cobbled variants. Natural grass/dirt/stone are
// NOT treated as "placed" — they're ground.
const PLACED_BLOCK_RE = /^(cobblestone|cobbled_deepslate|stone_bricks?|.*_planks|.*_fence|.*_fence_gate|.*_door|chest|crafting_table)$/;
function isPlacedStructureBlock(name) {
  return !!name && PLACED_BLOCK_RE.test(name);
}

/**
 * Topmost solid GROUND BLOCK of a column (block_y in the canonical
 * vocabulary — a bot's feet land at surfaceFromBlock(result)). Skips air,
 * fluids, canopy (leaves/logs, with the canopyDetected band flag), and
 * non-solid decorations (grass plants, flowers, snow layers): without the
 * decoration skip, the classification of flat ground used to depend on
 * ground cover — a grass plant in the feet cell read as "the surface"
 * while bare ground scanned through to the supporting block one below.
 */
function groundBlockYAt(bot, wx, wz, opts = {}) {
  const bx = Math.floor(wx);
  const bz = Math.floor(wz);
  const feetY = Math.floor(opts.feetY ?? bot.entity.position.y);
  const startY = feetY + 32;
  let canopyDetected = false;
  for (let dy = startY; dy >= feetY - 32; dy--) {
    const block = bot.blockAt(new Vec3(bx, dy, bz));
    if (!block) continue;
    const n = block.name;
    if (n === 'air' || n === 'cave_air' || n === 'void_air') continue;
    if (n === 'water' || n === 'flowing_water') continue;
    if (n === 'snow' || n === 'snow_layer') continue;
    if (isCanopyBlock(n)) {
      if (isCanopyBandDy(feetY, dy)) {
        canopyDetected = true;
      }
      continue;
    }
    // Passable decorations (short_grass, ferns, flowers…) are cover, not
    // ground. Mocks without boundingBox fall through as solid.
    if (block.boundingBox === 'empty') continue;
    if (opts.returnDetail) return { y: dy, canopyDetected };
    return dy;
  }
  return opts.returnDetail ? { y: null, canopyDetected } : null;
}

export { groundBlockYAt as _groundBlockYAtForTests };

/**
 * Δ surface Y at radius vs feet (integer blocks, signed).
 * @returns {{ N: number, E: number, S: number, W: number, formatted: string }}
 */
export function cardinalReliefDeltas(bot, radius = 16) {
  const pos = bot.entity.position;
  const feetY = Math.floor(pos.y);
  const out = { N: 0, E: 0, S: 0, W: 0 };
  for (const c of CARDINALS) {
    const gy = groundBlockYAt(bot, pos.x + c.dx * radius, pos.z + c.dz * radius);
    // Compare feet plane to feet plane: where the bot's feet WOULD be on
    // that column vs where they are now. 0 = same walking level.
    out[c.key] = gy == null ? 0 : surfaceFromBlock(gy) - feetY;
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
 * Phase 9 PR-E terrain classifier. Pure function over typed inputs so it's
 * trivially testable without a bot fixture. Caller (`buildLandscapeContext`)
 * fills inputs from the live world.
 *
 * BOTH Y inputs are feet-plane values: `feetY` is the cell the bot's feet
 * occupy (Math.floor(pos.y)); `surfaceY` is the cell its feet WOULD occupy
 * standing on the local ground column (= surfaceFromBlock(ground block_y)).
 * Standing normally on the local ground ⇒ feet_vs_local_ground = 0.
 *
 * Labels (conservative; classifier returns 'unknown' when ambiguous):
 *   - flat:          max |cardinal delta| ≤ 1 AND feet_vs_local_ground == 0
 *   - slope_<N/E/S/W>: monotone delta ≥ 2 in one cardinal, |opposite| ≤ 1
 *   - depression_1:  feet_vs_local_ground == -1 (single-block hole)
 *   - mound_1:       feet_vs_local_ground == +1 AND feet block is natural
 *                    (e.g. standing on a log/canopy block the ground scan
 *                    skips — the scan otherwise finds the standing block)
 *   - on_structure:  feet_vs_local_ground >= 0 AND feet block is placed
 *                    material (cobble, planks, etc.) — "standing on pad"
 *   - underground:   feet_vs_local_ground ≤ -3 AND no cardinal egress within 2
 *                    (negative fvlg = the column scan found terrain ABOVE
 *                    the bot — a cave roof / overhang)
 *   - cliff_above:   one cardinal jumps ≥ 4 up, none drops
 *   - cliff_below:   one cardinal drops ≤ -4, none rises
 *   - unknown:       canopy detected, no surface found, or ambiguous shape
 *
 * Steward SOUL (PR-F) is intentionally a no-op on 'unknown' — she falls back
 * to `mc scene` rather than acting on a wrong label.
 *
 * @param {{ deltas: { N: number, E: number, S: number, W: number },
 *           feetY: number, surfaceY: number|null, canopyDetected: boolean,
 *           feetBlockName: string|null }} input
 * @returns {{ terrain_kind: string, feet_vs_local_ground: number|null }}
 */
export function classifyTerrain({ deltas, feetY, surfaceY, canopyDetected, feetBlockName }) {
  if (surfaceY == null) return { terrain_kind: 'unknown', feet_vs_local_ground: null };
  const feet_vs_local_ground = feetY - surfaceY;
  if (canopyDetected) return { terrain_kind: 'unknown', feet_vs_local_ground };

  const dN = deltas?.N || 0;
  const dE = deltas?.E || 0;
  const dS = deltas?.S || 0;
  const dW = deltas?.W || 0;
  const absMax = Math.max(Math.abs(dN), Math.abs(dE), Math.abs(dS), Math.abs(dW));

  // >= 0: standing directly on a placed block is the common case (the
  // ground scan finds the placed block itself, so fvlg is 0, not +1).
  if (feet_vs_local_ground >= 0 && isPlacedStructureBlock(feetBlockName)) {
    return { terrain_kind: 'on_structure', feet_vs_local_ground };
  }

  if (feet_vs_local_ground <= -3) {
    const hasNearEgress = [dN, dE, dS, dW].some((d) => Math.abs(d) <= 2);
    if (!hasNearEgress) return { terrain_kind: 'underground', feet_vs_local_ground };
  }

  if (feet_vs_local_ground === -1) {
    return { terrain_kind: 'depression_1', feet_vs_local_ground };
  }

  if (feet_vs_local_ground === +1) {
    return { terrain_kind: 'mound_1', feet_vs_local_ground };
  }

  if (absMax <= 1 && feet_vs_local_ground === 0) {
    return { terrain_kind: 'flat', feet_vs_local_ground };
  }

  // Cliff check BEFORE slope: a 6-block jump up is a wall pathfinder
  // refuses; a 4-block rise over 16m is a walkable slope. The two bands
  // are disjoint by design (slope: delta in [2,5]; cliff: delta ≥ 6).
  const maxUp = Math.max(dN, dE, dS, dW);
  const minDown = Math.min(dN, dE, dS, dW);
  if (maxUp >= 6 && minDown >= -1) return { terrain_kind: 'cliff_above', feet_vs_local_ground };
  if (minDown <= -6 && maxUp <= 1) return { terrain_kind: 'cliff_below', feet_vs_local_ground };

  const opposites = [['N', 'S'], ['E', 'W']];
  for (const [a, b] of opposites) {
    if (deltas[a] >= 2 && deltas[a] <= 5 && Math.abs(deltas[b]) <= 1) {
      return { terrain_kind: `slope_${a}`, feet_vs_local_ground };
    }
    if (deltas[b] >= 2 && deltas[b] <= 5 && Math.abs(deltas[a]) <= 1) {
      return { terrain_kind: `slope_${b}`, feet_vs_local_ground };
    }
  }

  return { terrain_kind: 'unknown', feet_vs_local_ground };
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
  const pos = bot.entity.position;
  const feetY = Math.floor(pos.y);
  // Phase 9 PR-E: get the local-column ground with canopy detection, plus
  // the feet-block name for on_structure heuristic.
  const localGround = groundBlockYAt(bot, pos.x, pos.z, { feetY, returnDetail: true });
  const feetBlock = bot.blockAt(new Vec3(Math.floor(pos.x), feetY - 1, Math.floor(pos.z)));
  const relief = cardinalReliefDeltas(bot, 16);
  const trees = treeClusterSummary(bot, 12);
  const { terrain_kind, feet_vs_local_ground } = classifyTerrain({
    deltas: relief,
    feetY,
    // classifyTerrain compares feet plane to feet plane: convert the ground
    // BLOCK to the feet cell a bot standing on it would occupy. Standing
    // normally on the local ground ⇒ feet_vs_local_ground = 0 ⇒ flat.
    surfaceY: localGround?.y != null ? surfaceFromBlock(localGround.y) : null,
    canopyDetected: !!localGround?.canopyDetected,
    feetBlockName: feetBlock?.name || null,
  });
  return {
    biome: biomeAtFeet(bot),
    y_band: yBandLabel(pos.y),
    relief,
    trees,
    terrain_kind,
    feet_vs_local_ground,
    clause: formatLandscapeClause({
      biome: biomeAtFeet(bot),
      yBand: yBandLabel(pos.y),
      reliefFormatted: relief.formatted,
      treesText: trees.text,
    }),
    suggested_cardinal: pickSuggestedCardinalLabel(relief),
  };
}
