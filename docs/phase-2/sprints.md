# Phase 2 — Sprint plan & success criteria

Sections 14, 15, and 16 (success criteria) of the Phase 2 architecture: refactor plan, capability-driven sprints, and per-sprint exit gates. Sprint 5+ added below.

## 14. Refactor plan (Sprint 1 scope)

All on `experiment/hermes-agents`:

### Action contracts (gating)
- `mc collect` (`bot/lib/actions/mining.js:8-229`) — enforce `ok=false` on `mined_count==0`; return `data.mined_count`, `data.requested_count`; map error paths to enum codes
- `mc dig` (`bot/lib/actions/mining.js:231-248`) — error code enum (NO_BLOCK_AT_COORD, OUT_OF_RANGE, TOOL_INADEQUATE, PROTECTED_BLOCK, INTERRUPTED); `data.dropped_items`; `data.position_after`
- `mc place` (`bot/lib/actions/world.js:281-328`) — error code enum (NO_SOLID_NEIGHBOR, TARGET_OCCUPIED, INVENTORY_MISSING, OUT_OF_RANGE); `error.observed_state.neighbors`
- `mc craft` (`bot/lib/actions/crafting.js:7-97`) — error code enum (NO_RECIPE, MISSING_INGREDIENTS, TABLE_REQUIRED, TABLE_OUT_OF_RANGE); `data.crafted_count`, `data.ingredients_consumed`
- `mc chest` — error code enum (NO_CONTAINER, NO_MARK, OUT_OF_RANGE); `data.container_kind`, `data.item_counts`

### Dispatcher patch (gating)
- Skip cards where `assignee == "human"` — never spawn worker
- On `bug_report` with status=`done` AND `summary` matching `/^fixed in [a-f0-9]{7,40}/`, auto-create the dependent `verify_fix` card

### Already done in Phase 1 (1.4)
- `bin/mc` symlink resolution fix
- Per-profile `terminal.env_passthrough: [MC_API_URL, MC_USERNAME]`

### Sprint 0 deliverables (infrastructure, not gating)
- `scripts/setup-landfolk-profiles.sh` — creates `gatherer` + `flint` profiles cleanly
- `scripts/landfolk-bodies-only.sh` — launches 2 Mineflayer bodies
- `scripts/run-fixture.sh` — runs fixture prep/cleanup
- `data/marks/canonical.yaml` — initial 3-mark seed: `@base`, `@test_origin`, `@spawn_landfolk`
- `data/capability-matrix.yaml` — empty matrix scaffold for L0–L4
- `data/test-fixtures/L0/L0.1_health_connected.yaml` — first fixture (smoke test)

## 15. Sprints 0–4 (capability-driven)

### Sprint 0 — Bootstrap (1 session)

**Goal:** Two-bot setup running, dispatcher patched for `human` assignee, first capability_test card runs end-to-end through the full loop (prep → dispatch → worker → metadata → matrix).

**Tasks:**
1. Server: confirm Multiverse, create `landfolk-test` flat world per §12
2. `scripts/setup-landfolk-profiles.sh` (gatherer + flint)
3. `scripts/landfolk-bodies-only.sh` launches 2 bodies on ports 3001/3002
4. Dispatcher patch (skip `human`, auto-spawn verify_fix)
5. Bootstrap files: marks YAML, matrix YAML, fixture YAML for L0.1
6. `scripts/run-fixture.sh` working
7. Smoke-run L0.1 capability_test card end-to-end

**Exit gate:**
- L0.1 (`health_connected`) test passes
- One synthetic bug card filed and verified to demonstrate the verify_fix loop

### Sprint 1 — L0 + Action contracts (1–2 sessions)

**Goal:** L0 green; primitive action contracts shipped for `mc dig`, `mc collect`, `mc place`, `mc craft`, `mc chest`.

**Action contracts ship first** because L1+ tests can't pass cleanly without them. Most of these are bug fixes per §14.

**L0 capability tests** (6, all use the same simple fixture):

| Test ID | What it checks |
|---------|---------------|
| L0.1_health_connected | `/health` returns connected=true with position; move_rate calculated after motion |
| L0.2_health_disconnected | bot offline (kill -9 the body) → `/health` returns connected=false |
| L0.3_observe_payload | `/observe` payload contains all required fields per the explore agent's spec |
| L0.4_observe_action_loop | inject 3 identical failed actions → observe shows `action_loop` warning |
| L0.5_marks_list_empty | empty marks file → `/marks` returns empty array |
| L0.6_marks_list_with_distance | seeded marks file → `/marks` returns entries with `distance_m` |

Worker side: each test is a tiny script (just `mc status`, `mc nearby`, etc.) — minimal LLM cost.

