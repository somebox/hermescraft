# Construct canary: Node vs arena parity (Track D2)

Maps F6 scenarios in [`docs/architecture/construct-canary.md`](../architecture/construct-canary.md)
to [`tests/functional/building/test_construct_scoped.py`](../../tests/functional/building/test_construct_scoped.py)
and Node suites (`bot/test/runtime/construct-*.test.js`, `construct-handler-filter.test.js`,
`construct-contract.test.js`, `http-app.test.js`).

**Policy:** Do not delete or shrink the arena module without explicit sign-off
([`construct-canary-policy.md`](construct-canary-policy.md)).

## Scenario matrix

| F6 / pytest | Primary proof today | Node mirror (no live world) | HTTP integration |
|-------------|--------------------|------------------------------|------------------|
| Scoped place + `guided_edit_progress` | `test_construct_begin_and_scoped_place` | `construct-lifecycle.test.js` (`attachConstructMotorEnvelope`); `construct-shelter-regression.test.js` (mutation/scope) | Action POST only in arena |
| **A** task_context auto-begin → patch → end | `test_construct_canary_scenario_a_task_context_auto_begin` | Begin gates, end gates, materials (unit); not full auto-begin pipeline success without world | `POST /task-context` shape + `construct_auto_begin` when env on (arena); `FEATURE_DISABLED` when env off (`http-app.test.js`) |
| **B** prep_required / wet site | `test_construct_canary_scenario_b_prep_required` | `construct-site-readiness.test.js`; `construct-contract.test.js` (`CONSTRUCT_PREP_REQUIRED` on `construct_begin`) | Wet site + `POST /task-context` auto-begin failure stays arena |
| **C** plan_revision mismatch | `test_construct_canary_scenario_c_plan_revision_mismatch` | `construct-begin-gates.test.js`; `construct-contract.test.js` (`PLAN_REVISION_MISMATCH`) | Same — arena proves disk revision + live begin |
| **D** lifecycle DELETE / blocked complete | `test_construct_canary_scenario_d_lifecycle_teardown` | `http-app.test.js` (DELETE/POST card change, GET blocked); `construct-lifecycle.test.js` | Covered at HTTP layer without world |
| **F2** death clears session | `test_construct_canary_scenario_f2_death_clears_session` (`@slow`) | No Node equivalent (requires disconnect/reconnect) | **Arena-only** |
| Handler scoping (place/fill/dig) | Partially in scenario A/B place steps | `construct-handler-filter.test.js`, `construct-context-filter.test.js` | Live reach/LOS in arena |

## Gaps intentionally left in arena

These behaviors need a running bot, RCON terrain, or reconnect semantics:

- Full **scenario A** happy path: auto-begin from real plan anchor, in-world `place`, `construct_end` with live end gates.
- **Scenario B** after prep: RCON pad fill and second begin with readiness `ready`.
- **Scenario C** success path with on-disk `starter_shelter-v1` and session teardown.
- **F2** death/disconnect clearing `construct_context` and workset.
- Fleet-adjacent checks (kanban complete probe, `mc bot release`) — documented in construct-canary.md; not duplicated in Node.

## Gaps closed in Node (Track D2)

| Gap | Test location |
|-----|----------------|
| `POST /task-context` CONSTRUCT grant returns `construct_auto_begin` with `FEATURE_DISABLED` when `HERMES_CONSTRUCT_CONTEXT` unset | `http-app.test.js` |
| `construct_auto_begin: false` on POST omits auto-begin payload | `http-app.test.js` |
| `construct_begin` → `PLAN_REVISION_MISMATCH` / `CONSTRUCT_PREP_REQUIRED` envelopes | `construct-contract.test.js` |
| Session teardown on DELETE / card rebind / `construct_complete_blocked` on GET | pre-existing `http-app.test.js` + `construct-lifecycle.test.js` |

## Commands

```bash
# Node construct stack (no world)
cd bot && node --test test/runtime/construct-*.test.js test/actions/construct-*.test.js test/http-app.test.js

# Arena canary (tester + HERMES_CONSTRUCT_CONTEXT=1)
HERMES_CONSTRUCT_CONTEXT=1 ./scripts/restart-tester.sh --no-sentinel
.venv/bin/pytest tests/functional/building/test_construct_scoped.py -m functional -v
```
