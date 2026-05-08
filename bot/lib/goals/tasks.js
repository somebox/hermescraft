/**
 * Task runtime helpers: extended task shape, lease, checkpoint state.
 */

/**
 * @param {object} params
 * @param {string} params.id
 * @param {string} params.action
 * @param {number} [params.started]
 * @param {string|null} [params.parent_goal_id]
 * @param {Record<string, number>|null} [params.contributes_to]
 * @param {number|null} [params.lease_seconds]
 * @param {object} [params.progress]
 * @param {object|null} [params.resume_token]
 */
export function createTaskRecord({
  id,
  action,
  started = Date.now(),
  parent_goal_id = null,
  contributes_to = null,
  lease_seconds = null,
  progress = {},
  resume_token = null,
}) {
  const leaseExpiresAt =
    lease_seconds && lease_seconds > 0 ? started + lease_seconds * 1000 : null;
  return {
    id,
    action,
    status: 'running',
    started,
    result: null,
    error: null,
    parent_goal_id,
    contributes_to,
    lease_seconds,
    lease_expires_at: leaseExpiresAt,
    checkpoint_status: 'ok',
    progress: { ...progress },
    resume_token,
    paused_at: null,
  };
}

/**
 * If lease expired and task still running, mark checkpoint pending.
 * @param {ReturnType<typeof createTaskRecord>|null} task
 */
export function refreshLeaseCheckpoint(task) {
  if (!task || task.status !== 'running') return task;
  if (!task.lease_expires_at) {
    task.checkpoint_status = 'ok';
    return task;
  }
  if (Date.now() >= task.lease_expires_at) {
    task.checkpoint_status = 'pending';
  } else {
    task.checkpoint_status = 'ok';
  }
  return task;
}

export function renewLease(task, leaseSeconds) {
  if (!task || task.status !== 'running') return task;
  const now = Date.now();
  task.lease_seconds = leaseSeconds;
  task.lease_expires_at = leaseSeconds > 0 ? now + leaseSeconds * 1000 : null;
  task.checkpoint_status = 'ok';
  return task;
}

export function taskToApi(task) {
  if (!task) return null;
  const elapsed_s = Math.round((Date.now() - task.started) / 1000);
  let lease_remaining_s = null;
  if (task.lease_expires_at) {
    const rem = Math.round((task.lease_expires_at - Date.now()) / 1000);
    lease_remaining_s = rem < 0 ? 0 : rem;
  }

  return {
    ...task,
    elapsed_s,
    lease_remaining_s,
    needs_checkpoint: task.checkpoint_status === 'pending' && task.status === 'running',
  };
}
