# tests/colony — agent-arch validation suite

Tests in this tree validate the colony architecture's mechanisms (predicates, blocker/review loops, per-bot mutex) on the `landfolk-test` world via Tester. They are **opt-in only** — never collected by `run-functional-fast.sh` or `run-functional-full.sh`.

Plan: [`reports/agent-arch/2026-06-06-colony-validation-plan.md`](../../reports/agent-arch/2026-06-06-colony-validation-plan.md).

## Marker

Every test here carries **only** `@pytest.mark.colony` — *not* `@pytest.mark.functional`.

The autouse `_functional_harness` in `tests/conftest.py` runs `reset_ground_arena()` before every `@functional` test, filling `(-32,65,-32)–(32,80,32)` with air. That destroys any blocks set up by the C0 fixture (`:storage:` chest, signs, ore column) and makes the tests non-hermetic. Colony tests own their own per-test block state via fixtures (see `test_chest_delta_predicate.py::storage_chest`).

Adding `@pytest.mark.functional` to a colony test will silently destroy the C0 arena — strict-markers won't catch it.

`pyproject.toml` registers `colony`; both run scripts exclude it (`and not colony`). If a future PR adds a new colony test, no run-script edit is needed — the marker filter already handles it.

## How to run

```bash
# 1. Prep arena (one-time per server reboot; rerun any time you want a clean state)
scripts/run-fixture.sh prep data/test-fixtures/colony/C0_colony_arena.yaml

# 2. Start Tester on :3004
scripts/run-tester-bot.sh

# 3. Run the colony suite
.venv/bin/pytest -m colony --durations=15 -q --tb=short

# 4. Clean up arena when done (optional)
scripts/run-fixture.sh cleanup data/test-fixtures/colony/C0_colony_arena.yaml
```

`C0_colony_arena.yaml` is **not** autoused — fixtures in `tests/conftest.py` do not require its POIs. Default functional runs are unaffected.

## Arena POIs (C0)

After `prep` runs, Tester sees the following marks via `mc marks`:

| Mark | Coords | Purpose |
|---|---|---|
| `:base_anchor:` | `(0, 65, 0)` | Canonical arena center; nav target for return-trip cards |
| `:storage:` | `(4, 65, 0)` | Chest used by Concern 2 chest-delta tests |
| `:test_mine:` | `(0, 65, 8)` | Ore seam target for miner cards |
| `:test_lookout:` | `(8, 65, 0)` | High-visibility mark for nav-only tests |

Rcon `setblock` lays the blocks/chest; a post-prep step issues `mc mark` calls so the marks are queryable through the bot's marks API (per `agent-navigator.md` — cards resolve `:marks:` through the bot, not raw coords). Without this step nav-heavy tests would silently fall back to coord form.

## Done-ness vocabulary (Session 2)

Three completion vocabularies, one underlying predicate shape. `mc verify` is the bridge.

| Where | Vocabulary | Audience | Example |
|---|---|---|---|
| Card body | `success_when:` clause (prose or YAML) | Operator / `@planner` writing the card | `success_when: chest at :storage: contains ≥4 cobblestone` |
| `mc` verb | `mc verify <kind> <args...>` | Worker self-checking at completion | `mc verify chest_contains storage cobblestone 4` |
| Epic metadata | `metadata.acceptance:` items (structured) | `@overseer` reviewing epic completion | `{ kind: chest_contains, mark: storage, item: cobblestone, min_count: 4 }` |

**Concrete mapping for `chest_contains`:**

```yaml
# Card body — what the operator / planner writes:
success_when: chest at :storage: contains at least 4 cobblestone

# Worker self-check before kanban_complete:
$ mc verify chest_contains storage cobblestone 4
# {"ok":true, "data":{"satisfied":true, "observed":{"count":4}, "expected":{"min_count":4}}}

# Epic metadata — what overseer parses:
metadata:
  acceptance:
    - kind: chest_contains
      mark: storage
      item: cobblestone
      min_count: 4
```

