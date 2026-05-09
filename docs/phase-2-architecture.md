# Phase 2 — Two-Bot Co-Evolution Loop

> **Status:** executable plan, narrowed from earlier draft per code-review feedback.
> **Branch:** `experiment/hermes-agents`. No backwards-compat constraint.
> **Predecessor docs:** `docs/experiments/1.1-1.4-*.md`, `docs/experiments/phase-1-summary.md`.

## 1. Context & narrowed objective

Phase 1 validated the core architecture (kanban-driven mission spawn, per-character profiles, comments-as-IPC, `worker_context` injection) but also surfaced that **the action layer is the bottleneck**. Phase 2 takes that seriously.

The **single objective** is: *prove the co-evolution loop with two bots and human-as-steward, on a regression-grade test suite.* Steward automation, marks sync, logistics planning, multi-bot expansion, dashboard — all become **products of** that loop, not part of the executable plan. They live in the appendix.

The plan changed substantially from earlier drafts based on review feedback:
- Scope narrowed to two bots (gatherer + flint) and L0–L4 capabilities only
- Steward profile + body deferred entirely; human plays the steward role
- Marks system simplified to a single file + coords inline in card bodies (no distributed sync)
- Logistics planner deferred; chest tracking moves from prose-parsing to structured `kanban_complete.metadata`
- Action layer promoted from "side quest" to **gate** — every primitive must meet a response-shape contract before higher tests can pass
- Capability tests get a strict YAML schema; tests are runnable specifications, not prose
- Multiverse + flat test world + reusable fixture files make every test deterministic and repeatable

## 2. Non-goals (Phase 2)

These are explicitly out of scope and live in the Phase 3+ appendix:

- ❌ Steward profile + body (human plays the role)
- ❌ Marks sync between bot caches (single canonical file; coords inline in cards)
- ❌ Chest inventory in canonical (use card metadata)
- ❌ Logistics planner / supply-chain analysis / distance computation
- ❌ Cast expansion beyond gatherer + flint
- ❌ Custom dashboard implementation (only the event/feed schema is specified, for later)
- ❌ Capability levels L5–L8 (build, farm, combat, full logistics)
- ❌ `/api-spec` self-describing endpoint, anti-revisit pathfinder memory, custom metric registration in goal engine — all Phase 3

## 3. Roles

| Assignee | Body | Function | Model |
|----------|------|----------|-------|
| `gatherer` | port 3001 — mobile | Wood, food, plants, scouting; L1–L4 worker | DeepSeek V4 Flash |
| `flint` | port 3002 — mobile | Mining, deep ops; L4 specialist | DeepSeek V4 Flash |
| `human` | (none — pulls cards manually) | Steward role + bug fixes via Claude Code | (me) |

The `human` assignee is a first-class kanban concept: cards assigned to `human` are **never auto-dispatched**. They sit in `ready` until I pull them.

I play **two distinct sub-roles** as `human`:
1. **Steward role** — write capability_test cards, triage failures into bug_reports, run verify_fix cycles, maintain the capability matrix
2. **Coding role** — pull `[BUG]` / `[FEAT]` / `[SKILL]` cards from the board, fix with Claude Code on the experiment branch, mark done with commit SHA

The protocol below in §11 specifies exactly what each sub-role does, with formats precise enough that the steward agent can later be programmed to execute them.

## 4. The co-evolution loop

```
┌──────────────────────────────────────────────────────────────┐
│ 1. Pick the next L<N>.<n> in capability matrix (status=pending)│
│ 2. Look up its fixture file → run `prep` rcon commands         │
│ 3. Create capability_test card per the schema (§7)             │
│ 4. Dispatch via hermes kanban; worker runs                     │
│ 5. Worker outputs: kanban_complete with PASS/FAIL + metadata   │
│ 6. Outcome:                                                    │
│    PASS → matrix.consecutive_pass++; if ≥2 mark green          │
│    FAIL → triage:                                              │
│      - action contract violation? → bug_report (assignee=human)│
│      - skill behavior issue?      → skill_revision (human)     │
│      - missing primitive?          → feature_request (human)   │
│      - test/fixture defect?        → fix the test, re-run      │
│ 7. Pull bug card → fix with Claude Code → commit              │
│ 8. Mark bug card done with `summary: "fixed in <SHA>"`        │
│ 9. verify_fix card auto-spawns (or human creates) → re-runs   │
│    the original test                                           │
│ 10. PASS on re-run → matrix updated, both cards archived       │
│     FAIL on re-run → re-open bug or new bug with diagnosis     │
└──────────────────────────────────────────────────────────────┘
```

The kanban board does double duty: gameplay coord (worker cards) and dev backlog (human cards). Dispatcher patch (§14) ensures these don't cross.

## 5. Board protocol

### Card types

| Type | Title prefix | Default assignee | Dispatchable | Body schema |
|------|-------------|------------------|--------------|-------------|
| `capability_test` | `[L<N>.<n>] <capability>` | character (gatherer/flint) | yes | §7 |
| `bug_report` | `[BUG][L<N>.<n>] <symptom>` | `human` | **no** | §11 |
| `feature_request` | `[FEAT] <feature>` | `human` | **no** | §11 |
| `skill_revision` | `[SKILL] <skill_name>: <issue>` | `human` | **no** | §11 |
| `verify_fix` | `[VERIFY][L<N>.<n>] re-run <test_id>` | character | yes | §11 |

