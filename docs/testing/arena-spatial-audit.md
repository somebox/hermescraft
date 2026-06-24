# Arena spatial audit — functional pytest modules

Inventory for the lean landfolk-test arena: where each module anchors geometry,
which bbox tier it expects, and which specialty pad it should stay on. The harness
still owns the full **±32** substrate; new work should fit the **observation zone**
`ARENA_MEDIUM` (±16 X/Z) so a fly spectator at **`(0, 72, 0)`** sees the whole case.

Constants live in `tests/_lib/functional_fixtures.py`:

| Constant | Meaning |
|----------|---------|
| `ARENA_SMALL` | ±8 footprint (y=64 floor .. y=80 air) |
| `ARENA_MEDIUM` | ±16 footprint (y=60 .. y=80) — **observation default** |
| `ARENA_LARGE` | ±30 footprint |
| `PAD_ORIGIN` | Door / LOS / through smokes at spawn |
| `PAD_EAST` | Mining stairs, strip pits, east-of-divider digs |
| `PAD_SOUTH` | South-offset scenarios (reserved) |
| `PAD_WEST` | Lab-side work; `PREFAB_BAKE_PAD` (x=−12..−4) for session prefabs |
| `MINING_CENTER` | `(4, 65, 0)` — east mining cube anchor |
| `LAB_CENTER` | `(−16, 65, 0)` — west lab anchor |

**Observer default:** `(0, 72, 0)` spectator slow-fall (same as legacy YAML tp-from-height pattern).

**Coord gate:** `python3 scripts/check-arena-coords.py --observation-bbox --strict` enforces ±16 X/Z; omit the flag for full ±32 arena bounds.

## Module inventory

