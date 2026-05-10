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
- `skills/minecraft-building.md` skill text update — pending Sprint 6+ when we wire skills to mc verbs systematically.
- Cleanup of `protectedBlocks` and legacy block-tagging workarounds — deferred to building-and-integration phase since `canDig=false` makes them defense-in-depth, not the primary safeguard.

---

## Sprints 6–10 (stubs — to be planned at the end of each predecessor)

| Sprint | Domain | Depends on | Status |
|---|---|---|---|
| 6 | Safe mining (tool-tier validation, sand/gravel safety) | independent | planned |
| 7 | Liquid management (`mc self bucket fill/empty`) | 6 (iron) | planned |
| 8 | Crops (`mc farm till/plant/harvest`) | 5, 7 | planned |
| 9 | Animals (`mc farm lure/breed/shear/milk`) | 5, 8 | planned |
| 10 | Fishing + boats (`mc farm fish`, `mc self board/disembark`) | independent | planned |

Each becomes its own section here when the prior sprint exits. Sprint 6 can start in parallel with Sprint 5 — they're independent.

