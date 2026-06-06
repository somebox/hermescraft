/**
 * Actionable next-step hints for path failures on slopes, lips, and non-standable targets.
 */
import { Vec3 } from 'vec3';
import { DIR_VEC_4 } from '../_directions.js';
import { standingState } from '../_nav-helpers.js';
import { buildLandscapeContext } from '../../shared/scene-landscape.js';
import { detourHintForDy } from './detour-check.js';

const AIR = new Set(['air', 'cave_air', 'void_air']);
const SLOPE_TO_STAIR = { N: 'north', E: 'east', S: 'south', W: 'west' };

function isSolidBlock(block) {
  return block && !AIR.has(block.name) && block.boundingBox === 'block';
}

/**
 * @param {import('mineflayer').Bot} b
 * @param {{ classification?: string, step_up_dirs?: string[], cell?: { x: number, y: number, z: number } }} ss
 * @returns {{ x: number, y: number, z: number } | null}
 */
export function findTwoHighLipDig(b, ss) {
  const cell = ss?.cell;
  if (!cell || !Array.isArray(ss.step_up_dirs) || !ss.step_up_dirs.length) return null;
  const by = Math.floor(cell.y);
  for (const dir of ss.step_up_dirs) {
    const d = DIR_VEC_4[dir];
    if (!d) continue;
    const fx = cell.x + d.dx;
    const fz = cell.z + d.dz;
    const foot = b.blockAt(new Vec3(fx, by, fz));
    const mid = b.blockAt(new Vec3(fx, by + 1, fz));
    const top = b.blockAt(new Vec3(fx, by + 2, fz));
    if (isSolidBlock(foot) && isSolidBlock(mid) && (!top || AIR.has(top.name))) {
      return { x: fx, y: by + 1, z: fz };
    }
    if (isSolidBlock(foot) && mid && AIR.has(mid.name) && isSolidBlock(top)) {
      return { x: fx, y: by + 2, z: fz };
    }
  }
  return null;
}

/**
 * @param {number} tx
 * @param {number} tz
 * @param {number} bx
 * @param {number} bz
 */
function targetCardinalKey(tx, tz, bx, bz) {
  const dx = tx - bx;
  const dz = tz - bz;
  if (Math.abs(dx) < 0.5 && Math.abs(dz) < 0.5) return null;
  if (Math.abs(dx) >= Math.abs(dz)) return dx > 0 ? 'E' : 'W';
  return dz > 0 ? 'S' : 'N';
}

/**
 * @param {import('mineflayer').Bot} b
 * @param {{ x: number, y: number, z: number }} target
 * @param {{ x: number, y: number, z: number }} pos
 */
function pillarAnchorHint(b, target, pos) {
  const bx = Math.floor(pos.x);
  const bz = Math.floor(pos.z);
  const ty = Math.floor(target.y);
  let best = null;
  let bestDist = Infinity;
  for (const d of Object.values(DIR_VEC_4)) {
    const ax = bx + d.dx * 2;
    const az = bz + d.dz * 2;
    const foot = b.blockAt(new Vec3(ax, ty - 1, az));
    const head = b.blockAt(new Vec3(ax, ty, az));
    const head2 = b.blockAt(new Vec3(ax, ty + 1, az));
    if (isSolidBlock(foot) && head && AIR.has(head.name) && head2 && AIR.has(head2.name)) {
      const dist = Math.abs(ax - bx) + Math.abs(az - bz);
      if (dist < bestDist) {
        bestDist = dist;
        best = { x: ax, y: ty, z: az };
      }
    }
  }
  if (!best) return null;
  const steps = Math.max(1, Math.min(12, Math.abs(ty - Math.floor(pos.y)) + 2));
  return `mc goto_near ${best.x} ${best.y} ${best.z} range=1, then mc pillar_up cobblestone ${steps} if still blocked vertically`;
}

/**
 * Standability-first hint from NAV observed_state enrichment.
 * @param {{ target_standable?: boolean, closest_standable?: { x: number, y: number, z: number } | null }} obs
 * @param {{ x: number, y: number, z: number }} target
 */
export function standabilityActionHint(obs, target) {
  if (!obs || obs.target_standable !== false) return null;
  const tx = Math.floor(Number(target.x));
  const ty = Math.floor(Number(target.y));
  const tz = Math.floor(Number(target.z));
  const prefix = `mc reachable ${tx} ${ty} ${tz}`;
  const cs = obs.closest_standable;
  if (cs && Number.isFinite(cs.x) && Number.isFinite(cs.y) && Number.isFinite(cs.z)) {
    return `${prefix}; target not standable — mc goto_near ${Math.floor(cs.x)} ${Math.floor(cs.y)} ${Math.floor(cs.z)} range=1`;
  }
  return `${prefix}; target not standable and no standable cell in range`;
}

