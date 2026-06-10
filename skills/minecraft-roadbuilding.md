---
name: minecraft-roadbuilding
description: "Plan and build a road across procedural terrain. Load when a card mentions road, corridor, path, link two anchors, road segment, road_mid, road_wp, or when navigation requires clearing/leveling/bridging a multi-segment route. Covers the doctrine of a good road, the verbs that build it, segment-by-segment workflow, curves, tunnels, bridges, and tree removal."
triggers:
  - build a road
  - road segment
  - road tier
  - road_mid
  - road_wp
  - corridor
  - clear a path
  - bridge a ravine
  - tunnel through
version: 0.1.0
status: prototype
metadata:
  hermes:
    tags: [minecraft, roadbuilding, building, navigation, hermescraft]
    category: minecraft-verb-bundle
---

# Minecraft Roadbuilding

A road connects two anchors with a **continuous, walkable surface** that
the next worker (or planner) can trust. Geometry first, terrain second,
aesthetics third.

## What a "good" road is

| Property | Target | When to relax |
|---|---|---|
| **Width** | **3 blocks** most of the way | Tighter only across tunnels/bridges where structure dictates |
| **Surface** | Cleared and **flat** within each segment | Allow ±1 Y across a transition between segments if grade is unavoidable |
| **Grade** | **Gradual** rises — prefer a long shallow ramp over a wall | Tight squeezes through ravines |
| **Surface block** | **Dirt** by default; available materials when dirt isn't on hand | Use **cobblestone** for bridges, tunnel floors, anything load-bearing or water-adjacent |
| **Surface consistency** | One material per visible stretch | A clean material handover at a structural seam (bridge ends, tunnel mouths) is fine |
| **Vertical clearance** | ≥ **3 blocks** of air above the road surface | Never below 3 — even a 2-tall ceiling clips agent navigation |
| **Tree removal** | **All** wood blocks removed | None — floating leaves with no log under them are a tell of a sloppy clear |

## Verbs — survey, shape, verify (load-bearing)

`minecraft-building.md` covers building grammar in depth; this section names
the verbs that matter for **roads specifically**, grouped by what you're
doing with them.

### Pre-build survey — read the terrain

```
mc terrain_top X Z
# block_y (top solid) + surface_y (feet, = block_y + 1) at one XZ. Cheap.
# Spam at 4-block intervals along the planned corridor to spot rises/dips
# before committing. Road verbs (clear_strip y=, level_ground target=,
# deck y=) take the block_y.

mc regions_terrain --rect X1 Z1 X2 Z2 [--expect-y N]
# Per-column top-solid survey for an entire rectangle. Returns the Y of
# the top solid block per cell, and (with --expect-y) per-cell delta from
# the target. THE survey verb for a road segment — one call gives you the
# whole grade profile.

mc nearby N
# Block + entity census around the bot. After clearing trees, run this
# with N=8 to confirm no log/wood blocks remain in the corridor band.

mc find_blocks BLOCK [RADIUS] [COUNT]
# Find specific blocks by name within radius. Use to scout hazards before
# committing a segment: `mc find_blocks water 16 8` (any water nearby?),
# `mc find_blocks lava 32 1` (any lava in striking distance?).

mc scene                    # ~10KB rich view; rare — once per segment
mc observe                  # cheaper standing classification (more often)
mc standing                 # current-cell classification only (cheapest)

mc inspect X Y Z            # exact block at one cell
mc inspect --mark NAME      # resolve a mark to coords + inspect there

mc reachable X Y Z [--range N]
# Geometry-only standability check. Returns {target_standable, target_reason,
# best_stand}. Use after building a segment to confirm the next worker can
# stand on the surface — and use best_stand to find the right end cell when
# the placement engine handed you an air-anchor.
```

### Shape the bed

