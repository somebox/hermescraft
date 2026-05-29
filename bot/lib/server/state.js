/**
 * Mutable runtime state for one bot server process, organized into 9 bounded
 * slices. Each slice has a small named constructor; `createBotState(config)`
 * assembles them. Phase 3 of the refactor (docs/archive/refactor-plan-2026.md).
 *
 * Slice ownership:
 *
 *   world      — Mineflayer connection + position
 *   social     — chat, command queue, social graph
 *   tasks      — currentTask, action/task history, sync-in-flight, counters
 *   runtime    — stuck-detection diagnostics, sound events
 *   goals      — goalsStore + chestSnapshots
 *   team       — team config, combat stats, recent damagers, furnaces
 *   reminders  — recurring-reminder store
 *   death      — death/damage/respawn/reconnect state
 *   reactive   — Layer-2 reactive-loop state, perception cache, fair-play mode
 *
 * Field placement is governed by which subsystem mutates the field. When a
 * field is read by many places but mutated by one, it goes in the mutator's
 * slice. When in doubt, this file is the authoritative reference.
 */

/** Mineflayer connection + bot position. */
export function createWorldState() {
  return {
    bot: /** @type {import('mineflayer').Bot | null} */ (null),
    mcData: /** @type {import('minecraft-data').IndexedData | null} */ (null),
    botReady: false,
    /** Single in-flight Minecraft TCP/login attempt (dedupes overlapping POST /connect). */
    connectPromise: /** @type {Promise<import('mineflayer').Bot> | null} */ (null),
    positionHistory: /** @type {Array<{time:number, x:number, y:number, z:number}>} */ ([]),
    bootTime: Date.now(),
    /** Wall time of last mineflayer `spawn` for this connection; cleared on `end`. Used for session duration in /health. */
    mcSessionStartedAt: /** @type {number | null} */ (null),
  };
}

/** Chat, command queue, social graph + events. */
export function createSocialState() {
  return {
    chatLog: /** @type {Array<{time:number, from:string, message:string, [k:string]:any}>} */ ([]),
    overheardLog: /** @type {Array<{time:number, from:string, message:string, channel:string, to:string[]}>} */ ([]),
    commandQueue: /** @type {Array<{time:number, from:string, command:string, status:string, [k:string]:any}>} */ ([]),
    socialGraph: /** @type {Record<string, any>} */ ({}),
    socialEvents: /** @type {Array<{time:number, [k:string]:any}>} */ ([]),
    /** F59: timestamp of last public-chat emit; used by the chat rate limiter. */
    lastChatTs: 0,
    /**
     * "Chat seen by the agent" high-water mark — only chat messages with
     * time > lastChatBriefedTime are surfaced in briefState().new_chat.
     * Without this cursor, every action response re-emits the same 120s
     * window of chat over and over (~50 tokens × N calls of bloat).
     */
    lastChatBriefedTime: 0,
    MAX_LOG: 100,
    MAX_QUEUE: 20,
  };
}

/** Action/task execution: currentTask, history, sync-in-flight, counters. */
export function createTasksState() {
  return {
    currentTask: /** @type {object | null} */ (null),
    taskHistory: /** @type {object[]} */ ([]),
    /** True while a sync /action/* call is in flight — prevents watchdog from cancelling pathfinder. */
    syncActionInFlight: false,
    syncActionName: /** @type {string | null} */ (null),
    syncActionStartedAt: /** @type {number | null} */ (null),
    /** Set by mc stop; long-running sync actions poll this and bail out cleanly. */
    cancelRequested: false,
    actionHistory: /** @type {Array<{action:string, status:string, started_at:number, finished_at:number, detail:string}>} */ ([]),
    /** Rolling action counters for diagnostics (populated by recordActionOutcome). */
    actionCounters: {
      window_ms: 5 * 60 * 1000,
      events: /** @type {Array<{ts:number, action:string, status:string, error:string|null}>} */ ([]),
    },
    /** Last thrown API failure (sync POST /action or async task errors); cleared on successful sync action. */
    lastApiError: /** @type {{ ts: number, method: string, path: string, action: string | null, message: string } | null} */ (
      null
    ),
    MAX_ACTION_HISTORY: 24,
    MAX_TASK_HISTORY: 50,
  };
}

