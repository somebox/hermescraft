# Phase 6 establish.explore re-test — success baseline

**Run:** 2026-06-02 ~19:36 → 21:15 (~100 min wallclock, manually stopped at success milestone).
**Bots:** Steward (orchestrator-loop), Flint, Mason, Gatherer, Barley (offline).
**Scenario:** `AUTO_REUSE=1 MATERIALIZE=0 scripts/establish-scenario.sh`.
**Companion:** [`ARCHITECTURE-FINDINGS.md`](../establish-2026-06-02/ARCHITECTURE-FINDINGS.md) (the prior diagnostic doc that produced the Phase 6 plan).

## Outcome

**First epic completed.** Steward archived `[EPIC] [ESTABLISH:BASE] Establish home base` at 20:46 (~70 min into the run) — the canonical "Phase 5 success" outcome. A second epic `[EPIC] [DEVELOP:BASE] Base shelter + furnishings` was created at 20:15 and was actively in flight at stop time (1/4 done, 2 in-flight, 1 ready).

This is the first establish run in the project's history where the orchestrator successfully decomposed, dispatched, and closed a multi-card phase without operator intervention.

## Phase 6 predicates vs Phase 5 run3 baseline

| Predicate | Phase 5 run3 (2026-06-02 morning) | Phase 6 run2 (this run) |
|---|---|---|
| Duplicate cards in any non-archived lane | **8** (4 originals + 4 dups in 77s) | **0** |
| Concurrent workers per bot at any time | up to 2 (gatherer SE+SW, flint chests, mason shelter) | **1 max** |
| `protocol_violation` events on the epic | 1 | **0** |
| `crashed` / `gave_up` events after bootstrap | many | **0** |
| `auto_blocked` events from dispatcher | several | **0** |
| First epic closed by Steward | no (run was stopped mid-decomposition) | **yes (archived at 70 min)** |
| Cards created with `parents=[…]` | 0 | **5 of 18 created** |
| Cards created with `idempotency_key=…` (Steward tool calls) | n/a (not in SOUL yet) | seen in session prompt, not yet used in every create — partial adoption |
| Gateway-embedded dispatcher firing | n/a (`dispatch_in_gateway: false`) | **yes — `kanban dispatcher: embedded in gateway, interval=60s, max_spawn=3`** |
| `landfolk-dispatcher.sh` PID alive | 0 (script wasn't running, mutex code dormant) | 0 (intentionally not started) |
| `hermes gateway` PID alive | 1 (incidentally; mutex bypassed) | **1 (intended — owns the dispatcher)** |
| Plugin `mutex_parked` / `mutex_released` events | 0 (hooks dormant) | **3 / 3** (hooks firing on tool-side `kanban_create`) |
| `goal was changed` errors | 1 (dual-claim symptom) | 17 (nav-internal during heavy traffic, *not* dual-claim — confirmed via 1-worker-per-bot pgrep) |
| `Unknown skill` errors | 6+ (run3 + run4 — `minecraft-scouting-site` typo) | **0** |

## Bug fixes that produced run2

Two fixes landed after run2's first attempt crashed within minutes:

1. **`data/establish/templates/establish-explore-cards.yaml`** — removed the non-existent `minecraft-scouting-site` skill from all 4 explore cards. Workers no longer crash with `Error: Unknown skill(s)` on spawn.

2. **`scripts/establish-seed-cards.py:84-91`** — after creating the epic, immediately call `_run_kanban(["reassign", epic_id, "orchestrator-tracker"])`. The non-profile assignee triggers Hermes's `skipped_nonspawnable` path (per `kanban-worker-lanes.md`), so the gateway-embedded dispatcher leaves the epic alone. Steward's continuous loop still finds it by tag, comments, decomposes children, and ultimately archives it — none of which require her to be the dispatched worker.

Both fixes are upstream-clean: no plugin changes, no patches to Hermes.

## Architecture as it actually runs (correct version of the picture)

```
                Operator (re44) / In-game chat
                            │
                            ▼
                   hermes gateway (single long-lived)
                  └── embedded kanban dispatcher
                       (max_spawn=3, interval=60s)
                       └── claim_task → _default_spawn
                            └── HERMES_KANBAN_TASK env → worker
                  │
                  │   tool-side kanban_create calls trigger:
                  ▼
                landfolk plugin post_tool_call hooks
                  └── _handle_create_or_unblock → mutex_park
                       on second ready card for same assignee

                Steward continuous agent-loop (separate process)
                  └── reads board, decomposes via kanban_create
                       (with parents=, idempotency_key= per SOUL)
                  └── comments on epic, marks it done when ready

                Workers (flint/mason/gatherer)
                  └── dispatched by gateway, work card, then exit
```

The **plugin's `post_tool_call` hooks ARE registered** when `kanban_create` is called via the MCP tool inside an agent session — not via the CLI subprocess. That's why my earlier diagnostic (α.3 CLI test showed no hook fire) was misleading: the hook IS load-bearing, just at a different layer than I thought. This run produced 3 `mutex_parked` and 3 `mutex_released` events — clean per-assignee serialisation, automatically, with no `landfolk-dispatcher.sh` running.

## What still needs work (deferred, not fixed)

These were observed during run2 but didn't block success; recording for future iteration:

- **Mason hit `iteration_budget_exhausted (150/150)` on the 9×9 pad construct.** This is the documented "31% of blocks are not real blockers" pattern from `landfolk-plugin.md` — the worker did work and self-blocked. Steward recovered by decomposing a `[SUPPLY] Deposit cobble, help finish pad` card for gatherer, and later archived the pad as done. Recovery happened, but the iteration-budget block is friction worth addressing (the `kanban_yield` primitive in the plugin's backlog).
- **`goal was changed` count: 17** across mc-{flint,mason,gatherer,steward}.log over 100 min. These are NOT dual-claim symptoms (verified via 1-worker-per-bot pgrep throughout the run) — they're in-worker navigation transitions during heavy traffic. Probably tied to #38a (NAV_BLOCKED) and #42 (goto_near cap). Independent of dispatch.
- **`orchestrator-tracker commented` shows up in event payloads** when Steward comments on the epic from her continuous loop. The `kanban_comment` author defaults to the card's assignee (which is now `orchestrator-tracker`) rather than the calling profile. Cosmetic; the comments themselves are Steward's.
- **`--idempotency-key` adoption is partial.** Steward's SOUL section mentions it, but session inspection shows it's not yet on every create call. Could be improved in a future SOUL iteration; for this run the dedup didn't matter because she didn't double-create.

## Recommendation — revise Phase 6 plan items

The plan as written ([planning-tracker.md Phase 6](../../docs/testing/procedural/planning-tracker.md#phase-6--upstream-alignment)) called for retiring both `scripts/landfolk-dispatcher.sh` AND `plugins/landfolk/`. This run shows that's only half right:

- **6.1, 6.2, 6.3, 6.4, 6.7 → DONE.** Gateway-embedded dispatcher works; bootstrap wires the gateway; Steward SOUL uses `parents`; auto_decompose stays false; re-test demonstrates success.
- **6.5 → REVISE.** Retire `scripts/landfolk-dispatcher.sh` (correct — it was racing the gateway and not running anyway). **KEEP `plugins/landfolk/`** — its `post_tool_call` hooks fire automatically when Steward calls `kanban_create` via tool, providing per-assignee mutex with no extra plumbing. Verified by the 3 `mutex_parked`/`mutex_released` events in this run.
- **6.6 (replace fleet-status.py with kanban diagnostics wrapper) → still pending.** Not blocking; can land in a follow-up.
- **6.8 (closure note) → this document satisfies it.**

## Timeline (run2 milestones)

| Time | Event |
|---|---|
| 19:36 | `scripts/establish-scenario.sh` started |
| 19:40 | Gateway up; embedded dispatcher logged `max_spawn=3, interval=60s` |
| 19:41 | Bootstrap complete: epic + 4 explore cards seeded |
| 19:48 | Flint closed NE explore (`t_89811a2e`) |
| 19:50 | Gatherer closed SE explore (`t_6039b0d8`) |
| 19:57 | Flint closed SW explore (`t_4d6641c3`); Mason closed NW explore |
| 19:58 | Mason claimed `[CONSTRUCT] Pad 9x9 cobble` (`t_6f3ad052`) |
| 20:08 | Steward created gather work (cobble, wood) — first cards with `parents=[…]` |
| 20:15 | Steward created `[EPIC] [DEVELOP:BASE] Base shelter + furnishings` |
| 20:35 | Gatherer closed gather-cobble, picked up "deposit cobble, help finish pad" |
| 20:40 | Mason hit `iteration_budget_exhausted` on pad; blocked herself |
| 20:46 | **Steward archived `[EPIC] [ESTABLISH:BASE]`** — first-ever orchestrator-driven epic completion |
| 20:46 | Mason claimed `[CONSTRUCT] Cabin walls + roof` (`t_9375fb8d`) |
| 21:15 | Manual stop for postmortem capture |

## Artifacts

- `kanban.db` — board state at stop (1 archived epic, 10 done, 1 ready, 3 running, 3 todo)
- `board-final.txt` / `fleet-status.txt` — runtime snapshots
- `t_*.log` — per-task session traces (worker cognition)
- `mc-*.log` — bot HTTP request/response logs
- `locations-*.json` — bot mark registries (real exploration output)
- `gateway.log` — embedded dispatcher tick history
