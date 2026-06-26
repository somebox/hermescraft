# Schematic construction recovery — baseline probe log (S0.1)

Recorded: 2026-06-25 (recovery plan `schematic_construction_recovery_f0135d09`, guidance lane).

## Commands

```bash
python3 -m unittest scripts.tests.test_gv2_schematic_shelter scripts.tests.test_gv2_card_validator
cd bot && HERMES_CONSTRUCT_CONTEXT=1 node --test \
  test/runtime/construct-lifecycle.test.js \
  test/runtime/construct-shelter-regression.test.js \
  test/runtime/construct-phase-binding-probe.test.js \
  test/runtime/construct-gv2-11-fixture.test.js \
  test/actions/construct-handler-filter.test.js
```

Optional (S6.2, not run here): `.venv/bin/pytest tests/functional/building/test_construct_scoped.py -m functional`

## Results matrix

| Suite | Result | Notes |
|-------|--------|-------|
| `scripts/tests/test_gv2_schematic_shelter.py` | pass (48) | L3 **`oak_log`** aligned with GATE-MATERIAL when cards lane merged |
| `scripts/tests/test_gv2_card_validator.py` | pass | — |
| `construct-lifecycle.test.js` | mostly pass | `CONSTRUCT_PHASE_NOT_CLOSED` test fails until **S4** lands |
| `construct-shelter-regression.test.js` | pass | F5 door/roof gates |
| `construct-phase-binding-probe.test.js` (S0.2) | pass | `normalizeSessionPhase` + `phaseVerifyArgs` |
| `construct-handler-filter.test.js` | pass | workset clip |
| `construct-gv2-11-fixture.test.js` (S6.1, if present) | see runtime lane | Encodes S0.3 fixture F1 |

## Classification

| Item | Class | Owner |
|------|-------|-------|
| L3 `oak_log` vs test `oak_planks` | Known drift | S3.6 + GATE-MATERIAL ADR |
| String-only `session.phase` (pre-normalize) | Fixed in S2 | `normalizeSessionPhase` — see S0.2 probe |
| Complete without `construct end` after context clear | Policy gap | S4.1 |
| Functional canary A/B/D | **pass (A/B/D)** | S6.2 — see section below |

## S0.2 pointer

- Tests: `bot/test/runtime/construct-phase-binding-probe.test.js`
- Runtime: `normalizeSessionPhase`, `phaseVerifyArgs`, `buildConstructShowPayload` in `bot/lib/runtime/construct-lifecycle.js`
- Pre-fix symptom: fixture F1 in [`gv2-11-construct-fixture-spec.md`](gv2-11-construct-fixture-spec.md)

## S6.2 functional canary (2026-06-25)

**Prerequisite:** MC server listening on `:25565`, `landfolk-test` dimension, Tester on `:3004` with construct flag on the **bot process** (not pytest alone).

```bash
HERMES_CONSTRUCT_CONTEXT=1 ./scripts/restart-tester.sh --no-sentinel
HERMES_CONSTRUCT_CONTEXT=1 .venv/bin/pytest \
  tests/functional/building/test_construct_scoped.py::test_construct_canary_scenario_a_task_context_auto_begin \
  tests/functional/building/test_construct_scoped.py::test_construct_canary_scenario_b_prep_required \
  tests/functional/building/test_construct_scoped.py::test_construct_canary_scenario_d_lifecycle_teardown \
  -m functional -q
```

| Scenario | Result | Notes |
|----------|--------|-------|
| A — task_context auto-begin + end | **pass** | Pad geometry follows `starter_shelter-plan.json` anchor + chunk load via Tester TP |
| B — prep_required | **pass** | Water at plan corner blocks begin/readiness; pad prep then begin OK |
| D — lifecycle teardown | **pass** | `construct_complete_blocked` then `DELETE /task-context` clears session |

**Automated gates (same session):**

| Suite | Result |
|-------|--------|
| `python3 -m unittest scripts.tests.test_gv2_schematic_shelter scripts.tests.test_gv2_card_validator scripts.tests.test_construct_kanban_guard` | pass (54) |
| `cd bot && HERMES_CONSTRUCT_CONTEXT=1 node --test test/runtime/construct-*.test.js test/actions/construct-*.test.js` | pass (66) |

**Fix applied for canary:** functional tests had hardcoded anchor `(0,64,0)` while `data/ops/plans/starter_shelter-plan.json` anchor moved with genesis; tests now load anchor from plan, forceload footprint chunks, and teleport Tester to generate/load off-spawn terrain before RCON fills.

**Operator pitfall:** running pytest without a fresh `restart-tester.sh` in the same shell (or with a stale/orphan `:3004` listener) yields `Connection refused` on `:3004` — always restart Tester immediately before the pytest line above.


## Related

- Gap register: [`schematic-construction-gap-register.md`](schematic-construction-gap-register.md)
- Fixture spec: [`gv2-11-construct-fixture-spec.md`](gv2-11-construct-fixture-spec.md)