/** Stuck-detection diagnostics + sound events + perception buffers. */
export function createRuntimeState() {
  return {
    /** F51.2: Last failed movement attempt. Cleared on next successful move,
     *  on mc status, or after 30s. */
    lastMoveFailed: /** @type {{ ts: number, intended_target: {x:number,y:number,z:number}, actual_pos: {x:number,y:number,z:number}, reason: string, verb: string } | null} */ (
      null
    ),
    /** Survives position-drift clear of lastMoveFailed — for escape do_not_retry_goto. */
    lastFailedGotoTarget: /** @type {{ x: number, y: number, z: number } | null} */ (null),
    /** F53.2: Recent failed placement attempts. Capped at 8 entries. */
    recentPlaceFailures: /** @type {Array<{ts:number, target:{x:number,y:number,z:number}, block:string, error_code:string}>} */ (
      []
    ),
    /** F57.1: Recent mc escape calls — capped at 6 entries; decays lazily on read. */
    recentEscapes: /** @type {Array<{ts:number, cell:{x:number,y:number,z:number}, classification_before:string}>} */ (
      []
    ),
    /** F57.2: Cells where movement stalled or escape was needed; capped at 12 entries. */
    recentStuckCells: /** @type {Array<{ts:number, cell:{x:number,y:number,z:number}, source:'no_progress'|'escape', hit_count:number}>} */ (
      []
    ),
    /** circuit-v8 followup: cells where mc dig failed recently. After
     *  ≥ 3 failures at the same cell within 60s, dig surfaces a stronger
     *  DIG_BLOCKED_REPEAT envelope so the agent stops retrying. Capped
     *  at 12 entries; decays lazily on read. */
    recentDigFailures: /** @type {Array<{ts:number, cell:{x:number,y:number,z:number}, block:string|null, code:string, hit_count:number}>} */ (
      []
    ),
    /** Designated regions registry (per-world JSON). Set at server boot. */
    regions: null,
    /** Kanban card worksite grant (in-memory, per bot process). */
    taskContext: /** @type {{ card_id: string, worksite_region: string|null, expires_at: number, source: string } | null} */ (
      null
    ),
    /** F72: Items auto-picked-up from recent mc dig calls; 30s decay window. */
    recentPickups: /** @type {Array<{ts:number, item:string, count:number, source:string}>} */ (
      []
    ),
    /** #101: Blocks the bot placed recently — capped at 64 entries, 15-min
     *  TTL. Exempts these from isDigProtected so the bot can rebuild or
     *  relocate its own structures (chicken pens, scaffolding, etc.). */
    recentPlaces: /** @type {Array<{ts:number, cell:{x:number,y:number,z:number}, block:string}>} */ (
      []
    ),
    soundEvents: /** @type {Array<{type:string, position:any, distance:number, direction:string, time:number}>} */ ([]),
    /** Repeated stuck activations at the same spot — used to escalate the unstick wiggle. */
    _stuckActivations: /** @type {Array<{x:number, z:number, time:number}>} */ ([]),
    /** Timestamp of last stuck-streak log; rate-limits the watchdog wiggle to once per 5s. */
    _lastSyncStuckLogAt: /** @type {number | null} */ (null),
  };
}

/** Goal scoreboard + chest inventory snapshots. */
export function createGoalsState() {
  return {
    goalsStore: { goals: /** @type {object[]} */ ([]), deficitSince: /** @type {Record<string, number>} */ ({}) },
    chestSnapshots: /** @type {Record<string, { at:string, position:{x:number,y:number,z:number}, total:number, items:Array<{name:string,count:number}> }>} */ ({}),
  };
}

/** Team config + combat stats + furnaces + crouch state. */
export function createTeamState() {
  return {
    teamConfig: {
      team: /** @type {string | null} */ (null),
      role: /** @type {string | null} */ (null),
      teammates: /** @type {string[]} */ ([]),
      rallyPoint: /** @type {{x:number,y:number,z:number} | null} */ (null),
      teamChat: /** @type {Array<{time:number, from:string, message:string}>} */ ([]),
    },
    combatStats: { kills: 0, deaths: 0, assists: 0, damageDealt: 0, damageTaken: 0 },
    recentDamagers: /** @type {Record<string, any>} */ ({}),
    activeFurnaces: /** @type {Array<{id:string, position:any, estimatedDone?:number, [k:string]:any}>} */ ([]),
    isSneaking: false,
  };
}

/** Recurring-reminder store (persisted to data/reminders-<user>.json). */
export function createRemindersState() {
  return {
    reminders: /** @type {Array<{id:number, note:string, interval_ms:number, created:number, last_fired?:number, mark?:string}>} */ ([]),
    remindersNextId: 1,
  };
}

