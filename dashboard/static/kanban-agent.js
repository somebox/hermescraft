/** Pick the kanban card an agent is most likely working on (assignee match). */
export function pickAgentKanbanTask(tasks, agentName) {
  if (!Array.isArray(tasks) || !tasks.length || !agentName) return null;
  const n = String(agentName).trim().toLowerCase();
  const mine = tasks.filter((t) => String(t.assignee || '').trim().toLowerCase() === n);
  if (!mine.length) return null;
  const rank = {
    running: 0,
    ready: 1,
    blocked: 2,
    todo: 3,
    triage: 4,
    done: 8,
    archived: 9,
  };
  mine.sort((a, b) => {
    const ra = rank[String(a.status || a.column || '').toLowerCase()] ?? 5;
    const rb = rank[String(b.status || b.column || '').toLowerCase()] ?? 5;
    if (ra !== rb) return ra - rb;
    return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
  });
  return mine[0];
}
