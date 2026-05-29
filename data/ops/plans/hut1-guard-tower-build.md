# Build guide: hut1-guard-tower

## Summary

- **Plan file:** `data/ops/plans/hut1-guard-tower-plan.json`
- **Source:** grabcraft — Medieval Colonial Guard Tower
- **World anchor (min corner):** `310, 65, -600`
- **Foundation / layer 1 world Y:** **65** (must match placemark sign Y)
- **Footprint (local):** x=[1, 21] y=[1, 29] z=[1, 21]
- **Cells:** 1306 across **29** layer(s)

- **Placemark center:** `320, 65, -590`

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
| `oak_planks` | 331 | `mc collect oak_planks 331` |
| `stone_bricks` | 305 | `mc collect stone_bricks 305` |
| `oak_log` | 112 | `mc collect oak_log 112` |
| `stone_brick_slab` | 98 | `mc collect stone_brick_slab 98` |
| `oak_fence` | 89 | `mc collect oak_fence 89` |
| `stone_brick_stairs_west` | 42 | `mc collect stone_brick_stairs_west 42` |
| `stone_brick_stairs_south` | 40 | `mc collect stone_brick_stairs_south 40` |
| `stone_brick_stairs_east` | 39 | `mc collect stone_brick_stairs_east 39` |
| `stone_brick_stairs_north` | 39 | `mc collect stone_brick_stairs_north 39` |
| `oak_wood_stairs_north` | 36 | `mc collect oak_wood_stairs_north 36` |
| `oak_wood_stairs_south` | 36 | `mc collect oak_wood_stairs_south 36` |
| `oak_wood_stairs_east` | 36 | `mc collect oak_wood_stairs_east 36` |
| `oak_wood_stairs_west` | 36 | `mc collect oak_wood_stairs_west 36` |
| `glass` | 24 | `mc collect glass 24` |
| `torch` | 20 | `mc collect torch 20` |
| `blue_wool` | 15 | `mc collect blue_wool 15` |
| `oak_door` | 4 | `mc collect oak_door 4` |

## Site prep (foundation)

Run terrain checks before building (bot must be on site):

**Foundation plane:** layer 1 builds at world **Y=65**. Placemark sign Y should match (e.g. `:hut1:` at **Y=65**).

1. `mc terrain_top 309 -601` — corner 1 surface Y
2. `mc terrain_top 331 -601` — corner 2 surface Y
3. `mc terrain_top 309 -579` — corner 3 surface Y
4. `mc terrain_top 331 -579` — corner 4 surface Y

If corner surface Y spread **> 2 blocks**, flatten the pad to the foundation plane:
`mc level 309 -601 331 -579 65`

(Levels columns **at** Y=65 — same as layer 1 / placemark; digs blocks above, fills air at Y.)

Prep footprint XZ (includes 1-block margin): **309..331**, **-601..-579**.

If the site is below grade, dig or strip-mine before leveling; if above, level/fill is usually enough (see `minecraft-building` log-cabin prep).

## Build phases (local Y)

### Layer Y = 1 (241 cells)

**Materials this layer:** `oak_planks`×97, `stone_brick_slab`×70, `oak_log`×52, `stone_bricks`×14, `stone_brick_stairs_east`×2, `stone_brick_stairs_north_normal`×2, `stone_brick_stairs_south_normal`×2, `stone_brick_stairs_west`×2

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill oak_log 312 65 -588 316 65 -588` <!-- local y=1 vol=5 -->
- `mc fill oak_log 312 65 -592 316 65 -592` <!-- local y=1 vol=5 -->
- `mc fill oak_log 324 65 -588 328 65 -588` <!-- local y=1 vol=5 -->
- `mc fill oak_log 318 65 -586 318 65 -582` <!-- local y=1 vol=5 -->
- `mc fill oak_log 322 65 -598 322 65 -594` <!-- local y=1 vol=5 -->
- `mc fill oak_log 324 65 -592 328 65 -592` <!-- local y=1 vol=5 -->
- `mc fill oak_log 322 65 -586 322 65 -582` <!-- local y=1 vol=5 -->
- `mc fill oak_log 318 65 -597 318 65 -594` <!-- local y=1 vol=4 -->
- `mc fill oak_log 318 65 -598 319 65 -598` <!-- local y=1 vol=2 -->
- `mc fill oak_log 321 65 -582 321 65 -582` <!-- local y=1 vol=1 -->
- `mc fill oak_log 312 65 -591 312 65 -591` <!-- local y=1 vol=1 -->
- `mc fill oak_log 328 65 -589 328 65 -589` <!-- local y=1 vol=1 -->
- `mc fill oak_log 321 65 -598 321 65 -598` <!-- local y=1 vol=1 -->
- `mc fill oak_log 312 65 -589 312 65 -589` <!-- local y=1 vol=1 -->
- `mc fill oak_log 317 65 -593 317 65 -593` <!-- local y=1 vol=1 -->
- `mc fill oak_log 317 65 -587 317 65 -587` <!-- local y=1 vol=1 -->
- `mc fill oak_log 323 65 -593 323 65 -593` <!-- local y=1 vol=1 -->
- `mc fill oak_log 323 65 -587 323 65 -587` <!-- local y=1 vol=1 -->
- `mc fill oak_log 328 65 -591 328 65 -591` <!-- local y=1 vol=1 -->
- `mc fill oak_log 319 65 -582 319 65 -582` <!-- local y=1 vol=1 -->
- `mc fill oak_planks 313 65 -591 327 65 -589` <!-- local y=1 vol=45 -->
- `mc fill oak_planks 319 65 -597 321 65 -592` <!-- local y=1 vol=18 -->
- `mc fill oak_planks 319 65 -586 321 65 -583` <!-- local y=1 vol=12 -->
- `mc fill oak_planks 317 65 -588 323 65 -588` <!-- local y=1 vol=7 -->
- `mc fill oak_planks 318 65 -587 322 65 -587` <!-- local y=1 vol=5 -->
- `mc fill oak_planks 317 65 -592 318 65 -592` <!-- local y=1 vol=2 -->
- `mc fill oak_planks 322 65 -593 322 65 -592` <!-- local y=1 vol=2 -->
- `mc fill oak_planks 318 65 -593 318 65 -593` <!-- local y=1 vol=1 -->
- `mc fill oak_planks 328 65 -590 328 65 -590` <!-- local y=1 vol=1 -->
- `mc fill oak_planks 323 65 -592 323 65 -592` <!-- local y=1 vol=1 -->
- `mc fill oak_planks 312 65 -590 312 65 -590` <!-- local y=1 vol=1 -->
- `mc fill oak_planks 320 65 -582 320 65 -582` <!-- local y=1 vol=1 -->
- `mc fill oak_planks 320 65 -598 320 65 -598` <!-- local y=1 vol=1 -->
- `mc fill stone_brick_slab 311 65 -593 314 65 -593` <!-- local y=1 vol=4 -->
- `mc fill stone_brick_slab 311 65 -587 314 65 -587` <!-- local y=1 vol=4 -->
- `mc fill stone_brick_slab 326 65 -593 329 65 -593` <!-- local y=1 vol=4 -->
- `mc fill stone_brick_slab 326 65 -587 329 65 -587` <!-- local y=1 vol=4 -->
- `mc fill stone_brick_slab 317 65 -584 317 65 -581` <!-- local y=1 vol=4 -->
- `mc fill stone_brick_slab 323 65 -599 323 65 -596` <!-- local y=1 vol=4 -->
- `mc fill stone_brick_slab 323 65 -584 323 65 -581` <!-- local y=1 vol=4 -->
- `mc fill stone_brick_slab 330 65 -591 330 65 -589` <!-- local y=1 vol=3 -->
- `mc fill stone_brick_slab 317 65 -598 317 65 -596` <!-- local y=1 vol=3 -->
- `mc fill stone_brick_slab 319 65 -580 321 65 -580` <!-- local y=1 vol=3 -->
- `mc fill stone_brick_slab 317 65 -599 319 65 -599` <!-- local y=1 vol=3 -->
- `mc fill stone_brick_slab 319 65 -600 321 65 -600` <!-- local y=1 vol=3 -->
- `mc fill stone_brick_slab 315 65 -586 316 65 -586` <!-- local y=1 vol=2 -->
- `mc fill stone_brick_slab 318 65 -581 319 65 -581` <!-- local y=1 vol=2 -->
- `mc fill stone_brick_slab 310 65 -589 311 65 -589` <!-- local y=1 vol=2 -->
- `mc fill stone_brick_slab 321 65 -599 322 65 -599` <!-- local y=1 vol=2 -->
- `mc fill stone_brick_slab 329 65 -592 329 65 -591` <!-- local y=1 vol=2 -->
- `mc fill stone_brick_slab 329 65 -589 329 65 -588` <!-- local y=1 vol=2 -->
- `mc fill stone_brick_slab 321 65 -581 322 65 -581` <!-- local y=1 vol=2 -->
- `mc fill stone_brick_slab 311 65 -592 311 65 -591` <!-- local y=1 vol=2 -->
- `mc fill stone_brick_slab 310 65 -591 310 65 -590` <!-- local y=1 vol=2 -->
- `mc fill stone_brick_slab 324 65 -586 325 65 -586` <!-- local y=1 vol=2 -->
- `mc fill stone_brick_slab 325 65 -594 325 65 -594` <!-- local y=1 vol=1 -->
- `mc fill stone_brick_slab 316 65 -585 316 65 -585` <!-- local y=1 vol=1 -->
- `mc fill stone_brick_slab 311 65 -588 311 65 -588` <!-- local y=1 vol=1 -->
- `mc fill stone_brick_slab 324 65 -585 324 65 -585` <!-- local y=1 vol=1 -->
- `mc fill stone_brick_slab 315 65 -594 315 65 -594` <!-- local y=1 vol=1 -->
- `mc fill stone_brick_slab 316 65 -595 316 65 -595` <!-- local y=1 vol=1 -->
- `mc fill stone_brick_slab 324 65 -595 324 65 -595` <!-- local y=1 vol=1 -->
- `mc fill stone_brick_stairs_east 325 65 -593 325 65 -593` <!-- local y=1 vol=1 -->
- `mc fill stone_brick_stairs_east 325 65 -587 325 65 -587` <!-- local y=1 vol=1 -->
- `mc fill stone_brick_stairs_north_normal 323 65 -595 323 65 -595` <!-- local y=1 vol=1 -->
- `mc fill stone_brick_stairs_north_normal 317 65 -595 317 65 -595` <!-- local y=1 vol=1 -->
- `mc fill stone_brick_stairs_south_normal 317 65 -585 317 65 -585` <!-- local y=1 vol=1 -->
- `mc fill stone_brick_stairs_south_normal 323 65 -585 323 65 -585` <!-- local y=1 vol=1 -->
- `mc fill stone_brick_stairs_west 315 65 -593 315 65 -593` <!-- local y=1 vol=1 -->
- `mc fill stone_brick_stairs_west 315 65 -587 315 65 -587` <!-- local y=1 vol=1 -->
- `mc fill stone_bricks 316 65 -594 317 65 -594` <!-- local y=1 vol=2 -->
- `mc fill stone_bricks 323 65 -594 324 65 -594` <!-- local y=1 vol=2 -->
- `mc fill stone_bricks 329 65 -590 329 65 -590` <!-- local y=1 vol=1 -->
- `mc fill stone_bricks 320 65 -581 320 65 -581` <!-- local y=1 vol=1 -->
- `mc fill stone_bricks 324 65 -593 324 65 -593` <!-- local y=1 vol=1 -->
- `mc fill stone_bricks 324 65 -587 324 65 -587` <!-- local y=1 vol=1 -->
- `mc fill stone_bricks 320 65 -599 320 65 -599` <!-- local y=1 vol=1 -->
- `mc fill stone_bricks 317 65 -586 317 65 -586` <!-- local y=1 vol=1 -->
- `mc fill stone_bricks 323 65 -586 323 65 -586` <!-- local y=1 vol=1 -->
- `mc fill stone_bricks 311 65 -590 311 65 -590` <!-- local y=1 vol=1 -->
- `mc fill stone_bricks 316 65 -593 316 65 -593` <!-- local y=1 vol=1 -->
- `mc fill stone_bricks 316 65 -587 316 65 -587` <!-- local y=1 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 1`

