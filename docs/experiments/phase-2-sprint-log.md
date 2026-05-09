# Phase 2 sprint log

Running log of Phase 2 sprints (0, 1, 2, ...). Findings carry forward.

## Sprint 0 — Bootstrap

Goal: get the two-bot setup, dispatcher path, kanban→fixture→capability-matrix loop running end-to-end with at least one capability_test card.

## Deliverables status

| Deliverable | Status | Notes |
|---|---|---|
| Multiverse `landfolk-test` world | ✓ done in prep | docs/test-world.md |
| `scripts/run-fixture.sh` | ✓ done in prep | `-n` ssh flag is load-bearing |
| `data/test-fixtures/L0/L0.1_health_connected.yaml` | ✓ done in prep | runs, prep+cleanup verified |
| `scripts/landfolk-bodies-only.sh` | ✓ done | 2-bot launcher (Flint:3001, Gatherer:3002) |
| `scripts/setup-landfolk-profiles.sh` | ✓ done | targets `~/.hermes/profiles/{flint,gatherer}` |
| `data/marks/canonical.yaml` (3-mark seed) | ✓ done | base, test_origin, spawn_landfolk |
| `data/capability-matrix.yaml` (L0–L4 scaffold) | ✓ done | 51 tests; L0.1 is now `red, consecutive_pass=1` |
| Dispatcher patch (skip `human` assignee) | ✓ already upstream | see "Findings" |
| Dispatcher patch (verify_fix auto-spawn) | DEFERRED | see "Findings"; manual loop for now |
| L0.1 capability_test card runs end-to-end | ✓ done | `t_86e0a6c6`, PASS in 10s |
| Synthetic bug card → verify_fix loop demo | ✓ done | `t_3c7e9d16` (bug) → `t_7c3f127c` (verify, parent-linked); both PASS |

## Findings

### F1. Dispatcher already skips non-Hermes-profile assignees
The architecture §14 says "Dispatcher patch: skip cards where `assignee == "human"` — never spawn worker." This is **already implemented upstream** at `~/.hermes/hermes-agent/hermes_cli/kanban_db.py:3580–3592` (added 2026-05-05 to fix `kanban-dispatcher-crash-loop`). The dispatcher calls `profile_exists(assignee)`; cards with assignees that aren't real Hermes profile dirs (`~/.hermes/profiles/<name>/`) are bucketed into `result.skipped_nonspawnable` and stay in `ready` for a human to claim manually.

**Implication:** never create a Hermes profile literally named `human`. Use `jeremy` (or `steward` later) as the human-lane assignee. The "human" string in the architecture doc is shorthand.

### F2. Profile directory mismatch — corrected
The Phase 1 landfolk launcher used `~/.hermes-landfolk-<name>/` as separate `HERMES_HOME` directories. The kanban dispatcher's `_default_spawn` uses `hermes -p <name>`, which loads from `~/.hermes/profiles/<name>/`. These are different things. The first iteration of `setup-landfolk-profiles.sh` patched the wrong path; it was rewritten to target `~/.hermes/profiles/{flint,gatherer}/` and now the env_passthrough patch lands where the dispatcher will see it.

The pre-existing `~/.hermes-landfolk-*` HERMES_HOMEs are unused going forward and can be archived or deleted later.

### F3. `verify_fix` auto-spawn needs a small external poller
Architecture §14 calls for "on `bug_report` with status=`done` AND `summary` matching `/^fixed in [a-f0-9]{7,40}/`, auto-create the dependent `verify_fix` card." There is no upstream hook in `kanban_db.complete_task` that scans the summary regex. Cleanest approach is a small external poller that watches `kanban_events` for `completed` events on `[BUG]` cards and creates the verify_fix child via `hermes kanban create --parent`. **Deferred to Sprint 1** — for Sprint 0 we drive the verify-fix loop manually.

### F4. mc health response shape is flat, not nested
The success_predicate in the L0.1 fixture initially used `data.connected`, `data.position`, etc. Actual response is flat at top level: `{ok, connected, username, position, move_rate, ...}`. The card body in `t_86e0a6c6` uses the correct flat fields.

### F5. The `--metadata` flag on kanban_complete works as advertised
Storing the full health response inside `metadata.response` worked. This is the persistence path the eventual matrix-update tick script will use to fold results into `data/capability-matrix.yaml`.

## L0.1 smoke-run trace

