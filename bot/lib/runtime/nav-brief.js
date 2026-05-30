/**
 * Per-round navigation brief (planner + renderer). See docs/features/route-precompute-context.md.
 */

import { formatStandingSituation } from '../shared/perception.js';
import { floorCellFromPos } from './nav-trail.js';
import { getConfig } from '../config/index.js';
import { shouldSkipDigAt } from './regions/policy-guard.js';
import { isDigProtected } from './dig-tools.js';

export const NAV_BRIEF_SCHEMA = 'nav_brief/1';
export const KEY_LOCATION_CAP = 8;
/** Total compute ceiling before PARTIAL_BRIEF (override via deps.budgetMs). */
export const DEFAULT_BRIEF_BUDGET_MS = 100;
/** Shadow-mode SLO ceiling (D4): calibrate from p95 compute_ms in nav_brief_shadow logs. */
export const NAV_BRIEF_SLO_MS = DEFAULT_BRIEF_BUDGET_MS * 3;
export const GET_PATH_TIMEOUT_MS = 1200;
const WALK_PROFILES = ['walk', 'dig'];
const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air']);

function isSolidBlock(blk) {
  return blk && !AIR_BLOCKS.has(blk.name) && blk.boundingBox === 'block';
}

/**
 * First solid cell on the leg toward goal (fallback when reachability has no hop).
 * @param {any} bot
 * @param {{ x: number, y: number, z: number }} goal
 */
export function rayFirstSolidBlocker(bot, goal) {
  if (!bot?.blockAt || !bot?.entity?.position) return null;
  const pos = bot.entity.position;
  const fx = Math.floor(pos.x);
  const fy = Math.floor(pos.y);
  const fz = Math.floor(pos.z);
  const tx = Math.floor(goal.x);
  const ty = Math.floor(goal.y);
  const tz = Math.floor(goal.z);
  const steps = Math.max(Math.abs(tx - fx), Math.abs(ty - fy), Math.abs(tz - fz), 1);
  for (let i = 1; i <= Math.min(steps, 24); i++) {
    const t = i / steps;
    const cx = Math.floor(fx + (tx - fx) * t);
    const cy = Math.floor(fy + (ty - fy) * t);
    const cz = Math.floor(fz + (tz - fz) * t);
    for (const dy of [0, 1]) {
      const blk = bot.blockAt(cx, cy + dy, cz);
      if (isSolidBlock(blk)) {
        return { x: cx, y: cy + dy, z: cz, block: blk.name };
      }
    }
  }
  return null;
}

/**
 * k=1 choke candidate via optional Movements-backed reachability (Phase 2 stub).
 * @param {any} bot
 * @param {{ x: number, y: number, z: number }} goal
 * @param {{ computeReachability?: (bot: any, target: any, maxVisit?: number) => any, reachVisit?: number }} deps
 */
export function findK1BlockerCell(bot, goal, deps = {}) {
  const computeReachability = deps.computeReachability;
  const g = { x: Math.floor(goal.x), y: Math.floor(goal.y), z: Math.floor(goal.z) };
  if (typeof computeReachability === 'function') {
    const reach = computeReachability(bot, g, deps.reachVisit ?? 96);
    if (reach?.walkable_to_target) return null;
    const hop = reach?.next_hop_suggestion;
    if (hop) {
      for (const dy of [0, 1]) {
        const blk = bot.blockAt(hop.x, hop.y + dy, hop.z);
        if (isSolidBlock(blk)) {
          return { x: hop.x, y: hop.y + dy, z: hop.z, block: blk.name };
        }
      }
    }
  }
  return rayFirstSolidBlocker(bot, g);
}

/**
 * @param {Record<string, any>} ctx
 * @param {any} bot
 * @param {{ name: string, x: number, y: number, z: number }} loc
 * @param {Record<string, any>} deps
 */