### Layer Y = 2 (67 cells)

**Materials this layer:** `stone_bricks`×37, `oak_log`×16, `oak_door`×4, `stone_brick_stairs_west`×3, `stone_brick_stairs_east`×2, `stone_brick_stairs_north_normal`×2, `stone_brick_stairs_south_normal`×2, `oak_fence`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill oak_fence 320 66 -590 320 66 -590` <!-- local y=2 vol=1 -->
- `mc fill oak_log 318 66 -582 318 66 -582` <!-- local y=2 vol=1 -->
- `mc fill oak_log 318 66 -598 318 66 -598` <!-- local y=2 vol=1 -->
- `mc fill oak_log 322 66 -594 322 66 -594` <!-- local y=2 vol=1 -->
- `mc fill oak_log 324 66 -588 324 66 -588` <!-- local y=2 vol=1 -->
- `mc fill oak_log 316 66 -588 316 66 -588` <!-- local y=2 vol=1 -->
- `mc fill oak_log 318 66 -586 318 66 -586` <!-- local y=2 vol=1 -->
- `mc fill oak_log 328 66 -588 328 66 -588` <!-- local y=2 vol=1 -->
- `mc fill oak_log 322 66 -598 322 66 -598` <!-- local y=2 vol=1 -->
- `mc fill oak_log 322 66 -582 322 66 -582` <!-- local y=2 vol=1 -->
- `mc fill oak_log 328 66 -592 328 66 -592` <!-- local y=2 vol=1 -->
- `mc fill oak_log 316 66 -592 316 66 -592` <!-- local y=2 vol=1 -->
- `mc fill oak_log 312 66 -592 312 66 -592` <!-- local y=2 vol=1 -->
- `mc fill oak_log 312 66 -588 312 66 -588` <!-- local y=2 vol=1 -->
- `mc fill oak_log 324 66 -592 324 66 -592` <!-- local y=2 vol=1 -->
- `mc fill oak_log 322 66 -586 322 66 -586` <!-- local y=2 vol=1 -->
- `mc fill oak_log 318 66 -594 318 66 -594` <!-- local y=2 vol=1 -->
- `mc fill stone_brick_stairs_east 324 66 -593 324 66 -593` <!-- local y=2 vol=1 -->
- `mc fill stone_brick_stairs_east 324 66 -587 324 66 -587` <!-- local y=2 vol=1 -->
- `mc fill stone_brick_stairs_north_normal 317 66 -594 317 66 -594` <!-- local y=2 vol=1 -->
- `mc fill stone_brick_stairs_north_normal 323 66 -594 323 66 -594` <!-- local y=2 vol=1 -->
- `mc fill stone_brick_stairs_south_normal 317 66 -586 317 66 -586` <!-- local y=2 vol=1 -->
- `mc fill stone_brick_stairs_south_normal 323 66 -586 323 66 -586` <!-- local y=2 vol=1 -->
- `mc fill stone_brick_stairs_west 318 66 -589 318 66 -589` <!-- local y=2 vol=1 -->
- `mc fill stone_brick_stairs_west 316 66 -593 316 66 -593` <!-- local y=2 vol=1 -->
- `mc fill stone_brick_stairs_west 316 66 -587 316 66 -587` <!-- local y=2 vol=1 -->
- `mc fill stone_bricks 313 66 -592 315 66 -592` <!-- local y=2 vol=3 -->
- `mc fill stone_bricks 325 66 -588 327 66 -588` <!-- local y=2 vol=3 -->
- `mc fill stone_bricks 318 66 -597 318 66 -595` <!-- local y=2 vol=3 -->
- `mc fill stone_bricks 318 66 -585 318 66 -583` <!-- local y=2 vol=3 -->
- `mc fill stone_bricks 322 66 -597 322 66 -595` <!-- local y=2 vol=3 -->
- `mc fill stone_bricks 325 66 -592 327 66 -592` <!-- local y=2 vol=3 -->
- `mc fill stone_bricks 322 66 -585 322 66 -583` <!-- local y=2 vol=3 -->
- `mc fill stone_bricks 313 66 -588 315 66 -588` <!-- local y=2 vol=3 -->
- `mc fill stone_bricks 321 66 -582 321 66 -582` <!-- local y=2 vol=1 -->
- `mc fill stone_bricks 312 66 -591 312 66 -591` <!-- local y=2 vol=1 -->
- `mc fill stone_bricks 319 66 -598 319 66 -598` <!-- local y=2 vol=1 -->
- `mc fill stone_bricks 328 66 -589 328 66 -589` <!-- local y=2 vol=1 -->
- `mc fill stone_bricks 319 66 -589 319 66 -589` <!-- local y=2 vol=1 -->
- `mc fill stone_bricks 321 66 -598 321 66 -598` <!-- local y=2 vol=1 -->
- `mc fill stone_bricks 312 66 -589 312 66 -589` <!-- local y=2 vol=1 -->
- `mc fill stone_bricks 317 66 -593 317 66 -593` <!-- local y=2 vol=1 -->
- `mc fill stone_bricks 317 66 -587 317 66 -587` <!-- local y=2 vol=1 -->
- `mc fill stone_bricks 323 66 -593 323 66 -593` <!-- local y=2 vol=1 -->
- `mc fill stone_bricks 323 66 -587 323 66 -587` <!-- local y=2 vol=1 -->
- `mc fill stone_bricks 328 66 -591 328 66 -591` <!-- local y=2 vol=1 -->
- `mc fill stone_bricks 319 66 -582 319 66 -582` <!-- local y=2 vol=1 -->

**Single blocks** (first 30; full list: `mc blueprint layer hut1-guard-tower --y 2`):

- `mc place oak_door 328 66 -590`
- `mc place oak_door 320 66 -598`
- `mc place oak_door 320 66 -582`
- `mc place oak_door 312 66 -590`

**Verify layer:** `mc blueprint verify :hut1: --level 2`

### Layer Y = 3 (58 cells)

**Materials this layer:** `stone_bricks`×28, `oak_log`×16, `glass`×8, `oak_door`×4, `oak_fence`×1, `stone_brick_stairs_west`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill glass 322 67 -584 322 67 -584` <!-- local y=3 vol=1 -->
- `mc fill glass 326 67 -588 326 67 -588` <!-- local y=3 vol=1 -->
- `mc fill glass 326 67 -592 326 67 -592` <!-- local y=3 vol=1 -->
- `mc fill glass 314 67 -588 314 67 -588` <!-- local y=3 vol=1 -->
- `mc fill glass 318 67 -596 318 67 -596` <!-- local y=3 vol=1 -->
- `mc fill glass 314 67 -592 314 67 -592` <!-- local y=3 vol=1 -->
- `mc fill glass 318 67 -584 318 67 -584` <!-- local y=3 vol=1 -->
- `mc fill glass 322 67 -596 322 67 -596` <!-- local y=3 vol=1 -->
- `mc fill oak_fence 320 67 -590 320 67 -590` <!-- local y=3 vol=1 -->
- `mc fill oak_log 318 67 -582 318 67 -582` <!-- local y=3 vol=1 -->
- `mc fill oak_log 318 67 -598 318 67 -598` <!-- local y=3 vol=1 -->
- `mc fill oak_log 322 67 -594 322 67 -594` <!-- local y=3 vol=1 -->
- `mc fill oak_log 324 67 -588 324 67 -588` <!-- local y=3 vol=1 -->
- `mc fill oak_log 316 67 -588 316 67 -588` <!-- local y=3 vol=1 -->
- `mc fill oak_log 318 67 -586 318 67 -586` <!-- local y=3 vol=1 -->
- `mc fill oak_log 328 67 -588 328 67 -588` <!-- local y=3 vol=1 -->
- `mc fill oak_log 322 67 -598 322 67 -598` <!-- local y=3 vol=1 -->
- `mc fill oak_log 322 67 -582 322 67 -582` <!-- local y=3 vol=1 -->
- `mc fill oak_log 328 67 -592 328 67 -592` <!-- local y=3 vol=1 -->
- `mc fill oak_log 316 67 -592 316 67 -592` <!-- local y=3 vol=1 -->
- `mc fill oak_log 312 67 -592 312 67 -592` <!-- local y=3 vol=1 -->
- `mc fill oak_log 312 67 -588 312 67 -588` <!-- local y=3 vol=1 -->
- `mc fill oak_log 324 67 -592 324 67 -592` <!-- local y=3 vol=1 -->
- `mc fill oak_log 322 67 -586 322 67 -586` <!-- local y=3 vol=1 -->
- `mc fill oak_log 318 67 -594 318 67 -594` <!-- local y=3 vol=1 -->
- `mc fill stone_brick_stairs_west 319 67 -589 319 67 -589` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 313 67 -592 313 67 -592` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 321 67 -582 321 67 -582` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 312 67 -591 312 67 -591` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 328 67 -589 328 67 -589` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 319 67 -598 319 67 -598` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 325 67 -588 325 67 -588` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 327 67 -588 327 67 -588` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 321 67 -598 321 67 -598` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 312 67 -589 312 67 -589` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 318 67 -597 318 67 -597` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 318 67 -585 318 67 -585` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 317 67 -593 317 67 -593` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 322 67 -597 322 67 -597` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 317 67 -587 317 67 -587` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 325 67 -592 325 67 -592` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 322 67 -585 322 67 -585` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 327 67 -592 327 67 -592` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 315 67 -588 315 67 -588` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 323 67 -593 323 67 -593` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 323 67 -587 323 67 -587` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 313 67 -588 313 67 -588` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 318 67 -595 318 67 -595` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 328 67 -591 328 67 -591` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 318 67 -583 318 67 -583` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 322 67 -595 322 67 -595` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 319 67 -582 319 67 -582` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 322 67 -583 322 67 -583` <!-- local y=3 vol=1 -->
- `mc fill stone_bricks 315 67 -592 315 67 -592` <!-- local y=3 vol=1 -->

**Single blocks** (first 30; full list: `mc blueprint layer hut1-guard-tower --y 3`):

- `mc place oak_door 328 67 -590`
- `mc place oak_door 320 67 -598`
- `mc place oak_door 320 67 -582`
- `mc place oak_door 312 67 -590`

**Verify layer:** `mc blueprint verify :hut1: --level 3`

### Layer Y = 4 (127 cells)

**Materials this layer:** `stone_bricks`×49, `oak_log`×16, `oak_wood_stairs_north_normal`×12, `oak_wood_stairs_south_normal`×12, `oak_wood_stairs_east_normal`×12, `oak_wood_stairs_west_normal`×12, `torch_facing_west`×3, `torch_facing_east`×3, `torch_facing_south`×3, `torch_facing_north`×3, `oak_fence`×1, `stone_brick_stairs_west`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill oak_fence 320 68 -590 320 68 -590` <!-- local y=4 vol=1 -->
- `mc fill oak_log 318 68 -582 318 68 -582` <!-- local y=4 vol=1 -->
- `mc fill oak_log 318 68 -598 318 68 -598` <!-- local y=4 vol=1 -->
- `mc fill oak_log 322 68 -594 322 68 -594` <!-- local y=4 vol=1 -->
- `mc fill oak_log 324 68 -588 324 68 -588` <!-- local y=4 vol=1 -->
- `mc fill oak_log 316 68 -588 316 68 -588` <!-- local y=4 vol=1 -->
- `mc fill oak_log 318 68 -586 318 68 -586` <!-- local y=4 vol=1 -->
- `mc fill oak_log 328 68 -588 328 68 -588` <!-- local y=4 vol=1 -->
- `mc fill oak_log 322 68 -598 322 68 -598` <!-- local y=4 vol=1 -->
- `mc fill oak_log 322 68 -582 322 68 -582` <!-- local y=4 vol=1 -->
- `mc fill oak_log 328 68 -592 328 68 -592` <!-- local y=4 vol=1 -->
- `mc fill oak_log 316 68 -592 316 68 -592` <!-- local y=4 vol=1 -->
- `mc fill oak_log 312 68 -592 312 68 -592` <!-- local y=4 vol=1 -->
- `mc fill oak_log 312 68 -588 312 68 -588` <!-- local y=4 vol=1 -->
- `mc fill oak_log 324 68 -592 324 68 -592` <!-- local y=4 vol=1 -->
- `mc fill oak_log 322 68 -586 322 68 -586` <!-- local y=4 vol=1 -->
- `mc fill oak_log 318 68 -594 318 68 -594` <!-- local y=4 vol=1 -->
- `mc fill oak_wood_stairs_east_normal 323 68 -599 323 68 -594` <!-- local y=4 vol=6 -->
- `mc fill oak_wood_stairs_east_normal 323 68 -586 323 68 -581` <!-- local y=4 vol=6 -->
- `mc fill oak_wood_stairs_north_normal 324 68 -593 329 68 -593` <!-- local y=4 vol=6 -->
- `mc fill oak_wood_stairs_north_normal 311 68 -593 316 68 -593` <!-- local y=4 vol=6 -->
- `mc fill oak_wood_stairs_south_normal 311 68 -587 316 68 -587` <!-- local y=4 vol=6 -->
- `mc fill oak_wood_stairs_south_normal 324 68 -587 329 68 -587` <!-- local y=4 vol=6 -->
- `mc fill oak_wood_stairs_west_normal 317 68 -599 317 68 -594` <!-- local y=4 vol=6 -->
- `mc fill oak_wood_stairs_west_normal 317 68 -586 317 68 -581` <!-- local y=4 vol=6 -->
- `mc fill stone_brick_stairs_west 320 68 -589 320 68 -589` <!-- local y=4 vol=1 -->
- `mc fill stone_bricks 313 68 -592 315 68 -592` <!-- local y=4 vol=3 -->
- `mc fill stone_bricks 312 68 -591 312 68 -589` <!-- local y=4 vol=3 -->
- `mc fill stone_bricks 319 68 -598 321 68 -598` <!-- local y=4 vol=3 -->
- `mc fill stone_bricks 325 68 -588 327 68 -588` <!-- local y=4 vol=3 -->
- `mc fill stone_bricks 318 68 -597 318 68 -595` <!-- local y=4 vol=3 -->
- `mc fill stone_bricks 318 68 -585 318 68 -583` <!-- local y=4 vol=3 -->
- `mc fill stone_bricks 322 68 -597 322 68 -595` <!-- local y=4 vol=3 -->
- `mc fill stone_bricks 325 68 -592 327 68 -592` <!-- local y=4 vol=3 -->
- `mc fill stone_bricks 322 68 -585 322 68 -583` <!-- local y=4 vol=3 -->
- `mc fill stone_bricks 313 68 -588 315 68 -588` <!-- local y=4 vol=3 -->
- `mc fill stone_bricks 328 68 -591 328 68 -589` <!-- local y=4 vol=3 -->
- `mc fill stone_bricks 319 68 -582 321 68 -582` <!-- local y=4 vol=3 -->
- `mc fill stone_bricks 323 68 -588 323 68 -587` <!-- local y=4 vol=2 -->
- `mc fill stone_bricks 322 68 -593 323 68 -593` <!-- local y=4 vol=2 -->
- `mc fill stone_bricks 317 68 -593 318 68 -593` <!-- local y=4 vol=2 -->
- `mc fill stone_bricks 317 68 -587 318 68 -587` <!-- local y=4 vol=2 -->
- `mc fill stone_bricks 317 68 -592 317 68 -592` <!-- local y=4 vol=1 -->
- `mc fill stone_bricks 322 68 -587 322 68 -587` <!-- local y=4 vol=1 -->
- `mc fill stone_bricks 321 68 -589 321 68 -589` <!-- local y=4 vol=1 -->
- `mc fill stone_bricks 323 68 -592 323 68 -592` <!-- local y=4 vol=1 -->
- `mc fill stone_bricks 317 68 -588 317 68 -588` <!-- local y=4 vol=1 -->
- `mc fill torch_facing_east 311 68 -592 311 68 -592` <!-- local y=4 vol=1 -->
- `mc fill torch_facing_east 327 68 -590 327 68 -590` <!-- local y=4 vol=1 -->
- `mc fill torch_facing_east 311 68 -588 311 68 -588` <!-- local y=4 vol=1 -->
- `mc fill torch_facing_north 322 68 -581 322 68 -581` <!-- local y=4 vol=1 -->
- `mc fill torch_facing_north 320 68 -597 320 68 -597` <!-- local y=4 vol=1 -->
- `mc fill torch_facing_north 318 68 -581 318 68 -581` <!-- local y=4 vol=1 -->
- `mc fill torch_facing_south 322 68 -599 322 68 -599` <!-- local y=4 vol=1 -->
- `mc fill torch_facing_south 318 68 -599 318 68 -599` <!-- local y=4 vol=1 -->
- `mc fill torch_facing_south 320 68 -583 320 68 -583` <!-- local y=4 vol=1 -->
- `mc fill torch_facing_west 313 68 -590 313 68 -590` <!-- local y=4 vol=1 -->
- `mc fill torch_facing_west 329 68 -588 329 68 -588` <!-- local y=4 vol=1 -->
- `mc fill torch_facing_west 329 68 -592 329 68 -592` <!-- local y=4 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 4`

### Layer Y = 5 (91 cells)

**Materials this layer:** `stone_bricks`×21, `oak_wood_stairs_north_normal`×12, `oak_wood_stairs_south_normal`×12, `oak_log`×12, `oak_wood_stairs_east_normal`×12, `oak_wood_stairs_west_normal`×12, `stone_brick_slab`×4, `torch_facing_east`×1, `stone_brick_stairs_south_normal`×1, `torch_facing_north`×1, `oak_fence`×1, `torch_facing_south`×1, `torch_facing_west`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill oak_fence 320 69 -590 320 69 -590` <!-- local y=5 vol=1 -->
- `mc fill oak_log 328 69 -591 328 69 -589` <!-- local y=5 vol=3 -->
- `mc fill oak_log 312 69 -591 312 69 -589` <!-- local y=5 vol=3 -->
- `mc fill oak_log 319 69 -582 321 69 -582` <!-- local y=5 vol=3 -->
- `mc fill oak_log 319 69 -598 321 69 -598` <!-- local y=5 vol=3 -->
- `mc fill oak_wood_stairs_east_normal 322 69 -599 322 69 -594` <!-- local y=5 vol=6 -->
- `mc fill oak_wood_stairs_east_normal 322 69 -586 322 69 -581` <!-- local y=5 vol=6 -->
- `mc fill oak_wood_stairs_north_normal 311 69 -592 316 69 -592` <!-- local y=5 vol=6 -->
- `mc fill oak_wood_stairs_north_normal 324 69 -592 329 69 -592` <!-- local y=5 vol=6 -->
- `mc fill oak_wood_stairs_south_normal 324 69 -588 329 69 -588` <!-- local y=5 vol=6 -->
- `mc fill oak_wood_stairs_south_normal 311 69 -588 316 69 -588` <!-- local y=5 vol=6 -->
- `mc fill oak_wood_stairs_west_normal 318 69 -599 318 69 -594` <!-- local y=5 vol=6 -->
- `mc fill oak_wood_stairs_west_normal 318 69 -586 318 69 -581` <!-- local y=5 vol=6 -->
- `mc fill stone_brick_slab 317 69 -593 317 69 -593` <!-- local y=5 vol=1 -->
- `mc fill stone_brick_slab 323 69 -593 323 69 -593` <!-- local y=5 vol=1 -->
- `mc fill stone_brick_slab 323 69 -587 323 69 -587` <!-- local y=5 vol=1 -->
- `mc fill stone_brick_slab 317 69 -587 317 69 -587` <!-- local y=5 vol=1 -->
- `mc fill stone_brick_stairs_south_normal 321 69 -590 321 69 -590` <!-- local y=5 vol=1 -->
- `mc fill stone_bricks 317 69 -592 317 69 -588` <!-- local y=5 vol=5 -->
- `mc fill stone_bricks 318 69 -593 322 69 -593` <!-- local y=5 vol=5 -->
- `mc fill stone_bricks 318 69 -587 322 69 -587` <!-- local y=5 vol=5 -->
- `mc fill stone_bricks 323 69 -592 323 69 -588` <!-- local y=5 vol=5 -->
- `mc fill stone_bricks 321 69 -591 321 69 -591` <!-- local y=5 vol=1 -->
- `mc fill torch_facing_east 322 69 -590 322 69 -590` <!-- local y=5 vol=1 -->
- `mc fill torch_facing_north 320 69 -592 320 69 -592` <!-- local y=5 vol=1 -->
- `mc fill torch_facing_south 320 69 -588 320 69 -588` <!-- local y=5 vol=1 -->
- `mc fill torch_facing_west 318 69 -590 318 69 -590` <!-- local y=5 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 5`

### Layer Y = 6 (96 cells)

**Materials this layer:** `oak_planks`×24, `stone_bricks`×22, `oak_wood_stairs_north_normal`×12, `oak_wood_stairs_south_normal`×12, `oak_wood_stairs_east_normal`×12, `oak_wood_stairs_west_normal`×12, `stone_brick_stairs_east`×1, `oak_fence`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill oak_fence 320 70 -590 320 70 -590` <!-- local y=6 vol=1 -->
- `mc fill oak_planks 320 70 -599 320 70 -594` <!-- local y=6 vol=6 -->
- `mc fill oak_planks 311 70 -590 316 70 -590` <!-- local y=6 vol=6 -->
- `mc fill oak_planks 324 70 -590 329 70 -590` <!-- local y=6 vol=6 -->
- `mc fill oak_planks 320 70 -586 320 70 -581` <!-- local y=6 vol=6 -->
- `mc fill oak_wood_stairs_east_normal 321 70 -599 321 70 -594` <!-- local y=6 vol=6 -->
- `mc fill oak_wood_stairs_east_normal 321 70 -586 321 70 -581` <!-- local y=6 vol=6 -->
- `mc fill oak_wood_stairs_north_normal 311 70 -591 316 70 -591` <!-- local y=6 vol=6 -->
- `mc fill oak_wood_stairs_north_normal 324 70 -591 329 70 -591` <!-- local y=6 vol=6 -->
- `mc fill oak_wood_stairs_south_normal 311 70 -589 316 70 -589` <!-- local y=6 vol=6 -->
- `mc fill oak_wood_stairs_south_normal 324 70 -589 329 70 -589` <!-- local y=6 vol=6 -->
- `mc fill oak_wood_stairs_west_normal 319 70 -586 319 70 -581` <!-- local y=6 vol=6 -->
- `mc fill oak_wood_stairs_west_normal 319 70 -599 319 70 -594` <!-- local y=6 vol=6 -->
- `mc fill stone_brick_stairs_east 320 70 -591 320 70 -591` <!-- local y=6 vol=1 -->
- `mc fill stone_bricks 317 70 -592 317 70 -588` <!-- local y=6 vol=5 -->
- `mc fill stone_bricks 318 70 -593 322 70 -593` <!-- local y=6 vol=5 -->
- `mc fill stone_bricks 318 70 -587 322 70 -587` <!-- local y=6 vol=5 -->
- `mc fill stone_bricks 323 70 -592 323 70 -588` <!-- local y=6 vol=5 -->
- `mc fill stone_bricks 319 70 -591 319 70 -590` <!-- local y=6 vol=2 -->

