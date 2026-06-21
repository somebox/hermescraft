# genesis-v2 reset / new-run runbook

How to start a clean genesis-v2 colony run, and the full checklist of what a
reset must do — every item here exists because a past run broke without it. Each
row names the script that performs it and how to verify it took.

Primary commands:

```bash
bash scripts/genesis-v2.sh new-run --seed <int> [--world genesis2] [--model <id>] [--spawn X,Y,Z]
bash scripts/genesis-v2.sh emergent-run --seed <int> [--world genesis2] [--model <id>]
bash scripts/genesis-v2.sh retro
bash scripts/genesis-v2.sh stop
```

- `--seed` is required.
- `--spawn X,Y,Z` pins the colony center and skips the land-biome probe (operator
  vouches the coords are valid land). Without it, `find_good_spawn` rerolls the
  seed until the natural spawn is flat temperate land.
- Reuse a prior run's `seed`+`spawn` for an A/B test (e.g. `--seed 20276453
  --spawn 64,64,-64`).

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
| A1 | Kill prior poller | old poller acts on the about-to-be-archived board | `genesis-v2.sh` new-run (`pgrep -f genesis-v2-poller`) | `pgrep -f genesis-v2-poller` → only the new run's pid |
| A2 | Kill stale gateway workers | orphaned `slash_worker`s keep running prior-run cards | `genesis-v2.sh` (`pgrep -f tui_gateway.slash_worker`) | `pgrep -f slash_worker` → none from the old run |
| A3 | Bounce gateway `--replace` | the dispatch asyncio task can die silently; restart clears it + reloads `kanban.failure_limit` | `genesis-v2.sh` (`hermes gateway run --replace`) | gateway.log fresh; cards dispatch |

### B. Profile mint — fresh agent memory + correct env

| # | Item | Why | Where | Verify |
|---|------|-----|-------|--------|
| B1 | Clone + write SOUL/skills/.env/model (including re-sync of `skills/kanban-worker.md`) | specialist profiles from road-planner | `genesis-v2-mint-profiles.sh` | `[mint] done` line lists 8 profiles |
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

### E. Board reset and card assignment shape

| # | Item | Why | Where | Verify |
|---|------|-----|-------|--------|
| E1 | `reinit_board` — archive leftover cards + init | prior-run cards would dispatch into this run | `genesis2_lib.reinit_board` | board has only the freshly seeded cards |
| E2 | `seed_board` — P1 ready, P2–P5 parked (blocked), scout cards | poller-authoritative phase chain; epics never used as `parents` (deadlock) | `genesis2_lib.seed_board` | 5 epics + 4 scouts; P1 ready |
| E3 | `save_config` + `write_active` + `snapshot("start")` | run metadata + baseline | new-run python | `data/genesis-v2-runs/<id>/config.json` |

Role clarity in seeded flow:
- planner/orchestrator cards are bodiless (`colony-planner` / `colony-overseer`).
- worker cards are body-lease cards (`colony-scout/gatherer/builder/farmer/miner/road`).
- pool gating prevents race-spawning cards when no body is available.

### F. Runtime (deterministic, post-launch)

| # | Item | Why | Where | Verify |
|---|------|-----|-------|--------|
| F1 | Shelter render once `base_anchor` exists | bots built into terrain / couldn't exit | `genesis2_lib.maybe_render_shelter_for_run` (poller) | `cfg.shelter_rendered=True` |
| F2 | **Dry, solid foundation** — force cobble pad + drain water under/around the base | base sited over water drowned the colony | `shelter_setblock_commands` (foundation fill + `air replace water`) | no drowning; base walkable |
| F3 | **Chests pre-marked** — `chest_wood`+`chest_food` written at render | render PROVIDES the chests; BUILD churned ~20m trying to place a 2nd one it had no materials for | `genesis2_lib.mark_shelter_chests` | `mc marks` shows 2 `chest_*` at base |
| F3b | **Starter food pantry** — render rcon-stocks `chest_food` with `STARTER_FOOD_COUNT` bread + writes a render snapshot base-inventory reads | colony can't build a cooking loop early; bots starved + P2 dead-locked at `food 2/64` | `genesis2_lib.{shelter_setblock_commands,write_starter_provision_snapshot}` + `base-inventory.load_render_snapshots` | P2 food gate clears at boot; a later live chest snapshot supersedes the pantry |
| F4 | Poller skill-strip backstop | null `skills` on worker cards the planner poisoned + unblock | `strip_worker_card_skills` (poller step 1) | poller log "stripped … skills" (only if poisoned) |
| F5 | Gateway watchdog (no false-positive) | restart ONLY when ready work waits AND nothing is running (running>0 proves dispatch alive); `todo`-on-deps and ready-behind-a-full-pool are backpressure, not death — both thrashed the gateway + killed agents before this gate | `detect_dead_dispatch` (`ready>0 and running==0`) | ~0 restarts on a healthy run |
| F6 | SUPPLY cards target the resource SOURCE | "mine stone near base_anchor" wedged miners in the cramped shelter on a grass plain | `_supply_source` + `file_supply_card` | SUPPLY card body says `go_mark lt_stone_*`, not base |
| F7 | Reconcile marks, lease reap, pool-gate requeue, advance_phases, gate-gap/overseer, stall-supervise | poller-authoritative phase progression + recovery | `genesis-v2-poller.py` loop | poller log shows steps |

### G. Emergent-mode specifics (`emergent-run`)

| # | Item | Why | Where | Verify |
|---|------|-----|-------|--------|
| G1 | Seed one standing `[MISSION]` card only | no phase epics/gates in emergent mode | `seed_emergent_mission` | board has mission, no P1..P5 epics |
| G2 | Poller disables phase/render/supply auto-cards, keeps control-plane backstops | planner owns decomposition; poller still prevents deadlocks/stalls | `genesis-v2-poller.py` emergent branch | poller log prints emergent-mode line |
| G3 | Mission continuity uses same-card retry first | avoids MANAGE churn and preserves card continuity | `reengage_planner_if_mission_closed` | closed mission gets `retry`; fallback MANAGE only on retry failure |
| G4 | Planner mission protocol is terminal-per-turn | dispatcher requires complete/block on dispatched turns | `data/genesis-v2/emergent-mission.md`, `emergent-planner-soul.md` | no `protocol_violation`/`gave_up` loop on mission turn exits |

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
2. Stop poller + gateway workers + gateway + body processes.
3. Kill leaked board-tail watchers.

Verification:
- artifact dir exists: `data/genesis-v2-runs/<run-id>/artifacts`
- card-story dir exists: `data/genesis-v2-runs/<run-id>/card-stories`
- no live run processes: `pgrep -f 'genesis-v2-poller|tui_gateway.slash_worker|bot/server.js|hermes gateway'` returns nothing

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
