# Refactor bot/lib for testability, maintainability, traceability

## Context

Fork of an experimental Minecraft-agent platform. No upstream PR planned; no backwards-compat constraint (P12). The first pass trimmed `bot/server.js` from a monolith to a 619-line composition root. This pass attacks the modules that grew large because they absorbed everything the first pass didn't touch.

**Goals:** decompose around logical boundaries, define clear contracts, make the code easier to test and change.

**Hotspots:**

| File | Lines | Problem |
|---|---|---|
| `actions/world.js` | 4121 | grab-bag: inventory + building + excavation + interaction + chat + queries + lifecycle |
| `actions/mining.js` | 1381 | `collect` (~750L) and `dig` (~250L) dominate |
| `server/http-app.js` | 978 | flat router with inlined F-numbered guards |
| `actions/movement.js` | 939 | coherent but large |
| `actions/containers.js` | 864 | grab-bag: containers + marks + furnace + team + reminders |

**Structural issues:**

- Behavior flags duplicated across modules (`LONG_VERBS`, `POSITION_DEPENDENT_VERBS`, `STUCK_MOVEMENT_ACTIONS`, `SYNC_STUCK_ACTIONS`, `noBanner`) — not derived from one source.
- Upward dependency: `lib/runtime/observation.js` imports from `lib/server/http-app.js` (violates P8).
- Double instantiation: `lib/actions/index.js` builds movement/mining/world/containers twice so the ACTIONS-map self-reference resolves.
- No contract enforcement: P9 is "soft." 100+ inline `{ok:false, error:{...}}` literals with inconsistent fields.
- `reason=` only powers the F53.6 announce; never reaches `actionHistory` or the dashboard.

---

## Decisions

