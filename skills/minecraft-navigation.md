---
name: minecraft-navigation
description: "Navigation and exploration in Minecraft — ore Y-levels, finding structures/biomes/caves, strip mining, coordinate system, marks, hazard survey. Load when exploring, mining at specific depths, looking for villages/structures, or navigating underground."
triggers:
  - minecraft navigate
  - find biome
  - minecraft explore
  - find village
  - find cave
  - ore y level
  - diamond level
  - strip mine
  - lost underground
  - find structure
version: 4.0.0
---

# Minecraft Navigation

## Commands

```
# Walking
mc move X Y Z              # smart non-destructive nav (handles doors/gates)
mc goto X Y Z              # raw pathfinder — open spaces only, no door handling
mc goto_near X Y Z [r]     # pathfind near position (default range: 2)
mc through GX GY GZ        # explicit door/gate: opens, walks, closes behind
mc follow PLAYER           # follow a player continuously
mc stop                    # stop movement
mc escape                  # last-resort unstuck (sidestep / pillar / wait by classification)
mc flee [X Y Z]            # combat retreat (see minecraft-combat)

# Vertical
mc stair_down DIR [LEN=12] [X Y Z] [W=1 H=3]   # dig descending staircase
mc stair_up DIR [LEN=12] [X Y Z] [W=1 H=3]     # dig ascending, places floor over voids
mc pillar_step [BLK] [N=1]   # climb up by placing blocks underfoot
mc pillar_down [N=12]        # descend a pillar by mining the block underfoot

# Survey + look
mc status                  # current position, biome, dimension, HP, food
mc map [R]                 # compact ASCII map (default R=12, max 16)
mc nearby [R=32]           # blocks + entities within R
mc scene                   # visible landmarks + entities in vision range
mc look_at X Y Z           # face a position (no movement)
mc find_blocks BLOCK [R]   # locate blocks of TYPE (no mining)
mc terrain_top X Z [R=0]   # highest non-air, non-fluid Y in column(s)
mc reachable X Y Z         # standability pre-flight; returns best_stand if target blocked
mc scout [--block BLOCK]   # hazard survey: lava, falling columns, hostiles in radius

# Marks (your in-bot waypoint memory)
mc mark NAME [NOTE]        # save current position as a named mark
mc marks                   # list all marks
mc go_mark NAME            # walk to a saved mark
mc unmark NAME             # delete a mark

# Recovery
mc deathpoint              # walk to most recent death location
mc sleep                   # use a nearby bed (resets respawn point)
```

## Picking the right movement verb

**Default: `mc move`.** It handles doors automatically, never destroys infrastructure, and surfaces a structured `NAV_BLOCKED` with the reason if it fails.

| Situation | Use |
|---|---|
| General navigation (might pass a door, may not) | `mc move X Y Z` |
| Open terrain, no buildings | `mc goto X Y Z` (slightly faster, no door scan) |
| **Water in the way (BOAT_REQUIRED)** | **`mc sail_to X Y Z`** — ferry service, see "Water journeys" below |
| You know the door coords and want a single explicit pass | `mc through GX GY GZ` |
| Target may not be standable (a wall corner, a roof edge) | `mc reachable X Y Z` first → use the returned `best_stand` |
| Need to clear a path through terrain | `mc tunnel` or `mc dig_area` (see [minecraft-survival](minecraft-survival)) |
| Stuck (corner / wedge / on-pillar / in water) | `mc escape` |

## Water journeys — `mc sail_to`

**🚨 RULE: When `mc bg_goto` or `mc move` returns `BOAT_REQUIRED`,
call `mc sail_to X Y Z` — DO NOT manually chain
`mc board` / `mc sail` / `mc disembark`.**

`mc sail_to` is one transactional call that:
1. BFS-validates the water route from your current position to target
   (filters out 1-cell ponds, 1-deep shallows, and 1-block bridges)
2. Walks you to the entry shore
3. Places a boat from your inventory at the entry water
4. Mounts you
5. Sails the validated route
6. Disembarks at the destination shore
7. Walks the final land leg

**Resumable**: if interrupted mid-journey (boat broken, knocked off),
call `mc sail_to X Y Z` again. The body detects current state and
resumes — already-mounted bots keep their boat and re-route from
current position.

**Refusal codes and what to do:**

| Code | Meaning | Next action |
|---|---|---|
| `NO_BOAT` | No boat in inventory | `mc craft oak_boat` (needs 5 planks) |
| `NO_NAVIGABLE_ROUTE` + `POND_DISCONNECTED` | You're in a tiny pond | **`mc bg_goto <coast coords>` to a real shore, THEN `mc sail_to` again** |
| `NO_NAVIGABLE_ROUTE` + `WATER_TOO_SHALLOW` | Water is 1 deep, boat would ground | Find deeper water nearby |
| `NO_NAVIGABLE_ROUTE` + `TARGET_NOT_REACHABLE_FROM_WATER` | Destination has no water shore | `mc bg_goto` for the land approach |
| `NO_NAVIGABLE_ROUTE` + `NO_WATER_ROUTE` | No navigable water near you | Walk to a coast first |

**Always follow the `next_action_hint` in the error envelope.** The
body has already analyzed the situation; the hint is the
authoritative next step, not a suggestion.

The four old verbs (`mc place_boat`, `mc board`, `mc sail`,
`mc disembark`) are **low-level recovery hatches only.** Don't chain
them as a first move — that's the broken pattern `mc sail_to`
replaced.

