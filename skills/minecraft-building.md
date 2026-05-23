---
name: minecraft-building
description: "Build structures in Minecraft — houses, cabins, fences, shelters, walls, roofs with actual aesthetics. Load when placing multiple blocks, building anything, constructing farms/pens/walls, or when the player asks to build. Covers systematic block placement, material combos, roof styles, and building workflow."
triggers:
  - minecraft build
  - build a house
  - minecraft construction
  - build shelter
  - log cabin
  - place blocks
  - build wall
  - build fence
  - build farm
  - build pen
version: 4.3.0
---

# Minecraft Building — With Taste

## Commands

```
# Bulk-placement primitives (auto-equip materials; transactional)
mc wall BLOCK X1 Y1 Z1 X2 Y2 Z2          # vertical wall between two corners
mc fill BLOCK X1 Y1 Z1 X2 Y2 Z2 [--hollow]  # fill an axis-aligned box
mc fence BLOCK X1 Z1 X2 Z2 [--gate DIR]  # fence rectangle + optional gate
mc level X1 Z1 X2 Z2 Y [BLOCK]           # flatten an area to target Y
mc path X1 Z1 X2 Z2 [Y]                  # convert dirt/grass to dirt_path (needs shovel)
mc dig_pit X Z W L D [TOP_Y]             # dig a W×L×D pit
mc build_stairs BLOCK DIR LEN [X Y Z]    # ascending triangular ramp

# Single-block primitives (finishing work)
mc place BLOCK X Y Z              # place block at position (torches, decoration)
mc dig X Y Z                      # remove block at position
mc safe_dig X Y Z                 # dig with lava/fall/suffocation pre-check
mc collect BLOCK N                # gather materials
mc craft ITEM [N]                 # craft building blocks

# Doors and gates
mc through GX GY GZ [DX DY DZ]    # open door/gate, walk through, close behind
mc interact X Y Z                 # toggle a door/gate (without traversal)

# Site prep + survey
mc status                         # position + inventory
mc nearby [R]                     # blocks + entities nearby
mc map [R]                        # compact ASCII map of the area
mc terrain_top X Z [R]            # highest non-air Y at a column (find flat ground)
mc reachable X Y Z                # standability pre-flight; returns best_stand alternative
mc find_blocks BLOCK [R]          # locate material sources
mc mark NAME [NOTE]               # save the build site (e.g. mc mark cabin_site)

# Navigation around the build site
mc move X Y Z                     # smart non-destructive nav (handles doors)
mc goto_near X Y Z [r]            # pathfind near a position
```

## Prefer the bulk-placement verbs

For multi-block work, use the high-level verbs — they're transactional
(action-contract responses with placed/skipped/failed counts), auto-equip
the right item, and won't half-complete on a small inventory shortfall.
A loop of `mc place` calls is slower, error-prone, and harder to debug.

| Goal | Use |
|---|---|
| 5×5 fenced animal pen with gate | `mc fence oak_fence 0 0 4 4 --gate south` |
| 3-block-tall cobble wall | `mc wall cobblestone X1 Y1 Z1 X2 Y2 Z2` |
| Solid floor / roof slab | `mc fill oak_planks X1 Y Z1 X2 Y Z2` |
| Hollow stone box (room shell) | `mc fill stone X1 Y1 Z1 X2 Y2 Z2 --hollow` |
| Flatten a building site | `mc level X1 Z1 X2 Z2 Y` |
| Path through a garden | `mc path X1 Z1 X2 Z2` (need shovel) |
| Stairs out of a foundation pit | `mc build_stairs cobblestone east 4` |
| Torches / decoration / single blocks | `mc place BLOCK X Y Z` |

## Before you build ANYTHING

1. **Check memory** for building lessons the player taught you.
2. **Ask the player** where they want it if they didn't specify.
3. **Find flat ground** — `mc map 16` for an overview; `mc terrain_top X Z 8` to compare column heights over a small radius.
4. **Verify standability** at the corners — `mc reachable X Y Z` returns `best_stand` if a corner is buried/blocked.
5. **Plan it out** — tell the player your plan in chat before placing blocks.
6. **Mark the site** — `mc mark cabin_site` so you can `mc go_mark cabin_site` after gathering.
7. **Clear + level** — `mc dig` trees / tall grass, then `mc level X1 Z1 X2 Z2 Y` over the footprint.

