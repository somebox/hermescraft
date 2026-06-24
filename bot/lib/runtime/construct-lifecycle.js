/**
 * Construct session lifecycle: begin pipeline, task_context auto-begin, teardown.
 */

import path from 'node:path';
import { Vec3 } from 'vec3';
import { ok, fail } from '../shared/action-contract.js';
import { createBlueprintActions } from '../actions/blueprints/index.js';
import { parsePlanIdFromTarget, resolvePlanContext, loadPlanJson, enrichPlan } from './blueprints/loader.js';
import { evaluateConstructEndGates } from './construct-end-gates.js';
import { computeMaterialsMissing } from './construct-materials.js';
import { evaluateConstructSiteReadiness } from './construct-site-readiness.js';
import {
  checkConstructSiteBindingGate,
  checkPlanRevisionGate,
  gateToActionFail,
  effectivePlanRevision,
} from './construct-begin-gates.js';
import {
  constructScopingEnabled,
  getConstructContext,
  setConstructContext,
  worksetFromVerifyMismatches,
} from './construct-context.js';

function dataDirFromCtx(ctx) {
  if (ctx.runtime?.dataDir) return ctx.runtime.dataDir;
  const fp = ctx.runtime?.regions?.filePath;
  if (fp) return path.dirname(fp);
  return null;
}

export function clearConstructSession(ctx) {
  setConstructContext(ctx, null);
  if (ctx?.runtime) delete ctx.runtime._constructWorkset;
}

/**
 * When a construct session is active, kanban/card completion should wait for construct end.
 *
 * @param {object} ctx
 * @returns {{ code: string, message: string, next_action_hint: string }|null}
 */
export function constructCompletionBlockedReason(ctx) {
  if (!constructScopingEnabled()) return null;
  const session = getConstructContext(ctx);
  if (!session) return null;
  return {
    code: 'CONSTRUCT_SESSION_ACTIVE',
    message: `Construct session still active for plan ${session.plan_id}`,
    next_action_hint: 'mc construct show — fix workset; mc construct end when phase clean, then complete the card',
  };
}

/**
 * @param {object} ctx
 * @param {string} newCardId
 */
export function autoClearConstructOnCardChange(ctx, newCardId) {
  const session = getConstructContext(ctx);
  if (!session) return;
  const bound = session.card_id;
  if (bound && String(bound) !== String(newCardId)) {
    clearConstructSession(ctx);
    return;
  }
  const tc = ctx.runtime?.taskContext;
  if (tc?.card_id && String(tc.card_id) !== String(newCardId)) {
    clearConstructSession(ctx);
  }
}

/**
 * @param {object} httpBody POST /task-context body
 * @param {string|null} worksite_region normalized
 */
export function constructFieldsForTaskContext(httpBody, worksite_region) {
  const plan = httpBody.plan || httpBody.plan_id || null;
  const level = httpBody.level != null ? Number(httpBody.level) : undefined;
  const range = httpBody.range;
  const phase = httpBody.phase;
  const card_kind = httpBody.card_kind
    || (plan && (level != null || range || phase) ? 'CONSTRUCT' : undefined);
  const out = {};
  if (plan) out.plan = String(plan);
  if (card_kind) out.card_kind = String(card_kind);
  if (level != null && Number.isFinite(level)) out.level = level;
  if (range != null) out.range = range;
  if (phase != null) out.phase = phase;
  if (httpBody.plan_revision != null) out.plan_revision = String(httpBody.plan_revision);
  if (httpBody.construct_auto_begin === false) out.construct_auto_begin = false;
  if (worksite_region && !plan) {
    // CONSTRUCT cards often name worksite only; plan resolves from region plan=
    if (card_kind === 'CONSTRUCT') out.plan_target = `:${worksite_region}:`;
  }
  return out;
}

function parseBeginTarget(body) {
  const raw = body.target || body.plan_id || body.plan || body.region;
  if (!raw) return null;
  return parsePlanIdFromTarget(String(raw).trim());
}

function parsePhaseRange(raw) {
  if (Array.isArray(raw)) return raw.map(Number);
  if (typeof raw === 'string') {
    const m = raw.match(/^(-?\d+)\.\.(-?\d+)$/);
    if (m) return [Number(m[1]), Number(m[2])];
  }
  return undefined;
}

