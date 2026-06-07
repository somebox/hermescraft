# Wheat-farm capstone — runbook (Session 5b)

Single-bot run: **Mox** drives a four-card chain (nav → build → farm
→ deposit) end-to-end. The point of this trial isn't parallelism — it's
**per-card scope reset**. Does narrowing each card's role+skill bundle
let one body handle a multi-domain task that a wide-baseline body would
stall on?

See [`2026-06-06-colony-validation-plan.md`](2026-06-06-colony-validation-plan.md)
§ "Capstone — Wheat farm" for falsifiability claims, confound table,
and how this slots between Sessions 5a and 5c.

## Layout (same shape as trial 3, single-bot variant)

| Concern | Wheat capstone |
|---|---|
| HERMES_HOME | `~/.hermes/` (live, dashboard-visible) |
| Pilots | `~/.hermes/profiles/pilot-mox/` (one profile, four roles via per-card --skill) |
| Board | `wheat-capstone` |
| Bots | Mox (:3007) drives all 4 cards; Tester (:3004) is the acceptance observer |
| Bodies | 1 (Mox); no mutex contention this trial — the mutex test is the two-bot demo's job |
| Workspace layout | boards (`kanban/boards/wheat-capstone/workspaces/`) |
| Visible at `:9119` | yes |
| Conflicts with landfolk-ops? | no (different board; dispatcher filtered) |

Why one profile for four roles instead of four bot-bound profiles:
the [bot:mox] title-prefix mutex serialises cards on one body regardless
of profile boundary, and the role distinction is conveyed entirely by
the per-card --skill bundle that the runner passes at create time. One
profile is the smallest configuration that still respects the role
narrowness the architecture claims.

## Prereqs (post-trial-3)

Already landed in this branch:

- [x] `acceptance.py` nested-`data.satisfied` fix + multi-predicate `evaluate_all`
- [x] `wheat_graph.acceptance_predicates` (3-predicate set: farmland 9×9 + wheat 9×9 + water source)
- [x] C0_colony_arena fixture mark-body fix (`at: {x,y,z}` + single-quoted YAML)
- [x] `mc-verify-spec.md` nested-envelope addendum
- [x] `data/test-fixtures/colony/wheat_capstone.yaml` — staging arena
- [x] `prototypes/agent-arch/setup-pilot-mox-live.sh` — pilot-mox profile installer
- [x] `prototypes/agent-arch/capstone/run_wheat_capstone.py` — runner
- [x] `scripts/preflight-wheat.sh` — trial-time gate

Audit before launch:

```bash
.venv/bin/python -m pytest \
  prototypes/agent-arch/tests/test_capstone_scaffold.py -q
# expect: 39 passed
```

## One-time setup (live pilot-mox)

```bash
HERMES_HOME=~/.hermes prototypes/agent-arch/setup-pilot-mox-live.sh

# Verify
HERMES_HOME=~/.hermes hermes profile show pilot-mox      # 10 skills, model pinned
HERMES_HOME=~/.hermes hermes kanban boards list           # includes wheat-capstone
```

The script idempotently overwrites `config.yaml`, `SOUL.md`, and `.env`,
but never touches `state.db`, `memories/`, or `sessions/` from prior
runs. Other live profiles (flint, mason, gatherer, barley, steward,
pilot-pip, pilot-zee) are untouched.

## Trial launch

### 1. Reset arena + bots

```bash
# Tester (acceptance observer) + Mox (worker)
scripts/run-tester-bot.sh
MC_HOST=192.168.1.202 scripts/colony start mox

# Stage the wheat arena (dirt floor + water + chest + marks; tps Mox)
scripts/run-fixture.sh prep data/test-fixtures/colony/wheat_capstone.yaml

# Confirm everything is in place — 9 gates, all must be OK
scripts/preflight-wheat.sh
```

If preflight reports MISSING for the world state (water, chest, marks,
Mox position), re-run `run-fixture.sh prep` — the rcon container can
drop commands during a heavy load window. Don't proceed past a red
preflight; the trial will just silently fail on a missing precondition.

