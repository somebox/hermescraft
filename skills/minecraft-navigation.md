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
version: 4.1.0
---

# Minecraft Navigation

Canonical command syntax, argument keys, and refusal → next-command matrix: [`docs/reference/mc-command-reference.md`](../docs/reference/mc-command-reference.md) (especially Section D–E for water and `BOAT_REQUIRED`). Player hitbox, jump height, bridging, trap recovery: [`docs/reference/minecraft-gameplay-mechanics.md`](../docs/reference/minecraft-gameplay-mechanics.md). Navigation refactor (move-canonical DSL, per-round brief, breadcrumbs): [`docs/specs/nav/route-precompute-context.md`](../docs/specs/nav/route-precompute-context.md). Strategic framing (taxi nav, replan on stall): [`docs/architecture/embodied-control.md`](../docs/architecture/embodied-control.md).

## Per-round route brief (`mc observe`)

When the fleet runs with **`HERMES_NAV_BRIEF=1`**, `mc observe` includes a **`nav_brief`** block (and human **`nav_brief_text`**) instead of a flat `nearby_marks` list. Each line is a copy-paste movement primitive — marks as `move <name>`, recovery as `retrace --trail`, body verbs as `pillar_up`, `dig`, etc. Tags such as `← suggested`, `⚠ blocked`, and `k=1` repair hints are computed by the bot, not guessed in the prompt.

**Doctrine:** read the brief, pick a line (usually the one with `← suggested`), run it. If that line fails, do not retry the same destination blindly — re-run `mc observe` or use `mc scene` / `mc standing` to see what changed. In **confined** mode (pit, sealed room), long strategic `move` rows may show `⚠ blocked (confined)`; use DO primitives (`pillar_up`, `stair_up`, `dig`) from the same brief instead of reasoning a path from `mc map`.

Shadow rollout (`HERMES_NAV_BRIEF=shadow`) logs the brief without showing it to the agent — ops only.

**Runtime hints:** weigh `error.next_action_hint` and observe **Suggested next commands** (`next_action_hints[]`) first — they mirror bot precedence (walk/`mc move`, safe exits, `mc check` before destructive `dig_area` / `mc tunnel`). Do not obey blindly when the hint contradicts protect-region policy, stale brief flags (`STALE_BRIEF`, `brief_refresh_required`), or your skill doctrine.

## Commands

```
# Walking (canonical target grammar on mc move)
mc move X Y Z [--near N] [--raw] [--force] [--door GX GY GZ] [--max-doors N]
mc move @MARK | mark_name | :region:[/site]   # same flags; region refs route like go_site
mc goto X Y Z              # raw pathfinder — prefer mc move --raw for the same behavior
mc goto_near X Y Z [r]     # legacy; prefer mc move X Y Z --near N (default N=2 for marks)
mc through GX GY GZ        # explicit door/gate: opens, walks, closes behind
mc follow PLAYER           # follow a player continuously
mc stop                    # stop movement
mc escape                  # last-resort unstuck (sidestep / pillar / wait by classification)
mc flee [X Y Z]            # combat retreat (see minecraft-combat)

# Vertical
mc stair_down DIR [LEN=12] [X Y Z] [W=1 H=3]   # dig descending staircase (records steps[] for retrace)
mc stair_up DIR [LEN=12] [X Y Z] [W=1 H=3]     # dig ascending, places floor over voids
mc retrace [--trail]       # back: default last stair_down trail; --trail prefers nav breadcrumbs (falls back if thin)
mc pillar_up [BLK] [N=1] [--force]   # climb N blocks (multi-block, not 1). Stops at a sky-open surface. Omit BLK to dig overhead + capture + pillar. Auto bare-hand digs the ceiling when truly trapped; --force also slow-digs stone + breaks protected blocks. Alias: pillar_step.
mc pillar_down [N=12]        # descend a pillar by mining the block underfoot

# Survey + look (CLI category: perceive — mc commands --category perceive)
mc status                  # self: position, HP, food, holding, supplies, situation if stuck
mc observe [--full]        # orchestration snapshot; may include nav_brief when enabled
mc scene                   # world: LOS blocks, entities, topology (use for surroundings / blocked)
mc map [R]                 # compact ASCII map (default R=12, max 16)
mc nearby [R=32]           # blocks + entities within R
mc look_at X Y Z           # face a position (no movement)
mc find_blocks BLOCK [R]   # locate blocks of TYPE (no mining)
mc terrain_top X Z [R=0]   # highest non-air, non-fluid Y in column(s)
mc reachable X Y Z         # standability pre-flight; returns best_stand if target blocked
mc scout [--block BLOCK]   # hazard survey: lava, falling columns, hostiles in radius

# Marks (your in-bot waypoint memory)
mc mark NAME [NOTE]        # save current position as a named mark
mc marks                   # list all marks
mc move @NAME              # preferred walk to mark (door-aware when HERMES_MOVE_RESOLVE=1)
mc go_mark NAME            # still works; same destination, legacy verb name
mc go_site :region:[/site] # region/site refs; also mc move :region:[/site]
mc unmark NAME             # delete a mark

# Recovery
mc deathpoint              # walk to most recent death location (near reach, not GoalBlock-on-mark)
mc sleep                   # use a nearby bed (resets respawn point)
```

