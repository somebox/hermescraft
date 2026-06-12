# W2 self-improve runbook (B+C)

Closed loop: execute → feedback → synthesize → IMPROVE → REVIEW → promote → execute with artifacts.

**Default execute lane:** `W2_GRAPH=w2` on the **capstone** fixture (`wheat_capstone.yaml`) — matches W2-AUTO script hooks and `wheat_plot` / `wheat_chest` marks.

**Optional stretch lane:** `W2_GRAPH=discovery` + `wheat_discovery.yaml` (explore + plan-live-verify). Use after the B+C loop works on capstone.

W1 reference: [`wheat-w1-role-runbook.md`](wheat-w1-role-runbook.md).

## Layout

| Concern | W2 |
|---|---|
| HERMES_HOME | `~/.hermes` |
| Execute profiles | W1: `navigator`, `builder`, `farmer`, `crafter` via `setup-role-profiles.sh` |
| Desk profiles | `engineer`, `overseer`, `planner` via `setup-*-w2.sh` (after smoke gate) |
| Board | `wheat-capstone` |
| Bots | Mox (:3007), Tester (:3004) |
| Dispatcher | `scripts/wheat-dispatcher.sh` — exports `MC_*` **and** `HERMESCRAFT_REPO` |
| Registry | `data/postmortems/wheat-capstone/_known_issues.json`, `_w2_artifacts.json` |

## Dispatcher policy (pick one — we use **A**)

| Policy | Behavior |
|---|---|
| **A (implemented)** | Dispatcher **runs continuously**. Seed IMPROVE/REVIEW only when **no** `[bot:mox]` card is `running`/`ready` (execute lane idle). Desk cards (no bot prefix) claim in parallel with idle Mox mutex. |
| B (not implemented) | Pause dispatcher during IMPROVE/REVIEW — would count as operator intervention in metrics unless documented as infra. |

Do **not** pause the dispatcher as the primary mechanism; sequence improve phases after `reset-execute` or when execute cards are terminal.

## Intervention taxonomy

**Infrastructure (never `manual_interventions`):** `prep-offline`, `teardown`, starting dispatcher, fixture prep, `wheat-w2-trial.sh` phase transitions, P0 fixes in repo.

**Forbidden (low-touch stretch):** mid-run card body edits, manifest threshold patches, manual `MC_API_URL=`, manual Tester tp during evaluate, re-run evaluate until pass.

---

## A. Prep (offline — do not skip)

```bash
cd <hermescraft>
export HERMES_HOME=~/.hermes HERMESCRAFT_REPO="$PWD"
export RUN_ID=w2-$(date +%s)
export MC_HOST=<your-mc-host>   # required for colony start

echo "$RUN_ID" | tee /tmp/wheat-current-run-id

# Full cold start: reset board, W1+W2 profiles, bots, fixture, validates, preflights, dry-run
scripts/wheat-w2-trial.sh prep-offline
```

**Pass:** validate + `preflight-wheat.sh` + `preflight-w2-p0.sh` + capstone `preflight.sh` exit 0; dry-run prints invocations for `--graph w2` (or your `W2_GRAPH`).

Re-run W1 profiles only (if already reset):

```bash
prototypes/agent-arch/setup-role-profiles.sh   # adds HERMESCRAFT_REPO to each role .env
```

---

## B. Start dispatcher (required before smoke / execute)

```bash
DISPATCHER_LOG=/tmp/wheat-dispatcher-${RUN_ID}.log
scripts/wheat-dispatcher.sh >>"$DISPATCHER_LOG" 2>&1 &
echo $! >/tmp/wheat-dispatcher-w2-pid

grep HERMESCRAFT_REPO "$DISPATCHER_LOG" | head -1   # must show repo path
```

Or: `W2_START_DISPATCHER=1 RUN_ID=... scripts/wheat-w2-trial.sh dispatcher`

---

## C. Smoke-script gate (before trusting desk profiles)

Run **after** dispatcher is up, **before** `run1`. Board should have no other `[bot:mox]` cards (use `prep-offline` or archive leftovers).

```bash
scripts/wheat-w2-trial.sh smoke-script
# Wait for navigator smoke card → done; log must contain: w2-smoke-ok

scripts/reset-wheat-execute-only.sh   # clears smoke card before run1
```

**Pass:** worker invoked `bash $HERMESCRAFT_REPO/data/workspace/production/scripts/_smoke_echo.sh` on turn ≤3.

---

## D. Live trial — minimum B+C loop (capstone / w2)

```bash
export W2_GRAPH=w2   # explicit; this is the default in wheat-w2-trial.sh

scripts/wheat-w2-trial.sh run1
# → create-only + watch + evaluate-only
# Packet: data/postmortems/wheat-capstone/$RUN_ID/

scripts/wheat-w2-trial.sh feedback1
scripts/wheat-w2-trial.sh synthesize1

# Optional stretch (plan-live-verify) — before improve1 if exploring discovery later:
# scripts/wheat-w2-trial.sh plan-verify
# Uses graph plan-verify only; does not replace run1 execute graph.

scripts/wheat-w2-trial.sh improve1
# Dispatcher claims engineer → overseer. When REVIEW done:
scripts/w2-promote-artifact.sh "$RUN_ID" W2-AUTO-001

scripts/wheat-w2-trial.sh reset-execute
scripts/wheat-w2-trial.sh run2    # w2_cycle=2; survey_cache hook if AUTO-003 promoted

scripts/wheat-w2-trial.sh feedback2
scripts/wheat-w2-trial.sh synthesize2
scripts/wheat-w2-trial.sh improve2   # targets W2-AUTO-003 (JSON cache)
scripts/w2-promote-artifact.sh "$RUN_ID" W2-AUTO-003

scripts/wheat-w2-trial.sh reset-execute
scripts/wheat-w2-trial.sh run3

scripts/wheat-w2-trial.sh report
# Writes w2-report.json — tier_minimum, tier_stretch_efficiency vs W2_BASELINE_RUN
```

Monitor board: `http://127.0.0.1:9119` → `wheat-capstone`.

---

## E. Discovery lane (optional)

```bash
export W2_GRAPH=discovery W2_FIXTURE=discovery
scripts/wheat-w2-trial.sh prep          # or full prep-offline with env set
scripts/wheat-w2-trial.sh run1
```

Acceptance is outcome-first (`chest_contains`); optional `farm_plan.json` in postmortem dir after planner cards.

---

## F. P0 (eval hygiene)

```bash
scripts/preflight-w2-p0.sh
# CI/offline: W2_P0_SKIP_LIVE=1 scripts/preflight-w2-p0.sh
```

Marks registry `W2-EVAL-TESTER` / `W2-EVAL-THRESHOLD` resolved when green.

---

## G. Teardown

```bash
scripts/wheat-w2-trial.sh teardown
```

Stops dispatcher pid file and runs `reset-wheat-capstone.sh`. **Keep** `data/postmortems/wheat-capstone/$RUN_ID/` for evidence.

---

## Tiered success (reminder)

| Tier | Criteria |
|---|---|
| Minimum | synthesize → IMPROVE → REVIEW → promote; verifier green; issue `resolved` |
| Stretch cycle 2 | W2-AUTO-003 survey-cache promoted |
| Stretch efficiency | run3 vs baseline wall time ≥10% lower **or** navigator survey skip |
| Stretch plan-verify | `pv002` metadata `verify_results`; playbook updated |

---

## Phase driver reference

`scripts/wheat-w2-trial.sh --help` — all phases including `prep-offline`, `dispatcher`, `plan-verify`, `report`, `teardown`.
