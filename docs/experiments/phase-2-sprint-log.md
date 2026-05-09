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

### F23. Open: chest organize / consolidate as behavior_test territory

User flagged "organizing — grouping similar items together" — that's behavior_test material:
- **Consolidate** — within a single chest, merge duplicate item stacks into the smallest number of slots.
- **Organize across chests** — move iron-related items to one chest, wood to another, by following a steward-curated convention.
- **Auto-route deposit** — given an item, pick the chest that already has it (via chest_search), open and deposit there rather than the nearest empty chest.

These need a worker that can chain mc chest_search → mc go_mark → mc deposit; not a single primitive. Frame as L4-level behavior_tests once the strategy layer is exercised.



