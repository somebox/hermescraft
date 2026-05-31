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
mc status                         # self: position, holding, supplies
mc scene                          # world: blocks in view
mc nearby [R]                     # blocks + entities nearby
mc map [R]                        # compact ASCII map of the area
mc terrain_top X Z [R]            # highest non-air Y at a column (find flat ground)
mc reachable X Y Z                # standability pre-flight; returns best_stand alternative
mc find_blocks BLOCK [R]          # locate material sources
mc mark NAME [NOTE]               # save the build site (e.g. mc mark cabin_site)

# Navigation around the build site
mc move X Y Z [--near N]          # smart non-destructive nav (handles doors)
mc move @mark                     # return to a saved site mark
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

## Building from a blueprint

When a construct card includes `plan_id` and a bound region (`plan=` on the sign), use the blueprint library instead of guessing block lists:

```bash
mc blueprint layer <plan_id> --y N       # expected cells for local layer N
mc blueprint verify :region: --level N   # ok / missing / wrong / extra
```

Fix mismatches with `mc place`, `mc dig`, and bulk verbs; re-verify before marking the card done. Full workflow: skill [`minecraft-blueprints.md`](minecraft-blueprints.md). `mc construct` is not available yet (Phase 2c).

## Before you build ANYTHING

1. **Check memory** for building lessons the player taught you.
2. **Ask the player** where they want it if they didn't specify.
3. **Find flat ground** — `mc map 16` for an overview; `mc terrain_top X Z 8` to compare column heights over a small radius.
4. **Verify standability** at the corners — `mc reachable X Y Z` returns `best_stand` if a corner is buried/blocked.
5. **Plan it out** — tell the player your plan in chat before placing blocks.
6. **Mark the site** — `mc mark cabin_site` so you can `mc move @cabin_site` after gathering.
7. **Clear + level** — `mc dig` trees / tall grass, then `mc level X1 Z1 X2 Z2 Y` over the footprint.

## Vertical builds (structure vs scaffold)

When the deliverable is **taller than you can reach from the ground**, use **dirt only** for temporary scaffold — **outside** the structure footprint. Never put scaffold dirt inside deliverable cells. Cobble (or other deliverable) goes only on the planned footprint.

Before kanban complete: **`mc pillar_down`** any scaffold you climbed, then **`mc dig` every dirt block you placed**. W6-T4-class cards fail if any dirt remains in the work zone.

Two valid strategies (pick based on footprint and reach; both must end with **zero scaffold dirt**):

### A — Sectional (access per zone)

Use when the footprint is **wider than one reach arc** (e.g. 2×2) or you want to finish one column/row before moving scaffold.

1. Pick a scaffold column **off footprint** (e.g. x=109 while structure is x=110..111).
2. **`mc pillar_up dirt N`** only on that column until you can **`place`** the cells you need at that height.
3. **`mc pillar_down`** on that scaffold until feet are on ground or a safe stand.
4. **Move scaffold site** if needed (new dirt column at x=112, etc.) and repeat for other cells/heights.
5. **`mc dig`** all dirt from every sectional column when done.

Pros: fewer blocks in the air at once; easier to reason about one corner at a time. Cons: more up/down cycles; easy to forget a remote dirt column — **`mc scene`** before closeout.

### B — Level-by-level (scaffold rises with the work)

Use when you can **`place` the whole footprint for one Y** from a single scaffold position each layer.

1. Scaffold column off footprint. From ground, place **all deliverable blocks at y=65** (or first layer) that you can reach.
2. **`mc pillar_up dirt 1`** (or one step via `pillar_up_safe`) on the **scaffold column only** — one dirt block per layer, not on the structure.
3. Place **all footprint cells at the next y**. Repeat: one dirt step up on scaffold → place full layer.
4. When the top layer is placed, **`mc pillar_down`** the full scaffold height in one column.
5. **`mc dig`** any remaining dirt (should be none if you descended cleanly and mined the column).

Pros: structure “grows” evenly; one primary scaffold column. Cons: must not place dirt on footprint; if you pillar on structure by mistake you fail strict site checks.

**Do not** leave orphan columns for “later.” **Do not** use `pillar_up` to scout — use `mc scene` / `mc reachable X Y Z`. Escape and BOT_ON_PILLAR: **`minecraft-navigation`**.

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