```
mc level_ground X1 Z1 X2 Z2 [target=Y] [mode=median|min|max] [block=NAME] [execute=true]
# Plan a flatten on a rectangle. Dry-run by default (omit execute=true to
# read the plan first — the dry-run output is itself a useful survey).
#
# **16-column cap per call.** A 3×13 segment is 39 columns and rejects with
# OUT_OF_RANGE. Split into ≤16-column sub-rectangles (e.g. 3×4 = 12 cols):
#   mc level_ground -21 0 -19 3 target=63   # cols 1..12
#   mc level_ground -21 4 -19 7 target=63   # cols 13..24
#   mc level_ground -21 8 -19 11 target=63  # cols 25..36
# The error message shows the split suggestion; don't retry the full rect.
# - mode=min   — cut downward to the lowest cell (cut into a hill)
# - mode=max   — build up to the highest cell (bridge a shallow dip)
# - mode=median— meet in the middle (default; normal segments)
# - target=Y   — override and pick a specific Y (joining known-Y segments)
# - block=NAME — fill cells where new material is placed (default: dirt;
#                use cobblestone over water/ravines)

mc dig_pit X Z W L D [TOP_Y]
# Excavate a W×L rectangle D blocks deep. Cutting a road bed into a hill
# (target_y much lower than current surface_y), carving a culvert under a
# bridge approach.

mc dig_area X1 Y1 Z1 X2 Y2 Z2
# Bulk dig over a 3D box. Tree canopy clearance, tall-grass strips.

mc dig X Y Z          # single block — stumps, leftover logs
mc safe_dig X Y Z     # same, but pre-checks for lava/fall/suffocation hazards
                      # — prefer over plain dig when working blind in caves
                      # or near water.
```

### Build the surface and structures

```
mc fill BLOCK X1 Y1 Z1 X2 Y2 Z2 [--hollow]
# Bulk place. Surface slab, bridge deck, tunnel floor. --hollow gives a
# 1-block-thick shell — useful for tunnel walls in one call.

mc place BLOCK X Y Z
# Single block. Patch holes the bulk verbs wouldn't reach.

mc wall BLOCK X1 Y1 Z1 X2 Y2 Z2
# Vertical wall. Bridge parapets, drop-off edges, tunnel reinforcement.

mc tunnel direction length
# Drive a 1×2 tunnel — widen to 3×3 with mc fill air and floor with
# mc fill cobblestone. See "Tunnels" below.

mc build_stairs BLOCK DIRECTION LENGTH [X Y Z]
# Triangular ramp; column i is i blocks tall, so column 1 is 1 tall,
# column 2 is 2 tall, … LEN capped at 16. The bot walks up as it builds.
# Use for: short, steep approaches at segment ends (not for long grades —
# prefer level_ground there).

mc stair_up DIRECTION [LENGTH] [X Y Z] [WIDTH] [HEIGHT]
mc stair_down DIRECTION [LENGTH] [X Y Z] [WIDTH] [HEIGHT]
# Multi-cell stair cut (up) or fill (down) of arbitrary width + height.
# For a 3-wide gradual rise in a road, this is the right choice — each
# step is a 3-wide tread, so the road keeps its width up the slope.
```

### Verify in the field — confirm before handing off

```
mc verify_plot X1 Z1 X2 Z2 [--expect-y N] [--flat-max-delta N]
# Originally for farm plots; perfect for road segments. Asserts the
# rectangle is flat (within --flat-max-delta cells off target Y, default 0)
# at --expect-y. Use after each segment shape pass: a green verify_plot
# is your "segment done" signal.

mc verify region_blocks X1 Y1 Z1 X2 Y2 Z2 BLOCK [MIN_COUNT]
# Composition check. Confirms the road surface is the material you intended
# (no surprise stone mixed into a dirt stretch). For a 3-wide × 16-long
# segment at Y=80: `mc verify region_blocks X1 80 Z1 X2 80 Z2 dirt 45`
# (45 of 48 cells = 94% tolerance).

mc verify at_mark MARK [--block BLOCK] [--near N]
# Confirm a named anchor still resolves to expected block. Use to validate
# road waypoints (road_wp_1 should be dirt at the expected Y).

mc reachable X1 Y1 Z1
# Already listed under survey, but worth restating: at handoff time, run
# reachable on the segment's END cell to confirm the next worker (or the
# traveling agent) can stand there. The road earns its name by being
# walkable, not just looking right from above.

mc anchors
# List the anchors currently in scope. After building, a final mc anchors
# is a cheap log of which marks the segment connects.
```