The structured `acceptance` shape **is** the verify body (same keys). Workers can templatize their `mc verify` calls directly from the epic's `acceptance` list, and the overseer can replay any worker's check by sending the same body to its own bot.

**Vocab discipline:** card-body `success_when` is the human prose; `acceptance` is the canonical machine form; `mc verify` is the runtime verb. When the three drift, prefer `acceptance` as the source of truth and regenerate the others.

Full spec: [`docs/architecture/mc-verify-spec.md`](../../docs/architecture/mc-verify-spec.md).

### Concern 2 variants

Three predicate shapes. The plan lists them as variants 1/2/3 of "object-state done-ness":

| Variant | Predicate | Test file | Tier | Status |
|---|---|---|---|---|
| 1 | Vague (`"complete when done"`) — expect AUTO_STUCK | manual / `@pytest.mark.integration` (TBD) | Integration | **Observational** — runtime-dependent; not a regression. Run ad-hoc when investigating worker stall patterns. See "Variant 1 capture recipe" below. |
| 2 | Object-state (chest contains ≥N item) | [`test_chest_object_state_predicate.py`](test_chest_object_state_predicate.py) | Tier 3 (Tester + rcon) | ✅ green |
| 3 | Delta (chest delta ≥N vs start) | [`test_chest_delta_predicate.py`](test_chest_delta_predicate.py) | Tier 3 (rcon only) | ✅ green |

### Variant 1 capture recipe (ad-hoc, no test infra)

When investigating vague-predicate AUTO_STUCK behavior:

1. Create a card with a deliberately vague body on the proto tenant:

   ```bash
   export HERMES_HOME=$HOME/.hermes-proto-agent-arch
   hermes kanban create --tenant proto-agent-arch --assignee pilot-navigator \
       --skill agent-navigator --skill minecraft-navigation \
       --body "Complete when done" \
       --max-runtime 5m --json "vague predicate observation"
   ```
2. Dispatch + observe: `hermes kanban dispatch --max 1`
3. Watch the worker log for fingerprint stalls: `tail -f ~/.hermes-proto-agent-arch/profiles/pilot-navigator/logs/agent.log | grep -E "AUTO_STUCK|recent_tuple"`
4. Record the recent[] tuple shape in `reports/agent-arch/` for the audit trail. Do NOT promote this to a deterministic test — the failure mode depends on the LLM's planning-vs-acting balance under specific prompt conditions and isn't reproducible enough to gate CI on.

Variant 1's value is **diagnostic**, not regression. It tells us *what specific predicate shapes trigger paralysis*, which informs the design of `success_when` conventions card authors should write — not whether the architecture is broken.

## What this tree is NOT

- Not the architecture's full validation. Colony tests cover specific mechanisms — predicates (Concern 2), blocker/review (Concern 4), parallelism (Concern 5b's demo). Plugin mutex (Concern 5a) lives in `plugins/landfolk/tests/`. Orchestration contracts live in `prototypes/agent-arch/tests/`.
- Not CI-required. Run manually; promoted to nightly only after a session-by-session pivot gate confirms stability.
- Not coupled to production tenant. Plugin work touches `plugins/landfolk` source but tests use in-memory SQLite, not the live `landfolk-ops` board.

## Anti-patterns

- ❌ Marking colony tests `@pytest.mark.functional` or `@pytest.mark.integration` — the autouse harness will wipe the arena before the test body runs.
- ❌ Relying on the C0 fixture for block persistence within a colony test — use per-test fixtures that own setup + teardown. C0 is for marks (via `mc mark`) and ambient world prep, not block state your test asserts on.
- ❌ Wiring `C0` POI requirements into autouse fixtures.
- ❌ Reaching for `flint_bot` — use `tester_bot` per `tests/conftest.py`.
- ❌ Modifying `tests/conftest.py` in ways that require colony POIs for default functional runs.