/** Stable key for materials_by_phase and workset phase_id. */
export function resolvePhaseKey(phase) {
  if (!phase || typeof phase !== 'object') return null;
  if (phase.id != null && String(phase.id).trim()) return String(phase.id).trim();
  if (phase.level != null && Number.isFinite(Number(phase.level))) return String(Number(phase.level));
  const range = parsePhaseRange(phase.range);
  if (range && range.length === 2) return `${range[0]}..${range[1]}`;
  return null;
}

/** Align session.phase with blueprint_verify slice (level / range / phase id). */
function phaseFromBeginBody(body) {
  if (body.phase && typeof body.phase === 'object') return body.phase;
  if (body.phase_id) return { id: String(body.phase_id) };
  if (body.level != null && Number.isFinite(Number(body.level))) {
    return { level: Number(body.level) };
  }
  const range = parsePhaseRange(body.range);
  if (range) return { range };
  return {};
}

/**
 * @param {object} deps
 * @param {object} body
 */
export function resolvePlanContextForBegin(deps, body) {
  const dataDir = dataDirFromCtx(deps.ctx);
  if (!dataDir) {
    return { err: fail('INTERNAL', 'Blueprint dataDir not configured', { retry_safe: false }) };
  }
  const target = parseBeginTarget(body);
  if (!target || target.kind === 'invalid') {
    return { err: fail('NO_PLAN_CONTEXT', 'Missing blueprint target for readiness', { retry_safe: false }) };
  }
  const regions = deps.ctx.runtime?.regions?.list?.() || [];
  const ctxPlan = resolvePlanContext({ dataDir, target, regions, siteRef: body.site });
  if (!ctxPlan.ok) {
    return { err: fail(ctxPlan.code || 'PLAN_NOT_FOUND', ctxPlan.message || 'Plan not found', { retry_safe: false }) };
  }
  return { ctxPlan };
}

/**
 * @param {object} ctx
 * @param {{ plan?: string, worksite_region?: string|null, plan_target?: string }} fields
 */
export function resolveConstructPlanSnapshot(ctx, fields) {
  const dataDir = dataDirFromCtx(ctx);
  if (!dataDir) return { ok: false, code: 'NO_DATA_DIR' };
  const raw = fields.plan || fields.plan_target;
  if (!raw) return { ok: false, code: 'NO_PLAN' };
  const target = parsePlanIdFromTarget(raw.startsWith(':') ? raw : String(raw));
  if (target.kind === 'invalid') return { ok: false, code: 'INVALID_PLAN' };
  const regions = ctx.runtime?.regions?.list?.() || [];
  const ctxPlan = resolvePlanContext({ dataDir, target, regions, siteRef: fields.plan_target });
  if (!ctxPlan.ok) return ctxPlan;
  return {
    ok: true,
    plan_id: ctxPlan.planId,
    target: raw,
    anchor: ctxPlan.anchor,
    footprint: ctxPlan.footprint,
  };
}

/**
 * @param {object} taskContext merged task_context record
 * @param {object} httpBody
 */
export function shouldAutoBeginConstruct(taskContext, httpBody) {
  if (httpBody.construct_auto_begin === false || taskContext.construct_auto_begin === false) {
    return false;
  }
  if (!constructScopingEnabled()) return false;
  if (taskContext.card_kind !== 'CONSTRUCT') return false;
  const hasPlan = !!(taskContext.plan || taskContext.plan_target || taskContext.worksite_region);
  if (!hasPlan) return false;
  const hasPhase = taskContext.level != null || taskContext.range != null || taskContext.phase != null;
  return hasPhase;
}

/**
 * @param {object} taskContext
 * @param {object} httpBody
 */
export function buildConstructBeginBody(taskContext, httpBody) {
  const target = taskContext.plan
    || taskContext.plan_target
    || (taskContext.worksite_region ? `:${taskContext.worksite_region}:` : null);
  return {
    ...httpBody,
    target,
    card_id: taskContext.card_id,
    level: httpBody.level ?? taskContext.level,
    range: httpBody.range ?? taskContext.range,
    phase: httpBody.phase ?? taskContext.phase,
    plan_revision: httpBody.plan_revision ?? taskContext.plan_revision,
    mismatch_cap: httpBody.mismatch_cap || 5000,
  };
}

/**
 * Shared begin pipeline (construct_begin + task_context auto-begin).
 *
 * @param {object} deps { ctx, config, ensureBot }
 * @param {object} body begin args (target, phase, level, range, …)
 * @param {ReturnType<createBlueprintActions>|null} blueprintFns
 */