export function buildK1RepairHint(ctx, bot, loc, deps = {}) {
  const goal = { x: loc.x, y: loc.y, z: loc.z };
  const blocker = findK1BlockerCell(bot, goal, deps);
  if (!blocker) return null;

  const config = deps.getConfig?.() ?? getConfig();
  const skipFn = deps.shouldSkipDigAt ?? shouldSkipDigAt;
  const protectedFn = deps.isDigProtected ?? isDigProtected;
  const skip = skipFn(ctx, config, blocker.block || 'stone', blocker.x, blocker.y, blocker.z, protectedFn);
  if (skip.skip) {
    return { refused: true, reason: skip.regionId ? `protect:${skip.regionId}` : 'protect' };
  }

  if (typeof deps.confirmK1Repair === 'function' && !deps.confirmK1Repair(ctx, bot, loc, blocker, deps)) {
    return null;
  }
  if (typeof deps.confirmK1Repair !== 'function') {
    const pos = bot.entity.position;
    const d = Math.hypot(blocker.x - pos.x, blocker.y - pos.y, blocker.z - pos.z);
    if (d > 16) return null;
  }

  return {
    composite: `dig ${blocker.x} ${blocker.y} ${blocker.z} → move ${loc.name}`,
    dig_cell: { x: blocker.x, y: blocker.y, z: blocker.z },
  };
}

/**
 * When every mark row is blocked, attach a composite k=1 hint on the nearest one (v1).
 * @param {Record<string, any>} ctx
 * @param {any} bot
 * @param {Array<Record<string, any>>} ranked
 * @param {Array<{ name: string, x: number, y: number, z: number }>} candidates
 * @param {{ nav_mode?: string }} frame
 * @param {Record<string, any>} deps
 */
export function applyK1RepairToRanked(ctx, bot, ranked, candidates, frame, deps) {
  const moveRows = ranked.filter((p) => p.verb === 'move');
  if (!moveRows.some((p) => p.blocked)) return ranked;
  if (moveRows.some((p) => p.reachable && !p.blocked)) return ranked;

  const target = [...moveRows]
    .filter((p) => p.blocked)
    .sort((a, b) => (a.straight_m ?? 9999) - (b.straight_m ?? 9999))[0];
  if (!target) return ranked;

  const loc = candidates.find((c) => c.name === target.label);
  if (!loc) return ranked;

  const hint = buildK1RepairHint(ctx, bot, loc, deps);
  if (!hint) return ranked;
  if (hint.refused) {
    target.repair_refused = hint.reason;
    return ranked;
  }

  target.composite_hint = hint.composite;
  target.repair_dig_cell = hint.dig_cell;
  target.via_k1_repair = true;
  target.blocked = false;
  target.reachable = true;
  if (frame.nav_mode === 'open') {
    for (const p of ranked) {
      if (p.suggested) p.suggested = false;
    }
    target.suggested = true;
    // Promote the repaired row to the head of the move-verb section so
    // the ← suggested annotation lands at the top of the visible list.
    // Without this, the row stays where it was placed when blocked, and
    // the agent reads "suggested" mid-list under other (non-blocked but
    // farther) rows.
    const idx = ranked.indexOf(target);
    if (idx > 0) {
      ranked.splice(idx, 1);
      let insertAt = 0;
      while (insertAt < ranked.length && ranked[insertAt].verb !== 'move') insertAt++;
      ranked.splice(insertAt, 0, target);
    }
  }
  return ranked;
}

const CONFINED_CLASSIFICATIONS = new Set([
  'enclosure_inside',
  'three_walled',
  'trapped',
  'head_blocked',
]);

/**
 * @param {Record<string, any>} ctx
 * @param {{ cells?: Array<{ x: number, y: number, z: number }> }} [detail]
 */
export function markBriefRefreshRequired(ctx, detail = {}) {
  if (!ctx?.runtime) return;
  ctx.runtime.briefRefreshRequired = { ts: Date.now(), ...detail };
}

/** Stable key for a brief path row (`move base_anchor`, `retrace --trail`, …). */
export function navBriefLineKey(row) {
  if (!row || typeof row !== 'object') return '';
  const verb = String(row.verb || '').trim();
  const args = String(row.args ?? '').trim();
  return verb ? `${verb}:${args}` : '';
}

/**
 * Round-scoped suppression after a live nav failure (Phase 2).
 * @param {Record<string, any>} ctx
 * @param {string} lineKey
 * @param {Record<string, unknown>} [detail]
 */
