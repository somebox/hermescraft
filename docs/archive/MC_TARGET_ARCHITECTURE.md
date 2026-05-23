# `mc` Target Architecture

This document defines a target architecture for the `mc` command and bot server as HermesCraft moves from a command wrapper toward goal-directed autonomous play.

## Implementation status (repo)

| Area | Status |
|------|--------|
| Goal engine (`bot/lib/goals/engine.js`), persistence, presets | Implemented |
| Task runtime + leases (`bot/lib/goals/tasks.js`), `/task/start`, checkpoint respond | Implemented |
| HTTP: `/observe`, `/checkpoint`, `/alerts`, `/logistics`, `/goals` | Implemented |
| Fleet command center (`dashboard/` on port 3000, not per-bot HTTP) | Implemented |
| CLI: `mc observe`, `alerts`, `discover`, `craft_plan`, `logistics`, goals/task/dashboard | Implemented |
| First preset `data/goal-presets/gatherer.json`, prompt `prompts/landfolk/gatherer-test.md`, skill `skills/minecraft-goals.md` | Implemented |
| Profile design for archer/builder/miner (no evaluators yet) | `docs/design/goal-profiles.md` |
| Shared domains + envelopes (`bot/lib/shared/domains.js`, `bot/lib/shared/schemas.js`) | Implemented |
| Item/block resolution (`bot/lib/shared/resolver.js`), wired into collect/find/craft/recipes/equip | Implemented |
| Fair-play constants (`bot/lib/bot/fair-play-constants.js`) + perception suite (`bot/lib/bot/fair-play.js`) | Implemented |
| Spatial narration (`bot/lib/bot/spatial.js`) — `/map`, `/look` | Implemented |
| Bot context factory (`bot/lib/server/state.js`, `bot/lib/server/config.js`) | Implemented |
| Action registry (`bot/lib/server/action-registry.js`), CLI POST `/action` \| `/task` parity test | Implemented |
| HTTP listener factory (`bot/lib/server/http-app.js`), router re-export (`bot/lib/router.js`), body-parse tests | Implemented |
| Per-route modules under `bot/routes/` splitting GET/POST branches | Not yet |
| Domain-split action modules (`bot/lib/actions/*.js`) | **Done** — 6 domain modules + index assembler |
| Mineflayer lifecycle package (`bot/lib/bot/manager.js`) | Implemented |
| Observation factory (`bot/lib/bot/observation.js`) | Implemented |
| Slim `server.js` entrypoint (~590 LOC wiring-only) | **Done** |

### Refactor plan checklist (phases vs repo)

Cross-check against the retained HermesCraft bot refactor plan (domains → slim entrypoint). This table is the source of truth for **what is done** vs **still open**.

| Phase | Topic | Status |
|-------|--------|--------|
| 1 | Domains + shared schemas (`shared/domains.js`, `shared/schemas.js`) + tests | Done |
| 2 | `BotContext` (`server/state.js`, `server/config.js`) + tests | Done |
| 3 | Resolver (`shared/resolver.js`) + tests; wired into collect/find/craft/recipes/equip | Done |
| 4 | Fair-play (`bot/fair-play-constants.js`, `bot/fair-play.js`) | Done |
| 5 | Spatial (`bot/spatial.js`) + compass-level tests | Done |
| 6 | Action registry wrapper (`server/action-registry.js`); rich per-action metadata (domain, schemas, sideEffects) | Partial — wrapper only |
| 7 | Domain action modules (`lib/actions/*.js`) | **Done** — movement, mining, crafting, combat, world, containers |
| 8 | Registry-backed HTTP router + `bot/routes/*` | Partial — `createBotHttpListener` + `router.js`; no per-route files |
| 9 | CLI ↔ registry sync | Done — `test/cli-action-sync.test.js` |
| 10 | Bot manager (`bot/manager.js`) + slim `server.js` | **Done** — server.js is ~590 LOC wiring-only |
| 11 | Observation factory (`bot/observation.js`) | **Done** |
| 12 | Integration/regression/docs | Partial — `test/integration/listener-health.test.js`; docs here |

