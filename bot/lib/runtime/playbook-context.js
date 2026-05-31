/**
 * In-memory playbook phase context (ctx.runtime.playbook_context).
 * Set via mc playbook phase set; cleared explicitly or on kanban card change.
 */

/**
 * @param {Record<string, any>} ctx bot state
 */
export function clearPlaybookContext(ctx) {
  if (ctx?.runtime) ctx.runtime.playbook_context = null;
}

/**
 * Auto-clear when task_context card_id changes (new claim / reclaim / leak).
 * Same card_id → leave context (A3 resume re-sets phase from run_state).
 *
 * @param {Record<string, any>} ctx
 * @param {string} newCardId
 */
export function autoClearPlaybookOnCardChange(ctx, newCardId) {
  const pc = ctx?.runtime?.playbook_context;
  if (!pc || !pc.card_id) return;
  if (String(pc.card_id) !== String(newCardId)) {
    clearPlaybookContext(ctx);
  }
}

/**
 * @param {Record<string, any>} ctx
 * @param {{
 *   playbook_id: string,
 *   phase: string,
 *   sub_playbook_id?: string,
 *   sub_phase?: string,
 * }} fields
 */
export function setPlaybookContext(ctx, fields) {
  const tc = ctx?.runtime?.taskContext;
  if (!tc?.card_id) {
    return { ok: false, code: 'TASK_CONTEXT_REQUIRED', message: 'Bind kanban card first: mc task_context set … (HERMES_KANBAN_TASK / --card)' };
  }
  ctx.runtime.playbook_context = {
    playbook_id: String(fields.playbook_id),
    phase: String(fields.phase),
    card_id: String(tc.card_id),
    ...(fields.sub_playbook_id ? { sub_playbook_id: String(fields.sub_playbook_id) } : {}),
    ...(fields.sub_phase ? { sub_phase: String(fields.sub_phase) } : {}),
  };
  return { ok: true, data: { playbook_context: ctx.runtime.playbook_context } };
}
