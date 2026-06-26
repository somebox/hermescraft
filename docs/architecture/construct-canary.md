# Construct mode canary matrix (F6)

Manual and semi-automated checks before enabling `HERMES_CONSTRUCT_CONTEXT=1` fleet-wide. Plan vocabulary and JSON shape: [`blueprints-grabcraft.md`](../specs/world/blueprints-grabcraft.md). Layered base (parallel track): [`base-build-layered.md`](base-build-layered.md). Fixture plan: [`data/ops/plans/starter_shelter-plan.json`](../../data/ops/plans/starter_shelter-plan.json).

## Prerequisites

- Tester bot (or one worker profile) with `HERMES_CONSTRUCT_CONTEXT=1`
- `starter_shelter` plan on disk; region `plan=starter_shelter` + worksite grant
- Optional: paste a reference shell with `python3 scripts/place-schematic-rcon.py <plan_id> --at-player <name> --sign-front "<label>"` (RCON; [`blueprints-grabcraft.md`](../specs/world/blueprints-grabcraft.md))
- Automated regression (no world): `cd bot && node --test test/runtime/construct-*.test.js test/actions/construct-*.test.js test/http-app.test.js`
- Node vs arena parity (Track D2): [`docs/testing/construct-node-arena-parity.md`](../testing/construct-node-arena-parity.md)
- Python validator: `python3 -m unittest scripts.tests.test_gv2_card_validator.SchematicConstructValidatorTest`
- Arena (optional): `pytest tests/functional/building/test_construct_scoped.py -m functional`

### Automated F6 coverage (Tester + `HERMES_CONSTRUCT_CONTEXT=1`)

```bash
HERMES_CONSTRUCT_CONTEXT=1 ./scripts/restart-tester.sh --no-sentinel
.venv/bin/pytest tests/functional/building/test_construct_scoped.py -m functional -v
```

| Scenario | Pytest |
|----------|--------|
| A — ready path, task_context auto-begin, end gates | `test_construct_canary_scenario_a_task_context_auto_begin` |
| B — wet site blocks begin; prep then ready begin | `test_construct_canary_scenario_b_prep_required` |
| D — lifecycle teardown (blocked → DELETE clears) | `test_construct_canary_scenario_d_lifecycle_teardown` |
| C — plan revision mismatch (E5) | `test_construct_canary_scenario_c_plan_revision_mismatch` |
| Scoped place smoke | `test_construct_begin_and_scoped_place` |

Manual steps below remain the steward checklist; pytest is the repeatable gate before G1.

Functional tests read `starter_shelter` anchor from `data/ops/plans/starter_shelter-plan.json` and teleport Tester + forceload footprint chunks before RCON geometry (`_ensure_plan_site_chunks` in `test_construct_scoped.py`) — do not assume anchor `(0,64,0)`.

## Known gaps (post-canary A/B)

| Item | Status |
|------|--------|
| **G1** fleet `HERMES_CONSTRUCT_CONTEXT=1` on landfolk workers | Tester only |
| **E4** planner SUPPLY from `materials_by_phase` | [`scripts/lib/plan_supply.py`](../../scripts/lib/plan_supply.py) + [`scripts/construct-plan-cards.py`](../../scripts/construct-plan-cards.py); gv2 poller auto-files full phase chain via [`scripts/lib/gv2_schematic_shelter.py`](../../scripts/lib/gv2_schematic_shelter.py) |
| **E3** overlap / full gv2 CONSTRUCT body rules for schematic cards | Partial (`SchematicConstructValidatorTest` only) |
| **C7** `guided_edit_progress` on every motor success path | Partial (place/fill/dig wired) |
| **Canary C** plan revision drift | `test_construct_canary_scenario_c_plan_revision_mismatch` |
| **`scripts/kanban complete`** | Blocks when assignee bot reports `construct_complete_blocked` (active session). Schematic CONSTRUCT cards (plan + `--card-kind CONSTRUCT`) also require matching `construct_phase_closed` on the bot (survives `task_context` clear after `mc construct end`). Override: `KANBAN_ALLOW_COMPLETE_WITH_CONSTRUCT=1` |
| **`mc bot release`** | Best-effort `DELETE /task-context` on leased bot (same as scenario D DELETE) |

Live fixes not in original plan text: `PLAN_ID_RE` allows `_` in plan ids; begin stores structured `session.phase` (`normalizeSessionPhase`: level/range override string phase labels).

## Construct end flags (`skip-gates` vs `skip_phase_gate`)

