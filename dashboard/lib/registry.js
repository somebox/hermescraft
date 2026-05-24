import fs from 'fs';
import path from 'path';

/**
 * @param {string} repoRoot
 */
export function loadRegistry(repoRoot) {
  const p = path.join(repoRoot, 'data', 'agent-registry.json');
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const agents = (Array.isArray(raw.agents) ? raw.agents : []).map((a) => ({
    ...a,
    hermes_home: a.hermes_home ?? null,
  }));
  return {
    defaultWorld: raw.defaultWorld || 'world',
    worlds: raw.worlds || [],
    kanbanBoardIdsByWorld: raw.kanbanBoardIdsByWorld || {},
    defaultKanbanBoardId: raw.defaultKanbanBoardId || null,
    worldMap: raw.worldMap || null,
    agents,
  };
}

export function boardIdForWorld(registry, world) {
  const map = registry?.kanbanBoardIdsByWorld || {};
  const w = world || registry?.defaultWorld;
  return (
    map[w] ||
    map[registry?.defaultWorld] ||
    registry?.defaultKanbanBoardId ||
    null
  );
}