**Verify layer:** `mc blueprint verify :hut1: --level 6`

### Layer Y = 7 (47 cells)

**Materials this layer:** `oak_fence`×25, `stone_bricks`×21, `stone_brick_stairs_north_normal`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill oak_fence 320 71 -599 320 71 -594` <!-- local y=7 vol=6 -->
- `mc fill oak_fence 311 71 -590 316 71 -590` <!-- local y=7 vol=6 -->
- `mc fill oak_fence 324 71 -590 329 71 -590` <!-- local y=7 vol=6 -->
- `mc fill oak_fence 320 71 -586 320 71 -581` <!-- local y=7 vol=6 -->
- `mc fill oak_fence 320 71 -590 320 71 -590` <!-- local y=7 vol=1 -->
- `mc fill stone_brick_stairs_north_normal 319 71 -590 319 71 -590` <!-- local y=7 vol=1 -->
- `mc fill stone_bricks 317 71 -592 317 71 -588` <!-- local y=7 vol=5 -->
- `mc fill stone_bricks 318 71 -593 322 71 -593` <!-- local y=7 vol=5 -->
- `mc fill stone_bricks 318 71 -587 322 71 -587` <!-- local y=7 vol=5 -->
- `mc fill stone_bricks 323 71 -592 323 71 -588` <!-- local y=7 vol=5 -->
- `mc fill stone_bricks 319 71 -589 319 71 -589` <!-- local y=7 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 7`