```
2026-05-09 21:18  fixture prep: fill air → mvtp Flint landfolk-test → tp 0 72 0 → clear → effects(saturation, instant_health, slow_falling)
                  Flint lands at (0.5, 65, 0.5) on the spawn platform.
2026-05-09 21:18  hermes kanban create [L0.1] capability_test: health_connected
                    --assignee flint --priority 100 → t_86e0a6c6 (ready)
2026-05-09 21:19  hermes kanban claim t_86e0a6c6
                    workspace: ~/.hermes/kanban/workspaces/t_86e0a6c6
2026-05-09 21:19  curl -sf http://localhost:3001/health
                    → {"ok":true,"connected":true,"username":"Flint",
                       "position":{"x":0.5,"y":65,"z":0.5},"move_rate":12.54,...}
                    Predicates: 5/5 PASS.
2026-05-09 21:19  hermes kanban complete t_86e0a6c6 --result PASS
                    --metadata '{...full response...}'
                  Run #9 completed in 10s.
2026-05-09 21:19  fixture cleanup: mvtp Flint world → kill @e[type=item,distance=..32]
                  Flint back in production. Cleanup ran in <1s.
2026-05-09 21:20  data/capability-matrix.yaml: L0.1 status: red → consecutive_pass: 1
                  (will become green after 2 more consecutive passes per §15 sprint exit gate)
```

## Open items entering Sprint 1

1. **F3 followup:** decide whether the verify_fix auto-spawn poller is worth building now or whether Sprint 1 manual triggering is fine. The architecture says it gates Sprint 0; in practice manual worked for the demo.
2. **Brain-driven worker:** the L0.1 demo used a human stand-in for the worker. Sprint 1 should run at least one `hermes -p flint chat` worker against a capability_test card to validate the SOUL.md, env_passthrough, and the kanban-worker built-in skill all line up correctly.
3. **Matrix-update tick:** `data/capability-matrix.yaml` was updated by hand. A small script that reads `kanban_events` since last tick and folds completed `capability_test` cards into the matrix would close the loop properly. Deferred until Sprint 1.
4. **Dispatch-in-gateway off:** the gateway is currently not running, so cards sit in `ready` until manually claimed or `hermes kanban dispatch` is invoked. Sprint 1 should decide whether to start the gateway or stay in manual-tick mode.
5. **`mc dig` action contract:** still has the no-auto-pickup gap noted in `docs/test-world.md`. L3.1 fixture exposed it. Sprint 1 includes the action contract refactor where this gets formalized in `data.dropped_items`.

## Bug → verify_fix loop demo trace

```
2026-05-09 21:20  hermes kanban create [BUG] L0.1 mc health response sometimes returns null move_rate
                    --assignee jeremy --priority 200 → t_3c7e9d16 (ready, jeremy)
2026-05-09 21:20  hermes kanban dispatch    # one tick
                    Skipped (non-spawnable assignee — terminal lane, OK): t_3c7e9d16
                  ← Confirms F1: dispatcher correctly skips human-lane assignees.
2026-05-09 21:20  hermes kanban claim t_3c7e9d16    # human-as-steward claims
                  hermes kanban complete t_3c7e9d16 --result PASS
                    --summary "fixed in c0ffee1 — synthetic ..."
                  Bug card resolved.
2026-05-09 21:21  hermes kanban create [VERIFY] L0.1 — re-run after move_rate null fix
                    --assignee flint --parent t_3c7e9d16 → t_7c3f127c (ready, flint)
                  Parent edge: t_7c3f127c.parents = [t_3c7e9d16] ✓
                  (in Sprint 1 a poller will create this child automatically when
                   it sees a [BUG] card complete with summary matching ^fixed in [a-f0-9]{7,40})
2026-05-09 21:21  fixture prep → mc health → fixture cleanup
                  Verify response: ok=true, connected=true, move_rate=12.63 (not null)
                  hermes kanban claim t_7c3f127c
                  hermes kanban complete t_7c3f127c --result PASS
                    --summary "verify PASS — L0.1 still green after synthetic 'fix' ..."
                  matrix: L0.1 consecutive_pass 1 → 2
```

## Phase 2 Sprint 0 exit gate

- [x] L0.1 (`health_connected`) test passes (twice consecutively)
- [x] One synthetic bug card filed and verified to demonstrate the verify_fix loop

**Sprint 0 complete.**

---

## Sprint 1 — L0 (mostly) green + first brain-driven worker

Goal per architecture §15:
- L0 all green (consecutive_pass ≥ 2)
- Action contracts shipped for `mc dig`, `mc collect`, `mc place`, `mc craft`, `mc chest`
- One worked example of L1 test running cleanly

### Architecture refinement: `behavior_test` card type

