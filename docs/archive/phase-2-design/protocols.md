# Phase 2 — Protocols (marks, chests, steward, events)

Sections 9, 10, 11, and 13 of the Phase 2 architecture: minimal marks MVP, chest accounting, human-as-steward protocol, and event/feed schema for the future dashboard.

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