export function recordNavBriefNegativeLeg(ctx, lineKey, detail = {}) {
  if (!ctx?.runtime || !lineKey) return;
  if (!ctx.runtime.navBriefNegativeLegs || typeof ctx.runtime.navBriefNegativeLegs !== 'object') {
    ctx.runtime.navBriefNegativeLegs = {};
  }
  ctx.runtime.navBriefNegativeLegs[lineKey] = { ts: Date.now(), ...detail };
}

/**
 * Drop path rows suppressed by volatile negative legs this round.
 * @param {Record<string, any>} ctx
 * @param {Array<Record<string, any>>} paths
 */
export function reconcileNavBriefPaths(ctx, paths, deps = {}) {
  const legs = ctx?.runtime?.navBriefNegativeLegs;
  let list = Array.isArray(paths) ? paths : [];
  if (legs && typeof legs === 'object') {
    list = list.filter((p) => {
      const key = navBriefLineKey(p);
      return !(key && legs[key]);
    });
  }
  const cells = ctx?.runtime?.briefRefreshRequired?.cells;
  const locs = deps.loadLocations?.() || {};
  if (Array.isArray(cells) && cells.length) {
    list = list.map((p) => {
      if (p.verb !== 'move' || typeof p.args !== 'string') return p;
      const loc = locs[p.args];
      if (!loc) return p;
      const crosses = cells.some(
        (c) => Math.abs(c.x - loc.x) <= 1 && Math.abs(c.z - loc.z) <= 1 && Math.abs(c.y - loc.y) <= 2,
      );
      if (!crosses) return p;
      return {
        ...p,
        blocked: true,
        stale_after_mutation: true,
        reachable: false,
        suggested: false,
      };
    });
  }
  return list;
}

/**
 * @param {any} bot
 */
export function briefPosSnapshot(bot) {
  const p = bot?.entity?.position;
  if (!p) return null;
  return floorCellFromPos(p);
}

/**
 * @param {Record<string, any>} ctx
 * @param {{ pos_snapshot?: { x: number, y: number, z: number } }|null} brief
 */
export function isNavBriefStale(ctx, brief) {
  if (!brief) return false;
  const snap = brief.pos_snapshot;
  const cur = briefPosSnapshot(ctx?.world?.bot);
  if (!snap || !cur) return false;
  return snap.x !== cur.x || snap.y !== cur.y || snap.z !== cur.z;
}

/**
 * @param {Record<string, any>|null} standing
 */
export function summarizeStandingForBrief(standing) {
  if (!standing || standing.error) return null;
  const bits = [];
  if (standing.classification) bits.push(standing.classification);
  if (Array.isArray(standing.open_dirs) && standing.open_dirs.length) {
    bits.push(`open_dirs [${standing.open_dirs.join(', ')}]`);
  }
  if (Array.isArray(standing.step_up_dirs) && standing.step_up_dirs.length) {
    bits.push(`step_up_dirs [${standing.step_up_dirs.join(', ')}]`);
  }
  return bits.length ? bits.join('; ') : null;
}

export function classifyNavMode(standing) {
  if (!standing || standing.error) {
    return { mode: 'open', signals: { exit_count: 4, text: '4 exits' } };
  }
  const exits = standing.open_dirs?.length ?? 0;
  if (CONFINED_CLASSIFICATIONS.has(standing.classification)) {
    const density = typeof standing.local_density === 'number' ? standing.local_density : 0.81;
    return {
      mode: 'confined',
      signals: {
        exit_count: exits,
        density,
        text: `${exits} exit, density ${density.toFixed(2)}`,
      },
    };
  }
  return {
    mode: 'open',
    signals: { exit_count: exits, text: `${exits} exits` },
  };
}

/**
 * @param {Record<string, any>} ctx
 */
function buildJourney(ctx) {
  const crumbs = ctx?.runtime?.navTrail?.crumbs;
  if (!Array.isArray(crumbs) || crumbs.length === 0) {
    return { line: null, crumbs: [] };
  }
  const segments = [];
  for (const c of crumbs) {
    if (c.junction) segments.push(String(c.junction).replace(/_/g, ' '));
    else segments.push(`${c.x},${c.y},${c.z}`);
  }
  segments.push('here');
  return { line: segments.join(' → '), crumbs: crumbs.slice(-8) };
}

