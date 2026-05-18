import fs from 'fs';
import path from 'path';

/**
 * @param {string} repoRoot
 */
export function loadRegistry(repoRoot) {
  const p = path.join(repoRoot, 'data', 'agent-registry.json');
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const agents = Array.isArray(raw.agents) ? raw.agents : [];
  return {
    defaultWorld: raw.defaultWorld || 'world',
    worlds: raw.worlds || [],
    kanbanBoardIdsByWorld: raw.kanbanBoardIdsByWorld || {},
    agents,
  };
}

export function boardIdForWorld(registry, world) {
  const map = registry?.kanbanBoardIdsByWorld || {};
  return map[world] || map[registry?.defaultWorld] || null;
}
