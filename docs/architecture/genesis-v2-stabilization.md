# Genesis v2 stabilization notes

Status: operator runbook supplement (2026-06). Complements [`target.md`](target.md) and the genesis-v2 devlog. Documents stabilization choices that are **evidence-gated** — not implemented in bot code until the next run proves site-prep + correct verbs were used and failures persist.

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
