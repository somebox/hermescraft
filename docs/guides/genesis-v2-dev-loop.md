# Genesis-v2 improvement dev loop

Canonical playbook for **Layer 3** (Improvement agent + operator): turn post-run artifacts into repo changes. Launch/stop remains [`genesis-v2-runbook.md`](genesis-v2-runbook.md). Metric definitions: [`../testing/genesis-v2/competence-scorecard.md`](../testing/genesis-v2/competence-scorecard.md). Plan audit: [`../testing/genesis-v2/plan-alignment.md`](../testing/genesis-v2/plan-alignment.md).

## §0 Achievement levels

Before selecting work, read `scorecard.summary.achievement_level` (or fleet `data/genesis-v2-runs/_index/index.html`).

**Evidence arm:** Each run gets `config.evidence_arm` at start (`default_evidence_arm()` or `GV2_EVIDENCE_ARM`). Use the same arm + `tier` for validation runs. Emergent runs may share an arm but differ in `mission_id` — do not treat establishment swings alone as regression.

- **Orient** on `current`, `next`, `target`, and `gaps`.
- **Strive** toward `target_achievement_level` via [`data/genesis-v2/improvement-queue.json`](../../data/genesis-v2/improvement-queue.json) (≤2 `selected` / `in_progress`).
- **Validate** on the same `evidence_arm` + `tier`; success = level advance or `expected_metrics` met.
- **Do not regress** on same-arm `compare_safe` runs without documenting a confound.

Thresholds: [`config/gv2-achievement-levels.yaml`](../../config/gv2-achievement-levels.yaml).

## 1. After every capped run

1. Open `<run_id>/dashboard/index.html` (or fleet index).
2. Read **compare.compare_safe** and **outcome_vs_expected** first.
3. Read operational vs achievement columns.
4. MC verb **hotspots** and **never_used_core** (in `scorecard.json` until dashboard tables land).
5. Worst cards → `card-stories/`.
6. `feedback-bundle.json` / RETRO vs `planner-review.json`.
7. Queue ingest (automatic on `stop --score`) or `gv2-improvement-queue.py ingest`; **select ≤2** items.
8. Implement → tests → `set-status verified`.
9. Schedule validation run; `gv2-compare-runs.py` → `validated` / `done`.

## 2. Commands

```bash
scripts/genesis-v2.sh stop --score   # feedback → score → planner-review → queue ingest
python3 scripts/gv2-score-run.py --run-id <id>
python3 scripts/gv2-collect-feedback.py --run-id <id>
python3 scripts/gv2-planner-review.py --run-id <id>
python3 scripts/gv2-improvement-queue.py list
bash scripts/genesis-v2-verify-smoke.sh --run-id <id>
bash scripts/genesis-v2-verify-smoke.sh --run-dir scripts/tests/fixtures/gv2-run-smoke
```

## 3. Work between cycles

Committed backlog: `data/genesis-v2/improvement-queue.json`. WorkItem fields include `work_id`, `status`, `lifts_level`, `target_gap`, `validation_run_id`.

```bash
python3 scripts/gv2-improvement-queue.py ingest --run-dir data/genesis-v2-runs/<id>
python3 scripts/gv2-improvement-queue.py select gv2-<work-id-a> gv2-<work-id-b>
python3 scripts/gv2-improvement-queue.py set-status gv2-<id> verified
```

WIP: ≤2 `selected` + `in_progress`. Next run picks up `expected_metrics` from selected queue items via `apply_run_start_metadata`. Set `GV2_EVIDENCE_ARM` and optional `GV2_VALIDATION_BASELINE_RUN_ID` when launching emergent runs. **`GV2_VALIDATE_EVERY_MIN`** defaults to **15** on `emergent-run` (live validate hook); use **`GV2_VALIDATE_EVERY_MIN=0`** to disable.

Only **Layer 3** edits the repo; Layer 2 scripts do not.

Never mark `done` on LLM opinion alone — require tests or compare-runs.

## 4. Escalate to human when

Confounded run needs product choice; tier/cap/arm change; schema v2; destructive ops; two failed validation cycles on the same gap.