### Status transitions

Hermes Kanban built-in: `triage → todo → ready → running → done | blocked | timed_out`.

Phase 2 conventions:
- Capability tests skip `triage` (created directly in `ready` since they have full schemas at create time)
- Bug/feature/skill cards skip `triage` too (human-authored, structured)
- `verify_fix` cards depend_on the bug they verify; auto-promote when bug is `done`

### Dispatchability rules

The dispatcher must be patched to:
1. **Skip cards where `assignee == "human"`** — they stay in `ready` indefinitely
2. **Auto-promote `verify_fix`** when its parent `bug_report` is marked `done` AND parent's `summary` starts with `"fixed in "` (commit SHA marker)

### Retries and timeouts

| Card type | `--max-runtime` | `--max-retries` | Notes |
|-----------|----------------|-----------------|-------|
| capability_test | per-test (5 min default) | 1 | One transient retry; outcome (PASS/FAIL) is final |
| verify_fix | per-test | 1 | Same as test |
| bug_report | n/a | n/a | Human-managed |
| feature_request | n/a | n/a | Human-managed |

### Idempotency keys

- `capability_test`: `{level}_{capability}_{sprint}` — re-running L1.2 in sprint 1 vs sprint 2 are different cards
- `bug_report`: `{level}_{symptom_kebab}` — same symptom on same test dedupes; different symptom creates new
- `verify_fix`: `{bug_id}_verify` — exactly one verify per bug
- `feature_request` / `skill_revision`: `{feature_kebab}` / `{skill}_{issue_kebab}`

### Commit-SHA linkage

Bug-card `kanban_complete` summary string MUST follow:
```
fixed in <SHA>: <one-line description of fix>
```

The verify_fix card body references both bug_id AND `fix_commit`. The verify worker runs the original test's action_sequence and checks the success_predicate. On PASS, both cards close; on FAIL, the bug re-opens with diagnosis from the verify worker.

## 6. Capability matrix (L0–L4)

L0–L4 only. L5+ in Phase 3 appendix.

| Level | Theme | Test count | Worker(s) |
|-------|-------|-----------|-----------|
| L0 | Connectivity & observation | 6 | both |
| L1 | Movement | 10 | both |
| L2 | Inventory & equip | 8 | both |
| L3 | Basic gather + craft | 14 | gatherer (mostly) |
| L4 | Mining | 15 | flint (mostly) |

A level becomes `green` when **all** its tests have `consecutive_pass >= 2` AND there are no open `priority: blocking` bug_reports linked to its tests.

## 7. Capability test contract (schema)

Every capability_test card body MUST be valid YAML matching:

```yaml
id: L<N>.<n>_<short_name>
level: L<N>
capability: <dotted.path>            # e.g. movement.goto_near
bot: gatherer | flint
fixture: <relative-path>             # e.g. L1/L1.2_goto_near.yaml
preconditions:                       # human-readable summary; fixture file is source of truth
  bot_position: "..."
  inventory: "..."
  world_setup: "..."
  required_marks: [@base, @target]
action_sequence:                     # list of mc commands the worker MUST run, in order
  - mc tp_self @base
  - mc goto_near 100 70 -100 3
success_predicate:                   # checked after action_sequence; structured assertions
  - { kind: bot_position_within, coords: [100, 70, -100], radius: 3 }
  - { kind: no_action_errors }
  - { kind: inventory_contains, item: dirt, count: ">=4" }
  - { kind: response_field, field: "data.mined_count", op: "==", value: 4 }
timeout: 30s
retry_policy: { transient: 1, outcome: 0 }
cleanup:                             # post-test rcon commands; also defined in fixture
  - mc tp_self @base
evidence_required:                   # what worker MUST include in kanban_complete
  - mc command log (full stdout/stderr per call)
  - final mc status output
  - PASS|FAIL with one-line diagnosis
exercises_phase1_bug: null | <bug_description>   # set if test deliberately exercises a known bug
```

### Worker output (`kanban_complete`)

```yaml
result: PASS | FAIL | INCONCLUSIVE
summary: "one-line diagnosis"
metadata:
  test_id: L1.2_goto_near
  predicate_results:
    - { name: bot_position_within, status: pass, observed: [100.4, 70, -99.8] }
    - { name: no_action_errors, status: pass }
  evidence:
    command_log: [...]
    final_status: {...}
    duration_seconds: 12.4
  inventory_delta: { ... }            # if test involved inventory changes
```

## 8. Primitive action reliability contract

This is the **gate**: no L1+ test can pass until the action it depends on meets this contract. Sprint 1 fixes them.

### Required response shape (all `mc <verb>` actions)

```yaml
{
  "ok": <bool>,
  "command": "<verb>",
  "data": { <action-specific structured fields> },
  "error": {                            # only when ok=false
    "code": "<UPPERCASE_ENUM>",
    "message": "<human readable>",
    "observed_state": { ... },
    "next_action_hint": "<what to try>",
    "retry_safe": <bool>
  }
}
```

### Per-primitive contracts (L0–L4 hot path)