| File | Anchor | Bbox tier | Spatial need | Specialty pad | Observer |
|------|--------|-----------|--------------|---------------|----------|
| `test_door_pathfind.py` | `(0, 65, 0)` | medium | `door_sealed_box` | Origin | `(0, 72, 0)` |
| `test_door_simple.py` | `(0, 65, 0)` | small | `door_open_pass` | Origin | `(0, 72, 0)` |
| `test_through_los.py` | `(0, 65, 0)` | small | `stance_and_act_gate` | Origin | `(0, 72, 0)` |
| `test_through_fresh_door.py` | `(0, 65, 0)` | small | `door_through` | Origin | `(0, 72, 0)` |
| `test_through_elevated_door.py` | `(0, 65, 0)` | small | `door_step_up` | Origin | `(0, 72, 0)` |
| `test_through_recovery.py` | `(0, 65, 0)` | small | `door_error_path` | Origin | `(0, 72, 0)` |
| `test_interact_los.py` | `(0, 65, 0)` | small | `los_wall_interact` | Origin | `(0, 72, 0)` |
| `test_chest_los.py` | `(0, 65, 0)` | small | `los_wall_container` | Origin | `(0, 72, 0)` |
| `test_place_los.py` | `(0, 65, 0)` | small | `los_wall_place` | Origin | `(0, 72, 0)` |
| `test_attack_through_wall.py` | `(0, 65, 0)` | small | `los_wall_combat` | Origin | `(0, 72, 0)` |
| `test_goto_near_los.py` | `(0, 65, 0)` | small | `los_landing` | Origin | `(0, 72, 0)` |
| `test_goto_near_reachability.py` | `(0, 65, 0)` | medium | `path_hint_envelope` | Origin | `(0, 72, 0)` |
| `test_goto_near_landing.py` | `(0, 65, 0)` | small | `landing_class` | Origin | `(0, 72, 0)` |
| `test_corner_cut_prevention.py` | `(0, 65, 0)` | small | `nav_diagonal_guard` | Origin | `(0, 72, 0)` |
| `test_nav_reachable.py` | `(0, 65, 0)` | medium | `reachability_matrix` | Origin | `(0, 72, 0)` |
| `test_stall_reachability.py` | `(0, 65, 0)` | small | `path_failure_hint` | Origin | `(0, 72, 0)` |
| `test_movement_precondition.py` | `(0, 65, 0)` | small | `position_taint` | Origin | `(0, 72, 0)` |
| `test_movement_errors_enriched.py` | `(0, 65, 0)` | small | `error_envelope` | Origin | `(0, 72, 0)` |
| `test_action_reach_pathing.py` | `(0, 65, 0)` | small | `auto_path_reach` | Origin | `(0, 72, 0)` |
| `test_action_timeouts.py` | `(0, 65, 0)` | small | `timeout_envelope` | Origin | `(0, 72, 0)` |
| `test_task_semantics.py` | `(0, 65, 0)` | small | `harness_idle` | Origin | `(0, 72, 0)` |
| `test_wait_chat_interrupt.py` | `(0, 65, 0)` | small | `chat_wait` | Origin | `(0, 72, 0)` |
| `test_whisper_as_mention.py` | `(0, 65, 0)` | small | `chat_routing` | Origin | `(0, 72, 0)` |
| `test_flee_no_threat.py` | `(0, 65, 0)` | medium | `reactive_no_mob` | Origin | `(0, 72, 0)` |
| `test_escape_multidir.py` | `(0, 65, 0)` | small | `trap_escape` | Origin | `(0, 72, 0)` |
| `test_recovery_protocols.py` | `(0, 65, 0)` | small | `brain_recovery` | Origin | `(0, 72, 0)` |
| `test_stuck_recenter.py` | `(0, 65, 0)` | small | `stuck_watchdog` | Origin | `(0, 72, 0)` |
| `test_stuck_loop_prevention.py` | `(0, 65, 0)` | medium | `stuck_loop` | Origin | `(0, 72, 0)` |
| `test_pickup_blocked.py` | `(0, 65, 0)` | small | `pickup_stall` | Origin | `(0, 72, 0)` |
| `test_fill_self_displace.py` | `(0, 65, 0)` | small | `fill_displace` | Origin | `(0, 72, 0)` |
| `test_place_fresh_craft.py` | `(0, 65, 0)` | small | `place_autocraft` | Origin | `(0, 72, 0)` |
| `test_region_predicates.py` | `(0, 65, 0)` | small | `region_predicate` | Origin | `(0, 72, 0)` |
| `test_is_sheltered_wall_check.py` | `(0, 65, 0)` | small | `shelter_predicate` | Origin | `(0, 72, 0)` |
| `test_ladder_climb.py` | `(0, 65, 0)` | small | `ladder_column` | Origin | `(0, 72, 0)` |
| `test_move_underground_door.py` | `(0, 65, 0)` | medium | `underground_door_nav` | Origin | `(0, 72, 0)` |
| `test_drown_protection.py` | `(0, 65, 0)` | medium | `water_drown_reactive` | Origin | `(0, 72, 0)` |
| `test_water_navigation.py` | `(0, 65, 0)` | medium | `sail_candidate` | Origin | `(0, 72, 0)` |
| `test_pillar_state_invariants.py` | `(0, 64, 0)` | small | `cavity_pillar` | Origin | `(0, 72, 0)` |
| `test_pillar_thick_ceiling.py` | `(0, 64, 0)` | small | `cavity_thick_ceiling` | Origin | `(0, 72, 0)` |
| `test_shelter_egress.py` | genesis offset | medium | `shelter_egress` | Origin | `(0, 72, 0)` |
| `mining/test_dig_los.py` | `(0, 65, 0)` | small | `dig_los_refusal` | Origin | `(0, 72, 0)` |
| `mining/test_mine_behind_wall.py` | `(0, 65, 0)` | small | `collect_los_fairplay` | Origin | `(0, 72, 0)` |
| `mining/test_mine_collect_grid.py` | `(2, 65, 2)` | small | `prefab_grid_collect` | Origin | `(0, 72, 0)` |
| `mining/test_dig_walk_pickup_chain.py` | `(0, 65, 0)` | medium | `dig_walk_chain` | East | `(0, 72, 0)` |
| `mining/test_dig_door_support.py` | `(0, 65, 0)` | small | `dig_support_refusal` | Origin | `(0, 72, 0)` |
| `mining/test_tool_switching.py` | `(0, 65, 0)` | small | `tool_auto_switch` | Origin | `(0, 72, 0)` |
| `mining/test_collect_ore_drop_name.py` | `(0, 65, 0)` | small | `collect_drop_name` | Origin | `(0, 72, 0)` |
| `mining/test_mine_ergonomics.py` | `MINING_CENTER` | medium | `stair_registry` | East | `(0, 72, 0)` |
| `mining/test_strip_flatten.py` | `(8, 65, 8)` | medium | `strip_pit_16` | East | `(0, 72, 0)` |
| `mining/test_breach_danger.py` | `(0, 65, 0)` | medium | `hazard_record` | East | `(0, 72, 0)` |
| `mining/test_collect_underwater.py` | `(0, 65, 0)` | **large** | `underwater_guard` | East | `(0, 72, 0)` |
| `mining/water/test_collect_near_water.py` | `(0, 65, 0)` | medium | `water_adjacent_collect` | East | `(0, 72, 0)` |
| `mining/stairs/test_stair_straight.py` | `(0, 65, 0)` | medium | `stair_down_up` | East | `(0, 72, 0)` |
| `mining/stairs/test_stair_with_turn.py` | `MINING_CENTER` | medium | `stair_turn` | East | `(0, 72, 0)` |
| `mining/stairs/test_long_stair_tunnel_egress.py` | `MINING_CENTER` | medium | `stair_tunnel_egress` | East | `(0, 72, 0)` |
| `mining/stairs/test_deep_tunnel_egress.py` | `MINING_CENTER` | medium | `deep_tunnel_egress` | East | `(0, 72, 0)` |
| `farming/test_till_plant_underfoot.py` | `(0, 65, 0)` | small | `farm_underfoot` | Origin | `(0, 72, 0)` |
| `farming/test_farm_status.py` | `(0, 65, 0)` | small | `farm_status_grid` | Origin | `(0, 72, 0)` |
| `terrain/test_terrain_shaping.py` | `(0, 65, 0)` | medium | `terrain_shaping` | East | `(0, 72, 0)` |
| `terrain/test_execution_kernel_bulk.py` | `(0, 65, 0)` | **large** / sky | `kernel_bulk` | East | `(0, 72, 0)` |
| `building/test_construct_scoped.py` | `(0, 65, 0)` | medium | `construct_context` | Origin | `(0, 72, 0)` |
| `combat/scenarios.py` | `(0, 65, 0)` | medium | `combat_arena_spec` | Origin | `(0, 72, 0)` |
| `combat/test_reactive_combat.py` | `(0, 65, 0)` | medium | `reactive_combat` | Origin | `(0, 72, 0)` |
| `combat/test_reactive_flee.py` | `(0, 65, 0)` | medium | `reactive_flee` | Origin | `(0, 72, 0)` |

## Known observation-zone outliers

These modules still emit rcon coords outside ±16 (acceptable until migrated; full arena ±32 remains valid):

- `mining/test_collect_underwater.py` — fill extent z=20
- `terrain/test_execution_kernel_bulk.py` — sky/bulk workspace tp to ~(27, 79, 28)
- Additional offenders: run `python3 scripts/check-arena-coords.py --observation-bbox` (19 lines as of Track I)

## Prefab vault migration (Track I)

Session bake moved from **x=40..56** to **`PREFAB_BAKE_PAD`** on the west pad (**x=−12..−4**). Tests copy prefabs with `arena.load_prefab(name, dest)` at in-case coords (e.g. `mining_grid_3x3` → `(2, 65, 2)`); only the vault slab moved.
