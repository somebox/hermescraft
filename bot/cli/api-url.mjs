/**
 * Resolve bot HTTP base URL from environment (shared by mc CLI and tests).
 *
 * `_MC_API_URL_LOCKED` normally wins over `MC_API_URL` so continuous-agent
 * loops cannot hallucinate ports. Kanban workers set `HERMES_KANBAN_TASK` and
 * profile `.env` with matching `MC_API_URL` + lock — prefer `MC_API_URL` there
 * so a leaked steward lock from the gateway parent cannot override the assignee.
 *
 * When `HERMES_BOT_LEASE=1` and no `MC_API_URL`, resolves from the active bot
 * lease (`bot/cli/lease-registry.mjs`). Returns empty string when lease-mode
 * has no lease — callers must hard-fail before HTTP.
 */
import { leaseModeEnabled, resolveLeaseUrl, ownerId, NO_LEASE } from './lease-registry.mjs';

export { NO_LEASE };

export function apiUrl() {
  const locked = process.env._MC_API_URL_LOCKED;
  const url = process.env.MC_API_URL;
  if (process.env.HERMES_KANBAN_TASK && url) {
    return String(url);
  }
  if (locked) return String(locked);
  if (url) return String(url);
  if (leaseModeEnabled()) {
    const leased = resolveLeaseUrl(ownerId());
    if (leased) return leased;
    return NO_LEASE;
  }
  return 'http://localhost:3001';
}

export function isNoActiveLease(api) {
  return api === NO_LEASE;
}