## Golden rules

- **Build on the ground.** Not in trees. Not floating. On solid flat ground.
- **Crafting tables, furnaces, chests go INSIDE buildings**, not scattered in the wilderness.
- **Use multiple materials** — variety is what makes builds look good. All-planks = ugly.
- **Add depth** — overhangs, different heights; avoid plain boxes.
- **Foundations first** — lay a cobblestone/stone base perimeter before walls.
- **Sloped roof** — use stairs for the pitch, slabs for overhangs. Flat roof with no overhang reads as unfinished.
- **Light it up** — `mc place torch X Y Z` inside AND outside (every ~6 blocks) to prevent mob spawns at night.
- **Clear obstacles first** — trees, tall grass, uneven ground.
- **Right-size it** — a 5×5 box looks empty; a 20×20 mansion you can't furnish looks abandoned. Aim ~8–12 blocks per side for a starter house.

## Log Cabin Style

Materials needed:
- Oak/spruce logs (frame + pillars): ~40-60
- Stripped logs or planks (walls): ~80-120
- Cobblestone or stone bricks (foundation + chimney): ~40-60
- Glass panes (windows): 8-12
- Stairs (roof): ~40-60
- Slabs (details): ~20
- Door: 1
- Torches/lanterns: 8+
- Fences (porch railing): ~10

Build order:
1. Clear + level a ~12x10 area on the ground
2. Lay cobblestone foundation (1 block deep perimeter)
3. Place log pillars at corners + every 3-4 blocks (3-4 high)
4. Fill walls between pillars with planks (leave gaps for windows + door)
5. Place glass panes for windows (2 wide, 1-2 high)
6. Build roof with stairs — peaked/A-frame looks best
7. Add chimney on one end with cobblestone/bricks going above roofline
8. Place door
9. Interior: crafting table, furnace, chests, bed, torches
10. Exterior: fence porch/railing, flower pots, path with gravel/cobble

## Material Combos That Look Good

```
Rustic cabin:   oak_log frame + spruce_planks walls + cobblestone base + stone_brick chimney
Medieval:       stone_bricks + dark_oak_planks + cobblestone + oak fences
Modern:         quartz + glass + concrete + stone slabs  
Cozy cottage:   birch_planks + stripped_birch_log + flowering_azalea + lanterns
Desert:         sandstone + smooth_sandstone + red_sandstone accents
```

## Roof Techniques

```
A-frame:     stairs ascending from both sides meeting at peak
Flat+border: slab roof with stair border overhang  
Hip roof:    stairs on all 4 sides converging
Overhang:    extend roof 1 block past walls using stairs/slabs
```

## Worked example: 7×5 plank floor at Y=64 starting at (100, 200)

Don't loop `mc place` — break the build into regions and pick the right verb:

```
mc level 100 200 106 204 64                       # flatten the footprint
mc fill oak_planks 100 64 200 106 64 204          # lay the floor in one call
```

For a four-wall room shell:
```
mc fill stone 100 65 200 106 68 204 --hollow      # hollow stone box, 4 tall
mc place oak_door 103 65 200                      # door on the south face
mc place torch 103 67 202                         # interior light
```

## Emergency shelter (first night)

If night is coming and there's no time for a proper build:
1. `mc collect cobblestone 24` (or any solid block on hand).
2. Pick a spot against a hillside or wall: `mc fill cobblestone X1 Y Z1 X2 Y+2 Z2 --hollow` gives you a sealed 1-block-thick box in one call.
3. `mc place torch X Y Z` inside for light + spawn-proofing.
4. `mc sleep` if you have a bed (sets respawn) — otherwise `mc wait 600` (~dawn).
5. **Tell the player** "quick shelter for the night, we'll build properly tomorrow."
