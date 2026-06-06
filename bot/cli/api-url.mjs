/**
 * Resolve bot HTTP base URL from environment (shared by mc CLI and tests).
 *
 * `_MC_API_URL_LOCKED` normally wins over `MC_API_URL` so continuous-agent
 * loops cannot hallucinate ports. Kanban workers set `HERMES_KANBAN_TASK` and
 * profile `.env` with matching `MC_API_URL` + lock — prefer `MC_API_URL` there
 * so a leaked steward lock from the gateway parent cannot override the assignee.
 */
export function apiUrl() {
  const locked = process.env._MC_API_URL_LOCKED;
  const url = process.env.MC_API_URL;
  if (process.env.HERMES_KANBAN_TASK && url) {
    return String(url);
  }
  if (locked) return String(locked);
  if (url) return String(url);
  return 'http://localhost:3001';
}