**Never** rely on `mc goto` to "find a way through" closed doors or walls — it cannot. The bot will fail with `NAV_BLOCKED`, not break things. To modify the world, use an explicit destructive verb (`mc dig`, `mc safe_dig`, `mc tunnel`, `mc dig_area`).

When `mc move` fails with `NAV_BLOCKED`, the error includes `observed_state.nearby_doors` — useful if the auto-detection picked wrong and you want to retry with `mc move X Y Z --door GX GY GZ`.

## Reachability pre-flight

Before a long walk to an exotic coord (top of a tree, edge of a cliff, corner of a wall), check it's standable:

```
mc reachable 120 75 -45
# → { target_standable: false, target_reason: "head_blocked",
#     best_stand: { x: 120, y: 75, z: -44, distance: 1.0 } }
mc goto_near 120 75 -44
```

`mc reachable` is geometry-only — it doesn't verify a path exists, just that the destination is a place a bot can occupy.

## Vertical movement — never dig straight down

Vertical mining is dangerous (lava, deep caves, suffocation). Use staircases for routine descent; pillars only when you need height.

| Want to | Use |
|---|---|
| Surface → mining depth | `mc stair_down DIR LEN` (default LEN=12) |
| Deep mine → surface | `mc stair_up DIR LEN` (places floor over voids) |
| Climb 1–8 blocks to reach something high | `mc pillar_step dirt 5` (dirt is cheap to re-dig) |
| Stuck on top of a 1×1 pillar with no walkable neighbours | `mc pillar_down` — mines block-underfoot, drops 1, repeats |

`mc move` refuses to plan from a 1×1 pillar — it surfaces `BOT_ON_PILLAR` with `mc pillar_down N` as the next-action hint. Always descend the pillar BEFORE trying to navigate from it.

## Coordinate system

- **X**: East (+) / West (−)
- **Y**: Height (−64 = bedrock, 64 = sea level, 320 = sky limit)
- **Z**: South (+) / North (−)
- **Cardinal DIR** (for stair_*, build_stairs, fence --gate): `north` (−Z), `south` (+Z), `east` (+X), `west` (−X).

Always check `mc status` for current position before navigating.

## Finding resources by Y-level

```
Diamonds:       Y = −64 to −1    (best at Y = −59)
Iron:           Y = −64 to 72    (best at Y = 16)
Gold:           Y = −64 to 32    (best at Y = −16)
Coal:           Y = 0 to 192     (best at Y = 96)
Copper:         Y = −16 to 112   (best at Y = 48)
Lapis:          Y = −64 to 64    (best at Y = 0)
Redstone:       Y = −64 to 16    (best at Y = −59)
Emerald:        Y = −16 to 320   (mountain biomes only)
Ancient Debris: Y = 8 to 119     (best at Y = 15, Nether only)
```

## Finding structures

Structures don't have search commands, but strategies:

- **Village**: explore plains, savanna, desert, taiga biomes; look for path blocks.
- **Cave/Ravine**: `mc find_blocks cave_air 64` near Y=40–60, or surface-scan for openings.
- **Stronghold**: throw eye of ender, follow direction.
- **Nether Fortress**: explore the Nether, tends to be along Z axis.
- **Ocean Monument**: find a deep ocean biome, look for the dark prismarine structure.

## Exploration strategies

### Map-driven scan

`mc map 16` gives you the densest cheap picture of what's around. Use it before committing to a long walk.

```
mc status                      # current position
mc map 16                      # see terrain + landmarks ±16
mc goto X Y Z                  # move ~30 blocks in the chosen direction
mc map 16                      # re-check
# repeat until you spot the feature
```

Combine with `mc nearby 32` (counts) and `mc find_blocks BLOCK 64` (positions) when looking for something specific.

### Strip mining (for ores)

```
mc stair_down north 60         # descend safely from surface to ~Y=−59
mc scout --block diamond_ore   # hazard + target survey at this level (lava? candidates?)
mc tunnel north 32             # 2-high 1-wide branch
mc find_blocks diamond_ore 16  # check what the branch revealed
```

At depth, prefer `mc safe_dig X Y Z` over `mc dig X Y Z` — it refuses to dig if it would expose lava, drop the bot, or release a falling-block column. `mc tunnel` and `mc dig_area` already use the same hazard pre-check internally.

### Cave exploration

1. `mc scout` first — lists lava + hostile mobs in radius, so you know what you're walking into.
2. Bring torches (lots). Place torches on RIGHT wall going in (then follow torches on LEFT to find your way out).
3. `mc status` frequently — watch HP, food, and the alerts feed.
4. `mc safe_dig` for any wall removal at depth.

## Saving locations (marks)

The bot has built-in waypoint memory. Use it instead of remembering coords.

```
mc mark home "base camp"       # save current position
mc mark mine_entrance          # bare mark
mc marks                       # list everything you've marked
mc go_mark home                # walk back
mc unmark old_camp             # remove an outdated one
```

Good things to mark:
- `home` — your base
- `mine_entrance` — top of your stair_down
- `materials_chest`, `food_chest`, `tools_chest` — for `mc deposit/withdraw @MARK`
- `wheat_farm` and other infrastructure (see [minecraft-survival](minecraft-survival) worked examples)
- `nether_portal` — both sides
- A productive ore vein you didn't fully clear

Set your respawn point with `mc sleep` from a bed near `home` so death recoveries stay short. After a death, `mc deathpoint` walks to where you fell to pick up drops (if they haven't despawned — ~5 min).
