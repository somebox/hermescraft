import { interCellMsForMode, applyMotorJitter } from './constants.js';
import { progressEnvelope, envelopeToFail } from './progress-envelope.js';
import { mirrorBulkTaskProgress, TASK_PROGRESS_MIRROR_EVERY } from './task-progress.js';

const TOOL_MISSING_RE = /tool|equip|pickaxe|shovel|axe|hoe|shears/i;

/**
 * @param {object} ctx
 * @returns {boolean}
 */
function cancelRequested(ctx) {
  return !!(ctx?.tasks?.cancelRequested || ctx?.runtime?.tasks?.cancelRequested);
}

/**
 * @typedef {object} RunCellsResult
 * @property {import('./progress-envelope.js').ProgressEnvelope} envelope
 * @property {'complete'|'cancelled'|'deadline'|'preflight_abort'|'tool_missing'} [stopReason]
 * @property {object} [preflightUnit]
 */

/**
 * @param {object} ctx
 * @param {{ id: string, x: number, y: number, z: number, meta?: object }[]} ordered
 * @param {object} hooks
 * @param {object} [options]
 * @param {number} [options.deadlineMs] absolute Date.now() deadline
 * @param {'remove'|'add'} [options.mode]
 * @param {'auto'|'volume'|'column'} [options.shape]
 * @param {number} [options.interUnitDelayMs]
 * @param {boolean} [options.failFastOnTool]
 * @param {(reason: string, env: import('./progress-envelope.js').ProgressEnvelope) => void} [hooks.onAbort]
 * @param {import('./progress-envelope.js').ProgressEnvelope} [options.initialCounters]
 * @returns {Promise<RunCellsResult>}
 */
export async function runCells(ctx, ordered, hooks, options = {}) {
  const {
    deadlineMs,
    mode = 'remove',
    shape = 'auto',
    interUnitDelayMs,
    failFastOnTool = false,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = options;

  const orderedIds = ordered.map((u) => u.id);
  /** @type {Record<string, number>} */
  const counters = {
    dug: 0,
    placed: 0,
    skipped: 0,
    failed: 0,
    scope_denied: 0,
    skipped_wrong_block: 0,
  };

  let nextIndex = 0;
  let lastUnitId;
  /** @type {Record<string, number>} */
  const constructMeta = {};

  const bumpConstruct = (unit) => {
    if (!unit?.meta) return;
    for (const [k, v] of Object.entries(unit.meta)) {
      if (v === undefined) continue;
      const key = String(k);
      constructMeta[key] = (constructMeta[key] || 0) + 1;
    }
  };

  const makeEnv = (ok, partial, error) => progressEnvelope({
    ok,
    partial,
    nextIndex,
    unitsTotal: ordered.length,
    lastUnitId,
    counters: { ...counters },
    mode,
    shape,
    orderedIds,
    remainingUnits: ordered.slice(nextIndex),
    construct: Object.keys(constructMeta).length ? constructMeta : undefined,
    error,
  });

  const publishProgress = (env, extra) => {
    mirrorBulkTaskProgress(ctx, env, extra);
  };

  for (let i = 0; i < ordered.length; i++) {
    const unit = ordered[i];
    lastUnitId = unit.id;

    if (cancelRequested(ctx)) {
      const env = makeEnv(false, true, {
        code: 'CANCELLED',
        message: 'Operation cancelled via mc stop',
        retry_safe: true,
      });
      hooks.onAbort?.('cancelled', env);
      publishProgress(env, { stop_reason: 'cancelled' });
      return { envelope: env, stopReason: 'cancelled' };
    }
    if (deadlineMs != null && Date.now() > deadlineMs) {
      const env = makeEnv(false, true);
      hooks.onAbort?.('deadline', env);
      publishProgress(env, { stop_reason: 'deadline' });
      return { envelope: env, stopReason: 'deadline' };
    }

    if (hooks.allowUnit) {
      const allowed = await hooks.allowUnit(unit, ctx);
      if (allowed === false) {
        counters.scope_denied = (counters.scope_denied || 0) + 1;
        counters.skipped = (counters.skipped || 0) + 1;
        nextIndex = i + 1;
        continue;
      }
    }

    if (hooks.shouldSkip) {
      const skip = await hooks.shouldSkip(unit, ctx);
      if (skip) {
        counters.skipped = (counters.skipped || 0) + 1;
        nextIndex = i + 1;
        continue;
      }
    }

    if (hooks.preflight) {
      const pre = await hooks.preflight(unit, ctx);
      if (pre && pre.abort) {
        const code = pre.code || 'PREFLIGHT_ABORT';
        const env = makeEnv(false, true, {
          code,
          message: pre.message || code,
          retry_safe: pre.retry_safe ?? false,
        });
        hooks.onAbort?.('preflight_abort', env);
        publishProgress(env, { stop_reason: 'preflight_abort' });
        return { envelope: env, stopReason: 'preflight_abort', preflightUnit: unit };
      }
      if (pre && pre.skip) {
        counters.skipped = (counters.skipped || 0) + 1;
        nextIndex = i + 1;
        continue;
      }
    }

    if (hooks.beforeUnit) await hooks.beforeUnit(unit, ctx);

    let actResult = { status: 'done' };
    if (hooks.act) {
      try {
        actResult = await hooks.act(unit, ctx) || { status: 'done' };
      } catch (err) {
        const msg = err?.message || String(err);
        if (failFastOnTool && TOOL_MISSING_RE.test(msg)) {
          const env = makeEnv(false, true, {
            code: 'TOOL_MISSING',
            message: msg,
            retry_safe: true,
          });
          hooks.onAbort?.('tool_missing', env);
          publishProgress(env, { stop_reason: 'tool_missing' });
          return { envelope: env, stopReason: 'tool_missing' };
        }
        actResult = { status: 'failed', code: err?.code, message: msg };
      }
    }

    if (actResult.status === 'skipped') {
      counters.skipped = (counters.skipped || 0) + 1;
    } else if (actResult.status === 'failed') {
      counters.failed = (counters.failed || 0) + 1;
      if (failFastOnTool && actResult.code === 'TOOL_MISSING') {
        const env = makeEnv(false, true, {
          code: 'TOOL_MISSING',
          message: actResult.message || 'TOOL_MISSING',
          retry_safe: true,
        });
        hooks.onAbort?.('tool_missing', env);
        publishProgress(env, { stop_reason: 'tool_missing' });
        return { envelope: env, stopReason: 'tool_missing' };
      }
    } else {
      if (mode === 'add') counters.placed = (counters.placed || 0) + 1;
      else counters.dug = (counters.dug || 0) + 1;
      bumpConstruct(unit);
    }

    if (hooks.afterUnit) await hooks.afterUnit(unit, ctx, actResult);

    nextIndex = i + 1;

    if (nextIndex % TASK_PROGRESS_MIRROR_EVERY === 0 || nextIndex === ordered.length) {
      publishProgress(makeEnv(nextIndex < ordered.length, nextIndex < ordered.length));
    }

    const delayBase = interUnitDelayMs ?? interCellMsForMode(mode);
    const delay = applyMotorJitter(delayBase, i);
    if (delay > 0) await sleep(delay);
  }

  const env = makeEnv(true, false);
  publishProgress(env, { stop_reason: 'complete' });
  return { envelope: env, stopReason: 'complete' };
}

export { envelopeToFail };
