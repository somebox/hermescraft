import os from 'os';
import path from 'path';

/**
 * Default HERMES_HOME for landfolk agents (~/.hermes-landfolk-{nameLower}).
 * @param {string} agentName
 */
export function defaultHermesHome(agentName) {
  const lower = String(agentName || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_');
  return path.join(os.homedir(), `.hermes-landfolk-${lower}`);
}

/**
 * @param {{ name: string, hermes_home?: string | null }} registryAgent
 */
export function resolveHermesHome(registryAgent) {
  const explicit = registryAgent?.hermes_home;
  if (typeof explicit === 'string' && explicit.trim()) {
    const expanded = explicit.startsWith('~')
      ? path.join(os.homedir(), explicit.slice(1))
      : explicit;
    return path.resolve(expanded);
  }
  return defaultHermesHome(registryAgent?.name || '');
}