### Layer Y = 8 (31 cells)

**Materials this layer:** `stone_bricks`×13, `oak_fence`×5, `oak_planks`×4, `stone_brick_stairs_west`×3, `stone_brick_stairs_north_normal`×2, `stone_brick_stairs_south_normal`×2, `stone_brick_stairs_east`×2

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill oak_fence 329 72 -590 329 72 -590` <!-- local y=8 vol=1 -->
- `mc fill oak_fence 320 72 -581 320 72 -581` <!-- local y=8 vol=1 -->
- `mc fill oak_fence 320 72 -599 320 72 -599` <!-- local y=8 vol=1 -->
- `mc fill oak_fence 311 72 -590 311 72 -590` <!-- local y=8 vol=1 -->
- `mc fill oak_fence 320 72 -590 320 72 -590` <!-- local y=8 vol=1 -->
- `mc fill oak_planks 322 72 -592 322 72 -592` <!-- local y=8 vol=1 -->
- `mc fill oak_planks 318 72 -592 318 72 -592` <!-- local y=8 vol=1 -->
- `mc fill oak_planks 318 72 -588 318 72 -588` <!-- local y=8 vol=1 -->
- `mc fill oak_planks 322 72 -588 322 72 -588` <!-- local y=8 vol=1 -->
- `mc fill stone_brick_stairs_east 322 72 -593 322 72 -593` <!-- local y=8 vol=1 -->
- `mc fill stone_brick_stairs_east 322 72 -587 322 72 -587` <!-- local y=8 vol=1 -->
- `mc fill stone_brick_stairs_north_normal 317 72 -592 317 72 -592` <!-- local y=8 vol=1 -->
- `mc fill stone_brick_stairs_north_normal 323 72 -592 323 72 -592` <!-- local y=8 vol=1 -->
- `mc fill stone_brick_stairs_south_normal 317 72 -588 317 72 -588` <!-- local y=8 vol=1 -->
- `mc fill stone_brick_stairs_south_normal 323 72 -588 323 72 -588` <!-- local y=8 vol=1 -->
- `mc fill stone_brick_stairs_west 320 72 -589 320 72 -589` <!-- local y=8 vol=1 -->
- `mc fill stone_brick_stairs_west 318 72 -593 318 72 -593` <!-- local y=8 vol=1 -->
- `mc fill stone_brick_stairs_west 318 72 -587 318 72 -587` <!-- local y=8 vol=1 -->
- `mc fill stone_bricks 319 72 -593 321 72 -593` <!-- local y=8 vol=3 -->
- `mc fill stone_bricks 319 72 -587 321 72 -587` <!-- local y=8 vol=3 -->
- `mc fill stone_bricks 317 72 -591 317 72 -589` <!-- local y=8 vol=3 -->
- `mc fill stone_bricks 323 72 -591 323 72 -589` <!-- local y=8 vol=3 -->
- `mc fill stone_bricks 321 72 -589 321 72 -589` <!-- local y=8 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 8`