| Flag | Effect |
|------|--------|
| *(none)* | Phase slice must be verify-clean (`evaluatePhaseClean` on `level` / `range` only), then plan `gates[]` run (`l0_ground`, `door_traversable`, `interior_air`, …). |
| `--skip-gates` | Skip plan `gates[]` after phase-clean passes. Use on **non-final phase cards** (L1 slab, L3 walls) when cards intentionally defer shell gates to a later phase. Phase-clean still runs unless `skip_phase_gate` is also set. |
| `--skip_phase_gate` | Skip slice verify-clean check. Dangerous for normal worker completion; operator rescue / dry runs only. |
| Both set | End clears construct session without probes (same as legacy escape hatch). |

**Worker rule:** gv2 CONSTRUCT cards should reach `mc construct end` **without** `--skip-gates` on the final shell phase; intermediate phases may match generator bodies that pass `--skip-gates` after slice work is done.

## Scenario A — Fresh flat site (`ready` path)

1. Flat cobble pad at plan anchor; door gap air; interior hollow.
2. `mc task_context set :base: --card <CONSTRUCT L1> --plan starter_shelter --level 1 --card-kind CONSTRUCT`
3. Expect auto-begin or explicit `mc construct begin` success; `construct show` workset > 0 initially.
4. Patch with `mc fill` / `mc place` / `mc dig`; no `mc wall` inside footprint.
5. `mc construct show` → phase verify clean; `materials_missing` reflects inventory.
6. `mc construct end` → success (gates pass).
7. `mc task_context show` → no `construct_complete_blocked`.

**Pass signals:** zero out-of-footprint construct errors in action JSONL; no `CONSTRUCT_NOT_STARTED` after begin; end returns `ok` without `GATE_FAIL`.

**Automated:** `test_construct_canary_scenario_a_task_context_auto_begin` (see table above).

## Scenario B — Sloped / wet site (`prep_required`)

1. Site with L0 air/water or readiness spread failure.
2. Begin or auto-begin returns readiness **`prep_required`** or **`relocate`** (D1); no construct session until prep card completes.
3. After prep, re-bind task_context and begin.

**Pass signals:** no silent begin on bad L0; steward sees structured readiness in begin error payload.

**Automated:** `test_construct_canary_scenario_b_prep_required` — water at an L1 footprint corner → `CONSTRUCT_PREP_REQUIRED` and no session; after pad prep, begin succeeds with readiness on.

## Scenario C — Plan drift

1. Build partial shelter from revision A; update plan file revision / `plan_revision` on card.
2. Begin with mismatched `plan_revision` → **`PLAN_REVISION_MISMATCH`** (E5).
3. Correct revision or re-verify; workset shows `wrong`/`missing` from world drift, not lost handoff text.

**Pass signals:** no completion with door gap filled; `door_traversable` gate fails on end if gap blocked (see F5 Node tests).

**Automated:** `test_construct_canary_scenario_c_plan_revision_mismatch` — stale `plan_revision` → `PLAN_REVISION_MISMATCH`, no session; matching `starter_shelter-v1` begins.

## Scenario D — Lifecycle teardown

1. Active construct session → `mc bot release` or `DELETE /task-context` → session cleared.
2. Death/disconnect → session cleared (bot reconnects without stale workset).
3. Card rebind with new `card_id` → prior construct session cleared.

**Pass signals:** `mc task_context show` without `construct_complete_blocked` after teardown; kanban complete only after construct end (`scripts/kanban complete` probes assignee bot; refuses while session active).

**Automated:** `test_construct_canary_scenario_d_lifecycle_teardown` — active session exposes `construct_complete_blocked`; `DELETE /task-context` clears session (`mc bot release` uses the same HTTP clear when lease mode is on).

## `--skip-gates` vs `--skip_phase_gate` (S4.2)

| Flag | Phase-clean verify | Plan gates (`door_traversable`, `l0_ground`, …) |
|------|-------------------|--------------------------------------------------|
| neither | runs on **session slice** (`level` / `range` from task_context) | runs on final L4 |
| `--skip-gates` | still runs | skipped |
| `--skip_phase_gate` | skipped | still runs (if not skip-gates) |
| both | skipped | skipped |

gv2 **non-final** CONSTRUCT cards use `mc construct end --skip-gates` so stewards can advance the chain without final `door_traversable` on partial shells. **Phase-clean still runs** unless `--skip_phase_gate` is also set — workers must not treat slice `blueprint verify` alone as card done; `construct end` on the same slice is required (`CONSTRUCT_PHASE_NOT_CLOSED` blocks kanban complete after context clear).

## Rollback

Set `HERMES_CONSTRUCT_CONTEXT=0` (or unset) on bot profile; workers fall back to unscoped place/fill/dig. Keep plan JSON and validator rules — they remain useful for audits.
