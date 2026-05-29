# Build guide: dystopian-hut-3

## Summary

- **Plan file:** `data/ops/plans/dystopian-hut-3-plan.json`
- **Source:** grabcraft — Dystopian Village Hut 3
- **World anchor:** `320, 65, -590`
- **Footprint (local):** x=[1, 4] y=[1, 10] z=[1, 6]
- **Cells:** 169 across **10** layer(s)

## Placemark sign

Use placemark **`:hut1:`** on line 1 of the in-world sign (region id `hut1`).
Break/replace the sign to change text; then `mc regions_rescan_signs` with a bot in chunk.

Example:

```text
:hut1:
region=hut1
r=16
intent=marker
```

Navigation: `mc goto :hut1:` · site ref in plan: `:hut1:/anchor`

## Worksite (protect regions)

Before dig/place inside a protect region: `mc task_context set hut1`
Clear on card complete: `mc task_context clear`

## Materials

| Item | Count | Suggested gather |
|------|------:|------------------|
| `cobblestone` | 79 | `mc collect cobblestone 87` |
| `dirt` | 53 | `mc collect dirt 59` |
| `stone_slab` | 13 | `mc collect stone_slab 15` |
| `ladder_facing_north` | 5 | `mc collect ladder_facing_north 6` |
| `glass_pane` | 5 | `mc collect glass_pane 6` |
| `torch_facing_east` | 2 | `mc collect torch_facing_east 3` |
| `cobblestone_stairs_south_normal` | 1 | `mc collect cobblestone_stairs_south_normal 2` |
| `wall_mounted_sign_block_west_northwest` | 1 | `mc collect wall_mounted_sign_block_west_northwest 2` |
| `oak_door_facing_south_closed_lower` | 1 | `mc collect oak_door_facing_south_closed_lower 2` |
| `oak_fence` | 1 | `mc collect oak_fence 2` |
| `oak_wood_stairs_north_normal` | 1 | `mc collect oak_wood_stairs_north_normal 2` |
| `wooden_pressure_plate_unactive` | 1 | `mc collect wooden_pressure_plate_unactive 2` |
| `oak_door_hinge_right_unpowered_upper` | 1 | `mc collect oak_door_hinge_right_unpowered_upper 2` |
| `bed_north_empty_head_of_the_bed` | 1 | `mc collect bed_north_empty_head_of_the_bed 2` |
| `bed_north_empty_foot_of_the_bed` | 1 | `mc collect bed_north_empty_foot_of_the_bed 2` |
| `furnace_facing_east` | 1 | `mc collect furnace_facing_east 2` |
| `chest_south` | 1 | `mc collect chest_south 2` |
| `torch_facing_west` | 1 | `mc collect torch_facing_west 2` |

## Site prep (foundation)

Run terrain checks before building (bot must be on site):

1. `mc terrain_top 319 -591` — corner 1 surface Y
2. `mc terrain_top 324 -591` — corner 2 surface Y
3. `mc terrain_top 319 -584` — corner 3 surface Y
4. `mc terrain_top 324 -584` — corner 4 surface Y

If corner surface Y spread **> 2 blocks**, flatten the pad:
`mc level 319 -591 324 -584 64`

Prep footprint XZ (includes 1-block margin): **319..324**, **-591..-584** at build anchor Y band.

If the site is below grade, dig or strip-mine before leveling; if above, level/fill is usually enough (see `minecraft-building` log-cabin prep).

## Build phases (local Y)

### Layer Y = 1 (21 cells)

**Materials this layer:** `cobblestone`×20, `cobblestone_stairs_south_normal`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill cobblestone 320 65 -589 323 65 -585` <!-- local y=1 vol=20 -->
- `mc fill cobblestone_stairs_south_normal 322 65 -590 322 65 -590` <!-- local y=1 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 1`

### Layer Y = 2 (18 cells)