## Target Y — derive from terrain, NOT from catalog placement

This is the #1 way road plans go wrong. Anchor coordinates in
`data/runtime/last-scenario-map.json` come from the placement engine,
which picks the *highest* standable cell in the disc — that's a great
**vantage point** (overlook) but often **above the corridor floor** by
many blocks.

**Rule:** before you commit a target Y, sample the real surface along
the corridor.

```
# Suppose the catalog anchor is (X, CATALOG_Y, Z). Don't use CATALOG_Y as
# target_y — sample the real terrain at the endpoints and each segment
# boundary along the corridor:
mc terrain_top X Z              # → block_y at the start anchor
mc terrain_top X Z+SEG          # → block_y at each segment boundary…
mc terrain_top X Z_END          # → block_y at the destination anchor

# Use the *median* or *min* of the block_y values as target_y — target_y is
# the BED block (block_y vocabulary), the same plane level_ground target=
# and clear_strip y= take. Do NOT use the surface_y field here: it's the
# feet level one above the bed, and passing it raises the road by 1.
# Never go more than 2 blocks below the median — beyond that you're
# digging a trench. Bots walk on top of the bed at target_y + 1.
```

If the catalog anchor Y is **lower** than `terrain_top` at the same XZ
(e.g. anchor Y=67, surface Y=78), the anchor is *embedded* in terrain
or *floating in a cave* — not a road target. Adjust your road's target Y
to the live surface, and document the choice in the planner card body
(so downstream cards inherit it).

## Recovery from a deep hole — use `mc escape`, not `mc pillar_up`

If a `level_ground` call ran with the wrong target Y (or you mistimed
`mc dig_pit`) and you end up at the bottom of a trench, the correct
recovery is **`mc escape`** — it reads your standing-state classifier
and picks the right strategy (pillar up with dirt for `trapped`,
sidestep for `corner`/`wedge`, dig the wall for `enclosure_inside`).

**Do not** chain `mc pillar_up N` blind. Common failure mode you'll
see in postmortems: agent does `mc pillar_up 12` (builds a 12-block
single-column tower of dirt) → tries to walk → can't, because the
tower is 1 wide → does `mc pillar_down 12` (un-builds the column,
falls back down). Net result: 20 seconds, 0 progress.