### Layer Y = 9 (19 cells)

**Materials this layer:** `stone_bricks`×9, `glass`×4, `oak_planks`×4, `stone_brick_stairs_south_normal`×1, `oak_fence`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill glass 320 73 -593 320 73 -593` <!-- local y=9 vol=1 -->
- `mc fill glass 320 73 -587 320 73 -587` <!-- local y=9 vol=1 -->
- `mc fill glass 317 73 -590 317 73 -590` <!-- local y=9 vol=1 -->
- `mc fill glass 323 73 -590 323 73 -590` <!-- local y=9 vol=1 -->
- `mc fill oak_fence 320 73 -590 320 73 -590` <!-- local y=9 vol=1 -->
- `mc fill oak_planks 322 73 -592 322 73 -592` <!-- local y=9 vol=1 -->
- `mc fill oak_planks 318 73 -592 318 73 -592` <!-- local y=9 vol=1 -->
- `mc fill oak_planks 318 73 -588 318 73 -588` <!-- local y=9 vol=1 -->
- `mc fill oak_planks 322 73 -588 322 73 -588` <!-- local y=9 vol=1 -->
- `mc fill stone_brick_stairs_south_normal 321 73 -590 321 73 -590` <!-- local y=9 vol=1 -->
- `mc fill stone_bricks 319 73 -593 319 73 -593` <!-- local y=9 vol=1 -->
- `mc fill stone_bricks 319 73 -587 319 73 -587` <!-- local y=9 vol=1 -->
- `mc fill stone_bricks 321 73 -591 321 73 -591` <!-- local y=9 vol=1 -->
- `mc fill stone_bricks 317 73 -591 317 73 -591` <!-- local y=9 vol=1 -->
- `mc fill stone_bricks 323 73 -591 323 73 -591` <!-- local y=9 vol=1 -->
- `mc fill stone_bricks 317 73 -589 317 73 -589` <!-- local y=9 vol=1 -->
- `mc fill stone_bricks 323 73 -589 323 73 -589` <!-- local y=9 vol=1 -->
- `mc fill stone_bricks 321 73 -593 321 73 -593` <!-- local y=9 vol=1 -->
- `mc fill stone_bricks 321 73 -587 321 73 -587` <!-- local y=9 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 9`

### Layer Y = 10 (19 cells)

**Materials this layer:** `stone_bricks`×9, `glass`×4, `oak_planks`×4, `stone_brick_stairs_east`×1, `oak_fence`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill glass 320 74 -593 320 74 -593` <!-- local y=10 vol=1 -->
- `mc fill glass 320 74 -587 320 74 -587` <!-- local y=10 vol=1 -->
- `mc fill glass 317 74 -590 317 74 -590` <!-- local y=10 vol=1 -->
- `mc fill glass 323 74 -590 323 74 -590` <!-- local y=10 vol=1 -->
- `mc fill oak_fence 320 74 -590 320 74 -590` <!-- local y=10 vol=1 -->
- `mc fill oak_planks 322 74 -592 322 74 -592` <!-- local y=10 vol=1 -->
- `mc fill oak_planks 318 74 -592 318 74 -592` <!-- local y=10 vol=1 -->
- `mc fill oak_planks 318 74 -588 318 74 -588` <!-- local y=10 vol=1 -->
- `mc fill oak_planks 322 74 -588 322 74 -588` <!-- local y=10 vol=1 -->
- `mc fill stone_brick_stairs_east 320 74 -591 320 74 -591` <!-- local y=10 vol=1 -->
- `mc fill stone_bricks 319 74 -593 319 74 -593` <!-- local y=10 vol=1 -->
- `mc fill stone_bricks 319 74 -587 319 74 -587` <!-- local y=10 vol=1 -->
- `mc fill stone_bricks 317 74 -591 317 74 -591` <!-- local y=10 vol=1 -->
- `mc fill stone_bricks 323 74 -591 323 74 -591` <!-- local y=10 vol=1 -->
- `mc fill stone_bricks 319 74 -591 319 74 -591` <!-- local y=10 vol=1 -->
- `mc fill stone_bricks 317 74 -589 317 74 -589` <!-- local y=10 vol=1 -->
- `mc fill stone_bricks 323 74 -589 323 74 -589` <!-- local y=10 vol=1 -->
- `mc fill stone_bricks 321 74 -593 321 74 -593` <!-- local y=10 vol=1 -->
- `mc fill stone_bricks 321 74 -587 321 74 -587` <!-- local y=10 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 10`

### Layer Y = 11 (19 cells)

**Materials this layer:** `stone_bricks`×13, `oak_planks`×4, `oak_fence`×1, `stone_brick_stairs_north_normal`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill oak_fence 320 75 -590 320 75 -590` <!-- local y=11 vol=1 -->
- `mc fill oak_planks 322 75 -592 322 75 -592` <!-- local y=11 vol=1 -->
- `mc fill oak_planks 318 75 -592 318 75 -592` <!-- local y=11 vol=1 -->
- `mc fill oak_planks 318 75 -588 318 75 -588` <!-- local y=11 vol=1 -->
- `mc fill oak_planks 322 75 -588 322 75 -588` <!-- local y=11 vol=1 -->
- `mc fill stone_brick_stairs_north_normal 319 75 -590 319 75 -590` <!-- local y=11 vol=1 -->
- `mc fill stone_bricks 319 75 -593 321 75 -593` <!-- local y=11 vol=3 -->
- `mc fill stone_bricks 319 75 -587 321 75 -587` <!-- local y=11 vol=3 -->
- `mc fill stone_bricks 317 75 -591 317 75 -589` <!-- local y=11 vol=3 -->
- `mc fill stone_bricks 323 75 -591 323 75 -589` <!-- local y=11 vol=3 -->
- `mc fill stone_bricks 319 75 -589 319 75 -589` <!-- local y=11 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 11`

### Layer Y = 12 (19 cells)

**Materials this layer:** `stone_bricks`×9, `glass`×4, `oak_planks`×4, `oak_fence`×1, `stone_brick_stairs_west`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill glass 320 76 -593 320 76 -593` <!-- local y=12 vol=1 -->
- `mc fill glass 320 76 -587 320 76 -587` <!-- local y=12 vol=1 -->
- `mc fill glass 317 76 -590 317 76 -590` <!-- local y=12 vol=1 -->
- `mc fill glass 323 76 -590 323 76 -590` <!-- local y=12 vol=1 -->
- `mc fill oak_fence 320 76 -590 320 76 -590` <!-- local y=12 vol=1 -->
- `mc fill oak_planks 322 76 -592 322 76 -592` <!-- local y=12 vol=1 -->
- `mc fill oak_planks 318 76 -592 318 76 -592` <!-- local y=12 vol=1 -->
- `mc fill oak_planks 318 76 -588 318 76 -588` <!-- local y=12 vol=1 -->
- `mc fill oak_planks 322 76 -588 322 76 -588` <!-- local y=12 vol=1 -->
- `mc fill stone_brick_stairs_west 320 76 -589 320 76 -589` <!-- local y=12 vol=1 -->
- `mc fill stone_bricks 319 76 -593 319 76 -593` <!-- local y=12 vol=1 -->
- `mc fill stone_bricks 319 76 -587 319 76 -587` <!-- local y=12 vol=1 -->
- `mc fill stone_bricks 317 76 -591 317 76 -591` <!-- local y=12 vol=1 -->
- `mc fill stone_bricks 323 76 -591 323 76 -591` <!-- local y=12 vol=1 -->
- `mc fill stone_bricks 321 76 -589 321 76 -589` <!-- local y=12 vol=1 -->
- `mc fill stone_bricks 317 76 -589 317 76 -589` <!-- local y=12 vol=1 -->
- `mc fill stone_bricks 323 76 -589 323 76 -589` <!-- local y=12 vol=1 -->
- `mc fill stone_bricks 321 76 -593 321 76 -593` <!-- local y=12 vol=1 -->
- `mc fill stone_bricks 321 76 -587 321 76 -587` <!-- local y=12 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 12`

