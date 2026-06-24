# genesis-v2 reset / new-run runbook

How to start a clean genesis-v2 colony run, and the full checklist of what a
reset must do — every item here exists because a past run broke without it. Each
row names the script that performs it and how to verify it took.

Primary commands:

```bash
bash scripts/genesis-v2.sh new-run --seed <int> [--world genesis2] [--model <id>] [--planner-model <id>] [--spawn X,Y,Z]
bash scripts/genesis-v2.sh emergent-run --seed <int> [--world genesis2] [--model <id>] [--planner-model <id>] [--spawn X,Y,Z]
bash scripts/genesis-v2.sh retro
bash scripts/genesis-v2.sh stop
```

- `--seed` is required.
- `--planner-model` sets LLM `default:` on bodiless `colony-planner` and `colony-overseer`; workers use `--model`. Omitted → same as `--model`. Recorded in run `config.json` as `worker_model` / `planner_model`.
- `--spawn X,Y,Z` pins the colony center and **skips `find_good_spawn` rerolls** (not the world reset — pinned launches still call `reset_world` + `restart_bodies`). Sets `spawn_source: pinned` in `config.json`; auto spawn sets `spawn_source: auto`.
- Without `--spawn`, `find_good_spawn` may reset+restart bodies up to 12× (~70–90s per attempt). Prefer `--spawn` for experiments and A/B runs.
- Reuse a prior run's `seed`+`spawn` for an A/B test (e.g. `--seed 91011 --spawn 0,69,0`).

`new-run` and `emergent-run` run synchronously through setup, then background the
poller and print `run <id> live`. Bodies + gateway + poller are nohup/Popen —
they survive shell exit.

Recommended operator sequence:

1. Start run (`new-run` for gated phase flow, `emergent-run` for planner-driven).
2. Let run proceed; use `status`/board views for checks.
3. Near end, call `retro` (while agents are still alive), wait ~3 minutes.
4. Call `stop` (captures artifacts/card-stories, then tears down poller+gateway+bodies).

---

## Reset checklist (what new-run must do, and why)

Ordered as `genesis-v2.sh new-run` executes. "Verify" = how to confirm it took
on a live run.

### A. Agent-layer shutdown — clear stale dispatch

| # | Item | Why (past failure) | Where | Verify |
|---|------|--------------------|-------|--------|
| A1 | Kill prior poller | old poller acts on the about-to-be-archived board | `gv2_shutdown_agent_layer` (`pgrep -f genesis-v2-poller`) | `pgrep -f genesis-v2-poller` → only the new run's pid |
| A2 | Kill stale gateway workers | orphaned `slash_worker`s keep running prior-run cards | `gv2_shutdown_agent_layer` (`pgrep -f tui_gateway.slash_worker`) | `pgrep -f slash_worker` → none from the old run |
| A3 | **`hermes gateway stop`** (not bare SIGTERM) | launchd can restart the gateway after SIGTERM while seed is still running → stale `genesis-v2` cards dispatch | `gv2_shutdown_agent_layer` | `pgrep -f 'hermes gateway'` empty; `hermes gateway status` not running |
| A4 | **Early `reinit_board`** before world reset | slow `find_good_spawn` must not leave prior-run cards on the board if a gateway leaks | `new-run` / `emergent-run` python (right after `next_run_id`) | launch log prints `early reinit_board`; mid-seed board has no ready cards from prior run |
| A5 | Start gateway **after** seed + mission/epics | dispatch only this run's cards | `new-run` / `emergent-run` python (`hermes gateway run --replace`) | gateway.log dispatch line after `run … live` |

### B. Profile mint — fresh agent memory + correct env

