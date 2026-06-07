# Wheat-farm capstone — runner scaffold

Status: **Session 5a complete (scaffold + freeze-rule gate).**
Session 5b (live trial) is operator-driven and waits on the preflight
gaps below.

This directory holds the runner code for the wheat-farm capstone
described in
[`reports/agent-arch/2026-06-06-colony-validation-plan.md`](../../../reports/agent-arch/2026-06-06-colony-validation-plan.md).
The capstone is the experiment that resolves **A6** (per-card scope
reset → completion reliability) and **A7** (the walkthrough graph
exposes wide-flint paralysis).

## Why this is split into 5a and 5b

The plan budgets ~1½ days for Session 5. Pre-trial inspection of the
prerequisites turned up two architecture gaps that violate the freeze
rule if absorbed into the trial:

1. **`mc verify` verbs.** Session 2 landed `inventory_contains` and
   `chest_contains` only. The walkthrough's full acceptance list
   (tilled-plot grid, water source, sign) needs `region_blocks` /
   `at_mark` verbs that haven't landed. The scaffold narrows the
   capstone's acceptance gate to a single `chest_contains` predicate
   (wheat deposited at `:chest_food:`), which still resolves A2/A6/A7
   honestly.
2. **Agent skill bundles.** The walkthrough's execute lane uses
   `navigator → builder → farmer → crafter`. `agent-navigator.md`
   exists in the repo; `agent-builder.md`, `agent-farmer.md`,
   `agent-crafter.md` do not. The scaffold references them by their
   canonical names so the preflight gate surfaces the gap clearly.

These are pre-trial discoveries, not mid-trial discoveries, so the
freeze rule says: stop, file as separate work, then resume.
**Session 5a is the scaffold + the gate**; **Session 5b is the trial**,
gated on those two items landing.

## What's in here

| File | Purpose |
|---|---|
| `wheat_graph.py` | Canonical colony graph: 4 execute cards, all bound to `mox`, chained by `depends_on`. Data only. |
| `wide_baseline.py` | Single-card flint control, body = concatenation of execute bodies, skills = union. The architecturally fair comparison. |
| `acceptance.py` | Drives `mc verify` against the (narrowed) acceptance predicate. Refuses unsupported predicate kinds at module level — freeze-rule made mechanical. |
| `author.py` | Translates a graph into `hermes kanban create` command vectors with `[bot:mox]` title prefixes and `depends_on` → `--parent` resolution. Doesn't shell out — caller does. |
| `preflight.sh` | Pre-trial gate. Seven checks; non-zero exit on any MISSING. WARNs are trial-only items the scaffold itself doesn't need. |

The contract tests live one level up at
[`../tests/test_capstone_scaffold.py`](../tests/test_capstone_scaffold.py)
(29 tests, all green). They exercise the graph shape, the title prefix,
the parent resolution, the wide-baseline body/skill union, and the
acceptance-gate freeze-rule enforcement. None of them touch live infra.

## Trial procedure (Session 5b)

These steps assume the preflight gate exits 0. If it doesn't, run the
gap closure first.

### 0. Run the preflight gate

```bash
./prototypes/agent-arch/capstone/preflight.sh
```

Any MISSING line means stop. WARNs are advisory.

### 1. Start the colony test world + Tester bot

```bash
# Bring up landfolk-test world (see docs/architecture/bots-and-mc.md)
# Then:
scripts/run-tester-bot.sh
```

Tester listens on `:3004` and is the neutral observer for `mc verify`.
Do NOT run verify on `mox` — verify must be observer-driven.

### 2. Apply the test fixture

The wheat capstone needs the same arena fixture as the chest-delta
test:

```bash
scripts/run-fixture.sh data/test-fixtures/colony/C0_colony_arena.yaml
```

Confirms `:field_south:`, `:chest_food:`, `:base_anchor:` marks resolve
via `mc marks` on Tester.

### 3. Start `mox` (the bound bot)

```bash
# Wire up data/bots/mox.yaml's port + username.
# Concrete invocation depends on how scripts/landfolk runs in
# colony mode — defer to that runbook.
```

### 4. Open a JSONL telemetry stream

Reuse `automation/telemetry.py` from Session 1:

```python
from prototypes.agent_arch.automation.telemetry import open_stream
stream = open_stream(run_id="capstone-colony-2026-06-07a", mode="colony")
```

Wall time, cards_created, cards_completed, cards_blocked,
per_card_retries, manual_interventions — emit on every state change.

### 5. Author the colony lane

```python
from capstone.author import author_colony_lane, resolve_parents
from capstone.wheat_graph import build_default_graph

graph = build_default_graph()
invocations = author_colony_lane(graph)
slug_to_id: dict[str, str] = {}
for inv in invocations:
    cmd = resolve_parents(inv, slug_to_id)
    # subprocess.run(cmd, ...); parse JSON; record id in slug_to_id
```

### 6. Watch + intervene only when freeze rule allows

The freeze rule: **no new architecture elements added during the trial.**
Manual interventions are fine and counted in telemetry. Architecture
changes require stopping the trial and filing a new session.

### 7. Run the acceptance gate

```python
from capstone.acceptance import evaluate
result = evaluate(graph.acceptance_predicate)
# result.evaluable, result.satisfied → log to telemetry
```

### 8. Repeat for the wide-flint baseline

Reset world state, author `build_wide_baseline(graph)`, run, gate.

### 9. Categorise via the plan's confound table

| Outcome | Conclusion | Updates |
|---|---|---|
| Both complete, similar wall time | Architecture value isn't in cost or completion. | A6 → inconclusive; A7 → contradicted |
| Colony completes; flint blocks | Narrow-scope claim supported. | A6 → supported; A7 → supported |
| Flint completes; colony struggles | Chain orchestration > scope-reset benefit. | A6 → contradicted |

## Pre-trial gaps — closed

All three gaps the scaffold flagged closed in follow-up commits:

1. **`mc verify` verbs** — `at_mark` (bot proximity + block-at-mark
   modes) and `region_blocks` (axis-aligned box scan with volume cap)
   landed. The full walkthrough acceptance set is now expressible:
   tilled grid via `region_blocks`+`farmland`, planted wheat via
   `region_blocks`+`wheat`, water source via `at_mark`+`--block water`,
   sign via `at_mark`+`--block oak_sign`, deposit via the existing
   `chest_contains`. 17 new verify-contract tests, 5 new dispatch
   parser tests. The default colony graph still uses just
   `chest_contains` (minimum trial); richer predicates can be wired
   when the walkthrough's full set is desired.
2. **Agent skill bundles** — `agent-builder.md`, `agent-farmer.md`,
   `agent-crafter.md` landed in `skills/`, each mirroring
   `agent-navigator.md`'s 7-section template with role-scoped verbs,
   structured block reasons, and handoff schemas.
3. **Colony launcher** — `scripts/colony` brings up the test bots
   (mox/pip/zee) from `data/bots/<name>.yaml`. Subcommands: `start`,
   `stop`, `status`, `restart`, `logs`; `--dry-run` + `--bot a,b,c`
   for selective ops; `status --json` for machine consumption. 15
   contract tests cover dry-run env composition, status output
   shape, and dispatch errors.

Preflight (`preflight.sh`) now exits 0 on a clean checkout with
Tester running, opening the path to 5b.