**Next sequencing (when continuing refactor):** **A)** Per-route HTTP files (`bot/routes/*`) splitting GET/POST branches from `http-app.js`. **B)** Rich per-action metadata in the action registry (domain, param schemas, sideEffect flags).


## Bot server module layout

`bot/server.js` is a thin wiring entrypoint (~590 LOC) that imports modules, injects dependencies, and starts the HTTP server. All gameplay logic lives in `bot/lib/`.

### `bot/lib/actions/` — domain action handlers

Each file exports a `create*Actions(deps)` factory returning an object of `async handler(body)` methods:

- **`movement.js`** — goto, goto_near, follow, look, stop
- **`mining.js`** — collect, dig, pickup, find_blocks, find_entities, complete_command
- **`crafting.js`** — craft, recipes, craft_plan, discover, smelt
- **`combat.js`** — attack, eat, feed_mob, fight, flee, sneak, shield_block, shoot, sprint_attack, critical_hit, strafe, combo
- **`world.js`** — equip, unequip, toss, pillar_step, place, place_fill, terrain_top, dig_area, interact, close_screen, chat, wait, use, sleep_bed, chat_to, whisper, deathpoint
- **`containers.js`** — list_container, deposit, withdraw, mark, marks, go_mark, unmark, team_chat, team_status, rally, report, set_team, set_fair_play, remind, list_reminders, unremind, smelt_start, furnace_check, furnace_take
- **`index.js`** — assembles all factories into one ACTIONS map via `createAllActions(deps)`

### `bot/lib/bot/` — Mineflayer-dependent gameplay

- **`manager.js`** — Mineflayer `createBot`, plugins/events, reconnect backoff, hardcore guard, stuck watchdog.
- **`fair-play-constants.js`** / **`fair-play.js`** — fair-play tuning values and LOS / scanning / sound helpers.
- **`spatial.js`** — ASCII map + verbal "look around" summaries from Mineflayer state.
- **`locations.js`** — persistent location marks, container resolution, mark staleness.
- **`dig-tools.js`** — tool selection, harvest priority, dig time estimates, protected blocks.
- **`observation.js`** — `createObservation(deps)` factory for briefState, getFullState, getInventory, getNearby, buildObservePayload, buildLogisticsPayload.

### `bot/lib/server/` — HTTP infrastructure

- **`config.js`** — argv + env configuration.
- **`state.js`** — mutable runtime context (`ctx`) for one bot process.
- **`http-app.js`** / **`router.js`** — HTTP listener factory (`createBotHttpListener`) plus `parseBody` / `respond`.
- **`action-registry.js`** — thin registry mapping action names to handlers.

### `bot/lib/shared/` — pure utilities (no bot/server deps)

- **`perception.js`** — angle math, bearing, sector classification, scene summarization.
- **`resolver.js`** — typed queries (`axe`, `wood`, exact IDs) for inventory, blocks, and craft targets.
- **`chat.js`** — message routing, social graph management, cast definitions.
- **`domains.js`** — public capability domains.
- **`schemas.js`** — API envelope helpers (`okEnvelope`, `errEnvelope`, `assertDomain`).

### `bot/lib/goals/` — goal engine

- **`engine.js`** — goal persistence, metric evaluation, scoring, presets.
- **`tasks.js`** — task record and lease management helpers.

### Backward compatibility

Re-export shims at old flat `bot/lib/` paths (e.g. `lib/goals.js` re-exports from `lib/goals/engine.js`) keep existing imports stable during the transition.

### Regression

`bot/test/cli-action-sync.test.js` ensures every CLI POST `/action/` or `/task/` entry (except task control endpoints) names a handler present in the assembled ACTIONS map (scanned from `lib/actions/*.js`).

Items below marked as **target** may still be future work (e.g. `mc engage`, farm/repair commands).

The design principle: give agents strong generic capabilities and rich world telemetry, then let the agent decide what to do based on its goals and the current situation.

