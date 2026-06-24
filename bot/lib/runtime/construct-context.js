/**
 * Construct-mode helpers for execution-kernel allowUnit + unit.meta.
 * Schematic MVP: workset comes from blueprint verify; handlers clip cells then runCells.
 */

import { worldInsideFootprint } from './blueprints/footprint.js';

/** @typedef {'ok'|'missing'|'wrong'|'extra'} WorksetCategory */

/**
 * @typedef {object} WorksetCell
 * @property {WorksetCategory} category
 * @property {string} [expected_block]
 * @property {string} [phase_id]
 * @property {string} [plan_revision]
 */

/**
 * @typedef {object} ConstructContextShape
 * @property {'construct'} kind
 * @property {string} plan_id
 * @property {string} [target]
 * @property {number[] | { x: number, y: number, z: number }} [anchor]
 * @property {object} [footprint]
 * @property {object} [phase]
 * @property {string[]} mutation_policy
 * @property {object} [progress]
 * @property {string} [card_id]
 * @property {string} [plan_revision]
 * @property {Record<string, string[]>} [substitutions]
 * @property {number} [workset_version]
 * @property {number} [started_at]
 */

/** @param {string|undefined} name */
export function normalizeBlockName(name) {
  return String(name || '').replace(/^minecraft:/, '');
}

/**
 * Expected block names for a plan cell (primary + plan substitutions).
 *
 * @param {string|undefined} expected
 * @param {Record<string, string[]>|undefined} substitutions
 * @returns {Set<string>}
 */
export function expandExpectedBlocks(expected, substitutions) {
  const set = new Set();
  const primary = normalizeBlockName(expected);
  if (!primary || primary === 'any') return set;
  set.add(primary);
  if (!substitutions || typeof substitutions !== 'object') return set;
  const subs = substitutions[primary] || substitutions[expected];
  if (Array.isArray(subs)) {
    for (const s of subs) set.add(normalizeBlockName(s));
  }
  return set;
}

/**
 * @param {string} requested
 * @param {string|undefined} expected
 * @param {Record<string, string[]>|undefined} substitutions
 */
export function blockMatchesConstructExpected(requested, expected, substitutions) {
  if (!expected || expected === 'any') return true;
  const allowed = expandExpectedBlocks(expected, substitutions);
  if (!allowed.size) return true;
  return allowed.has(normalizeBlockName(requested));
}

/** @param {number} x @param {number} y @param {number} z */
export function worksetCellKey(x, y, z) {
  return `${x},${y},${z}`;
}

/**
 * @param {Iterable<{ x: number, y: number, z: number, category: WorksetCategory, expected_block?: string, phase_id?: string }>} entries
 * @returns {Map<string, WorksetCell>}
 */
export function buildWorksetIndex(entries) {
  const map = new Map();
  for (const e of entries) {
    map.set(worksetCellKey(e.x, e.y, e.z), {
      category: e.category,
      expected_block: e.expected_block,
      phase_id: e.phase_id,
    });
  }
  return map;
}

const DEFAULT_POLICY = ['missing', 'wrong'];

/**
 * @param {string[]|Set<string>|undefined} raw
 * @returns {Set<WorksetCategory>}
 */
export function parseMutationPolicy(raw) {
  const list = raw instanceof Set ? [...raw] : (raw?.length ? raw : DEFAULT_POLICY);
  return new Set(/** @type {WorksetCategory[]} */ (list));
}

/**
 * Whether a workset cell may be mutated for add (place/fill) or remove (dig).
 *
 * @param {WorksetCell|undefined} cell
 * @param {'add'|'remove'} motorMode
 * @param {Set<WorksetCategory>} policy
 */
export function unitAllowedInWorkset(cell, motorMode, policy) {
  if (!cell) return false;
  const { category } = cell;
  if (motorMode === 'add') {
    if (category === 'missing') return true;
    if (category === 'wrong' && policy.has('wrong')) return true;
    return false;
  }
  if (category === 'wrong' && policy.has('wrong')) return true;
  if (category === 'extra' && policy.has('extra')) return true;
  return false;
}

/**
 * @param {object} unit { x, y, z, meta? }
 * @param {WorksetCell|undefined} cell
 * @param {object} [ctxMeta]
 */
export function attachConstructUnitMeta(unit, cell, ctxMeta = {}) {
  if (!cell) return unit;
  return {
    ...unit,
    meta: {
      ...unit.meta,
      category: cell.category,
      expected_block: cell.expected_block,
      phase_id: cell.phase_id,
      ...ctxMeta,
    },
  };
}

/**
 * runCells hook bundle when construct session + workset are active.
 *
 * @param {object} ctx
 * @param {'add'|'remove'} motorMode
 * @returns {{ allowUnit?: (unit: object) => Promise<boolean> }}
 */
export function getConstructAllowUnitForCtx(ctx, motorMode) {
  if (!constructScopingEnabled()) return {};
  const session = getConstructContext(ctx);
  const workset = ctx.runtime?._constructWorkset;
  if (!session || !workset?.size) return {};
  const phaseId = session.phase?.id ?? session.phase?.level;
  return {
    allowUnit: createConstructAllowUnit(workset, {
      motorMode,
      mutationPolicy: session.mutation_policy,
      phase_id: phaseId != null ? String(phaseId) : undefined,
      plan_revision: session.plan_revision,
    }),
  };
}

/**
 * Kernel allowUnit hook factory for construct-scoped bulk runs.
 *
 * @param {Map<string, WorksetCell>} worksetIndex
 * @param {{ motorMode: 'add'|'remove', mutationPolicy?: string[]|Set<string>, phase_id?: string, plan_revision?: string }} opts
 * @returns {(unit: { x: number, y: number, z: number, meta?: object }) => Promise<boolean>}
 */