export async function runConstructBeginPipeline(deps, body, blueprintFns = null) {
  const { ctx, ensureBot } = deps;
  const resolved = resolvePlanContextForBegin(deps, body);
  if (resolved.err) return resolved.err;
  const { ctxPlan } = resolved;

  let planRevision = effectivePlanRevision(ctxPlan);
  if (!body.skip_revision_gate) {
    const revGate = checkPlanRevisionGate(body, ctxPlan, ctx);
    if (!revGate.ok) return gateToActionFail(revGate, fail);
    planRevision = revGate.plan_revision;
  }

  if (!body.skip_anchor_gate) {
    const bindGate = checkConstructSiteBindingGate(ctxPlan, {
      worksite_region: body.worksite_region ?? ctx.runtime?.taskContext?.worksite_region,
      regions: ctx.runtime?.regions?.list?.() || [],
      card_plan_id: body.plan || body.plan_id || ctx.runtime?.taskContext?.plan,
    });
    if (!bindGate.ok) return gateToActionFail(bindGate, fail);
  }

  let siteReadiness = null;
  if (!body.skip_readiness) {
    const b = ensureBot();
    siteReadiness = evaluateConstructSiteReadiness(
      ctxPlan,
      (x, y, z) => b.blockAt(new Vec3(x, y, z))?.name || 'air',
      {
        level: body.level != null ? Number(body.level) : undefined,
        range: parsePhaseRange(body.range),
      },
    );
    if (siteReadiness.status !== 'ready') {
      const code = siteReadiness.status === 'relocate' ? 'CONSTRUCT_RELOCATE' : 'CONSTRUCT_PREP_REQUIRED';
      return fail(code, siteReadiness.message, {
        observed_state: { site_readiness: siteReadiness },
        next_action_hint: siteReadiness.hint,
        retry_safe: false,
      });
    }
  }
  const bp = blueprintFns || createBlueprintActions(deps);
  const verifyRes = await bp.blueprint_verify({
    ...body,
    mismatch_cap: body.mismatch_cap || 5000,
  });
  if (!verifyRes.ok) return verifyRes;
  const data = verifyRes.data || {};
  const planId = data.plan_id || body.plan_id || body.target;
  const phase = body.phase_id || body.phase || data.phase || phaseFromBeginBody(body);
  const phaseKey = resolvePhaseKey(phase);
  const mismatches = data.mismatches || [];
  const workset = worksetFromVerifyMismatches(mismatches, { phase_id: phaseKey || phase.id || phase.level });
  const summary = data.summary || {};
  /** @type {Record<string, string[]>|undefined} */
  let substitutions;
  /** @type {Array<{ name: string, count: number }>|undefined} */
  let materials_for_phase;
  const mutation_policy = body.mutation_policy != null
    ? (Array.isArray(body.mutation_policy)
      ? body.mutation_policy
      : String(body.mutation_policy).split(',').map((s) => s.trim()))
    : ['missing', 'wrong'];
  const dataDir = dataDirFromCtx(ctx);
  if (dataDir && planId) {
    const loaded = loadPlanJson(dataDir, planId);
    if (loaded.ok && loaded.plan) {
      if (loaded.plan.substitutions && typeof loaded.plan.substitutions === 'object') {
        substitutions = loaded.plan.substitutions;
      }
      const byPhase = loaded.plan.materials_by_phase;
      if (phaseKey && byPhase?.[phaseKey]) {
        materials_for_phase = byPhase[phaseKey];
      }
    }
  }
  const session = {
    kind: 'construct',
    plan_id: planId,
    target: body.target || body.region || planId,
    anchor: data.anchor,
    footprint: data.footprint,
    phase,
    mutation_policy: Array.isArray(mutation_policy) ? mutation_policy : ['missing', 'wrong'],
    progress: summary,
    workset_size: workset.size,
    started_at: Date.now(),
    card_id: ctx.runtime?.taskContext?.card_id || body.card_id || null,
    plan_revision: planRevision,
    ...(substitutions ? { substitutions } : {}),
    ...(materials_for_phase ? { materials_for_phase } : {}),
  };
  ctx.runtime._constructWorkset = workset;
  setConstructContext(ctx, session);
  return ok({
    result: `Construct context began for ${planId} (${workset.size} mutable cells in workset index)`,
    data: {
      construct_context: session,
      plan_revision: planRevision,
      verify_summary: summary,
      sample_mismatches: mismatches.slice(0, 8),
      guided_edit_progress: buildGuidedEditProgress(ctx),
      ...(siteReadiness ? { site_readiness: siteReadiness } : {}),
    },
  });
}