### Layer Y = 13 (19 cells)

**Materials this layer:** `stone_bricks`×9, `glass`×4, `oak_planks`×4, `stone_brick_stairs_south_normal`×1, `oak_fence`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill glass 320 77 -593 320 77 -593` <!-- local y=13 vol=1 -->
- `mc fill glass 320 77 -587 320 77 -587` <!-- local y=13 vol=1 -->
- `mc fill glass 317 77 -590 317 77 -590` <!-- local y=13 vol=1 -->
- `mc fill glass 323 77 -590 323 77 -590` <!-- local y=13 vol=1 -->
- `mc fill oak_fence 320 77 -590 320 77 -590` <!-- local y=13 vol=1 -->
- `mc fill oak_planks 322 77 -592 322 77 -592` <!-- local y=13 vol=1 -->
- `mc fill oak_planks 318 77 -592 318 77 -592` <!-- local y=13 vol=1 -->
- `mc fill oak_planks 318 77 -588 318 77 -588` <!-- local y=13 vol=1 -->
- `mc fill oak_planks 322 77 -588 322 77 -588` <!-- local y=13 vol=1 -->
- `mc fill stone_brick_stairs_south_normal 321 77 -590 321 77 -590` <!-- local y=13 vol=1 -->
- `mc fill stone_bricks 319 77 -593 319 77 -593` <!-- local y=13 vol=1 -->
- `mc fill stone_bricks 319 77 -587 319 77 -587` <!-- local y=13 vol=1 -->
- `mc fill stone_bricks 321 77 -591 321 77 -591` <!-- local y=13 vol=1 -->
- `mc fill stone_bricks 317 77 -591 317 77 -591` <!-- local y=13 vol=1 -->
- `mc fill stone_bricks 323 77 -591 323 77 -591` <!-- local y=13 vol=1 -->
- `mc fill stone_bricks 317 77 -589 317 77 -589` <!-- local y=13 vol=1 -->
- `mc fill stone_bricks 323 77 -589 323 77 -589` <!-- local y=13 vol=1 -->
- `mc fill stone_bricks 321 77 -593 321 77 -593` <!-- local y=13 vol=1 -->
- `mc fill stone_bricks 321 77 -587 321 77 -587` <!-- local y=13 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 13`

### Layer Y = 14 (27 cells)

**Materials this layer:** `stone_bricks`×13, `oak_planks`×12, `stone_brick_stairs_east`×1, `oak_fence`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill oak_fence 320 78 -590 320 78 -590` <!-- local y=14 vol=1 -->
- `mc fill oak_planks 322 78 -593 322 78 -592` <!-- local y=14 vol=2 -->
- `mc fill oak_planks 318 78 -588 318 78 -587` <!-- local y=14 vol=2 -->
- `mc fill oak_planks 322 78 -588 323 78 -588` <!-- local y=14 vol=2 -->
- `mc fill oak_planks 317 78 -592 318 78 -592` <!-- local y=14 vol=2 -->
- `mc fill oak_planks 322 78 -587 322 78 -587` <!-- local y=14 vol=1 -->
- `mc fill oak_planks 317 78 -588 317 78 -588` <!-- local y=14 vol=1 -->
- `mc fill oak_planks 323 78 -592 323 78 -592` <!-- local y=14 vol=1 -->
- `mc fill oak_planks 318 78 -593 318 78 -593` <!-- local y=14 vol=1 -->
- `mc fill stone_brick_stairs_east 320 78 -591 320 78 -591` <!-- local y=14 vol=1 -->
- `mc fill stone_bricks 319 78 -593 321 78 -593` <!-- local y=14 vol=3 -->
- `mc fill stone_bricks 319 78 -587 321 78 -587` <!-- local y=14 vol=3 -->
- `mc fill stone_bricks 317 78 -591 317 78 -589` <!-- local y=14 vol=3 -->
- `mc fill stone_bricks 323 78 -591 323 78 -589` <!-- local y=14 vol=3 -->
- `mc fill stone_bricks 319 78 -591 319 78 -591` <!-- local y=14 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 14`

### Layer Y = 15 (35 cells)

**Materials this layer:** `oak_planks`×32, `oak_fence`×1, `stone_brick_stairs_north_normal`×1, `stone_bricks`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill oak_fence 320 79 -590 320 79 -590` <!-- local y=15 vol=1 -->
- `mc fill oak_planks 319 79 -586 321 79 -586` <!-- local y=15 vol=3 -->
- `mc fill oak_planks 324 79 -591 324 79 -589` <!-- local y=15 vol=3 -->
- `mc fill oak_planks 319 79 -594 321 79 -594` <!-- local y=15 vol=3 -->
- `mc fill oak_planks 317 79 -592 318 79 -592` <!-- local y=15 vol=2 -->
- `mc fill oak_planks 318 79 -593 319 79 -593` <!-- local y=15 vol=2 -->
- `mc fill oak_planks 318 79 -587 319 79 -587` <!-- local y=15 vol=2 -->
- `mc fill oak_planks 317 79 -589 317 79 -588` <!-- local y=15 vol=2 -->
- `mc fill oak_planks 322 79 -593 322 79 -592` <!-- local y=15 vol=2 -->
- `mc fill oak_planks 316 79 -591 317 79 -591` <!-- local y=15 vol=2 -->
- `mc fill oak_planks 323 79 -592 323 79 -591` <!-- local y=15 vol=2 -->
- `mc fill oak_planks 323 79 -589 323 79 -588` <!-- local y=15 vol=2 -->
- `mc fill oak_planks 322 79 -588 322 79 -587` <!-- local y=15 vol=2 -->
- `mc fill oak_planks 316 79 -590 316 79 -589` <!-- local y=15 vol=2 -->
- `mc fill oak_planks 318 79 -588 318 79 -588` <!-- local y=15 vol=1 -->
- `mc fill oak_planks 321 79 -593 321 79 -593` <!-- local y=15 vol=1 -->
- `mc fill oak_planks 321 79 -587 321 79 -587` <!-- local y=15 vol=1 -->
- `mc fill stone_brick_stairs_north_normal 319 79 -590 319 79 -590` <!-- local y=15 vol=1 -->
- `mc fill stone_bricks 319 79 -589 319 79 -589` <!-- local y=15 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 15`

### Layer Y = 16 (43 cells)

**Materials this layer:** `oak_planks`×40, `stone_bricks`×1, `oak_fence`×1, `stone_brick_stairs_west`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill oak_fence 320 80 -590 320 80 -590` <!-- local y=16 vol=1 -->
- `mc fill oak_planks 317 80 -586 323 80 -586` <!-- local y=16 vol=7 -->
- `mc fill oak_planks 324 80 -593 324 80 -587` <!-- local y=16 vol=7 -->
- `mc fill oak_planks 317 80 -594 323 80 -594` <!-- local y=16 vol=7 -->
- `mc fill oak_planks 316 80 -591 316 80 -587` <!-- local y=16 vol=5 -->
- `mc fill oak_planks 316 80 -593 318 80 -593` <!-- local y=16 vol=3 -->
- `mc fill oak_planks 323 80 -588 323 80 -587` <!-- local y=16 vol=2 -->
- `mc fill oak_planks 322 80 -593 323 80 -593` <!-- local y=16 vol=2 -->
- `mc fill oak_planks 317 80 -587 318 80 -587` <!-- local y=16 vol=2 -->
- `mc fill oak_planks 316 80 -592 317 80 -592` <!-- local y=16 vol=2 -->
- `mc fill oak_planks 322 80 -587 322 80 -587` <!-- local y=16 vol=1 -->
- `mc fill oak_planks 323 80 -592 323 80 -592` <!-- local y=16 vol=1 -->
- `mc fill oak_planks 317 80 -588 317 80 -588` <!-- local y=16 vol=1 -->
- `mc fill stone_brick_stairs_west 320 80 -589 320 80 -589` <!-- local y=16 vol=1 -->
- `mc fill stone_bricks 321 80 -589 321 80 -589` <!-- local y=16 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 16`

### Layer Y = 17 (80 cells)

