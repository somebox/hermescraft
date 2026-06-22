# Genesis v2 stabilization notes

Status: operator runbook supplement (2026-06). Indexed from [`README.md`](README.md). Complements [`target.md`](target.md) and the genesis-v2 devlog. Documents stabilization choices that are **evidence-gated** — not implemented in bot code until the next run proves site-prep + correct verbs were used and failures persist.

## Retro capture

- Operator runs `scripts/genesis-v2.sh retro` while agents are alive; `[RETRO]` cards file at elevated priority and are **not** body-pool gated.
- `retro_mode` in run `config.json` suppresses poller filing of SUPPLY, stock brief, MANAGE re-engage, site advisory, tool-error backstop blocks, and stall-supervise while retros are collected.
- `scripts/genesis-v2.sh stop` waits up to `RETRO_WAIT_DEFAULT_S` (240s) for all retros to reach `done`; incomplete IDs are printed and stop exits **3** unless `stop --force`.
- **`wait_for_retro_cards()` returns OK when `total == 0`** — stop without prior retro filing still passes wait. Before E1, capped runs that called `capture_run_artifacts` + `teardown_session` from the poller without a retro phase showed `retro_done: 0/0` (e.g. `gv2-2026-06-22-2`).
- **Implemented:** `ensure_retro_phase(run_id)` files retros when total==0, waits bounded, then capture — on poller **max-runtime cap** (`CAP_RETRO_WAIT_S=120`), **validate-abort**, and manual **`stop`** (not `--force`; default wait `RETRO_WAIT_DEFAULT_S=240`). Poller cap and validate-abort paths call `run_cap_score_bundle` after capture so `feedback-bundle.json` can exist post-teardown.
- **`compare_safe` does not fail on zero retros filed** — it gates `retro_pending > 0` and audit scope (`scripts/lib/gv2_metrics/summary.py`). A run can show `compare_safe: true` with `retro_done: 0/0`; card-gate E1 pass criteria require **`feedback-bundle.json` / `retro_count > 0`**, not compare_safe alone.

## Primitive motor changes (deferred)

Do **not** relax these contracts until scoped action logs from a run show workers followed site-prep + verb guidance and still failed at scale:

| Area | Module | Rationale |
|------|--------|-----------|
| Collect LOS / behind-wall | `bot/lib/actions/mining/collect/` | Intentional line-of-sight contract |
| Dig occlusion | `bot/lib/actions/mining/dig.js` | Same |
| Fill occupancy / wall misuse | `bot/lib/actions/building/place-bulk.js` | Occupied cells need explicit overwrite or clear |
| Door-aware nav | `move.js` vs `goto.js` | Prefer `move` in prompts first; engine split is deliberate |

After the next run, classify failures in scoped `artifacts/actions-*.jsonl` by verb and card title before opening engine PRs.

## Next-run classification (`verify-smoke`)

`scripts/genesis-v2-verify-smoke.sh` reports:

- RETRO completion from captured `board.json`
- Scoped verb error buckets (`place_fill`, `move`, `goto`, `collect`, `dig`, `withdraw`, `craft`, …)
- Craft failures with `observed_state.craft_diag.failure_origin` when present (runs after craft-diag JSONL landed in capture)

Use these buckets with card stories to decide whether the ceiling is still site-prep vs a primitive contract change.

## Structured worker cards + offline validation (2026-06)

- Planner/worker contract: `skills/genesis-v2-worker-card-schema.md` (minted on
  `colony-planner` / referenced by emergent mission SOUL).
- Read-only validation: `scripts/kanban validate-board`, `scripts/gv2-validate-cards.py`,
  library `scripts/lib/gv2_card_validator.py`.
- Exception tiers (comments before expensive blocks): `skills/genesis-v2-card-exceptions.md`
  + worker patches in `kanban-worker.md`.
- Post-run: `verify-smoke` prints validator compliance summary and scoped 503/disconnect
  counts — treat high 503 as a confound before judging gameplay outcomes.
- Control plane: poller skips new `[GENESIS2:SUPERVISE]` when the worker is already
  blocked with `card-review-needed:` / `schema-missing:` (planner review path).
- **Dispatch gate (implemented):** `block_invalid_ready_cards(run_id)` in `genesis2_lib.py`, hooked in
  `genesis-v2-poller.py` after `strip_worker_card_skills` and before `sync_body_pool_gates`:
  validate each `ready` colony worker card; block with `schema-missing: {first_error}` when invalid
  (prefix matches supervise dedup in `file_supervise_card`). Complements offline
  `scripts/gv2-validate-cards.py` — create/edit/Hermes promote can still race one tick before
  the poller runs.
- **E2 layer gates:** planner files `[VERIFY]` cards after L0/L1 CONSTRUCT with
  `depends_on:` + `kanban set-after` (see `skills/genesis-v2-worker-card-schema.md`).
  Validator enforces `gv2-verify-layer.py` in VERIFY bodies; base-layer CONSTRUCT with
  `source_truth: handoff` is a **hard error** (SCOUT-before-CONSTRUCT).
- **Worker preflight section parsing (E2 decision):** not implemented. Poller
  `block_invalid_ready_cards` + pilot CONSTRUCT template fields are the primary enforcement;
  workers are not required to parse `preflight:` blocks in E2.0 — revisit only if invalid
  cards still slip past the poller gate after E1 operator runs.
- **Template feedback:** after capture, `scripts/gv2-extract-template-deltas.py` scans RETRO
  bodies for `TEMPLATE_PATCH:` / `MISSING_PREFLIGHT:` / `PLAYBOOK_CANDIDATE:` and appends
  `data/genesis-v2/template-changelog.jsonl` (optional `--ingest-queue`).
- **validate-board scope:** live planner self-check should use repo-root
  `HERMES_KANBAN_BOARD=genesis-v2 scripts/kanban validate-board` (no `HERMESCRAFT_ROOT`).
  Post-run gates and the card-gate experiment use **`ready,running,done,todo`** on captured
  `board.json`, not `--status ready,todo` only.

## Evidence Loop phase 1 (2026-06)

Minimal experiment surface before deeper metrics tooling:

- **`--planner-model`** on `new-run` / `emergent-run` — bodiless profiles use planner model; workers use `--model`. Persisted in run `config.json`.
- **`emergent-run --spawn`** — operator-pinned easy-site control; `spawn_source` in config. **Evidence Loop three-way:** pin all arms (see runbook); do not rely on auto `find_good_spawn` for A/B.
- **Establishment ladder** — `scripts/gv2-establishment-ladder.py` + smoke WARN line; marks frozen under `artifacts/world/` at `stop`.

Readout precedence: establishment score → retro/503/MANAGE → scoped motor errors → `gv2_invalid`.
Operator protocol and decision table: [`docs/guides/genesis-v2-runbook.md`](../guides/genesis-v2-runbook.md) (Evidence Loop section).

Phase 2 (gated): extract `gv2_run_metrics.py`, tiered compliance, linter normalization, `gv2-run-report.py` — only after the three-way result.
