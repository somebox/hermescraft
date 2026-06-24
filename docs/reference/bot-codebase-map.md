# Bot codebase map

One-page navigation reference for the bot codebase. Reflects the post-refactor
state (see `docs/archive/refactor-plan-2026.md` for the history). When in doubt
about where new code goes, this document is the answer; if it doesn't answer,
extend it.

## Layered architecture (P8 — no upward calls)

```
┌─────────────────────────────────────────────────────────┐
│  Layer 3 — Strategic agent (Hermes, LLM-driven)          │  outside this repo
└──────────────────────────────┬──────────────────────────┘
                               │ HTTP
┌──────────────────────────────▼──────────────────────────┐
│  lib/server/        HTTP listener, dispatch, middleware  │  Layer 1 (sync verbs) + Layer 2 (reactive)
│    ├── http-app.js          @size-exempt thin dispatcher │
│    ├── services.js          central DI container         │
│    ├── mock-services.js     test-time mirror             │
│    ├── state.js             9 bounded slices             │
│    ├── action-registry.js   handler lookup               │
│    ├── diagnostics.js       pure read-only stats         │
│    ├── route-probe.js       GET /route_probe terrain probe (Task #6) │
│    └── middleware/                                       │
│         ├── pipeline.js         pre/post lists           │
│         ├── position-guard.js   F51.2 intercept          │
│         ├── place-repeat-guard  F53.2 intercept + record │
│         ├── announce.js         F53.6 start/done chat    │
│         ├── chat-banner.js      F53.5 [!] result banner  │
│         └── task-lifecycle.js   dispatchAction + helpers │
├─────────────────────────────────────────────────────────┤
│  lib/runtime/       Layer 2 reactive + perception        │
│    execution-kernel/  Bulk orderCells + runCells motor   │
│    construct-context.js  Workset allowUnit factory (schematic MVP) │
│    ├── reactive.js          tick loop                    │
│    ├── reactive-helpers.js  pure watchdog state-machine helpers │
│    ├── manager.js           connect + stuck watchdog     │
│    ├── observation.js       /observe payload builders    │
│    ├── fair-play.js         LOS + sound + perception     │
│    ├── fair-play-constants.js  tunables (ranges, scan density) │
│    ├── spatial.js           map + look-around            │
│    ├── locations.js         marks store                  │
│    ├── dig-tools.js         tool classification          │
│    ├── water-route.js       BFS navigable water routes (mc sail_to) │
│    ├── boat-path.js         dense boat steering / executeBoatPath   │
│    └── paper-mcp.js         PaperMCP RPC client          │
├─────────────────────────────────────────────────────────┤
│  lib/actions/       Layer 1 — `mc <verb>` handlers       │
│  lib/goals/         goal-engine scoring + task runtime    │
│  lib/shared/        domain-pure helpers (resolver,       │
│                     chat, perception, recipe-ingredients,│
│                     schemas, action-contract, domains)   │
│  lib/config/        env-var + YAML config schema         │
└─────────────────────────────────────────────────────────┘
```

**Upward calls are forbidden.** `lib/runtime/*` MUST NOT import from
`lib/server/*` except for `diagnostics.js` (a pure leaf). `lib/actions/*`
MUST NOT import from `lib/runtime/manager.js` or `lib/server/*`. The
convention check does not yet enforce this — review-time only; a future
check could grep for violations.

**`bot/server.js`** is the composition root (~660 LOC, `// @size-exempt`):
config load → state factory → services container → all actions →
manager.connect → http-app listener.

## Action handlers — domain → file → handlers

Every `mc <verb>` lives in exactly one of these files. Files are sized to fit
the P16 budget (≤500 LOC) or carry `// @size-exempt: <reason>`.