If you must climb a known height manually (e.g. you know surface is at
Y=78 and you're at Y=65 in a trench), prefer:

```
mc escape                           # FIRST — let the classifier pick
# Only if escape returns success=false or the classification is
# unhelpful:
mc stair_up north 13 X Y Z 3 3      # 3-wide, 3-tall stair you can
                                    # walk back DOWN safely. Same
                                    # construction time as pillar_up,
                                    # vastly better recovery.
```

Never `mc pillar_down` from the top of a pillar you just built — you
fall straight down. To get off a pillar safely: `mc move` to an
adjacent solid block, *then* dig the pillar from the side.

## Workflow per road segment

1. **Survey + classify the segment FIRST.** Run `mc level_ground X1 Z1 X2 Z2 target=Y` (no `execute=true`). The dry-run output is your disposition map:

   ```
   data.dispositions = { level, cut, fill_shallow, fill_deep, no_floor, preserved, unknown }
   data.dip_spans = [ { cells, n, max_depth, min_depth, suggestion } ]
   data.recommended_actions = [ "…", "…" ]
   ```

   The `suggestion` field is the disposition for each connected pocket of holes:
   - `level_caps` — `mc level_ground execute=true` will handle it (shallow ≤3, single cell).
   - `deck` — deep (>3) OR wide (≥3 connected cells). The level execute would only plant a cap over an empty cavity; structurally + visually wrong. **Reroute around it or split the segment.**
   - `reroute` — `no_floor` (≥16 deep, ravine/cliff). The deck-style bridge would require multi-segment planning. **Shift the corridor ±3 X or mark for a [BRIDGE] super-card.**

   Also do `mc inspect` on any flagged hazard cell (water, lava, structure).

2. **Adapt the plan if dispositions say so.**
   - If `summary.deck_required_n + summary.reroute_required_n == 0`: proceed to step 3 with the normal flow.
   - If `deck_required_n > 0`: pick one — **(a)** shift this segment's rectangle in X (or split into two narrower rectangles that flank the dip); **(b)** mark the segment as "deferred — needs deck primitive" and emit a [PLAN] note back to the orchestrator. Do NOT execute a `level_ground` over a deck-required span; you'd waste blocks and time on a cap.
   - If `reroute_required_n > 0`: **don't fill ravines with `mc level_ground`**. Either route the road around (shift ±3 X over a few segments to ease around the gap) or mark for a multi-segment [BRIDGE] plan.
   - When in doubt: emit a [SURVEY] note describing the obstacle and ask the orchestrator to split the segment.

3. **Clear trees and obstacles.**
   - For each tree on the corridor: `mc clear_strip X1 Z1 X2 Z2 y=Y road_mode=true` clears wood + leaves + above-bed blocks in one auto-batched call (Y = the bed's block_y, same value as level_ground's target=). The `road_mode` flag treats wood as diggable (default level/level_ground preserves it).
   - For tall grass/flowers in the path: `mc clear_strip` already covers Y..Y+height above the surface.

4. **Shape the bed.** Only run this on segments whose dispositions cleared step 2.
   - **Flat:** `mc level_ground X1 Z1 X2 Z2 mode=median block=dirt execute=true`.
   - **Cut (hill into the road):** `mc level_ground X1 Z1 X2 Z2 mode=min block=dirt execute=true`. Long shallow cut > one steep wall.
   - **Fill (shallow dip ≤3 deep):** `mc level_ground X1 Z1 X2 Z2 mode=max block=dirt execute=true`.
   - **Cut + fill (rolling terrain):** two calls — `mode=min` on the high stretch, `mode=max` on the low — meeting at a chosen target Y.

5. **Lay the surface.** If `level_ground` placed dirt for you, you're done. If you cut down to stone, top with `mc fill dirt X1 Y Z1 X2 Y Z2`.

6. **Verify.** `mc nearby 8` from segment midpoint, plus a re-survey: `mc level_ground X1 Z1 X2 Z2 target=Y` dry-run should now report `dispositions.level == columns_n` and no `dip_spans` with `suggestion != 'level_caps'`. Any residual `fill_*` or `cut` cells = corridor not done.

## Curves — rectangles that shift

The road is a sequence of **axis-aligned rectangles**, not arcs. Curves come from rectangles that shift sideways at segment boundaries.

```
start  ───────────►          ─────────►    waypoint
                  └──seg 2────┘                  ▲
                    shifts +X                    │
                    by 3 blocks                  shift +Z
                                                 by 1 block per segment
```

Doctrine for curves:
- Plan each segment as a rectangle anchored on a waypoint mark.
- At a segment boundary, shift the next rectangle by the curve delta (e.g., +3 X over 12 Z gives a ~14° turn).
- Where two rectangles overlap at the corner, **don't double-level** — the second `mc level_ground` finishing on the corner will overwrite the first cleanly.
- For tight corners (>30°): widen the corner cell to 4×4 dirt so an agent doesn't clip the edge.

## Tunnels (through hills/mountains)

When terrain rises **>4 blocks** above the road's target Y for a stretch >8 blocks long, prefer a tunnel over a cut.

1. `mc terrain_top` the corridor — find where block_y exceeds target_y + 4.
2. `mc tunnel <dir> <length>` from the segment start. Default cross-section is 1×2 — too small for a road.
3. Widen: `mc fill air X1 Y Z1 X2 Y+2 Z2` to clear a **3×3 cross-section** (3 wide, 3 tall vertical clearance).
4. Floor: `mc fill cobblestone X1 Y-1 Z1 X2 Y-1 Z2`. Stone or cobble underfoot — never dirt in a tunnel; it crumbles aesthetically and roots into the wall material.
5. Mouth: leave the entry/exit 1 segment-width wider than the tunnel itself — a sudden 1×3 hole in a hillside reads as a mineshaft, not a road.

## Bridges (over water, ravines, deep dips)

Triggered by step 1's disposition map — when `summary.deck_required_n > 0` or `summary.reroute_required_n > 0` on a candidate segment, you're in bridge territory.

**Decision order** — try cheaper options first:

1. **Reroute around (preferred).** Shift the corridor in X over the surrounding 2-3 segments to ease around the gap. A ~20° detour adds 3-5 blocks of road; a bridge adds 20+ blocks of cobblestone + tooling time. Re-survey the shifted rectangle with `mc level_ground … target=Y` — if its new dispositions clear (no deck/reroute), commit the shift.

2. **Split the segment** — narrow the rectangle so the dip falls outside. If the corridor is 3 wide and the dip is in column x=0, two parallel 1-wide rectangles at x=-1 and x=1 may both clear; the dip column becomes a "skip cell" left as natural terrain (acceptable when surrounded by clean shoulder).

3. **Deck with `mc deck`.** When neither reroute nor split works — wide-open ravine across the corridor — use the dedicated verb. It does the edge-inward BFS placement automatically (no manual "build from bank one row at a time"). Returns `unanchored[]` for cells it couldn't reach from a rim.

   ```
   mc deck X1 Z1 X2 Z2 y=Y block=cobblestone [dry_run=true]   # Y = bed block_y; bots walk at Y+1
   ```

   - **Pre-flight**: `mc inspect` the gap to confirm water/lava/dirt below — affects support placement.
   - **Dry-run first** on large spans to see `would_place` vs `unanchored` counts before committing the placements.
   - **Supports** (for spans >5 blocks): place piers with `mc fill cobblestone X Y-N Z X Y Z` every 4-6 blocks, depth N down to solid ground. The piers act as anchor seeds for `mc deck` to BFS off of.
   - **Parapets** (safety): `mc wall cobblestone X1 Y+1 Z1 X1 Y+1 Z2` on each long edge.
   - **Material consistency:** cobblestone for the whole bridge stretch; the dirt road resumes on the far side.

4. **Defer** — when the deck cap (256 cells per call) is exceeded or `unanchored.length > 0` even after manual pier placement: emit a `[DEFER]` card noting `dip_spans` coords + `suggestion='deck'` and stop. The orchestrator can route a multi-segment bridge plan in a follow-up.

The disposition output's `recommended_actions` strings already include the per-span coords and the suggestion. Use them verbatim in your [DEFER] / [SPLIT] / [REROUTE] notes — they survive across handoffs.

## Trees — remove ALL wood blocks

A tree on the corridor isn't a single block. After `mc dig` on the visible trunk, **walk around the stump position** and `mc inspect` adjacent cells. Branches and leaves that were attached to wood will decay over time, **but floating leaves are a visible flaw** — clear them now.

```
mc dig_area X1 Y_canopy Z1 X2 Y_canopy+8 Z2   # bulk-clear the canopy band
# Then sweep ground-level for stumps:
mc inspect X Y_ground Z   # at the original tree base
mc dig    X Y_ground Z   # one per remaining wood block
```

If `mc nearby 4` after the sweep reports any `oak_log` / `birch_log` / `*_wood` in the corridor, dig those too. The road is done when wood count = 0 in the corridor band.

## Field measurement — the inner verify loop

Build → survey → adjust → re-survey. Per segment, the inner loop is:

```
# 1. plan + survey (dry-run)
mc regions_terrain --rect X1 Z1 X2 Z2 --expect-y 80
# read the per-column deltas; pick mode= and target= accordingly

# 2. shape
mc level_ground X1 Z1 X2 Z2 target=80 mode=median block=dirt execute=true

# 3. verify the bed is flat
mc verify_plot X1 Z1 X2 Z2 --expect-y 80 --flat-max-delta 0
# green → continue. red → mc inspect on flagged cells, mc place / mc dig
# to fix, repeat verify_plot.

# 4. verify the surface composition
mc verify region_blocks X1 80 Z1 X2 80 Z2 dirt 45

# 5. verify reachability at the end cell (the handoff point)
mc reachable X_end 81 Z_end
# target_standable=true → segment is walkable.
# target_standable=false + best_stand returned → fix the last cell, or
# accept best_stand as the actual segment endpoint and update the waypoint.

# 6. final spot-check for leftover wood / floating leaves
mc nearby 6
# wood_count should be 0 in the corridor band.
```

This sequence is **cheap enough to run per segment** (six verbs, all
read-only except level_ground). Don't skip — a segment that "looks right"
but fails verify_plot is the same class of bug as the wheat trial-3
script that returned the right shape from the wrong source.

## Material selection by biome

The default road bed is **dirt** — cheap, abundant, fast to place. But in biomes where the world process keeps modifying exposed dirt, the road looks wrong minutes after the trial completes.

| Biome | Use | Why |
|---|---|---|
| Plains, forest, desert, savanna | `dirt` (default) | No grass spread issues outside snowy/swamp; surface stays consistent. |
| **Snowy taiga, snowy plains, ice spikes** | `cobblestone` (or `stone`) | Snowfall accumulates `snow_layer` on dirt within a few minutes (looks like +1 block bumps). Grass also spreads to exposed dirt over time. Cobblestone is biome-stable. |
| **Swamp, mangrove swamp** | `cobblestone` | Grass spread + water pooling on dirt. Cobblestone keeps the surface clean and walkable. |
| Mushroom fields, the End, nether | `cobblestone` or `stone_bricks` | Default dirt looks alien against the biome palette. Cobblestone reads as "built" rather than "grown." |

Pass the material via the `block=` arg on the road verbs:

```
mc clear_strip X1 Z1 X2 Z2 y=TARGET_Y road_mode=true block=cobblestone
mc level_ground X1 Z1 X2 Z2 target=TARGET_Y execute=true block=cobblestone
```

When the measure card classifies a segment as `passage=deck`, the deck verb ALWAYS uses cobblestone regardless of biome (bridges over water/lava are visually + structurally load-bearing).

This is the W2-NAV-020 fix from `data/postmortems/proc-nav-lab/proc-nav-1780994801/postmortem.md` — the prior trial's dirt road in snowy taiga had `snow_layer` accumulate on top within ~10 min, producing the `±1 block surface variation` the operator observed.

## Doctrine summary

- **3 wide. Flat. Dirt by default, cobblestone in snowy/swamp/regen-active biomes. Cobble for bridges & tunnels.**
- **Gradual over steep.** A long ramp reads as a road; a wall reads as a building.
- **All wood blocks gone.** Floating leaves = unfinished. `mc clear_strip road_mode=true` auto-cleans the canopy connected to any trunk it touches; you usually don't need a separate `mc fell_tree` pass.
- **3-block vertical clearance.** Always.
- **Curves are shifted rectangles.** Plan segment-by-segment, not arc-by-arc.
- **Surface consistency in each visible stretch.** A material change at a structural seam is the only acceptable seam.
- **Survey with `mc corridor_sample` (one call), not N × `mc terrain_top`.** The batch verb returns the same aggregate (median/min/max/delta) in one round-trip. **Foliage is excluded by default** — canopy doesn't register as ground, no flag needed. Pass `exclude_foliage=false` only when you specifically want to inspect leaves/snow_layer as a topY.
- **Verify with `mc level_ground target=<corridor_median>` dispositions sweep** — checks the bed is actually flat, not just that anchors are reachable. (Foliage exclusion is the default; explicit `exclude_foliage=true` is redundant but harmless.)

For wider building grammar (materials, hollow shells, sectional fills,
verification patterns), see [minecraft-building.md](minecraft-building.md).
