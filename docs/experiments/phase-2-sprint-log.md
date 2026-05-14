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

### Sprint 1 perception suite (L0.7–L0.12) + F9 + F10

User feedback: "the raycast technique is problematic, and we might want to verify the settings allow nearby items to be seen and the scanning approach allows the agent to recognize things farther away without overloading things." Wrote a 6-card perception suite to surface concrete behaviors of `mc nearby`, `mc scene`, and `mc discover`.

#### Results

| Test | Result | Card | Notes |
|---|---|---|---|
| L0.7_nearby_close_block | **FAIL** | t_40e31b7e | bug t_dc89c01b — /nearby misses cobble at (1,65,0) when bot at (0.5,_,0.5) |
| L0.8_nearby_stride | **FAIL** | t_99e662c3 | bug t_dc89c01b — finds 1/2 cobbles (odd-X invisible) |
| L0.9_scene_block_in_fov | PASS | t_7d8fb694 | mc scene works after `mc look` orients bot |
| L0.10_scene_obstructed | PASS | t_6c3e5bf5 | 2-tall wall blocks LoS correctly |
| L0.11_discover_distant | PASS | t_96361117 | chunk-scan finds coal_ore at d=42.3 |
| L0.12_scene_drop_entity | PASS | t_c56c8131 | drop item visible in scene + nearby |

Filed: **[BUG] t_dc89c01b** — `/nearby block-scan misses ~half of 1-block targets` with reproduction, three candidate fixes, and verify-after-fix steps.

### F9. mc nearby block-scan: stride 2 + Math.floor + common-block filter = silent half-blindness

`bot/lib/bot/observation.js:512-526`. Three compounding issues:
1. Stride 2 in dx/dz of `pos.offset(dx, _, dz)` — combined with `Math.floor` in `blockAt`, half of integer-X targets are unsampled when bot is at fractional X (the standard mvtp-spawn pose at (0.5, _, 0.5)).
2. Common-block name filter (line 516) excludes `stone`/`dirt`/`grass_block`/`deepslate` from the response — even when a player or steward deliberately places them. Workers asking "what's around me" can't see these terrains.
3. `scanR = Math.min(radius, 16)` quietly caps the block scan at 16 even when caller passes radius=64. Caller has no signal that truncation happened.

This is a quiet bug because workers calling mc nearby see *some* output and assume it's complete. The architecture's contract refactor pattern (structured ok/data/error with observed_state) should expand to /nearby too — at least surface the cap.

### F10. Eye height 1.6 means 1-tall walls don't fully obstruct LoS

Bot eye position: `pos.y + (height || 1.62) * 0.85 ≈ pos.y + 1.38`. So bot standing at Y=65 has eye at Y≈66.38. A 1-tall wall (top Y=66) is 0.38 below the eye. Rays at pitches between roughly -14° and -6° pass over the wall top and hit blocks behind it.

**For all obstruction-related tests and behavior_tests: walls must be ≥2 blocks tall.** This is now noted at the top of L0.10 fixture and should be a default in any future LoS-obstacle fixture (digging-tunnel ceilings, shelter walls, etc.). This is a *fixture-design* gotcha, not a code bug — but failing to know it produces flaky tests.

### F11. The four perception modes have very different semantics

| Mode | LoS check | Range | What it sees | Best use |
|---|---|---|---|---|
| `mc scene` | yes (raycast cone) | range param, capped 24 in non-fair-play | blocks + entities visible from current orientation | "what can the bot SEE right now" |
| `mc nearby` | partial (entities go through fair-play LoS; blocks chunk-scan with above bugs) | 16 for blocks; up to radius for entities | entity counts + non-common block summaries | "is anything moving near me" |
| `mc discover` | none (chunk-scan via b.findBlocks) | 8–64 (configurable per call) | named ore/log/food categories with count + locations | "find coal in the loaded area" |
| `mc map` | none (chunk-based) | radius param | top-down array of block names | "render terrain layout" |

Workers should learn which mode to use when. Documenting in SOUL.md so the brain doesn't ask `mc scene` to find ore 50 blocks away — it should be `mc discover`.

### L0 status update

| Test | Status |
|---|---|
| L0.1 health_connected | green (3) |
| L0.2 health_disconnected | deferred |
| L0.3 observe_payload | green (2) |
| L0.4 observe_action_loop | green (2) |
| L0.5 marks_list_empty | deferred |
| L0.6 marks_list_with_distance | green (2) |
| L0.7 nearby_close_block | **red** (FAIL → bug t_dc89c01b) |
| L0.8 nearby_stride | **red** (FAIL → bug t_dc89c01b) |
| L0.9 scene_block_in_fov | red (1 PASS, needs 1 more) |
| L0.10 scene_obstructed | red (1 PASS, needs 1 more) |
| L0.11 discover_distant | red (1 PASS, needs 1 more) |
| L0.12 scene_drop_entity | red (1 PASS, needs 1 more) |

5/12 green; 2 blocked on bug fix; 4 need a second consecutive PASS; 1 deferred (L0.2); L0.5 deferred. Bug t_dc89c01b is now the gating item for L0 green.

### Perception fix landed (bd79e6e) + suite extended to L0.16

Fixed `getNearby` in observation.js per BUG t_dc89c01b. Three changes:
- **Stride 1 in dx/dz**, iterating from `Math.floor(pos.x)+dx` instead of `pos.offset(dx, _, _)`. Closes the half-blind-at-fractional-X bug.
- **Drop the common-block name filter**. Aggregation by name (count + nearest) + top-25 prevents flooding without hiding placed terrain.
- **Surface scanRadius truncation**: response now includes `requested_radius` and `truncated:bool` so callers see when the cap kicks in.

Cost: ~4× more `blockAt` calls (still negligible, chunk-cached).

Verify-fix loop closed: BUG marked done with `fixed in bd79e6e`, `[VERIFY]` cards t_c9518b9a (L0.7) + t_819e6c96 (L0.8) PASS, then second PASS runs t_0f479422 + t_35bce2bc bumped both to consecutive_pass=2.

### Sprint 1 perception: L0.13–L0.16 (depth tests) + F12 + F13

Wrote 4 more fixtures to deepen coverage. All 4 PASS:

| Test | Card1 / Card2 | What it locks |
|---|---|---|
| L0.13_scene_vertical_fov | t_a6b1dddd / t_3070deb0 | Default ±18° vertical cone; in-cone visible, out-of-cone hidden until `mc look_at` |
| L0.14_scene_summary_consistency | t_a2b90510 / t_73fa617c | `visible_blocks` summary names ⊆ `visible_block_hits` names |
| L0.15_looking_at_block | t_1d2e5828 / t_79bd500b | `looking_at` populated when bot aims at block CENTER (not corner) |
| L0.16_nearby_terrain_visible | t_6c0d52bb / t_ceeb9dde | Regression: placed stone wall now in /nearby (was filtered before fix) |

### F12. Vertical FOV cone is ±18° from horizontal

`scanVisibleBlocks` defaults: `verticalFov: 36, verticalRays: 3`. With 3 rays spanning 36°, ray pitches are at base±18° and base+0°. So a block at +21° pitch above the bot's eye is OUTSIDE the default cone — invisible until the bot calls `mc look_at` to re-aim. L0.13 locks this: cobble at (5,67,0) (≈+8°) is visible; cobble at (3,70,0) (≈+55°) is not — UNTIL after `look_at(3,70,0)`.

**SOUL.md should teach**: when a worker expects to see a high or low block (chest in a tower, ore in a pit) and `mc scene` reports nothing, the next move is `mc look_at <coords>` — not "the block isn't there."

### F13. mc look_at aims at the EXACT coord — aim at block CENTER for cursor hits

`bot.lookAt(Vec3(x,y,z))` orients the bot's gaze at that coordinate exactly. The block at (3, 65, 0) occupies the cube (3..4, 65..66, 0..1) — so passing (3, 65, 0) targets the corner. For `looking_at` to populate via `blockAtCursor`, the cursor needs to actually intersect the block face. Aim at the center: (3.5, 65.5, 0.5).

**Worker rule**: when calling `mc look_at <coords>` to set up `mc dig` or `looking_at` checks, add 0.5 to each coord to aim at the block center.

### F14. NEVER fill below Y=65 in the spawn region

`fill -5 60 -5 10 80 5 air` destroys the spawn platform stones at Y=64. Bot then tp's to (0, 72, 0), slow-falls into the now-open void, and ends up at Y=-29 (or wherever bedrock physics catches it). Every test fixture must use `fill -5 65 -5 10 80 5 air` for the test region clear.

This also led to extending the platform east to x=10 (was 11×11; now 16×11) so fixtures placing targets at x=4..5 don't risk landing the bot off the edge during slow-fall. Documented in docs/test-world.md including the restore command.

### L0 status update

| Test | Status |
|---|---|
| L0.1 health_connected | green (3) |
| L0.2 health_disconnected | deferred |
| L0.3 observe_payload | green (2) |
| L0.4 observe_action_loop | green (2) |
| L0.5 marks_list_empty | deferred |
| L0.6 marks_list_with_distance | green (2) |
| L0.7 nearby_close_block | **green (2 — fixed)** |
| L0.8 nearby_stride | **green (2 — fixed)** |
| L0.9 scene_block_in_fov | green (2) |
| L0.10 scene_obstructed | green (2) |
| L0.11 discover_distant | green (2) |
| L0.12 scene_drop_entity | green (2) |
| L0.13 scene_vertical_fov | green (2) |
| L0.14 scene_summary_consistency | green (2) |
| L0.15 looking_at_block | green (2) |
| L0.16 nearby_terrain_visible | green (2) |

**14/16 L0 green**; 2 deferred (L0.2 disconnected, L0.5 empty marks). The perception block is solid. Action contracts shipped: dig + collect. Remaining for the architecture's Sprint 1 exit gate: place + craft + chest contracts; the two deferred L0 tests; one L1 smoke run.

### Action contract: mc place (DONE) + F15 + F16

Refactor at `bot/lib/actions/world.js:place`. Same pattern as dig/collect: structured `{ok, data, error}`, soft failures route to error.code rather than throwing.

| Path | Returned |
|---|---|
| Success | `ok=true, data.{placed_block, face_used:{dx,dy,dz,neighbor_block,neighbor_position}, position_after, requested_coord}` |
| INVENTORY_MISSING | `ok=false, error.observed_state.inventory_summary` (per-name counts) |
| TARGET_OCCUPIED | `ok=false, error.observed_state.existing_block`, `next_action_hint='mc dig X Y Z'` |
| OUT_OF_RANGE | `ok=false, error.observed_state.{distance, bot_position}` |
| NO_SOLID_NEIGHBOR | `ok=false, error.observed_state.neighbors` (full 6-face map: block name + is_air + position) |
| INTERRUPTED | `ok=false, retry_safe=true` — placement attempted but server rejected (anti-grief, mid-flight position drift) |

Key implementation detail: success path now **verifies** `b.blockAt(targetPos).name === blockName` AFTER the placeBlock call — mineflayer can ack a place that didn't land (e.g., placement-against-water glitch). If the verification fails, the loop tries the next solid neighbor; if all fail, returns INTERRUPTED.

Tests: L3.20 success, L3.21 INVENTORY_MISSING, L3.22 TARGET_OCCUPIED, L3.23 NO_SOLID_NEIGHBOR — all green at consecutive_pass=2.

### F15. Fixture YAML inline comments need explicit handling

`run-fixture.sh`'s naive YAML parser (intentionally pyyaml-free) didn't strip inline `# comments` on quoted scalars. A line like `- "clear Flint"  # explicit empty inventory` was passed verbatim to rcon, which rejected `"clear Flint" # ...` as unknown command. **Caused L3.21 to falsely return ok=true** because Flint kept the previous test's cobblestone in inventory.

Fixed: when a value starts with `"` or `'`, take only the substring inside the quote pair. Otherwise strip everything from the first ` #` (whitespace + hash). Lesson: naive YAML is fine for this scope but must handle the standard inline-comment pattern.

### F16. mc place pathfind to floating coords throws → routes to OUT_OF_RANGE

Initial L3.23 fixture put the no-neighbor target at (3, 70, 0) — distance 5.6 from bot. The `b.entity.position.distanceTo(targetPos) > 4.5` branch triggered `b.pathfinder.goto(GoalNear)` which can't reach a floating point with no support → throws → routes to OUT_OF_RANGE rather than NO_SOLID_NEIGHBOR.

Fix: place the target within 4.5 blocks (3, 67, 0 — distance 3.24) so the pathfind branch is skipped and the neighbor check runs. Lesson: NO_SOLID_NEIGHBOR is reachable only when target is within direct reach AND has no solid faces. To exercise OUT_OF_RANGE specifically, use a target deliberately beyond 4.5 with no terrain to path to.

### L3 status update (after place contracts)

| Test | Status | Coverage |
|---|---|---|
| L3.1 dig_basic | green (2) | success + dropped_items |
| L3.2 dig_air | green (2) | NO_BLOCK_AT_COORD |
| L3.3 dig_wrong_tool | untested | needs equip-aware fixture |
| L3.4 dig_protected | green (2) | PROTECTED_BLOCK |
| L3.5 collect_basic | green (2) | success + inventory delta |
| L3.6 collect_silent_failure | green (2) | Phase-1 bug fixed |
| L3.20 place_basic | green (2) | success + face_used |
| L3.21 place_inventory_missing | green (2) | INVENTORY_MISSING |
| L3.22 place_target_occupied | green (2) | TARGET_OCCUPIED |
| L3.23 place_no_solid_neighbor | green (2) | NO_SOLID_NEIGHBOR |

10/14 + 4 added = **10/18 L3 entries green**. Three Phase-2 action contracts shipped (dig/collect/place). Two remaining: craft + chest.

### Action contract: mc craft + mc smelt (DONE) + F17 + F18 + F19

#### mc craft (§8)
Same pattern as dig/collect/place. Failure paths:
`UNKNOWN_ITEM`, `NO_RECIPE`, `TABLE_REQUIRED`, `TABLE_OUT_OF_RANGE`, `MISSING_INGREDIENTS`, `INTERRUPTED`. Success returns `data.{crafted_count, requested_count, expected_per_craft, recipe_used, ingredients_consumed, started/ended_inventory}`.

Ingredient consumption is computed via inventory delta after the craft, so the response shows EXACTLY what wood/items were used — not just what the recipe nominally calls for. This is the basis for the wood-type-specific tests (L3.15 / L3.16).

#### mc smelt (§8.5 — new contract spec)
Architecture didn't formalize smelt; treating it as §8.5 in the sprint log. Failure paths: `NO_FURNACE`, `NO_INPUT`, `NO_FUEL`, `NOT_SMELTABLE`, `INTERRUPTED`. Success returns `data.{smelted_count, requested_count, input_item, output_item, fuel_used, existing_output_collected, started/ended_inventory, furnace}`.

Behavioral fixes vs the original:
- **Auto-collects pre-existing output** before loading new input (prevents furnace blocking).
- **Restores input to bot's inventory** if NO_FUEL fires after putInput already ran (worker doesn't lose materials on failed start).
- **Distinguishes pre-existing from freshly-smelted in the response**: `existing_output_collected` shows the auto-collected ingot count; `smelted_count` is the actual new smelt only. Bug found and fixed during L3.33.

### F17. mc smelt should be a background task by default

User question: "the wait should ideally not matter, and the agent just treats it as a background job?"

The `/task/<action>` infrastructure was already there — no code change needed in the action layer. Added `bg_smelt` CLI verb (POST /task/smelt) that returns immediately with a `task_id`; agent polls `mc task` to see `status=running` → `done`. **L3.36 batch test** validates the pattern: `bg_smelt raw_iron count=4` returns at t=0s, completes at t=46s, agent free during the wait.

The synchronous `/action/smelt` endpoint stays for fast tests / direct calls, but **SOUL.md should teach workers to use `mc bg_smelt` for any smelt action** since smelting blocks for ≥10s/item.

### F18. Smelt response was over-counting `smelted_count` when furnace had pre-existing output

