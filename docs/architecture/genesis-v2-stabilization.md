# Genesis v2 stabilization notes

Status: operator runbook supplement (2026-06). Indexed from [`README.md`](README.md). Complements [`target.md`](target.md) and the genesis-v2 devlog. Documents stabilization choices that are **evidence-gated** — not implemented in bot code until the next run proves site-prep + correct verbs were used and failures persist.

## Retro capture

- Operator runs `scripts/genesis-v2.sh retro` while agents are alive; `[RETRO]` cards file at elevated priority and are **not** body-pool gated.
- `retro_mode` in run `config.json` suppresses poller filing of SUPPLY, stock brief, MANAGE re-engage, site advisory, tool-error backstop blocks, and stall-supervise while retros are collected.
- `scripts/genesis-v2.sh stop` waits up to `RETRO_WAIT_DEFAULT_S` (240s) for all retros to reach `done`; incomplete IDs are printed and stop exits **3** unless `stop --force`.

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

## Evidence Loop phase 1 (2026-06)

Minimal experiment surface before deeper metrics tooling:

- **`--planner-model`** on `new-run` / `emergent-run` — bodiless profiles use planner model; workers use `--model`. Persisted in run `config.json`.
- **`emergent-run --spawn`** — operator-pinned easy-site control; `spawn_source` in config. **Evidence Loop three-way:** pin all arms (see runbook); do not rely on auto `find_good_spawn` for A/B.
- **Establishment ladder** — `scripts/gv2-establishment-ladder.py` + smoke WARN line; marks frozen under `artifacts/world/` at `stop`.

Readout precedence: establishment score → retro/503/MANAGE → scoped motor errors → `gv2_invalid`.
Operator protocol and decision table: [`docs/guides/genesis-v2-runbook.md`](../guides/genesis-v2-runbook.md) (Evidence Loop section).

Phase 2 (gated): extract `gv2_run_metrics.py`, tiered compliance, linter normalization, `gv2-run-report.py` — only after the three-way result.
