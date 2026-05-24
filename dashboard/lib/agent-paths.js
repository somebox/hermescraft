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

/** Kanban dispatcher worker profile (~/.hermes/profiles/{name}). */
export function kanbanProfileHome(agentName) {
  const lower = String(agentName || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_');
  return path.join(os.homedir(), '.hermes', 'profiles', lower);
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

/**
 * Landfolk home + kanban profile (same as watch-agent.py --auto candidates).
 * @param {{ name: string, hermes_home?: string | null }} registryAgent
 */
export function hermesHomeCandidates(registryAgent) {
  const primary = resolveHermesHome(registryAgent);
  const profile = kanbanProfileHome(registryAgent?.name || '');
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const h of [primary, profile]) {
    const key = path.resolve(h);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** @param {string} home */
export function hermesHomeLabel(home) {
  const base = path.basename(home);
  if (base === 'profiles' || home.includes(`${path.sep}profiles${path.sep}`)) {
    const name = path.basename(home);
    return `${name.charAt(0).toUpperCase()}${name.slice(1)} (kanban)`;
  }
  if (base.startsWith('.hermes-landfolk-')) {
    const part = base.slice('.hermes-landfolk-'.length);
    return part ? part.charAt(0).toUpperCase() + part.slice(1) : 'Agent';
  }
  return base || 'Agent';
}