## Current baseline

Today `mc` is:
- a CLI router (`bin/mc`) mapping shell commands to HTTP endpoints
- a bot server (`bot/server.js` + `bot/lib/`) executing one action at a time (or one background task)
- an LLM prompt loop that decides strategy externally by polling

This works for direct control but creates problems at scale:
- complex behavior requires constant LLM reasoning per action
- no built-in progress tracking or time budgeting
- no structured way to switch between competing priorities
- behavior drifts across sessions and agents

## Design principles

- `mc` provides **capability + telemetry + task control**, not strategy
- strategy lives in the agent (LLM or planner), not in hardcoded state machines
- commands are generic and composable, not role-specific
- every running activity is observable, interruptible, and resumable
- the agent can pause, reflect, and switch at any time without losing work

## Layered model

### Layer 1: Primitive Actions

Atomic operations. Quick, deterministic, structured output.

Categories:
- **observe**: `status`, `inventory`, `nearby`, `scene`, `alerts`, `sounds`
- **move**: `goto`, `goto_near`, `follow`, `stop`, `look_at`
- **world**: `collect`, `dig`, `place`, `interact`, `pickup`
- **craft**: `craft`, `recipes`, `smelt`, `deposit`, `withdraw`
- **combat**: `attack`, `shoot`, `shield`, `strafe`, `flee`, `eat`, `equip`
- **social**: `chat`, `whisper`, `team_chat`, `report`
- **memory**: `mark`, `marks`, `go_mark`, `unmark`

Guidelines:
- returns `{ ok, result, state }` always
- failures include typed error codes (`missing_item`, `unreachable`, `blocked`, `threat`)
- declares whether the action may alter terrain (for safe pathfinding)

### Layer 2: Task Runtime

Purpose: manage longer jobs with lifecycle, progress tracking, and interruption support.

Task lifecycle:
```
created -> running -> [checkpoint] -> running -> done
                   \-> paused -> resumed -> running
                   \-> cancelled
                   \-> error
```

Key properties:
- `task_id`: unique identifier
- `parent_goal_id`: which goal this task serves
- `contributes_to`: `{ goal_id: weight }` map (a task can help multiple goals)
- `lease_expires_at`: when the agent must re-evaluate
- `progress`: task-specific metrics (items gained, distance closed, blocks placed)
- `resume_token`: enough state to continue after pause

Task APIs:
- `mc task_start <action> <params> --goal <goal_id> --lease <seconds>`
- `mc task_status`
- `mc task_pause`
- `mc task_resume [task_id]`
- `mc task_cancel`
- `mc tasks` (history with durations, outcomes, goal attribution)

### Layer 3: Goal Engine

Purpose: give the agent a structured set of objectives it can inspect, prioritize, and act on.

A goal is not a script. It defines *what* matters, not *how* to achieve it.

#### Goal schema

```json
{
  "id": "keep_arrows_stocked",
  "enabled": true,
  "priority": 70,
  "metric": "inventory.arrow + chest.archer_cache.arrow",
  "current": 47,
  "target_min": 192,
  "target_ok": 256,
  "gap": 145,
  "urgency": 0.76,
  "time_in_deficit_s": 340,
  "active_task_id": null,
  "last_progress_at": null,
  "strategies_available": [
    "withdraw_from_chest",
    "craft_from_materials",
    "gather_feathers",
    "gather_wood",
    "gather_flint"
  ],
  "constraints": {
    "preempt_class": "normal",
    "min_run_s": 30,
    "cooldown_after_fail_s": 60
  }
}
```

#### Goal commands

- `mc goals` — list all goals with current score, metric, gap, active task
- `mc goal_add <json|preset_name>` — add a new goal
- `mc goal_set <id> <field> <value>` — adjust priority, target, enabled, etc.
- `mc goal_remove <id>`
- `mc goal_status <id>` — detailed view with strategy options and blockers
- `mc goal_presets` — list available preset goal sets (e.g. `archer`, `miner`, `builder`)

