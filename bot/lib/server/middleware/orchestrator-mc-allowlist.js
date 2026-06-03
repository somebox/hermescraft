/**
 * Shared orchestrator (Steward) mc verb allowlist — must stay in sync with
 * config/orchestrator-mc-allowlist.json and scripts/hermes-hooks/orchestrator-deny.sh.
 */
import allowlistDoc from '../../../../config/orchestrator-mc-allowlist.json' with { type: 'json' };

const PROFILE = String(allowlistDoc.profile || 'steward').toLowerCase();

/** @type {Set<string>} */
export const ORCHESTRATOR_ALLOWED_MC = new Set(
  (allowlistDoc.allowed_verbs || []).map((v) => String(v).toLowerCase()),
);

export function isOrchestratorProfile(profile) {
  return String(profile || '').toLowerCase() === PROFILE;
}

export function orchestratorMcDenyReason(verb) {
  const v = String(verb || '').toLowerCase();
  // Phase-12 (2026-06-03): keep this message *minimal*. Previous wording named
  // allowed verbs inline, which Steward re-parsed as ALSO being denied and filed
  // a false [BUG] card. The follow-up wording mentioned "allowed read-only
  // verbs" by name, which the model could still re-frame. The canonical rubric
  // (which verbs are allowed, when to use kanban vs mc, escape hatches) lives
  // in prompts/landfolk/steward.md — do NOT teach it here.
  return `mc ${v} is denied for the orchestrator (Steward) role. See prompts/landfolk/steward.md.`;
}

/**
 * @param {{ agent?: { profile?: string } }} config
 * @param {string} actionName
 * @returns {{ ok: false, status: number, error: string } | null}
 */
export function gateOrchestratorMcAction(config, actionName) {
  if (!isOrchestratorProfile(config?.agent?.profile)) return null;
  const verb = String(actionName || '').toLowerCase();
  if (ORCHESTRATOR_ALLOWED_MC.has(verb)) return null;
  return {
    ok: false,
    status: 403,
    error: orchestratorMcDenyReason(verb),
  };
}