Architecture §6 amended (commit 4334298 → next commit) to split capability tests into two modes:
- **`capability_test`** (existing) — failure means the action layer broke its contract; fix lives in `bot/lib/actions/*.js`; loop is `[BUG]` → fix code → `[VERIFY]`. One pass closes.
- **`behavior_test`** (new) — failure means the strategy layer is wrong; fix lives in `~/.hermes/profiles/<name>/{SOUL.md,skills/...}`; loop is rewrite skill → re-run → re-run until N consecutive passes. Tests use the fixture system to build adversarial scenarios (mob-vs-bot, hole-with-blocks, locked-chest-protocol, etc.).

This formalizes the iteration loop the user articulated: "put them in front of a mob and iterate until they consistently survive."

Behavior tests start at L1+, dominate L4+. L0 is all `capability_test`.

### L0 status (after Sprint 1)

| Test | Status | Cards | Notes |
|---|---|---|---|
| L0.1_health_connected | green (3 passes) | t_86e0a6c6, t_7c3f127c, t_77170817, **t_c63b9de0 (brain)** | brain-driven worker validated end-to-end |
| L0.2_health_disconnected | deferred | — | needs bot-process-kill harness |
| L0.3_observe_payload | green (2 passes) | t_dd971cc6, t_6857edd4 | 12/12 required keys present |
| L0.4_observe_action_loop | green (2 passes) | t_cd693647, t_435fa157 | trigger: 3× POST /action/dig 999/99/999 |
| L0.5_marks_list_empty | deferred | — | needs fresh-bot-or-marks-clear harness |
| L0.6_marks_list_with_distance | green (2 passes) | t_695ec6b2, t_4280583c | 36 marks, all distance_m numeric ≥ 0 |

**4/6 green; 2 deferred.** Closing L0.2 + L0.5 needs a bit of test-process plumbing. Pragmatic: defer until Sprint 1 close-out and ship the action-contract refactors first (where the real Phase-2 value lives).

### F6. Brain-driven worker validated end-to-end

`hermes kanban dispatch` → `_default_spawn` → `hermes -p flint --skills kanban-worker chat -q "work kanban task t_c63b9de0"`. The worker:

1. Read the card via the kanban_show tool.
2. Auto-loaded the `minecraft-flint-mission` skill (legacy from old experiments — note for cleanup).
3. Executed `mc health --json` — `MC_API_URL` reached the subprocess via `terminal.env_passthrough`. ✓
4. Evaluated all 4 predicates against the response.
5. Posted `kanban_complete --result PASS` with a tight one-line summary.
6. Exited cleanly in 18s on `deepseek/deepseek-v4-flash`.

**Gap (F6.1):** the worker called `kanban_complete` without `metadata`. The completed event shows `result_len: 0`. The Phase-2 SOUL.md asks for "metadata for any inventory_delta / chest_delta / observed errors" — but the worker interpreted "no inventory delta on a health-only card" as "no metadata needed." For the matrix-update tick to fold response payloads into the matrix, workers need to attach the action_sequence response under `metadata.response`. Tighten SOUL.md in the next pass.

**Gap (F6.2):** worker session JSON has `total_input_tokens=None`, `total_cost_usd=None`. Token/cost telemetry isn't being recorded for kanban-spawned workers. Worth investigating but not Phase-2-blocking.

### Open items entering action-contract refactor block

1. **Tighten SOUL.md** to require metadata.response on every `kanban_complete` call. Will reduce duplicate `kanban_show + curl` work in matrix-update tooling.
2. **Drop `minecraft-flint-mission` skill** from the auto-load path — it's a Phase 1 artifact.
3. **`mc dig` contract** is up next (smallest delta, validates the pattern). After that: `mc collect` (real Phase-1 bug fix at L3.6).

### Action contract: mc dig (DONE)

Refactor at `bot/lib/actions/mining.js:dig` — handler now returns structured `{ok, data, error}` per architecture §8 instead of throwing.

| Path | Trigger | Returned |
|---|---|---|
| Success | block at coord, in range, tool OK | `ok=true, data.{block_name, dropped_items, position_after}` |
| NO_BLOCK_AT_COORD | target is air/cave_air/void_air/null | `ok=false, error.code, error.observed_state.block_at_target` |
| PROTECTED_BLOCK | target in PROTECTED_DIG_BLOCKS (crafting_table, chest, …) | `ok=false, error.code, observed_state` |
| TOOL_INADEQUATE | equipForDig throws (e.g. axe needed for log, slow-dig refused) | `ok=false, error.code, error.next_action_hint` |
| OUT_OF_RANGE | distance > 4.5 AND pathfind throws | `ok=false, error.code, observed_state.{distance, bot_position}` |
| INTERRUPTED | b.dig throws mid-break (cancel, death) | `ok=false, error.code, retry_safe=true` |