| Topic | Choice |
|---|---|
| Action contract | `ok()`/`fail()` helpers + `validate()` now; `defineAction({...})` self-describing handlers deferred (Phase 10) |
| Dependency injection | Central `services` container; `services.state` is the one path to state (flat in Phases 1–2, sliced from Phase 3) |
| State | 9 bounded slices: `world / social / tasks / runtime / goals / team / reminders / death / reactive` |
| ACTIONS wiring | Single build pass + lazy `getActions()` ref (see [§ Assembly rules](#assembly-rules)) |
| Middleware | Pre/post intercept-or-continue lists in `middleware/pipeline.js` |
| Dispatch | One `dispatchAction()` function for both sync `/action/*` and async `/task/*` (see [§ Dispatch](#dispatch)) |
| Mocks | `createMockServices()` in Phase 1; structural parity with real services enforced by test |
| Traceability | `reason=` threaded into `actionHistory` via `dispatchAction` (Phase 7); surfaced in API, not in `dashboard.html` (replaced separately per `docs/dashboard-redesign.md`) |
| Metadata | Defer `action-meta` to Phase 10; http-app keeps hard-coded behavior sets until then |
| Cross-action calls | Migrate `ACTIONS.verb()` → `getActions().verb()` when touching a callsite; no mandatory burn-down gate |

## Assembly rules

These rules are not optional — every phase follows them.

### State shape

| Phases | `services.state` shape | Transition |
|---|---|---|
| 1–2 | Flat `ctx` (today's `createBotState` return) | `createServices` wraps `ctx`. Factories keep working. |
| 3 | Sliced (`state.world.bot`, `state.social.chatLog`, …) | All `ctx.field` reads → `state.<slice>.field`. Phase-1 factory shim deleted. No `services.ctx` alias ever. |
| 4+ | Sliced (stable) | No further shape changes. |

### ACTIONS self-reference

One build, one shared reference. No module receives `ACTIONS` directly.

```js
export function createAllActions(services) {
  const actionsRef = { value: {} };
  const deps = { ...services, getActions: () => actionsRef.value };

  const handlers = {
    ...createInventoryActions(deps),
    ...createBuildingActions(deps),
    // ... remaining modules ...
  };

  actionsRef.value = handlers;
  return handlers;
}
```

1. Cross-action calls use `deps.getActions().verb(body)` — never a captured map.
2. Don't cache `getActions()` at factory time (the ref is empty then).
3. Tests override via `createMockServices({ getActions: () => ({ pickup: async () => ok() }) })`.

### Dispatch

Phase 7 introduces a single dispatch function used by both `/action/<name>` and `/task/<action>`:

```
dispatchAction(services, actionName, body, { mode: 'sync' | 'task' }) → ActionResult
```

Pre/post middleware, `pushAction`, `pushTaskHistoryRecord`, and error handling all live inside `dispatchAction`. Neither HTTP path duplicates this logic.

### Mock parity

`createMockServices(overrides)` structurally matches `createServices()`:

- Same top-level keys (bidirectional `Object.keys` check — real must not have keys mock lacks, and vice versa; this forces mock updates when services grows and prevents stale test-only fields).
- Same field names per state slice.
- Every function-typed field is a no-op stub; `getActions` returns `{}`.
- `deepMerge` replaces leaf values only — does not clobber slice objects on partial override.

Parity test ships in Phase 1 and re-runs after Phase 3 (sliced shape).

---

## Phase gating

Every phase ends with:

1. `cd bot && node --test test/` — new + existing tests pass.
2. `cd tests/functional && pytest -q` — functional suite green.
3. Manual smoke: `./start-companion.sh`, exercise one verb touched by the phase.
4. From Phase 4: `actionRegistry.names()` matches expected set.
5. From Phase 6: `bot/lib/runtime/*` does not import from `bot/lib/server/*`.

Do not start phase N+1 until phase N is fully gated.

---

## Phase 1 — Foundation

**Goal:** Ship contract module, services container, and mock. Purely additive.

**New files:**

- `bot/lib/shared/action-contract.js` — `ok()`, `fail()`, `validate()`.
- `bot/lib/server/services.js` — wraps `ctx` + helpers into `services`. `services.state` is the flat `ctx` for now. Fields: `config`, `state`, `ensureBot`, `resolver`, `fairPlay`, `spatial`, `locations`, `social`, `utils`, `getActions`.
- `bot/lib/server/mock-services.js` — `createMockServices(overrides)` per parity rules above.

**Changes:**

- `bot/server.js` — call `createServices()`, pass `services` to factories. One-line shim per factory (`const ctx = services?.state ?? deps?.ctx ?? deps.ctx`) bridges old/new; removed in Phase 3.

**Tests:**

- `bot/test/foundation.test.js` — contract shapes (`ok`, `fail`, `validate`), `createServices()` top-level keys, mock parity + override merge.

---

## Phase 2 — Pilot migration: `actions/crafting.js`

**Goal:** Prove the contract on one already-tested module.

**Changes:**

- `bot/lib/actions/crafting.js` — factory takes `services` (with shim). Every inline `{ok:false, error:{...}}` → `fail('CODE', ...)`. Every success → `ok(...)`. Accept optional `reason` param, surface in `data._reason`.
- `bot/lib/actions/index.js` — pass `services` to `createCraftingActions`.

**Tests:**

- `bot/test/crafting-contract.test.js` — iterate handlers, force failure paths via mock services, assert `validate()` passes on every return.

**Gate:** all standard gates. Existing `bot/test/crafting.test.js` still passes.

---

## Phase 3 — State slice split

**Goal:** Split flat `ctx` into 9 bounded slices. Mechanical wide diff, no behavior change.

**Changes:**

- `bot/lib/server/state.js` rewritten — `createBotState(config)` returns `{ config, world, social, tasks, runtime, goals, team, reminders, death, reactive }`. Each slice is a small constructor in the same file.
- Every reader updated: `ctx.chatLog` → `state.social.chatLog`, etc.
- `bot/lib/server/services.js` — `services.state` is now the sliced object. Delete factory shim.
- `bot/lib/server/mock-services.js` — returns sliced shape. Re-run parity test.

**Tests:**

- `bot/test/state-slices.test.js` — each slice constructor returns expected fields with correct defaults.

**Gate:** all standard gates. Riskiest mechanical step — functional suite must be green before Phase 4.

---

## Phase 4 — Split `actions/world.js`

**Goal:** 4121 lines → six focused modules.

| New file | Handlers |
|---|---|
| `actions/inventory.js` | `equip`, `unequip`, `toss` |
| `actions/building.js` | `pillar_step`, `place`, `place_fill`, `wall`, `fence`, `path`, `dig_pit`, `level`, `build_stairs` |
| `actions/excavation.js` | `dig_area`, `tunnel`, `stair_down`, `stair_up` |
| `actions/interaction.js` | `interact`, `through`, `close_screen`, `use` |
| `actions/queries.js` | `scout`, `terrain_top`, `find`, `inspect`, `reachable`, `standing`, `is_empty`, `is_filled`, `is_sheltered`, `escape` |
| `actions/lifecycle.js` | `wait`, `chat`, `chat_to`, `whisper`, `surface`, `sleep_bed`, `set_home`, `respawn`, `deathpoint` |

`bucket_fill` / `bucket_empty` move into existing `actions/water.js`. Delete `world.js` after migration.

**File placement rules** (document in `docs/architecture-map.md` when it ships):

1. Domain enum first — match `bot/lib/shared/domains.js`.
2. Capability over CLI category — a verb that *builds* goes in `building.js`.
3. CRUD quartet stays together (P11). Symmetric pairs stay together (P10).
4. If a file passes ~500 LOC, split it.

**Changes:**

- `bot/lib/actions/index.js` — six `create*Actions` imports; single-build assembly per [§ Assembly rules](#assembly-rules).

**Tests:**

- `bot/test/world-split.test.js` — registry name parity + `validate()` on a sample of handlers per module.
- `bot/test/actions-manifest.test.js` — `readdir('bot/lib/actions/')`, find every `.js` file that exports a `create*Actions` function (skip `_`-prefixed files and `index.js` itself), assert each is imported in `index.js`.

---

## Phase 5 — Split `actions/containers.js`

**Goal:** 864 lines → five focused modules.

| New file | Handlers |
|---|---|
| `actions/containers.js` (slim) | `list_container`, `deposit`, `withdraw`, `chest_search` |
| `actions/marks.js` | `mark`, `mark_update`, `marks`, `go_mark`, `unmark` |
| `actions/furnace.js` | `smelt`, `smelt_start`, `furnace_check`, `furnace_take` |
| `actions/team.js` | `team_chat`, `team_status`, `rally`, `report`, `set_team`, `set_fair_play` |
| `actions/reminders.js` | `remind`, `list_reminders`, `unremind` |

Move `smelt` out of `crafting.js` so crafting stays recipe-only.

**Tests:**

- `bot/test/containers-split.test.js` — registry parity + a few `validate()` smoke cases.

---

## Phase 6 — Diagnostics extraction + first middleware

**Goal:** Fix the P8 upward dependency. Extract diagnostics + one pilot guard.

**New files:**

- `bot/lib/server/diagnostics.js` — `buildActionStats` + `classifyIdleReason` moved from `http-app.js`.
- `bot/lib/server/middleware/position-guard.js` — F51.2 logic extracted from `http-app.js`.

**Changes:**

- `bot/lib/runtime/observation.js` — import from `diagnostics.js` instead of `http-app.js`.
- `bot/lib/server/http-app.js` — call `position-guard.check()` in place of inlined block.

**Tests:**

- `bot/test/diagnostics.test.js` — `buildActionStats` aggregation, `classifyIdleReason` cases.
- `bot/test/middleware/position-guard.test.js` — intercept/pass-through cases (verb set, decay, distance).

---

## Phase 7 — Remaining middleware + `dispatchAction`

**Goal:** Extract all inlined guards; consolidate sync/task dispatch into one function.

**New files:**

- `bot/lib/server/middleware/place-repeat-guard.js` (F53.2)
- `bot/lib/server/middleware/chat-banner.js` (F53.5)
- `bot/lib/server/middleware/announce.js` (F53.6)
- `bot/lib/server/middleware/task-lifecycle.js` — implements `dispatchAction` per [§ Dispatch](#dispatch).
- `bot/lib/server/middleware/pipeline.js` — ordered pre/post lists with rationale comments:

```js
export const preMiddleware = [
  positionGuard,       // F51.2
  placeRepeatGuard,    // F53.2
  announceStart,       // F53.6
];
export const postMiddleware = [
  placeOutcomeRecorder, // F53.2
  announceComplete,     // F53.6
  chatBanner,           // F53.5
];
```

**Changes:**

- `bot/lib/server/http-app.js` — both `/action/*` and `/task/*` call `dispatchAction`. Wire `reason` into `actionHistory` entries inside `dispatchAction` (replaces the former Phase 9 scope — cheap to thread while consolidating dispatch). Note: `announce.js` and `dispatchAction` both read `body.reason` independently — announce fires a chat message, dispatch writes the history record. No shared state between them.
- Dev-mode validator: `dispatchAction` runs `validate(result)` and logs a warning when `HERMES_VALIDATE=1`.

**Note:** `reason` in `actionHistory` is available via the bot API (`/observe`) immediately after this phase. The old `bot/dashboard.html` is being replaced by a standalone aggregator (see `docs/dashboard-redesign.md`), so we do not touch `dashboard.html` here. The new dashboard can render `reason` from `/observe` data when it ships.

**Tests:**

- One test file per middleware: `place-repeat-guard.test.js`, `chat-banner.test.js`, `announce.test.js`, `task-lifecycle.test.js`.

---

## Phase 8 (deferred) — `defineAction` self-describing handlers

Wrap every handler in `defineAction({ name, params, meta, examples, run })`. Collapse hard-coded behavior sets into handler-side metadata. Registry auto-builds from imports. Param validation runs in the dispatcher. `scripts/gen-mc-cheatsheet.mjs` may pivot to handler metadata as canonical source.

Ship when behavior-flag duplication becomes painful or when adding new actions frequently enough to justify the wrapper.

**Tests:** `bot/test/registry-conformance.test.js` — every action has `description`, `params`, ≥1 example, valid `meta`.

---

## Phase 9 (deferred) — `mining.js` collect/dig decomposition

`collect` (~750L) and `dig` (~250L) become coordinators over named helpers in `_mining-helpers.js`. Helpers: `findCollectTargets`, `pathfindToTargetWithFallback`, `digBlockWithRecovery`, `consumePickupCredit`. Each gets direct unit tests; `collect`/`dig` shrink to ~100–150L.

Lower priority — the file is isolated to one concern. Do it when mining reliability needs investment.

---

## Phase 10 — Convention hardening

**Sequencing:** ships right after Phase 7. Phases 8 and 9 are deferred indefinitely — they are numbered for reference, not for ordering. Start Phase 10 as soon as Phase 7 is gated.

**Goal:** Turn refactor choices into checked conventions so the codebase stays clean.

**Deliverables:**

- `docs/architecture-map.md` (~1 page): layers (P8 recap), domain → file → handlers table, "how to add an action" checklist, state-slice ownership summary, pointer to `middleware/pipeline.js`.
- Append **P16** (module size budget ≤500 LOC) and **P20** (mock key parity) to `docs/reference/engineering-patterns.md` (same format as P1–P14). Wire both into `scripts/check-conventions.mjs`. Add P15/P17/P18/P19 when pain justifies them.
- `http-app.js` gets a `// @size-exempt: thin GET handlers` comment if it remains >500 LOC after Phase 7 (expected ~400–500L of short GET routes + dispatcher). Split into route modules only if editing the file stays painful — no dedicated phase for it.
- Dev-mode validator (`HERMES_VALIDATE=1`) promoted to default-on in test runner.
- Move `docs/refactor-plan.md` to `docs/archive/` and replace with a stub pointing to `architecture-map.md`.

**Gate:** standard gates + clean `node scripts/check-conventions.mjs`.

---

## Critical files (by phase)

| Phase | Files touched |
|---|---|
| 1 | `shared/action-contract.js` (new), `server/services.js` (new), `server/mock-services.js` (new), `server.js` (wire), `test/foundation.test.js` (new) |
| 2 | `actions/crafting.js`, `actions/index.js`, `test/crafting-contract.test.js` (new) |
| 3 | `server/state.js` (rewrite), all `actions/*.js` + `runtime/*.js` + `server/http-app.js` (mechanical `ctx.` → `state.<slice>.`) |
| 4 | `actions/{inventory,building,excavation,interaction,queries,lifecycle}.js` (new), `actions/world.js` (deleted), `actions/water.js` (absorbs bucket_*), `actions/index.js`, `test/world-split.test.js` + `test/actions-manifest.test.js` (new) |
| 5 | `actions/{marks,furnace,team,reminders}.js` (new), `actions/containers.js` (slimmed), `actions/crafting.js` (smelt removed), `actions/index.js`, `test/containers-split.test.js` (new) |
| 6 | `server/diagnostics.js` (new), `server/middleware/position-guard.js` (new), `server/http-app.js`, `runtime/observation.js` |
| 7 | `server/middleware/{place-repeat-guard,chat-banner,announce,task-lifecycle,pipeline}.js` (new), `server/http-app.js` |
| 8 | `actions/**/*.js` (defineAction wrappers), optional cheatsheet pivot |
| 9 | `actions/mining.js`, `actions/_mining-helpers.js` (new) |
| 10 (after 7) | `docs/architecture-map.md` (new), `docs/reference/engineering-patterns.md` (P16+P20 appended), `scripts/check-conventions.mjs` (P16+P20 checks), `docs/archive/refactor-plan-2026.md` |

(All paths relative to `bot/lib/` unless noted.)

## Reused utilities (do not duplicate)

- `actions/_helpers.js` — `raceWithTimeout`, `withWallclockCap`, `ensureWithinReach`, `pathfindWithProgressWatchdog`, `ACTION_CAPS_MS`
- `actions/_nav-helpers.js` — `isStandableCell`, `standabilityReason`, `findClosestStandable`, `standingState`
- `runtime/dig-tools.js` — `equipForDig`, `PROTECTED_DIG_BLOCKS`, `detectDigHazards`, `suggestedToolForBlock`
- `server/action-registry.js` — handler lookup for dispatch
- `shared/resolver.js` — `resolveInventoryItem`, `resolveCraftTarget`, `resolveBlockQuery`
- `shared/chat.js` — routing helpers
- `shared/recipe-ingredients.js` — `bestRecipeForInventory`, `buildCraftPlanFromRecipes`

## What this plan does NOT do

- **No new actions or endpoints.** Surface stays identical.
- **No backwards-compat shims.** Old files deleted in the same commit (P12). Exception: Phase 1 factory shim, removed in Phase 3.
- **No `reactive.js` or `manager.js` decomposition.** They're coherent single-purpose files.
- **No CLAUDE.md / cheatsheet churn** until Phase 8 metadata. `docs/architecture-map.md` (Phase 10) is allowed — it's the refactor map, not agent prompt text.
- **No `bot/dashboard.html` changes.** The old dashboard is being replaced by a standalone aggregator (`docs/dashboard-redesign.md`). This refactor exposes `reason` in the API; the new dashboard picks it up from there.
- **No TypeScript migration.** JSDoc + contracts + slice constructors give shape guarantees without build cost.
- **No auto-discovery of action modules.** Explicit imports + `actions-manifest.test.js` (Phase 4).
- **No per-handler files.** Domain modules with 3–10 handlers stay one file; ~500 LOC budget triggers splits.
- **No classes replacing factories.** `createXxxActions(services) → { handler1, handler2 }` stays the convention.

## Deferred phases (post-completion)

These were left out of the March 2026 execution (Phases 1–7 + 10). Revisit if the triggers return:

- **Phase 8** — `defineAction` self-describing handlers. Would collapse the six parallel action-name behavior lists (`LONG_VERBS`, `POSITION_DEPENDENT_VERBS`, `STUCK_MOVEMENT_ACTIONS`, `SYNC_STUCK_ACTIONS`, `noBanner`, the CLI registry) into handler-side metadata. Trigger: behavior-flag duplication becomes painful or actions are being added frequently enough to justify the wrapper.

- **Phase 9** — `mining.js` collect/dig decomposition. `collect` (~750L) and `dig` (~250L) become coordinators over named helpers. Trigger: mining reliability needs investment, or the `@size-exempt` annotation on `mining.js` stops being defensible.

Current layout reference: [`docs/reference/bot-codebase-map.md`](../architecture.md).
