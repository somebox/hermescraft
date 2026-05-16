# Architecture map

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
│    └── middleware/                                       │
│         ├── pipeline.js         pre/post lists           │
│         ├── position-guard.js   F51.2 intercept          │
│         ├── place-repeat-guard  F53.2 intercept + record │
│         ├── announce.js         F53.6 start/done chat    │
│         ├── chat-banner.js      F53.5 [!] result banner  │
│         └── task-lifecycle.js   dispatchAction + helpers │
├─────────────────────────────────────────────────────────┤
│  lib/runtime/       Layer 2 reactive + perception        │
│    ├── reactive.js          tick loop                    │
│    ├── manager.js           connect + stuck watchdog     │
│    ├── observation.js       /observe payload builders    │
│    ├── fair-play.js         LOS + sound + perception     │
│    ├── spatial.js           map + look-around            │
│    ├── locations.js         marks store                  │
│    ├── dig-tools.js         tool classification          │
│    └── paper-mcp.js         PaperMCP RPC client          │
├─────────────────────────────────────────────────────────┤
│  lib/actions/       Layer 1 — `mc <verb>` handlers       │
│  lib/goals/         goal-engine scoring                   │
│  lib/shared/        domain-pure helpers (resolver,       │
│                     chat, perception, recipe-ingredients,│
│                     schemas, action-contract)            │
└─────────────────────────────────────────────────────────┘
```

**Upward calls are forbidden.** `lib/runtime/*` MUST NOT import from
`lib/server/*` except for `diagnostics.js` (a pure leaf). `lib/actions/*`
MUST NOT import from `lib/runtime/manager.js` or `lib/server/*`. The
convention check enforces this informally — a future check could grep for
violations.

## Action handlers — domain → file → handlers

Every `mc <verb>` lives in exactly one of these files. Files are sized to fit
the P16 budget (≤500 LOC) or carry `// @size-exempt: <reason>`.

| File | Handlers | Notes |
|---|---|---|
| `actions/inventory.js` | `equip` `unequip` `toss` | hand + slot ops |
| `actions/building.js` | `pillar_step` `place` `place_fill` `wall` `fence` `path` `dig_pit` `level` `build_stairs` | all block-placement verbs |
| `actions/excavation.js` | `dig_area` `tunnel` `stair_down` `stair_up` | owns cardinalDelta + tunnelSliceBounds |
| `actions/interaction.js` | `interact` `through` `close_screen` `use` | door / button / lever / GUI |
| `actions/queries.js` | `scout` `terrain_top` `find` `inspect` `reachable` `standing` `escape` `is_empty` `is_filled` `is_sheltered` | read-only world queries |
| `actions/lifecycle.js` | `chat` `wait` `surface` `sleep_bed` `set_home` `chat_to` `whisper` `respawn` `deathpoint` | bot lifecycle + chat verbs |
| `actions/mining.js` | `collect` `dig` `pickup` `find_blocks` `find_entities` `safe_dig` `complete_command` `acknowledge_command` `cancel_command` | collect/dig dominate; Phase 9 (deferred) extracts helpers |
| `actions/movement.js` | `goto` `goto_near` `move` `follow` `look` `stop` | pathfinder + stall recovery |
| `actions/crafting.js` | `craft` `recipes` `craft_plan` `discover` | recipe-only post Phase 5 |
| `actions/furnace.js` | `smelt` `smelt_start` `furnace_check` `furnace_take` | smelt moved here from crafting in Phase 5 |
| `actions/containers.js` | `list_container` `deposit` `withdraw` `chest_search` | chest ops + shared openContainerStructured |
| `actions/marks.js` | `mark` `mark_update` `marks` `go_mark` `unmark` | location bookmarks |
| `actions/team.js` | `team_chat` `team_status` `rally` `report` `set_team` `set_fair_play` | multi-agent coordination |
| `actions/reminders.js` | `remind` `list_reminders` `unremind` | recurring nudges |
| `actions/combat.js` | `mode` `combat_skill` `attack` `eat` `feed_mob` `fight` `flee` `sneak` `shield_block` `shoot` `sprint_attack` `critical_hit` `strafe` `combo` | combat verbs share threat-filter helpers |
| `actions/farming.js` | crop verbs | plant/harvest/water |
| `actions/animals.js` | mob-interaction verbs | breed/feed/shear/hunt/lure |
| `actions/water.js` | `fish` `place_boat` `board` `sail` `disembark` `bucket_fill` `bucket_empty` | absorbed bucket_* from former world.js in Phase 4 |

## State slices

`createBotState(config)` returns `{ config, world, social, tasks, runtime, goals, team, reminders, death, reactive }`. The authoritative field→slice map is exported as `FIELD_SLICE_MAP` from `bot/lib/server/state.js`.

| Slice | What it owns |
|---|---|
| `world` | Mineflayer bot, mcData, connect state, position history, boot time |
| `social` | chat logs, command queue, social graph, MAX_LOG/MAX_QUEUE caps |
| `tasks` | currentTask, history, action counters, sync-in-flight state, lastApiError, history caps |
| `runtime` | F-numbered stuck-detection diagnostics + sound events |
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
2. The factory accepts `services` (preferred) or `deps` (legacy). New modules should be services-first.
3. Handler returns via `ok({...})` / `fail('CODE', 'msg', {...})` from `lib/shared/action-contract.js`. Never inline `{ok: false, error: {...}}` literals.
4. If the module needs cross-action calls, use `services.getActions().verb(body)` — never capture an ACTIONS map.
5. If the module is new, add the factory import to `lib/actions/index.js`. The `actions-manifest.test.js` will fail if you forget.
6. Add a smoke test under `bot/test/`. Build the factory with `createMockServices()`, exercise one representative failure path, and assert `validate()` passes.
7. If the module passes 500 LOC, either split it OR add `// @size-exempt: <reason>` at the top.
8. Update the CLI registry (`bot/cli/registry.mjs`) with description, params, and examples. P3 requires a non-empty description.

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

Currently enforces:
- **P3**: every CLI registry command has a description
- **P4**: test fixtures use safe-home tp, declare `landfolk-test` world, tag combat mobs `Tags:["target"]`
- **P16**: modules in `bot/lib/` stay under 500 LOC unless `// @size-exempt:` annotated
- **P20**: `createMockServices` keys match `createServices` / `SERVICES_KEYS` bidirectionally

## Cross-references

- `docs/patterns.md` — canonical pattern list (P1-P20)
- `docs/archive/refactor-plan-2026.md` — history of the 2026 refactor (Phases 1-10) that produced this structure
- `docs/phase-2/action-contracts.md` — error-code taxonomy per primitive (referenced by P9)
- `docs/MC_AGENT_BOUNDARIES.md` — Hermes ↔ bot interface contract
