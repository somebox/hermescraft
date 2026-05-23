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

    // F41 (task #66, v55): vertical sweep for water below the interpolated
    // path. circuit-v54 forensics: path from base (y=64) to W1 (y=67)
    // interpolated through y=64..67. Probe sampled foot/floor at those
    // y values and saw air/grass — but the actual water on the route
    // was at y=62 (2-3 blocks below the probe). Pathfinder walks the
    // bot along the surface, which dips down when the route crosses a
    // lake — and that dip is invisible to the interpolated probe.
    //
    // Scan up to 4 blocks below py for water. If found, mark this
    // sample as water. Common case: bot at y=64 forest walking into
    // a y=62 lake; sample sees floor=air at y=63 and water at y=62.
    let waterBelow = null;
    if (fc !== 'water' && flc !== 'water') {
      for (let dy = 2; dy <= 4; dy++) {
        let below = null;
        try { below = bot.blockAt(new Vec3(px, py - dy, pz)); } catch { below = null; }
        const bc = classifySample(below);
        // Only count water if everything ABOVE it is air (a true open
        // water column, not water in a sealed pocket).
        if (bc === 'water') {
          let opens = true;
          for (let dy2 = 1; dy2 < dy; dy2++) {
            let mid = null;
            try { mid = bot.blockAt(new Vec3(px, py - dy2, pz)); } catch { mid = null; }
            const mc = classifySample(mid);
            if (mc !== 'air' && mc !== 'water') { opens = false; break; }
          }
          if (opens) { waterBelow = { y: py - dy, name: below?.name || 'water' }; break; }
        }
      }
    }

    let classification;
    if (fc === 'hazard' || hc === 'hazard' || flc === 'hazard') classification = 'hazard';
    else if (fc === 'water' || flc === 'water' || waterBelow) classification = 'water';
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
      ...(waterBelow ? { water_below_y: waterBelow.y } : {}),
      classification,
    });
  }

  const counts = out.reduce((acc, s) => { acc[s.classification] = (acc[s.classification] || 0) + 1; return acc; }, {});
  return { samples: out, counts, sample_count: n };
}

/**
 * F40 (task #66, v55): corridor probe. Samples THREE parallel lines —
 * the centre bot→end line plus two perpendicular offsets at ±`offset`
 * blocks (default 10) — and aggregates the counts.
 *
 * Motivation: the original single-line `probeRouteAlongLine` misses
 * water that the pathfinder will detour through. circuit-v54
 * forensics: bg_goto base→W1 returned ok (probe found 0/30 water on
 * the SW straight line), pathfinder routed NW around obstacles and
 * walked Steve into a 1-deep marsh. The marsh sits ~20b north of
 * the straight line — outside the original probe's coverage but
 * inside any detour the pathfinder would realistically take.
 *
 * The corridor probe samples a `2*offset` wide band of terrain
 * along the route axis, catching water the bot might encounter even
 * if the pathfinder doesn't follow the straight line. Same return
 * shape as `probeRouteAlongLine` so callers can swap freely:
 * { samples, counts, sample_count }. `sample_count` is the
 * combined total (3 × per-line) so threshold logic continues to
 * make sense.
 *
 * @param {object} bot
 * @param {{x,y,z}} start
 * @param {{x,y,z}} end
 * @param {number} [count=10]   samples PER line (3× this total)
 * @param {number} [offset=10]  perpendicular offset in XZ blocks
 */
export function probeRouteCorridor(bot, start, end, count = 10, offset = 10) {
  if (!bot || typeof bot.blockAt !== 'function') return [];
  if (!start || !end) return [];
  const sx = Number(start.x), sy = Number(start.y), sz = Number(start.z);
  const ex = Number(end.x), ey = Number(end.y), ez = Number(end.z);
  if (![sx, sy, sz, ex, ey, ez].every(Number.isFinite)) return [];

  // Compute the perpendicular XZ unit vector. The route axis is
  // (ex-sx, ez-sz); a 90° XZ rotation gives (-(ez-sz), (ex-sx)).
  // Normalize so the offset is in blocks (not distance-scaled).
  const dx = ex - sx;
  const dz = ez - sz;
  const len = Math.hypot(dx, dz) || 1;
  const pxUnit = -dz / len;
  const pzUnit = dx / len;
  const ox = pxUnit * offset;
  const oz = pzUnit * offset;

  const center = probeRouteAlongLine(bot, start, end, count);
  const left = probeRouteAlongLine(
    bot,
    { x: sx + ox, y: sy, z: sz + oz },
    { x: ex + ox, y: ey, z: ez + oz },
    count,
  );
  const right = probeRouteAlongLine(
    bot,
    { x: sx - ox, y: sy, z: sz - oz },
    { x: ex - ox, y: ey, z: ez - oz },
    count,
  );

  const samples = [
    ...(center.samples || []),
    ...(left.samples || []),
    ...(right.samples || []),
  ];
  const counts = samples.reduce((acc, s) => {
    acc[s.classification] = (acc[s.classification] || 0) + 1;
    return acc;
  }, {});
  return {
    samples,
    counts,
    sample_count: samples.length,
    lanes: ['center', 'left_perp', 'right_perp'],
    offset,
  };
}
