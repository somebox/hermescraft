# Two-bot trial 2 — prerequisite fixes checklist

Tick boxes as items land. Trial 2 doesn't run until every **P0** is green and **P1 graph + skills** decisions below are implemented.

Sources: [`2026-06-07-two-bot-trial-1-postmortem.md`](2026-06-07-two-bot-trial-1-postmortem.md), trial-1 packet under `data/postmortems/two-bot-base/trial-1780797829/`.

## Locked decisions (trial 2)

| Topic | Choice | Rationale |
|---|---|---|
| Pickaxe for Zee | **Option A — graph cards** | `z_nav_stash` + `z_withdraw_pickaxe` before `z_nav_stone` (symmetric with pip; matches fixture comment). |
| Sign for pip | **Withdraw with axe** | `p_withdraw_axe` body withdraws `wooden_axe` + `oak_sign` from `:chest_stash:` (no extra nav card). |
| Skills in scope | **Four agent bundles** | `agent-navigator`, `agent-crafter`, `agent-miner`, `agent-builder` + `minecraft-{navigation,chores,mining,building,survival}` + `kanban-worker`. Farmer not in this demo. |
| Parallelism proof | **Regression only** | Trial 1 showed 529s overlap; trial 2 focus is **full lanes + sign**. |

Graph: `prototypes/agent-arch/capstone/two_bot_base_graph.py` — **13 execute cards** (7 pip lane slugs + 6 zee lane slugs).

## P0 — load-bearing for trial 2

- [x] **Fix `mc collect` response shape** in `bot/lib/actions/mining/collect/execute.js`:
  - [x] Result message leads with inventory truth ("Collected I/N") not blocks broken; appends explicit gap diagnostic + actionable hint when `items_dropped_uncollected > 0`.
  - [x] Data fields added (alongside legacy names): `blocks_broken`, `items_collected_in_inventory`, `items_dropped_uncollected`, `inventory_gap` (boolean).
  - [x] Two Tier-1 contract tests in `bot/test/actions/mining-collect.test.js`:
    - "success envelope exposes postmortem-named alias fields" — arithmetic invariants on the new fields
    - "result message leads with inventory truth, not blocks broken" — regression test for the trial-1 misleading-headline pattern (asserts message starts with `Collected N/M`, contains "not picked up" diagnostic, contains an actionable hint).
  - [x] Existing 30 mining-collect tests still pass; total 32/32 green.
- [x] **Fix `agent-crafter.md` verb table** — `mc chest @MARK`, no `open` / `list_container`; mark vs `:colon:` body refs; `mc help` hint.
- [x] **Verb audit script** — `scripts/audit-skill-verbs.py` (§3 tables vs `registry.mjs`).
  - [x] Re-runs clean against `navigator,builder,crafter,miner`.
- [x] **Pilot profile config parity with flint** — `setup-pilot-pip-zee.sh` now writes `compression`, `memory`, `context`, `tool_output`, `terminal.env_passthrough`, `prompt_caching` sections matching live flint's tuned values. Trial 1 ran with defaults (no compression at 86k tokens); trial 2 will compress at 70% of 250k context. Re-run setup: `prototypes/agent-arch/setup-pilot-pip-zee.sh`.

## P1 — likely to surface during trial 2 if not landed

- [x] **`agent-miner.md`** — inventory truth after `mc collect`, dig + `pickup`, `dig_area` ≤32, `extraction_yield_low` escape.
- [x] **`agent-navigator.md`** — solid targets → `@MARK` or `move --near` / `goto_near` (not raw coords on chest cells).
- [x] **`minecraft-mining.md`** — one-line inventory caveat on `mc collect` (generic, not demo-specific).
- [x] **Zee pickaxe path (Option A)** — graph + tests updated (`z_nav_stash`, `z_withdraw_pickaxe`).
- [x] **Pip sign path** — `p_withdraw_axe` withdraws axe + sign; `p_sign` body references that withdraw.

