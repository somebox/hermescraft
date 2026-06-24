/**
 * D2 / E5 gates for construct begin — plan revision + site/anchor binding.
 */

import { normalizeRegions } from './regions/resolver.js';

/**
 * @param {object} plan loaded plan JSON
 * @returns {string|null}
 */
export function readPlanRevision(plan) {
  if (plan?.revision != null && String(plan.revision).trim()) {
    return String(plan.revision).trim();
  }
  return null;
}

/**
 * Effective revision string returned on begin (explicit revision or plan_id fallback).
 * @param {object} ctxPlan resolvePlanContext result
 */
export function effectivePlanRevision(ctxPlan) {
  return readPlanRevision(ctxPlan.plan) || ctxPlan.planId || ctxPlan.plan?.plan_id || 'unknown';
}

/**
 * @param {object} body begin / task_context fields
 * @param {object} ctxPlan
 * @param {object} ctx bot state
 */
export function checkPlanRevisionGate(body, ctxPlan, ctx) {
  const expected = body.plan_revision
    ?? ctx?.runtime?.taskContext?.plan_revision
    ?? null;
  const actual = effectivePlanRevision(ctxPlan);
  if (expected != null && String(expected).trim() !== '' && String(expected) !== String(actual)) {
    return {
      ok: false,
      code: 'PLAN_REVISION_MISMATCH',
      message: `Card plan_revision "${expected}" does not match plan file revision "${actual}"`,
      hint: 'Issue a new CONSTRUCT card after intentional plan changes',
      observed_state: { expected, actual, plan_id: ctxPlan.planId },
    };
  }
  return { ok: true, plan_revision: actual };
}

function regionById(regions, id) {
  if (id == null || String(id).trim() === '') return null;
  const key = String(id).toLowerCase().replace(/^:|:$/g, '');
  return normalizeRegions(regions || []).find((r) => r.id === key) || null;
}

/**
 * @param {object} ctxPlan
 * @param {{
 *   worksite_region?: string|null,
 *   regions?: object[],
 *   card_plan_id?: string|null,
 *   markerTolerance?: number,
 * }} opts
 */
export function checkConstructSiteBindingGate(ctxPlan, opts = {}) {
  const planId = ctxPlan.planId || ctxPlan.plan?.plan_id;
  const region = ctxPlan.region || regionById(opts.regions, opts.worksite_region);
  const cardPlan = opts.card_plan_id ? String(opts.card_plan_id).trim().toLowerCase() : null;

  if (cardPlan && planId && cardPlan !== String(planId).toLowerCase()) {
    return {
      ok: false,
      code: 'PLAN_SITE_MISMATCH',
      message: `Card plan "${cardPlan}" does not match resolved plan "${planId}"`,
      hint: 'Align kanban plan: field with worksite region plan= sign binding',
      observed_state: { card_plan: cardPlan, resolved_plan_id: planId },
    };
  }

  if (opts.worksite_region && region?.plan && planId && region.plan !== planId) {
    return {
      ok: false,
      code: 'PLAN_SITE_MISMATCH',
      message: `Worksite :${region.id}: plan=${region.plan} does not match begin target plan ${planId}`,
      hint: 'Fix region sign plan= directive or use matching mc task_context plan field',
      observed_state: {
        worksite_region: region.id,
        region_plan: region.plan,
        resolved_plan_id: planId,
      },
    };
  }

  const marker = ctxPlan.plan?.anchor?.marker?.coords;
  if (region?.anchor && Array.isArray(marker) && marker.length >= 3) {
    const [mx, my, mz] = marker;
    const ra = region.anchor;
    const dist = Math.hypot(ra.x - mx, ra.y - my, ra.z - mz);
    const tol = opts.markerTolerance ?? 1.5;
    if (dist > tol) {
      return {
        ok: false,
        code: 'ANCHOR_DRIFT',
        message: `Region sign anchor drifted ${dist.toFixed(1)}m from plan marker (tol ${tol}m)`,
        hint: 'Re-survey site, update plan anchor.marker.coords, or fix region sign placement',
        observed_state: {
          plan_marker: marker,
          region_anchor: ra,
          distance: dist,
          tolerance: tol,
        },
      };
    }
  }

  return {
    ok: true,
    binding: {
      plan_id: planId,
      region_id: region?.id ?? null,
      plan_marker: marker ?? null,
    },
  };
}

/**
 * @param {{ ok: false, code: string, message: string, hint?: string, observed_state?: object }} gate
 * @param {typeof import('../shared/action-contract.js').fail} failFn
 */
export function gateToActionFail(gate, failFn) {
  return failFn(gate.code, gate.message, {
    observed_state: gate.observed_state,
    next_action_hint: gate.hint,
    retry_safe: false,
  });
}