#### `mc dig X Y Z`
- `ok=true` only if a block was actually broken at the target coord
- **Does NOT auto-pickup**: the dropped item entity stays at the target coord. Tests or sequences that need the item in inventory must follow up with `mc pickup` (or `mc collect` which dig+pickups). Verified in L3.1 fixture: `mc dig 1 65 0` returned ok=true with the dirt block removed but inventory unchanged.
- `ok=false` for these cases, with `error.code` in:
  - `NO_BLOCK_AT_COORD` — target is air/cave_air; `observed_state.block_at_target == "air"`
  - `OUT_OF_RANGE` — distance > 4.5 and pathfind unsuccessful
  - `TOOL_INADEQUATE` — guardSlowDigEstimate fired; `next_action_hint` names the right tool
  - `PROTECTED_BLOCK` — building protection (crafting_table, chest, etc.)
  - `INTERRUPTED` — task cancelled or bot died mid-dig
- `data` includes: `{ block_name, dropped_items: [{name, count, position}], position_after }`

#### `mc collect <name> <count>`
- **Phase 1 bug to fix**: `ok=true` with `mined_count == 0` is forbidden by this contract
- `ok=true` only if `mined_count > 0`
- `ok=false` cases:
  - `NO_VISIBLE_BLOCKS` — no blocks of `name` found within fair-play range
  - `ALL_PATHFIND_FAILED` — found candidates but couldn't reach any
  - `ALL_DIG_FAILED` — found and reached but every dig errored (timeout, tool, interrupt)
  - `MIXED_PARTIAL` — collected `mined_count > 0` but `< count` AND every remaining attempt failed; this is `ok=true` with a `partial_failure` flag, not `ok=false`
- `data` includes: `{ mined_count, requested_count, started_inventory, ended_inventory, dropped_items_collected }`

#### `mc place <block> X Y Z`
- `ok=true` only if block is now at target coord
- `ok=false` cases:
  - `NO_SOLID_NEIGHBOR` — all 6 face neighbors are air/liquid; `observed_state.neighbors` enumerates them
  - `TARGET_OCCUPIED` — block already at coord; `observed_state.existing_block`
  - `INVENTORY_MISSING` — block not in inventory
  - `OUT_OF_RANGE` — distance > 4.5 and pathfind unsuccessful
- `data` includes: `{ placed_block, face_used, position_after }`

#### `mc craft <item> [count]`
- `ok=true` only if `crafted_count >= 1`
- `ok=false` cases:
  - `NO_RECIPE` — recipesAll returned empty
  - `MISSING_INGREDIENTS` — `error.observed_state.missing` lists shortfall
  - `TABLE_REQUIRED` — recipe needs crafting_table; `next_action_hint` includes nearest table mark/coord if known
  - `TABLE_OUT_OF_RANGE` — table is just outside 4-block search; `observed_state.nearest_table` includes its coords
- `data` includes: `{ crafted_count, recipe_used, ingredients_consumed }`

#### `mc chest @mark` (or `X Y Z`)
- `ok=true` only if a chest container is at the location and was successfully opened
- `ok=false` cases:
  - `NO_CONTAINER` — block at target is not a chest/barrel/shulker; `observed_state.block_at_target`
  - `NO_MARK` — `@mark` doesn't exist in marks file
  - `OUT_OF_RANGE` — distance > 4.5 and pathfind unsuccessful
- `data` includes: `{ container_kind, slots: [...], item_counts: {item_name: count, ...} }` for read; deposit/withdraw return `{ inventory_delta: {...}, container_inventory_after: {...} }`

### Sprint 1 must ship these contracts

The bot HTTP server's response shape changes are non-breaking (additive fields, ok=false where it was ok=true with empty data). Fixing each primitive lives in `bot/lib/actions/*` per the explore-agent's file:line refs.

## 9. Minimal marks MVP

For Phase 2:

- **One file**: `data/marks/canonical.yaml`. I edit it manually. No per-bot caches, no diff API.
- **Card body includes resolved coordinates inline**: a card might reference `@quarry-east` in its prose, but the `action_sequence` always uses literal coords (`mc dig 180 50 0`). The mark name is for human readability; the worker uses the coords.
- **Workers can use `mc go_mark`** if the bot's local marks file has been seeded with the catalog (one-time copy at startup). No runtime sync.

This avoids building a distributed marks system before agents prove they can use curated coordinates reliably. Distributed sync moves to Phase 3.

## 10. Chest accounting

Workers report chest deltas via **structured `kanban_complete.metadata`**, not parsed prose:

```yaml
result: PASS
summary: "deposited 32 cobblestone in stone_chest"
metadata:
  test_id: L4.14_chest_deposit
  predicate_results: [...]
  inventory_delta:
    chest: stone_chest
    chest_coords: [2, 79, -1]
    item: cobblestone
    delta: +32
    chest_count_before: 47
    chest_count_after: 79
    bot_inventory_before: 32
    bot_inventory_after: 0
```

The `mc chest @mark` action returns counts; the worker copies them into `metadata`. Comments stay narrative for humans.

For Phase 2 the canonical marks file does NOT track chest inventory — it stays a coords/labels file. Inventory tracking via accumulated card metadata moves to Phase 3 logistics planner.

## 11. Human-as-steward protocol

This is the protocol I follow. **It IS the spec** — the future steward agent will be designed to execute this mechanically.

### File-system artifacts I maintain