**Materials this layer:** `oak_planks`×78, `stone_brick_stairs_south_normal`×1, `oak_fence`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill oak_fence 320 81 -590 320 81 -590` <!-- local y=17 vol=1 -->
- `mc fill oak_planks 317 81 -594 323 81 -592` <!-- local y=17 vol=21 -->
- `mc fill oak_planks 316 81 -588 324 81 -587` <!-- local y=17 vol=18 -->
- `mc fill oak_planks 316 81 -591 318 81 -589` <!-- local y=17 vol=9 -->
- `mc fill oak_planks 322 81 -591 324 81 -589` <!-- local y=17 vol=9 -->
- `mc fill oak_planks 317 81 -586 323 81 -586` <!-- local y=17 vol=7 -->
- `mc fill oak_planks 315 81 -593 316 81 -593` <!-- local y=17 vol=2 -->
- `mc fill oak_planks 324 81 -593 325 81 -593` <!-- local y=17 vol=2 -->
- `mc fill oak_planks 320 81 -591 321 81 -591` <!-- local y=17 vol=2 -->
- `mc fill oak_planks 324 81 -592 324 81 -592` <!-- local y=17 vol=1 -->
- `mc fill oak_planks 316 81 -592 316 81 -592` <!-- local y=17 vol=1 -->
- `mc fill oak_planks 325 81 -587 325 81 -587` <!-- local y=17 vol=1 -->
- `mc fill oak_planks 323 81 -585 323 81 -585` <!-- local y=17 vol=1 -->
- `mc fill oak_planks 317 81 -595 317 81 -595` <!-- local y=17 vol=1 -->
- `mc fill oak_planks 315 81 -587 315 81 -587` <!-- local y=17 vol=1 -->
- `mc fill oak_planks 323 81 -595 323 81 -595` <!-- local y=17 vol=1 -->
- `mc fill oak_planks 317 81 -585 317 81 -585` <!-- local y=17 vol=1 -->
- `mc fill stone_brick_stairs_south_normal 321 81 -590 321 81 -590` <!-- local y=17 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 17`

### Layer Y = 18 (53 cells)

**Materials this layer:** `oak_fence`×45, `oak_planks`×8

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill oak_fence 317 82 -586 323 82 -586` <!-- local y=18 vol=7 -->
- `mc fill oak_fence 324 82 -593 324 82 -587` <!-- local y=18 vol=7 -->
- `mc fill oak_fence 317 82 -594 323 82 -594` <!-- local y=18 vol=7 -->
- `mc fill oak_fence 316 82 -592 316 82 -587` <!-- local y=18 vol=6 -->
- `mc fill oak_fence 318 82 -591 318 82 -589` <!-- local y=18 vol=3 -->
- `mc fill oak_fence 322 82 -591 322 82 -589` <!-- local y=18 vol=3 -->
- `mc fill oak_fence 320 82 -592 320 82 -590` <!-- local y=18 vol=3 -->
- `mc fill oak_fence 319 82 -588 321 82 -588` <!-- local y=18 vol=3 -->
- `mc fill oak_fence 316 82 -593 317 82 -593` <!-- local y=18 vol=2 -->
- `mc fill oak_fence 319 82 -592 319 82 -592` <!-- local y=18 vol=1 -->
- `mc fill oak_fence 317 82 -587 317 82 -587` <!-- local y=18 vol=1 -->
- `mc fill oak_fence 323 82 -593 323 82 -593` <!-- local y=18 vol=1 -->
- `mc fill oak_fence 323 82 -587 323 82 -587` <!-- local y=18 vol=1 -->
- `mc fill oak_planks 315 82 -593 315 82 -593` <!-- local y=18 vol=1 -->
- `mc fill oak_planks 315 82 -587 315 82 -587` <!-- local y=18 vol=1 -->
- `mc fill oak_planks 317 82 -585 317 82 -585` <!-- local y=18 vol=1 -->
- `mc fill oak_planks 323 82 -585 323 82 -585` <!-- local y=18 vol=1 -->
- `mc fill oak_planks 323 82 -595 323 82 -595` <!-- local y=18 vol=1 -->
- `mc fill oak_planks 317 82 -595 317 82 -595` <!-- local y=18 vol=1 -->
- `mc fill oak_planks 325 82 -593 325 82 -593` <!-- local y=18 vol=1 -->
- `mc fill oak_planks 325 82 -587 325 82 -587` <!-- local y=18 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 18`

### Layer Y = 19 (8 cells)

**Materials this layer:** `oak_planks`×8

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill oak_planks 315 83 -593 315 83 -593` <!-- local y=19 vol=1 -->
- `mc fill oak_planks 315 83 -587 315 83 -587` <!-- local y=19 vol=1 -->
- `mc fill oak_planks 317 83 -585 317 83 -585` <!-- local y=19 vol=1 -->
- `mc fill oak_planks 323 83 -585 323 83 -585` <!-- local y=19 vol=1 -->
- `mc fill oak_planks 323 83 -595 323 83 -595` <!-- local y=19 vol=1 -->
- `mc fill oak_planks 317 83 -595 317 83 -595` <!-- local y=19 vol=1 -->
- `mc fill oak_planks 325 83 -593 325 83 -593` <!-- local y=19 vol=1 -->
- `mc fill oak_planks 325 83 -587 325 83 -587` <!-- local y=19 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 19`

### Layer Y = 20 (56 cells)

**Materials this layer:** `stone_brick_slab`×12, `stone_bricks`×8, `oak_planks`×8, `stone_brick_stairs_east`×7, `stone_brick_stairs_north_normal`×7, `stone_brick_stairs_south_normal`×7, `stone_brick_stairs_west`×7

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill oak_planks 315 84 -593 315 84 -593` <!-- local y=20 vol=1 -->
- `mc fill oak_planks 315 84 -587 315 84 -587` <!-- local y=20 vol=1 -->
- `mc fill oak_planks 317 84 -585 317 84 -585` <!-- local y=20 vol=1 -->
- `mc fill oak_planks 323 84 -585 323 84 -585` <!-- local y=20 vol=1 -->
- `mc fill oak_planks 323 84 -595 323 84 -595` <!-- local y=20 vol=1 -->
- `mc fill oak_planks 317 84 -595 317 84 -595` <!-- local y=20 vol=1 -->
- `mc fill oak_planks 325 84 -593 325 84 -593` <!-- local y=20 vol=1 -->
- `mc fill oak_planks 325 84 -587 325 84 -587` <!-- local y=20 vol=1 -->
- `mc fill stone_brick_slab 324 84 -596 324 84 -596` <!-- local y=20 vol=1 -->
- `mc fill stone_brick_slab 314 84 -586 314 84 -586` <!-- local y=20 vol=1 -->
- `mc fill stone_brick_slab 326 84 -594 326 84 -594` <!-- local y=20 vol=1 -->
- `mc fill stone_brick_slab 316 84 -584 316 84 -584` <!-- local y=20 vol=1 -->
- `mc fill stone_brick_slab 325 84 -585 325 84 -585` <!-- local y=20 vol=1 -->
- `mc fill stone_brick_slab 324 84 -584 324 84 -584` <!-- local y=20 vol=1 -->
- `mc fill stone_brick_slab 325 84 -595 325 84 -595` <!-- local y=20 vol=1 -->
- `mc fill stone_brick_slab 314 84 -594 314 84 -594` <!-- local y=20 vol=1 -->
- `mc fill stone_brick_slab 326 84 -586 326 84 -586` <!-- local y=20 vol=1 -->
- `mc fill stone_brick_slab 315 84 -585 315 84 -585` <!-- local y=20 vol=1 -->
- `mc fill stone_brick_slab 315 84 -595 315 84 -595` <!-- local y=20 vol=1 -->
- `mc fill stone_brick_slab 316 84 -596 316 84 -596` <!-- local y=20 vol=1 -->
- `mc fill stone_brick_stairs_east 326 84 -593 326 84 -587` <!-- local y=20 vol=7 -->
- `mc fill stone_brick_stairs_north_normal 317 84 -596 323 84 -596` <!-- local y=20 vol=7 -->
- `mc fill stone_brick_stairs_south_normal 317 84 -584 323 84 -584` <!-- local y=20 vol=7 -->
- `mc fill stone_brick_stairs_west 314 84 -593 314 84 -587` <!-- local y=20 vol=7 -->
- `mc fill stone_bricks 325 84 -594 325 84 -594` <!-- local y=20 vol=1 -->
- `mc fill stone_bricks 315 84 -586 315 84 -586` <!-- local y=20 vol=1 -->
- `mc fill stone_bricks 316 84 -585 316 84 -585` <!-- local y=20 vol=1 -->
- `mc fill stone_bricks 324 84 -585 324 84 -585` <!-- local y=20 vol=1 -->
- `mc fill stone_bricks 315 84 -594 315 84 -594` <!-- local y=20 vol=1 -->
- `mc fill stone_bricks 325 84 -586 325 84 -586` <!-- local y=20 vol=1 -->
- `mc fill stone_bricks 316 84 -595 316 84 -595` <!-- local y=20 vol=1 -->
- `mc fill stone_bricks 324 84 -595 324 84 -595` <!-- local y=20 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 20`

### Layer Y = 21 (40 cells)

**Materials this layer:** `stone_bricks`×12, `stone_brick_stairs_east`×7, `stone_brick_stairs_north_normal`×7, `stone_brick_stairs_south_normal`×7, `stone_brick_stairs_west`×7

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill stone_brick_stairs_east 325 85 -593 325 85 -587` <!-- local y=21 vol=7 -->
- `mc fill stone_brick_stairs_north_normal 317 85 -595 323 85 -595` <!-- local y=21 vol=7 -->
- `mc fill stone_brick_stairs_south_normal 317 85 -585 323 85 -585` <!-- local y=21 vol=7 -->
- `mc fill stone_brick_stairs_west 315 85 -593 315 85 -587` <!-- local y=21 vol=7 -->
- `mc fill stone_bricks 324 85 -587 324 85 -586` <!-- local y=21 vol=2 -->
- `mc fill stone_bricks 316 85 -594 317 85 -594` <!-- local y=21 vol=2 -->
- `mc fill stone_bricks 323 85 -594 324 85 -594` <!-- local y=21 vol=2 -->
- `mc fill stone_bricks 316 85 -587 316 85 -586` <!-- local y=21 vol=2 -->
- `mc fill stone_bricks 324 85 -593 324 85 -593` <!-- local y=21 vol=1 -->
- `mc fill stone_bricks 317 85 -586 317 85 -586` <!-- local y=21 vol=1 -->
- `mc fill stone_bricks 323 85 -586 323 85 -586` <!-- local y=21 vol=1 -->
- `mc fill stone_bricks 316 85 -593 316 85 -593` <!-- local y=21 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 21`