| # | Item | Why | Where | Verify |
|---|------|-----|-------|--------|
| B1 | Clone + write SOUL/skills/.env/model (including re-sync of `skills/kanban-worker.md`) | specialist profiles from road-planner; optional `--planner-model` for bodiless roles | `genesis-v2-mint-profiles.sh` | `[mint] done` line lists 8 profiles; `grep default ~/.hermes/profiles/colony-planner/config.yaml` vs worker |
| B2 | **Wipe agent memory/state** — `memories/*`, `MEMORY.md`, `state.db`(+wal/shm), `sessions/*`, `logs/agent.log` | cross-run contamination: a prior-run memory (`@23:12`) resurfaced in a later run because `state.db` (message history) was preserved | `genesis-v2-mint-profiles.sh` clean-slate block | `~/.hermes/profiles/colony-scout/`: `MEMORY.md`=0b, `memories/` empty, `state.db` small/absent (recreated ~4 KB on first agent boot), `logs/agent.log` reset |
| B3 | `env_passthrough` forwards `HERMES_BOT_LEASE*` to the `mc` subprocess | W1: workers had the var but `mc` never saw lease mode | `genesis-v2-mint-profiles.sh` config.yaml writer | `grep env_passthrough ~/.hermes/profiles/colony-miner/config.yaml` includes `HERMES_BOT_LEASE` |
| B4 | Lease mode (`HERMES_BOT_LEASE=1`, no `MC_API_URL`) for workers; planner/overseer bodiless | bodies are a shared pool, leased per card | mint `.env` writer | worker `.env` has `HERMES_BOT_LEASE=1`, no `MC_API_URL` |
| B5 | Planner rule 4: never set a `skills` field on a worker card | LLM attached its own `minecraft-steward-blueprint-plan` to builder cards → fatal `Unknown skill(s)` crash → blocked, killing the base chain | mint planner SOUL rule 4 + poller backstop (F-skills) | no `Unknown skill` in `kanban log` |

### C. Bodies — fresh, connected, correct env

| # | Item | Why | Where | Verify |
|---|------|-----|-------|--------|
| C1 | Source repo `.env` so bodies inherit `PAPERMCP_TOKEN` | without it the server-side craft fallback is off → ~half of tool crafts silently produce nothing (Paper 1.21 3×3 window race) | `genesis-v2.sh` top (`. .env`) | crafts succeed; `paperMcpConfig` non-null |
| C2 | Bring up 3 bodies (Mox:3007, Pip:3005, Zee:3006); kill stale port holder first | a crashed run's orphan bot holds the port and blocks the new one | `genesis-v2.sh` `ensure_body` | `wait_bodies_connected` → "all bodies connected" |
| C3 | **`MC_SUPPRESS_ADVISE_HINTS=1` on every body** | bot stuck/blocked hints kept pushing workers to `mc advise` (62 dead attempts/run); colony workers escalate via `kanban_block` | BOTH `genesis-v2.sh ensure_body` AND `genesis2_lib.restart_bodies` (reset path bypasses ensure_body) | `ps eww -p <body pid>` shows `MC_SUPPRESS_ADVISE_HINTS=1` on all 3 |
| C4 | Relaunch bodies on world reset | `reset_world` drops the bodies; clean restart beats auto-reconnect | `restart_bodies` (called by `--spawn` path and by `find_good_spawn` each reroll) | body process start-time ≈ run start |
| C5 | Confirm fresh, not a stale orphan | `/health` `connected:true` can be a leftover bot; trust the pid | `wait_bodies_connected` (+ restart kills by pid first) | spot-check: body pid `etime` small (started this run) |

### D. World reset