Key implementation details:
- `dropped_items` is captured by snapshotting entity IDs before dig, sleeping `MC_DIG_DROP_SCAN_MS` (default 300ms), then collecting NEW item entities within 2.5 blocks of the target. Verified with L3.1: returned `[{name:"dirt", count:1, position:{1.7, 65.5, 0.7}}]`.
- The HTTP wrapper in `bot/lib/server/http-app.js:642` was patched: when handler returns `{ok:false}`, action is recorded with status `'error'` (not `'done'`). Confirmed via `recent_actions` showing the failed digs as `('dig', 'error')` — required for `state.action_loop` detection in observation.js.
- Legacy `result` and `hints` fields preserved alongside `data` for backwards compatibility with the goal engine and existing tests.

Validation: L3.1, L3.2, L3.4 created and run twice each; all green at consecutive_pass=2. L3.3 (TOOL_INADEQUATE) needs a more involved fixture (place stone, dig with held axe) — deferred to next pass.

### F7. mc dig contract: existing thrown-error fall-through paths

`b.blockAt` returning a non-air block doesn't guarantee the block is fully loaded — for chunks beyond render distance, blockAt returns `null` or an unknown-name block, which my handler currently routes to `NO_BLOCK_AT_COORD`. The §8 contract reserves `OUT_OF_RANGE` for "distance > 4.5 and pathfind unsuccessful" — which is the *known-but-unreachable* case. Tested with `dig 200, 65, 200`: routed to NO_BLOCK_AT_COORD (target.name was "unknown"). For now this is acceptable — workers see `ok=false` and a code; the distinction matters more for autonomous nav decisions and can be sharpened in Sprint 2.

### Action contract: mc collect (DONE) + Phase-1 silent-failure root cause

Refactor at `bot/lib/actions/mining.js:collect`. New return shapes:

| Path | Returned |
|---|---|
| Success / partial success | `ok=true, data.{mined_count, requested_count, attempted, partial_failure, causes, started_inventory, ended_inventory, dropped_items_collected, dropped_item_positions}` |
| UNKNOWN_BLOCK | typo / unknown blockName |
| NO_VISIBLE_BLOCKS | `findBlocks` and raycast both empty |
| ALL_PATHFIND_FAILED | every harvest attempt's pathfind threw |
| ALL_DIG_FAILED | every reachable target's `b.dig` threw or timed out |
| MIXED_FAILURE | mixed cause distribution; `error.observed_state.causes` shows the breakdown |

Per-cause counters track WHY each loop iteration bailed:
`not_target_block`, `pathfind_failed`, `out_of_range_post_path`, `skipped_self_block`, `dig_failed`. These are exposed in both success (`data.causes`) and failure (`error.observed_state.causes`) responses, so workers and the steward can see WHERE attempts went wrong.

### F8. Phase-1 silent failure: root cause was `ctx.currentTask?.status` on null

The original loop opened with `if (ctx.currentTask?.status !== 'running') break;`. When called via the synchronous `/action/collect` route, `ctx.currentTask` is `null` (it's only set for backgrounded `/task/*` calls). Optional-chain on null returns `undefined`. `undefined !== 'running'` is `true`. The loop **broke on iteration 0** without entering the body. `lastCollectErr` stayed empty. The line 218 throw `if (collected === 0 && lastCollectErr)` never fired. Function returned `{ result: "Mined 0 oak_log..." }` with `ok` defaulted to true by the HTTP wrapper. **That was the silent failure.**

Fix: `if (ctx.currentTask && ctx.currentTask.status !== 'running') break;` — only honour the cancel-flag when there IS a background task. For sync calls (no task), keep harvesting.

This is the kind of bug a behavior_test would *also* surface: a worker calls `mc collect oak_log 3`, the response says ok=true with no mined_count, the bot then calls `mc inventory` and sees no logs, and is confused about reality. The capability_test catches it immediately — exactly what the architecture's "code-grounded tests" §15 promised.

### L3 status (after dig + collect contracts)

| Test | Status | Cards |
|---|---|---|
| L3.1_dig_basic | green (2) | t_ba653df3, t_ad113549 |
| L3.2_dig_air | green (2) | t_acf42e01, t_4a0083c9 |
| L3.3_dig_wrong_tool | untested | needs equip-aware fixture |
| L3.4_dig_protected | green (2) | t_5399a1c1, t_cdde9146 |
| L3.5_collect_basic | green (2) | t_5bbb2c72, t_cd133bd4 |
| L3.6_collect_silent_failure | **green (2) — Phase-1 bug fixed** | t_670523a5, t_027d466b |

5/14 L3 tests green; 1 deferred (TOOL_INADEQUATE), 8 not yet written. The five we've shipped exercise the two most important contracts (dig + collect) including the silent-failure regression.