/** Death/damage/respawn/reconnect state. */
export function createDeathState() {
  return {
    deathLog: /** @type {Array<{time:number, position:any}>} */ ([]),
    lastDeath: /** @type {{ time: number, position: any, inventory: Array<{name:string,count:number}>, deathNumber: number } | null} */ (
      null
    ),
    hardcoreDead: false,
    lastDamageEvent: /** @type {{ amount: number; hp: number; ts: number } | null} */ (null),
    lastHealth: 20,
    reconnectAttempts: 0,
    /** Skip auto-reconnect from `end` when we voluntarily quit() to replace the session. */
    suppressEndReconnect: false,
  };
}

/** Layer-2 reactive autopilot state + fair-play mode + perception cache.
 *  fairPlayMode lives here because the reactive layer is the primary toggle
 *  (mc set_fair_play action belongs to the tactical layer). */
export function createReactiveState(config) {
  return {
    fairPlayMode: !!(config && config.behaviors && config.behaviors.fairPlay),
    /** Tactical mode: 'normal' | 'guard' | 'hold'. */
    mode: /** @type {string | null} */ (null),
    /** Combat skill ∈ [0,1] — soldier vs farmer. */
    combat_skill: /** @type {number | undefined} */ (undefined),
    /** Reactive anchor — point the reactive autopilot returns to. */
    reactiveAnchor: /** @type {{x:number,y:number,z:number} | null} */ (null),
    /** Auto-fired actions, capped at 32. */
    autoActionLog: /** @type {Array<{kind:string, why:string, ts:number, [k:string]:any}>} */ ([]),
    /** setInterval handle for the reactive tick loop. */
    _reactiveInterval: /** @type {NodeJS.Timeout | null} */ (null),
    /** Perception memory cache: blockKey → { name, bearing, distance, lastSeen }. */
    observedBlocks: new Map(),
    /** #97: engagement tracker for kiting-stalemate detection. Records the
     *  last few engage_step distances against a specific hostile. When
     *  distance fails to decrease across a sliding window, the controller
     *  declares stalemate and disengages. Reset when the target changes. */
    engageHistory: /** @type {{ target_id: number | null, target_name: string | null, distances: number[], started_at: number } | null} */ (null),
  };
}

/**
 * Compose all slices into the bot state object. `state.config` is the
 * top-level config reference; everything else is a named slice.
 *
 * @param {object} config  loaded config (see lib/config/index.js)
 */
export function createBotState(config) {
  return {
    config,
    world: createWorldState(),
    social: createSocialState(),
    tasks: createTasksState(),
    runtime: createRuntimeState(),
    goals: createGoalsState(),
    team: createTeamState(),
    reminders: createRemindersState(),
    death: createDeathState(),
    reactive: createReactiveState(config),
  };
}

/** Field → slice mapping. Authoritative reference for the Phase 3 migration.
 *  Exported so the state-slices test can verify field placement
 *  against the slice constructors without re-listing fields. */
export const FIELD_SLICE_MAP = Object.freeze({
  world:     ['bot', 'mcData', 'botReady', 'connectPromise', 'positionHistory', 'bootTime', 'mcSessionStartedAt'],
  social:    ['chatLog', 'overheardLog', 'commandQueue', 'socialGraph', 'socialEvents', 'lastChatTs', 'lastChatBriefedTime', 'MAX_LOG', 'MAX_QUEUE'],
  tasks:     ['currentTask', 'taskHistory', 'syncActionInFlight', 'syncActionName', 'syncActionStartedAt', 'cancelRequested', 'actionHistory', 'actionCounters', 'lastApiError', 'MAX_ACTION_HISTORY', 'MAX_TASK_HISTORY'],
  runtime:   ['lastMoveFailed', 'recentPlaceFailures', 'recentEscapes', 'recentStuckCells', 'recentDigFailures', 'regions', 'taskContext', 'recentPickups', 'recentPlaces', 'soundEvents', '_stuckActivations', '_lastSyncStuckLogAt'],
  goals:     ['goalsStore', 'chestSnapshots'],
  team:      ['teamConfig', 'combatStats', 'recentDamagers', 'activeFurnaces', 'isSneaking'],
  reminders: ['reminders', 'remindersNextId'],
  death:     ['deathLog', 'lastDeath', 'hardcoreDead', 'lastDamageEvent', 'lastHealth', 'reconnectAttempts', 'suppressEndReconnect'],
  reactive:  ['fairPlayMode', 'mode', 'combat_skill', 'reactiveAnchor', 'autoActionLog', '_reactiveInterval', 'observedBlocks', 'engageHistory'],
});