| # | Item | Why | Where | Verify |
|---|------|-----|-------|--------|
| D1 | `reset_world(seed)` | deterministic fresh world | `genesis2_lib.reset_world` | snapshot-start records seed |
| D2 | Spawn: pinned (`--spawn`) or `find_good_spawn` land reroll | base needs wood + water + buildable land, not ocean/desert/mountain | new-run python | run log prints spawn coords |
| D3 | `wipe_marks` | stale waypoints from prior runs contaminate marks/decisions | `genesis2_lib.wipe_marks` | `locations-base.json` has only this run's marks |
| D4 | `clear_pool_leases` | a prior worker may have leaked a lease → body locked for this run | `genesis2_lib.clear_pool_leases` | `mc bot status --pool` all `lease=None` |
| D5 | `wipe_world_mines` | stale mine-registry entries from another world | `genesis2_lib.wipe_world_mines` | `mines-world.json` empty for this world |
| D6 | `render_regions_world` | seeds the buildable `shelter` region placeholder | `genesis2_lib.render_regions_world` | `regions-world.json` has `shelter` |
| D7 | `world_setup` | forceload + gamerules (peaceful, no difficulty ramp) | `genesis2_lib.world_setup` | — |
| D8 | Observer (`re44` by default, `GENESIS_V2_OBSERVER`) | **Before** world delete: `evac_to_hub_before_world_reset` mvtp to hub (never kick). After `world_setup`: `setup_observer` mvtp back + spectator @ spawn; poller `ensure_observer_watching` if you join mid-run | `genesis2_lib.reset_world` + `world_setup` + poller | stay connected in hub during reset; auto-return to run world |

### E. Board reset and card assignment shape

| # | Item | Why | Where | Verify |
|---|------|-----|-------|--------|
| E1 | `reinit_board` — archive leftover cards + init | prior-run cards would dispatch into this run | early in boot python (A4) + board empty until seed | after `run … live`, board has only this run's cards |