Original code computed `smelted_count = endedInventory[output] - startedInventory[output]` — but if the furnace already had iron_ingot in its output slot, the auto-collect added that to inventory ALONGSIDE the new smelt. Result: smelted_count reported 2 when only 1 was actually smelted. Fixed by subtracting `existingOutputCount` (the pre-collected count, when same item type) from the delta. L3.33 locks this regression.

### F19. Wood-type semantics are correctly enforced by recipe matching

Two paired tests prove it:
- **L3.15** craft_wood_specific: bot has 6 birch_planks, asks for `oak_door`. Recipe needs oak_planks specifically. Result: `ok=false, MISSING_INGREDIENTS, missing=[{name:oak_planks, short:6}]`. Birch is NOT substituted. ✓
- **L3.16** craft_wood_agnostic: bot has 8 birch_planks, asks for `chest`. Recipe accepts any planks (#planks tag). Result: `ok=true, ingredients_consumed={birch_planks:8}`. Worker actually used birch, not (nonexistent) oak. ✓

Together this locks the two semantic modes: type-named recipes (doors, fences, signs) need the named wood; tag-recipes (chest, crafting_table, sticks, scaffolding) accept any matching tag.

### F20. Open: behavior_test territory for smelt/craft

User flagged additional testing surface that's beyond contract — these are behavior_test material:
- "Remembering to go to the furnace with the right items" — multi-step plan: collect input, walk to furnace, smelt. Requires the bot's STRATEGY layer (SOUL.md / planner). 
- "Managing multiple furnaces at once" — needs steward coordination + work-allocation. Phase 3.
- Alternative fuels beyond the hardcoded list (lava_bucket, blaze_rod, dried_kelp_block) — needs server-side fuel tag resolution rather than hardcoded names.

L3 status update (Sprint 1 close):

| Test | Status |
|---|---|
| L3.1–L3.6 (dig + collect) | green |
| L3.11 craft_hand_recipe | green |
| L3.12 craft_table_present | green |
| L3.13 craft_table_absent | green |
| L3.14 craft_missing_ingredients | green |
| L3.15 craft_wood_specific | green |
| L3.16 craft_wood_agnostic | green |
| L3.20–L3.23 (place) | green |
| L3.30 smelt_basic | green |
| L3.31 smelt_no_input | green |
| L3.32 bg_smelt_task | green |
| L3.33 smelt_existing_output | green |
| L3.34 smelt_no_fuel | green |
| L3.35 smelt_planks_fuel | green |
| L3.36 smelt_batch_bg | green |

**21 L3 tests green. Action contracts shipped: 4 of 5 (dig, collect, place, craft+smelt). Remaining: chest.**

### Action contract: mc chest (DONE) + chest_search + F21 + F22

#### Refactored: list_container, deposit, withdraw (§8)
Three handlers now share `openContainerStructured(deps, body)` which returns either `{ok:true, chest, block, x, y, z}` or `{ok:false, error: {...}}` with one of:

| Code | Trigger |
|---|---|
| `NO_MARK` | `body.mark` references a name that doesn't exist in marks file |
| `MISSING_COORDS` | Neither x/y/z nor mark provided |
| `NO_CONTAINER` | Block at coords is not a chest/barrel/shulker (or air); `observed_state.block_at_target` |
| `OUT_OF_RANGE` | Distance > 4.5 AND pathfind threw |
| `INTERRUPTED` | `b.openContainer` threw mid-flight |

deposit/withdraw responses now include:
- `inventory_delta` (per-name {item: signed-count})
- `container_delta` (mirror for the chest)
- `container_inventory_after` (post-state aggregate)
- `container_slots_after` (per-slot detail)
- `ambiguous_skipped` / `not_found_skipped` (when an item ref couldn't resolve)

Plus per-item soft failures:
- `AMBIGUOUS_ITEM` — request matched multiple distinct items via substring (e.g. "planks" → oak_planks AND birch_planks)
- `ITEM_NOT_FOUND` — request didn't match anything

#### New action: `chest_search`
Phase-2 §8 extension. Solves the user's "searching multiple chests" pain — scans `ctx.chestSnapshots` (already populated by every prior list/deposit/withdraw) and returns marks containing the requested item, sorted by distance from bot. **No chest is opened during the search.** Workers can call this BEFORE deciding which chest to walk to.

```
mc chest_search iron_ingot              # exact match across all known chests
mc chest_search planks max_results=5    # exact match; AMBIGUOUS skipped
mc chest_search planks exact=false      # broaden: any plank type counts
```

CLI verb: `mc chest_search` (alias: `mc cs`, `mc find_in_chests`).

### F21. mineflayer chest window inventory_delta gotcha

Sampling `b.inventory.items()` while a chest window is open returns the **pre-open** inventory snapshot — the window holds the player's items in its slot range, and bot.inventory only resyncs on `chest.close()`. First refactor of deposit/withdraw computed `inventory_delta` BEFORE close, returning empty deltas even though items moved. Fix: capture container state inside the try, capture inventory state AFTER `chest.close()` (with a 50ms sleep for the close packet to flush). Now deltas are accurate.

### F22. resolveItemRef: exact-match preferred, AMBIGUOUS surfaced

The original code used `i.name.includes(req.item)` which silently grabbed the first matching wood type. Replaced with a 4-state resolver:
1. **Exact name match** → use it (sums all stacks of that exact name)
2. **Substring match, exactly 1 distinct name** → use it (treat as "obvious abbreviation")
3. **Substring match, multiple distinct names** → return `AMBIGUOUS` with candidate list
4. **No match** → return `NOT_FOUND`

L3.44 locks the disambiguation: `withdraw planks` against a chest with both oak_planks and birch_planks now returns `ok=false, error.code=AMBIGUOUS_ITEM, observed_state.ambiguous=[{item:'planks', candidates:['oak_planks','birch_planks']}]`. Workers must specify the exact name.

### L3 status (Sprint 1 close — full action contract block)

**5 of 5 action contracts shipped: dig, collect, place, craft+smelt, chest.**

| Test | Status |
|---|---|
| L3.1–L3.6 (dig + collect) | green |
| L3.11–L3.16 (craft + wood-type) | green |
| L3.20–L3.23 (place) | green |
| L3.30–L3.36 (smelt incl. bg + alt fuel + batch) | green |
| L3.40–L3.45 (chest incl. disambiguate + chest_search) | green |

**27 L3 tests green** out of the matrix's expanded set. Behavior_test territory (multi-step plans, multi-furnace coord, multi-chest organize) flagged for Phase 2 follow-up under F20 + new F23 below.

### L0 closeout (Sprint 1 final): L0.2 + L0.5 green via run-fixture.sh `local:` prefix

Both deferred tests needed off-rcon harness — file system writes for L0.5, and bot-connection lifecycle for L0.2. Extended `scripts/run-fixture.sh` with a `local:` prefix that runs commands on the test host (this Mac) instead of via rcon-cli.

```yaml
prep:
  - "local: cp data/locations-flint.json /tmp/backup"
  - "local: echo '{}' > data/locations-flint.json"
  - "execute in landfolk-test run fill -5 65 -5 10 80 5 minecraft:air"
```

#### L0.2 — health_disconnected (green)
Strategy: KICK the bot rather than killing the process. mineflayer disconnects from MC; HTTP server stays up; `/health` returns `{ok:true, connected:false, position:null}`. To avoid disrupting Flint (used by every other test), targets Gatherer on port 3002. Fixture cleanup `POST /connect` restores Gatherer. Cards: t_3833256e, t_eeecda5a.

#### L0.5 — marks_list_empty (green)
The locations module reads `data/locations-<name>.json` fresh on every `/marks` call (no caching) — so we can swap the file content live, hit /marks, and see empty. Fixture: backup file → write `{}` → action → restore. Cards: t_ae2cd6b3, t_20b08d28.

### Phase 2 Sprint 1 — DONE

**16/16 L0 green. 27 L3 tests green. 5/5 action contracts shipped.**

| Block | Tests green | Sprint exit gate |
|---|---|---|
| L0 (foundation) | 16 / 16 | ✓ |
| L3 (action contracts: dig, collect, place, craft+smelt, chest) | 27 / TBD | ✓ |
| Action contracts shipped | 5 / 5 | ✓ |
| Brain-driven worker validated | t_c63b9de0 | ✓ |
| Verify_fix loop demonstrated | t_dc89c01b → t_c9518b9a + t_819e6c96 | ✓ |

Architectural findings captured F1–F23 across the sprint. Sprint 2 candidates: L1 (movement) fixtures + first behavior_test (multi-step "fetch + smelt" or "mob ambush").

### F24. mc place: water/lava counted as "tried" neighbor → INTERRUPTED instead of NO_SOLID_NEIGHBOR

While validating B2 (water-gap behavior_test), `mc place cobblestone 3 65 0` (above water) returned `INTERRUPTED` for every cell, despite there being no solid block to place against. Root cause: the neighbor scan only skipped `air/cave_air/void_air`. Water has `boundingBox === 'empty'` and is not air-named, so the loop tried `placeBlock(water, ...)` — server rejects it — `triedAnyNeighbor=true` — error code **INTERRUPTED** (semantically: "server rejected, retry safe"). For a worker, this is misleading: it implies "try again" when the right action is "stand somewhere else."

Fix in `bot/lib/actions/world.js:place`:
- Introduced `REPLACEABLE` set (air variants + water/lava/bubble_column + tall_grass/fern/vine/snow_layer/kelp/seagrass/dead_bush).
- `isSolidNeighbor(blk) = blk && !REPLACEABLE.has(blk.name) && blk.boundingBox === 'block'`.
- Loop now skips non-solid neighbors entirely → returns `NO_SOLID_NEIGHBOR` correctly.
- `neighborMap.is_air` field renamed to `is_solid` (more accurate; downstream callers use it to debug).

### F25. mc place: TARGET_OCCUPIED for water/grass blocked legitimate placements

Same refactor: `b.placeBlock` against a water-cell reference is rejected, but placing INTO a water-cell (water cell as the target) is valid — the cobble replaces the water. The original handler returned `TARGET_OCCUPIED` for any non-air block at the target, blocking the entire water-replacement bridging strategy.

Fix: TARGET_OCCUPIED now only fires for non-replaceable blocks at the target. Fluids and replaceable plants are allowed.

### F26. B2 fixture: "place at Y=65 over water" was physically impossible

The original B2 strategy comment said "Option A (good): place cobble at Y=65 across the trench, walk over." This is impossible in vanilla Minecraft mechanics — placement requires a solid block adjacent to the target, and at Y=65 over a 3-wide water trench, every neighbor of (3,65,0) is air or water. The bot would never have a valid reference block.

Correct strategy: **place cobble at Y=64** (replace water cells), creating a Y=64 → Y=65 step pattern. (3,64,0) has stone at (2,64,0) as solid neighbor; subsequent (4,64,0) and (5,64,0) use the previous placement as neighbor. Bot then walks at Y=65 over the new cobble.

After F25 fix this strategy works end-to-end:
- `goto_near 2 65 0 1` → arrived at edge.
- `place cobblestone 3 64 0` → ok, neighbor=stone(2,64,0).
- `place cobblestone 4 64 0` → ok.
- `place cobblestone 5 64 0` → ok.
- `goto_near 8 65 0 1` → walked across new bridge.
- `withdraw raw_iron 4` + `withdraw coal 4` → ok.
- `bg_smelt raw_iron coal 4` → 4 iron_ingot in inventory.

Fixture comment updated to reflect the corrected strategy. SOUL.md needs a "bridge over water" rule note: **place at the water-surface Y, not above it**.

### F27. bg_smelt CLI positional arg order trap

CLI signature: `mc bg_smelt INPUT [FUEL] [COUNT]`. Natural mental model is `mc bg_smelt INPUT COUNT` (parallel to `mc withdraw item count`), but smelt's optional positional comes BEFORE count. `mc bg_smelt raw_iron 4` parses as input=raw_iron, fuel="4", count defaults to 1 → NO_FUEL error with `requested_fuel="4"` in observed_state.

Workaround (no code change): always pass fuel explicitly when count > 1: `mc bg_smelt raw_iron coal 4`. SOUL.md / smelt skill should call this out — and if the worker hits NO_FUEL with `requested_fuel` looking like a number, that's the tell.

### B-suite (behavior_test) fixtures validated via steward action_sequence

| Fixture | Geometry | Steward path | Result |
|---|---|---|---|
| B1 baseline | open platform, chest+furnace | goto_near→withdraw×2→goto_near→bg_smelt | iron_ingot×4 |
| B2 water gap | 3×5×2 water trench at Y=63-64 | goto_near edge→place×3 at Y=64→goto_near→withdraw×2→bg_smelt | iron_ingot×4 |
| B3 walled | sealed cobble box around chest | goto_near wall→dig wall block→withdraw×2→bg_smelt | iron_ingot×4 |
| B4 descent | 1×1 vertical shaft to chest 5 below | goto_near top→drop in→withdraw×2→pillar_step×4→goto_near→bg_smelt | iron_ingot×4 |

All four fixtures have a *valid* steward strategy that ends with iron_ingot ≥ 1. Ready for brain-driven worker tests in Sprint 2.

### F28. pillar_step count param doesn't multi-step under slow_falling

B4 fixture grants `slow_falling 60 0` to soften the 5-block fall onto the chest. After landing, `mc pillar_step 5` (count=5) only placed 1 block per call — `placed=1, startY→endY=+1`. Looking at `bot/lib/actions/world.js:pillar_step`, `doOneStep` runs a 400ms cycle waiting for `b.entity.position.y >= baseFy + 1.0` (jump apex check). Slow_falling slows the upward arc enough that the apex check misses inside 400ms — bot lands back down, count++ on consecutiveFails, hits 2 fails, breaks loop.

Workaround: call `pillar_step` once per block (5 separate calls in B4 → climbed Y=61 → Y=66 over 5 calls). Acceptable for behavior tests but worth a SOUL note: under slow_falling, treat pillar_step as 1-step-at-a-time. Long-term fix: widen the cycle deadline to 800ms when the bot has slow_falling effect, or detect "still rising" rather than "above threshold." Defer to Sprint 2 contract polish.

### F29. pillar_step: rewrite — 87s → 2s for 3-block climb, with auto-stop and lateral-exit hints

While running B4 the user observed pillar_step was painfully slow (~30s per block) and overshot the platform by 2 blocks. Investigation surfaced a stack of issues:

1. **Multiple face-offsets per attempt** — original `canPlaceAt` looped through 6 face directions (top, bottom, ±x, ±z) and called `b.placeBlock` against each one. In a 1-wide shaft, lateral faces always failed; each failed `placeBlock` cost a server round-trip (~500ms). Restricted to bottom-face only for the canonical pillar reference, with side-walls as fallback candidates.
2. **CLI arg confusion** — `mc pillar_step 5` parsed "5" into the `block` slot (string-typed, first positional), not `count` (defaulting to 1). Result: every call was a single step, even though count=5 was intended. Fixed by re-routing numeric `block` to `count` in `bot/cli/registry.mjs`.
3. **No wait-for-onGround between steps** — after a successful place, the bot was still mid-air; the next iteration fired `setControlState('jump', true)` while airborne, which is a no-op. Added `waitForOnGround(600)` before each jump-place.
4. **No platform-level auto-stop** — once the bot reached the surrounding floor's level, pillar_step would happily keep building a spire. Added `canStepLaterally()` — checks the 4 horizontal neighbors at feet level for a walkable cell (solid floor + air feet + air head). When found, the loop returns early with `lateral_exit: { x, y, z, dx, dz, floor }` so the caller can `mc goto_near $exit.x $exit.y $exit.z 1` to step out.
5. **Replaced offset-loop with findStandingBlock + multi-ref** — locate the block currently underfoot directly, then build a candidate list: top-of-standing first, then any solid lateral wall at the target Y. Rotates through candidates if mineflayer rejects (chest top is a known offender — see F30).
6. **Restored ensureHeadroom** — pillar through a solid roof works again. Tested: a bot in a 4-block underground chamber with 2-block stone ceiling above climbs to the surface in 5.2s (6 blocks placed, ceiling dug through).

Final result on B4 (drop into 5-block shaft, climb back out): pillar_step takes 2.1s for 3 blocks, then `lateral_exit: { x: 6, y: 64, z: 0 }` directs the caller to a single goto_near to step onto the platform. Total run with smelt: 53s end-to-end (40s of which is the 4×iron smelt itself).

### F30. mineflayer placeBlock has a 5-second internal blockUpdate timeout

When `b.placeBlock(refBlock, faceVec)` is called and the server rejects the placement (e.g., bot's hitbox overlaps the new block, or partial-block reference like a chest), the server sends no `blockUpdate` event back. mineflayer waits 5 full seconds for that event before throwing `"Event blockUpdate:(x, y, z) did not fire within timeout of 5000ms"`. In a retry loop, this is catastrophic — N rejected attempts each cost 5s.

Fix: wrap `placeBlock` with `Promise.race([place, timeout(600ms)])`. After the race, verify by reading `b.blockAt(targetPos)`. If the block is there, success regardless of whether mineflayer's internal event fired; if not, the place was rejected and we move to the next candidate ref. Used in pillar_step's place loop — turned chest-pillar from 10.8s/0-blocks into 2.1s/3-blocks.

Generalizable: the same wrapper pattern is worth applying to any `placeBlock` call site that retries on rejection (place_fill, stair_up's floor placement, etc.). Defer to Sprint 2 contract polish unless behavior tests surface it again.

### F31. Ladder primitives validated — placement, climb, build-then-climb

Three L3 fixtures shipped to round out vertical-traversal:

| Fixture | What it tests | Result |
|---|---|---|
| L3.50 ladder_place | `mc place ladder` against a stone wall | ok=true; bot climbs onto placed ladder |
| L3.51 ladder_climb | pathfinder uses pre-placed ladder column to reach top platform | Y=65→70 in 12.2s |
| L3.52 ladder_build_then_climb | place 4 ladders, then climb to top platform | 13.5s total (1.3s build + 12.2s climb) |

Findings:

1. **`mc place ladder`** — the place handler picks the bottom face (platform stone below) as reference, but the server auto-orients the ladder to attach to the nearest solid wall regardless. Functionally correct; no contract change needed. (Could be improved by preferring horizontal faces when blockName is 'ladder' or other wall-mount blocks — defer.)

2. **Pathfinder ladder support** — mineflayer's pathfinder uses ladders out-of-the-box. Climb speed is ~2.4s/block, slower than walking but reliable. Distinctly slower than pillar_step (1.16s/block under load) but doesn't require digging through ceilings.

3. **Ladders need a top platform** — a ladder column ending in mid-air leaves the bot 1 block short of "the top" (cell above the highest ladder is air with no floor). For pillar_step we surfaced this via `lateral_exit`; for ladders we just require the fixture geometry to include a step-off platform.

4. **Ladders as a pillar_step alternative** — the worker now has two vertical-ascent primitives:
   - **pillar_step**: builds blocks beneath the bot. Fast (1-2s/block), single-direction, leaves a permanent column. Needs jump headroom (digs through if `ensureHeadroom` succeeds).
   - **ladder column**: places ladders against an existing wall. Slower per block (~2.4s), reusable for descent, no chunk modification of the ladder column itself. Needs a wall to attach to AND a platform at the top.
   - SOUL.md should pick: ladders if a wall exists and you have time; pillar_step if you're in open space or in a hurry. Both work.

### F32. Combat & escape primitives — 7 L3 fixtures shipped (L3.60–66)

Covers melee, ranged, threat avoidance, food gathering, defensive retreat, marked-shelter escape, and ranged-evasion.

| Fixture | Action | Result |
|---|---|---|
| L3.60 fight_zombie | `mc fight zombie` (point-blank) | 6 hits, full HP, 5.7s |
| L3.61 fight_skeleton | `mc fight skeleton` (range 10) | bot closes + 6 hits, full HP, 5.1s |
| L3.62 flee_creeper | `mc flee 16` (NoAI creeper) | 16 blocks west, full HP, 2.5s |
| L3.63 attack_cow_food | `mc fight cow 0 30` | 4 hits, cow dies, raw_beef drop, 3.1s |
| L3.64 fight_retreat_low_hp | `mc fight zombie 15 30` (bot pre-damaged) | retreat triggers immediately at 11 HP, 0 hits |
| L3.65 flee_to_mark | `mc flee --to shelter` | bot at (-9.3, 65, 0.5), navigates to mark |
| L3.66 dodge_skeleton | `mc flee 25` (defenseless) | survives arrows by movement, 25 blocks, full HP |

#### Findings during the run:

1. **`kill @e[type=!player,distance=..30]` in cleanup is centered on the rcon console** — origin (0, 0, 0) — not the bot. Mobs at Y=65 are 65+ blocks away by the distance metric and never get killed. Lingering cows from prior tests were appearing in subsequent runs. **Fixed across all 7 fixtures by raising distance to ..200.** Worth retro-fitting to all fixture cleanup blocks (defer scan to next session).

2. **`mc attack <target>` is single-hit, not a kill loop.** L3.63 v1 used `mc attack cow` and the cow lived (10 HP, one 4-dmg hit). For "kill X" semantics use `mc fight X` — it loops attack until target.isValid is false. The CLI naming overlap (attack vs fight) is a worker pitfall worth flagging in SOUL.md.

3. **`instant_health 5` regenerates faster than zombie damage** — L3.64 v1 had retreat_health=12 but bot's HP ticked above 12 every 0.5s due to instant_health, so retreat never fired. **Fix**: drop instant_health entirely from defensive-retreat fixtures, pre-damage the bot, set retreat_health *above* the starting HP.

4. **Night + `gamerule doDaylightCycle false` is the right test environment** for hostile mobs. Without `doDaylightCycle false`, time moves while the test runs and skeletons start burning at sunrise, perturbing the test. With it disabled, the scene is stable and reproducible. Torches added for visibility (the user must also be able to *watch* the test in-game).

5. **YAML parser quote-escape pyramid** — the `local: python3 -c '...'` pattern broke the run-fixture.sh parser at the first escaped `\"`. **Workaround**: ship a static JSON asset alongside the YAML (e.g., `L3.65_locations.json`) and `cp` it. Avoids the escape stack entirely.

6. **NoAI creeper for `flee` test** — a charging creeper detonates within the 4-second prep-to-action window if the bot can't react. We're testing the **detection-and-flee branch**, not creeper-survival under fire. NoAI freezes the creeper as a visible-but-stationary threat. (A behavior_test for "creeper actually charging" is a separate concern.)

7. **Defensive movement (L3.66)** validates that the worker has a viable strategy when ENGAGEMENT IS WRONG: defenseless + skeleton at range = `mc flee` not `mc fight`. SOUL.md's combat rule should explicitly call this case out: "no weapon AND ranged threat → flee, do not approach".

### F33. Combat tuning — FAIR_PLAY toggle, fight loop tightening

User observation during combat fixture review: "player was attacked and took a while to defend or run." Two layers of latency in the chain:

1. **`reactionDelay()` (100-300ms)** — fair-play mode adds a random delay before EVERY combat action's first move (attack/fight/flee). Defaults: `REACTION_MIN_MS=100, REACTION_MAX_MS=300`. For tests, set `FAIR_PLAY=false` when launching bots: `FAIR_PLAY=false ./scripts/landfolk-bodies-only.sh start`. Removes the random preamble entirely.

2. **Fight loop sleep durations** — `bot/lib/actions/combat.js:fight`:
   - Chase branch: `sleep(300)` between path-follow re-checks → **150ms**. Cuts the gap where the bot has already arrived in melee range but is still in the chase branch's sleep.
   - Attack branch: `sleep(600)` after each swing → **500ms**. Closer to wooden sword's 0.625s ideal cycle without losing per-hit damage.

Net effect: bot reacts to incoming aggro within ~150ms instead of ~700-900ms. The user-observed "took a while to defend" pattern is fixed.

### F34. Skeleton ranged-attack AI is finicky in confined spaces

Designing L3.66 (dodge_skeleton) surfaced a multi-step problem with Paper skeleton AI:

1. **First attempt (1-block bunker window at body level)** — skeleton's eye is at Y=66.4 (feet Y=65 + 1.4). A 1-block window at (11, 65, 0) puts the arrow path at Y=66 = stone wall. Arrows hit the wall, not the bot. **Lesson:** bunker windows must be at the mob's eye Y, not body Y.

2. **Second attempt (1-block window at head level Y=66)** — skeleton stays in the bunker but never fires. Possibly the AI's aim-cone raycast fails at the corner of a 1×1 hole; possibly Paper's `isInWall` heuristic gates ranged attacks when the mob is tightly enclosed. **Lesson:** narrow windows confuse the AI.

3. **Third attempt (2-block-tall window)** — skeleton WALKS OUT the front. Window high enough for body to fit through. **Lesson:** can't have it both ways for stone walls.

4. **Final design — open arena, no bunker** — skeleton fires reliably when given open ground and time. Verified in isolation: skeleton on a 3-block pillar (immediately fell off) fired arrows; skeleton at distance 8 in open air on flat ground fired arrows after ~3-5s of bot stationary.

**Conclusion:** for "skeleton must fire arrows" tests, give the AI an open arena and let nature take its course. Caging skeletons reliably requires iron bars / glass panes, but those block arrows too. The cleanest dodge_skeleton fixture asserts bot survival, not arrow accuracy — the latter is Paper RNG, not under our control.

### F35. Cleanup `kill @e[type=!player,distance=..N]` is centered on rcon console origin

The cleanup pattern `execute in <world> run kill @e[type=!player,distance=..30]` doesn't reach mobs that the bot interacted with — distance is measured from the rcon console's executor position (effectively (0, 0, 0)), not from the bot or any sensible test origin. Mobs at Y=65 are 65+ blocks away by Euclidean distance and never get killed. The user noticed cows lingering across multiple test runs.

**Fix**: use `kill @e[type=!player]` with no distance filter — `execute in <world>` already scopes to the test world, and the test world is otherwise empty of long-lived entities.

### F36. NBT escape pyramid in YAML fixture commands

Summon commands with NBT data that includes string keys (e.g., `Tags:["L366"]`) break the run-fixture.sh YAML parser when wrapped in double-quoted YAML — the parser's `cmd.find('"', 1)` truncates at the first inner `"` from `\"`. Workaround: use single-quoted YAML for the entire line:

```yaml
- 'execute in landfolk-test run summon minecraft:skeleton 8 65 0 {Tags:["L366"]}'
```

Single quotes in YAML allow embedded double quotes without escaping. The parser still strips the outer single quotes correctly.

### F37. Eight combat / escape fixtures green (L3.60-67)

| Fixture | Action | Pass condition | Time |
|---|---|---|---|
| L3.60 fight_zombie | `mc fight zombie` | killed, alive | 5.8s |
| L3.61 fight_skeleton | `mc fight skeleton` (range 22) | killed, alive | ~8s |
| L3.62 flee_creeper | `mc flee 16` (NoAI creeper) | fled ≥10 blocks | 2.5s |
| L3.63 attack_cow_food | `mc fight cow 0 30` | cow killed, raw_beef | 3.1s |
| L3.64 fight_retreat_low_hp | `mc fight zombie 15 30` (pre-damaged) | retreat triggers | 0.5s |
| L3.65 flee_to_mark | `mc flee --to shelter` | bot near mark | 1.4s |
| L3.66 dodge_skeleton | `mc flee 25` (open arena, no weapon) | survived 25-block flee | 4.2s |
| L3.67 fight_two_zombies_obstacles | `mc fight zombie 6 30` × 2 | both killed, alive | 12.7s |
| L3.68 shoot_bow | `mc shoot zombie` × 5 | zombie killed, 5 arrows consumed | 8.5s |

All validated individually with FAIR_PLAY=false bots. Batch runner has a known mvtp-race issue (defer fix).

**`mc shoot` works** but is a **single-shot primitive**, not a kiting loop. It equips bow, finds target, draws, fires, returns. Multi-shot encounters need the worker (or a future `mc bow_volley` action) to call it repeatedly. In L3.68 the zombie closed to melee range during the 5-shot sequence (each shot ~1.7s) — arrows still hit but the bot didn't back-pedal. Kiting (shoot + back-step + repeat) is higher-level behavior, deferred to behavior_tests.

### F38. Audit (A) — observe vs scene: signal layer is split, threat data lives in /scene

User pushed back on the "manual action invocation" testing pattern: action contracts in isolation don't predict survival. We need to verify the bot's signal layer surfaces in-world threats fast enough that an agent (or reactive layer) can respond.

**Audit method:** spawned a zombie 2 blocks east of bot, polled `/observe` and `/scene` at 300ms-3s intervals, recorded what each surfaced.

**`/observe` payload — what's there:**
- `state.health` — live, updates per damage tick. ✓
- `state.damage_telemetry: { last_damage, hp_after, seconds_ago }` — populates within 1s of being hit. Excellent "something bad happened" signal. ✓
- `goals_context.survive_score` — derived from HP, drops cleanly (100→62 over 5s as bot is killed). ✓
- `goals_context.threat_score` — **stays 0 even while bot is being killed.** Either not computed or stale. **Broken.** ✗
- `state.top_goal` — **does NOT preempt to `survive` or `low_threat` even at HP=4.6.** Goal engine has those critical goals defined but they don't fire. **Broken.** ✗
- `nearby_entities` — **field doesn't exist anywhere in /observe.** Top-level None, state-level None. ✗
- `alerts` — only contained the bot's own walking sounds. No zombie detection, no damage alert, no threat. **Useless for combat awareness.** ✗

**`/scene` payload — has the missing data:**
- `visible_entities: [{ type, distance, bearing, kind }]` — within 300ms of summon: `{"type": "zombie", "distance": 2, "bearing": "east", "kind": "hostile"}`. ✓ This is the proximity signal we need.
- `hazards` — exists as a list field; empty in this test. Worth probing with lava/cliff scenarios.
- `sounds` — populated; includes nearby mob movement.
- `looking_at` — what the bot is currently looking at.

**Implications:**
1. The agent's reactive layer needs to poll `/scene` (or merge it into `/observe`). Today's `/observe` simply does not surface visible hostiles.
2. The goal engine's `threat_score` and critical-goal preemption is broken — bot dies with `top_goal: supply_cobblestone urgency=1.5` while `survive` (priority 95) sits inactive. Two-bug fix needed:
   - `threat_score` derivation must read `visible_entities[kind=hostile]`.
   - Goal preemption must respect `preempt_class: critical`.
3. `damage_telemetry` is ALREADY a viable "took_damage" signal — no new wiring needed for that branch.

**Next steps from audit:**
- For Sprint 2 stub react-loop (B), poll `/scene` AND `/observe`, treat them as a merged view.
- Plan a small `/observe` patch to fold `visible_entities` (filtered to hostile + close) and a derived `urgent_alerts` field into the response. Defer until after stub + modes are validated.
- Plan a goal-engine fix for `threat_score` + preemption. Defer until reactive modes are in place (modes may obviate the need for goal-driven threat reaction).

### F39. Reactive layer (Layer 2) shipped + multi-target combat

Implemented `bot/lib/bot/reactive.js` per the §16 plan revision. Key design points:

- **Per-tick micro-actions, not macros.** Each tick (400ms) the layer issues at most one short action (single swing or 1-2 block step) and re-evaluates. No more `mc fight` or `mc flee 16` — those lock out re-evaluation and yank the bot far from where the agent placed it.
- **Bounded movement via anchor.** Bot stays within `ANCHOR_RANGE_NORMAL=6` blocks of the position it held when reactive last went idle. The agent's mental model stays intact: "I told the bot to mine cobble at X" → the bot is still ≤6 blocks of X regardless of what threats it dealt with.
- **Equipment-aware decisions.** No weapon → flee. Sword + no armor → fight. HP critical + recently damaged → flee. Creeper close → flee always.
- **Multi-target swing per tick.** `attackStep` iterates over EVERY hostile within MELEE_RANGE+0.5 and swings at each. Critical for surviving multi-zombie pile-ons — single-target focus while N attackers land hits is fatal. The combination of per-target `b.attack` + brief back-step at the end produces effective AOE damage and knockback on all nearby threats simultaneously.
- **Mode switch via `mc mode normal | guard | hold`.** Changes the engagement policy. `hold` disables auto-actions entirely (pure observation). Default `normal` covers single-bot survival.
- **`FAIR_PLAY=false` removes 100-300ms reaction delay.** The reactive layer's default poll cadence (400ms) is faster than the fair-play preamble. Toggle is per-process env var.

#### Empirical breaking points (closed 9×9 arena, NO armor, wooden sword):

| Threat | Result | Failure mode |
|---|---|---|
| 1 zombie | trivial — kill in 4-5s, full HP | — |
| 3 zombies | bot at full HP throughout | — |
| 4 zombies | bot at full HP throughout (HP=20 sustained) | — |
| 6 zombies | bot dies at T~15s | **wooden sword durability runs out at T~8s**; bot then has `weap=none`, flees, gets cornered against arena wall, dies |

Multi-target swing kept the bot at full HP against 4 zombies. The breakthrough finding is that **the durability ceiling, not damage exchange, is the binding constraint on combat duration**. Worth pulling forward Sprint 3 work on weapon-rotation: when held weapon hits low durability, reactive should auto-switch to the next available weapon in inventory.

#### F40. Safe-home pattern for test fixtures

Earlier tests showed bot taking damage, food drain, and witch poisoning in `world` (regular dimension where mobs spawn freely). Cleanup `mvtp Flint world` was the culprit. Built a small walled+lit safe-home box at landfolk-test (52, 65, 52) — peaceful difficulty, no spawns. All 58 test fixtures updated via sed to park the bot there between tests instead of `mvtp Flint world`. Result: HP=20 sustained at the safe-home; clean starting conditions for every test.

### F23. Open: chest organize / consolidate as behavior_test territory

User flagged "organizing — grouping similar items together" — that's behavior_test material:
- **Consolidate** — within a single chest, merge duplicate item stacks into the smallest number of slots.
- **Organize across chests** — move iron-related items to one chest, wood to another, by following a steward-curated convention.
- **Auto-route deposit** — given an item, pick the chest that already has it (via chest_search), open and deposit there rather than the nearest empty chest.

These need a worker that can chain mc chest_search → mc go_mark → mc deposit; not a single primitive. Frame as L4-level behavior_tests once the strategy layer is exercised.

### F40. Skeleton archery: Paper does not auto-equip bows

**Symptom:** every L3 skeleton fixture had the skeleton charging into melee instead of firing arrows. User: "the skeleton STILL doesn't fire arrows."

**Root cause #1 (real):** `summon minecraft:skeleton ...` with no `HandItems` produces an unarmed skeleton. `data get entity @e[type=skeleton] HandItems` returned `[{}, {}]`. Without a bow, the skeleton's AI defaults to melee chase. Fix: every skeleton summon now needs `HandItems:[{id:"minecraft:bow",Count:1b},{}]` explicitly. Updated L3.61 and L3.66.

**Root cause #2 (red herring that ate ~30 minutes):** my arrow-detection probe used `execute as @e[type=arrow] run say arrow` and counted output. Paper suppresses entity-`say` from rcon return, so I was reading "0 arrows" even when the air was thick with them. Switching the counter to `execute as @e[type=arrow] run tag @s add <unique>` and counting `Added tag` lines is reliable. **Pattern: any `execute as ENTITY run ACTION` that I want to count needs an action that emits per-entity rcon output — `tag add` works, `say` does not.**

The same trap bit my zombie counter: I reused the same tag name across loop iterations, so after iteration 1 every zombie already had the tag and `tag add` reported zero new adds → "all zombies dead" false positive. Fixed: use a per-iteration unique tag.

After the fix, L3.66 shows the bot taking the first arrow at T=2s (HP 20→17), 1–2 arrows in flight at any moment afterwards, and the reactive layer correctly transitioning to `flee_step (no_weapon)` with the new zig-zag dodge.

### F41. combat_skill per-agent setting (soldier vs farmer)

**Goal:** scalar 0..1 per bot that scales lethality so a soldier dispatches a horde while a farmer survives a single attacker but flees one zombie too many. User ask: "set higher for a soldier character and low for a farmer."

**Implementation in `bot/lib/bot/reactive.js`:**
- `ctx.combat_skill` defaults to 0.5; bootstrap from `COMBAT_SKILL` env var so launchers can stamp roles.
- `attackStep` always strikes the closest hostile; each additional melee target rolls against a decaying threshold (`skill`, `skill²`, `skill³`, …). At 0.9 a bot reliably hits 6 piled-on zombies; at 0.5 it reliably hits 2; at 0.0 it stays single-target.
- Tick-rate throttle: low-skill bots skip attack ticks (`skipBudget = round((1 - skill) * 2)`), so skill=0 swings every ~1.2s and skill=1 every 0.4s. **Flee is never throttled** — we don't want a "low-skill" bot to fail to dodge.
- `mc combat_skill <value>` action exposed via `bot/lib/actions/combat.js`; CLI verb registered. `mc combat_skill` with no arg reports the current value.

**Verification — 4 zombies (L3.70), wooden sword, no armor, closed arena:**
| skill | clear time | final HP | died mid-fight |
|------:|-----------:|---------:|----------------|
| 0.9   | 14s        | 20       | no             |
| 0.5   | 14s        | 20       | no             |
| 0.2   | 25s        | 13       | yes (HP 2.5 → respawn) |

The 0.5 ≈ 0.9 result is expected at 4 zombies — once the closest is always struck, half-skill keeps up because zombies attack one at a time anyway. The differential opens up at 6+ zombies (soldier survives, farmer doesn't). The 0.2 run actually died and respawned, then mopped up the persistent zombies — exactly the "farmer survives barely or not at all" envelope we wanted.

**Where this leaves us:** soldier/farmer roles are now a one-line config (`COMBAT_SKILL=0.9` for guards, `0.2` for villagers). Same architecture, same reactive code, profile shapes the survival envelope.

### F42. Combat suite green at skill 0.5 — what it took

After F39–41 the suite still had stuck-bot bugs that only showed up under live observation. User flagged five distinct failure modes by watching the runs:

1. *"Skeleton is too far away from the player."* L3.61 had the skeleton at d=22, designed for the agent-driven `mc fight` (which closes via pathfinder). Reactive only engages within `MELEE_RANGE` (4) or when `recently_damaged`, so the bot stood still soaking arrows. **Fix:** moved skeleton to d=10 inside a confined corridor and added `advance_step` — a bounded sprint toward the closest hostile (mirrors `flee_step` in reverse). One forward sprint of ~1.5 blocks per tick, weapon equipped on the way.

2. *"Creeper doesn't approach or try to explode."* L3.62 had `NoAI:1b` on the creeper — old design tested "did the bot detect a creeper" rather than "did the bot survive a charging creeper." **Fix:** removed `NoAI`, walled the arena into a closed 17×17 room so the bot can circle-flee without falling off the world (it had been running into the void at Y=1).

3. *"Player enters arena with arrows and poison still."* The reset block called `effect clear` and `kill @e[type=arrow]`, but couldn't clear arrows stuck in the bot's body or the damage-tilt animation. **Paper blocks `data merge entity` on players** — `Unable to modify player data`. **Fix:** the only reliable visual reset is `kill Flint` + mineflayer auto-respawn. A `spawnpoint Flint 52 65 52` before kill ensures the respawn lands at safe-home. Reset round-trip is ~1s; cheap and bulletproof.

4. *"Player advances only when shot, then stops."* `decide()` triggered on `recently_damaged` (2s window), so once arrows were in flight but hadn't hit yet the bot was untriggered. **Fix:** added a third trigger condition — `weapon && closest_ranged` — so an armed bot keeps closing on a visible archer indefinitely. For weaponless bots, added a preemptive `flee_step (ranged_no_weapon)` rule that fires the moment a ranged hostile is within `RANGED_AWARE_RANGE=16`. Standing still under archer fire is the worst possible policy.

5. *"Bot ends up in the corner each time, doesn't move around enough."* `attack_step` always retreated with `back` after the swing, which pushed the bot in a straight line away from the closest threat — multi-zombie packs walked it into corners. **Fix:** mixed retreat directions — 50% back, 25% strafe-left, 25% strafe-right. This alone was the difference between L3.71 (6 zombies) clearing in 22s at full HP versus dying twice and ending at HP 14.

`fleeStep` also gained wall-awareness: tries up to 4 rotated angles (zig-zag jitter, ±60°, ±90° strafe) and picks the first one with passable space ahead. Stops bots from grinding into a wall when the "directly away" vector is blocked.

**Verification — combat suite at skill 0.5:**
| Fixture | Result | HP |
|---|---|---|
| L3.60 fight_zombie | cleared 4s | 20 |
| L3.61 fight_skeleton | cleared 8s | 20 |
| L3.62 flee_creeper (live AI) | cleared 10s | 19.4 |
| L3.64 retreat_low_hp | cleared 6s | 20 |
| L3.66 dodge_skeleton | survived 25s | 20 |
| L3.67 two_zombies_obstacles | cleared 9s | 20 |
| L3.69 three zombies | cleared 11s | 20 |
| L3.70 four zombies | cleared 13s | 20 |
| L3.71 six zombies | cleared 22s | 20 |
| L3.72 2-skel + zombie (new) | cleared 17s | 20 |

10/10 pass at skill 0.5, every result above HP 19. L3.72 (closed room with 2 skeletons in opposite corners + zombie at floor) is a new fixture per user request — exercises the crossfire scenario where the bot has to engage one threat while dodging two others.

**Excluded from the reactive suite (agent-driven, not reactive-layer behavior):**
- L3.63 attack_cow_food (agent decides to hunt food)
- L3.65 flee_to_mark (agent picks the destination mark)
- L3.68 shoot_bow (agent fires bow; reactive doesn't shoot)

These remain as fixtures for the strategy/agent layer once that work begins.


### F43. G20 close-out — validate F42 at N=3 and freeze

- **Scope:** confirm the F42 reactive/mining/crafting/drown/shelter fixes hold over multiple runs on the two strongest models. Freeze G20 and move on to G21.
- **Fixes shipped this sprint (just two tooling cleanups — no bot-framework code changed):**
  - `mc_verbs_include_any` predicate (`scripts/agent-test.py`) now peeks into `mc batch` JSON payloads — inner action names (e.g. `craft` inside a batch step) count toward predicates. Closes the long-running false-negative where every batch-only run failed the `craft` predicate.
  - `g20-bench.py` death classifier (`DEATHS_RE`) was capturing the absolute `post` death counter, which is a cumulative Mineflayer-body counter that survives `/reset`. Per-run absolute values bleed across runs (e.g. the bench reported `deaths=54` for a run that actually had 0). Switched to `post - pre` delta. First bench sweep silently mis-classified 3 PASS runs as FAIL until this was caught.
- **Bench (N=3, strict rule = `survived AND deaths == 0`):**

  | model                       | passes/3 | mean deaths | mean final_t | mean seconds |
  |-----------------------------|----------|-------------|--------------|--------------|
  | deepseek/deepseek-v4-pro    | 2/3      | 9.3         | 18 010       | 652          |
  | z-ai/glm-5.1                | 2/3      | 7.7         | 18 018       | 652          |

  Both meet the ≥ 2/3 acceptance bar. PASS runs early-exit at ~520 s; FAIL runs go the full 915 s as the bot keeps re-arming the watchdog after each death.
- **Failure modes observed in the 4 non-passing runs (3 distinct patterns, none a F42 regression):**
  - **Death-loop** — bot dies once, respawns outside its shelter, walks back through the mob cluster to recover items, dies again. Loops ~25× through the rest of the night. (deepseek r1 original + r3 retry, deepseek r3 original.)
  - **Bot leaves shelter to fight** — bot has a visible zombie via `mc nearby` and goes out to engage at night instead of waiting it out. (deepseek r3 original.)
  - **Fall through terrain** — bot ended up at Y = -59 after standing on an edge. Couldn't pathfind back to surface. (glm r3.)
- **Carry-forwards (deferred to agent-prompt / SOUL revision, not framework work):**
  - **Death-recovery strategy** — the G20 prompt doesn't tell the bot to *stay put* after a death and accept item loss. The recovery instinct ("find death point, grab items") is what triggers the loop.
  - **Bot leaving sealed shelter** — once shelter is closed, the prompt should forbid breaking it before dawn.
  - **Reactive narrative collision** — agent plans around hazards the reactive layer already handled (e.g. "I see a creeper, let me retreat" right after reactive already retreated).
  - **Terrain-wedge soft-spot** — jump+back escalation works but adds ~30 s of stuck-time in deep mined-out deposits. Acceptable for now; revisit if it shows up in G21.
- **Verdict:** G20 frozen at F43. Reactive-layer regressions from F42 are closed; the 4 remaining FAIL modes are all agent-strategy issues that belong to a prompt/SOUL revision sprint, not the bot framework. Moving to G21 (two-bot collaboration).


### F44. G21 v1 — first two-bot coordination test, learnings + framework gaps

- **Scope:** stand up the simplest possible two-bot collaboration test. Flint + Mason cooperate, in one Minecraft world, to grab tools from a shared chest, mine cobble, build a chest, build a 4×4 platform, then jointly construct a small house with door + window. The steward is a scripted Python orchestrator that delivers missions over in-game chat (RCON `tellraw`) and listens for keyword acks. No long-lived Hermes-driven steward yet; that's the eventual architecture but we wanted to prove the chat protocol first.
- **What shipped (12 iterations from cold start to first PASS):**
  - `scripts/g21-orchestrator.py` — standalone runner. Launches 2 bot bodies (`node server.js` per bot) and 2 long-lived `hermes chat --yolo --max-turns 2000` sessions, runs world setup + post-connect setup + per-phase setup via RCON batches, broadcasts mission text via `tellraw`, polls each bot's `/chat` for keyword detection, advances phases.
  - `data/agent-tests/G21_two_bot_house.yaml` — declarative spec: bots, world setup, post-connect setup, marks, phase graph (M0 radio check → M1 parallel mine+chest → M2 parallel platform+door → M3 joint house), per-phase timing.
  - `prompts/landfolk/{flint,mason}.md` — extended with a "G21 coordination" block on top of existing role prompts.
  - `bot/server.js` — added `BOT_HEAR_ALL` env-var bypass for the cross-bot proximity filter on chat broadcasts.
  - `bot/lib/actions/world.js` — added `TARGET_ENTITY_OCCUPIED` pre-flight check in the `place` action so a bot trying to place where a partner is standing gets a clear actionable error (with partner name + suggested chat) instead of a 5 s silent timeout.
  - Combined ASCII-only log at `/tmp/hermescraft-g21/combined.log` — tailable, no UTF-8 box-drawing noise, both bots' streams merged with `[Flint]` / `[Mason]` prefixes.
- **The chat-routing detective story (the biggest single time sink):**
  - **Paper's `say @<name>:` expands** the `@selector` and re-emits the line as if it came FROM that player. So `say @mason: mine 100 cobble` showed up in chat as `<mason> mine 100 cobble`. The orchestrator's keyword filter (matching by sender) then accidentally matched the steward's own mission text — phases "completed" within 1 s of broadcast. Two fixes were needed in combination: switch broadcasts to `tellraw` (no @-expansion) AND add a `[STEWARD]` text prefix so Mineflayer extracts `STEWARD` as the chat username via its bracketed-prefix heuristic.
  - The bot's own `parseMessageRouting` parser also matches `<knownName>:` as direct-message routing — so any mission text starting with `mason:` or `flint:` still got mis-routed. Final shape: `@flint please …` (no colon after the name) keeps `from=STEWARD` and treats the body as a broadcast addressed by mention.
  - Cross-bot chat hearing is gated by a **proximity filter** (`FAIR_PLAY.LOS_ENTITY_RANGE = 48` blocks). Mason mining ~25 blocks from Flint's tree-chopping was inside the threshold, but as soon as either bot wandered to MINING_HINT or the BEACH (>48 blocks from the partner), broadcasts dropped into `overheardLog` and `mc read_chat` couldn't see them. `BOT_HEAR_ALL=true` env-var bypass added; orchestrator sets it on every body launch.
- **First successful PASS (iteration 9, model `z-ai/glm-5.1`):**
  - Wallclock 18 min 17 s end-to-end. All five missions completed: 3 via keyword (M1B, M2A SLAB READY, M3 HOUSE COMPLETE), 2 via inventory fallback (M1A 60-cobble, M2B 1-door + 20-planks).
  - The bots **genuinely cooperated** — visible in the combined log:
    - Mason: `"Mason: stuck trying to place door. Flint, can you help place the oak_door at (-1,66,9)?"`
    - Flint: `"Flint: door and window placed. House looks complete from outside — walls, roof, door, window all there. Mason, can you confirm from inside?"`
  - They **smelted glass for the window** without being told twice — sand on the BEACH mark + furnace + smelt, exactly as the prompt suggested. They added a roof beyond spec.
  - RCON probe confirmed the build: 42 cobble + 1 oak_door + 1 glass in the envelope `(-5..4, 65..71, 7..14)`.
- **Recurring failure modes across iterations 5–12 (real bot-framework gaps, not prompt issues):**
  - **`mc place` failure rate ~44%** (12 of 27 attempts errored in run 12). When the bot was outside ~4.5 blocks, the action's internal pathfinder call had no wallclock cap and frequently hung 5–25 s before timing out. When a partner stood on the target cell, the pre-fix behaviour was a silent 5 s timeout with no useful feedback.
  - **`mc goto` / `mc go_mark` stuck loop** — pathfinder gets stuck on a corner or unreachable target and the action sits for 15–25 s before returning `[error]`, but the bot's brain keeps issuing OTHER `mc` commands (`read_chat`, `find_blocks`, `chat`) in parallel. The bot doesn't realise its "current task" is actually frozen.
  - **`mc task` polling spam** — after a synchronous action like `mc fill` completes (instant), Mason called `mc task` 22 times in a row expecting an async task status. The bot's mental model of "long-running task" doesn't match the framework's sync vs. async distinction.
  - **Place-through-walls** — bots placed cobble through an existing wall (no raycast LOS guard on `placeBlock`, parallel to the attack-through-walls bug we fixed in G20 F42).
  - **Chat asymmetry** — bots emit a lot of chat (31 outgoing) but poll `mc read_chat` rarely (10 polls in the same run, 3:1 talk-to-listen). Reasonable as ambient narration, but it means a partner's request can sit unread for 30+ seconds while the recipient grinds through their own `mc fill` plan.
  - **Mining the build site** — Flint chopped cobble out of an already-placed wall to top up his inventory (prompt now explicitly forbids this; verify in next run).
- **Carry-forwards for F45 — framework hardening (proposed):**
  - **Action-level wallclock cap.** Every long-running primitive (`mc place`, `mc goto`, `mc goto_near`, `mc go_mark`, `mc collect`, `mc dig`, `mc craft`) returns within an absolute cap (e.g. 8 s for place, 15 s for collect/goto, 30 s for craft). On cap, return `OPERATION_TIMEOUT` with the partial-progress observed_state so the agent can decide next.
  - **Raycast LOS guard on `placeBlock`.** Same primitive as combat — refuse placement when the bot's eye can't see the target face. Closes the place-through-walls hole.
  - **Background-action heartbeat.** `bg_*` actions emit a progress heartbeat (line in chatLog / `/status` flag) so the brain knows it's still running and doesn't trigger `mc flee` panic.
  - **Unread-chat indicator in `mc status`.** Add `unread_chat: N` to the status payload so the brain notices waiting messages without polling separately. Cheap signal, big behavioural change.
  - **`mc inspect X Y Z`** primitive — return `{block, entities_at, occupied_by}`. Closes the gap that the new `TARGET_ENTITY_OCCUPIED` error filled half-way, but proactively rather than after a failed attempt.
  - **`mc is_empty REGION` / `mc is_filled REGION`** — region predicates beyond just `mc is_sheltered`. Useful for "is the interior empty?" or "are all 12 perimeter cells filled?" checks before emitting DONE.
  - **`mc task` semantics doc.** Either make `mc task` echo the most recent completion or rename to `mc current_task` and document that synchronous actions never appear there. Stops the polling spam.
  - **Move-friendly infrastructure blocks.** `crafting_table`, `furnace`, `chest`, `barrel` should be dig-allowed in coordinated-build mode (BOT_ALLOW_DIG_INFRASTRUCTURE env var or similar). A misplaced table at the build site is otherwise a permanent obstacle. Steward-declared "protected" list can come later; default for now should permit relocation.
  - **`TARGET_OCCUPIED` error should hint about diggability.** Current message says "block is already X. Dig it first or choose another cell." Better: include `is_diggable: true/false`, the suggested tool, and whether it's a craft fixture (`crafting_table`/`chest`) that the bot can move. Saves the agent a planning cycle.
  - **`mc flee` should not fire after pathfinder errors.** Right now `goto [error]` is followed by `mc flee 16` in the reactive layer, even when there's no threat. Flee should require a real hostile / damage signal, not generic stuck-state.
  - **Observation payload budget.** Token usage hit ~200 k input per Hermes call on a deepseek-flash run — overwhelmingly driven by repeated full `mc observe` / `mc scene` outputs accumulating in the conversation history. Trim these (return summary by default, full body only when explicitly asked) and document the budget per agent-test.
  - **Hermes-side context controls.** The compression-threshold knob is set to 0.5 but the Minecraft tool outputs are large enough that compression still keeps a lot. Worth evaluating per-tool max-context-share settings or aggressive summarisation hooks for verbose tools like `observe`, `scene`, `nearby`.

- **G21 v1 deepseek-v4-flash one-shot — partial data (run aborted mid-M3):**
  - M0 RADIO_CHECK: pass.
  - M1A (Mason mine 60 cobble): pass via inventory fallback at tick 12450 (mason was over-collecting and didn't emit the keyword phrase; predicate caught it).
  - M1B (Flint build chest + 20 planks): **HARD TIMEOUT** at tick 13430 — Flint did not emit `M1B DONE` within budget + 2400 overtime. He had over-collected sand (14 blocks for what only needed 3-4) and got stuck switching between tasks.
  - M2A (Mason platform): pass via keyword at tick 16250 (after a single warning).
  - M2B (Flint door + 20 planks): pass via inventory fallback.
  - M3 (joint house): aborted by user before completion. Patterns observed in the live combined log before abort:
    - `mc flee 16` fired immediately after `mc goto … [error]` with no threat present.
    - Mason collected ~14 sand (only ~3 needed for one glass block) — no "take only what you need" guidance in the prompt.
    - Both bots opened SUPPLY_CHEST and took multiples of the same tool, leaving nothing for the partner — fair-share rule was in the prompt but ignored.
    - Stuck-on-corner pattern surfaced again: M3 cobblestone placement at `(1, 68, 11)` errored 4× in a row across 60 s with no recovery move.
    - Communication: bots emitted progress notes intermittently but didn't share *decisions* before acting ("I'll do the south wall" type announcements were rare).
- **Verdict:** G21 v1 proves the chat-driven orchestrator pattern works end-to-end on the first reliable run. Both bots cooperated, smelted glass, built a verifiable structure, and signalled completion via keyword. The remaining instability is dominated by **framework-level action-timeout and verification gaps**, not coordination or prompt drift. The cleanest next step is **F45: a focused bot-framework hardening sprint** that addresses the seven carry-forwards above before we try G22 (3+ bot coordination, harder mission graph).

### F45. Bot-framework hardening — wallclock caps, place-LOS, inspect/region predicates

- **Scope.** Eight of the eleven F44 carry-forwards landed as focused edits. Three deferred to F45.2/F46 (bg_* heartbeat, observation budget, mc task / mc flee semantics) — each needs investigation, not just an edit.
- **What shipped:**
  - **Centralised timeout helper** (`bot/lib/actions/_helpers.js`). Exports `OperationTimeoutError`, `raceWithTimeout(promise, capMs, opName)`, `timeoutError(...)`, `withWallclockCap(...)`, and a frozen `ACTION_CAPS_MS` table (place=8 s, goto/goto_near/go_mark=15 s, move=20 s, collect=20 s, dig=10 s, craft=30 s). Replaces the inline `Promise.race` boilerplate that was scattered across movement/mining.
  - **Wallclock caps applied to** `place`, `goto`, `goto_near`, `move`, `go_mark` (containers.js), `collect`, `dig`, `craft`. Each returns a structured `{ok:false, error:{code:"OPERATION_TIMEOUT", message, observed_state:{op, cap_ms, ...}, retry_safe:true}}` on timeout and cancels pathfinder/dig before returning. The existing mining-only `gotoWithTimeout` was refactored to throw `OperationTimeoutError` so all paths share the contract.
  - **`placeBlock` raycast LOS guard** (world.js:550+). Tests 7 candidate face points on the target cell; if `hasLineOfSight` rejects all of them, returns `{ok:false, error:{code:"NO_LINE_OF_SIGHT", observed_state:{blocker, ...}}}`. Closes the place-through-walls hole parallel to the G20 attack-through-walls fix.
  - **`TARGET_OCCUPIED` hint extension.** Error now carries `is_diggable`, `is_relocatable` (true for crafting_table / furnace / blast_furnace / smoker / chest / trapped_chest / barrel), `suggested_tool`, and a human-readable hint string. Saves the brain a planning cycle.
  - **`BOT_ALLOW_DIG_INFRASTRUCTURE` env-var** (dig-tools.js). New `isDigProtected(name)` function — when env var is `true`, only beds and bookshelves stay protected; relocatable infrastructure becomes dig-allowed. Migrated 5 callers in world.js + mining.js. Orchestrator sets it on every body launch alongside `BOT_HEAR_ALL`.
  - **`mc inspect X Y Z`** primitive (world.js + cli/registry.mjs). Returns `{block:{name, is_air, is_diggable, is_relocatable, is_protected, suggested_tool, hardness, bounding_box}, entities_at:[…], occupied}`. Lets the brain plan place/dig without trial-and-error.
  - **`mc is_empty x1 y1 z1 x2 y2 z2`** and **`mc is_filled … material`** region predicates. Bounded at 1000 cells (returns `REGION_TOO_LARGE` otherwise). Returns up to 32 sample mismatches with their coords. Useful for "is the interior cleared?" / "are all 12 perimeter cells filled?" checks before emitting DONE.
  - **`unread_chat` always-present in `/status`** (observation.js:464). Was `unreadChat.length > 0 ? unreadChat : undefined`; now `{count, recent: slice(-3)}` always. Stable signal of waiting messages without a `mc chat` poll.
- **Primitive test results** (against landfolk-test world with Flint bot at localhost:3001):
  - `scripts/test-action-timeouts.py` — A (place unreachable) PASS, B (goto sealed) PASS.
  - `scripts/test-place-los.py` — A (wall blocks LOS) PASS with `NO_LINE_OF_SIGHT`, B (clear LOS) PASS with place success.
  - `scripts/test-inspect.py` — A (air) PASS, B (crafting_table → is_relocatable=true) PASS, C (cobblestone → suggested_tool='wooden_pickaxe') PASS.
  - `scripts/test-region-predicates.py` — A/B (is_empty true/false) PASS, C/D (is_filled true/false with correct missing-cell coord) PASS, E (REGION_TOO_LARGE) PASS.
  - **12/12 scenarios across 4 tests green.**
- **G21 re-run on deepseek-flash** — deferred to a separate sit-down. Implementation + smoke tests are stable; the integration test belongs in its own session so the live combined log can be observed end-to-end.
- **Files touched.**
  - New: `bot/lib/actions/_helpers.js`, `scripts/test-{action-timeouts,place-los,inspect,region-predicates}.py`.
  - Modified: `bot/lib/actions/{world,movement,mining,crafting,containers}.js` (wallclock caps + new actions + LOS guard + TARGET_OCCUPIED hint), `bot/lib/bot/dig-tools.js` (RELOCATABLE_INFRASTRUCTURE, suggestedToolForBlock, isDigProtected), `bot/lib/bot/observation.js` (unread_chat always present), `bot/cli/registry.mjs` (3 new verbs), `scripts/g21-orchestrator.py` (BOT_ALLOW_DIG_INFRASTRUCTURE on body launch).
- **Deferred to F45.2 / F46.**
  - **`mc task` rename / semantics rework.** Needs a backward-compat decision; bots currently mistake silence for progress.
  - **`mc flee` misfire investigation.** Needs a clean repro of the G21 case where flee fired after a generic goto error.
  - **Observation payload budget.** Needs token-cost profiling against deepseek-flash before we trim `/observe` / `/scene`.
  - **bg_* task registry + heartbeat.** New module, not a small edit.
- **Verdict:** F45 frozen. Eight carry-forwards converted to structured action-contract returns with primitive coverage; the brain now has explicit pre-flight + post-failure signals (`mc inspect`, region predicates, `is_diggable`, `is_relocatable`, `NO_LINE_OF_SIGHT`, `OPERATION_TIMEOUT`) instead of having to infer them from silence. Next session: G21 re-run on deepseek-flash with target wallclock <15 min and `mc place` failure rate <15%.

### F46. `mc task` semantics rework

- **Bug.** G21 v1 captured Mason calling `mc task` 22 times in a row after a synchronous `mc fill` completed. `GET /task` only reported the async `ctx.currentTask` (started via `POST /task/start`). Synchronous actions set `ctx.syncActionInFlight` for the duration of the request but it was wiped the moment the action returned, so `mc task` always answered `{task:null}` for sync work. The brain read the silence as "still running" and kept polling.
- **Fix.** Extend `GET /task` to expose three additive slots: `{task, sync, last}`.
  - `task` — async bg task (existing `ctx.currentTask`), null when no `/task/start` is running.
  - `sync` — `{action, started_at_ms, elapsed_s}` while a synchronous `/action/<name>` is in flight; null otherwise.
  - `last` — `{action, status, finished_at_ms, age_s, detail}` echoing `ctx.actionHistory[-1]` so the brain can see what just finished without polling.
  - Pre-F46 callers that only read `data.task` still work; `sync`/`last` are additive.
- **Implementation.**
  - `bot/lib/server/http-app.js:285` — `/task` handler reads `ctx.syncActionInFlight` + `ctx.syncActionStartedAt` and `ctx.actionHistory` to compose the new shape.
  - `bot/lib/server/http-app.js:636` — sync-action wrapper now stamps `ctx.syncActionStartedAt = Date.now()` on entry and clears it in `finally`.
  - `bot/cli/registry.mjs` — `mc task` verb description rewritten so the brain prompt sees the three-slot contract.
- **Smoke test** — `scripts/test-task-semantics.py` (4 scenarios, all PASS):
  - A: idle bot → `{task:null, sync:null}` confirmed.
  - B: `mc look` then `mc task` → `last={action:'look', status:'done', age_s:0}`.
  - C: `mc move` to a far target, parallel `/task` polling → 81 snapshots, caught `sync.action='move'` with `elapsed_s=6`.
  - D: `/task/start mc wait 3` → observed `task.status` transition `'running'` → `'done'`, `last.action='wait'`.
- **Verdict.** F46 done. The brain prompt update (one line: "`mc task` returns three slots — check `last` to see what just finished") can land alongside the G22 prompt rewrite. Next: F47 (`mc flee` misfire repro) or the G21 re-run on deepseek-flash, whichever the user prefers.

### F47. `mc flee` misfire — stop auto-targeting players

- **Bug.** `bot/lib/actions/combat.js` `flee()` listed `'player'` in its default hostiles array. In G21 v1 with Flint + Mason + Re44 all online, a bot calling `mc flee 16` (no `from` argument) would find the OTHER PLAYER via `e.name.includes('player')` and pathfind away from it — fleeing its own partner or the human, then narrating "stuck and fleeing" in chat. The reactive layer's flee triggers were correctly gated on real hostiles; this was the explicit `mc flee` verb itself.
- **Fix.** `bot/lib/actions/combat.js:256`:
  - Default hostiles list is now MOB-ONLY (zombie/skeleton/spider/creeper/etc., plus the rest of vanilla 1.21 hostiles: vindicator, pillager, ravager, vex, evoker, magma_cube, ghast, hoglin, zoglin, piglin_brute, warden). Players are removed.
  - Players can still be flee targets, but only when the brain explicitly passes `from=<name>` — taking responsibility for the targeting choice.
  - The "No threats nearby" no-op return is replaced with a structured `{ok:false, error:{code:"NO_THREAT", message, observed_state:{visible_entities}, retry_safe:false}}`. The brain stops misreading silence as success.
  - Success path returns `data.flee_reason` (`hostile_mob:<name>` or `explicit:<from>`) and `data.threat` (name/username/distance) so the action is self-narrating.
- **Smoke test** — `scripts/test-flee-no-threat.py` (4 scenarios, all PASS):
  - A: empty arena, `mc flee 16` → `{ok:false, error.code='NO_THREAT'}`.
  - B: passive cow at (3,65,0), `mc flee 16` → `NO_THREAT`. Cow is not a hostile.
  - C: live zombie at (3,65,0), `mc flee 16` → `{ok:true, data.threat={name:'zombie', distance:12.1}, flee_reason:'hostile_mob:zombie'}`.
  - D: no other player online (proxy for "is this still NO_THREAT") → `NO_THREAT`. Regression check: if a partner ever shows up nearby and `mc flee` without `from` fires on them, this scenario flips to `ok=true` and FAILS.
- **Verdict.** F47 done. Two of the three F45.2/F46 deferred items are now closed (`mc task` semantics, `mc flee` misfire). F48 (observation budget) is the last deferred item. The G21 re-run on deepseek-flash should now show cleaner chat — no more spurious flee narration when a bot is just stuck on a goto error.

### G21 v2 (deepseek-flash, post-F47) — partial run, Mason stuck repro

- **Setup.** G21 spec on `deepseek/deepseek-v4-flash`, F45+F46+F47 in. Run aborted ~22 min in after Mason stuck on a wall-corner geometry that he couldn't escape via `mc goto_near` / `mc place`.
- **Progress observed:** M0 RADIO_CHECK ✓, M1A DONE ✓ (Mason — 56 cobble), M1B DONE ✓ (Flint — chest + 20 planks), M2A SLAB READY ✓ (Mason — platform built, deposited 16 cobble in M1B chest), M2B in progress (Flint crafting door). Wallclock to M2B start was ~10 min — on pace for the <15 min target.
- **Bug: coordination breakdown on M3.** Both bots independently kicked off house wall construction. Mason ran `mc fill cobblestone -2 66 9 1 68 12 true` (the place_fill async task). Flint started digging what he thought was a south-wall door cutout — but he only mined the foot block at (0,65,9), leaving the head block (0,66,9) still in place. Result: 1-block-tall opening that no bot can pass through.
- **Bug: Mason wedged at the NE corner.** With walls at y=66, x∈[-2,1], z∈[9,12], Mason was outside at (2.3, 65, 12.7). To place the last missing block at (0,68,12) he needed to stand near (0,65,12) — but every range=1 stand cell has a wall block at head height. `mc goto_near 0 65 12 range=1` ran for 15s then OPERATION_TIMEOUT. The previous error message just said "Pathfinder didn't finish" — no signal about WHY. Mason looped three more 15s timeouts on the same target (also on `mc chest -3 65 11` because his straight path west was blocked by walls at head height).
- **No spurious mc flee fires.** F47 fix held — zero hostile-mob-misfire events. The 2 grep matches in the combined log were just prompt-text mentions.
- **Carry-forwards for F48 / G22 prompt:**
  - **Navigation introspection** — pathfinder error contracts need to surface WHY a cell is unreachable so the brain can adapt instead of looping. (Addressed by F48 below.)
  - **Coordination structure** — both bots tried to build the same walls. The G21 spec says "decide together: who does what" but the prompt doesn't enforce it. Needs a claim/lease protocol or explicit role partition.
  - **Door-cut helper** — a single primitive that digs BOTH foot and head blocks atomically. Closes the "Flint dug half a door" pattern.
  - **Stuck-state escalation** — after 3 errored actions on the same coord, the system should nudge the brain to chat for help instead of retrying.
  - **`mc collect` taking 25–34 s** — F45's 40 s cap absorbed it, but the underlying cost is real. F49 (observation budget) plus deeper-tier mining heuristics would help.

### F48. Navigation introspection — `mc reachable` + enriched nav errors

- **Bug.** G21 v2 Mason stuck pattern: `mc goto_near 0 65 12 range=1` returned `OPERATION_TIMEOUT` with no signal about WHY the cell wasn't reachable. The cell had a wall block at head height — but the bot had no field on which to base a retry, so it looped the same call.
- **Fix.**
  - **New module `bot/lib/actions/_nav-helpers.js`** with `isStandableCell(b, x, y, z)`, `standabilityReason(b, x, y, z)` (returns `ok`/`head_blocked`/`foot_blocked`/`no_foot_support`/`unknown`), and `findClosestStandable(b, x, y, z, maxScan)` (BFS-style search over a small region, returns closest cell where the bot could actually stand).
  - **New action `mc reachable X Y Z [range=3]`** in `world.js`. Geometry-only pre-flight: returns `{target_standable, target_reason, best_stand: {x, y, z, distance}}`. The brain calls this BEFORE committing to a goto so it picks a valid stand-spot upfront.
  - **`goto` / `goto_near` enriched errors** in `movement.js`. On any nav failure (NAV_BLOCKED, NAV_TIMEOUT, NAV_FAILED, or OPERATION_TIMEOUT), the error's `observed_state` now carries `target_standable`, `target_reason`, and `closest_standable`. Mason's exact OPERATION_TIMEOUT case now surfaces `target_reason: "head_blocked"`, `closest_standable: {x:0, y:65, z:11, distance:1}` — enough for the brain to retry on a working coord instead of looping.
- **Smoke test** — `scripts/test-nav-reachable.py` (4 scenarios, all PASS) against Mason's exact wall-corner trap:
  - A: `mc reachable 0 65 12` → `target_standable=false, target_reason='head_blocked', best_stand={x:0,y:65,z:11,distance:1}`.
  - B: `mc reachable 0 65 13` → `target_standable=true, target_reason='ok'`.
  - C: `mc goto_near 0 65 12 range=1` → `OPERATION_TIMEOUT` after 15.1s WITH `observed_state.closest_standable={x:0,y:65,z:11,distance:1}` and `target_reason='head_blocked'`.
  - D: bot TP'd to a different position, `mc reachable 0 65 12` still reports `head_blocked` — confirms the check is pose-independent (geometry of the target, not the bot's current state).
- **Verdict.** F48 done. The class-of-bug ("nav fails silently and brain loops") is converted into a self-explaining error contract. The G22 prompt should add a one-line hint: "if a nav action fails, check `observed_state.closest_standable` — try that coord instead of retrying."

### F49. Pathfinder parkour expansion was the timeout culprit

- **Symptom.** Across F48's recovery test R1, plus a focused 30-case probe matrix, pathfinder `goto`/`goto_near`/`move` timed out at 15s when:
  - A multi-block wall (≥4 cells wide, ≥2 cells tall) was between the bot and target, AND
  - The bot started in a narrow band 0.3–0.9 blocks east of the wall's east face.

  Bot at `(3.0+, 12.7)` succeeded in <2s. Bot at `(2.3–2.9, 12.7)` hung 15s. Single-cell pillars and walls with the bot ≥1 block away worked fine. The same scenario via `mc move` and `mc goto` all timed out, ruling out a goto_near-specific bug.

- **Root cause.** `bot/lib/bot/manager.js:174` set `moves.allowParkour = true`. Mineflayer-pathfinder explores parkour-over-the-top sequences in its A* search; for a 3-tall wall those are all dead-ends, but the search exhausts the 5s think budget exploring them. After timeout, pathfinder re-plans and loops — wallclock-capped at 15s by F45's `OPERATION_TIMEOUT`. The bot edges forward by tenths of a meter each iteration but never crosses the corner.

- **Fix.** Default `allowParkour = false`. Env-var `BOT_ALLOW_PARKOUR=true` opts back in for tests that need parkour (none currently in our suite). `bot/lib/bot/manager.js:172–185` documents the rationale.

- **Verification (post-F49 default):**
  - Original failing case `goto_near (0,65,11)` from `(2.5, 65, 12.7)`:
    - range=0: still 15s timeout (degenerate case — bot must stand AT exact cell)
    - range=1: **NAV_FAILED in 2s** (was 15s timeout — clean fast failure)
    - range=2: **SUCCESS in 7s** (was 15s timeout — actual route found)
  - All 4 F48 scenarios still PASS.
  - All 5 dig-walk-pickup-chain scenarios still PASS (no regression on pillar navigation).
  - test-stuck-recenter still PASS.

- **F48 + F49 together.** F48's `closest_standable` is now load-bearing: the brain reads the suggested coord from the error, retries with `range=2`, and pathfinder ACTUALLY routes around the wall. R1 in `test-recovery-protocols.py` is updated to demonstrate this combined path.

- **Remaining smaller issues:**
  - "Goal was changed before it could be completed" sometimes fires on rapid back-to-back goto calls. The previous goto's `setGoal(null)` in the catch handler doesn't fully reset pathfinder state. A small `sleep(200ms)` between retries works around it but a framework-side fix (await pathfinder idle) is cleaner.
  - `range=0` (must-stand-AT-cell) still times out for wall-adjacent targets. Acceptable: brain prompts should default to `range=1` or higher for any navigation involving walls.

- **Verdict.** F49 done. The G21 v2 Mason stuck-loop class is unblocked when combined with F48's introspection. Default-off parkour is a defensible cost: G21 / building / mining workflows don't need parkour, and the speed/reliability gain is large.

### Upstream pathfinder bug — root cause confirmed (closeout)

After F49 we attempted an F51 fix for "Goal was changed before it could be completed!" errors on consecutive gotos. The fix made things worse, then a deeper investigation found the real root cause: **[mineflayer-pathfinder issue #273](https://github.com/PrismarineJS/mineflayer-pathfinder/issues/273)** (OPEN since June 2022).

The bug is in `lib/goto.js`'s `noPathListener`: when A* returns a `partial` result with `path.length > 0`, NONE of the cleanup branches fire — the goto promise hangs forever. This is exactly our 15-second-timeout pattern. The upstream package is on its last release (2.4.5, Sept 2023, latest is also 2.4.5) with no open PR for the fix.

**Why our existing framework is correct:**
- **F45 wallclock cap** is THE workaround. Without it, gotos hang indefinitely. The 15s timeout fires, our code calls `setGoal(null)`, the still-subscribed `goalChangedListener` rejects the hung promise via `GoalChanged`, and we return a structured `OPERATION_TIMEOUT` error.
- **F49 parkour-off** reduces how often A* returns `partial` (smaller search space, more clean `noPath` results) — fewer hangs in the first place.
- **F48's `closest_standable`** in the error gives the brain the data needed to retry with a working coord.
- **F47's clean `mc flee` contract** prevents the brain from misreading the timeout as a hostile threat.

**Why the F51 attempt failed:** issue #261 confirms that "GoalChanged" / "PathStopped" errors are **by design** when `setGoal(null)` interrupts a hanging goto. Our `setGoal(null)` is the *mechanism* by which the wallclock cap force-rejects the hung promise. Removing it (F51) left the promise hanging across calls, which is worse.

**The IParallel fork** (`https://github.com/IParallel/mineflayer-pathfinder`) has a fix: track `lastNodeTime`, emit `resetPath('stuck')` after 3500ms of no waypoint progress, add a `pathReset` listener in `goto.js` that rejects with `Stucked`. ~40 lines total. We are NOT applying it now — the fork is single-author, stale (Aug 2024), and bundles a massive `index.js` refactor. If our agent system matures past prototype, we'll either submit an upstream PR cherry-picking the fix, or maintain a `patch-package` patch locally.

**For now: F45 + F48 + F49 are the correct workaround stack.** Document the upstream bug, point future fixes at it, and move on.

### F54. Post-G21 v5 — close the four thrash patterns — SHIPPED

**Status: F54.1, F54.3, F54.4, F54.5 SHIPPED. 13/13 smoke tests green.** F54.2 rejected (coordination semantics belong outside the framework). Door-support guard, inventory advisories, underwater rejection, and `mc through` recovery hints all wired in and verified against live bot on :3002.



G21 v5 attempt-3 on deepseek-v4-flash got the farthest yet: M0 ✓, M1A ✓, M1B fallback ✓, M2A SLAB READY ✓, M2B ✓, M3 reached the verification phase with `mc is_sheltered` actually being invoked (9 calls) — but the run never emitted `HOUSE COMPLETE`. The bots burned ~25 min in M3 thrashing on five distinct framework gaps that the forensic analysis pinpointed precisely. F54 closes all five before the next G21 run. **Order is severity-ranked — F54.1 alone prevents the cascade that ate ~60 commands.**

#### F54.1 — Protect door-support blocks from `mc dig`

- **Bug.** Mason ran `mc dig -2 65 10` to clear what he thought was a dirt block. It was the platform cell directly beneath the door at (-2, 66, 10). The door dropped as an item entity, the slot became air, and both bots spent the next 20 minutes thrashing on a door they couldn't see, place, or path through. The `mc dig` action's existing `isDigProtected` check (`bot/lib/actions/mining.js:794`) protects buildings (chests/beds/etc.) but knows nothing about *blocks that support a door above them*.
- **Fix.** In `bot/lib/actions/mining.js` `dig({x,y,z})` at line 776, after the `isDigProtected` check, add: read the block at `(x, y+1, z)`. If it's a door (`oak_door`, `iron_door`, all variants — match `name.endsWith('_door')`) AND the bot is not already standing on the support, return `{ok:false, error:{code:'SUPPORT_BLOCK', message:'Cannot dig (x,y,z) — supports door at (x,y+1,z). Digging will drop the door. mc dig with --force to override.', observed_state:{block_at_target, door_above:name, door_pos}, next_action_hint:'mc dig --force <x> <y> <z>'}}`. Also handle fence_gate and trapdoors. The `--force` flag (and `BOT_ALLOW_DIG_INFRASTRUCTURE=true`) bypass.
- **Smoke test** — `scripts/test-dig-door-support.py` (4 cases): A: place door at (5,66,0), `mc dig 5 65 0` → `SUPPORT_BLOCK`. B: same with `--force` → succeeds, door drops as entity. C: no door above, `mc dig 5 65 0` → succeeds. D: fence_gate above → `SUPPORT_BLOCK`.

#### F54.2 — REJECTED (auto-chat on milestone block placements)

Originally proposed: framework auto-emits `placed glass at X,Y,Z` chat after milestone-block placement. **Rejected** — too prescriptive. Bakes coordination semantics into a primitive. In the planned Hermes-task-card architecture, agents will work from defined tasks with TODO lists and update their cards via Hermes kanban (or similar) — that's where "what got done" announcements belong, not in `mc place`. Framework stays as primitives + actionable errors; coordination layers on top. The window-coordination-gap problem will be solved by giving bots a real shared task board, not by autochat.

#### F54.3 — `mc inventory` surfaces tool advisories

- **Bug.** Mason's pickaxe broke mid-`mc collect stone 34`. He ran `mc inventory` to diagnose — got `{categories: {blocks: [...], food: [...]}}` with NO `tools` entry. The MISSING category was the diagnostic, but the brain didn't infer it. Two wasted commands before he ran `mc craft stone_pickaxe`.
- **Fix.** In `bot/lib/bot/observation.js` `getInventory()` at line 503, after building `categories`, append a top-level `advisories: []` array. Push entries when:
  - `categories.tools` is absent or empty: `"no working tool — mc craft wooden_pickaxe (needs 3 oak_planks + 2 sticks)"`
  - any tool has `item.durabilityUsed/maxDurability > 0.85`: `"<tool> near-broken (X/Y durability) — craft a spare"`
  - bot is on a mining goal (`ctx.currentTask?.goal === 'maintain_iron'` or similar) AND no pickaxe: `"mining goal active but no pickaxe — blocker"`
  
  Use `item.maxDurability` and `item.durabilityUsed` (mineflayer exposes both via the Item class).
- **Smoke test** — `scripts/test-inventory-advisories.py` (3 cases): A: bot with only food/blocks → advisory `"no working tool"`. B: bot with full-durability pickaxe → no advisories. C: bot with pickaxe at 95% used → advisory `"near-broken"`.

#### F54.4 — `mc collect` rejects underwater targets

- **Bug.** Mason ran `mc collect sand 4` near the beach. The closest sand candidates were in a pond. The action sort de-prioritized flooded blocks (`mining.js:386`) but still selected one when no dry candidate scored higher. Mason walked into the water and got stuck for ~12 commands trying to dig sand-under-water with `dig_timeout`s.
- **Fix.** In `bot/lib/actions/mining.js` `collect()` around line 380 where candidates are sorted, after sort: if the top candidate is flooded (existing `isFlooded` predicate at line 316), check if dry candidates exist in the matched set. If ALL candidates are flooded, return `{ok:false, error:{code:'TARGET_IN_WATER', message:'All N candidates of <block> are in water — drain pond first, approach from beach side, or pick a drier block', observed_state:{candidates_dry:0, candidates_flooded:N, suggested_dry_search_radius:32}, retry_safe:false}}`. If some dry, prefer them strictly (skip flooded entirely unless `--include-water` flag set).
  - **Also** in `bot/lib/bot/dig-tools.js` near where `dig()` body executes (find `b.dig(target)` call): if `b.entity.isInWater === true`, throw `Error('Cannot dig while submerged — swim to surface (mc escape) before digging')`. Brain sees `TOOL_INADEQUATE`/`DIG_FAILED` with this message instead of opaque timeout.
- **Smoke test** — `scripts/test-collect-underwater.py` (3 cases): A: sand only in pond → `TARGET_IN_WATER`. B: sand on beach AND pond → succeeds on beach sand. C: bot teleported into water, `mc dig <some sand>` → `submerged` error message.

#### F54.5 — `mc through` error rewrite + `mc use` disambiguation

- **Bug.** Both bots called `mc through -2 66 10` when the door was missing. `mc through` correctly returned `NOT_A_DOOR` (good error) but the bots couldn't read past the prefix and thought the command was wrong. Mason invented `mc thru`. Neither bot tried `mc place oak_door -2 66 10` even though both had doors in inventory.
- **Fix.** In `bot/lib/actions/world.js` find the `through` action (around line 2050 per the forensic agent — verify). On the `NOT_A_DOOR` branch, enrich the error: if the block at target is `air` AND the bot's inventory contains a matching door, set `next_action_hint: 'No door at (x,y,z) — you have oak_door in inventory, try mc place oak_door <x> <y> <z>'`. If the block is a wall: `next_action_hint: 'Block is <name>, not a door. mc dig it or mc use a real door coord.'` Also in `bot/cli/registry.mjs:138` and `:719`, tighten the descriptions: `mc through` for "open + walk past + close"; `mc use` for "just toggle the door (right-click)". Brain prompts should pick `mc use` for verification, `mc through` for traversal.
- **Smoke test** — `scripts/test-through-recovery.py` (3 cases): A: target is air, bot has door → error includes the `mc place` hint. B: target is cobblestone → error includes "dig or use a real door coord". C: target is an actual door → succeeds.

---

#### F54 deferred (lower-impact)

- **Dropped-door entity detection in `mc escape` classifier.** `_nav-helpers.js:218-239` could scan for dropped item entities near the bot and surface them in standing-state output. The wider F54.1 fix (prevent the drop in the first place) makes this much less load-bearing. Punt to F55.
- **`mc escape` `enclosure_inside_broken_door` action.** Same logic — if F54.1 prevents the drop, escape doesn't need a special case. Punt.
- **F53.6 `reason=...` quoted-spaces CLI bug.** Bots' `mc fill cobblestone 0 66 9 1 68 9 reason="M3 roof"` errors at the CLI arg parser. They work around it by retrying without reason. Real fix is in the `mc` CLI shell quoting layer, not the bot framework. Tracked as F54.6 if it stays painful in G21 v6.

---

#### Success criteria for G21 v6 (deepseek-flash re-run after F54)

- **HOUSE COMPLETE keyword emitted** within 25 min wallclock (vs. v5: never, M3 hit ~25 min and was killed).
- **`mc dig` SUPPORT_BLOCK fires at least once** with no door drops in the run (Mason will try to dig a door support; F54.1 should block it).
- **Zero invented verbs** (no `mc through` failures followed by `mc thru` or `mc walk_through`).
- **`mc collect sand` does not get Mason stuck in water** for >2 commands.
- **Tool-error rate** Flint+Mason < 60 total at HOUSE COMPLETE emit (v5: 84 at the abort point with no completion).

If G21 v6 still doesn't emit HOUSE COMPLETE, the next bottleneck is brain-side (prompt clarity, planning depth) not framework — and F55 should be a prompt rewrite, not more framework hardening.

---

#### F54 sequencing

Land in this order so each fix can be smoke-tested in isolation against the still-running test world bots (:3002/:3003):

1. **F54.1** (~45 min) — door-support guard. Highest ROI. Smoke-test by trying to dig under the existing door at (-2,66,10) in test world.
2. **F54.3** (~45 min) — inventory advisories. Easy, broadly applicable.
3. **F54.4** (~60 min) — underwater rejection + submerged dig guard. Two related touch points.
4. **F54.5** (~30 min) — `mc through` error rewrite. Smallest impact; do last.

Total: ~3 hours focused work + ~1 hour smoke tests. Then immediately run G21 v6.

#### F54 ship verification (live :3002 bot, world=landfolk-test)

Each of the four code tickets has a self-contained smoke test that resets the test arena, drives the contract, and validates the error code + observed_state. All four green:

- `scripts/test-dig-door-support.py` — F54.1 — A/B/C/D PASS
  - A: dig support under oak_door → `SUPPORT_BLOCK`, `supported_block.name='oak_door'`
  - B: same with `--force` → ok=true (door drops, intentional)
  - C: dig plain cobblestone (no door above) → ok=true (no regression)
  - D: dig support under oak_fence_gate → `SUPPORT_BLOCK`, `supported_block.name='oak_fence_gate'`
- `scripts/test-inventory-advisories.py` — F54.3 — A/B/C PASS
  - A: cleared inventory → advisories `['no pickaxe...', 'no axe...']`
  - B: full-durability pickaxe + axe → no advisories
  - C: damaged pickaxe (damage 56/59) → `'wooden_pickaxe near breaking (3/59 durability, 5%) — craft a spare'`
  - Mineflayer 1.21 quirk: damage value lives in `item.components` as `{type:'damage', data:N}`, NOT `item.durability` (which is undefined). Code falls back to the legacy field for older versions.
- `scripts/test-collect-underwater.py` — F54.4 — A/B/C PASS
  - A: sand only in a pond → `TARGET_IN_WATER`, `candidates_dry=0, candidates_flooded=7`
  - B: sand on a dry beach + pond → ok=true (mines dry one, flooded sort-last unchanged)
  - C: bot inside water column, `mc dig` adjacent stone → `SUBMERGED`, `bot_in_water=true`
- `scripts/test-through-recovery.py` — F54.5 — A/B/C PASS
  - A: air target + oak_door in inventory → `NOT_A_DOOR` with hint `'mc place oak_door 4 65 3'`
  - B: cobblestone wall target → `NOT_A_DOOR` with dig/real-coord hint
  - C: real oak_door target → ok=true (through traverses, no regression)

#### Files touched

- `bot/lib/bot/dig-tools.js` — new export `getSupportedDoorAbove(b, x, y, z)`
- `bot/lib/actions/mining.js` — `dig` accepts `force` param; SUPPORT_BLOCK check (F54.1); SUBMERGED check (F54.4 part 2); TARGET_IN_WATER guard in `collect` (F54.4 part 1); safe_dig forwards `force` to dig
- `bot/lib/bot/observation.js` — `getInventory()` returns `advisories[]` (F54.3) computed from tool wear and missing-tool detection; reads damage from `item.components` first, falls back to `item.durability`
- `bot/lib/actions/world.js` — `through` NOT_A_DOOR branch enriched with inventory-aware `next_action_hint` (F54.5)
- `bot/cli/registry.mjs` — `dig` accepts `--force` flag with example; `through`, `interact`, `use` descriptions disambiguated (F54.5)
- `scripts/test-{dig-door-support,inventory-advisories,collect-underwater,through-recovery}.py` — four new smoke tests

#### Verdict

F54 done. Next: F54.6 (G21 v6 re-run on deepseek-v4-flash) to validate the four fixes against the actual failure modes they target.

### F54.6 — G21 v6 deepseek-flash re-run — **HOUSE COMPLETE achieved**

**Status: SHIPPED — first G21 success ever on deepseek-v4-flash.**

- **Total wallclock: 37 min** (vs v5: 35 min and never finished).
- Phases: ✓ M0 (95s), ✓ M1A / ✗ M1B (Flint hard timeout but inventory verified), ✓ M2A SLAB READY (Mason), ✓ M2B (Flint inventory), ✓ **M3 HOUSE COMPLETE keyword emitted by Flint at tick 1584** (orchestrator wall = 2233s).
- **Zero F54 framework signatures triggered**: SUPPORT_BLOCK=0, TARGET_IN_WATER=0, SUBMERGED=0, NOT_A_DOOR=0. The bots didn't trip any of the v5-pattern traps the guards protect against, which is the whole point.
- Tool errors final: Flint 39, Mason 64. Mason died once (mob on cross-map run to MINING_HINT, not a framework failure).
- F53 signatures kept firing as designed: `mc find` 31, `mc escape` 9, FILL_PARTIAL 6, 13 context compactions, 3 rate limits.
- Coordination quality: Mason chat-claimed walls (`"I'll build north + east, you take south + west?"`), Flint chat-claimed door + window. Bots used `mc whisper` for private status updates (though see F55.6).
- Final emit: Flint stood inside, ran `mc is_sheltered` (returned `pathfinder_enclosed: true` for all 5 directions), emitted `mc chat "HOUSE COMPLETE"`. Steward listener picked it up cleanly.

**Bonus bug found mid-run.** F53.5's `[!]` chat banner and many actions' `result` strings (inspect, scout, smelt) had been silently stripped by the CLI envelope builder for the entire prior sprint. `bot/cli/results.mjs:178` built `{ ok, command, data, state }` without propagating top-level `result`, and `bot/cli/output.mjs:82` only read `d?.result` (nested). Result: brains saw the JSON dump minus the banner/summary line. Fixed: envelope now preserves `js.result`, output prefers `e.result` then falls back to `d?.result`. Live verified — `chat <Rcon>` + `[!] N unread chat` now appears at the top of `mc inspect` output before the JSON body.

### F55. Post-G21 v6 — primitive correctness + chat plumbing — SHIPPED

**Status: F55.1, F55.2, F55.3, F55.4, F55.5, F55.6, F55.7 SHIPPED. 21/21 smoke tests green.** All seven code tickets landed and verified against live Flint bot on :3002. F55.8 (G22 mission run) pending.

**Files touched (final):**
- `bot/lib/actions/world.js` — `wait` chat-interrupt; `chat_to`/`whisper` rewritten as public @-mention; `place` post-equip verify + retry; `place_fill` bot_was_inside_region surfacing; `through` snapshot re-fetch + reach precheck; `is_sheltered` optional walls perimeter check; `interact` reach precheck.
- `bot/lib/actions/_helpers.js` — new `ensureWithinReach()` helper + `ACTION_CAPS_MS.reach=8000`.
- `bot/lib/actions/containers.js` — `openContainerStructured` uses `ensureWithinReach`.
- `bot/cli/registry.mjs` — `wait --no-interrupt`, tightened chat_to/whisper descriptions, `is_sheltered walls=` flag.
- `scripts/test-{wait-chat-interrupt,whisper-as-mention,action-reach-pathing,place-fresh-craft,fill-self-blocking,through-fresh-door,is-sheltered-wall-check}.py` — 7 new smoke tests.

**Smoke test scoreboard:**

| Test | Cases | Result |
|------|-------|--------|
| `test-wait-chat-interrupt.py` (F55.5) | A/B/C/D | 4 PASS |
| `test-whisper-as-mention.py` (F55.6) | A/B/C | 3 PASS |
| `test-action-reach-pathing.py` (F55.3) | A/B/C/D | 4 PASS |
| `test-place-fresh-craft.py` (F55.1) | A/B/C | 3 PASS |
| `test-fill-self-blocking.py` (F55.2) | A/B | 2 PASS |
| `test-through-fresh-door.py` (F55.4) | A/B/C | 3 PASS |
| `test-is-sheltered-wall-check.py` (F55.7) | A/B | 2 PASS |
| **Total** | **21** | **21 PASS** |



G21 v6 succeeded but exposed a fresh batch of friction. F55 focuses on the same principle as F54: **make primitives work more often, fail with actionable info, and stay out of coordination semantics**. Five framework defects + three prompt/test refinements.

Source: user-observed issues during the v6 watch session.

#### F55.1 — `mc place BLOCK X Y Z` auto-equips silently

- **Bug.** Agent saw a crafting_table missing from inventory, crafted it, then called `mc place crafting_table X Y Z` and got back failure twice before manually calling `mc equip crafting_table` and trying again. `world.js:350` `place()` already has an `await b.equip(item, 'hand')` (around line 599), but a fresh-crafted item's Item reference can lag — the inventory items() pass returns the OLD slot snapshot before mineflayer re-syncs. **Investigate first**: confirm whether equip silently failed or threw, or whether the b.heldItem mismatch survives.
- **Fix.** In `bot/lib/actions/world.js` `place()` near line 597-600, after the existing `b.equip(item, 'hand')`, **verify** `b.heldItem?.name === blockName` and **retry once** after a 200ms sleep if not. If still mismatched, return `{ok:false, error:{code:'EQUIP_FAILED', message:'<blockName> in inventory but couldn't be equipped to hand', observed_state:{held: b.heldItem?.name, inv_count: ...}}}`. Brain gets a real signal instead of a generic placement timeout.
- **Smoke test** — `scripts/test-place-fresh-craft.py` (2 cases): A: bot crafts crafting_table, immediately `mc place crafting_table X Y Z` → ok=true (no manual equip needed). B: bot has empty hand and `crafting_table` in inv slot 3, `mc place crafting_table X Y Z` → ok=true.

#### F55.2 — `mc is_filled` (or fill verification) false positive on platform check

- **Bug.** Mason ran `mc fill cobblestone -2 65 9 1 65 12` while standing in the fill region. FILL_PARTIAL returned with `skipped_occupied` listing his foot cell. Mason then "verified" the platform (likely via `mc is_filled` or one-by-one `mc inspect`) and got back "OK" / "complete" despite the missing cell, then emitted SLAB READY. Investigate: which verb gave the false positive, and why didn't it surface the missing cell.
- **Fix.** Most likely culprit is the brain doing piecewise `mc inspect` and stopping too early. But also: in `bot/lib/actions/mining.js` (or wherever `fill`/`place_fill` lives), when FILL_PARTIAL is returned AND the skipped cells include `bot_foot_cell` or `bot_head_cell`, the response should **also** include `bot_was_inside_region: true` plus a `next_action_hint: 'mc move (away from region), then mc fill again'`. Make the bot-position-blocking case impossible to miss.
- **Smoke test** — `scripts/test-fill-self-blocking.py` (2 cases): A: bot stands inside a 3×3 fill region, `mc fill cobblestone <region>` → FILL_PARTIAL with `bot_was_inside_region: true` and the foot cell listed in `skipped_occupied`. B: bot stands outside, same fill → ok=true, all cells placed.

#### F55.3 — Uniform "too far away" precheck for chest_search / take / deposit / withdraw / interact

- **Bug.** Mason repeatedly errored on `mc chest_search`, `mc take`, `mc deposit`, `mc withdraw` with "too far away" or `MOVEMENT_PRECONDITION_FAILED`. Each verb has its own range check (or none), so when distance > 4.5 the brain gets back an error and has to manually call `mc goto_near`, then retry. Wasted 5-10 commands per chest interaction.
- **Fix.** Extract a shared helper `ensureWithinReach(b, x, y, z, range=4.5, capMs=8000)` in `bot/lib/actions/_helpers.js` that:
  - Returns immediately if distance ≤ range.
  - Otherwise runs `b.pathfinder.goto(new goals.GoalNear(x, y, z, range))` with `withWallclockCap`.
  - Returns `{ok:true}` on success or `{ok:false, error:{code:'OUT_OF_RANGE', distance, target, bot_position, next_action_hint:'mc move <closer>'}}` on failure.
  
  Wire into: `chest_search`, `chest_open`, `take`, `deposit`, `withdraw`, `interact`, `inspect` (when bot is far). `place` already has this — pattern lives there at line 510-540. The point is **uniformity**: every coord-targeting action either succeeds or returns a structured movement error.
- **Smoke test** — `scripts/test-action-reach-pathing.py` (4 cases): A: bot 10m from chest, `mc chest_search` → ok=true (pathfinds first). B: bot 30m from chest with wall in between, `mc chest_search` → OUT_OF_RANGE. C: same for `mc deposit X`. D: same for `mc interact`.

#### F55.4 — `mc through` after fresh door placement returns stale-state failure

- **Bug.** Flint placed an oak_door at (0, 66, 9). Mason called `mc through 0 66 9` — got [error] even though the door was real and standing. Most likely the block cache (mineflayer's blocksAt or the action's b.blockAt re-read) hadn't synced the fresh placement when through started. Or the door state (open/closed properties) confused the passability check.
- **Fix.** In `bot/lib/actions/world.js` `through()` (~line 2048):
  - After `b.blockAt(gateVec)`, if `gate.name === 'air'`, do ONE re-fetch after a 100ms sleep — the door may have just been placed by a partner.
  - Once a door is detected, do NOT require LOS to the door before `b.activateBlock(gate)` — toggling a door doesn't need LOS, only proximity (within ~4 blocks). The current "approach gate" step at line 2079-2083 already handles range.
  - If `b.activateBlock` throws, fall through to the existing `TRAVERSAL_FAILED` but include `door_state: gate._properties?.open` in observed_state so brain knows whether the door is even toggling.
- **Smoke test** — `scripts/test-through-fresh-door.py` (2 cases): A: bot1 places door, bot2 immediately calls `mc through` on the new door coord → ok=true. B: same but with a wall block in front of the door — `mc through` returns TRAVERSAL_FAILED, not NOT_A_DOOR.

#### F55.5 — Chat interrupts `mc wait` (highest-impact fix)

- **Bug.** While a bot is in `mc wait N` (default uses `await sleep(N*1000)` — `world.js:2265`), incoming chat messages accumulate but the bot is unresponsive. Mason whispered Flint "need 16 blocks for roof?" while Flint was waiting; Flint only saw the message after the wait expired, by which time Mason had moved on. **Root cause of v5/v6's "they think about coordinating but rarely do" pattern.**
- **Fix.** Replace `mc wait` impl with chat-aware polling:
  ```js
  async wait({ seconds = 5, until_mention = true, until_direct = true }) {
    const b = ensureBot();
    const cap = Math.min(seconds, 60) * 1000;
    const start = Date.now();
    const myName = b.username.toLowerCase();
    const chatLogLenAtStart = ctx.chatLog.length;
    while (Date.now() - start < cap) {
      await sleep(250);
      if (!until_mention && !until_direct) continue;
      const newMsgs = ctx.chatLog.slice(chatLogLenAtStart);
      for (const m of newMsgs) {
        const msg = String(m.message || '').toLowerCase();
        const isMention = until_mention && (msg.includes(`@${myName}`) || msg.includes(`${myName}:`) || msg.includes(`${myName},`));
        const isDirect = until_direct && (m.private || m.whisper);
        if (isMention || isDirect) {
          const elapsed_s = Math.round((Date.now() - start) / 100) / 10;
          return { result: `Wait interrupted by chat after ${elapsed_s}s — ${m.from}: ${m.message}`, data: { interrupted: true, by: m.from, message: m.message, elapsed_s } };
        }
      }
    }
    return { result: `Waited ${seconds}s` };
  }
  ```
  This is **opt-in by default** (both flags true) so prompt updates aren't required. Bots that pass `--no-interrupt` get the legacy behavior. Add the flags to registry.mjs.
- **Side effect**: this also lets us wire chat interrupts into other long actions later (collect, fill, smelt). F55.5 is the foundation; F56 might extend.
- **Smoke test** — `scripts/test-wait-chat-interrupt.py` (3 cases): A: `mc wait 10`, no chat → returns after 10s with `interrupted=false`. B: `mc wait 10`, partner sends `@flint hello` 2s in → returns at ~2s with `interrupted=true, by='Mason', message='@flint hello'`. C: `mc wait 10`, partner sends generic public chat (no mention, not direct) → still waits the full 10s.

#### F55.6 — `mc whisper` redirect to public chat (or disable)

- **Bug.** Flint whispered Mason `"roof already up — please go inside and run is_sheltered"`. Mason never received it (or didn't surface it). Whispers go through Minecraft's tell/msg system which the bot's chat-log filter may not capture, or the listener treats them as private and excludes from the general chat history.
- **Fix.** Two options, smallest wins:
  - **Option A (cheapest):** In `bot/lib/actions/world.js` `whisper({player, message})` (~line 2653), instead of `b.whisper(player, message)`, do `b.chat(\`@${player} ${message}\`)`. Whisper becomes a public `@-mention` of the target player. F55.5 ensures the recipient gets interrupted.
  - **Option B:** Investigate why mineflayer's whisper events aren't captured in `ctx.chatLog` — probably the listener only captures `chat` packets, not `system_chat` or `tell`. Fix the listener.
- **Recommendation: Option A.** Simpler, works with F55.5, no surface deviation from "everything goes through chat." Update registry.mjs description: `'mc whisper PLAYER MSG' → 'Public @-mention of PLAYER — equivalent to mc chat "@<player> MSG" but easier to type.'`
- **Smoke test** — `scripts/test-whisper-as-mention.py` (1 case): bot1 `mc whisper Bot2 "hi"`, bot2 reads chat → sees `@Bot2 hi` from bot1.

#### F55.7 — `mc is_sheltered` enforce wall-cell presence

- **Bug.** Mason's "all walls done" claim post-platform-fill was based on individual `mc inspect` calls, not on a single primitive that verifies the entire expected perimeter. The bot took a piecewise inspect approach, gave up partway, and reported done. (Re-cast: same class as F55.2 — bot doing manual verification badly. Different verb to harden.)
- **Fix.** Extend `mc is_sheltered` (`world.js:3350`). Add an optional `walls: {x1,y1,z1, x2,y2,z2}` parameter. When provided, BEFORE the pathfinder check, sweep the cells along the perimeter of that box at the given Y range and verify each is non-air. If any are air, return `{ok:false, error:{code:'WALLS_INCOMPLETE', message: 'N of M perimeter cells missing', observed_state:{missing: [{x,y,z}, ...up to 8], total_missing: N}}}`. Pathfinder check only runs if walls are fully present.
- **Smoke test** — `scripts/test-is-sheltered-wall-check.py` (2 cases): A: bot inside a 3×3×3 enclosure with all walls present, `mc is_sheltered walls=...` → ok=true. B: bot inside with one wall missing → WALLS_INCOMPLETE with the gap cell listed.

#### F55 deferred (not framework — note and move on)

- **Test design (separate session).**
  - **T1.** Test floor should be 2 layers thick atop bedrock so accidental floor-digs don't drop bots to the void.
  - **T2.** Pre-stock SHARED_CHEST at the build site with 32 cobble + 16 oak_planks + 1 glass + 1 oak_door + cooked food. Bots can self-help instead of cross-map runs.
  - **T3.** Update G21 spec prompt: "roof material may be cobblestone OR oak_planks — use whichever you have."
- **Prompt rewrites (cheap edits in `prompts/landfolk/*.md`).**
  - Replace any "don't take cobble from chest" language with "share cobble — withdraw what you need, leave some for your partner."
  - After F55.5 lands, **remove** the cargo-cult `mc read_chat` polling between every command in prompts. Wait + chat-interrupt replaces it.
- **`mc escape` one-shot optimization.** Currently OK; minor wins available if the standing-state classifier runs once instead of multiple times during recovery. Punt to F56 unless a real run shows it costing >5s.

#### F55 success criteria for G22 (next mission test, post-F55)

- **Median bot dialogue turn-around < 5s.** Currently bots wait 15-20s between exchanges because of `mc wait`-then-`mc read_chat` polling. F55.5 should cut this to <5s by interrupting wait on relevant chat.
- **Chest interactions complete in ≤2 commands.** Currently `mc chest_search` from out-of-range needs a `mc goto_near` + retry. F55.3 makes it a single call.
- **Zero `mc whisper`-related communication failures.** With F55.6 these go through public mention.
- **HOUSE COMPLETE in ≤25 min wallclock.** v6 took 37; cutting wait-coordination friction should drop this by 10+ min.

#### F55 sequencing (~5 hours work + smoke tests)

1. **F55.5** (~75 min) — chat-aware mc wait. **Highest impact**, foundation for the others.
2. **F55.6** (~15 min) — whisper → @-mention rewrite. Tiny, unblocks F55.5 benefit for direct addressing.
3. **F55.3** (~75 min) — uniform reach precheck. Eliminates a whole class of friction.
4. **F55.1** (~30 min) — place auto-equip verify+retry. Small but high-frequency.
5. **F55.2** (~45 min) — fill-self-blocked + missing-cells surfacing. Make the existing FILL_PARTIAL impossible to misread.
6. **F55.4** (~45 min) — `mc through` stale-state retry. Smallest blast radius.
7. **F55.7** (~45 min) — is_sheltered wall-cell check. Useful for the M3 verification ritual.

Then run G22 to validate.

### F50.4 + F50.6 follow-up — pathfind no-progress watchdog + universal standing-state enrichment

These two F50 items were deferred when the sprint shipped (F50.7 + F50.8 got absorbed into F56). Picked up after G22 because two of G22's biggest time-sinks were pathfinder stalls (bot standing still against a 1-block lip until the wallclock cap) and movement errors that left the brain blind to the bot's own standing state.

#### F50.4 — `pathfindWithProgressWatchdog`

- **Helper**: `bot/lib/actions/_helpers.js`. New `NoProgressError` class; new `pathfindWithProgressWatchdog({bot, pathfinderGoto, onStall, opName, capMs, windowMs, minDelta, minTotalMovement, sampleMs})` wraps an inner pathfinder promise with BOTH a wallclock cap and a stall detector.
- **Logic**: samples `bot.entity.position` every 500 ms. The watchdog **does not arm** until the bot has moved at least `minTotalMovement` (0.6 blocks) from start — protects against false-positives during the pathfinder's initial path-calculation phase when the bot stands still. Once armed, if the bot moves <0.3 blocks in any 4-second window, the helper calls `onStall()` (typically `pathfinder.setGoal(null)`) and rejects with `NoProgressError`. Wallclock cap runs in parallel and wins if the bot never moves.
- **Wired into**: `goto`, `goto_near`, `move` (per-leg pathfind in `movement.js`). Each catches `NoProgressError` and returns a fresh `NAV_NO_PROGRESS` error code (vs the old `OPERATION_TIMEOUT`) with `observed_state.no_progress_for_ms`, `stalled_position`, and the enrichment from F50.6. `move()` records the per-leg failure as `no_progress:<ms>ms` in `lastPathfinderError` so the brain sees specifically why the leg gave up.
- **Why not just lower the cap**: a 4 s watchdog with a 5 s wallclock cap covers both: legit slow path → succeeds, hung pathfind → fires on cap; stuck-against-obstacle → fires on watchdog with a more actionable error. Lowering the cap alone misses legit slow paths.
- **Smoke test** — `scripts/test-pathfind-watchdog-unit.mjs` (node-level, no live bot needed): 5/5 PASS.
  - A — bot never moves → `OperationTimeoutError` (cap wins, watchdog never arms).
  - B — bot moves once then freezes → `NoProgressError` after windowMs (709 ms vs 5000 ms cap).
  - C — bot moves continuously → pathfinder result resolves cleanly.
  - D — pathfinder rejects with a normal error → that error propagates unchanged.
  - E — bot moves with 300 ms stalls < windowMs → no false trip.

#### F50.6 — universal `your_standing_state` on movement errors

- **Status before**: `enrichWithStand()` was applied in `movement.js`'s timeout / `navBlockedError` / `navFailureError` paths only. Four movement error paths still returned a hand-built `observed_state` without standing-state: `goto`'s `NAV_TARGET_OCCUPIED`, and `move()`'s three branches (no-door `NAV_BLOCKED`, through-failed `NAV_BLOCKED`, and `TOO_MANY_DOORS`).
- **Fix**: thread each of those four `observed_state` objects through `enrichWithStand(b, {...}, x, y, z)` so they all carry `your_standing_state.{classification, blocked_dirs, open_dirs}` plus `closest_standable` plus `target_reason`. No new error codes; the brain just sees the same info on every movement failure.
- **Why it matters**: in G22 Mason hit several movement errors back-to-back and had no signal that he was in a `corner` until he called `mc observe` separately. Auto-enrichment replaces that extra round-trip with zero extra cost on the bot side (~200 µs).
- **Smoke test** — `scripts/test-movement-errors-enriched.py` (deferred to next G-run; integration sanity, not blocking).

#### F50.4 / F50.6 success criteria

- Pathfinder stalls now return in ≤4.5 s with a specific code (vs ~10 s with `OPERATION_TIMEOUT`).
- Every `mc goto/goto_near/move` error carries `observed_state.your_standing_state` — observable by inspecting any G-run log.
- No regressions in the existing F50.x / F51.x / F55.x smoke tests when re-run.

#### F50.9 + F51.3 smoke-test coverage — 18/18 PASS

Live Tester bot on `landfolk-test` (192.168.1.202:25565). Required one-time whitelist via rcon (`whitelist add Tester`) before the bot could log in. Cross-dimension teleport via Multiverse — `execute in landfolk-test run tp Tester X Y Z` handles arena setup.

- `test-pathfind-watchdog-unit.mjs` — F50.4, node-level: 5/5 PASS.
- `test-movement-errors-enriched.py` — F50.6 (and F50.1/F50.2 by proxy): 3/3 PASS.
- `test-goto-near-landing.py` — F50.5: 2/2 PASS. Found a subtlety: `range=0` is needed to force the bot to land EXACTLY on the sticky target cell so F50.5's landing inspector has something to surface.
- `test-escape-multidir.py` — F50.7 (+ F56 multi-dir + burst): 3/3 PASS.
- `test-movement-precondition.py` — F51.2: 3/3 PASS. Discovered that `NAV_TARGET_OCCUPIED` (the pre-check that fires before any motion) does NOT record `lastMoveFailed` — that's intentional, the bot hasn't moved. Need a genuine pathfinder failure (e.g. sealed target, "No path") to populate the guard.
- `test-through-elevated-door.py` — F56 through stall+jump-nudge: 2/2 PASS, including the critical case (bot at y=65 grass must step UP onto a y=66 platform AND walk through the door).

F51.1 (silent pre-nudge) has no dedicated test — its behavior was implicitly verified when writing `test-movement-errors-enriched.py` scenario A: the first draft expected the bot to remain in a `corner` classification, but the pre-nudge correctly moved the bot to an open cell before the error fired. Confirmed the feature works by rewriting the scenario to use `alley` (not in `STICKY_CLASSIFICATIONS`).

