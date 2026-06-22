# GoalChanged evidence matrix (gv2-2026-06-20-3)

Purpose: attribute recurring `The goal was changed before it could be completed!` errors before choosing pathfinder ownership policy. Confidence labels: **proven**, **strong**, **plausible**, **speculative**.

Sources: [`docs/devlog/genesis-v2-devlog.md`](../../devlog/genesis-v2-devlog.md) (2026-06-20 −3 postmortem), card-stories under `data/genesis-v2-runs/gv2-2026-06-20-3/card-stories/`, bot code paths below.

## Run-level claims

| Claim | Confidence | Evidence |
|-------|------------|----------|
| Residual GoalChanged on run −3 is same-body, in-process overlap (worker compound/sync verbs), not multi-agent | **Strong** | Devlog: sampled errors; competing in-flight = `tunnel` / `stair_down` / `fell_tree` / `collect` / `place_fill`; 0 manager overlap |
| Reactive tick caused GoalChanged flood on run −3 | **Disproven** | Devlog: `/observe` auto_action_log empty, 0 `reactive_deferred` on −3 (same seed −2 had heavy reactive) |
| Phase 0 reactive sync-gate validated by −3 GoalChanged drop | **Disproven** | ~70% rate drop attributed to run variance + Vec3 guard, not gate |
| Worker *stalls* (52 SUPERVISE) = terrain unreachability, not GoalChanged | **Strong** | Devlog CORRECTION 1; kanban_block reasons `unreachable`, canyon, forest |
| Single root cause for every GoalChanged string | **Speculative** | Multiple code paths call `setGoal(null)` or start second pathfind while first active |

## Card-story examples (agent-visible)

| Card | Bot | Pattern | Confidence | Notes |
|------|-----|---------|------------|-------|
| `t_ea40c3ff` | gatherer | `fell_tree` CLI timeout → burst of `move`/`goto_near` with goal-changed in `Why:` | **Strong** | Compound verb + rapid follow-on commands |
| `t_cc5d0923` | miner | `collect` 40s cap → `move` goal-changed within seconds | **Strong** | Long action then immediate nav |
| `t_96eb2dd1` | builder | `goto_near` / `move` / `pillar_up` interleaved; goal-changed while position shifts | **Plausible** | Agent reads as terrain/caves, not overlap |
| `t_69f89ac9` | miner | No goal-changed in trace; NAV_BLOCKED only | N/A | Stalls ≠ GoalChanged on this card |

## Code paths that can produce the symptom

| Mechanism | Location | Confidence as −3 driver | Test target |
|-----------|----------|---------------------------|-------------|
| Sync action clears bg pathfinder goal | `task-lifecycle.js` L319–322 | **Historically plausible**, now neutralized by 409 serialization | `goal-changed-overlap.test.js` L2 |
| Second sync/bg command without HTTP serialization | `task-lifecycle.js` | **Previously strong gap; now fixed** with 409 on overlapping sync/task actions | `goal-changed-overlap.test.js` + `task-lifecycle.test.js` |
| Compound verb internal pathfind + agent next `mc` | `road.js`, `excavation.js`, `_helpers.js` | **Strong** (devlog sampling) | L4 harness (pending) |
| CLI HTTP timeout while server still running | `bot/cli/http.mjs` | **Plausible** (`fell_tree` 30s timeout pattern) | L3 (pending) |
| Reactive `swimUp` / escape `setGoal(null)` | `reactive.js` | **Disproven on −3**; **plausible on −2** | Separate reactive tests |
| Manager sync-stuck cancel | `manager.js` ~1192–1196 | **Plausible** | Not traced in −3 JSONL |

## Reproduction ladder status

| Level | Intent | Status |
|-------|--------|--------|
| L1 | Mineflayer symptom + `describePathfinderError` passthrough | **Done** — `bot/test/middleware/goal-changed-overlap.test.js` |
| L2 | Sync dispatch calls `setGoal(null)` while bg task running; documents missing sync mutex | **Done** — same file |
| L3 | CLI timeout + overlapping server action attribution | **Partial** — `bot/test/cli/http.test.js` + `bot/test/cli/results.test.js` validate client abort classification and user hint (“may still finish on server”); full server-continues overlap harness still pending |
| L4 | Compound-like overlap harness | **Done** — same file (`fell_tree` in-flight blocks `move` with 409) |

### L2 results (2026-06-20)

- **Proven:** `dispatchAction` sync mode calls `pathfinder.setGoal(null)` when `currentTask.status === 'running'`. Any bg nav still pathfinding will see GoalChanged on the bg leg (or the sync leg if bg wins the race).
- **Updated:** Two concurrent sync actions are now rejected with **409**; `syncActionInFlight` is enforced at dispatch.
- **Proven:** `shouldDeferReaction` defers `flee_step` during sync but not `swim_up` — reactive deferral is narrow by design.

### L4 results (2026-06-20)

- **Proven:** A compound-like in-flight sync action (`fell_tree` harness) now blocks follow-on nav (`move`) with **409** instead of allowing overlap.
- **Remaining uncertainty:** This harness validates serialization policy and overlap prevention, but it does not yet reproduce the exact run-3 timeout race where CLI returns before server-side compound work finishes (L3 still pending).

### L3 baseline results (2026-06-20)

- **Proven:** CLI POST abort path returns `httpStatus=0` with no POST retry (`requestHttp` baseline).
- **Proven:** Agent-facing classification for aborted long actions includes explicit guidance that work may still finish on the server.
- **Remaining:** dedicated harness where server action is intentionally left running past client timeout and a second command attempts overlap.

## Decision gate (interim — after L2)

**Action serialization (A) is now landed in middleware tests.** Next, validate CLI-timeout overlap (L3) before committing to full nav arbiter (C):

1. Keep **409 BUSY** on overlapping `POST /action/*` while `syncActionInFlight` or while bg `currentTask.status === 'running'`.
2. Run **L3** to confirm whether CLI timeout + server-side continuation is the dominant run-3 pattern.
3. If L3 confirms, add client-side “wait for task” / cap alignment for compound verbs; only then decide whether a full nav arbiter is still required.

Reactive expansion remains **out of scope** for run-3 residual GoalChanged unless a new run shows `reactive_deferred` / auto_action_log activity.