## Picking the right movement verb

**Default: `mc move`.** It handles doors automatically, never destroys infrastructure, and surfaces a structured `NAV_BLOCKED` with the reason if it fails. Resolve marks and region sites on `move` when your profile has **`HERMES_MOVE_RESOLVE=1`** (fleet rollout flag).

| Situation | Use |
|---|---|
| General navigation (might pass a door, may not) | `mc move X Y Z` or `mc move @mark` |
| Saved mark or chest anchor | `mc move @NAME` (or `mc go_mark NAME` during migration) |
| Region / site from kanban card | `mc move :region_id:` or `mc move :region_id:/site` |
| Open terrain, explicit raw pathfinder | `mc move X Y Z --raw` (alias-era: `mc goto X Y Z`) |
| Stand near a block (chest, mark cell) | `mc move X Y Z --near 2` (alias-era: `mc goto_near … 2`) |
| **Water in the way (BOAT_REQUIRED)** | **`mc sail_to X Y Z`** — ferry service, see "Water journeys" below |
| You know the door coords and want a single explicit pass | `mc through GX GY GZ` or `mc move … --door GX GY GZ` |
| Target may not be standable (a wall corner, a roof edge) | `mc reachable X Y Z` first → use the returned `best_stand` with `mc move … --near 2` |
| Need to clear a path through terrain | `mc tunnel` or `mc dig_area` (see [minecraft-survival](minecraft-survival)) |
| Stuck (corner / wedge / on-pillar / in water) | `mc escape` |
| Just dug `mc stair_down` and need to climb back out | `mc retrace` (surface path: `mc retrace --trail` when breadcrumbs exist) |

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

## Path failed on slope, lip, or pit (outdoor)

**Traversability:** pathfinder treats **1-block** step-ups as walkable; natural slopes often need a **2-block lip** opened (`mc dig` on the upper blocking cell) or a short **`mc build_stairs BLOCK DIR LEN`** ramp (effective rise ≤2 blocks per step). Do not repeat the same `mc move` line after `NAV_BLOCKED` — read `next_action_hint` first.

**Adjacent 1-block step-up:** When the target is one block higher on a cardinal neighbor and `observed_state.target_standable` or `next_hop_suggestion` points at that cell, prefer **`mc move X Y Z`** or **`mc goto_near X Y Z range=1`**. Do not call `build_stairs`, `dig_area`, or `tunnel` for that geometry.

| Situation | Typical hint / action |
|---|---|
| Target not standable | `mc reachable` → `mc goto_near` to `best_stand`, then retry |
| `terrain_kind` `slope_*` toward target | `mc build_stairs cobblestone <dir> 4-8` in that cardinal |
| `cliff_above` or large Δy on horizontal goal | Lip dig or stairs before `mc pillar_up`; pillar only at a **anchor** column (`goto_near` first) |
| `BOT_TRAPPED` / `step_up_only` | Lip `mc dig` on `next_action_hint` coords, else `mc escape` |