**Naming:** checklist row **E1** above is boot-time **`reinit_board` only**. The **card-gate E1 experiment** (base preflight: poller `block_invalid_ready_cards`, cap-path **`ensure_retro_phase`**, pilot base CONSTRUCT validator rules) is a separate validation run — see [Card-gate E1 experiment](#card-gate-e1-experiment-base-preflight) below. Do not use the reset checklist E1 row as that experiment's pass/fail checklist.
| E2 | `seed_board` — P1 ready, P2–P5 parked (blocked), scout cards | poller-authoritative phase chain; epics never used as `parents` (deadlock) | `genesis2_lib.seed_board` | 5 epics + 4 scouts; P1 ready |
| E3 | `save_config` + `write_active` + `snapshot("start")` | run metadata + baseline | new-run python | `data/genesis-v2-runs/<id>/config.json` |

Role clarity in seeded flow:
- planner/orchestrator cards are bodiless (`colony-planner` / `colony-overseer`).
- worker cards are body-lease cards (`colony-scout/gatherer/builder/farmer/miner/road`).
- pool gating prevents race-spawning cards when no body is available.

### F. Runtime (deterministic, post-launch)

| # | Item | Why | Where | Verify |
|---|------|-----|-------|--------|
| F0 | Gateway up only after seed | see A5 | `genesis-v2.sh` python block | no `spawned=` in gateway.log between clean shutdown and `run … live` |
| F1 | Schematic shelter bootstrap once `base_anchor` exists | plan-backed build instead of monolithic rcon shell | `genesis2_lib.maybe_bootstrap_schematic_shelter_for_run` (poller) | `cfg.schematic_shelter_bootstrapped=True`; board shows L0→L4 CONSTRUCT/VERIFY chain |
| F2 | **Dry, solid foundation** — site prep pad only (cobble + drain water under footprint) | base sited over water drowned the colony | `shelter_site_prep_commands` via poller bootstrap | no drowning; footprint walkable before L0 CONSTRUCT |
| F3 | **Chest marks after schematic build** — `[CONSTRUCT] shelter storage chests + marks` card at tail of chain | P1 gate needs `chest_*` marks; plan has no chest cells | filed by `file_starter_shelter_sequence` | `mc marks` shows 2 `chest_*` after that card |
| F3b | *(optional)* **Reference paste** for ops review | compare world to plan without workers | `scripts/place-schematic-rcon.py starter_shelter --at …` | matches `mc blueprint verify` |
| F4 | Poller skill-strip backstop | null `skills` on worker cards the planner poisoned + unblock | `strip_worker_card_skills` (poller step 1) | poller log "stripped … skills" (only if poisoned) |
| F5 | Gateway watchdog (no false-positive) | restart ONLY when ready work waits AND nothing is running (running>0 proves dispatch alive); `todo`-on-deps and ready-behind-a-full-pool are backpressure, not death — both thrashed the gateway + killed agents before this gate | `detect_dead_dispatch` (`ready>0 and running==0`) | ~0 restarts on a healthy run |
| F6 | SUPPLY cards target the resource SOURCE | "mine stone near base_anchor" wedged miners in the cramped shelter on a grass plain | `_supply_source` + `file_supply_card` | SUPPLY card body says `go_mark lt_stone_*`, not base |
| F7 | Reconcile marks, lease reap, pool-gate requeue, advance_phases, gate-gap/overseer, stall-supervise | poller-authoritative phase progression + recovery | `genesis-v2-poller.py` loop | poller log shows steps |

### G. Emergent-mode specifics (`emergent-run`)

| # | Item | Why | Where | Verify |
|---|------|-----|-------|--------|
| G1 | Seed one standing `[MISSION]` card only | no phase epics/gates in emergent mode | `seed_emergent_mission` | board has mission, no P1..P5 epics |
| G2 | Poller disables phase/render/supply auto-cards, keeps control-plane backstops | planner owns decomposition; poller still prevents deadlocks/stalls. **Schematic shelter bootstrap** (plan patch + site prep + CONSTRUCT/VERIFY chain) still runs when `base_anchor` is set — same as phased F1. | `genesis-v2-poller.py` emergent branch | poller log prints emergent-mode line; schematic cards on board after anchor |
| G3 | Mission continuity uses same-card retry first | avoids MANAGE churn and preserves card continuity | `reengage_planner_if_mission_closed` | closed mission gets `retry`; fallback MANAGE only on retry failure |
| G4 | Planner mission protocol is terminal-per-turn | dispatcher requires complete/block on dispatched turns | `data/genesis-v2/emergent-mission.md`, `emergent-planner-soul.md` | no `protocol_violation`/`gave_up` loop on mission turn exits |
| G5 | Spawn: auto dry land or operator `--spawn` | same pin semantics as gated `new-run`; no water requirement on auto | `genesis-v2.sh` emergent-run | log shows pinned or dry land spawn; `config.json` has `spawn_source` |
| G6 | `evidence_arm` on config | same-arm compare for improvement loop | `apply_run_start_metadata` / `GV2_EVIDENCE_ARM` | `config.json` has `evidence_arm` (default `{tier}/{model}/{mode}[/spawn]`) |
| G7 | Mid-run validate (emergent default) | abort early on corrupt board / manage pile-up | poller `--validate-every-min` via **`GV2_VALIDATE_EVERY_MIN`** (default **15** on `emergent-run`, **0** on `new-run`; set **0** to disable) | poller log `validate live exit=…`; `config.abort_reason` if exit ≥ 20 |

Emergent vs gated (short):

| | Gated `new-run` | `emergent-run` |
|--|-----------------|----------------|
| Board seed | P1–P5 epics + scouts | Single `[MISSION]` |
| Spawn probe | Water required unless `--spawn` | Dry land unless `--spawn` |
| Shelter render / pantry | Yes (poller) | No |
| Regions template | `regions-world.template.json` | `regions-world.emergent.template.json` |

---

## Evidence Loop — three-way experiment (operator)

Use **pinned spawn on all three arms** so terrain/planner are the variables, not `find_good_spawn` reroll time. Each launch still **regenerates** `genesis2` via `reset_world` (clean world per run).

Readout order: **establishment ladder → retro/503/MANAGE → motor verb buckets → `gv2_invalid` (secondary).**

### Pre-flight (every arm)

From repo root:

```bash
hermes gateway stop --all 2>/dev/null || hermes gateway stop 2>/dev/null || true
pgrep -fl 'hermes gateway|genesis-v2-poller|tui_gateway.slash_worker'   # expect empty
curl -s http://127.0.0.1:3005/health | grep -q '"connected":true' && echo bodies ok
```

Launch should reach `run gv2-… live` in **~2–5 minutes** with `--spawn`. If it sits >10 minutes with no `live` line, abort (Ctrl+C), run pre-flight again, and do **not** start a second launch in parallel.

### Three runs (same seed; planner varies on arm 2)

Replace `<stronger-model-id>` with the operator-chosen planner model.

```bash
# Arm 1 — hard site baseline (seed 91011 natural spawn coords, no reroll loop)
bash scripts/genesis-v2.sh emergent-run --seed 91011 --spawn 0,69,0 --model xiaomi/mimo-v2.5

# Arm 2 — planner A/B (only change planner model)
bash scripts/genesis-v2.sh emergent-run --seed 91011 --spawn 0,69,0 --model xiaomi/mimo-v2.5 --planner-model '<stronger-model-id>'

# Arm 3 — easy pinned control
bash scripts/genesis-v2.sh emergent-run --seed 91011 --spawn 80,64,-19 --model xiaomi/mimo-v2.5
```

**Per arm:** let the run proceed → `bash scripts/genesis-v2.sh retro` (while agents alive, ~3 min) → `bash scripts/genesis-v2.sh stop` (use `stop --force` only if retro stuck). Record `run_id` from launch log or `scripts/genesis-v2.sh status`.

After each `stop`:

```bash
bash scripts/genesis-v2-verify-smoke.sh --run-id <id>
python3 scripts/gv2-establishment-ladder.py --run-id <id>
python3 scripts/gv2-establishment-ladder.py --run-id <id> --live-marks   # if stop predates world capture
```

Log results in a small table: `run_id | arm | spawn | planner_model | ladder score | smoke notes`.

**Do not** use bare `emergent-run --seed 91011` (no `--spawn`) for this experiment unless debugging `find_good_spawn` itself.

**Compliance warnings:** smoke `gv2_invalid` uses full validator on captured `done` cards;
`kanban add` only runs line-start `mc` lint. Numbered-list planner recipes inflate invalid
counts — do not use compliance alone for planner A/B. Compare runs with smoke’s status set
(`ready,running,done,todo`), not default `validate-board` (`ready,todo` only).

---

## Card-gate E1 experiment (base preflight)

**Not** reset checklist E1 (`reinit_board`). This experiment validates deterministic card
readiness before worker dispatch and retro capture on **poller cap / validate-abort** paths
(where manual `retro` → `stop` is easy to skip).

**Evidence arm (hold constant):** `standard/mimo-v2.5/emergent`, same pinned spawn as prior
`-22-*` arms, shared lease DB, normal capture/score tooling.

### Runtime hooks (card-gate E1)

Implemented in `scripts/genesis2_lib.py` + `scripts/genesis-v2-poller.py`:

- **`block_invalid_ready_cards(run_id)`** — after `strip_worker_card_skills`, before pool
  gates: for each `ready` colony worker card, run `validate_card()`; on failure,
  `block_card(..., "schema-missing: …")` (prefix must match supervise dedup). Skips control
  cards (`FEEDBACK`, `RETRO`, `MISSION`, `[GENESIS2:*]`).
- **`ensure_retro_phase(run_id)`** — if `retro_card_snapshot()["total"] == 0`, call
  `file_retro_cards()` then bounded `wait_for_retro_cards()` **before**
  `capture_run_artifacts` on: poller **max-runtime cap**, poller **validate abort**, and
  manual **`stop`** (not `--force`). Cap path uses **`CAP_RETRO_WAIT_S=120`**; manual stop
  default wait is **`RETRO_WAIT_DEFAULT_S=240`**. After capture on cap and validate-abort,
  the poller runs **`run_cap_score_bundle`** (`gv2-collect-feedback.py` +
  `gv2-score-run.py`) so `feedback-bundle.json` exists without a post-teardown `stop --score`.

**Known holes (document only):** create/edit/promote paths can still reach `ready` for one
tick; mid-run `gv2-run-validate.py` does **not** enforce card schema — poller gate is the lever.

### Board validation scope

From **repo root** (there is no `HERMESCRAFT_ROOT` env var in this repo):

```bash
HERMES_KANBAN_BOARD=genesis-v2 scripts/kanban validate-board --status ready,todo
```

Planner turn-end checks using **only** `ready,todo` missed invalid cards still in
`running`/`done` on runs such as `gv2-2026-06-22-2`. For experiment readout and smoke parity,
use full captured board scope:

```bash
python3 scripts/gv2-validate-cards.py \
  --board-json data/genesis-v2-runs/<run-id>/artifacts/board.json \
  --status ready,running,done,todo
```

Trust **scorecard `board_quality` + `base_viability`** for gates; smoke establishment WARN
can diverge when viability is score-only.

### Operator validation (card-gate E1 — checklist only, no live run here)

After a capped or manual **stop + score** on the evidence arm, record pass/fail against:

| Criterion | Pass signal |
|-----------|-------------|
| Board compliance (primary) | `gv2_invalid == 0` on `--status ready,running,done,todo` **or** every remaining invalid worker card was **`blocked` with `schema-missing:`** before any worker session (card-stories / block events). |
| Base CONSTRUCT at capture | No invalid **base-layer** CONSTRUCT still in `ready`. |
| Retro bundle | `artifacts/feedback-bundle.json` with **`retro_count > 0`** (requires score step on cap or manual `stop --score`). Postmortem/dashboard retro total **not** `0/0` unless debug skip documented. |
| Audit | `compare.compare_safe == true` — **does not** prove retros ran; both `-22-1` and `-22-2` had `retro_done: 0/0` with `compare_safe: true`. |
| Base viability | `base_viability` still **fail-closed** on bad L0; **shell/establishment improvement is not required** for experiment success. |
| Block rate | Count poller `schema-missing:` blocks per run — high rate ⇒ template/planner work, not gate failure. |

**Confounds to note in postmortem:** Tester `actions-*.jsonl` in artifacts (motor metrics),
smoke WARN vs scorecard establishment, stale devlog card-count prose.

**Do not** treat planner-only `validate-board --status ready,todo` as sufficient for this experiment.

### Decision gates (after three-way)

| Outcome | Next investment |
|---------|-----------------|
| Planner helps on 91011 and easy pinned succeeds | Stronger planner / routing; targeted motor work |
| Planner helps cards but 91011 fails; easy succeeds | Motor/nav/construct-positioning |
| Planner unchanged; easy succeeds | Terrain dominates 91011 |
| Easy pinned fails | Worker loop / sync / skills before terrain |
| Sync/move spin on chest chains across runs | Motor backstop (pad rule + sync cancel) |

---

## Keep these three aligned (goals ↔ farm ↔ pantry)

A supply target with no matching production path dead-locks its phase gate. The
food trio must move together:
- `data/base-goals.yaml` **`food.target_min`** (the P2 gate; currently 16)
- `genesis2_lib` **`STARTER_FOOD_COUNT`** (render pantry bootstrap; intentionally lower than target_min is allowed, but the gap must be closed by early farm/cook cards)
- the P2 **FARM card plot size** (should yield ~the target per 1–2 harvests; a
  ~5×5–6×6 wheat plot ≈ 8–12 bread)

Same logic applies to wood/stone/coal targets vs the colony's gather/mine
throughput — don't set a benchmark the workers can't reach in a run.

## Known remaining ceilings (not reset issues — awareness)

- **Craft window-race** (Paper 1.21 3×3 table, mineflayer #3399): native `b.craft` lands only ~1-in-5 attempts. **Mitigated** (gv2-2026-06-17-4): `crafting.js` now does the reliable PaperMCP server-side craft FIRST for bench recipes when PaperMCP is configured (`paperMcpConfig()` non-null), skipping the racy 6× native loop; bodies without PaperMCP fall back to native retries. Compounding factor: a bot stuck in water can't hold still to craft at all — keep the base on dry ground (F2/water-safety).
- **P4 (roads) gate is implemented** — `lt_far` = ≥2 `lt_*` marks ≥`far_distance` (64) blocks from `base_anchor` (distance calc), and `roads` = ≥1 `road_*` mark (ROAD cards mark after the roadplan stake+torch loop). It closes once a road is staked + marked.
- **P5 (steady-state) gate is NOT implemented** — `check_phases` returns "steady_state gate not yet implemented" (it needs a base-stock time-series over a ~30-min window). The colony stops at P5 until that's built; P4 and below run end-to-end.
- **Planner SUPERVISE diagnoses can be wrong** — it once called a stuck-but-working miner a "systemic lease failure". Treat its diagnoses as hypotheses; check the body log (`/tmp/<user>-bot.log`) for ground truth.

## Stop and postmortem capture checklist

`scripts/genesis-v2.sh stop` is the canonical shutdown path.

It must do this order:

1. Capture artifacts first (`capture_run_artifacts`) while profiles/session DB/logs are still present.
2. Stop poller + gateway workers + gateway (`gv2_shutdown_agent_layer`) + body processes.
3. Kill leaked board-tail watchers.

Verification:
- artifact dir exists: `data/genesis-v2-runs/<run-id>/artifacts`
- card-story dir exists: `data/genesis-v2-runs/<run-id>/card-stories`
- no live run processes: `pgrep -f 'genesis-v2-poller|tui_gateway.slash_worker|bot/server.js|hermes gateway'` returns nothing

Post-stop scoring (measurement loop):

```bash
scripts/genesis-v2.sh stop --score   # capture artifacts, then deterministic score + dashboard
# or manually:
python3 scripts/gv2-score-run.py --run-id <run-id>
# open data/genesis-v2-runs/<run-id>/dashboard/index.html
bash scripts/genesis-v2-verify-smoke.sh --run-id <run-id>
```

Interpretation and improvement work: [`genesis-v2-dev-loop.md`](genesis-v2-dev-loop.md).

## Recurring failures and current coverage

From recent `docs/devlog/genesis-v2-devlog.md` runs:

- **Gateway dispatch death / silent stalls**
  - Covered by gateway watchdog + restart cooldown in poller.
- **Leaked body leases / no-free-body deadlocks**
  - Covered by boot `clear_pool_leases`, runtime orphan reap, and deferred requeue.
- **Mission protocol churn in emergent mode**
  - Covered by same-card mission retry-first continuity and terminal-per-turn mission protocol text.
- **Cross-run memory contamination**
  - Covered by mint-time profile memory/session/state.db wipe.
- **Craft window race**
  - Covered by PaperMCP-first bench craft path; body env wiring keeps token available.

Still not fully solved (requires further design/code work):
- dense-forest navigation stalls and terrain-unreachability plateaus,
- complete stock truth enforcement (`stored/reachable/withdrawable`) in gating,
- full P5 steady-state gate implementation.

## Operator guardrails (from devlog regressions)

- Use `scripts/kanban` as the default board surface; avoid ad-hoc SQL and mixed
  legacy command variants during runs.
- Prefer bounded worker recovery + `kanban_block` over live terminal command loops
  (`for ... mc ...`) when a card is stuck.
- Avoid mid-run manual body surgery (`tp`, hand-fed crafting/debug commands) except
  for explicit operator-only recovery incidents; capture these as `[BUG]`/`[INCIDENT]`.
- Keep troubleshooting evidence in board comments and captured run artifacts first;
  do not rely on in-session log spelunking as the primary workflow.

## Quick post-launch verification (one pass)

```bash
# bodies fresh + advise-suppressed
for p in $(pgrep -f bot/server.js); do ps eww -p $p | tr ' ' '\n' | grep -E 'API_PORT|MC_SUPPRESS_ADVISE_HINTS'; done
# memory wiped (scout) — recreated state.db is fine
ls -la ~/.hermes/profiles/colony-scout/{MEMORY.md,memories,state.db}
# board seeded; poller running
hermes kanban --board genesis-v2 stats; pgrep -f genesis-v2-poller
# advise attempts should stay ~0
grep -c 'mc advise' /tmp/{mox,pip,zee}-bot.log
```