/**
 * After task_context is stored — optional auto-begin (non-blocking for grant).
 *
 * @param {object} deps
 * @param {object} taskContext
 * @param {object} httpBody
 */
export async function tryAutoBeginConstructFromTaskContext(deps, taskContext, httpBody) {
  if (!shouldAutoBeginConstruct(taskContext, httpBody)) {
    return null;
  }
  if (getConstructContext(deps.ctx)) {
    return {
      ok: false,
      error: {
        code: 'CONSTRUCT_ALREADY_ACTIVE',
        message: 'Construct session already active; end before auto-begin',
        retry_safe: false,
      },
    };
  }
  const beginBody = buildConstructBeginBody(taskContext, httpBody);
  return runConstructBeginPipeline(deps, beginBody);
}

export function buildGuidedEditProgress(ctx) {
  const session = getConstructContext(ctx);
  if (!session) return null;
  const summary = session.progress || {};
  const total = (summary.ok || 0) + (summary.missing || 0) + (summary.wrong || 0) + (summary.extra || 0);
  const done = summary.ok || 0;
  return {
    total_cells: total || session.workset_size || 0,
    done_cells: done,
    materials_needed: session.materials_for_phase || [],
    materials_missing: session.materials_missing || [],
    blocked_cells: [],
    current_phase: resolvePhaseKey(session.phase) || session.phase?.id || session.phase?.level || 'place',
    next_step: session.workset_size
      ? `${session.workset_size} cells remain in workset — mc construct show`
      : 'mc construct show',
  };
}

/**
 * End pipeline gate check (D3). Does not clear session.
 *
 * @param {object} deps
 * @param {object} session
 * @param {object} [body]
 */
export function runConstructEndGateCheck(deps, session, body = {}) {
  if (!constructScopingEnabled()) return { ok: true };
  const skipGates = body.skip_gates === true || body.skip_gates === 'true';
  if (skipGates) return { ok: true };

  const ctx = deps.ctx;
  const dataDir = dataDirFromCtx(ctx);
  if (!dataDir || !session?.plan_id) {
    return {
      ok: false,
      response: fail('GATE_FAIL', 'End gates require plan data on disk', {
        retry_safe: false,
        observed_state: { plan_id: session?.plan_id },
      }),
    };
  }
  const loaded = loadPlanJson(dataDir, session.plan_id);
  if (!loaded.ok) {
    return {
      ok: false,
      response: fail('GATE_FAIL', `Plan not found for end gates: ${session.plan_id}`, {
        retry_safe: false,
        observed_state: { code: loaded.code },
      }),
    };
  }
  const enriched = enrichPlan(loaded.plan);
  const anchor = session.anchor || loaded.plan.anchor?.coords;
  if (!anchor || anchor.length !== 3) {
    return {
      ok: false,
      response: fail('GATE_FAIL', 'Construct session missing anchor for gate probe', {
        retry_safe: false,
      }),
    };
  }
  const ctxPlan = { ...enriched, anchor, planId: session.plan_id };
  const b = deps.ensureBot();
  const getBlockName = (x, y, z) => b.blockAt(new Vec3(x, y, z))?.name || 'air';
  const skipPhase = body.skip_phase_gate === true || body.skip_phase_gate === 'true';
  const gateOut = evaluateConstructEndGates({
    ctxPlan,
    getBlockName,
    gates: loaded.plan.gates || [],
    phase: session.phase,
    requirePhaseClean: !skipPhase,
  });
  if (!gateOut.ok) {
    const msg = gateOut.failures.map((f) => f.message).filter(Boolean).join('; ')
      || 'Construct end gates failed';
    return {
      ok: false,
      response: fail('GATE_FAIL', msg, {
        retry_safe: true,
        next_action_hint: 'mc construct show — fix verify mismatches/gates, then mc construct end',
        observed_state: { gate_failures: gateOut.failures },
      }),
    };
  }
  return { ok: true };
}

/** Attach construct telemetry to motor verb success payloads when session is active. */
export function attachConstructMotorEnvelope(ctx, data = {}) {
  const session = getConstructContext(ctx);
  if (!session) return data;
  const progress = buildGuidedEditProgress(ctx);
  return {
    ...data,
    construct_context: {
      plan_id: session.plan_id,
      progress: session.progress,
      workset_size: session.workset_size,
      phase: session.phase,
      ...(session.plan_revision ? { plan_revision: session.plan_revision } : {}),
    },
    ...(progress ? { guided_edit_progress: progress } : {}),
  };
}
