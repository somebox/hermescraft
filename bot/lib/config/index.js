/**
 * Central configuration loader for the bot server.
 *
 * All env-var reads in bot source SHOULD go through `loadConfig()`. The
 * resulting object groups settings by concern (mc, api, behaviors, papermcp,
 * agent, logging). See `bot/lib/config/README.md` for the full env-var table.
 *
 * `loadConfig(argv?)` is pure — call it once at startup and pass the result
 * into factories (createBotState, createBotManager, createAllActions, …).
 *
 * `getConfig()` returns the most recently loaded config as a singleton. Use
 * it ONLY from stateless helper modules (e.g. `bot/lib/runtime/dig-tools.js`)
 * that are called from many sites without a config in scope. If `loadConfig`
 * has not been called yet (e.g. from a unit test), `getConfig` lazily loads
 * a default config from the current environment.
 */

let _cached = null;

const boolEnv = (raw, fallback) => {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return String(raw).toLowerCase() === 'true';
};

const intEnv = (raw, fallback) => {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

const numEnv = (raw, fallback) => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/**
 * Bot server configuration from environment and CLI argv.
 * @param {string[]} [argv]
 */
export function loadConfig(argv = process.argv) {
  const env = process.env;
  const reactiveRaw = String(env.REACTIVE ?? 'on').toLowerCase();
  const config = {
    mc: {
      host: env.MC_HOST || 'localhost',
      port: intEnv(env.MC_PORT, 25565),
      username: env.MC_USERNAME || 'HermesBot',
      auth: env.MC_AUTH || 'offline',
      /** Mineflayer TCP/login; multi-bot LAN often needs >30s when other clients join first. */
      connectTimeoutMs: clamp(intEnv(env.MC_CONNECT_TIMEOUT_MS, 55000), 15000, 120000),
    },
    api: {
      port: intEnv(env.API_PORT, 3001),
    },
    behaviors: {
      /** FAIR_PLAY=false disables x-ray / fairness checks (debug only). */
      fairPlay: env.FAIR_PLAY !== 'false',
      /** BOT_HEAR_ALL=true bypasses proximity filter for multi-bot tests. */
      hearAll: boolEnv(env.BOT_HEAR_ALL, false),
      /** BOT_ACCEPT_SERVER_CHAT=true lets rcon `say @Bot …` reach wait/unread (Tester only). */
      acceptServerChatForTests: boolEnv(env.BOT_ACCEPT_SERVER_CHAT, false),
      /** BOT_ALLOW_PARKOUR=true enables pathfinder parkour (default off — slower/looser). */
      allowParkour: boolEnv(env.BOT_ALLOW_PARKOUR, false),
      /** BOT_ALLOW_DIG_INFRASTRUCTURE=true relaxes PROTECTED_DIG_BLOCKS to ALWAYS_PROTECTED only. */
      allowDigInfrastructure: boolEnv(env.BOT_ALLOW_DIG_INFRASTRUCTURE, false),
      /** MC_ALLOW_SLOW_DIG=true disables the slow-dig guard (force-through). */
      allowSlowDig: boolEnv(env.MC_ALLOW_SLOW_DIG, false),
      /** MC_WORLD — world name for shared region registry file (default world). */
      regionsWorld: (env.MC_WORLD || 'world').trim() || 'world',
      /** BEHAVIORS_REGIONS_ENABLED=false disables region enforcement (store still readable). */
      regionsEnabled: boolEnv(env.BEHAVIORS_REGIONS_ENABLED, true),
      /** MC_SLOW_DIG_TICKS_MAX — cap on ticks before slow-dig guard aborts (default 280). */
      slowDigTicksMax: (() => {
        const n = numEnv(env.MC_SLOW_DIG_TICKS_MAX, 280);
        return n < 40 ? 280 : n;
      })(),
      /** MC_CHAT_MIN_INTERVAL_MS — rate limit between chat sends (default 2500). */
      chatMinIntervalMs: numEnv(env.MC_CHAT_MIN_INTERVAL_MS, 2500),
      /** MC_DIG_DROP_SCAN_MS — post-dig drop-detection window (default 300). */
      digDropScanMs: numEnv(env.MC_DIG_DROP_SCAN_MS, 300),
      /** HERMES_NAV_AUTO_RETRACE=true: one mc retrace on goto/move NAV_NO_PROGRESS when dy>0 and trail exists. */
      navAutoRetraceOnStall: boolEnv(env.HERMES_NAV_AUTO_RETRACE, false),
      /** HERMES_RETRACE_TRAIL=true: junction promotion + collinear nav-trail merge (Phase 0a). */
      navRetraceTrailShape: boolEnv(env.HERMES_RETRACE_TRAIL, false),
      /** HERMES_MOVE_RESOLVE=true: go_site/go_mark/move use navigateToTarget facade. */
      navMoveResolve: boolEnv(env.HERMES_MOVE_RESOLVE, false),
      /** HERMES_NAV_BRIEF=shadow|1: compute nav brief (shadow logs only; 1 surfaces to agent). */
      navBriefMode: (env.HERMES_NAV_BRIEF || '').trim().toLowerCase() || 'off',
      /** REACTIVE=off disables the tactical autopilot tick. */
      reactiveOn: reactiveRaw !== 'off',
      /** COMBAT_SKILL — optional numeric override for reactive combat skill. */
      combatSkill: (env.COMBAT_SKILL ?? '').trim() || null,
    },
    papermcp: {
      host: env.PAPERMCP_HOST || env.MC_HOST || 'localhost',
      port: intEnv(env.PAPERMCP_PORT, 25577),
      /** Secret — sourced from .env. paperMcpConfig() returns null when unset. */
      token: env.PAPERMCP_TOKEN || null,
    },
    agent: {
      /** Hermes profile name; defaults to mc.username. */
      profile: (env.AGENT_PROFILE || '').trim() || null,
      model: (env.AGENT_MODEL || '').trim(),
      provider: (env.AGENT_PROVIDER || '').trim(),
      modelsJsonPath: env.AGENT_MODELS_JSON || null,
    },
    logging: {
      dir: env.LOG_DIR || null,
      debugLog: env.MC_DEBUG_LOG || null,
      cliErrorsMultiline: boolEnv(env.MC_CLI_ERRORS_MULTILINE, false),
      /** LOG_BANNER=false (or 0) suppresses the bot's startup ASCII banner.
       *  Set automatically by the pytest conftest when config.test.silence_banner
       *  is true; useful for any test or CI run capturing bot stdout. */
      banner: boolEnv(env.LOG_BANNER, true),
    },
  };

  // CLI argv overrides (kept for backward compatibility with existing scripts)
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--port' && next) { config.api.port = parseInt(next, 10); i++; }
    else if (arg === '--mc-host' && next) { config.mc.host = next; i++; }
    else if (arg === '--mc-port' && next) { config.mc.port = parseInt(next, 10); i++; }
    else if (arg === '--username' && next) { config.mc.username = next; i++; }
    else if (arg === '--auth' && next) { config.mc.auth = next; i++; }
  }

  // Resolve agent.profile after username override has been applied.
  if (!config.agent.profile) config.agent.profile = config.mc.username;

  _cached = config;
  return config;
}

/**
 * Singleton accessor for the most recently loaded config. Stateless helper
 * modules that don't receive a deps object may import this. If loadConfig
 * has not run yet, returns a default config loaded from the current env.
 */
export function getConfig() {
  if (!_cached) loadConfig();
  return _cached;
}