Optional (not blocking trial 2):

- [x] **Cross-bot chat noise** — one line in `kanban-worker.md` (stuck-probe section).
- [ ] **Reduce `z_mine` quota** (e.g. 16 cobble) if trial 2 still stalls on drops — document in postmortem, not skill text.

## P2 — quality-of-life

- [ ] **`mc pickup` search radius** — bot-side + contract test.
- [ ] **Run-26 spawn crash** — Hermes `crashed` with no `state.db` session; trace dispatch boot path.

## P3 — operational hygiene

- [ ] **Proto dispatcher** — `scripts/proto-dispatcher.sh` or `--watch` starts dispatch loop.
- [ ] **`pytest --run-id`** — `pytest_addoption` in `prototypes/agent-arch/tests/conftest.py`.
- [ ] **`scripts/stop-bots.sh`** — Pip / Zee / Mox whitelist (or colony-owned kill).
- [ ] **Colony health PID** — stale process answering `/health`.
- [ ] **`hermes profile show --json`** — or parse text in setup verification.
- [x] **Live log follower** — `scripts/proto-logs-follow.py`. Polls each pilot's `state.db` `messages` table (proto rig stores sessions in sqlite, not `session_*.json`) and prints assistant thoughts, tool calls (`⚙`), tool responses (`↩`), and bot chat (`[bot]`) with per-profile color. Flags mirror `landfolk-logs-aggregate.py`: `--tail N`, `--no-follow`, `--no-color`, `--no-bot-logs`, `--no-dispatcher`, `--quiet`, `--reasoning`, `--no-timestamps`, `--poll`.

## Pre-flight checks for trial 2 (after P0 lands)

- [ ] `cd bot && HERMES_VALIDATE=1 npm test` — green (collect contract included).
- [ ] `pytest prototypes/agent-arch/tests/test_two_bot_base_graph.py` — 13-card topology green.
- [ ] `python scripts/audit-skill-verbs.py` — zero unknown verbs in four demo bundles:
  ```bash
  python scripts/audit-skill-verbs.py --bundles navigator,builder,crafter,miner
  ```
- [ ] `scripts/reset-open-test.sh` → `scripts/colony status` — pip, zee, mox up on `landfolk-test`.
- [ ] Manual smoke on Tester: staged cobble face, `mc collect cobblestone 5` — inventory matches reported gain.
- [ ] `hermes config check` — green against `HERMES_HOME=~/.hermes-proto-agent-arch` (catches any new config-version drift from the richer pilot config.yaml).
- [ ] Pilot `compression.enabled: true` confirmed in both `pilot-pip` and `pilot-zee` config.yaml after `setup-pilot-pip-zee.sh` re-run.

## Trial 2 success criteria

| # | Metric | Target | Notes |
|---|---|---|---|
| 1 | `parallelism_observed` | true (≥60s overlap) | Regression; already proven in trial 1. |
| 2 | `pip_done_count` / `zee_done_count` | **7/7** and **6/6** | Lane slug sets in `two_bot_base_graph.py`. |
| 3 | `sign_at_seed` | true | `mc verify at_mark seed --block oak_sign` on Tester :3004. |

**Pass** = (3) true and lane (2) complete. **Partial** = zee or pip lane mostly done with honest block reasons. **Fail** = cards never created or mutex/orchestration broken.

## Status

| Wave | Status | Notes |
|---|---|---|
| P0 | **done** | Collect fix + 2 contract tests landed; crafter + audit + pilot config parity all green. |
| P1 | mostly done | Graph 13-card + agent/miner/nav + mining caveat landed 2026-06-07. |
| P2 | not started | |
| P3 | not started | |

**Gate for trial 2 is OPEN.** Run the pre-flight checks above (re-run setup-pilot-pip-zee.sh; reset-open-test.sh; manual smoke `mc collect cobblestone 5` against staged cobble face), then launch.