**Materials this layer:** `dirt`×9, `cobblestone`×4, `ladder_facing_north`×1, `wall_mounted_sign_block_west_northwest`×1, `oak_door_facing_south_closed_lower`×1, `oak_fence`×1, `oak_wood_stairs_north_normal`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill cobblestone 323 66 -585 323 66 -585` <!-- local y=2 vol=1 -->
- `mc fill cobblestone 320 66 -585 320 66 -585` <!-- local y=2 vol=1 -->
- `mc fill cobblestone 320 66 -589 320 66 -589` <!-- local y=2 vol=1 -->
- `mc fill cobblestone 323 66 -589 323 66 -589` <!-- local y=2 vol=1 -->
- `mc fill dirt 323 66 -588 323 66 -586` <!-- local y=2 vol=3 -->
- `mc fill dirt 320 66 -588 320 66 -586` <!-- local y=2 vol=3 -->
- `mc fill dirt 321 66 -585 322 66 -585` <!-- local y=2 vol=2 -->
- `mc fill dirt 321 66 -589 321 66 -589` <!-- local y=2 vol=1 -->
- `mc fill ladder_facing_north 322 66 -586 322 66 -586` <!-- local y=2 vol=1 -->
- `mc fill oak_door_facing_south_closed_lower 322 66 -589 322 66 -589` <!-- local y=2 vol=1 -->
- `mc fill oak_fence 321 66 -586 321 66 -586` <!-- local y=2 vol=1 -->
- `mc fill oak_wood_stairs_north_normal 321 66 -587 321 66 -587` <!-- local y=2 vol=1 -->
- `mc fill wall_mounted_sign_block_west_northwest 322 66 -587 322 66 -587` <!-- local y=2 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 2`

### Layer Y = 3 (16 cells)

**Materials this layer:** `dirt`×8, `cobblestone`×4, `wooden_pressure_plate_unactive`×1, `oak_door_hinge_right_unpowered_upper`×1, `ladder_facing_north`×1, `glass_pane`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill cobblestone 320 67 -585 320 67 -585` <!-- local y=3 vol=1 -->
- `mc fill cobblestone 320 67 -589 320 67 -589` <!-- local y=3 vol=1 -->
- `mc fill cobblestone 323 67 -585 323 67 -585` <!-- local y=3 vol=1 -->
- `mc fill cobblestone 323 67 -589 323 67 -589` <!-- local y=3 vol=1 -->
- `mc fill dirt 320 67 -588 320 67 -586` <!-- local y=3 vol=3 -->
- `mc fill dirt 321 67 -585 322 67 -585` <!-- local y=3 vol=2 -->
- `mc fill dirt 321 67 -589 321 67 -589` <!-- local y=3 vol=1 -->
- `mc fill dirt 323 67 -588 323 67 -588` <!-- local y=3 vol=1 -->
- `mc fill dirt 323 67 -586 323 67 -586` <!-- local y=3 vol=1 -->
- `mc fill glass_pane 323 67 -587 323 67 -587` <!-- local y=3 vol=1 -->
- `mc fill ladder_facing_north 322 67 -586 322 67 -586` <!-- local y=3 vol=1 -->
- `mc fill oak_door_hinge_right_unpowered_upper 322 67 -589 322 67 -589` <!-- local y=3 vol=1 -->
- `mc fill wooden_pressure_plate_unactive 321 67 -586 321 67 -586` <!-- local y=3 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 3`

### Layer Y = 4 (16 cells)