export function createConstructAllowUnit(worksetIndex, opts) {
  const policy = parseMutationPolicy(opts.mutationPolicy);
  const { motorMode, phase_id, plan_revision } = opts;
  return async (unit) => {
    const cell = worksetIndex.get(worksetCellKey(unit.x, unit.y, unit.z));
    if (phase_id && cell?.phase_id && cell.phase_id !== phase_id) return false;
    if (plan_revision && cell && unit.meta?.plan_revision && unit.meta.plan_revision !== plan_revision) {
      return false;
    }
    return unitAllowedInWorkset(cell, motorMode, policy);
  };
}

/**
 * Index non-ok cells from blueprint verify for construct filtering.
 * @param {Array<{ cell: { x, y, z }, category: WorksetCategory, expected?: string }>} mismatches
 * @param {{ phase_id?: string }} [opts]
 */
export function worksetFromVerifyMismatches(mismatches, opts = {}) {
  const entries = mismatches.map((m) => ({
    x: m.cell.x,
    y: m.cell.y,
    z: m.cell.z,
    category: m.category,
    expected_block: m.expected === 'air' ? undefined : m.expected,
    phase_id: opts.phase_id,
  }));
  return buildWorksetIndex(entries);
}

/**
 * @param {object} ctx
 * @returns {ConstructContextShape|null}
 */
export function getConstructContext(ctx) {
  return ctx?.runtime?.construct_context ?? null;
}

/**
 * @param {object} ctx
 * @param {ConstructContextShape|null} next
 */
export function setConstructContext(ctx, next) {
  if (!ctx.runtime) ctx.runtime = {};
  ctx.runtime.construct_context = next;
}

export function constructScopingEnabled() {
  const v = process.env.HERMES_CONSTRUCT_CONTEXT;
  return v === '1' || v === 'true';
}

/**
 * Effective workset category at a world cell (cells not in verify mismatches are ok).
 * @param {Map<string, WorksetCell>|undefined} workset
 */
export function worksetCategoryAt(workset, x, y, z) {
  const cell = workset?.get(worksetCellKey(Math.floor(x), Math.floor(y), Math.floor(z)));
  return cell?.category ?? 'ok';
}

/**
 * When construct context is active, return a handler failure object or null to proceed.
 * Outside plan footprint: no construct filter (legacy behavior).
 *
 * @param {object} ctx
 * @param {number} x @param {number} y @param {number} z
 * @param {'add'|'remove'} motorMode
 * @param {{ blockName?: string }} [opts]
 * @returns {{ ok: false, error: object }|null}
 */
export function evaluateConstructMutation(ctx, x, y, z, motorMode, opts = {}) {
  if (!constructScopingEnabled()) return null;

  const session = getConstructContext(ctx);
  const tc = ctx?.runtime?.taskContext;
  const planSnap = tc?.construct_plan;

  if (!session && tc?.card_kind === 'CONSTRUCT' && planSnap?.anchor && planSnap?.footprint) {
    if (worldInsideFootprint(x, y, z, planSnap.anchor, planSnap.footprint)) {
      return {
        ok: false,
        error: {
          code: 'CONSTRUCT_NOT_STARTED',
          message: 'CONSTRUCT card is bound but construct context is not active inside plan footprint',
          retry_safe: false,
          next_action_hint: 'mc task_context set :worksite: --card <id> with plan+phase (auto-begin) or mc construct begin',
          observed_state: { plan_id: planSnap.plan_id, card_id: tc.card_id },
        },
      };
    }
    return null;
  }

  if (!session) return null;
  const anchor = session.anchor;
  const footprint = session.footprint;
  if (!worldInsideFootprint(x, y, z, anchor, footprint)) return null;

  const workset = ctx.runtime?._constructWorkset;
  const category = worksetCategoryAt(workset, x, y, z);
  const policy = parseMutationPolicy(session.mutation_policy);
  const cell = workset?.get(worksetCellKey(Math.floor(x), Math.floor(y), Math.floor(z)));

  if (category === 'ok') {
    return {
      ok: false,
      error: {
        code: 'CONSTRUCT_ALREADY_OK',
        message: `Cell (${x},${y},${z}) already matches plan ${session.plan_id}`,
        retry_safe: false,
        next_action_hint: 'mc construct show or pick a missing/wrong cell from verify',
        observed_state: { category, plan_id: session.plan_id },
      },
    };
  }

  const pseudoCell = cell || { category };
  if (!unitAllowedInWorkset(pseudoCell, motorMode, policy)) {
    const code = motorMode === 'add' ? 'CONSTRUCT_OUT_OF_SCOPE' : 'CONSTRUCT_OUT_OF_SCOPE';
    return {
      ok: false,
      error: {
        code,
        message: `Construct policy denies ${motorMode} at (${x},${y},${z}) (${category}; policy=${[...policy].join(',')})`,
        retry_safe: false,
        next_action_hint: 'mc construct show — adjust mutation_policy or fix the cell category',
        observed_state: { category, plan_id: session.plan_id, motorMode },
      },
    };
  }

  if (motorMode === 'add' && opts.blockName && cell?.expected_block) {
    const want = cell.expected_block;
    const got = opts.blockName;
    if (!blockMatchesConstructExpected(got, want, session.substitutions)) {
      return {
        ok: false,
        error: {
          code: 'CONSTRUCT_WRONG_BLOCK',
          message: `Plan expects ${want} at (${x},${y},${z}), not ${got}`,
          retry_safe: false,
          next_action_hint: `mc place ${want} ${x} ${y} ${z}`,
          observed_state: { expected_block: want, requested_block: got, category },
        },
      };
    }
  }

  return null;
}