| File | Format | What it holds |
|------|--------|---------------|
| `data/marks/canonical.yaml` | YAML | Single source of truth for marks |
| `data/capability-matrix.yaml` | YAML | One row per `L<N>.<n>` with current status |
| `data/test-fixtures/<level>/<test_id>.yaml` | YAML | World prep + cleanup rcon commands per test |
| `data/sprint-state.yaml` | YAML | Active sprint, active level, current focus |

### Card title formats (strict; see §5)

### Card body schemas (strict)

**capability_test body:** §7 schema verbatim.

**bug_report body:**
```yaml
test_card_id: t_xxxx                    # the failing test card
level: L1.2
capability: movement.goto_near
priority: blocking | non-blocking       # blocking = level can't be green while open
symptom: "one-line description of the failure"
expected: "what the contract says should happen"
observed: "what the worker actually got"
repro:
  - "command sequence"
  - "log excerpt"
diagnosis: "root cause hypothesis"
suggested_fix:
  area: "bot/lib/actions/movement.js:23-36"
  approach: "..."
exercises_contract: "mc goto_near"      # which action contract is being violated
```

**feature_request body:**
```yaml
trigger: "what test or workflow needs this"
spec:
  command: "mc <new_verb>"
  args: { ... }
  response_shape: { ... }
  failure_modes: [ ... ]
priority: blocking | non-blocking
```

**skill_revision body:**
```yaml
skill: <skill_name>
trigger: "what behavior was off; quote agent's reasoning"
suggested_rewrite: "..."
priority: blocking | non-blocking
```

**verify_fix body:**
```yaml
bug_card_id: t_yyyy
test_card_id: t_xxxx
fix_commit: <SHA>
verify_predicate: "re-run test_card_id action_sequence; check success_predicate"
on_pass: "mark test green; archive both bug and verify"
on_fail: "post comment with new diagnosis; reopen bug"
```

### Per-session checklist

1. **Survey** — `hermes kanban list --json`
2. **Triage** — for each FAILed capability_test without a linked bug:
   - Diagnose: action-contract violation? skill issue? card-spec defect?
   - Create the appropriate card type with the proper body schema
   - Link parent: bug card depends_on the failed test
3. **Sync matrix** — update `capability-matrix.yaml` from recent outcomes
4. **Pick next test** — find next pending L<N>.<n> with no blocking bug
5. **Prep fixture** — read fixture YAML; run `prep:` rcon commands via SSH→docker→rcon-cli
6. **Create test card** — `hermes kanban create --assignee <bot> --max-runtime <T>` with strict title + YAML body
7. **Dispatch** — `hermes kanban dispatch`
8. **Watch** — `hermes kanban tail` or check session log
9. **Evaluate** — read worker's metadata; mark PASS/FAIL in matrix
10. **Cleanup** — run `cleanup:` rcon commands from fixture
11. **Loop** to step 2 (next failure to triage) or step 4 (next test)

### Bug-fix sub-protocol

1. Pick a `[BUG]` card with `priority: blocking` for the active level
2. Branch: stay on `experiment/hermes-agents`
3. With Claude Code:
   - Read bug card body + linked test card body
   - Read the file:line refs from `suggested_fix.area`
   - Implement fix per the action contract (§8)
   - Commit with message: `fix(<area>): <symptom>; closes <bug_id>`