### Layer Y = 22 (32 cells)

**Materials this layer:** `stone_brick_stairs_east`×7, `stone_brick_stairs_north_normal`×7, `stone_brick_stairs_south_normal`×7, `stone_brick_stairs_west`×7, `stone_bricks`×4

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill stone_brick_stairs_east 324 86 -593 324 86 -587` <!-- local y=22 vol=7 -->
- `mc fill stone_brick_stairs_north_normal 317 86 -594 323 86 -594` <!-- local y=22 vol=7 -->
- `mc fill stone_brick_stairs_south_normal 317 86 -586 323 86 -586` <!-- local y=22 vol=7 -->
- `mc fill stone_brick_stairs_west 316 86 -593 316 86 -587` <!-- local y=22 vol=7 -->
- `mc fill stone_bricks 317 86 -593 317 86 -593` <!-- local y=22 vol=1 -->
- `mc fill stone_bricks 323 86 -593 323 86 -593` <!-- local y=22 vol=1 -->
- `mc fill stone_bricks 323 86 -587 323 86 -587` <!-- local y=22 vol=1 -->
- `mc fill stone_bricks 317 86 -587 317 86 -587` <!-- local y=22 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 22`

### Layer Y = 23 (32 cells)

**Materials this layer:** `stone_brick_stairs_east`×5, `stone_brick_stairs_north_normal`×5, `stone_brick_stairs_south_normal`×5, `stone_brick_stairs_west`×5, `stone_brick_slab`×4, `stone_bricks`×4, `torch_facing_east`×2, `torch_facing_west`×2

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill stone_brick_slab 317 87 -593 317 87 -593` <!-- local y=23 vol=1 -->
- `mc fill stone_brick_slab 323 87 -593 323 87 -593` <!-- local y=23 vol=1 -->
- `mc fill stone_brick_slab 323 87 -587 323 87 -587` <!-- local y=23 vol=1 -->
- `mc fill stone_brick_slab 317 87 -587 317 87 -587` <!-- local y=23 vol=1 -->
- `mc fill stone_brick_stairs_east 323 87 -592 323 87 -588` <!-- local y=23 vol=5 -->
- `mc fill stone_brick_stairs_north_normal 318 87 -593 322 87 -593` <!-- local y=23 vol=5 -->
- `mc fill stone_brick_stairs_south_normal 318 87 -587 322 87 -587` <!-- local y=23 vol=5 -->
- `mc fill stone_brick_stairs_west 317 87 -592 317 87 -588` <!-- local y=23 vol=5 -->
- `mc fill stone_bricks 322 87 -592 322 87 -592` <!-- local y=23 vol=1 -->
- `mc fill stone_bricks 318 87 -592 318 87 -592` <!-- local y=23 vol=1 -->
- `mc fill stone_bricks 318 87 -588 318 87 -588` <!-- local y=23 vol=1 -->
- `mc fill stone_bricks 322 87 -588 322 87 -588` <!-- local y=23 vol=1 -->
- `mc fill torch_facing_east 321 87 -588 321 87 -588` <!-- local y=23 vol=1 -->
- `mc fill torch_facing_east 321 87 -592 321 87 -592` <!-- local y=23 vol=1 -->
- `mc fill torch_facing_west 319 87 -592 319 87 -592` <!-- local y=23 vol=1 -->
- `mc fill torch_facing_west 319 87 -588 319 87 -588` <!-- local y=23 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 23`

### Layer Y = 24 (20 cells)

**Materials this layer:** `stone_brick_slab`×4, `stone_bricks`×4, `stone_brick_stairs_east`×3, `stone_brick_stairs_north_normal`×3, `stone_brick_stairs_south_normal`×3, `stone_brick_stairs_west`×3

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill stone_brick_slab 322 88 -592 322 88 -592` <!-- local y=24 vol=1 -->
- `mc fill stone_brick_slab 318 88 -592 318 88 -592` <!-- local y=24 vol=1 -->
- `mc fill stone_brick_slab 318 88 -588 318 88 -588` <!-- local y=24 vol=1 -->
- `mc fill stone_brick_slab 322 88 -588 322 88 -588` <!-- local y=24 vol=1 -->
- `mc fill stone_brick_stairs_east 322 88 -591 322 88 -589` <!-- local y=24 vol=3 -->
- `mc fill stone_brick_stairs_north_normal 319 88 -592 321 88 -592` <!-- local y=24 vol=3 -->
- `mc fill stone_brick_stairs_south_normal 319 88 -588 321 88 -588` <!-- local y=24 vol=3 -->
- `mc fill stone_brick_stairs_west 318 88 -591 318 88 -589` <!-- local y=24 vol=3 -->
- `mc fill stone_bricks 321 88 -591 321 88 -591` <!-- local y=24 vol=1 -->
- `mc fill stone_bricks 319 88 -591 319 88 -591` <!-- local y=24 vol=1 -->
- `mc fill stone_bricks 321 88 -589 321 88 -589` <!-- local y=24 vol=1 -->
- `mc fill stone_bricks 319 88 -589 319 88 -589` <!-- local y=24 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 24`

### Layer Y = 25 (9 cells)

**Materials this layer:** `stone_brick_slab`×4, `stone_brick_stairs_east`×1, `stone_brick_stairs_north_normal`×1, `stone_bricks`×1, `stone_brick_stairs_south_normal`×1, `stone_brick_stairs_west`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill stone_brick_slab 321 89 -591 321 89 -591` <!-- local y=25 vol=1 -->
- `mc fill stone_brick_slab 319 89 -591 319 89 -591` <!-- local y=25 vol=1 -->
- `mc fill stone_brick_slab 321 89 -589 321 89 -589` <!-- local y=25 vol=1 -->
- `mc fill stone_brick_slab 319 89 -589 319 89 -589` <!-- local y=25 vol=1 -->
- `mc fill stone_brick_stairs_east 321 89 -590 321 89 -590` <!-- local y=25 vol=1 -->
- `mc fill stone_brick_stairs_north_normal 320 89 -591 320 89 -591` <!-- local y=25 vol=1 -->
- `mc fill stone_brick_stairs_south_normal 320 89 -589 320 89 -589` <!-- local y=25 vol=1 -->
- `mc fill stone_brick_stairs_west 319 89 -590 319 89 -590` <!-- local y=25 vol=1 -->
- `mc fill stone_bricks 320 89 -590 320 89 -590` <!-- local y=25 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 25`

### Layer Y = 26 (1 cells)

**Materials this layer:** `stone_bricks`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill stone_bricks 320 90 -590 320 90 -590` <!-- local y=26 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 26`

### Layer Y = 27 (4 cells)

**Materials this layer:** `blue_wool`×3, `stone_bricks`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill blue_wool 322 91 -590 323 91 -590` <!-- local y=27 vol=2 -->
- `mc fill blue_wool 324 91 -591 324 91 -591` <!-- local y=27 vol=1 -->
- `mc fill stone_bricks 320 91 -590 320 91 -590` <!-- local y=27 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 27`

### Layer Y = 28 (9 cells)

**Materials this layer:** `blue_wool`×8, `stone_bricks`×1

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill blue_wool 324 92 -591 326 92 -591` <!-- local y=28 vol=3 -->
- `mc fill blue_wool 321 92 -590 323 92 -590` <!-- local y=28 vol=3 -->
- `mc fill blue_wool 326 92 -590 327 92 -590` <!-- local y=28 vol=2 -->
- `mc fill stone_bricks 320 92 -590 320 92 -590` <!-- local y=28 vol=1 -->

**Verify layer:** `mc blueprint verify :hut1: --level 28`

### Layer Y = 29 (4 cells)

**Materials this layer:** `blue_wool`×4

**Bulk placement** (`mc fill` max 500 cells per call):

- `mc fill blue_wool 324 93 -591 325 93 -591` <!-- local y=29 vol=2 -->
- `mc fill blue_wool 321 93 -590 322 93 -590` <!-- local y=29 vol=2 -->

**Verify layer:** `mc blueprint verify :hut1: --level 29`

## Final verify

`mc blueprint verify :hut1:`

Large footprints truncate at `BLUEPRINT_VERIFY_MAX_CELLS_PER_CALL` (default 2000); rerun with `--level` or `--range Y1..Y2` per layer above.

## Notes

- `mc construct` / blueprint `mc repair` are **not** implemented; use fill/place/dig + verify.
- Fill boxes are greedy, not optimal; odd shapes need more `mc place`.
- **Doors:** cells are `oak_door` (no GrabCraft half/facing ids). Place one door at the **lower** world Y of each doorway (`mc place oak_door …`); upper half is automatic. Pick facing toward the outside; verify compares base id only (v1).
- Beds/ladders/stairs may need manual facing; verify uses block-id compare v1.
- Regenerate this file after plan edits: `python3 scripts/blueprint-tool.py guide hut1-guard-tower --anchor 310,65,-600`