#### How urgency is computed

```
urgency = clamp(0, 1,
  (gap / target_ok) * priority_weight
  + time_starvation_bonus
  + context_multiplier
)
```

Where:
- `gap` = how far below target
- `priority_weight` = normalized priority relative to other goals
- `time_starvation_bonus` = increases if goal ignored for too long
- `context_multiplier` = situational (night boosts defense, day boosts logistics)

The agent reads urgency scores and picks what to work on. The server computes them; the agent acts on them.

### Layer 4: Deliberation Cycle

Purpose: structured pause-and-reflect built into the runtime.

#### Lease model

Every running task has a **lease** — a time window before the agent must re-evaluate.

- short leases (20–60s) for volatile situations
- longer leases (2–5min) for stable background work
- emergency events expire all leases immediately

#### Checkpoint flow

When lease expires or an event fires:

1. **Snapshot**: refresh world state, alerts, inventory, goal metrics
2. **Score**: compute urgency for all goals
3. **Evaluate current task**:
   - progress rate (items/s, blocks/s, distance/s)
   - estimated time remaining
   - marginal value of continuing
4. **Compare**: current task value vs best alternative
5. **Decide**:
   - if current still best -> renew lease, continue
   - if alternative clearly better -> pause current, start new task
   - if blocked or failing -> abort, try different strategy or goal

#### Anti-thrash controls

- **minimum run window**: task guaranteed at least N seconds before first checkpoint (except emergency)
- **switch cost penalty**: factor in travel/setup time when scoring alternatives
- **cooldown on failed strategies**: don't retry same approach immediately
- **hysteresis band**: don't switch for marginal score differences (require threshold delta)

### Layer 5: Agent Intelligence

The LLM/planner layer. Responsible for:
- creative problem-solving when standard strategies fail
- social interaction and coordination
- setting and adjusting goals based on player requests or world events
- choosing novel strategies not in the preset list
- long-term planning and memory

This layer reads from the goal engine and task runtime but is not required for basic goal pursuit. A simple greedy scorer can drive behavior without an LLM for testing purposes.

## Observation improvements

### Unified snapshot

Add `mc observe` that returns a single merged view:
- position, health, food, time, weather
- inventory summary (counts by category)
- goal scoreboard (top 5 by urgency)
- active task + lease status
- alerts (threats, sounds, chat signals)
- nearby entities and notable blocks

This reduces the "run 5 commands to understand the world" problem.

### Alerts system

`mc alerts` returns typed, scored events:

```json
[
  { "type": "hostile", "entity": "creeper", "distance": 12, "bearing": "NW", "threat_score": 0.9 },
  { "type": "sound", "kind": "mining", "direction": "south", "distance_est": 14 },
  { "type": "chat_signal", "from": "Reed", "keyword": "help", "urgency": "high" },
  { "type": "damage", "block": "oak_fence", "position": [102, 65, -340], "cause": "explosion" }
]
```

### Resource discovery

`mc discover <need>` — flexible resource lookup:
- `mc discover logs` -> all log types visible + in chests + at marks
- `mc discover food` -> cooked items in inventory, raw items, animals nearby, farms
- `mc discover arrows` -> current count + materials for crafting + chest locations

Returns options ranked by effort/distance, not just raw block search.

## Combat model

Combat should be **generic and configurable**, not hardcoded roles.

### Combat commands (expanded)

Existing primitives stay. Add:
- `mc engage <target> --style ranged|melee|kite --max-distance N --min-distance N`
- `mc disengage` — break contact safely
- `mc threat_scan` — scored target list with type/distance/danger
- `mc loadout_check` — report readiness (weapon, ammo, food, armor, durability)

### Combat behavior parameters

