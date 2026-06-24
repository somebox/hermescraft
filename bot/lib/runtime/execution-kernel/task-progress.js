/** Mirror bulk motor cursor into ctx.tasks.currentTask.progress for /task polling. */

export const TASK_PROGRESS_MIRROR_EVERY = 8;

/**
 * @param {object} ctx
 * @param {import('./progress-envelope.js').ProgressEnvelope} envelope
 * @param {object} [extra]
 */
export function mirrorBulkTaskProgress(ctx, envelope, extra = {}) {
  const task = ctx?.tasks?.currentTask;
  if (!task || task.status !== 'running') return;
  task.progress = {
    ...task.progress,
    bulk_motor: {
      cursor: envelope.cursor,
      plan_hash: envelope.resume?.plan_hash,
      counters: { ...envelope.counters },
      partial: envelope.partial,
      ...(envelope.construct ? { construct: envelope.construct } : {}),
      ...extra,
    },
  };
}
