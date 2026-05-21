/**
 * Route probe: sample blocks along the bot→target line and classify each
 * sample so the advise LLM has concrete terrain data (water, land, lava,
 * hazard) instead of inferring from a 32-block ASCII map. Task #6.
 *
 * Used by GET /route_probe in http-app.js. The classifier is exported
 * separately so it can be unit-tested without booting a bot.
 */

import { Vec3 } from 'vec3';

export const HAZARD_NAMES = new Set([
  'lava', 'flowing_lava',
  'fire', 'soul_fire',
  'magma_block',
  'cactus',
  'sweet_berry_bush',
  'wither_rose',
  'powder_snow',
]);

const WATER_NAMES = new Set(['water', 'flowing_water']);
const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

/**
 * Classify a single block by name (and optional boundingBox) into a
 * coarse terrain category that's useful for route planning.
 *
 * Categories:
 *   - "unloaded"  block lookup returned null (chunk not loaded)
 *   - "hazard"    lava / fire / magma / cactus / etc.
 *   - "water"     water source or flowing
 *   - "air"       bot can walk through this column without breaking blocks
 *   - "land"      solid block (block-bounding-box, non-hazard, non-water)
 *   - "other"     foliage / replaceable plant / something otherwise weird
 */
export function classifySample(block) {
  if (!block) return 'unloaded';
  const name = block.name || '';
  if (HAZARD_NAMES.has(name)) return 'hazard';
  if (WATER_NAMES.has(name)) return 'water';
  if (AIR_NAMES.has(name)) return 'air';
  if (block.boundingBox === 'block') return 'land';
  return 'other';
}

/**
 * Sample `count` evenly-spaced points along the line from start to end
 * (inclusive of both endpoints). For each XZ sample, probe a small
 * vertical column near the bot's Y to capture the foot block (what the
 * bot would walk into) plus one cell up (head) and one cell down (floor).
 *
 * Returns an array of { x, y, z, foot, head, floor, classification }.
 *
 * Bounds: count is clamped to [2, 50]. Longer routes get the same number
 * of samples (denser sampling on short routes, sparser on long ones).
 * The 50-cap keeps the probe under ~150 blockAt() calls per advise.
 */
export function probeRouteAlongLine(bot, start, end, count = 20) {
  if (!bot || typeof bot.blockAt !== 'function') return [];
  if (!start || !end) return [];
  const sx = Number(start.x), sy = Number(start.y), sz = Number(start.z);
  const ex = Number(end.x), ey = Number(end.y), ez = Number(end.z);
  if (![sx, sy, sz, ex, ey, ez].every(Number.isFinite)) return [];

  const n = Math.max(2, Math.min(50, Math.floor(Number(count) || 20)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const px = Math.floor(sx + (ex - sx) * t);
    const py = Math.floor(sy + (ey - sy) * t);
    const pz = Math.floor(sz + (ez - sz) * t);

    let foot = null;
    let head = null;
    let floor = null;
    try { foot = bot.blockAt(new Vec3(px, py, pz)); } catch { foot = null; }
    try { head = bot.blockAt(new Vec3(px, py + 1, pz)); } catch { head = null; }
    try { floor = bot.blockAt(new Vec3(px, py - 1, pz)); } catch { floor = null; }

    const fc = classifySample(foot);
    const hc = classifySample(head);
    const flc = classifySample(floor);

    let classification;
    if (fc === 'hazard' || hc === 'hazard' || flc === 'hazard') classification = 'hazard';
    else if (fc === 'water' || flc === 'water') classification = 'water';
    else if (fc === 'unloaded') classification = 'unloaded';
    else if (fc === 'land') classification = 'wall';
    else if (flc === 'land') classification = 'land';
    else if (fc === 'air' && flc === 'air') classification = 'gap';
    else classification = fc;

    out.push({
      x: px, y: py, z: pz,
      foot: foot?.name || null,
      head: head?.name || null,
      floor: floor?.name || null,
      classification,
    });
  }

  const counts = out.reduce((acc, s) => { acc[s.classification] = (acc[s.classification] || 0) + 1; return acc; }, {});
  return { samples: out, counts, sample_count: n };
}
