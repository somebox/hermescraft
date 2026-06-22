# Genesis-v2 competence scorecard (schema v1)

Machine-readable output: `<run>/scorecard.json` with `schema_version: 1`.

## Top-level fields

| Field | Description |
|-------|-------------|
| `run_id` | Run directory name |
| `metrics` | Deterministic extractors (time, motor, production, establishment, cards, fleet, board_quality, audit) |
| `summary` | Dashboard hero: operational vs achievement, expectations, compare, `achievement_level` |

## Achievement levels

Committed thresholds: [`config/gv2-achievement-levels.yaml`](../../../config/gv2-achievement-levels.yaml). Evaluator: `scripts/lib/gv2_metrics/achievement_level.py`.

Levels **G0–G5** are cumulative. Missing frozen chest snapshots caps production-related levels; see `missing_evidence[]` on `summary.achievement_level`.

## Card effectiveness (v1)

Proxy index on done vs blocked cards; `artifacts/kanban-runs.json` captured at stop supplies `wall_s` per card when present. Full token/turn join from `state.db` still deferred.

## Commands

```bash
scripts/genesis-v2.sh stop --score          # capture + score + dashboard (no LLM)
python3 scripts/gv2-score-run.py --run-dir data/genesis-v2-runs/<id>
python3 scripts/gv2-compare-runs.py --prev-run-id A --run-id B
python3 scripts/gv2-improvement-queue.py ingest --run-dir ...
bash scripts/genesis-v2-verify-smoke.sh --run-dir data/genesis-v2-runs/<id>
```

## Fleet index

After scoring, real runs under `data/genesis-v2-runs/` update:

- `data/genesis-v2-runs/_index.json` — last 50 runs (level, overall, compare_safe, spawn)
- `<run_id>/run-nav.json` — paths to scorecard, dashboard, feedback

Fixture/off-tree `--run-dir` scoring writes only per-run `run-nav.json` (no fleet index).

## Summary.compare (v1)

| Field | Meaning |
|-------|---------|
| `prev_run_id` / `baseline_run_id` | From run `config.json` (or inferred prev on score) |
| `compare_safe` | False when RETRO pending, scoped 503s, or bad action-log scope |
| `overall_delta_vs_prev` | Requires prior run’s `scorecard.json` |
| `overall_delta_vs_baseline` | Validation arm baseline scorecard |

`summary.what_changed`: `repo_commits` between `repo_rev_at_start` and `repo_rev_at_stop`; `config_vs_prev` key diffs vs previous run config.

Run start metadata (`apply_run_start_metadata`): sets `prev_run_id`, `repo_rev_at_start`, optional `GV2_TIER`, `GV2_LOOP_GOAL`, `GV2_EVIDENCE_ARM` on emergent/new-run; merges `expected_metrics` from queue items in `selected` / `in_progress`.

Plan vs implementation audit: [`plan-alignment.md`](plan-alignment.md).
