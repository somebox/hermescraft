# Two-bot trial 2 — prerequisite fixes checklist

> **Status: SUPERSEDED — both trial 2 and trial 3 PASSED.**
>
> | Trial | Run id | Date | Band | Postmortem |
> |---|---|---|---|---|
> | **2-B** | `trial-1780816982` | 2026-06-07 09:23 | **pass** ✅ | [trial 2 postmortem](2026-06-07-two-bot-trial-2-postmortem.md) |
> | **3** | `trial-1780821845` | 2026-06-07 10:44 | **pass** ✅ | [trial 3 postmortem](2026-06-07-two-bot-trial-3-postmortem.md) |
>
> Trial 3 also migrated to the **live HERMES_HOME** with cards on a
> dashboard-visible board (`two-bot-demo` at http://127.0.0.1:9119) —
> see [trial 3 runbook](two-bot-trial-3-runbook.md).
>
> This file is preserved as the historical record of what trial 2
> needed; checkmarks below reflect what landed in time. For trial 4+
> work, start from the trial 3 runbook + postmortem.

---

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

- [ ] **`mc pickup` search radius** — bot-side + contract test. *(Trial 2 + 3 didn't surface this — z_mine completed cleanly via the `mc collect` rewrite; pickup radius is no longer load-bearing for the demo. Still worth landing eventually.)*
- [ ] **Run-26 spawn crash** — Hermes `crashed` with no `state.db` session; trace dispatch boot path. *(Trial 2 + 3 had zero crashes — every card completed on first task_run. The original crash was tied to the trial-1 chest verb error, which the agent-crafter.md fix resolved. Watching status; closeable.)*
- [x] **`agent-builder.md` placement-reachability + cross-bot coordination** *(landed before trial 3; trial 3 confirmed the guidance helps at the margin but isn't strict enough — see trial 3 postmortem P1)*

## P3 — operational hygiene

- [ ] **Proto dispatcher** — `scripts/proto-dispatcher.sh` or `--watch` starts dispatch loop. *(Trial 3 still ran a hand-rolled bash loop. Works but operational debt.)*
- [ ] **`pytest --run-id`** — `pytest_addoption` in `prototypes/agent-arch/tests/conftest.py`. *(Still env-var-only — `TWO_BOT_RUN_ID=… pytest …`. Works fine for the runbook procedure; not blocking.)*
- [ ] **`scripts/stop-bots.sh`** — Pip / Zee / Mox whitelist (or colony-owned kill). *(Worked around by direct `kill` in the runbook.)*
- [ ] **Colony health PID** — stale process answering `/health`. *(Surfaced once in trial 2 prep; worked around by direct PID kill.)*
- [ ] **`hermes profile show --json`** — or parse text in setup verification. *(Confirmed: this Hermes version's `profile show` is text-only. The setup script's mandatory check reads the text output; works fine.)*
- [x] **Live log follower** — `scripts/proto-logs-follow.py`. Polls each pilot's `state.db` `messages` table and prints assistant thoughts, tool calls (`⚙`), tool responses (`↩`), and bot chat (`[bot]`) with per-profile color. Flags mirror `landfolk-logs-aggregate.py`. *Hardened in trial 2 with read-only `mode=ro` URI + busy_timeout to handle worker write contention.*
- [x] **`--board` flag through the runner** — `run_two_bot_base.py` + `author.py` accept `--board <name>`; runner auto-creates the board (idempotent). Made trial 3 dashboard-visible without touching the proto rig.
- [x] **Board-aware `_kanban_db()`** — both runner and handoff contract test honor the boards-per-tenant layout (`HERMES_HOME/kanban/boards/<name>/kanban.db`) when `--board` is set; falls back to flat layout otherwise.
- [x] **Live HERMES_HOME pilot setup** — `setup-pilot-pip-zee-live.sh` installs pilots into `~/.hermes/profiles/` without disturbing the live flint/mason/etc. fleet.

## Pre-flight checks for trial 2 (after P0 lands)

All validated in trial 2 + 3 launches.

- [x] `cd bot && HERMES_VALIDATE=1 npm test` — green (collect contract included).
- [x] `pytest prototypes/agent-arch/tests/test_two_bot_base_graph.py` — 13-card topology green (28 tests).
- [x] `python scripts/audit-skill-verbs.py` — zero unknown verbs in four demo bundles.
- [x] `scripts/reset-open-test.sh` → `scripts/colony status` — pip, zee, mox up on `landfolk-test`.
- [x] Manual smoke on Tester: staged cobble face, `mc collect cobblestone 5` → `"Collected N/5 cobblestone in inventory (mined N blocks)."` (new headline format; trial-1 misleading message gone).
- [x] `hermes config check` — green against `HERMES_HOME=~/.hermes-proto-agent-arch` AND `~/.hermes` (config version 27 ✓).
- [x] Pilot `compression.enabled: true` confirmed in both `pilot-pip` and `pilot-zee` config.yaml after `setup-pilot-pip-zee.sh` re-run.

## Trial 2 success criteria — all met

| # | Metric | Target | Trial 2-B | Trial 3 |
|---|---|---|---|---|
| 1 | `parallelism_observed` | true (≥60s overlap) | true / **591s** | true / **483s** |
| 2 | `pip_done_count` / `zee_done_count` | **7/7** and **6/6** | **7/7, 6/6** | **7/7, 6/6** |
| 3 | `sign_at_seed` | true | **true** | **true** |
| 4 | Handoff contract (`p_nav_wood → p_withdraw_wood`) | 2/2 pass | **2/2** | **2/2** |

**Pass** = (3) true and lane (2) complete. **Both trials passed.**

## Status

| Wave | Status | Notes |
|---|---|---|
| P0 | **done** | Collect fix + 2 contract tests landed; crafter + audit + pilot config parity all green. |
| P1 | **done** | Graph 13-card + agent/miner/nav + mining caveat landed 2026-06-07. agent-builder placement-reachability + cross-bot coordination landed before trial 3. |
| P2 | **partial** | `mc pickup` radius + run-26 spawn crash investigation not landed — neither blocked trial 2 or 3. Status: backlog. |
| P3 | **partial** | log follower + `--board` flag + live setup all landed. Operational items (dispatcher script, `pytest --run-id`, stop-bots whitelist, colony health PID, profile show --json) remain — none blocked the trials. |

**Trial 2 gate: OPEN → PASSED. Trial 3 gate: OPEN → PASSED.**

Falsifiability claims demonstrated across **three independent runs**, **two HERMES_HOME layouts**, **two workspace formats**. The architecture's headline value claim (mutex parallelism + cooperative handoff in vivo) is now closed for the v1 demo.

## Plan-vs-deliverable scan (from `~/.claude/plans/create-a-plan-that-magical-lovelace.md`)

| Plan item | Status |
|---|---|
| **Plan called for 10-card graph** | Shipped **13-card graph** per Option A pickaxe-fetch decision (`z_nav_stash` + `z_withdraw_pickaxe` added; `oak_sign` bundled into `p_withdraw_axe` so no separate fetch). |
| **Goal**: pip + zee both running, sign at seed | Met in trial 2-B and trial 3. |
| **3-number scorecard** | Implemented + scored in all 3 trials. |
| **Hard stop 1**: graph tests green | 28 graph tests pass; 0 regressions. |
| **Hard stop 2**: fixture inspect green | Reset script's preflight + inspect smoke ran every launch. |
| **Hard stop 3**: `hermes profile show --json` for pilots | `--json` doesn't exist for `profile show`; substituted with text-output verification (works). |
| **Phase 1 — promote miner** | Done. `skills/agent-miner.md` canonical. |
| **Phase 2 — fixture + reset** | Done + thickened floor stack after trial 1 surfaced single-block-floor issue (dirt @ Y=64 / 4×stone Y=63-60 / bedrock Y=59). |
| **Phase 3 — pilot profiles** | Done. Both `setup-pilot-pip-zee.sh` (proto) and `setup-pilot-pip-zee-live.sh` (live, added for trial 3) ship. |
| **Phase 4 — graph + author + runner + tests** | Done. Runner has the four planned modes plus `--board`. |
| **Live trial procedure** | Followed in all 3 trials. |
| **Pivot options** | None used — trials 2-B and 3 succeeded without pivoting. |
| **Risk 1** (mutex doesn't parallelise) | Confirmed mitigated: 529s/591s/483s overlap across the three trials. |
| **Risk 2** (bots fall into void on `/tp`) | Mitigated by `/forceload add` in prep step 1. |
| **Risk 3** (LLM picks wrong verb in narrow bundle) | Surfaced occasionally (e.g. `mc @Zee` in trial 2 p_build); recovered in 1-2 turns. |
| **Out of scope (kept out)** | Scout-seed script, full 7-checkpoint matrix, full handoff matrix, heartbeat/soft-resume, board-snapshot.json/task-events.sql dumps, tiers A+B as built-in modes, wide-flint baseline, `spawn-with-bot.sh` wired into live spawn — all still out of scope. |
| **Out of scope but built anyway** | `scripts/audit-skill-verbs.py` (built during trial 2 prep when bundle-verb drift surfaced). |
| **Estimate**: ~3.5-4 hours to first scorecard | Actuals: trial 1 ~30 min (operator-blocked), trial 2-B ~15.4 min, trial 3 ~15.85 min. Total elapsed since plan: several hours including iteration. |

**Nothing material from the plan went un-delivered.** The architecture's v1 falsifiability story is complete.

## What's next (not in this plan, but follow-ups noted in trial 3 postmortem)

- **`agent-builder.md` strict placement-reachability directive**: trial 3's z_build still spent 441s with placement-related errors despite the new bundle section. Tighten language from "use" to "MUST call before EVERY `mc place`".
- **Optional bot-side auto-pathfind in `mc place`**: would eliminate the NAV_BLOCKED-during-placement pattern at the source.
- **Wheat-farm capstone** (A6/A7): different question (single-bot multi-domain with wide-flint baseline). Plan exists at [`reports/agent-arch/2026-06-06-colony-validation-plan.md`](2026-06-06-colony-validation-plan.md).