/**
 * @param {{
 *   bot: import('mineflayer').Bot,
 *   target: { x: number, y: number, z: number },
 *   pos: { x: number, y: number, z: number },
 *   observedState?: Record<string, unknown>,
 *   reach?: { next_hop_suggestion?: { x: number, y: number, z: number } } | null,
 *   terrain?: { terrain_kind?: string } | null,
 *   standing?: ReturnType<typeof standingState> | null,
 * }} input
 * @returns {{ hint: string | null, pattern: string }}
 */
export function resolveRouteSculptHint(input) {
  const { bot: b, target, pos, observedState, terrain: terrainIn, standing: standingIn } = input;
  const tx = Math.floor(Number(target.x));
  const ty = Math.floor(Number(target.y));
  const tz = Math.floor(Number(target.z));
  const py = Number(pos?.y ?? b?.entity?.position?.y ?? ty);
  const dy = ty - py;
  const bx = Math.floor(Number(pos?.x ?? b?.entity?.position?.x ?? 0));
  const bz = Math.floor(Number(pos?.z ?? b?.entity?.position?.z ?? 0));

  const standHint = standabilityActionHint(
    observedState,
    target,
  );
  if (standHint) {
    return { hint: standHint, pattern: 'standability' };
  }

  let ss = standingIn;
  if (!ss && b) {
    try { ss = standingState(b); } catch { ss = null; }
  }
  let terrain = terrainIn;
  if (!terrain && b?.entity?.position) {
    try {
      const land = buildLandscapeContext(b);
      terrain = { terrain_kind: land.terrain_kind };
    } catch { /* ignore */ }
  }
  const kind = terrain?.terrain_kind || '';

  if (ss && (ss.classification === 'trapped' || ss.classification === 'step_up_only')) {
    const lip = findTwoHighLipDig(b, ss);
    if (lip) {
      return { hint: `mc dig ${lip.x} ${lip.y} ${lip.z}  # 2-high lip blocking step-up`, pattern: 'lip_dig' };
    }
    if (ss.classification === 'trapped') {
      return { hint: 'mc escape', pattern: 'trapped_escape' };
    }
  }

  if (Math.abs(dy) <= 3) {
    const tCard = targetCardinalKey(tx, tz, bx, bz);
    if (tCard && kind === `slope_${tCard}`) {
      const stairDir = SLOPE_TO_STAIR[tCard] || 'north';
      const len = Math.max(4, Math.min(8, Math.abs(Math.round(dy)) + 4));
      return {
        hint: `mc build_stairs cobblestone ${stairDir} ${len}  # terrain ${kind}`,
        pattern: 'ramp_build',
      };
    }
    if (kind === 'cliff_above' && dy > 1) {
      const anchor = pillarAnchorHint(b, target, pos);
      if (anchor) return { hint: anchor, pattern: 'pillar_anchor' };
      const stairDir = tCard ? (SLOPE_TO_STAIR[tCard] || 'north') : 'north';
      return {
        hint: `mc build_stairs cobblestone ${stairDir} 6  # cliff_above`,
        pattern: 'cliff_build_stairs',
      };
    }
    if (kind.startsWith('slope_')) {
      const suffix = kind.slice(6);
      const stairDir = SLOPE_TO_STAIR[suffix] || 'north';
      return {
        hint: `mc build_stairs cobblestone ${stairDir} 6  # terrain ${kind} — dig 2-high lip or stairs before pillar_up`,
        pattern: 'slope_build_stairs',
      };
    }
    if (kind === 'depression_1') {
      return { hint: 'mc escape  # depression_1', pattern: 'depression_escape' };
    }
  }

  if (dy > 3) {
    const anchor = pillarAnchorHint(b, target, pos);
    if (anchor && (kind === 'cliff_above' || kind.startsWith('slope_'))) {
      return { hint: anchor, pattern: 'pillar_anchor' };
    }
    const msg = detourHintForDy(dy);
    if (/stair_up|retrace|waypoint/i.test(msg)) {
      return { hint: 'mc stair_up or mc goto with an intermediate waypoint at your current elevation', pattern: 'vertical_detour' };
    }
    return { hint: msg, pattern: 'vertical_detour' };
  }

  if (dy < -3) {
    return {
      hint: `mc tunnel ${tx} ${ty} ${tz} down (or mc stair_down) — target is ${Math.abs(Math.round(dy))} blocks below`,
      pattern: 'tunnel_down',
    };
  }

  if (kind.startsWith('slope_') || kind === 'cliff_above') {
    return {
      hint: `mc dig_area to clear terrain blocking ${tx} ${ty} ${tz}, or mc build_stairs toward target (terrain: ${kind})`,
      pattern: 'fallback_terrain',
    };
  }

  return { hint: null, pattern: 'none' };
}