**Exit gate:**
- L0 all green
- All 5 primitive action contracts implemented; no `priority: blocking` bugs open
- One worked example of L1 test running cleanly (smoke check that contracts don't break L1+)

### Sprint 2 — L1 (movement) (1–2 sessions)

**Goal:** L1 green for both bots.

**Capability tests (10):**

| Test ID | What it deliberately exercises |
|---------|-------------------------------|
| L1.1_goto_simple | short path on flat ground |
| L1.2_goto_near_radius | radius arg honored |
| L1.3_goto_timeout | distant target hits 15s timeout; advisory message returned |
| L1.4_goto_unreachable | target across canyon → contract failure |
| L1.5_bg_goto_lifecycle | bg_goto starts, completes, currentTask reflects |
| L1.6_bg_goto_cancel | start, cancel, status='cancelled', pathfinder cleared |
| L1.7_follow_player_present | follow when player online |
| L1.8_follow_player_absent | follow when player offline → contract error |
| L1.9_pillar_step_y62_trap | **Phase 1.1 deliberate trap**: bot in 6-block hole, `mc pillar_step 6` → escape |
| L1.10_go_mark_navigation | go_mark to seeded mark |

**Worked example — L1.9 fixture:**

```yaml
# data/test-fixtures/L1/L1.9_pillar_step_y62_trap.yaml
world: landfolk-test
prep:
  # L1 region centered at (50, 65, 0); pillar_step trap at (66, 64, 16)
  - "execute in landfolk-test run fill 32 60 -16 96 100 16 minecraft:air"
  - "execute in landfolk-test run fill 64 60 14 68 70 18 minecraft:stone"   # raised platform
  - "execute in landfolk-test run fill 66 64 16 66 70 16 minecraft:air"     # carve 6-deep hole
  - "mvtp Flint landfolk-test"
  - "execute in landfolk-test run tp Flint 66 65 16"                         # tp 1 above hole bottom
  - "clear Flint"
  - "give Flint minecraft:dirt 16"
  - "effect give Flint minecraft:saturation 1 10"
  - "effect give Flint minecraft:slow_falling 5 0 true"
required_marks: []
cleanup:
  - "execute in landfolk-test run fill 32 60 -16 96 100 16 minecraft:air"
  - "mvtp Flint world"
  - "execute in landfolk-test run kill @e[type=item,distance=..50]"
```

**Worked example — L1.9 capability_test card body:**

```yaml
id: L1.9_pillar_step_y62_trap
level: L1
capability: movement.pillar_step
bot: flint
fixture: L1/L1.9_pillar_step_y62_trap.yaml
preconditions:
  bot_position: "(16, 64, 16) — bottom of 6-block stone-walled hole"
  inventory: "16x dirt"
action_sequence:
  - mc pillar_step 6
success_predicate:
  - { kind: response_field, field: "ok", op: "==", value: true }
  - { kind: response_field, field: "data.placed_count", op: "==", value: 6 }
  - { kind: bot_position_within, coords: [16, 70, 16], radius: 1 }
  - { kind: inventory_contains, item: dirt, count: "==10" }     # 16 - 6 = 10
timeout: 60s
retry_policy: { transient: 1, outcome: 0 }
exercises_phase1_bug: "1.1's Y=62 hole trap; pillar_step is the existing primitive that should solve it"
```

**Expected bug surface:**
- `mc goto` 15s timeout returning `ok=true` advisory but bot didn't reach → contract violation, file bug
- `mc bg_goto` cancel race conditions
- `pillar_step` consecutive-failure short-circuit firing on legit terrain

**Exit gate:**
- L1 all green
- ≤2 non-blocking bugs open

### Sprint 3 — L2 + L3 (inventory, basic gather + craft) (2–3 sessions)

**Goal:** L2 + L3 green. This is where collect/craft contracts get exercised heavily.

**L2 tests (8):** equip success/missing/swap, unequip with full inventory, toss partial stack, pickup drops.

**L3 tests (14)** — code-grounded around the discovered handler complexity:

| Test ID | What it deliberately exercises |
|---------|-------------------------------|
| L3.1_dig_basic | dirt with bare hand → success |
| L3.2_dig_air | target is air → contract: `NO_BLOCK_AT_COORD` |
| L3.3_dig_wrong_tool | stone with wooden_axe held → contract: `TOOL_INADEQUATE` |
| L3.4_dig_protected | crafting_table → contract: `PROTECTED_BLOCK` |
| L3.5_collect_basic | 3 oak_log within 5 blocks → mined_count==3 |
| L3.6_collect_silent_failure | **Phase 1 bug**: 3 oak_log far away → contract: `ALL_PATHFIND_FAILED`, NOT `ok=true mined_count=0` |
| L3.7_collect_partial | 5 requested, 2 reachable → ok=true with partial_failure flag, mined_count=2 |
| L3.8_collect_fair_play_los | log behind water in fair-play mode → contract: `NO_VISIBLE_BLOCKS` |
| L3.9_pillar_step_jumping | basic 5-block pillar, plenty of dirt |
| L3.10_pillar_step_no_blocks | empty inventory → contract failure |
| L3.11_craft_hand_recipe | sticks from planks (no table) |
| L3.12_craft_table_required_present | chest from planks; table at 3 blocks |
| L3.13_craft_table_required_absent | chest from planks; no table → contract: `TABLE_REQUIRED` |
| L3.14_craft_missing_ingredients | chest with 0 planks → contract: `MISSING_INGREDIENTS` |

**Expected bug surface:**
- L3.6 will FAIL initially (Phase 1 bug deliberately exercised) → `[BUG][L3.6] mc collect returns ok=true with mined_count=0 on unreachable trees`
- L3.7 may need `partial_failure` flag added to contract
- Smelt is not in L3 (move to L4); blocking 30s deserves its own test
- Discover (`mc discover`) deferred to L4 (not on hot path for L3)

**Exit gate:**
- L2 + L3 all green
- All 5 contracts holding firm; no contract regressions
- Phase 1's `mc collect` bug fixed and verified

### Sprint 4 — L4 (mining) (2–3 sessions)

**Goal:** L4 green. Flint is the workhorse; this is the deepest capability set.

**L4 tests (15)** — covers the action richness the explore agent surfaced:

| Test ID | What it deliberately exercises |
|---------|-------------------------------|
| L4.1_dig_stone_with_pickaxe | stone with stone_pickaxe → succeeds |
| L4.2_dig_stone_no_pickaxe | stone with bare hand → contract: `TOOL_INADEQUATE` |
| L4.3_dig_iron_ore_stone_pickaxe | iron_ore with stone_pickaxe → succeeds |
| L4.4_dig_diamond_iron_pickaxe | diamond_ore with iron_pickaxe → succeeds |
| L4.5_dig_diamond_stone_pickaxe | diamond_ore with stone_pickaxe → contract: `TOOL_INADEQUATE` (tier mismatch) |
| L4.6_pillar_step_deep_escape | 30-block hole, 32 dirt → escape with 2 blocks remaining |
| L4.7_dig_area_5x5x5 | clean excavation, no obstacles |
| L4.8_dig_area_with_stand | bot in middle of area; nudge-off + stand-block-last |
| L4.9_tunnel_simple | 10-block straight tunnel, 2x3 cross-section |
| L4.10_stair_up_solid_ground | 10-step staircase, no auto-floor needed |
| L4.11_stair_up_open_cave | 10-step staircase over cave; auto-floor placement |
| L4.12_stair_down_to_layer | descend to known Y |
| L4.13_find_blocks_coal_ore | discover within radius, returns distance + bearing |
| L4.14_chest_deposit | open chest, deposit 32 cobble; metadata.inventory_delta correct |
| L4.15_float_straddle_dig | **Phase 1.4 deliberate**: bot at X=10.4, dig at X=10 → succeeds; verify floor coord used consistently |

**Worked example — L4.5 (tier mismatch contract test):**

```yaml
id: L4.5_dig_diamond_stone_pickaxe
level: L4
capability: mining.dig.tier_mismatch
bot: flint
fixture: L4/L4.5_diamond_stone_pickaxe.yaml
preconditions:
  bot_position: "(20, 50, 20) — adjacent to single diamond_ore block at (21, 50, 20)"
  inventory: "1x stone_pickaxe (held)"
action_sequence:
  - mc equip stone_pickaxe
  - mc dig 21 50 20
success_predicate:
  - { kind: response_field, field: "ok", op: "==", value: false }
  - { kind: response_field, field: "error.code", op: "==", value: "TOOL_INADEQUATE" }
  - { kind: response_field, field: "error.next_action_hint", op: "contains", value: "iron_pickaxe" }
  - { kind: inventory_contains, item: diamond, count: "==0" }
  - { kind: world_block_at, coords: [21, 50, 20], block: "diamond_ore" }   # block still there
timeout: 15s
exercises_phase1_bug: null
```

**Expected bug surface:**
- `mc place` "no solid neighbor" still firing where Mason's foundation pattern works → may need `place_against` primitive (file FEAT)
- `dig_area` nudge-off race conditions
- `stair_up` auto-floor placement in open caves not always reliable
- `find_blocks` bearing calculation off by one quadrant in some cases

**Exit gate:**
- L4 all green
- `[BUG][L4.x]` count for blocking < 3
- Phase 2 done; tag `phase2-sprint4-passed`; appendix-promoted features can begin

## 16. Success criteria

### Per-sprint exit gates (sharpened from earlier draft)

| Sprint | Gate |
|--------|------|
| 0 | L0.1 passes; one bug→fix→verify cycle completes end-to-end |
| 1 | L0 fully green (6/6 tests, 2 consecutive passes each); 5 action contracts implemented; no blocking bugs open |
| 2 | L1 fully green (10/10); ≤2 non-blocking bugs open; pillar_step Y=62 trap escapes deterministically |
| 3 | L2 + L3 fully green (8 + 14); Phase 1's `mc collect` silent-failure bug fixed and verified; no contract regressions |
| 4 | L4 fully green (15/15); float-straddle test passes; Phase 2 tag applied |

### Phase 2 "shippable" definition

A 4-hour live run on `landfolk-test` where:
- L0–L4 all green; capability matrix shows 53/53 tests with `consecutive_pass >= 2`
- Zero open `priority: blocking` bug_reports
- Action contracts hold under random fuzz: 100 randomly-selected capability tests run consecutively with no `ok=true` masking a real failure
- Total worker token spend for the 4-hour run < $5

If we hit those, Phase 2 is done. The action layer is reliable; the loop is boring; we're ready for Phase 3.

---

## Sprint 5 — Building primitives (L5)

**Status:** **shipped** (2026-05-10). All planned verbs + fixtures landed plus two unplanned-but-essential additions: `mc move` (smart non-destructive nav) and the pathfinder canDig=false architectural change.

**Goal:** the bot can construct basic structures via composed primitives. Unlocks Sprints 7–9 (liquids in pits, walled crop fields, fenced animal pens).

### Verbs

| Verb | Shape | Notes |
|---|---|---|
| `mc wall` | `mc wall X1 Y1 Z1 X2 Y2 Z2 BLOCK` | Sugar over `mc fill` for vertical line/rect. First deliverable — smallest unit. |
| `mc fence` | `mc fence X1 Z1 X2 Z2 [--gate DIR]` | Place fence enclosure with optional gate; auto-equips fences and gate item. |
| `mc through` | `mc through GX GY GZ [DX DY DZ]` | Open a gate/door, walk to the far side, close it behind. Differentiates traversal from raw `mc interact` toggling. |
| `mc level` | `mc level X1 Z1 X2 Z2 Y` | Flatten rectangle to target Y: dig blocks above Y, fill empties below Y. |
| `mc dig_pit` | `mc dig_pit X Z W L D [TOP_Y]` | Dig W×L×D pit. Wraps `mc dig_area`. (`--stairs` flag deferred — bot can call `mc dig_pit` then `mc build_stairs` to climb out.) |
| `mc path` | `mc path X1 Z1 X2 Z2 [Y]` | Use shovel on dirt/grass to convert to dirt_path along an axis-aligned line/rect. |
| `mc build_stairs` | `mc build_stairs BLOCK DIR LEN` | Builds an ascending triangular ramp (each column is filled from floor up to height i). Pure cube-step staircases can't be placed mid-air — every block needs a face neighbor below. |
| `mc move` *(unplanned)* | `mc move X Y Z [--max-doors N] [--door GX GY GZ]` | Smart non-destructive nav. On NAV_BLOCKED, auto-detects a door/gate between bot and target, opens it via `mc through` (closes behind), and recurses. Up to max-doors legs. Replaces `mc goto` for general navigation. |

### Action contract

Every new verb conforms to `phase-2/action-contracts.md`:
- success: `{ ok: true, data: { blocks_placed, blocks_dug, ... }, result: 'human summary' }`
- failure: `{ ok: false, error: { code, message, observed_state, retry_safe } }`
- error codes (initial): `MISSING_BLOCK_TYPE`, `OUT_OF_RANGE`, `MISSING_TOOL` (for path), `WORLD_OBSTACLE`

### Fixtures (L5)

| ID | Tests |
|---|---|
| L5.1 | `wall_basic` — 3-block-tall cobblestone wall in a clear arena |
| L5.2 | `wall_extended` — 5×3 wall, verifies multi-row fill |
| L5.3 | `fence_enclosure` — 5×5 oak_fence enclosure with a single south-side gate |
| L5.4 | `level_grass_to_y65` — flatten a 7×7 area with 1-block bumps; result must be flat |
| L5.5 | `dig_pit_with_stairs` — 5×5×4 pit with corner staircase exit; bot can walk out |
| L5.6 | `path_5_blocks` — convert 5 dirt blocks to dirt_path |
| L5.7 | `build_stairs_up` — 4-block ascending staircase |
| L5.10 | `through_gate` — open fence_gate, walk through, close behind. Verifies `mc through` end-to-end. |
| L5.11 | `through_door` — 5×5 cobble house with oak_door; bot enters and exits, doors closed each time. |
| L5.12 | `move_through_building` — 2-room vestibule layout; 5 scenarios (open path / one door / two doors / sealed / --door override) covering all `mc move` paths. |
| L5.99 | **exit gate** — bot builds a 5×5 fenced + leveled + path-floored enclosure with a south gate, then walks out through it. End-to-end multi-verb composition. |

### Benchmark additions

Add 4–5 new tasks to `scripts/benchmark/tasks/composition.json` covering Sprint-5 multi-step flows (at minimum: `build_3x3_floor`, `fence_enclosure_with_gate`, `level_then_path`). These exercise the two-tier eval as much as single-shot.

### Exit gate

- All L5 fixtures green (2 consecutive passes each).
- `node scripts/check-conventions.mjs` passes (every new verb has `description` + `examples`).
- `node scripts/benchmark/run.mjs` shows no >5pp regression on existing tasks; new L5 tasks land in the leaderboard.
- Skill text update in `skills/minecraft-building.md` references the new verbs (referencing `mc <cmd> --help` for detail; no inlined arg docs per P3).

### Implementation order

1. `mc wall` — thinnest sugar over `mc fill`. Validates the new-verb pipeline (handler → registry → fixture → benchmark) end-to-end. ~90 min.
2. `mc fence` — adds gate-orientation logic; `feed_mob` style equip-then-place pattern.
3. `mc path` — small; needs hoe-or-shovel selection + auto-equip.
4. `mc build_stairs` — mirror of `mc mine stairs`; reuses pathing.
5. `mc level` — first multi-direction primitive (dig high, fill low).
6. `mc dig_pit` — composition of `mc mine area` + `mc build_stairs` (when `--stairs`).

### Estimated scope

1–2 sessions. First verb is the longest because it sets up the registry/fixture/benchmark pattern; subsequent verbs are 30–45 min each.

### Sprint 5 retrospective (post-ship)

What landed beyond the original plan:

- **`mc move`** — smart non-destructive nav. Wasn't planned; surfaced when `mc through`/`mc goto` interactions exposed that agents need a single "go here" verb that handles doors automatically. Picks the closest accessible door (score by `dist(bot, near_side)`) — multi-door buildings unwind one door per leg. Closes every door behind.
- **Pathfinder canDig=false default** — empirical trap tests confirmed pathfinder breaks doors and tunnels through floors when `canDig=true`, even with `oak_door` in `protectedBlocks` (the protection list is unreliable for wooden doors). Reverted to `canDig=false`; navigation is now strictly read-only. Mining is explicit (`mc collect`/`mc dig`/`mc tunnel`).
- **Action-contract failures on `mc goto`** — `NAV_BLOCKED`, `NAV_TIMEOUT`, `NAV_FAILED` codes with `observed_state` and hints pointing at `mc through` / `mc tunnel`.
- **`mc through` rewrite** — uses direct movement (not pathfinder) for the door-cross step, so closed-door bypass via tunneling can't happen.

What was deferred:

- `mc dig_pit --stairs` — bot can chain `mc dig_pit` + `mc build_stairs` instead. Re-evaluate if real use cases demand the combined verb.
- `composition.json` benchmark additions for Sprint 5 — the L5 fixtures cover the integration cases; benchmark tasks for `wall`, `fence`, `path`, `level`, `build_stairs`, `dig_pit`, `move`, `through` were added to `direct.json`.
- Cleanup of `protectedBlocks` and legacy block-tagging workarounds — deferred to building-and-integration phase since `canDig=false` makes them defense-in-depth, not the primary safeguard.

What landed during cleanup:

- `skills/minecraft-navigation.md` v3.2.0: documents `mc move` as the default navigation verb; demotes `mc goto` to "raw pathfinder, open spaces only"; adds a verb-picking table covering doors, terrain, and explicit destruction.
- `skills/minecraft-building.md` v4.2.0: surfaces the building-primitive verbs (`mc wall`, `mc fence`, `mc level`, `mc path`, `mc dig_pit`, `mc build_stairs`) as the preferred bulk-placement tools; corrects the old `for x..for z: mc place` anti-pattern to recommend `mc level` + `mc fill` instead.

---

## Sprint 6 — Safe mining (L6)

**Status:** **shipped** (2026-05-10). Scope narrowed mid-sprint — `mc seal` deferred since agents can use raw `mc place` for the rare wall-off-a-hazard case.

**Goal:** the bot can mine at depth (Y < 0, near lava/gravel) without dying as a side-effect of unsafe digs. The "long-running infrastructure destruction" problem from Sprint 5 had a sibling: agents accidentally suiciding by digging into lava, suffocating under falling sand, or mining the floor out from under themselves. Sprint 6 makes those into action-contract failures with `HAZARD_*` codes, not silent deaths.

This unlocks Sprint 7 (liquids) which assumes the bot can reliably get iron ingots without burning to death at Y=15.

### Verbs

| Verb | Shape | Notes |
|---|---|---|
| `mc safe_dig` | `mc safe_dig X Y Z [--force]` | Like `mc dig` but checks for HAZARD_LAVA, HAZARD_FALL, HAZARD_SUFFOCATE before swinging. `--force` falls back to raw `mc dig` for power-user override. |
| `mc scout` | `mc scout X Y Z [RADIUS]` | Observation primitive: list lava/water cells, gravity-affected blocks, bedrock proximity, hostile mobs within radius. Read-only; cheap; intended for "look before you mine". |
| ~~`mc seal`~~ | *deferred* | Wall-off-a-hazard verb; not strictly needed for safe mining basics (agent can `mc place` directly). Re-evaluate after agent integration when we see how often agents try to wall off discovered lava. |

### Existing-verb upgrades

- `mc dig`: adds pre-check delegate to `mc safe_dig`. Existing direct callers should switch to `mc dig --force` if they actually want the unsafe semantics (none in current code — the change is transparent).
- `mc dig_area` and `mc tunnel`: per-block hazard pre-check; on HAZARD, abort with partial-completion data and the hazard cell named.

### Action contract

| Error code | When | observed_state | retry_safe |
|---|---|---|---|
| `HAZARD_LAVA` | block adjacent to dig target is lava (would flow on bot) | `hazard: { kind:"lava", at:{x,y,z} }` | false |
| `HAZARD_FALL` | block under bot's standing position would be removed by the dig | `hazard: { kind:"fall", drop:N }` | false |
| `HAZARD_SUFFOCATE` | block above dig target is sand/gravel/anvil and the target is what holds it up | `hazard: { kind:"suffocate", falling_block:"sand" }` | false |
| `TOOL_INADEQUATE` | as Sprint 4 — pickaxe tier wrong for block | `held: "wooden_pickaxe", required:"stone_pickaxe"` | false |
| `PROTECTED_BLOCK` | bedrock, beacon, etc. | `block: "bedrock"` | false |

### Fixtures (L6)

| ID | Tests |
|---|---|
| L6.1 | `dig_into_lava` — wall block with lava behind; safe_dig returns HAZARD_LAVA, lava unrevealed |
| L6.2 | `dig_under_sand` — sand column above stone target; HAZARD_SUFFOCATE |
| L6.3 | `dig_floor_under_self` — bot at (0,65,0), dig (0,64,0); HAZARD_FALL |
| L6.4 | `scout_lava_radius` — scout within 8 finds 3 placed lava cells with correct coords |
| L6.5 | `tunnel_into_lava` — `mc tunnel` aborts when it would dig into lava, partial-completion data |
| ~~L6.6~~ | *deferred (seal-dependent)* |
| ~~L6.7~~ | inline-verified in L6.1 (force override) |

### Benchmark additions

Add `safe_mine_to_diamond_layer` and `mine_through_gravel` tasks to `direct.json` so model evaluations exercise hazard-aware verb selection.

### Exit gate

- All L6 fixtures green (2 consecutive passes each).
- 30-minute unattended strip-mining run shows zero hazard-caused deaths (was the primary failure mode for Phase 1 mining bots).
- `check-conventions.mjs` passes.
- `skills/minecraft-survival.md` updated to point agents at `mc safe_dig` / `mc scout` for any below-Y=16 work.

### Implementation order

1. **`mc safe_dig`** ✅ shipped (41207e4) — HAZARD_LAVA, HAZARD_FALL, HAZARD_SUFFOCATE; `--force` override.
2. **`mc scout`** ✅ shipped (b167c28) — block-based hazards; known limitation on mob detection in Multiverse worlds.
3. **Upgrade `mc dig_area` / `mc tunnel`** to per-block hazard pre-check + abort-with-partial-completion. `mc dig` stays as the raw single-block verb; agents reach for `mc safe_dig` instead.
4. **Skill text update** in `minecraft-survival.md` pointing agents at `mc safe_dig` / `mc scout` for any below-Y=16 work.
5. **L6.5 fixture** — `mc tunnel` into a hidden lava pocket aborts cleanly.

`mc seal` deferred — agents can use `mc place` directly for the rare "wall off this lava" case. Re-evaluate after agent integration shows how often it comes up.

### Estimated scope

~1 session remaining; bulk of work was the hazard-detection logic in `dig-tools.js`.

---

## Sprint A — Agent integration tests

**Status:** **shipped** (2026-05-11). Out-of-band sprint inserted between 6 and 7: the "re-evaluate after agent integration" Sprint 6 referenced. Goal was to validate that the verb suite shipped in Sprints 0–6 actually composes correctly under LLM control, surface any remaining structural gaps, and put a repeatable test runner in place for future sprints to lean on.

**Goal:** drive the bot through realistic multi-step scenarios using a real Hermes agent, measure where it fails, and either fix the underlying action or harden the prompt/skill. Tests are parameterized by spec YAML so adding scenarios is cheap.

### Deliverables

- `scripts/agent-test.py` — spec-driven runner: batched rcon prep, pre-prep teleport + cleanup, post-prep verification, hermes subprocess with `--max-turns` + `-Q`, stall-watchdog (kills hermes if its session file stops growing for `stall_seconds`, default 75s), per-stage timing breakdown, JSON report per run.
- `data/agent-tests/` — 13 specs covering perception, atomic failure modes, and composite multi-step scenarios.
- Three bot-level fixes surfaced and shipped during this sprint (see "Bugs surfaced + fixed" below).
- `docs/agent-tests.md` — runner + predicate reference and per-test summary.

### Tests

| Class | Test | Capability | Avg time |
|---|---|---|---|
| Perception | P1 mixed_blocks | name-specific block reporting (oak vs birch vs spruce) | 13s |
| Failure modes | F1 over_literal_names | "wood" → birch_log canonicalization | 25s |
| | F2 phantom_search | give-up cleanly when target doesn't exist | 12s |
| | F3 stuck_in_pit | recover from 3-deep stone pit (`mc pillar_step` / `mc stair_up`) | 48s |
| | F4 tool_tier | wooden vs stone pickaxe on iron_ore | 22s |
| | F5 door_blockade | `mc goto`→NAV_BLOCKED→`mc through` recovery | 20s |
| | F6 axe_break_cascade | planks→sticks→table→wooden_axe→mine chain | 60s |
| Composite | G1 stone_pickaxe | punch wood from nothing → stone_pickaxe (multi-step) | 100-200s |
| | G2 shelter | 5×5 cobblestone perimeter via `mc wall` ×4 | 45s |
| | G3 fence_enclosure | one-call `mc fence ... --gate south` | 32s |
| | G4 chest_withdraw | selective container I/O (peek + withdraw by item type) | 18s |
| | G5 iron_smelt | mine iron_ore + coal_ore → `mc smelt raw_iron coal` | 43s |
| | G6 kill_zombie | iron-equipped bot kills a NoAI zombie via `mc fight` | 20s |

All 13 pass reliably with `google/gemini-2.5-flash` as the default model (≥3/3 PASS each).

### Predicates

The runner accepts a YAML `expect:` block with these predicate types:

- `agent_chat_contains` / `agent_chat_contains_any` / `agent_chat_does_not_contain`
- `bot_at` (with optional `range`) / `bot_y_at_least`
- `bot_inventory` / `bot_inventory_any` / `bot_inventory_excludes`
- `world_block_at` (rcon `if block X Y Z material` + `say MATCH_*` echo via bot chat)
- `world_no_entity_of_type` (rcon `data get entity @e[type=X]` returns "No entity was found" on absence)
- `mc_verbs_include_any` (set-membership over `mc <verb>` calls extracted from terminal tool args)
- `mc_cli_invocations_max` (loop / chattiness cap)

### Bugs surfaced + fixed

1. **rcon coord-flag parsing** (`scripts/agent-test.py`) — the single-command rcon path passed the full command as a docker-exec positional argv, so any `-N` coordinate got interpreted as a docker CLI flag (`unknown shorthand flag: '2' in -2`). Symptom: `world_block_at` probes at negative coordinates silently failed. The batched path already used stdin; switched the single path to match. Without this fix, G2 looked like it failed three of four corners on every run.
2. **Mineflayer 3×3 craft delta=0** (`bot/lib/actions/crafting.js`) — Mineflayer 4.35 + Paper 1.21 has an open bug ([#3399](https://github.com/PrismarineJS/mineflayer/issues/3399) et al.) where table-required `b.craft()` completes the click sequence but the server doesn't materialize the result. Ingredients stay in inventory untouched. Added a PaperMCP server-side fallback: when ingredients are still intact after `b.craft` returns delta=0, consume ingredients via `/clear` and emit the result via `/give`, then verify the delta. Reported as `recipe_used.fallback = papermcp_server_side` in action data. Required adding `clear` to PaperMCP's `command_whitelist`. Without this fix, F6 and G1 can't pass — both depend on a wooden_pickaxe + stone_pickaxe craft.
3. **Pathfinder spin on unreachable targets** (`bot/lib/actions/mining.js`) — `b.pathfinder.goto` has no wall-clock cap, so unreachable items (cramped spots, hole bottoms, behind blocks) caused indefinite spin — the visible "Flint stuck running in place" failure. Extracted a shared `gotoWithTimeout(bot, goal, ms)` helper that races `pathfinder.goto` against a wall-clock deadline, stops the pathfinder + clears control states on timeout, then throws `pathfinder_timeout`. Applied at all 7 pathfind callsites in mining.js (`collect`, `dig`, `pickup`) with 5-10s caps depending on context.

### Other improvements

- **Stall watchdog**: agent-test.py polls the hermes session file mtime every 1s; if it doesn't grow for `stall_seconds` (default 75s, > hermes's own 60s tool timeout so a single slow call doesn't trip it), it terminates hermes. Catches "agent loops on a 60s-timeout tool call" without waiting out the full spec timeout.
- **Per-stage timing breakdown**: stdout + report now show `pre_prep`, `prep`, `settle`, `verify`, `hermes` (with internal `model_think` / `tool_exec` / `other` split via session-file message timeline), `post`, `cleanup`. Confirmed empirically that LLM inference is the dominant cost — framework overhead is ~7s flat per test; the rest scales with agent reasoning.
- **Session-file fallback**: when the timeout/stall path doesn't get the session_id line flushed to stderr, we fall back to identifying the session file by "newest file created during hermes run". Previously regressed `tool_call_count` to 0 on early terminations.

### Model findings (gemini-2.5-flash baseline)

| Model | Suitability for agent-test |
|---|---|
| `google/gemini-2.5-flash` | **default**. Reliable, fast (2-8s per LLM round-trip), good tool-call accuracy |
| `google/gemini-2.5-flash-lite` | Refuses ~50% of tasks claiming "no Minecraft tools available" — avoid as baseline |
| `openai/gpt-4o-mini` | Wanders off to `memory`/`search_files` instead of using the terminal; good for direct-API benchmarks, bad for terminal-tool agents |
| `meta-llama/llama-3.1-8b-instruct` | Comparable to gemini-lite — cheap regression tier |
| `deepseek/deepseek-v4-flash` | Works but 2-3× slower than gemini-2.5-flash |

### Exit gate

- All 13 specs pass at least 3 of 3 attempts on the default model.
- Stall watchdog tested against a known-stuck scenario (mc collect → unreachable target).
- Bot-side timeouts in `pickup` / `collect` / `dig` verified to fail fast without leaving the pathfinder running.
- All sprint commits land on `experiment/hermes-agents`.

### Carry-forward (deferred Phase-1 follow-ups)

These were called out in `experiments/phase-1-summary.md` §"Branch-scope refactors needed" but not addressed in Sprint A. The agent-test suite makes them easier to attempt safely:

- `mc observe_lean` — strip nearby-block lists from the default observe payload; ~90% of token spend in long G-series runs is observe responses.
- Custom metric registration in `bot/lib/goals/engine.js` — accept arbitrary metric names so the steward can drive goal-preset urgency for free-form objectives.
- `/api-spec` route on the bot HTTP server — OpenAPI listing of available actions/queries for skill / prompt generation.
- Per-character `--ignore-rules` invocation for kanban-spawned workers (hermes-side, not hermescraft) — prevent cross-session memory contamination between unrelated missions.

---

## Sprint 7 — Liquid management

**Status:** in progress (started 2026-05-11).

**Goal:** the bot can carry liquids in buckets — fill from water/lava sources, empty into open or replaceable cells. Unlocks Sprint 8 (crop hydration needs water transport) and gives agents the missing tool for the "wall off discovered lava" use case that motivated the deferred `mc seal` verb in Sprint 6.

### Verbs

| Verb | Shape | Notes |
|---|---|---|
| `mc bucket_fill` | `mc bucket_fill X Y Z` | Fill an empty bucket from a water/lava source block at (X,Y,Z). Bot equips its empty bucket, walks within reach if needed, looks at the target, and activates. |
| `mc bucket_empty` | `mc bucket_empty X Y Z` | Place liquid from held water/lava bucket at (X,Y,Z). Bot equips the matching liquid bucket, looks at the destination, activates. |

`mc seal` (deferred from Sprint 6) is **subsumed** by `mc bucket_empty water` over a lava hazard: pour water on top of lava and the contact reaction produces stone/obsidian/cobble per vanilla rules. No new verb needed.

### Action contract

| Error code | When | observed_state | retry_safe |
|---|---|---|---|
| `MISSING_BUCKET` | no empty bucket in inventory (fill) or no matching liquid bucket (empty) | `inventory_buckets: [...]` | false |
| `NOT_A_LIQUID` | target block for fill isn't a water/lava source | `target_block: "stone"` | false |
| `NOT_A_SOURCE` | target is flowing water/lava, not a source block (fill) | `target_block: "water", level: 3` | false |
| `BLOCKED` | target cell for empty isn't replaceable (not air/grass/waterloggable) | `target_block: "stone"` | false |
| `OUT_OF_RANGE` | bot couldn't reach within 4.5 blocks after pathfind | `distance: 7.2` | false |
| `UNCHANGED` | inventory delta is zero post-action (server rejected silently) | `started_bucket, ended_bucket` | true |

### Fixtures (L7)

| ID | Tests |
|---|---|
| L7.1 | `bucket_fill_water` — empty bucket + water source at (3,65,0); result: water_bucket in inv, source block becomes air |
| L7.2 | `bucket_fill_lava` — empty bucket + lava source; result: lava_bucket in inv |
| L7.3 | `bucket_fill_not_source` — flowing water (not source); fill returns NOT_A_SOURCE |
| L7.4 | `bucket_empty_water` — water_bucket + air target; result: water source at target, empty bucket in inv |
| L7.5 | `bucket_empty_blocked` — water_bucket + stone target; fail BLOCKED |
| L7.6 | `seal_lava_via_water` — composite: place water_bucket over a 1×1 lava source; verify cobble/obsidian formation |

### Agent-test scenarios

These go in `data/agent-tests/` (sister to the F/G suite from Sprint A):

| ID | Scenario |
|---|---|
| G7 | `bucket_water_transport` — bot fetches water from a pond at (-5, 65, 0), carries it 10 blocks, places it next to a dirt block (turns to mud or waters a crop). |
| G8 | `seal_lava_pit` — bot finds a small lava cell, has a water_bucket, pours water on it, verifies the lava is gone. Validates the deferred `mc seal` use case. |

### Implementation order

1. `mc bucket_fill` — handler in `world.js`, registry entry, L7.1 fixture.
2. `mc bucket_empty` — handler, registry, L7.4 fixture.
3. NOT_A_SOURCE / BLOCKED error refinements; L7.2, L7.3, L7.5.
4. L7.6 composite (lava + water reaction).
5. G7 + G8 agent-tests.
6. Skill text in `skills/minecraft-survival.md` — point agents at bucket verbs for lava-hazard mitigation and water transport.

### Exit gate

- All L7 fixtures green (2 consecutive passes each).
- G7 + G8 agent-tests reliable (≥3/3 PASS on default model).
- `check-conventions.mjs` passes (both new verbs have `description` + `examples`).
- Skill text updated.

### Estimated scope

1–2 sessions. The mechanics are simple (mineflayer's `b.activateItem()` does the work) — the bulk is the action contract + lookAt sequencing + per-error observability.

---

## Sprint 8 — Crops

**Status:** SHIPPED 2026-05-11. Verbs `mc till`/`plant`/`bonemeal`/`harvest` landed in `bot/lib/actions/farming.js` with PaperMCP fallback for bonemeal (mineflayer's `activateBlock` silent-no-ops on Paper 1.21+ for bone meal). All 8 L8 fixtures smoke-tested green. G10 wheat_farm_cycle PASS ≥3/3 consecutively on `google/gemini-2.5-flash` (runs at `data/agent-tests/runs/G10_wheat_farm_cycle-2026-05-11T11-{35,37,39}*.json`). Skill text updated with light/hydration/maturity-stages/trampling/drop-rules guidance derived from the Minecraft wiki crop-farming tutorial.

**Goal:** the bot can till soil, plant seeds, accelerate growth with bone meal, and harvest mature crops. Unlocks self-sufficient food generation — bots no longer depend on saturation effects for long missions. Combined with Sprint 7's water transport (crops need hydrated farmland within 4 blocks), this is the first sprint where a bot can survive indefinitely on its own.

### Verbs

| Verb | Shape | Notes |
|---|---|---|
| `mc till` | `mc till X Y Z` | Convert a single dirt/grass block at (X,Y,Z) into farmland. Auto-equips a hoe (any tier). Returns NO_HOE / NOT_TILLABLE / OUT_OF_RANGE. |
| `mc plant` | `mc plant ITEM X Y Z` | Place a seed/sapling/crop on the block at (X,Y,Z+1) (the cell above the tilled soil). Validates the item is a plantable, the target soil is farmland/dirt as appropriate. |
| `mc harvest` | `mc harvest X1 Z1 X2 Z2 [Y]` | Dig mature crops in an axis-aligned rectangle. Skips immature crops (returns count of `skipped_immature`). Collects drops via the usual pickup pass. |
| `mc bonemeal` | `mc bonemeal X Y Z` | Apply bone meal to a crop at (X,Y,Z). Equips bone_meal, activates on the block. Returns BONEMEAL_FAILED if the target isn't growable or no bone_meal in inventory. |

### Action contract

| Error code | When | observed_state | retry_safe |
|---|---|---|---|
| `NO_HOE` | no hoe in inventory (till) | `inventory_hoes: []` | false |
| `NOT_TILLABLE` | target block isn't dirt/grass/coarse_dirt (till) | `target_block: "stone"` | false |
| `NO_SEEDS` | requested seed/sapling not in inventory (plant) | `requested: "wheat_seeds", have: ["beetroot_seeds"]` | false |
| `NOT_FARMLAND` | plant target's ground isn't farmland (for wheat/carrot/potato) | `target_soil: "dirt"` | false |
| `NOTHING_TO_HARVEST` | rectangle contains no mature crops | `total_blocks: 9, mature: 0, immature: 7` | false |
| `BONEMEAL_FAILED` | bone meal application didn't trigger growth (already mature, wrong target, no item) | `target_block: "wheat", age: 7` | true |
| `OUT_OF_RANGE` | target too far + pathfind failed | `distance: 7.2` | false |

### Fixtures (L8)

| ID | Tests |
|---|---|
| L8.1 | `till_basic` — grass block + iron_hoe → farmland |
| L8.2 | `till_wrong_block` — stone target → NOT_TILLABLE |
| L8.3 | `plant_wheat` — farmland at Y=64, wheat_seeds in inv → wheat crop at Y+1 |
| L8.4 | `plant_no_seeds` → NO_SEEDS |
| L8.5 | `bonemeal_immature_wheat` — wheat at age=0, bonemeal in inv → age increments |
| L8.6 | `harvest_mature_wheat_3x3` — 3x3 mature wheat field → 9 wheat collected, 0 seeds lost |
| L8.7 | `harvest_mixed_maturity` — 3x3 with mix of mature + immature → only mature counted; immature listed in observed |
| L8.8 | `full_cycle_3x3` — till → plant → bonemeal until mature → harvest. End: bot has wheat in inv, farmland clear of crops |

### Agent-test scenarios

| ID | Scenario |
|---|---|
| G10 | `wheat_farm_cycle` — bot has hoe + wheat_seeds + bone_meal. Goal: till a 3x3 patch, plant, bonemeal to maturity, harvest. Composite multi-verb chain. |

### Implementation order

1. `mc till` (single-block) — simplest, sets the pattern.
2. `mc plant` — adds seed/soil validation logic.
3. `mc bonemeal` — same activate-block pattern, plus growth verification.
4. `mc harvest` (rectangle) — area scan + dig-mature loop, reuses pickup.
5. L8.1-L8.8 fixtures.
6. G10 agent-test.
7. Skill text update in `skills/minecraft-survival.md` — point at the farm verbs for food generation.

### Exit gate

- All L8 fixtures green (2 consecutive passes each).
- G10 reliable (≥3/3 PASS on default model).
- `check-conventions.mjs` passes (4 new verbs each have description + examples).
- Skill text updated.

### Estimated scope

1-2 sessions. Mineflayer plumbing is the bucket pattern repeated (activateBlock with hoe / bone_meal / seed-on-farmland). Expect the same Paper 1.21+ silent-no-op gotcha → PaperMCP server-side fallback for actions that mineflayer can't complete.

---

## Sprint 9 — Animals

**Status:** SHIPPED 2026-05-11. 5 verbs (`mc breed`/`shear`/`milk_cow`/`hunt`/`lure`) landed in `bot/lib/actions/animals.js`. All 10 L9 fixtures green; 6 agent-tests (G11-G16) reliably PASS on `gemini-2.5-flash`. Skill text gained a "Husbandry" section covering breeding food, cooldown, hydration, drop rules, containment via gates, and the gate-safety pattern.

**Goal:** the bot can breed, shear, milk, hunt, and lure passive farm animals. Combined with Sprint 8 crops, this completes the loop: wheat→cows/sheep, wheat_seeds→chickens, carrot/potato/beetroot→pigs. Bots can now self-sufficiently maintain a renewable food + materials supply (eggs, milk, wool, leather, feathers).

### Verbs

| Verb | Shape | Notes |
|---|---|---|
| `mc breed SPECIES` | `mc breed chicken` | Feed 2 adult animals to start breeding. Auto-picks breeding item: wheat_seeds for chicken, wheat for cow/sheep, carrot/potato/beetroot for pig. Returns NO_FOOD, NO_PAIR, ANIMAL_ON_COOLDOWN. |
| `mc shear` | `mc shear` | Shear nearest unsheared sheep within 8 blocks. Chase loop retries up to 4× as sheep wander. Returns NO_SHEARS, NO_SHEEP, SHEEP_ALREADY_SHEARED. |
| `mc milk_cow` | `mc milk_cow` | Fill empty bucket from nearest cow. Chase loop, PaperMCP fallback if native useOn fails. Returns NO_BUCKET, NO_COW. |
| `mc hunt SPECIES [COUNT]` | `mc hunt chicken 3` | Kill N animals; auto-equip weapon, chase + attack loop, multi-pass pickup at each kill site to ensure feathers + meat are collected. |
| `mc lure SPECIES X Y Z` | `mc lure chicken 0 65 0` | Walk to coord holding breeding item; vanilla AI makes animals follow within ~10 blocks. Reports follower distance. |

### Action contract additions (shared)

`mc through` (Sprint 5 verb, used heavily in Sprint 9 for pen entry/exit) gained an `ANIMAL_AT_GATE` error that fires when a passive mob is within 1.5 blocks of the gate. Opening would let it escape. Agent should wait for the animal to wander, then retry. The traversal timeout was also tightened from 6s → 2.5s to minimize the open-gate window.

### Chase loop

`walkToEntity` in animals.js loops: re-resolve target → pathfind to GoalNear(pos, 2) → re-check distance → repeat until reach or 12s timeout. The radius=2 GoalNear is deliberately loose so the bot doesn't crowd the animal into walls (vanilla collision physics can clip passives through fences when pushed repeatedly).

### Fixtures (L9, 10 total)

L9.1 breed_chicken_pair_success · L9.2 breed_no_food · L9.3 breed_no_pair · L9.4 shear_basic · L9.5 shear_already_sheared · L9.6 milk_cow_basic · L9.7 milk_no_bucket · L9.8 hunt_chickens_x3 · L9.9 lure_chicken_follows · L9.10 lure_no_food

### Agent-tests (G11-G16, 6 total)

| ID | Scenario |
|---|---|
| G11 | `chicken_breed` — bot OUTSIDE fenced pen breeds 2 chickens through the fence. |
| G12 | `sheep_harvest_3x` — bot OUTSIDE pen shears 3 sheep through fence. ≥2 wool. |
| G13 | `cow_milk` — bot OUTSIDE pen milks 1 cow through fence. |
| G14 | `hunt_loose_chickens` — bot kills 3 wandering chickens, collects ≥2 feathers. |
| G15 | `chicken_containment` — escaped chicken outside a gated pen; agent ends with no loose chicken (typically via hunt). |
| G16 | `pen_harvest_cycle` — bot enters 7x7 pen via fence_gate (`mc through`), shears 2 sheep, exits via same gate. Sheep stay contained. |

### Exit gate met

- All 10 L9 fixtures green (smoke-tested each).
- G11-G14: 1/1 each (single-verb tests).
- G15: 3/3 PASS.
- G16: 4/4 PASS (after gate-safety pre-check + traversal speedup).
- check-conventions.mjs passes.
- Skill text updated.

---

## Sprint 10 (stub — to be planned)

| Sprint | Domain | Depends on | Status |
|---|---|---|---|
| 10 | Fishing + boats (`mc farm fish`, `mc self board/disembark`) | independent | planned |

Each becomes its own section here when the prior sprint exits.

