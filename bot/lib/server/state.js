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

    /** F51.2: Last failed movement attempt. Set by movement handlers on
     *  NAV_TIMEOUT/NAV_BLOCKED/NAV_FAILED; consulted by position-dependent
     *  verb guard in http-app.js to short-circuit dependent commands.
     *  Cleared on next successful move, on mc status, or after 30s. */
    lastMoveFailed: /** @type {{ ts: number, intended_target: {x:number,y:number,z:number}, actual_pos: {x:number,y:number,z:number}, reason: string, verb: string } | null} */ (
      null
    ),

    /** F53.2: Ring buffer of recent failed placement attempts. Used by the
     *  placement-repeat-failure guard in http-app.js to intercept the 3rd
     *  consecutive identical mc place at the same target. Cleared on
     *  successful place at that target, on mc status, or 30s decay.
     *  Capped at 8 entries. */
    recentPlaceFailures: /** @type {Array<{ts:number, target:{x:number,y:number,z:number}, block:string, error_code:string}>} */ (
      []
    ),

    /** F57.1: Ring buffer of recent mc escape calls — each entry is the
     *  cell the bot was IN when escape ran. Used by the escape-loop
     *  detector to surface ESCAPE_RECURRING_LOOP on the 3rd escape inside
     *  a 90s window. Capped at 6 entries. Decays lazily on read. */
    recentEscapes: /** @type {Array<{ts:number, cell:{x:number,y:number,z:number}, classification_before:string}>} */ (
      []
    ),

    /** F72: Items the bot auto-picked-up from recent mc dig calls.
     *  Cleared lazily (30s window) or consumed by mc collect when the
     *  caller asks for exactly those items. The point is to give
     *  `mc collect <item> N` a clean success path when the item was
     *  already grabbed via mineflayer's auto-pickup magnet after the
     *  mc dig that produced it — previously this path returned
     *  NO_VISIBLE_BLOCKS because there were no more drops on the
     *  ground, which the brain misread as "dig failed". */
    recentPickups: /** @type {Array<{ts:number, item:string, count:number, source:string}>} */ (
      []
    ),

    /** F57.2: Ring buffer of cells where movement actually stalled
     *  (NoProgressError) or where mc escape was needed. Pathfinder
     *  preflight in goto/goto_near/move blackballs targets within 1
     *  block of a recent stuck cell. Capped at 12 entries. Decays on
     *  successful move OR after 90s. */
    recentStuckCells: /** @type {Array<{ts:number, cell:{x:number,y:number,z:number}, source:'no_progress'|'escape', hit_count:number}>} */ (
      []
    ),

    /** F59: timestamp of last public-chat emit (mc chat / chat_to /
     *  whisper). Used by the chat rate limiter to auto-sleep when
     *  successive chats arrive within MC_CHAT_MIN_INTERVAL_MS (default
     *  2500 ms) — prevents the burst-of-6-lines-in-200ms pattern that
     *  desynchronised G26's bot dialogue. */
    lastChatTs: 0,

    goalsStore: { goals: [], deficitSince: {} },
    chestSnapshots: {},
    MAX_TASK_HISTORY: 50,
    taskHistory: [],

    reminders: [],
    remindersNextId: 1,

    fairPlayMode: config.behaviors.fairPlay,

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