Load `kanban-worker` for mandatory **`mc read_chat`** + **`mc reachable`** before retrying identical `recent[]` failures. Phase-2 automation may add `mc sculpt_path`; until then use dig + `build_stairs` per hint.

## Reachability pre-flight

Before a long walk to an exotic coord (top of a tree, edge of a cliff, corner of a wall), check it's standable:

```
mc reachable 120 75 -45
# → { target_standable: false, target_reason: "head_blocked",
#     best_stand: { x: 120, y: 75, z: -44, distance: 1.0 } }
mc move 120 75 -44 --near 2
```

`mc reachable` is geometry-only — it doesn't verify a path exists, just that the destination is a place a bot can occupy.

## Vertical movement — never dig straight down

Vertical mining is dangerous (lava, deep caves, suffocation). Use staircases for routine descent; pillars only when you need height.

| Want to | Use |
|---|---|
| Surface → mining depth | `mc stair_down DIR LEN` (default LEN=12) |
| Deep mine → surface | `mc stair_up DIR LEN` (places floor over voids) |
| Climb 1–8 blocks to reach something high | `mc pillar_up dirt 5` (dirt is cheap to re-dig) |
| Trapped underground with ceiling overhead | `mc pillar_up 20` (no block arg — digs ceiling, captures drop, pillars; auto bare-hand digs when truly trapped). Add `--force` to slow-dig stone faster / break protected blocks. Full playbook in **minecraft-mining → Underground pillar escape**. |
| Stuck on top of a 1×1 pillar with no walkable neighbours | `mc pillar_down` — mines block-underfoot, drops 1, repeats |

`mc move` refuses to plan from a 1×1 pillar — it surfaces `BOT_ON_PILLAR` with `mc pillar_down N` as the next-action hint. Always descend the pillar BEFORE trying to navigate from it.

### Pillar_up is for climbing only — not for navigation

If your goal is to **move to a horizontal coordinate**, `pillar_up` is the wrong primitive. Pillaring up just to "see" or "reach over" a wall traps you on a 1-block column from which `mc move` refuses to plan, forcing a `pillar_down` cleanup of every block you just placed. Live evidence (2026-05-27 session): 286 pillar calls vs 130 pillar_down by Mason, 390 vs **13** by Flint — workers oscillated for hours and left a trail of orphan columns across the map.

Use pillar_up when:
- you need actual height to break overhead ceiling, place something elevated, or escape a pit you've fallen into
- the bot is genuinely trapped (sealed cave, 4-wall+ceiling enclosure)

Don't use pillar_up to:
- get over a wall — `mc dig` through it, or walk around
- scout/survey — `mc map`, `mc nearby`, `mc scene`, `mc reachable` work without climbing; perception is range-capped and height rarely buys distance
- reach a destination — `mc move`, `mc stair_up`, `mc deck` / `mc place` to bridge a gap

**Observation rule:** do not `pillar_up` just to "see farther." Use only when (a) a concrete local occlusion blocks immediate planning and (b) no safer horizontal probe exists (`scene`/`map`/`reachable`, short `goto_near`, `stair_up`). If you pillar, pair `pillar_down` cleanup in the same plan.

`pillar_up` climbs the full count you ask for (e.g. `mc pillar_up 9` climbs up to 9), stopping early only when it reaches a sky-open surface or hits an obstruction it can't clear. When it does stop, read the result: it reports `placed/requested`, why it stopped, and a `next_action_hint` (often `--force` if the ceiling is stone and you're bare-handed). A climb that ends on a 1×1 column includes a `cleanup_hint` (`"mc pillar_down N"`) — descend before navigating. Placed pillar blocks are tracked in `recentPlaces`, so the bot may mine its own pillars on cleanup (no `PROTECTED_BLOCK` refusal).

## Surface cleanup — fill-from-edge doctrine

Cleanup cards (filling scattered holes, removing orphan pillars, leveling lumpy terrain) share a single shape: **arrive prepared, work the edge, never enter the damage.**

