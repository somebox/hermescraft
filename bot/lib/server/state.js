/**
 * Mutable runtime state for one bot server process (injectable context).
 * @param {ReturnType<typeof import('./config.js').loadConfig>} config
 */
export function createBotState(config) {
  return {
    config,

    bot: /** @type {import('mineflayer').Bot | null} */ (null),
    mcData: /** @type {import('minecraft-data').IndexedData | null} */ (null),
    botReady: false,

    /** Single in-flight Minecraft TCP/login attempt (dedupes overlapping POST /connect). */
    connectPromise: /** @type {Promise<import('mineflayer').Bot> | null} */ (null),

    chatLog: [],
    deathLog: [],
    commandQueue: [],
    currentTask: null,
    lastDeath: null,
    hardcoreDead: false,
    lastHealth: 20,
    lastDamageEvent: /** @type {{ amount: number; hp: number; ts: number } | null} */ (null),
    reconnectAttempts: 0,

    MAX_LOG: 100,
    MAX_QUEUE: 20,

    actionHistory: [],
    MAX_ACTION_HISTORY: 24,
    bootTime: Date.now(),
    /** True while a sync /action/* call is in flight — prevents watchdog from cancelling pathfinder. */
    syncActionInFlight: false,

    /** Rolling action counters for diagnostics (populated by recordActionOutcome). */
    actionCounters: {
      window_ms: 5 * 60 * 1000,
      events: [],
    },

    /** Last thrown API failure (sync POST /action or async task errors); cleared on successful sync action. */
    lastApiError: /** @type {{ ts: number, method: string, path: string, action: string | null, message: string } | null} */ (
      null
    ),

    goalsStore: { goals: [], deficitSince: {} },
    chestSnapshots: {},
    MAX_TASK_HISTORY: 50,
    taskHistory: [],

    reminders: [],
    remindersNextId: 1,

    fairPlayMode: process.env.FAIR_PLAY !== 'false',

    soundEvents: [],

    teamConfig: {
      team: null,
      role: null,
      teammates: [],
      rallyPoint: null,
      teamChat: [],
    },

    combatStats: { kills: 0, deaths: 0, assists: 0, damageDealt: 0, damageTaken: 0 },
    recentDamagers: {},

    activeFurnaces: [],
    isSneaking: false,

    overheardLog: [],
    socialGraph: {},
    socialEvents: [],
    observedBlocks: new Map(),

    positionHistory: [],

    /** Skip auto-reconnect from `end` when we voluntarily quit() to replace the session */
    suppressEndReconnect: false,
  };
}
