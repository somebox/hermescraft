/**
 * Find Hermes bot HTTP listeners without a registry row (e.g. Steward body on its own port).
 */

/**
 * @param {import('./registry.js').Registry | null} registry
 * @param {{ dashboardPort?: number, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {number[]}
 */
export function discoveryPortList(registry, opts = {}) {
  const env = opts.env || process.env;
  const dashboardPort = Number(opts.dashboardPort ?? env.DASHBOARD_PORT ?? 3000);
  const ports = new Set();

  for (const a of registry?.agents || []) {
    const p = Number(a.api_port);
    if (Number.isFinite(p) && p > 0) ports.add(p);
  }

  const min = Number(env.BOT_DISCOVERY_PORT_MIN || 3000);
  const max = Number(env.BOT_DISCOVERY_PORT_MAX || 3024);
  if (Number.isFinite(min) && Number.isFinite(max) && max >= min) {
    for (let p = min; p <= max; p++) ports.add(p);
  }

  for (const part of String(env.BOT_DISCOVERY_PORTS || '').split(',')) {
    const p = Number(part.trim());
    if (Number.isFinite(p) && p > 0) ports.add(p);
  }

  ports.delete(dashboardPort);
  return [...ports].sort((a, b) => a - b);
}

/**
 * @param {unknown} body
 * @returns {body is { ok: true, username: string }}
 */
export function isHermesBotHealth(body) {
  return (
    !!body &&
    typeof body === 'object' &&
    body.ok === true &&
    typeof body.username === 'string' &&
    body.username.trim().length > 0
  );
}

/**
 * @param {{ username: string, model?: string | null, profile?: string | null }} health
 * @param {number} apiPort
 * @param {string} defaultWorld
 */
export function syntheticAgentFromHealth(health, apiPort, defaultWorld) {
  const name = String(health.username).trim();
  return {
    name,
    api_port: apiPort,
    world: defaultWorld,
    model: health.model || null,
    role: health.profile || 'discovered',
    discovered: true,
    viewer_port: null,
    radar_port: null,
    hermes_home: null,
  };
}

/**
 * Registry poll targets plus bots found on open ports whose MC username is not already listed.
 *
 * @param {import('./registry.js').Registry} registry
 * @param {{ username: string, port: number, model?: string | null, profile?: string | null }[]} foundOnPorts
 */
export function mergePollTargets(registry, foundOnPorts) {
  /** @type {Map<string, object>} */
  const byKey = new Map();
  for (const a of registry.agents) {
    byKey.set(`${a.api_port}:${String(a.name).toLowerCase()}`, a);
  }

  const namesSeen = new Set(registry.agents.map((a) => String(a.name).toLowerCase()));
  const portsWithRegistry = new Set(registry.agents.map((a) => Number(a.api_port)));

  for (const hit of foundOnPorts) {
    const uname = hit.username.trim();
    const keyLower = uname.toLowerCase();
    if (namesSeen.has(keyLower)) continue;
    const port = hit.port;
    if (portsWithRegistry.has(port)) {
      // Shared-port registry rows (Steve/Gatherer on 3001) — do not add a duplicate discovered row.
      continue;
    }
    const syn = syntheticAgentFromHealth(
      { username: uname, model: hit.model, profile: hit.profile },
      port,
      registry.defaultWorld,
    );
    byKey.set(`${port}:${keyLower}`, syn);
    namesSeen.add(keyLower);
  }

  return [...byKey.values()];
}

/**
 * @param {Array<{ name?: string, mc_username?: string | null }>} agentRows
 */
export function botMcNameSet(registry, agentRows = []) {
  const set = new Set();
  for (const a of registry?.agents || []) {
    set.add(String(a.name).toLowerCase());
  }
  for (const row of agentRows) {
    if (row.name) set.add(String(row.name).toLowerCase());
    if (row.mc_username) set.add(String(row.mc_username).toLowerCase());
  }
  return set;
}
