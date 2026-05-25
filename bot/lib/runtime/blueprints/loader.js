import fs from 'node:fs';
import path from 'node:path';
import { normalizeRegions } from '../regions/resolver.js';
import { resolveFootprint, tightFootprintFromCells } from './footprint.js';
import { assertPlanSize } from './limits.js';

const PLAN_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

export function plansDir(dataDir) {
  return path.join(dataDir, 'ops', 'plans');
}

export function planFilePath(dataDir, planId) {
  return path.join(plansDir(dataDir), `${planId}-plan.json`);
}

export function parsePlanIdFromTarget(target) {
  const t = String(target || '').trim();
  const region = t.match(/^:([a-z0-9]{2,12}):$/i);
  if (region) return { kind: 'region', regionId: region[1].toLowerCase() };
  if (PLAN_ID_RE.test(t)) return { kind: 'plan_id', planId: t.toLowerCase() };
  return { kind: 'invalid', raw: t };
}

export function loadPlanJson(dataDir, planId) {
  const fp = planFilePath(dataDir, planId);
  if (!fs.existsSync(fp)) {
    return { ok: false, code: 'PLAN_NOT_FOUND', path: fp };
  }
  const raw = fs.readFileSync(fp, 'utf8');
  const plan = JSON.parse(raw);
  return { ok: true, plan, path: fp };
}

export function buildCellsIndex(cells) {
  const index = new Map();
  for (const c of cells || []) {
    const key = c.local.join(',');
    index.set(key, c);
  }
  return index;
}

export function enrichPlan(plan) {
  const footprint = resolveFootprint(plan);
  const cells = plan.cells || [];
  const index = buildCellsIndex(cells);
  const sizeCheck = assertPlanSize(cells.length, footprint.local);
  return {
    plan,
    footprint,
    cellsIndex: index,
    sizeCheck,
    planId: plan.plan_id || null,
  };
}

/**
 * Resolve plan + anchor for a target (:region: or plan_id).
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {object} opts.target parsed from parsePlanIdFromTarget
 * @param {object[]} opts.regions
 * @param {{ x:number,y:number,z:number }} [opts.at] bot position for implicit region
 * @param {string} [opts.siteRef] :region:/site
 */
export function resolvePlanContext({ dataDir, target, regions, at, siteRef }) {
  const normalized = normalizeRegions(regions || []);

  if (target.kind === 'region') {
    const region = normalized.find((r) => r.id === target.regionId);
    if (!region?.plan) {
      return { ok: false, code: 'NO_PLAN_CONTEXT', message: `Region :${target.regionId}: has no plan=` };
    }
    const loaded = loadPlanJson(dataDir, region.plan);
    if (!loaded.ok) return loaded;
    const enriched = enrichPlan(loaded.plan);
    let anchor = enriched.plan.anchor?.coords;
    if ((!anchor || anchor.length !== 3) && siteRef) {
      anchor = null; // caller resolves site
    }
    if ((!anchor || anchor.length !== 3) && region.sites) {
      const sites = region.sites;
      const siteCoords =
        sites.anchor ||
        (typeof sites === 'object' && !Array.isArray(sites) && sites.anchor
          ? sites.anchor
          : null);
      if (siteCoords && siteCoords.x != null) {
        anchor = [siteCoords.x, siteCoords.y, siteCoords.z];
      } else if (Array.isArray(sites)) {
        const a = sites.find((s) => s.name === 'anchor');
        if (a) anchor = [a.x, a.y, a.z];
      } else if (typeof sites === 'object') {
        const a = sites.anchor || Object.values(sites)[0];
        if (a?.x != null) anchor = [a.x, a.y, a.z];
      }
    }
    if (!anchor || anchor.length !== 3) {
      return { ok: false, code: 'NO_PLAN_CONTEXT', message: 'Plan missing anchor.coords; set anchor or site on region' };
    }
    return {
      ok: true,
      planId: region.plan,
      region,
      anchor,
      ...enriched,
      path: loaded.path,
    };
  }

  if (target.kind === 'plan_id') {
    const loaded = loadPlanJson(dataDir, target.planId);
    if (!loaded.ok) return loaded;
    const enriched = enrichPlan(loaded.plan);
    const anchor = enriched.plan.anchor?.coords;
    if (!anchor || anchor.length !== 3) {
      return { ok: false, code: 'NO_PLAN_CONTEXT', message: 'Pass --site or set anchor.coords on plan file' };
    }
    return { ok: true, planId: target.planId, region: null, anchor, ...enriched, path: loaded.path };
  }

  return { ok: false, code: 'INVALID_ARGS', message: `Invalid blueprint target: ${target.raw}` };
}

/** Regions with plan= at a world point (for ambiguity check). */
export function planRegionsAt(x, y, z, regions) {
  const normalized = normalizeRegions(regions || []);
  return normalized.filter((r) => r.plan && r.anchor != null);
}

export { tightFootprintFromCells, PLAN_ID_RE };