### 2. Launch trial

```bash
RUN_ID="trial-$(date +%s)"
echo "$RUN_ID" > /tmp/wheat-current-run-id
RUNNER_LOG="/tmp/wheat-runner-${RUN_ID}.log"
DISPATCHER_LOG="/tmp/wheat-dispatcher-${RUN_ID}.log"

# Runner — creates cards, then watches statuses to terminal
HERMES_HOME=~/.hermes \
  python prototypes/agent-arch/capstone/run_wheat_capstone.py \
  --run-id "$RUN_ID" \
  --board wheat-capstone \
  --assignee pilot-mox \
  --watch \
  > "$RUNNER_LOG" 2>&1 &
echo $! > /tmp/wheat-runner-pid

# Dispatcher — drains the wheat-capstone board every 10s
(
  export HERMES_HOME=~/.hermes
  while true; do
    echo "[$(date -Iseconds)] tick" >> "$DISPATCHER_LOG"
    hermes kanban --board wheat-capstone dispatch --max 5 >> "$DISPATCHER_LOG" 2>&1
    sleep 10
  done
) &
echo $! > /tmp/wheat-dispatcher-pid
```

### 3. Watch live

- **Dashboard:** http://127.0.0.1:9119/kanban — `wheat-capstone` board with 4 cards (x001..x004)
- **Mox reasoning + tool calls:**

  ```bash
  HERMES_HOME=~/.hermes scripts/proto-logs-follow.py --quiet --profile pilot-mox
  ```

- **Bot log:** `tail -F /tmp/hermescraft/bot-mox.log`
- **CLI snapshot:** `HERMES_HOME=~/.hermes hermes kanban --board wheat-capstone list`

### 4. After trial completes

```bash
# Move Tester near the plot so the chunk loads for region_blocks verify
ssh -n ubuntu-host "sudo docker exec minecraft rcon-cli 'execute in landfolk-test run tp Tester -50 70 50'"
sleep 4

# Stop the dispatcher loop
kill $(cat /tmp/wheat-dispatcher-pid) 2>/dev/null

# Score — runs evaluate_all over the 3 acceptance predicates against
# Tester :3004 and writes data/postmortems/wheat-capstone/<run>/scorecard.json
HERMES_HOME=~/.hermes \
  python prototypes/agent-arch/capstone/run_wheat_capstone.py \
  --run-id "$RUN_ID" \
  --board wheat-capstone \
  --evaluate-only
```

### Scorecard interpretation

The scorecard fields (`scorecard.json`):

| Field | Meaning | Pass target |
|---|---|---|
| `band` | `pass` / `partial` / `fail` | `pass` |
| `cards_done_count / cards_total` | 0..4 / 4 | 4/4 |
| `cards_blocked` | how many cards Mox blocked | 0 |
| `wall_time_s` | first card created → last terminal | informative |
| `acceptance_satisfied` | all 3 predicates green | true |
| `acceptance_evaluable` | all 3 predicates returned valid responses (regardless of result) | true |
| `per_predicate` | list of {predicate, satisfied, evaluable, detail} | farmland + wheat + water all `satisfied: true` |
| `card_statuses` | {x001: status, x002: status, ...} | all `done` |

**Pass** = cards_done_count == cards_total AND acceptance_satisfied.
**Partial** = some cards done OR some predicates satisfied.
**Fail** = no cards created OR zero progress.

### Confound table (for the postmortem)

The point of multi-predicate acceptance is **attribution** when
something misses. The confound matrix per the colony plan:

