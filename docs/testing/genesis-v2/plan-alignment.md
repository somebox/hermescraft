# Competence scorecard — plan alignment (2026-06-22)

Cross-check against the Cursor plan `competence_scorecard_be8866bd.plan.md`. Plan frontmatter todos mark many items **completed**; this doc states what is actually shipped in v1, what was mis-specified, and what remains.

## First useful slice (plan exit criteria)

| Criterion | Status |
|-----------|--------|
| Fixture → `scorecard.json`, `postmortem.md`, `dashboard/index.html` | **Done** (`scripts/tests/fixtures/gv2-run-smoke/`) |
| Operational vs achievement + deterministic G-level | **Done** (minimal hero; full section table deferred) |
| [`genesis-v2-dev-loop.md`](../../guides/genesis-v2-dev-loop.md) for Improvement agent | **Partial** — core checklist + commands; §8–§9 shorter than plan |
| `next-actions.json` / queue express validation intent | **Done** (queue + `expected_metrics` on selected items → run config) |
| LLM judge / planner review / mid-run abort optional in slice | **Correct** — stubs only |

## Mis-specifications (plan vs repo)

| Plan says | Repo reality |
|-----------|--------------|
| Fleet index at `data/genesis-v2-runs/_index/index.html` only | **`_index.json`** + **`_index/index.html`** (HTML generated from JSON on score) |
| `run-nav.json` includes `same_arm_runs`, `next_run_id` | **Done** via `scripts/lib/gv2_run_nav.py` (requires `evidence_arm` on config for arm filter) |
| `card_story.py --artifacts-dir` regen | **Not implemented** — `--board-json` only |
| Per-card economics from `roadplan-card-metrics` + `kanban-runs.json` | **Proxy only** in `cards.py` (done=80 / else 20); no token/turn join |
| `motor.repeated_calls` with args hash + 5 min window | **Simplified** — agent-test streak on `(action, detail prefix)` |
| `fleet.active_mc_s`, idle gaps, lease utilization | **Partial** — `active_mc_pct` + `bots_used` stems only |
| `gv2-git-changelog.py` | **Inline** in `compare_enrich.py` (`git log rev_start..rev_stop`) |
| Dimension-weighted `overall` / letter `band` | **Level map** (G0–G5 → numeric overall) not full 6-dimension score |
| `operational.smoke` wired in score-run | **Done** (subprocess smoke; skip with `GV2_SCORE_SKIP_SMOKE=1`) |
| Poller validate hook | **Not wired** — `gv2-run-validate.py` exists, minimal predicates |
| LLM score judge + real planner-review | **Stubs** — prompts exist; no Hermes invocation |
| CI gv2 tests | **Done** — `.github/workflows/ci.yml` unittest slice |

## Phase completion (honest)

| Phase | Shipped | Missing |
|-------|---------|---------|
| **0** Post-stop readout | Ladder, smoke `--run-dir`, capture errors, fixtures, tooling-check | Smoke establishment WARN threshold (**added**); card `--artifacts-dir` |
| **1** Metric library | Core extractors, achievement YAML, audit fix | Full production `by_resource`, card effectiveness v1 formula, fleet idle |
| **2** End report | score-run, dashboard hero, queue, compare enrich, fleet index, chest snapshots | Kanban-runs export, full dashboard sections, postmortem markdown sections |
| **3** Mid-run validate | CLI + yaml skeleton | Poller hook, configurable predicates, abort teardown |
| **4** Learning loop | feedback-bundle, planner-review stub, stop `--score` chain | LLM paths, scorecard `feedback` link (**added**), devlog auto-append |
| **5–6** Consolidation | Shared motor metrics, docs | Smoke→motor dedupe, metrics-history (**added** jsonl), stress tier runs |

## Remaining work (priority)

1. **Validation run for queue** — `gv2-scope-coverage-metric` needs `validation_run_id` on a same-arm run after measurement fix.
2. **`evidence_arm` on emergent runs** — auto default at run start; override with `GV2_EVIDENCE_ARM` when pinning a custom protocol label.
3. **Kanban `task_runs` export** — **`artifacts/kanban-runs.json`** at capture; token join still pending.
4. **Poller `--validate-every-min`** — wired; sets `abort_reason` on config when validate exit ≥ 20.
5. **Dashboard sections** — hotspots table, worst cards, RETRO collapsible (read `data.json` client-side or server render).
6. **LLM judge / planner-review** — Hermes one-shot behind explicit flags (never override counts).

## Commands (canonical)

```bash
scripts/genesis-v2.sh stop --score   # feedback → score → planner-review → queue ingest
python3 scripts/gv2-score-run.py --run-dir data/genesis-v2-runs/<id>
open data/genesis-v2-runs/_index/index.html
```

See also [`competence-scorecard.md`](competence-scorecard.md) for schema fields.

## When to commit (gv2 measurement stack)

Commit **repo-tracked** artifacts when a logical slice is reviewable and CI-green — not after every local score of gitignored run dirs.

**Good commit boundaries:**

1. **Tooling + tests only** — scripts, `config/gv2-*.yaml`, fixtures under `scripts/tests/fixtures/`, docs, CI job; no `data/genesis-v2-runs/` (gitignored).
2. **One improvement theme** — e.g. “scope audit metric fix” or “poller validate default” — not mixed with unrelated bot or landfolk changes.
3. **After** `GV2_SCORE_SKIP_SMOKE=1 python3 -m unittest scripts.tests.test_gv2_* …` and `bash scripts/gv2-tooling-check.sh` pass locally (same as CI).
4. **Queue / run evidence** — update committed `data/genesis-v2/improvement-queue.json` when closing or verifying a WorkItem; cite `validation_run_id` in the item, not in the commit message alone.

**Do not commit:**

- `data/genesis-v2-runs/*`, `data/genesis-v2-metrics-history.jsonl`, `data/locations-base.json`, or regenerated run dashboards/scorecards from local runs.
- Half-finished plan todos unless the code matches the honest status in this file.

**Suggested split for the current uncommitted stack (if bundling for PR):**

- **PR A — Measurement MVP:** gv2 metrics, score-run, dashboard, fleet index, capture/kanban-runs, establishment ladder, smoke, CI slice, competence-scorecard + dev-loop + plan-alignment.
- **PR B — Loop wiring:** genesis-v2.sh (`stop --score`, validate defaults, evidence arm), poller validate hook, improvement-queue ingest, genesis2_lib metadata (optional if small enough to merge with A).

**When to commit relative to a validation run:** land code + tests first (`verified` on queue); run same-arm validation **after** merge or from the commit branch; set `validation_run_id` / `validated` in a **follow-up commit** once compare confirms (keeps “code change” and “experiment outcome” separable in git history).