| File | Handlers | Notes |
|---|---|---|
| `actions/inventory.js` | `equip` `unequip` `toss` | hand + slot ops |
| `actions/building.js` | `pillar_step` `place` `place_fill` `wall` `fence` `path` `dig_pit` `level` `build_stairs` | all block-placement verbs |
| `actions/excavation.js` | `dig_area` `tunnel` `stair_down` `stair_up` `pillar_down` | owns cardinalDelta + tunnelSliceBounds; `pillar_down` (#99) is the inverse of `pillar_step` — mines underfoot until ground |
| `actions/interaction.js` | `interact` `through` `close_screen` `use` | door / button / lever / GUI |
| `actions/queries.js` | `scout` `terrain_top` `find` `inspect` `reachable` `standing` `escape` `is_empty` `is_filled` `is_sheltered` | read-only world queries |
| `actions/lifecycle.js` | `chat` `wait` `surface` `sleep_bed` `set_home` `chat_to` `whisper` `respawn` `deathpoint` | bot lifecycle + chat verbs |
| `actions/mining/` | `collect` `dig` `pickup` `find_blocks` `find_entities` `safe_dig` `complete_command` `acknowledge_command` `cancel_command` | collect/dig dominate; Phase 9 (deferred) extracts helpers |
| `actions/movement.js` | `goto` `goto_near` `move` `follow` `look` `jump` `stop` | pathfinder + stall recovery; `refuseWaterRouteWithoutBoat` → `mc sail_to` hints |
| `actions/crafting.js` | `craft` `recipes` `craft_plan` `discover` | recipe-only post Phase 5 |
| `actions/furnace.js` | `smelt` `smelt_start` `furnace_check` `furnace_take` | smelt moved here from crafting in Phase 5 |
| `actions/containers.js` | `list_container` `deposit` `withdraw` `chest_search` | chest ops + shared openContainerStructured |
| `actions/marks.js` | `mark` `mark_update` `marks` `go_mark` `unmark` | location bookmarks |
| `actions/team.js` | `team_chat` `team_status` `rally` `report` `set_team` `set_fair_play` | multi-agent coordination |
| `actions/reminders.js` | `remind` `list_reminders` `unremind` | recurring nudges |
| `actions/combat.js` | `mode` `combat_skill` `attack` `eat` `feed_mob` `fight` `flee` `sneak` `shield_block` `shoot` `sprint_attack` `critical_hit` `strafe` `combo` | combat verbs share threat-filter helpers |
| `actions/farming.js` | `till` `plant` `bonemeal` `harvest` | crops (wheat / beets / carrots / potatoes / saplings / sugar_cane); PaperMCP fallback for Paper 1.21+ `activateBlock` no-op |
| `actions/animals.js` | `breed` `shear` `milk_cow` `hunt` `lure` | shared fair-play + chase/`useOn` retry helpers |
| `actions/water.js` | **`sail_to`** `fish` `place_boat` `board` `sail` `disembark` `bucket_fill` `bucket_empty` | Ferry orchestration in actions; **`planWaterRoute`** (`lib/runtime/water-route.js`) + **`planBoatPath` / `executeBoatPath`** (`lib/runtime/boat-path.js`). Agent-facing ferry: **`mc sail_to`** only. Canonical command docs: [`docs/reference/mc-command-reference.md`](mc-command-reference.md). |

## State slices

`createBotState(config)` returns `{ config, world, social, tasks, runtime, goals, team, reminders, death, reactive }`. The authoritative field→slice map is exported as `FIELD_SLICE_MAP` from `bot/lib/server/state.js`.

| Slice | What it owns |
|---|---|
| `world` | Mineflayer bot, mcData, connect state, position history, boot time |
| `social` | chat logs, command queue, social graph, MAX_LOG/MAX_QUEUE caps |
| `tasks` | currentTask, history, action counters, sync-in-flight state, lastApiError, history caps |
| `runtime` | F-numbered stuck-detection diagnostics + sound events + `recentPickups` (#F72) + `recentPlaces` (#101 — exempts agent-placed protected blocks from `isDigProtected` for 15 min) |
| `goals` | goalsStore, chest snapshots |
| `team` | team config, combat stats, recent damagers, active furnaces, isSneaking |
| `reminders` | recurring-reminder store |
| `death` | deathLog, lastDeath, hardcore flag, damage/HP tracking, reconnect counters |
| `reactive` | Layer-2 mode/skill/anchor, perception cache, fair-play mode |

## HTTP middleware pipeline

Sync `POST /action/<name>` runs through `dispatchAction` (in `lib/server/middleware/task-lifecycle.js`) which threads request + body through:

```
preMiddleware  (intercept-or-continue)
  ├── positionGuard       — F51.2 stale-move-failure short-circuit
  ├── placeRepeatGuard    — F53.2 3rd-failed-place intercept
  └── announce            — F53.6 fire "starting" chat if reason= + LONG_VERBS
↓
handler(body)
↓
postMiddleware  (mutate-or-pass)
  ├── placeRepeatGuard.recordOutcome  — push/clear ring buffer
  ├── announce.apply                  — fire completion chat if >3s
  └── chatBanner.apply                — prepend [!] banner if unread chat
```

Async `POST /task/<name>` (background) **skips** pre/post middleware — preserves pre-refactor behaviour. Lifecycle bookkeeping (currentTask, history records) still runs in the background `.then`/`.catch`.

## Adding a new action — checklist

1. Decide the **module** by domain. Match the table above. If none fits, create a new module (and add it to this table).
2. The factory accepts `services` (preferred) or `deps` (legacy). New modules should be services-first. Migration status (`bot/lib/actions/index.js`):
   - **services-based**: `inventory`, `building`, `excavation`, `interaction`, `lifecycle`, `queries`, `crafting`
   - **legacy `deps`**: `movement`, `mining`, `containers`, `marks`, `furnace`, `team`, `reminders`, `combat`, `farming`, `animals`, `water`
3. Handler returns via `ok({...})` / `fail('CODE', 'msg', {...})` from `lib/shared/action-contract.js`. Never inline `{ok: false, error: {...}}` literals.
4. If the module needs cross-action calls, use `services.getActions().verb(body)` (preferred) or the legacy `deps.ACTIONS.verb(body)` for modules still on `deps`. Never capture a long-lived ACTIONS reference.
5. If the module is new, add the factory import + call to `lib/actions/index.js`. `actions-manifest.test.js` fails on omission.
6. Add a smoke test under `bot/test/`. Build the factory with `createMockServices()`, exercise one representative failure path, and assert `validate()` passes.
7. If the module passes 500 LOC, either split it OR add `// @size-exempt: <reason>` at the top.
8. Update the CLI registry (`bot/cli/registry.mjs`) with description, params, and examples. P3 requires a non-empty description. If the verb belongs on the default agent surface, add the name to `bot/cli/registry-surface.mjs` (`SURFACE_CORE` or `SURFACE_MICROSCOPE`; omit for extended). Run `node scripts/gen-mc-cheatsheet.mjs` (or `npm run cheatsheet`) and commit the regenerated cheatsheet. If emitting structured world nouns, use `bot/lib/shared/typed-nouns.js` (`block_ref` pilot on `find_blocks`, `inspect`, scene hits).

## Adding a new HTTP middleware — checklist

1. Pre-middleware: export `check(services, body, actionName, meta) → { intercept: true, response } | { intercept: false }`.
2. Post-middleware: export `apply(services, body, actionName, result, meta) → newResult | undefined`. Return `undefined` to leave the result unchanged.
3. Place the module under `bot/lib/server/middleware/`.
4. Register it in `lib/server/middleware/pipeline.js` in the appropriate ordered list. Document order rationale in the file's top comment.
5. Add a unit test under `bot/test/middleware/`. Drive the middleware with `createMockServices()` overrides; never spin up an HTTP server.

## Convention checks

Run before committing — gated by P14:

```
node scripts/check-conventions.mjs
```

Currently enforces (`scripts/check-conventions.mjs`):

- **P3** — registry descriptions: every `bot/cli/registry.mjs` command has a non-empty description.
- **P4** — fixture conventions (three sub-checks): cleanup uses `execute in landfolk-test run tp Flint 52 65 52` (safe-home), every fixture declares `world: landfolk-test`, every combat-mob summon tags `Tags:["target"]`.
- **P16** — module size budget: files in `bot/lib/**/*.js` must be ≤500 LOC unless annotated `// @size-exempt: <reason>` at top of file.
- **P20** — services parity: `createMockServices` top-level + bundle keys match `createServices` / `SERVICES_KEYS` / `SERVICE_BUNDLE_KEYS` bidirectionally.

Layer-boundary enforcement (P8 — no upward calls) is **not** automated yet.

## Actions layout — current vs target (2026 refactor)

**Current:** one factory file per domain at `bot/lib/actions/<domain>.js` (flat), plus `_`-prefixed helpers (`_helpers.js`, `_nav-helpers.js`). Query actions may use a subdirectory (e.g. `actions/queries/` with `escape/strategies.js`).

**Target (in progress):** largest domains become subdirectories with a thin shim at the legacy path:

```
bot/lib/actions/water.js     → export { createWaterActions } from './water/index.js'
bot/lib/actions/water/       sail-to/, place-boat.js, board.js, …
bot/lib/actions/mining/      collect/, dig.js, pickup.js, scout.js, …
bot/lib/actions/building/    place-single.js, place-bulk.js, pillar.js, terrain.js
bot/lib/actions/movement/    goto.js, move.js, _preflight.js, water-refusal.js, …
bot/lib/actions/queries/     escape/, scout.js, find.js, …
```

Shared constants/LOS/args: `_block-sets.js`, `_directions.js`, `_los.js`, `_args.js`. Runtime planners for boats stay in `lib/runtime/` (not under `actions/`).

Command semantics and agent chains: [`docs/reference/mc-command-reference.md`](mc-command-reference.md).

## Cross-references

- `docs/reference/engineering-patterns.md` — canonical pattern list (P1-P20)
- `docs/archive/refactor-plan-2026.md` — history of the 2026 refactor (Phases 1-10) that produced this structure
- `docs/reference/bot/handler-response-contracts.md` — error-code taxonomy per primitive (referenced by P9)
- [`docs/reference/mc-command-reference.md`](mc-command-reference.md) — canonical command taxonomy, argument schemas, chain playbooks (Section E)
- `docs/reference/hermes-mc-boundaries.md` — Hermes ↔ bot interface contract
