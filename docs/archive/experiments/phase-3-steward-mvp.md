# Phase 3 steward MVP — experiment log

**Date:** 2026-05-23  
**Scope:** Bootstrap headless `steward` profile + `landfolk-ops` kanban board (see [steward-mvp.md](../../design/phase-3/steward-mvp.md)).

## What was run locally

| Step | Result |
|------|--------|
| `scripts/setup-landfolk-profiles.sh` | Created `steward` profile, `landfolk-ops` board, profile descriptions, kanban config keys |
| `hermes -p steward skills reset kanban-orchestrator --restore --yes` | Bundled orchestrator skill installed |
| `hermes kanban --board landfolk-ops create "stockpile 64 cobble in treasury_main" --triage --assignee steward` | Card `t_76d8b7ca` in triage |
| `python3 scripts/ledger-update.py --dry-run` | OK (0 ops runs to fold — expected) |

## Smoke test acceptance (full path)

Not completed in this session — requires:

1. `hermes gateway start` (dispatcher + auto-decompose or `hermes kanban decompose t_76d8b7ca`)
2. Live bot bodies: flint + mason on production `world`, `MC_API_URL` / ports configured
3. Marks or inline coords for `treasury_main` and mining source in card bodies
4. Worker runs completing with `metadata.inventory_delta` / `metadata.chest_state`
5. `python3 scripts/ledger-update.py` updating `data/ops/logistics-ledger.yaml`

### Manual continuation

Prerequisites: bot(s) on the laptop connected to **192.168.1.202:25565**; profile `MC_API_URL` matches those ports; avoid overlapping Steve `run-steve.sh` and kanban workers on the same port.

**Solo Flint (current laptop default for ops testing):** see [Solo Flint ops](../../design/phase-3/steward-mvp.md#solo-flint-ops-testing-mode). Run `scripts/setup-landfolk-profiles.sh --solo-flint`, keep Flint bot on `:3002`, stop Landfolk agent before dispatch, use `hermes kanban log` (not `watch-agent.py`) for kanban workers.

```bash
hermes gateway start
hermes kanban --board landfolk-ops list
hermes kanban --board landfolk-ops decompose <task_id>   # if still in triage
hermes kanban --board landfolk-ops dispatch --dry-run
hermes kanban --board landfolk-ops log <task_id>
python3 scripts/ledger-update.py
```

**Wheat farm epic (2026-05-23):** parent `t_1fdfd13b`; children reassigned to flint and linked survey → craft → prep → harvest.

**Region epics (2026-05-24):** `t_efc1b9ef` (:base1: protect), `t_a89e5a86` (:wheat1: marker). Bodies in `data/ops/epic-*-body.yaml`. After decompose, link solo-flint chain: `craft → base create → base verify → prep → harvest → wheat region → wheat verify`.

**Legacy cobble smoke card:** `t_76d8b7ca` — archived or done; use a fresh triage card for supply/store retest.

## Notes

- Setup script auto-restores `kanban-worker` / `kanban-orchestrator` when missing (`--yes`).
- Steward uses read-only `MC_API_URL` (default `http://localhost:3001`) for surveys; workers use per-profile bot URLs.
- Phase 2 regression board `default` was not modified.

## Verdict

**Bootstrap PASS** — profiles, board, config, ledger poller, and triage seed card are in place. **Gameplay E2E PENDING** until gateway + bots run the decomposed supply/store chain.