**Materials this layer:** `dirt`×10, `cobblestone`×4, `torch_facing_east`×1, `ladder_facing_north`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill cobblestone 320 68 -585 320 68 -585` <!-- local y=4 vol=1 -->
- `mc fill cobblestone 320 68 -589 320 68 -589` <!-- local y=4 vol=1 -->
- `mc fill cobblestone 323 68 -585 323 68 -585` <!-- local y=4 vol=1 -->
- `mc fill cobblestone 323 68 -589 323 68 -589` <!-- local y=4 vol=1 -->
- `mc fill dirt 323 68 -588 323 68 -586` <!-- local y=4 vol=3 -->
- `mc fill dirt 320 68 -588 320 68 -586` <!-- local y=4 vol=3 -->
- `mc fill dirt 321 68 -585 322 68 -585` <!-- local y=4 vol=2 -->
- `mc fill dirt 321 68 -589 322 68 -589` <!-- local y=4 vol=2 -->
- `mc fill ladder_facing_north 322 68 -586 322 68 -586` <!-- local y=4 vol=1 -->
- `mc fill torch_facing_east 321 68 -587 321 68 -587` <!-- local y=4 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 4`

### Layer Y = 5 (20 cells)

**Materials this layer:** `cobblestone`×19, `ladder_facing_north`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill cobblestone 320 69 -589 323 69 -587` <!-- local y=5 vol=12 -->
- `mc fill cobblestone 320 69 -585 323 69 -585` <!-- local y=5 vol=4 -->
- `mc fill cobblestone 320 69 -586 321 69 -586` <!-- local y=5 vol=2 -->
- `mc fill cobblestone 323 69 -586 323 69 -586` <!-- local y=5 vol=1 -->
- `mc fill ladder_facing_north 322 69 -586 322 69 -586` <!-- local y=5 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 5`

### Layer Y = 6 (19 cells)

**Materials this layer:** `dirt`×10, `cobblestone`×4, `bed_north_empty_head_of_the_bed`×1, `bed_north_empty_foot_of_the_bed`×1, `furnace_facing_east`×1, `ladder_facing_north`×1, `chest_south`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill bed_north_empty_foot_of_the_bed 321 70 -587 321 70 -587` <!-- local y=6 vol=1 -->
- `mc fill bed_north_empty_head_of_the_bed 321 70 -588 321 70 -588` <!-- local y=6 vol=1 -->
- `mc fill chest_south 322 70 -588 322 70 -588` <!-- local y=6 vol=1 -->
- `mc fill cobblestone 323 70 -585 323 70 -585` <!-- local y=6 vol=1 -->
- `mc fill cobblestone 320 70 -585 320 70 -585` <!-- local y=6 vol=1 -->
- `mc fill cobblestone 320 70 -589 320 70 -589` <!-- local y=6 vol=1 -->
- `mc fill cobblestone 323 70 -589 323 70 -589` <!-- local y=6 vol=1 -->
- `mc fill dirt 323 70 -588 323 70 -586` <!-- local y=6 vol=3 -->
- `mc fill dirt 320 70 -588 320 70 -586` <!-- local y=6 vol=3 -->
- `mc fill dirt 321 70 -585 322 70 -585` <!-- local y=6 vol=2 -->
- `mc fill dirt 321 70 -589 322 70 -589` <!-- local y=6 vol=2 -->
- `mc fill furnace_facing_east 321 70 -586 321 70 -586` <!-- local y=6 vol=1 -->
- `mc fill ladder_facing_north 322 70 -586 322 70 -586` <!-- local y=6 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 6`

### Layer Y = 7 (14 cells)

**Materials this layer:** `dirt`×6, `glass_pane`×4, `cobblestone`×4

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill cobblestone 320 71 -585 320 71 -585` <!-- local y=7 vol=1 -->
- `mc fill cobblestone 320 71 -589 320 71 -589` <!-- local y=7 vol=1 -->
- `mc fill cobblestone 323 71 -585 323 71 -585` <!-- local y=7 vol=1 -->
- `mc fill cobblestone 323 71 -589 323 71 -589` <!-- local y=7 vol=1 -->
- `mc fill dirt 321 71 -585 322 71 -585` <!-- local y=7 vol=2 -->
- `mc fill dirt 323 71 -588 323 71 -588` <!-- local y=7 vol=1 -->
- `mc fill dirt 320 71 -586 320 71 -586` <!-- local y=7 vol=1 -->
- `mc fill dirt 323 71 -586 323 71 -586` <!-- local y=7 vol=1 -->
- `mc fill dirt 320 71 -588 320 71 -588` <!-- local y=7 vol=1 -->
- `mc fill glass_pane 321 71 -589 322 71 -589` <!-- local y=7 vol=2 -->
- `mc fill glass_pane 323 71 -587 323 71 -587` <!-- local y=7 vol=1 -->
- `mc fill glass_pane 320 71 -587 320 71 -587` <!-- local y=7 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 7`

