# Phase 2 — Capability tests & test world

Sections 6, 7, and 12 of the Phase 2 architecture: capability matrix (L0–L4), test contract schema, and the test world / fixture conventions.

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


## 12. Test world & fixtures (Multiverse)

This section is a summary. Source of truth is `docs/guides/test-world-landfolk.md`, which captures the operational details and the gotchas surfaced during prep.

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

`scripts/reset-test-world.sh` (TODO): `/mv delete landfolk-test --force && /mv create landfolk-test NORMAL --world-type FLAT --no-structures` then re-run the difficulty/gamerule/spawn/forceload sequence from `docs/guides/test-world-landfolk.md`. Run weekly or on-demand if fixtures drift.

### Helper script for the human-as-steward

`scripts/run-fixture.sh prep|cleanup|both <fixture.yaml>` reads the YAML and runs prep/cleanup via ssh→docker→rcon. The `-n` flag on ssh inside the loop is load-bearing — without it ssh consumes the heredoc and only the first command runs.