4. Mark bug card `done` with summary: `fixed in <SHA>: <one-line description>`
5. The dispatcher patch auto-spawns the verify_fix card (or I create it manually if patch hasn't shipped yet)
6. On verify PASS → matrix updated, both cards archived
7. On verify FAIL → re-open bug or create new bug with updated diagnosis

### Capability matrix format

```yaml
# data/capability-matrix.yaml
sprint: 1
levels:
  L0:
    status: green
    last_run: 2026-05-10
    tests:
      L0.1_health_connected:    { status: pass, last_run: 2026-05-10, consecutive_pass: 2 }
      L0.2_health_disconnected: { status: pass, last_run: 2026-05-10, consecutive_pass: 2 }
      L0.3_observe_payload:     { status: pass, last_run: 2026-05-10, consecutive_pass: 2 }
      # ...
  L1:
    status: in-progress
    tests:
      L1.1_goto_simple:    { status: pass, last_run: 2026-05-11, consecutive_pass: 2 }
      L1.2_goto_near:      { status: fail, blocking_bug: t_bug123, consecutive_pass: 0, last_failure: "no_action_errors predicate failed: 1 error in command_log" }
      L1.3_goto_timeout:   { status: pending }
      # ...
```

### Sprint exit gate

When all levels through `L<N>` are `green`:
1. `git tag phase2-sprint<N>-passed`
2. Update `sprint-state.yaml` to next sprint
3. Move on

## 12. Test world & fixtures (Multiverse)

This section is a summary. Source of truth is `docs/test-world.md`, which captures the operational details and the gotchas surfaced during prep.

### World setup (already done)

Multiverse-Core 5.6.2 is installed. The test world `landfolk-test` is a flat NORMAL world with `--no-structures`, PEACEFUL, daylight/mob/weather cycles off, keep-inventory on, and an 11×11 stone spawn platform at Y=64 centered on (0, 64, 0). Spawn chunk is forceloaded.

Production world is `world` (the Paper default). `world_nether` and `world_the_end` are unused for Phase 2. A pre-existing `testflat` world is also unused.

### Fixture file schema

`data/test-fixtures/<level>/<test_id>.yaml`:

```yaml
world: landfolk-test
prep:
  # Clear test region above platform
  - "execute in landfolk-test run fill -5 65 -5 5 80 5 minecraft:air"
  # Build the test scenario from scratch
  - "execute in landfolk-test run setblock 1 65 0 minecraft:dirt"
  # Bot starting state — tp at Y=72 to let chunk load before bot reaches the platform
  - "mvtp Flint landfolk-test"
  - "execute in landfolk-test run tp Flint 0 72 0"
  - "clear Flint"
  - "effect give Flint minecraft:saturation 1 10"
  - "effect give Flint minecraft:instant_health 1 10 true"
  - "effect give Flint minecraft:slow_falling 5 0 true"
cleanup:
  - "execute in landfolk-test run fill -5 65 -5 5 80 5 minecraft:air"
  - "execute in landfolk-test run setblock 1 65 0 minecraft:air"
  - "mvtp Flint world"
  - "execute in landfolk-test run kill @e[type=item,distance=..32]"
```

### Fixture conventions

- **Region partitioning by capability level** (planned): L0 at (0, 65, 0); L1 at (50, 65, 0); L2 at (100, 65, 0); L3 at (150, 65, 0); L4 at (200, 65, 0) with deep digging area below. ~128 vertical blocks of stone available below Y=64 down to bedrock at Y=-64.
- **Idempotent prep**: every `prep` block starts with a `fill ... air` to clear prior state.
- **Inventory does NOT auto-clear across worlds** — every fixture's prep includes `clear <bot>`.
- **Cross-world tp gotcha**: bots must tp at Y=72 (above platform) with `slow_falling` effect. Without this, the bot can phase through unloaded-chunk "air" that's actually solid stone and suffocate (~17s to die). Forceload on the spawn chunk is the other half of the fix.
- **Production world untouched**: tests only modify `landfolk-test`. Bots return via `mvtp <bot> world` after cleanup.
- **Items cleanup**: `execute in landfolk-test run kill @e[type=item,distance=..32]` after each test prevents item-drop pollution.

### Periodic full reset

`scripts/reset-test-world.sh` (TODO): `/mv delete landfolk-test --force && /mv create landfolk-test NORMAL --world-type FLAT --no-structures` then re-run the difficulty/gamerule/spawn/forceload sequence from `docs/test-world.md`. Run weekly or on-demand if fixtures drift.

### Helper script for the human-as-steward

`scripts/run-fixture.sh prep|cleanup|both <fixture.yaml>` reads the YAML and runs prep/cleanup via ssh→docker→rcon. The `-n` flag on ssh inside the loop is load-bearing — without it ssh consumes the heredoc and only the first command runs.

## 13. Event/feed schema (for future dashboard)

Phase 2 doesn't build a dashboard, but specifies the events that would feed one so we don't paint ourselves into a corner:

| Event | Source | Fields |
|-------|--------|--------|
| card.created | kanban DB | id, type, level, assignee, created_at |
| card.claimed | dispatcher | id, run_id, profile, claimed_at |
| card.completed | worker | id, run_id, result, summary, metadata, completed_at |
| card.blocked | worker or human | id, reason, blocked_at |
| card.commented | any | id, author, body, created_at |
| bot.health | bot http /health | profile, connected, position, hp, food, holding, ts |
| capability.matrix.updated | human-as-steward | level, test_id, status, consecutive_pass, ts |
| action.failure | bot http (action contract) | profile, command, error.code, error.message, ts |
| marks.updated | manual edit + git diff | mark_name, old, new, ts |
| inventory_delta | card.completed.metadata | (parsed from kanban DB) |

For Phase 2: emit nothing; just don't put data anywhere it can't be queried later. All listed sources are already queryable from kanban DB + bot APIs + git log.

## 14. Refactor plan (Sprint 1 scope)

All on `experiment/hermes-agents`:

### Action contracts (gating)
- `mc collect` (`bot/lib/actions/mining.js:8-229`) — enforce `ok=false` on `mined_count==0`; return `data.mined_count`, `data.requested_count`; map error paths to enum codes
- `mc dig` (`bot/lib/actions/mining.js:231-248`) — error code enum (NO_BLOCK_AT_COORD, OUT_OF_RANGE, TOOL_INADEQUATE, PROTECTED_BLOCK, INTERRUPTED); `data.dropped_items`; `data.position_after`
- `mc place` (`bot/lib/actions/world.js:281-328`) — error code enum (NO_SOLID_NEIGHBOR, TARGET_OCCUPIED, INVENTORY_MISSING, OUT_OF_RANGE); `error.observed_state.neighbors`
- `mc craft` (`bot/lib/actions/crafting.js:7-97`) — error code enum (NO_RECIPE, MISSING_INGREDIENTS, TABLE_REQUIRED, TABLE_OUT_OF_RANGE); `data.crafted_count`, `data.ingredients_consumed`
- `mc chest` — error code enum (NO_CONTAINER, NO_MARK, OUT_OF_RANGE); `data.container_kind`, `data.item_counts`

### Dispatcher patch (gating)
- Skip cards where `assignee == "human"` — never spawn worker
- On `bug_report` with status=`done` AND `summary` matching `/^fixed in [a-f0-9]{7,40}/`, auto-create the dependent `verify_fix` card

### Already done in Phase 1 (1.4)
- `bin/mc` symlink resolution fix
- Per-profile `terminal.env_passthrough: [MC_API_URL, MC_USERNAME]`

### Sprint 0 deliverables (infrastructure, not gating)
- `scripts/setup-landfolk-profiles.sh` — creates `gatherer` + `flint` profiles cleanly
- `scripts/landfolk-bodies-only.sh` — launches 2 Mineflayer bodies
- `scripts/run-fixture.sh` — runs fixture prep/cleanup
- `data/marks/canonical.yaml` — initial 3-mark seed: `@base`, `@test_origin`, `@spawn_landfolk`
- `data/capability-matrix.yaml` — empty matrix scaffold for L0–L4
- `data/test-fixtures/L0/L0.1_health_connected.yaml` — first fixture (smoke test)

## 15. Sprints 0–4 (capability-driven)

### Sprint 0 — Bootstrap (1 session)

**Goal:** Two-bot setup running, dispatcher patched for `human` assignee, first capability_test card runs end-to-end through the full loop (prep → dispatch → worker → metadata → matrix).

**Tasks:**
1. Server: confirm Multiverse, create `landfolk-test` flat world per §12
2. `scripts/setup-landfolk-profiles.sh` (gatherer + flint)
3. `scripts/landfolk-bodies-only.sh` launches 2 bodies on ports 3001/3002
4. Dispatcher patch (skip `human`, auto-spawn verify_fix)
5. Bootstrap files: marks YAML, matrix YAML, fixture YAML for L0.1
6. `scripts/run-fixture.sh` working
7. Smoke-run L0.1 capability_test card end-to-end

**Exit gate:**
- L0.1 (`health_connected`) test passes
- One synthetic bug card filed and verified to demonstrate the verify_fix loop

### Sprint 1 — L0 + Action contracts (1–2 sessions)

**Goal:** L0 green; primitive action contracts shipped for `mc dig`, `mc collect`, `mc place`, `mc craft`, `mc chest`.

**Action contracts ship first** because L1+ tests can't pass cleanly without them. Most of these are bug fixes per §14.

**L0 capability tests** (6, all use the same simple fixture):

| Test ID | What it checks |
|---------|---------------|
| L0.1_health_connected | `/health` returns connected=true with position; move_rate calculated after motion |
| L0.2_health_disconnected | bot offline (kill -9 the body) → `/health` returns connected=false |
| L0.3_observe_payload | `/observe` payload contains all required fields per the explore agent's spec |
| L0.4_observe_action_loop | inject 3 identical failed actions → observe shows `action_loop` warning |
| L0.5_marks_list_empty | empty marks file → `/marks` returns empty array |
| L0.6_marks_list_with_distance | seeded marks file → `/marks` returns entries with `distance_m` |

Worker side: each test is a tiny script (just `mc status`, `mc nearby`, etc.) — minimal LLM cost.

**Exit gate:**
- L0 all green
- All 5 primitive action contracts implemented; no `priority: blocking` bugs open
- One worked example of L1 test running cleanly (smoke check that contracts don't break L1+)

### Sprint 2 — L1 (movement) (1–2 sessions)

**Goal:** L1 green for both bots.

**Capability tests (10):**

| Test ID | What it deliberately exercises |
|---------|-------------------------------|
| L1.1_goto_simple | short path on flat ground |
| L1.2_goto_near_radius | radius arg honored |
| L1.3_goto_timeout | distant target hits 15s timeout; advisory message returned |
| L1.4_goto_unreachable | target across canyon → contract failure |
| L1.5_bg_goto_lifecycle | bg_goto starts, completes, currentTask reflects |
| L1.6_bg_goto_cancel | start, cancel, status='cancelled', pathfinder cleared |
| L1.7_follow_player_present | follow when player online |
| L1.8_follow_player_absent | follow when player offline → contract error |
| L1.9_pillar_step_y62_trap | **Phase 1.1 deliberate trap**: bot in 6-block hole, `mc pillar_step 6` → escape |
| L1.10_go_mark_navigation | go_mark to seeded mark |

**Worked example — L1.9 fixture:**

```yaml
# data/test-fixtures/L1/L1.9_pillar_step_y62_trap.yaml
world: landfolk-test
prep:
  # L1 region centered at (50, 65, 0); pillar_step trap at (66, 64, 16)
  - "execute in landfolk-test run fill 32 60 -16 96 100 16 minecraft:air"
  - "execute in landfolk-test run fill 64 60 14 68 70 18 minecraft:stone"   # raised platform
  - "execute in landfolk-test run fill 66 64 16 66 70 16 minecraft:air"     # carve 6-deep hole
  - "mvtp Flint landfolk-test"
  - "execute in landfolk-test run tp Flint 66 65 16"                         # tp 1 above hole bottom
  - "clear Flint"
  - "give Flint minecraft:dirt 16"
  - "effect give Flint minecraft:saturation 1 10"
  - "effect give Flint minecraft:slow_falling 5 0 true"
required_marks: []
cleanup:
  - "execute in landfolk-test run fill 32 60 -16 96 100 16 minecraft:air"
  - "mvtp Flint world"
  - "execute in landfolk-test run kill @e[type=item,distance=..50]"
```

**Worked example — L1.9 capability_test card body:**

```yaml
id: L1.9_pillar_step_y62_trap
level: L1
capability: movement.pillar_step
bot: flint
fixture: L1/L1.9_pillar_step_y62_trap.yaml
preconditions:
  bot_position: "(16, 64, 16) — bottom of 6-block stone-walled hole"
  inventory: "16x dirt"
action_sequence:
  - mc pillar_step 6
success_predicate:
  - { kind: response_field, field: "ok", op: "==", value: true }
  - { kind: response_field, field: "data.placed_count", op: "==", value: 6 }
  - { kind: bot_position_within, coords: [16, 70, 16], radius: 1 }
  - { kind: inventory_contains, item: dirt, count: "==10" }     # 16 - 6 = 10
timeout: 60s
retry_policy: { transient: 1, outcome: 0 }
exercises_phase1_bug: "1.1's Y=62 hole trap; pillar_step is the existing primitive that should solve it"
```

**Expected bug surface:**
- `mc goto` 15s timeout returning `ok=true` advisory but bot didn't reach → contract violation, file bug
- `mc bg_goto` cancel race conditions
- `pillar_step` consecutive-failure short-circuit firing on legit terrain

**Exit gate:**
- L1 all green
- ≤2 non-blocking bugs open

### Sprint 3 — L2 + L3 (inventory, basic gather + craft) (2–3 sessions)

**Goal:** L2 + L3 green. This is where collect/craft contracts get exercised heavily.

**L2 tests (8):** equip success/missing/swap, unequip with full inventory, toss partial stack, pickup drops.

**L3 tests (14)** — code-grounded around the discovered handler complexity:

| Test ID | What it deliberately exercises |
|---------|-------------------------------|
| L3.1_dig_basic | dirt with bare hand → success |
| L3.2_dig_air | target is air → contract: `NO_BLOCK_AT_COORD` |
| L3.3_dig_wrong_tool | stone with wooden_axe held → contract: `TOOL_INADEQUATE` |
| L3.4_dig_protected | crafting_table → contract: `PROTECTED_BLOCK` |
| L3.5_collect_basic | 3 oak_log within 5 blocks → mined_count==3 |
| L3.6_collect_silent_failure | **Phase 1 bug**: 3 oak_log far away → contract: `ALL_PATHFIND_FAILED`, NOT `ok=true mined_count=0` |
| L3.7_collect_partial | 5 requested, 2 reachable → ok=true with partial_failure flag, mined_count=2 |
| L3.8_collect_fair_play_los | log behind water in fair-play mode → contract: `NO_VISIBLE_BLOCKS` |
| L3.9_pillar_step_jumping | basic 5-block pillar, plenty of dirt |
| L3.10_pillar_step_no_blocks | empty inventory → contract failure |
| L3.11_craft_hand_recipe | sticks from planks (no table) |
| L3.12_craft_table_required_present | chest from planks; table at 3 blocks |
| L3.13_craft_table_required_absent | chest from planks; no table → contract: `TABLE_REQUIRED` |
| L3.14_craft_missing_ingredients | chest with 0 planks → contract: `MISSING_INGREDIENTS` |

**Expected bug surface:**
- L3.6 will FAIL initially (Phase 1 bug deliberately exercised) → `[BUG][L3.6] mc collect returns ok=true with mined_count=0 on unreachable trees`
- L3.7 may need `partial_failure` flag added to contract
- Smelt is not in L3 (move to L4); blocking 30s deserves its own test
- Discover (`mc discover`) deferred to L4 (not on hot path for L3)

**Exit gate:**
- L2 + L3 all green
- All 5 contracts holding firm; no contract regressions
- Phase 1's `mc collect` bug fixed and verified

### Sprint 4 — L4 (mining) (2–3 sessions)

**Goal:** L4 green. Flint is the workhorse; this is the deepest capability set.

**L4 tests (15)** — covers the action richness the explore agent surfaced:

| Test ID | What it deliberately exercises |
|---------|-------------------------------|
| L4.1_dig_stone_with_pickaxe | stone with stone_pickaxe → succeeds |
| L4.2_dig_stone_no_pickaxe | stone with bare hand → contract: `TOOL_INADEQUATE` |
| L4.3_dig_iron_ore_stone_pickaxe | iron_ore with stone_pickaxe → succeeds |
| L4.4_dig_diamond_iron_pickaxe | diamond_ore with iron_pickaxe → succeeds |
| L4.5_dig_diamond_stone_pickaxe | diamond_ore with stone_pickaxe → contract: `TOOL_INADEQUATE` (tier mismatch) |
| L4.6_pillar_step_deep_escape | 30-block hole, 32 dirt → escape with 2 blocks remaining |
| L4.7_dig_area_5x5x5 | clean excavation, no obstacles |
| L4.8_dig_area_with_stand | bot in middle of area; nudge-off + stand-block-last |
| L4.9_tunnel_simple | 10-block straight tunnel, 2x3 cross-section |
| L4.10_stair_up_solid_ground | 10-step staircase, no auto-floor needed |
| L4.11_stair_up_open_cave | 10-step staircase over cave; auto-floor placement |
| L4.12_stair_down_to_layer | descend to known Y |
| L4.13_find_blocks_coal_ore | discover within radius, returns distance + bearing |
| L4.14_chest_deposit | open chest, deposit 32 cobble; metadata.inventory_delta correct |
| L4.15_float_straddle_dig | **Phase 1.4 deliberate**: bot at X=10.4, dig at X=10 → succeeds; verify floor coord used consistently |

**Worked example — L4.5 (tier mismatch contract test):**

```yaml
id: L4.5_dig_diamond_stone_pickaxe
level: L4
capability: mining.dig.tier_mismatch
bot: flint
fixture: L4/L4.5_diamond_stone_pickaxe.yaml
preconditions:
  bot_position: "(20, 50, 20) — adjacent to single diamond_ore block at (21, 50, 20)"
  inventory: "1x stone_pickaxe (held)"
action_sequence:
  - mc equip stone_pickaxe
  - mc dig 21 50 20
success_predicate:
  - { kind: response_field, field: "ok", op: "==", value: false }
  - { kind: response_field, field: "error.code", op: "==", value: "TOOL_INADEQUATE" }
  - { kind: response_field, field: "error.next_action_hint", op: "contains", value: "iron_pickaxe" }
  - { kind: inventory_contains, item: diamond, count: "==0" }
  - { kind: world_block_at, coords: [21, 50, 20], block: "diamond_ore" }   # block still there
timeout: 15s
exercises_phase1_bug: null
```

**Expected bug surface:**
- `mc place` "no solid neighbor" still firing where Mason's foundation pattern works → may need `place_against` primitive (file FEAT)
- `dig_area` nudge-off race conditions
- `stair_up` auto-floor placement in open caves not always reliable
- `find_blocks` bearing calculation off by one quadrant in some cases

**Exit gate:**
- L4 all green
- `[BUG][L4.x]` count for blocking < 3
- Phase 2 done; tag `phase2-sprint4-passed`; appendix-promoted features can begin

## 16. Success criteria

### Per-sprint exit gates (sharpened from earlier draft)

| Sprint | Gate |
|--------|------|
| 0 | L0.1 passes; one bug→fix→verify cycle completes end-to-end |
| 1 | L0 fully green (6/6 tests, 2 consecutive passes each); 5 action contracts implemented; no blocking bugs open |
| 2 | L1 fully green (10/10); ≤2 non-blocking bugs open; pillar_step Y=62 trap escapes deterministically |
| 3 | L2 + L3 fully green (8 + 14); Phase 1's `mc collect` silent-failure bug fixed and verified; no contract regressions |
| 4 | L4 fully green (15/15); float-straddle test passes; Phase 2 tag applied |

### Phase 2 "shippable" definition

A 4-hour live run on `landfolk-test` where:
- L0–L4 all green; capability matrix shows 53/53 tests with `consecutive_pass >= 2`
- Zero open `priority: blocking` bug_reports
- Action contracts hold under random fuzz: 100 randomly-selected capability tests run consecutively with no `ok=true` masking a real failure
- Total worker token spend for the 4-hour run < $5

If we hit those, Phase 2 is done. The action layer is reliable; the loop is boring; we're ready for Phase 3.

---

# Appendix — Phase 3+ Roadmap (when Phase 2 is boring)

The destination architecture from the earlier draft, deferred until the Phase 2 loop is mechanical and bugs are rare.

## A1. Steward profile + body
A 6th profile `steward` with its own roaming Mineflayer body. Body is decoupled from role (role is body-independent; body provides diegetic chat presence). Aspirational tower built by the team as a kanban mission once efficiency justifies it. See earlier draft (commit `4ed4a55`) for full spec.

## A2. Marks sync (canonical → bot caches)
`POST /marks/replace` and `POST /marks/diff` endpoints; dispatcher hook to push relevant marks pre-spawn; chat-IPC handler in steward worker. Replaces the simple "coords inline in card body" pattern from §9.

## A3. Chest inventory in canonical
Promote `inventory_delta` metadata into a per-chest `inventory` field on chest marks. Audit cron tasks. Periodic ground-truth verification.

## A4. Logistics planner
Steward skill that runs a small rule engine over canonical state:
- chest occupancy > threshold → spawn overflow/rebalance card
- item count < floor → spawn supply card
- mark expired → spawn verify_mark card
- two cards need same chest → serialize via dependency
Distance computation, supply-chain efficiency analysis come *after* the rule engine works.

## A5. Mason + Barley cast expansion
Activated after L5 (build) and L6 (farm) pass with gatherer + flint covering temporarily. Each gets its own profile, body, port.

## A6. Custom dashboard
Web app reading from kanban DB + marks file + bot APIs + the event/feed schema (§13). Map view, inventory panel, mission feed, logistics overview, chat console.

## A7. L5–L8 capabilities
- L5 Build: `mc place_facing`, `mc place_against`, structure patterns, foundation handling
- L6 Farming & livestock: plant/harvest, breeding, food prep
- L7 Combat & survival: engage/disengage, threat-aware pathfind
- L8 Full logistics: multi-bot supply chains, treasury, rebalancing

## A8. Action layer polish
- `/api-spec` endpoint (OpenAPI for `/action/*`)
- Anti-revisit memory in pathfinder
- Custom metric registration in goal engine
- Token-diet `mc observe_lean`