| Outcome | What it suggests | Next action |
|---|---|---|
| All cards done + all 3 predicates satisfied | A6 supported on multi-domain tasks; per-card narrowness works | Move to Session 5c (multi-bot capstone variant) |
| All cards done + farmland predicate fails | Builder/farmer chain ran but till didn't cover the plot | Inspect farmer card body — was `mc till` invoked with the right area? |
| All cards done + wheat predicate fails | Tilled but didn't plant | Inspect farmer card body — was `mc plant` invoked? |
| All cards done + water predicate fails | Someone (probably builder) replaced the water source with dirt during pad-leveling | Inspect builder card body — did it overshoot when "leveling"? |
| Some cards blocked, others done | A6 inconclusive — narrow the postmortem to the blocked card's role | Read block reason; usually a verb-vocab gap |
| Mox blocks immediately on x001 | Profile setup gap (skills loaded? .env right?) | Re-run setup-pilot-mox-live.sh + preflight |
| No cards transition past `claimed` | Dispatcher not running or board filter wrong | Check /tmp/wheat-dispatcher-${RUN_ID}.log |

## Rollback / cleanup

```bash
# Stop everything trial-related
kill $(cat /tmp/wheat-runner-pid /tmp/wheat-dispatcher-pid) 2>/dev/null

# Clean the world (drops marks, removes the staged floor)
scripts/run-fixture.sh cleanup data/test-fixtures/colony/wheat_capstone.yaml

# Remove the pilot-mox profile if you want a clean slate
rm -rf ~/.hermes/profiles/pilot-mox
HERMES_HOME=~/.hermes hermes kanban boards delete wheat-capstone

# Live flint/mason/etc. and pilot-pip/zee are untouched
```

## Known limitations / open follow-ups

- **Hardcoded acceptance coords.** `wheat_graph.acceptance_predicates`
  hardcodes `(-54..-46, 64, 46..54)` for the 9×9 plot — matches the
  fixture's `(-55..-45, ...)` plot footprint shrunk by 1 cell on each
  side to give the till/plant a 1-block edge margin. If you move the
  fixture, update wheat_graph too (the runner doesn't re-bind from
  marks yet — that's a Session 5c+ improvement).
- **Sign predicate omitted.** The walkthrough's acceptance set includes
  a sign with the field name; we didn't ship a sign-placement card in
  the default graph because it adds a fifth domain (crafting +
  placement) and we want to isolate the multi-domain test before
  layering crafting on top.
- **No re-bind step.** `run_wheat_capstone.py` reads predicates as-is
  from the graph. If you change the fixture's mark coords, you must
  also update `wheat_graph.acceptance_predicates`. A future
  improvement would read mark coords from Tester at trial time and
  rewrite the region predicates accordingly.
- **Growth + harvest out of scope this trial.** Trial 1780842744 passed
  on the acceptance predicates (farmland, wheat blocks, water) but the
  deposit card was vacuous — `randomTickSpeed=0` on landfolk-test
  freezes crop growth, so no wheat matured before x004 ran. The full
  plant-then-grow-then-harvest-then-deposit cycle is owned by the
  production architecture documented in
  [`docs/architecture/scheduled-operations.md`](../../docs/architecture/scheduled-operations.md)
  — orchestrator-owned cron, role-assigned check cards, aging-priority
  registry. The capstone proves the worker-side narrow-scope claim;
  the orchestrator-side trial is a separate session.

## Differences trial 3 → wheat capstone

| Aspect | Trial 3 (two-bot) | Wheat capstone |
|---|---|---|
| Bodies | 2 (Pip + Zee) | 1 (Mox) |
| Cards | 13 | 4 |
| Acceptance | 1 predicate (`at_mark seed`) | 3 predicates (region + region + at_mark) |
| Falsifiability claim | mutex parallelism + handoff convergence | per-card scope reset on multi-domain task |
| Pilot profile(s) | pilot-pip + pilot-zee | pilot-mox |
| Board | `two-bot-demo` | `wheat-capstone` |
| Fixture | `data/test-fixtures/open/two_bot_base.yaml` | `data/test-fixtures/colony/wheat_capstone.yaml` |
| Runner | `run_two_bot_base.py` | `run_wheat_capstone.py` |
| Reset | `scripts/reset-open-test.sh` | `scripts/run-fixture.sh prep` + `scripts/preflight-wheat.sh` |
| Plot location | (300, 65, 300) — seed | (-50, 65, 50) — field_south |
| Wall time (expected) | ~25 min | ~25-40 min (single bot, but more domains) |