### Sense first

Before any movement at a cleanup site, get oriented:

```
mc status                          # current pos + HP + food
mc terrain_top <corner_x> <corner_z>   # what Y is the surface at?
mc map 12                          # visualize the damage shape
mc inventory                       # do you have fill material + tools?
```

These four reads decide everything that follows — the target Y for fill, whether you need to withdraw more material, and whether you're standing somewhere safe to start.

### Arrive with material in hand

A cleanup card is **not** a mining card. The worker is expected to carry fill blocks from base, not produce them on-site. Before leaving base:

- `mc inventory` to see what you already have.
- `mc chest_search <fill_chest>` (or the mark name the card body provides) so you know what's available before you withdraw.
- **Estimate need from the card's bbox**, not the full stack. A rough heuristic: count the bbox cells and assume a few blocks per cell of damage. Withdraw that plus a small surplus — not 64 by reflex. The shared chests are also draining for the peer worker; over-withdrawing leaves them blocked.
- Confirm you also carry: pickaxe (to harvest stray pillars), axe (if trees), sword + food (travel survivability).

If material runs out mid-tile, return to the chest — don't switch verbs to `mc collect`. Collect pathfinds globally and will pull you far off-site for material that's a short walk away in a chest.

### Hand back what you didn't use

When the card is done, before `kanban_complete`:

- `mc inventory` — see what's left of the pre-stocked fill.
- `mc go_mark <fill_chest>` + `mc deposit <fill_block> <leftover>` for any surplus.
- Mention the deposit in your `mc chat "done <tid>: …"` line so the next worker knows the chest is restocked.

This is how a 4-card cleanup run stays cheap: the second worker pulls from a chest you topped up, not from terrain you both have to re-mine.

### Tile the work

`mc level_ground` is capped at 16 columns per call. Any hotspot larger than that gets split into ≤4×4 tiles, processed one at a time. For each tile:

1. **Pick a standpoint outside the tile.** Use `mc terrain_top` at the tile corners (or one block beyond) to find a cell that's solid on top — that's your safe block.
2. **Move to it.** `mc move <safe_x> <safe_y> <safe_z>`. If the response carries `⚠ FELL`, the pathfinder dropped you into the damage — return to a known-safe Y before continuing.
3. **Dry-run plan.** `mc level_ground <tile_x1> <tile_z1> <tile_x2> <tile_z2>` (no `execute=true`). Read the column-by-column plan it returns.
4. **Harvest in-tile pillars by coordinate.** For each `action: 'dig'` column the plan reports, call `mc dig <x> <y> <z>` on that exact cell. Named coords keep you on-site; `mc collect` does not.
5. **Execute the fill.** Re-run `mc level_ground …` with `execute=true block=<your_fill_block>`. The primitive picks standpoints outside the fill region so you stay on the edge, not in the holes.
6. **Verify with senses.** `mc terrain_top` at the tile's corners and center should all report the target Y.

### Deep holes — creep, don't dive

The dry-run plan may include columns with very large `fill_depth`. Those are cave openings or mineshaft exposures, not surface damage — filling from above wastes a stack of blocks and still leaves the cavity below.

If you need a continuous walking surface across one of these, **creep**: stand on a known-safe block, place a fill block against your block's side (one step toward the void), step onto the new block, repeat. You build a horizontal bridge while the void stays open beneath. Mark deep cells with `mc mark <descriptive_name>` and report them in the card resolution so an operator can decide whether to cap, sign, or fill-from-below later.

The principle: **your standing block always supports the next placement.** Never step before you've built.

### Why these patterns, not improvisation

Workers who improvise on cleanup cards converge on the same failure modes: pathfinding underground to "collect" fill, falling into the holes during traversal, pillaring up to "see better" and getting stuck on the resulting columns. The shape above avoids all three by keeping the worker on solid edges with pre-stocked material and sensory checks between each action.

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
mc move X Y Z                  # move ~30 blocks in the chosen direction
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
mc move @home                  # walk back (preferred)
mc go_mark home                # same destination, legacy verb
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
