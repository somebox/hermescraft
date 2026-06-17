/**
 * Escalation-hint helper.
 *
 * Several action/observation paths tell a stuck worker its REQUIRED next action
 * is `mc advise`. For an orchestrated colony worker (genesis-v2) that is the
 * wrong escalation: the worker should `kanban_block` its card so the read-only
 * planner/poller picks it up. gv2-2026-06-16-1 logged 62 dead `mc advise`
 * attempts because the bot's own hints kept pointing there over the SOUL rule.
 *
 * When `MC_SUPPRESS_ADVISE_HINTS=1` is set on the body (genesis bodies set it at
 * launch; prod bodies don't), every advise hint degrades to a kanban_block
 * directive. Default (unset) preserves the existing `mc advise` behavior, so
 * this is opt-in and prod-safe.
 */
'use strict';

export function adviseHintsSuppressed() {
  const v = process.env.MC_SUPPRESS_ADVISE_HINTS;
  return v === '1' || v === 'true';
}

/**
 * The escalation directive for a stuck/blocked worker.
 *   reason  — short structured reason (e.g. "stuck 7min: dig blocked").
 *   target  — optional "x,y,z" for the advise form.
 * Returns the `mc advise …` string normally, or a `kanban_block` directive when
 * advise hints are suppressed.
 */
export function escalationHint({ reason = 'stuck', target } = {}) {
  if (adviseHintsSuppressed()) {
    return `kanban_block reason="${reason}" — escalate this card to the planner instead of retrying locally`;
  }
  const t = target ? ` --target ${target}` : '';
  return `mc advise --reason="${reason}"${t}`;
}
