# Wheat W1 — role agents runbook

Architecture-correct single-bot wheat execute: four Hermes profiles
(`navigator`, `builder`, `farmer`, `crafter`), no `MC_*` in role `.env`,
`scripts/wheat-dispatcher.sh` injects Mox env at dispatch.

Setup matrix: [`wheat-w1-setup-matrix.md`](wheat-w1-setup-matrix.md).

Legacy pilot-mox path: [`wheat-capstone-runbook.md`](wheat-capstone-runbook.md).

Optional phase driver: `scripts/wheat-w1-trial.sh prep|live|evaluate|feedback|teardown`.

## Layout

| Concern | W1 |
|---|---|
| HERMES_HOME | `~/.hermes` |
| Profiles | `~/.hermes/profiles/{navigator,builder,farmer,crafter}` |
| Board | `wheat-capstone` |
| Bot | Mox (:3007); Tester (:3004) for verify |
| Dispatcher | `scripts/wheat-dispatcher.sh` (board-scoped) |

## A. Prep (offline gate — do not skip)

```bash
cd <hermescraft>
export HERMES_HOME=~/.hermes W1_MODE=role

scripts/reset-wheat-capstone.sh
prototypes/agent-arch/setup-role-profiles.sh
scripts/run-tester-bot.sh
MC_HOST=<your-mc-host> scripts/colony start mox
scripts/run-fixture.sh prep data/test-fixtures/colony/wheat_capstone.yaml
scripts/validate-wheat-fixture.sh
scripts/preflight-wheat.sh
prototypes/agent-arch/capstone/preflight.sh

HERMES_HOME=~/.hermes .venv/bin/python prototypes/agent-arch/capstone/run_wheat_capstone.py \
  --dry-run --board wheat-capstone

.venv/bin/python -m pytest \
  prototypes/agent-arch/tests/test_capstone_scaffold.py \
  prototypes/agent-arch/tests/test_w1_card_skills_contract.py \
  prototypes/agent-arch/tests/test_w1_handoff_x001_x002.py -q
```

**Pass:** all exit 0; dry-run “W1 shape checks passed”; handoff tests skip without `W1_RUN_ID` only.

## B. Live trial

```bash
RUN_ID=w1-$(date +%s)
DISPATCHER_LOG=/tmp/wheat-dispatcher-${RUN_ID}.log
echo "$RUN_ID" | tee /tmp/wheat-current-run-id

scripts/wheat-dispatcher.sh >>"$DISPATCHER_LOG" 2>&1 &
echo $! >/tmp/wheat-dispatcher-w1-pid

HERMES_HOME=~/.hermes .venv/bin/python prototypes/agent-arch/capstone/run_wheat_capstone.py \
  --run-id "$RUN_ID" --board wheat-capstone --watch
```

Monitor `http://127.0.0.1:9119` → board `wheat-capstone` until four cards terminal (~25–45 min).

## C. Collect results

```bash
HERMES_HOME=~/.hermes .venv/bin/python prototypes/agent-arch/capstone/run_wheat_capstone.py \
  --run-id "$RUN_ID" --evaluate-only

PACKET=data/postmortems/wheat-capstone/$RUN_ID
# Expect: manifest.json, telemetry.jsonl, scorecard.json
# evaluate-only runs scripts/prep-wheat-verify-observer.sh first (Tester tp near plot)

grep MC_API_URL "$DISPATCHER_LOG" | head -3

W1_RUN_ID="$RUN_ID" HERMES_HOME=~/.hermes .venv/bin/python -m pytest \
  prototypes/agent-arch/tests/test_w1_handoff_x001_x002.py -q
```

**Compare to** `w1-1780871693`:

| Field | Baseline | Target |
|---|---|---|
| `cards_done_count` | 4 | 4 |
| `acceptance_evaluable` | false | **true** |
| `per_predicate[].satisfied` (till/plant/water) | false | **true** if fixture intact |
| `architectural.handoff_x001_x002` | pass | pass |
| `architectural.distinct_worker_session_ids` | 4 | 4 |

Quick jq diff (optional):

```bash
jq '{done:.cards_done_count, eval:.acceptance_evaluable, arch:.architectural}' \
  data/postmortems/wheat-capstone/w1-1780871693/scorecard.json \
  "$PACKET/scorecard.json"
```

## D. Gather feedback (optional; dispatcher still up)

```bash
scripts/collect-trial-feedback.sh \
  --run-id "$RUN_ID" \
  --board wheat-capstone
```

Read `$PACKET/feedback-index.md`. Success = no repeat of top themes: manual MC export, `inspect --mark` missing, “only kanban-worker loaded”.

## E. Teardown

```bash
kill "$(cat /tmp/wheat-dispatcher-w1-pid 2>/dev/null)" 2>/dev/null || true
scripts/reset-wheat-capstone.sh
```

**Keep** `$PACKET/` for architecture evidence; do not archive before delta is recorded.

## F. After run — where to record

- Remediation complete: note new `RUN_ID` and acceptance band in team chat or `wheat-validation-ladder.md` stub.
- If partial again: paste `per_predicate[].detail` + link packet; open next remediation slice (not a full re-plan).
- W2 gate (wide baseline): only after functional + `acceptance_evaluable` true on a role-agent run.

## Re-run delta (vs `w1-1780871693`)

| Metric | `w1-1780871693` | Target |
|---|---|---|
| `acceptance_evaluable` | false | true |
| MC friction (feedback) | 4/4 | none |
| Skills complaint | 3/4 | none |
| Handoff | pass | pass |

Baseline packet: `data/postmortems/wheat-capstone/w1-1780871693/`.