Instead of fixed "archer mode" or "warrior mode", expose tunable parameters:
- preferred engagement range
- retreat health threshold
- ammo conservation floor
- chase limit (don't pursue beyond N blocks from anchor)
- target priority weights

These live on the goal or as task parameters, not global config.

## Production and logistics

### Goal-driven supply

Instead of contracts, use goals:
- `keep_arrows_stocked` (metric: arrow count, target: 256)
- `maintain_food` (metric: food score, target: 48)
- `maintain_tools` (metric: best pickaxe durability, target: > 50%)

The agent picks strategies to satisfy goals:
- check storage first (cheapest)
- craft from available materials
- gather missing inputs
- scale up (build farm, expand storage) if deficit is chronic

### Logistics commands

- `mc logistics status` — what's where (inventory + known chests + marks)
- `mc logistics deficit` — computed shortfalls across all supply goals
- `mc craft_plan <item> [count]` — dependency tree from current inventory

### Farming

Generic farming primitives, not crop-specific scripts:
- `mc farm_status <mark>` — what's growing, what's ready, animal counts
- `mc farm_harvest <mark>` — collect ready outputs
- `mc farm_maintain <mark>` — replant, breed, feed

## Repair and recovery

### Assessment

- `mc assess <mark> [radius]` — scan for damage, missing blocks, broken stations
- Returns: list of issues, classified by severity and type

### Repair

- `mc repair_plan <mark>` — generate ordered fix list from assessment
- Agent executes repairs using normal `place`, `craft`, `interact` primitives
- No special "repair mode" — just goals that care about structural integrity

### Recovery goal example

```json
{
  "id": "base_integrity",
  "metric": "assess.base_core.issues_count",
  "target_min": 0,
  "target_ok": 0,
  "priority": 60,
  "strategies_available": ["repair_structural", "replace_stations", "restock_chests"]
}
```

## Command surface summary (target)

### Existing (keep as-is)
All current `mc` primitives remain unchanged.

### New observation
- `mc observe` — unified snapshot
- `mc alerts` — typed threat/event feed
- `mc discover <need>` — flexible resource search
- `mc threat_scan` — scored hostile list
- `mc loadout_check` — combat readiness
- `mc assess <mark> [radius]` — damage scan
- `mc logistics status` — supply overview
- `mc logistics deficit` — computed shortfalls
- `mc craft_plan <item> [count]` — dependency tree

### New task control
- `mc task_start <action> <params> --goal <id> --lease <s>`
- `mc task_status`
- `mc task_pause`
- `mc task_resume [id]`
- `mc task_cancel`
- `mc tasks` — history and metrics

### New goal management
- `mc goals`
- `mc goal_add <json|preset>`
- `mc goal_set <id> <field> <value>`
- `mc goal_remove <id>`
- `mc goal_status <id>`
- `mc goal_presets`

### New combat
- `mc engage <target> --style ... --max-distance ... --min-distance ...`
- `mc disengage`

### New logistics/farming
- `mc farm_status <mark>`
- `mc farm_harvest <mark>`
- `mc farm_maintain <mark>`
- `mc repair_plan <mark>`

## Observability

Track per-agent:
- goal scores over time (are goals being satisfied?)
- task durations and switch frequency (is it thrashing?)
- lease renewal vs switch ratio
- progress rate per strategy (which approaches work?)
- alert response latency
- deficit duration (how long goals stay unsatisfied)

## Testing strategy

- **Unit**: goal scoring formula, urgency computation, anti-thrash logic
- **Integration**: task start/pause/resume/cancel lifecycle, lease expiry triggers
- **Scenario**: night raid (emergency preemption), supply collapse (strategy switching), chronic deficit (farm scaling), multi-goal competition (prioritization)
- **Regression**: existing `mc` primitives continue working unchanged

## Migration path

1. Keep all existing `mc` primitives stable and working
2. Add `mc observe` (merged snapshot) and `mc alerts` (typed events)
3. Add task runtime with lease/pause/resume support
4. Add goal engine with scoring and `mc goals` commands
5. Add `mc discover`, `mc craft_plan`, `mc logistics deficit`
6. Add `mc engage` and combat parameter model
7. Add farm and repair assessment commands
8. Move orchestration from prompts into goal-driven deliberation loops

Each step is independently useful. The system stays playable throughout.
