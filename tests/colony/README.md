# tests/colony — agent-arch validation suite

Tests in this tree validate the colony architecture's mechanisms (predicates, blocker/review loops, per-bot mutex) on the `landfolk-test` world via Tester. They are **opt-in only** — never collected by `run-functional-fast.sh` or `run-functional-full.sh`.

Plan: [`reports/agent-arch/2026-06-06-colony-validation-plan.md`](../../reports/agent-arch/2026-06-06-colony-validation-plan.md).

## Marker

Every test here carries `@pytest.mark.colony` plus the layer marker it needs (`functional` for Tester+rcon; `integration` when LLM is in the loop).

`pyproject.toml` registers the marker; both run scripts exclude it (`and not colony`). If a future PR adds a new colony test, no run-script edit is needed — the marker filter already handles it.

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

## Done-ness vocabulary (placeholder for Session 2 to fill)

The colony architecture has three completion vocabularies that need to reconcile:

| Where | Vocabulary | Owner |
|---|---|---|
| Card body | `success_when:` clause | Operator / `@planner` |
| `mc` verb | `mc verify <predicate>` | Worker self-check at completion |
| Epic metadata | `metadata.acceptance:` items | `@overseer` epic-completion review |

Session 2 (Concern 2) builds `mc verify` as a Tier-1 contract in `bot/test/` and lands the per-variant tests here. The mapping table above will be filled in then; for now the chest-delta test in this tree (`test_chest_delta_predicate.py`) demonstrates the **delta** shape end-to-end.

## What this tree is NOT

- Not the architecture's full validation. Colony tests cover specific mechanisms — predicates (Concern 2), blocker/review (Concern 4), parallelism (Concern 5b's demo). Plugin mutex (Concern 5a) lives in `plugins/landfolk/tests/`. Orchestration contracts live in `prototypes/agent-arch/tests/`.
- Not CI-required. Run manually; promoted to nightly only after a session-by-session pivot gate confirms stability.
- Not coupled to production tenant. Plugin work touches `plugins/landfolk` source but tests use in-memory SQLite, not the live `landfolk-ops` board.

## Anti-patterns

- ❌ Adding `@pytest.mark.colony` tests without `@pytest.mark.functional` (or `integration`) — strict-markers won't complain but the harness expects a layer marker.
- ❌ Wiring `C0` POI requirements into autouse fixtures.
- ❌ Reaching for `flint_bot` — use `tester_bot` per `tests/conftest.py`.
- ❌ Modifying `tests/conftest.py` in ways that require colony POIs for default functional runs.