### Layer Y = 8 (16 cells)

**Materials this layer:** `dirt`×10, `cobblestone`×4, `torch_facing_west`×1, `torch_facing_east`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill cobblestone 320 72 -585 320 72 -585` <!-- local y=8 vol=1 -->
- `mc fill cobblestone 320 72 -589 320 72 -589` <!-- local y=8 vol=1 -->
- `mc fill cobblestone 323 72 -585 323 72 -585` <!-- local y=8 vol=1 -->
- `mc fill cobblestone 323 72 -589 323 72 -589` <!-- local y=8 vol=1 -->
- `mc fill dirt 323 72 -588 323 72 -586` <!-- local y=8 vol=3 -->
- `mc fill dirt 320 72 -588 320 72 -586` <!-- local y=8 vol=3 -->
- `mc fill dirt 321 72 -589 322 72 -589` <!-- local y=8 vol=2 -->
- `mc fill dirt 321 72 -585 322 72 -585` <!-- local y=8 vol=2 -->
- `mc fill torch_facing_east 321 72 -587 321 72 -587` <!-- local y=8 vol=1 -->
- `mc fill torch_facing_west 322 72 -587 322 72 -587` <!-- local y=8 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 8`

### Layer Y = 9 (20 cells)

**Materials this layer:** `cobblestone`×16, `stone_slab`×4

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill cobblestone 320 73 -588 323 73 -586` <!-- local y=9 vol=12 -->
- `mc fill cobblestone 321 73 -589 322 73 -589` <!-- local y=9 vol=2 -->
- `mc fill cobblestone 321 73 -585 322 73 -585` <!-- local y=9 vol=2 -->
- `mc fill stone_slab 323 73 -585 323 73 -585` <!-- local y=9 vol=1 -->
- `mc fill stone_slab 320 73 -585 320 73 -585` <!-- local y=9 vol=1 -->
- `mc fill stone_slab 320 73 -589 320 73 -589` <!-- local y=9 vol=1 -->
- `mc fill stone_slab 323 73 -589 323 73 -589` <!-- local y=9 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 9`

### Layer Y = 10 (9 cells)

**Materials this layer:** `stone_slab`×9

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill stone_slab 323 74 -588 323 74 -586` <!-- local y=10 vol=3 -->
- `mc fill stone_slab 320 74 -588 320 74 -586` <!-- local y=10 vol=3 -->
- `mc fill stone_slab 321 74 -589 322 74 -589` <!-- local y=10 vol=2 -->
- `mc fill stone_slab 322 74 -585 322 74 -585` <!-- local y=10 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 10`

## Final verify

`mc blueprint verify :hut1:`

Large footprints truncate at `BLUEPRINT_VERIFY_MAX_CELLS_PER_CALL` (default 2000); rerun with `--level` or `--range Y1..Y2` per layer above.

## Notes

- `mc construct` / blueprint `mc repair` are **not** implemented; use fill/place/dig + verify.
- Fill boxes are greedy, not optimal; odd shapes need more `mc place`.
- Doors/beds/ladders may need manual facing; verify uses block-id compare v1.
- Regenerate this file after plan edits: `python3 scripts/blueprint-tool.py guide dystopian-hut-3 --anchor 320,65,-590`