function headerSituationLabel(standing, navMode) {
  if (navMode !== 'confined') return 'Surface';
  // formatStandingSituation already classifies the bot's local situation
  // (pit, sealed, alley…). Use a slightly more specific label when it can
  // tell us so the header isn't just "Underground" for every confined state.
  const long = formatStandingSituation(standing);
  if (long) {
    const lc = long.toLowerCase();
    if (lc.includes('pit')) return 'Pit';
    if (lc.includes('alley') || lc.includes('corridor')) return 'Tunnel';
  }
  return 'Underground';
}

/**
 * Situated frame: nav_mode, header, journey (Phase 0c).
 * @param {Record<string, any>} ctx
 * @param {{ getStandingState?: (bot: any) => any, now?: () => number }} deps
 */
export function buildNavFrame(ctx, deps = {}) {
  const bot = ctx?.world?.bot;
  const getStanding = deps.getStandingState ?? (() => null);
  const standing = bot && getStanding ? getStanding(bot) : null;
  const { mode: nav_mode, signals: nav_mode_signals } = classifyNavMode(standing);
  const pos_snapshot = briefPosSnapshot(bot);
  const journey = buildJourney(ctx);
  const situation = headerSituationLabel(standing, nav_mode);
  const computed_at = deps.now?.() ?? Date.now();
  return {
    standing,
    nav_mode,
    nav_mode_signals,
    pos_snapshot,
    journey,
    header: {
      situation,
      pos: pos_snapshot,
      nav_mode,
      signals: nav_mode_signals,
      computed_at,
    },
  };
}

/**
 * @param {Record<string, any>} ctx
 * @param {{ loadLocations?: () => Record<string, { x: number, y: number, z: number, note?: string }> }} deps
 * @param {number} [cap]
 */
export function collectKeyLocations(ctx, deps, cap = KEY_LOCATION_CAP) {
  const locs = deps.loadLocations?.() || {};
  const botPos = ctx?.world?.bot?.entity?.position;
  if (!botPos) return [];
  return Object.entries(locs)
    .map(([name, l]) => ({
      name,
      x: l.x,
      y: l.y,
      z: l.z,
      straight_m: Math.round(
        Math.hypot(botPos.x - l.x, botPos.y - l.y, botPos.z - l.z),
      ),
      kind: 'mark',
    }))
    .sort((a, b) => a.straight_m - b.straight_m)
    .slice(0, cap);
}

/**
 * @param {Array<Record<string, any>>} paths
 * @param {{ nav_mode?: string }} [policy]
 */
export function rankNavBriefPaths(paths, policy = {}) {
  const nav_mode = policy.nav_mode || 'open';
  // Confined mode: don't DROP strategic rows — tag them so the agent still
  // sees that base/chest/etc exist and are currently sealed. The doctrine
  // (`docs/features/route-precompute-context.md`, lines 188-190) is "blocked
  // strategic marks are still listed, carry ⚠ and never ← suggested." We
  // keep local rows, the back-line, and DO primitives untouched; we mark
  // distant strategic moves as confined-blocked.
  let list = paths.map((p) => {
    if (nav_mode !== 'confined') return { ...p };
    const isLocalish = p.local || p.label === 'back' || p.verb !== 'move' || (p.straight_m ?? 999) <= 32;
    if (isLocalish) return { ...p };
    return {
      ...p,
      blocked: true,
      reachable: false,
      suggested: false,
      confined_strategic: true,
    };
  });
  list.sort((a, b) => {
    if (!!a.reachable !== !!b.reachable) return a.reachable ? -1 : 1;
    return (a.straight_m ?? 9999) - (b.straight_m ?? 9999);
  });
  if (nav_mode === 'open') {
    for (const p of list) {
      if (p.reachable && !p.blocked && p.verb === 'move') {
        p.suggested = true;
        break;
      }
    }
  }
  return list;
}

