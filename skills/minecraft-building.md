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
version: 4.2.0
---

# Minecraft Building — With Taste

## Commands

```
# Building primitives (use these for bulk work — they auto-equip materials)
mc wall BLOCK X1 Y1 Z1 X2 Y2 Z2   # vertical wall between two corners
mc fence BLOCK X1 Z1 X2 Z2 [--gate DIR]  # fence enclosure with optional gate
mc level X1 Z1 X2 Z2 Y [BLOCK]    # flatten an area to target Y
mc path X1 Z1 X2 Z2 [Y]           # convert dirt/grass to dirt_path (needs shovel)
mc dig_pit X Z W L D              # dig a W×L×D pit
mc build_stairs BLOCK DIR LEN     # ascending triangular ramp the bot can climb

# Single-block primitives (for finishing work)
mc place BLOCK X Y Z              # place block at position
mc dig X Y Z                      # remove block at position
mc collect BLOCK N                # gather materials
mc craft ITEM [N]                 # craft building blocks

# Doors and gates
mc through GX GY GZ [DX DY DZ]    # open door/gate, walk through, close behind
mc interact X Y Z                 # toggle a door/gate (without traversal)

# Navigation around the build site
mc move X Y Z                     # smart non-destructive nav (handles doors)
mc goto_near X Y Z                # raw pathfinder near a position

# Survey
mc status                         # check position + inventory
mc nearby                         # see what's around you
mc find_blocks BLOCK              # find material sources
```

## Prefer the building-primitive verbs

For bulk placement, use the high-level verbs — they're transactional
(action-contract responses with placed/skipped/failed counts), auto-equip
the right item, and won't half-complete on a small inventory shortfall.
A loop of `mc place` calls is slower, error-prone, and harder to debug.

| Goal | Use |
|---|---|
| 5×5 fenced animal pen with gate | `mc fence oak_fence 0 0 4 4 --gate south` |
| 3-block-tall cobble wall | `mc wall cobblestone X1 Y1 Z1 X2 Y2 Z2` |
| Flatten a building site | `mc level X1 Z1 X2 Z2 Y` |
| Path through a garden | `mc path X1 Z1 X2 Z2` (need shovel) |
| Stairs out of a foundation pit | `mc build_stairs cobblestone east 4` |
| Single decorative block | `mc place ...` |

## Before You Build ANYTHING

1. **CHECK MEMORY** for building lessons the player taught you
2. **ASK the player** where they want it if they didn't specify
3. **Survey the terrain** — `mc status` + `mc nearby` to find flat ground
4. **Plan it out** — tell the player your plan in chat before placing blocks
5. **Clear the area** — `mc dig` to remove trees, tall grass, uneven ground
6. **Level the ground** — fill holes, remove bumps to make a flat foundation

## Golden Rules

- **BUILD ON THE GROUND.** Not in trees. Not floating. On solid flat ground.
- **Place crafting tables and furnaces INSIDE buildings**, not randomly in the wilderness
- **Use multiple materials** — variety is what makes builds look good
- **Don't just make boxes** — add depth, overhangs, different heights
- **Foundations first** — lay cobblestone/stone base before walls
- **Roof isn't flat** — use stairs for sloped roofs, slabs for overhangs
- **Light it up** — torches/lanterns inside AND outside to prevent mob spawns

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

## Common Mistakes to Avoid

- ❌ Placing crafting tables outside or in trees
- ❌ Single-material builds (all planks = ugly)
- ❌ No foundation (walls directly on grass)
- ❌ Flat roofs with no overhang
- ❌ No windows or lighting
- ❌ Ignoring terrain (building on steep hills without terracing)
- ❌ Forgetting interior furnishing
- ❌ Building too small (5x5 boxes) or way too big to fill
- ❌ Not clearing trees/obstacles first

## Systematic Placement

For walls, fences, paths, floors, ramps — use the bulk-placement verbs
(`mc wall`, `mc fence`, `mc path`, `mc level`, `mc build_stairs`). They
take corner coordinates and handle equip, place, skip-existing, and
partial-success reporting in one call.

For one-off decoration: `mc place BLOCK X Y Z` per block. Always note
your starting corner coords from `mc status` first so the layout is
intentional, not improvised.

For a 7×5 floor at Y=64 starting at (100, 200), don't loop `mc place`:
```
mc level 100 200 106 204 64        # first flatten terrain
mc fill oak_planks 100 64 200 106 64 204   # then lay the wooden floor
```
For multi-layer construction, break the build into regions and use the
right verb for each: `mc fill` for solid layers, `mc wall` for vertical
walls, `mc fence` for fence enclosures.

## Emergency Shelter (first night)

If night is coming and there's no time for a proper build:
1. `mc collect cobblestone 24` 
2. Dig into a hillside or place 3x3x3 box
3. Seal yourself in, place torch
4. Wait for dawn
5. **But tell the player** "quick shelter for the night, we'll build properly tomorrow"
