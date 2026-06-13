/**
 * Reactive hazard → mine-registry bridge.
 *
 * When a dig breaches lava/water (detectPostDigBreach), the bot records the
 * spot as a `danger` point so future sessions (and other bots) route around
 * it. This module is the pure, testable half: resolve which mine the danger
 * attaches to, and write the point. The live recovery (water auto-plug /
 * lava retreat) stays in the dig handler — only the recording lives here.
 */
import { normalizeMineId } from './index.js';

/** Fluid family of a breach kind ('lava'|'flowing_lava' → 'lava', else 'water'). */
export function dangerFamily(breachKind) {
  return String(breachKind || '').includes('lava') ? 'lava' : 'water';
}

/**
 * Which mine does an auto-recorded danger attach to?
 *   1. the task_context worksite, if it names a known mine;
 *   2. else the nearest mine entrance within maxDist;
 *   3. else null — a flat registry has nowhere to put an orphan danger.
 *
 * @returns {string|null} mine id
 */
export function resolveDangerMine(store, { worksiteRegion, pos, maxDist = 48 } = {}) {
  if (!store) return null;
  if (worksiteRegion) {
    const id = normalizeMineId(worksiteRegion);
    if (id && store.get(id)) return id;
  }
  if (pos) {
    const near = store.nearestEntrance(pos, maxDist);
    if (near) return near.mineId;
  }
  return null;
}

/**
 * Record a breach as a `danger` point on the resolved mine. Never throws —
 * a recording failure must not break the dig that triggered it.
 *
 * @returns {{ mineId: string, point: object } | { mineId: null, reason: string }}
 */
export function recordBreachDanger(store, breach, { worksiteRegion, pos, sealed, by, maxDist = 48 } = {}) {
  try {
    if (!store) return { mineId: null, reason: 'no_store' };
    if (!breach?.breach_cell) return { mineId: null, reason: 'no_breach_cell' };
    const mineId = resolveDangerMine(store, { worksiteRegion, pos: pos || breach.breach_cell, maxDist });
    if (!mineId) return { mineId: null, reason: 'no_mine_in_range' };
    const point = store.addPoint(mineId, {
      kind: 'danger',
      pos: breach.breach_cell,
      hazard: dangerFamily(breach.kind),
      sealed: !!sealed,
      by: by || null,
    });
    return { mineId, point };
  } catch (e) {
    return { mineId: null, reason: String(e?.message || e) };
  }
}