/**
 * @param {Record<string, any>} ctx
 * @param {object} goal
 * @param {{ profile?: string, timeoutMs?: number }} opts
 * @param {Record<string, any>} deps
 */
function probePathTo(ctx, bot, goal, opts, deps) {
  const fn = deps.getPathTo;
  if (typeof fn !== 'function') return null;
  return fn(ctx, bot, goal, opts);
}

function pathSucceeded(result) {
  if (!result) return false;
  if (result.status === 'success') return true;
  if (result.ok === true) return true;
  return false;
}

/**
 * @param {Record<string, any>} ctx
 * @param {{
 *   loadLocations?: () => Record<string, any>,
 *   getStandingState?: (bot: any) => any,
 *   getPathTo?: (ctx: any, bot: any, goal: any, opts: any) => any,
 *   budgetMs?: number,
 *   now?: () => number,
 * }} [deps]
 */
export function computeNavBrief(ctx, deps = {}) {
  const t0 = deps.now?.() ?? Date.now();
  const budgetMs = deps.budgetMs ?? DEFAULT_BRIEF_BUDGET_MS;
  const brief_id = `nb-${t0}`;

  const elapsed = () => (deps.now?.() ?? Date.now()) - t0;

  try {
    const bot = ctx?.world?.bot;
    if (!bot?.entity?.position) {
      return { brief: null, status: 'NO_BRIEF', compute_ms: 0, error: 'no_bot' };
    }

    const frame = buildNavFrame(ctx, deps);
    const candidates = collectKeyLocations(ctx, deps);
    const paths = [];
    let partial = false;

    const trail = ctx?.runtime?.navTrail?.crumbs;
    if (Array.isArray(trail) && trail.length >= 2) {
      paths.push({
        label: 'back',
        verb: 'retrace',
        args: '--trail',
        provenance: 'seen',
        profile: 'walk',
        reachable: true,
        local: true,
        do_primitive: true,
      });
    }

    for (const loc of candidates) {
      if (elapsed() >= budgetMs) {
        partial = true;
        break;
      }
      let reachable = false;
      let profile = 'none';
      let path_m = null;
      for (const prof of WALK_PROFILES) {
        if (elapsed() >= budgetMs) {
          partial = true;
          break;
        }
        const goal = { x: loc.x, y: loc.y, z: loc.z };
        const result = probePathTo(ctx, bot, goal, {
          profile: prof,
          timeoutMs: GET_PATH_TIMEOUT_MS,
          // Marks are landmarks (chests, anchors, scout pins) — "reachable"
          // means we can stand within 2 cells, not on the literal block.
          // Without this every chest mark renders ⚠ blocked (see g-2026-05-30-2
          // postmortem: Steward at base saw all 5 chests as blocked).
          radius: 2,
        }, deps);
        if (pathSucceeded(result)) {
          reachable = true;
          profile = prof;
          path_m = result.path?.length ?? result.pathLength ?? null;
          break;
        }
      }
      paths.push({
        label: loc.name,
        verb: 'move',
        args: loc.name,
        straight_m: loc.straight_m,
        path_m,
        profile,
        provenance: 'inferred',
        reachable,
        blocked: !reachable,
      });
    }

    const ranked = applyK1RepairToRanked(
      ctx,
      bot,
      rankNavBriefPaths(
        reconcileNavBriefPaths(ctx, paths, deps),
        { nav_mode: frame.nav_mode },
      ),
      candidates,
      frame,
      deps,
    );
    // Single source of truth for degraded status is the result envelope
    // (`status` field below). We intentionally do NOT also stash it on
    // the brief struct — duplicating it causes consumers to disagree.
    const brief = {
      schema_version: NAV_BRIEF_SCHEMA,
      brief_id,
      computed_at: t0,
      pos_snapshot: frame.pos_snapshot,
      nav_mode: frame.nav_mode,
      nav_mode_signals: frame.nav_mode_signals,
      paths: ranked,
      journey: frame.journey,
      header: frame.header,
      standing_summary: summarizeStandingForBrief(frame.standing),
    };

    return {
      brief,
      status: partial ? 'PARTIAL_BRIEF' : null,
      compute_ms: elapsed(),
      mark_count: candidates.length,
      reachable_count: ranked.filter((p) => p.reachable).length,
      total_paths: ranked.length,
    };
  } catch (err) {
    return {
      brief: null,
      status: 'NO_BRIEF',
      compute_ms: elapsed(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Deterministic text projection of a typed brief.
 * @param {Record<string, any>|null|undefined} brief
 */
export function renderNavBrief(brief, statusContext = {}) {
  if (!brief) return '';
  const p = brief.pos_snapshot;
  const posStr = p ? `${p.x},${p.y},${p.z}` : '?, ?, ?';
  const sit = brief.header?.situation || (brief.nav_mode === 'confined' ? 'Underground' : 'Surface');
  const sig = brief.nav_mode_signals?.text || '';
  const asOf = brief.computed_at != null ? `as_of=${brief.computed_at}` : '';
  // Surface degraded modes to the agent in the prose — per D2, the
  // renderer is the agent-facing source of truth, so PARTIAL_BRIEF/
  // STALE_BRIEF/brief_refresh_required must show up in text or the
  // doctrine ("treat missing rows as unknown, not blocked") can't fire.
  const status = statusContext.nav_brief_status || null;
  const refreshed = statusContext.brief_refresh_required === true;
  const lines = [
    `${sit} at ${posStr} — ${brief.nav_mode} (${sig})   ${asOf}`.trimEnd(),
  ];
  if (status === 'PARTIAL_BRIEF') {
    lines.push('⚠ PARTIAL_BRIEF: some destinations not probed within budget — treat missing rows as unknown, not blocked');
  } else if (status === 'STALE_BRIEF') {
    lines.push('⚠ STALE_BRIEF: position changed since compute — re-read mc standing/mc reachable before acting on a line');
  }
  if (refreshed) {
    lines.push('⚠ brief_refresh_required: terrain mutated since last brief — re-read before committing');
  }
  lines.push('paths:');
  for (const row of brief.paths || []) {
    const tags = [];
    if (row.straight_m != null) tags.push(`(${row.straight_m}m)`);
    if (row.provenance) tags.push(row.provenance);
    if (row.blocked) tags.push(row.confined_strategic ? '⚠ blocked (confined)' : '⚠ blocked');
    if (row.stale_after_mutation) tags.push('⚠ stale (terrain changed)');
    if (row.repair_refused) tags.push('⚠ repair refused (protect)');
    if (row.suggested) tags.push('← suggested');
    if (row.via_k1_repair) tags.push('k=1');
    const cmd = row.composite_hint || `${row.verb} ${row.args}`.trim();
    const labelCol = `- ${row.label}:`;
    const body = tags.length ? `${cmd}     ${tags.join(', ')}` : cmd;
    lines.push(`${labelCol.padEnd(16)}${body}`);
  }
  if (brief.journey?.line) {
    lines.push(`journey: ${brief.journey.line}`);
  }
  if (brief.standing_summary && brief.nav_mode === 'confined') {
    lines.push(`standing: ${brief.standing_summary}`);
  }
  return lines.join('\n');
}

/**
 * Shadow-mode structured log (console or ctx.runtime).
 * @param {Record<string, any>} ctx
 * @param {Record<string, any>} result
 * @param {Array<any>|undefined} nearbyMarks
 */
export function logNavBriefShadow(ctx, result, nearbyMarks) {
  const entry = {
    event: 'nav_brief_shadow',
    brief_id: result.brief?.brief_id ?? null,
    nav_mode: result.brief?.nav_mode ?? null,
    mark_count: result.mark_count ?? 0,
    reachable: result.reachable_count ?? 0,
    total: result.total_paths ?? 0,
    compute_ms: result.compute_ms ?? 0,
    slo_ms: NAV_BRIEF_SLO_MS,
    slo_exceeded: (result.compute_ms ?? 0) > NAV_BRIEF_SLO_MS,
    status: result.status ?? null,
    nearby_marks_count: nearbyMarks?.length ?? 0,
  };
  if (typeof ctx?.runtime?.navBriefLog === 'function') {
    ctx.runtime.navBriefLog(entry);
    return;
  }
  console.log(JSON.stringify(entry));
}
