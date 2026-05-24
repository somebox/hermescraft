---
name: minecraft-mining
description: Safe-descent and ore-retrieval playbook for Mineflayer workers. Load on-demand when a card body involves descending below spawn-Y, collecting ores, or anything underground. Includes the pre-mining checklist, primitive preference order, and stuck-mining pivot heuristics distilled from incident postmortems.
version: 1.0.0
platforms: [linux, macos]
metadata:
  hermes:
    tags: [minecraft, mineflayer, mining, safety]
    related_skills: [minecraft-navigation, minecraft-survival]
---

# Minecraft Mining — safe descent + ore retrieval

Load this when the card body says you need to mine, descend, or fetch ore. Skip it for surface work — token budget matters.

## Worksite grant for protect regions

If your card body has a `worksite: <region_id>` line (e.g. `worksite: mine2`), run **once at session start, before any dig/place**:

```
mc task_context set <region_id>
```

This binds your kanban card to the named region; the bot grants ad-hoc dig/place inside `:<region_id>:` for the duration of this card (default 30 min, max 4 h). Without it, a `protect`-intent region rejects every `mc dig` and `mc collect` with policy errors — you'll burn iterations on what looks like "stuck" but is actually authorization.

On `kanban_complete` or `kanban_block`, run `mc task_context clear` so the grant doesn't leak to the next card.

If you see repeated `policy_violation` / `region_protected` errors AND your card has no `worksite:` line, `kanban_block` with reason `region_blocked:<id>:<short_reason>` — the steward supervisor will add the worksite via comment + unblock you. Don't try to flip region intent yourself.

## Pre-mining checklist

Before descending more than 5 blocks below your current foot Y, verify in inventory:

- **64+ cobblestone or dirt** — for pillaring up, bridging gaps, walling off lava. A bot with 0 placeable blocks in a shaft IS stuck. Period.
- **Torches ≥ 16** — light the descent, mark the route back, prevent mob spawns.
- **2 pickaxes** (or 1 pickaxe + spare sticks/cobble for an in-cave craft).
- **Food ≥ 8 cooked.** Hunger underground kills.

If anything is missing, surface trips are cheap; rescue trips from y=15 are expensive. The card body's `prep_required` field (when set by the steward) lists the exact thresholds — if they're not met, `kanban_block` with reason `prep_required_unmet` and let the orchestrator queue a `[SUPPLY]` precursor.

## Primitive preference order (top first)

For any "I need ore X" goal, **pick the primitive that matches the situation**:

| Situation | Primitive | Why |
|---|---|---|
| Ore is in your line-of-sight (visible via `mc nearby` or `mc scene`) | **`mc collect <ore_name> <count>`** | Embedded pathfinder routes to ore and mines it in one call. Handles ore-by-ore movement automatically. |
| Ore is at a known coord but **behind a wall** (LOS blocked) | **`mc tunnel X Y Z <dir> <length> [width] [height]`** | Industrial corridor digger — repeated `dig_area` slices in a direction. Use the ore's coord as origin and dig **toward** it. Default width=2, height=3 = walkable corridor you can return through. |
| You need to **descend** to ore depth from the surface | **`mc stair_down <dir> <N>`** | 3-wide walkable staircase, auto head clearance, climbable back up with `mc stair_up`. |
| You need to **clear out a 3D volume** (room, branch mine bay) | **`mc dig_area X1 Y1 Z1 X2 Y2 Z2`** | Axis-aligned box clearance, high-Y first, max 500 blocks. |
| Single specific block, in LOS, you really do want just one | **`mc dig X Y Z`** | Last-resort primitive. No planning. Easy to dig into a 1-wide trap. |

**Anti-pattern: looping `mc dig` against blocks NOT in your line-of-sight.** That's the most common mining failure mode. Symptom: repeated `mc dig X Y Z` calls returning `[error]` in 0.3s because the block is behind a wall. If you hit that twice in a row, **switch to `mc tunnel`** with the target coord as the destination and a direction toward it. The tunnel verb takes a starting coord + direction — point it at the ore and let it carve through.

NEVER `mc dig` straight down (lava) and NEVER make a 1-wide vertical shaft (no escape route).

### Worked example: ore at (381, 38, -599), you're at (380, 64, -596) on surface

```bash
# 1. Descend safely
mc stair_down south 30          # 3-wide staircase south, lands around Y=34

# 2. Once at ore depth, get the cluster
mc nearby 16                     # confirm visible iron
mc collect iron_ore 16           # let the pathfinder mine reachable ore

# 3. If more iron is needed but it's behind a cave wall at (375, 38, -603):
mc tunnel 380 38 -599 west 8     # dig a 2x3 corridor toward it
mc collect iron_ore 16           # now in LOS, collect again

# 4. Return
mc stair_up                      # uses your staircase
```

## Stuck-mining pivot heuristic

If you get 3 errors in a row from `mc dig`, `mc goto`, or `mc escape` at the same target — **stop digging** and run the escape protocol below.

### Escape protocol (run BEFORE more dig attempts)

Don't assume you're stuck because walls are unbreakable. Often the way out is a plain `mc move` into an adjacent air cell you haven't noticed.

1. **`mc status`** — confirm your exact `pos`. Note feet Y; head is Y+1.
2. **`mc scene --reason="locating escape route from pocket at <coords>"`** — the LLM digest is the right tool for "I'm stuck and need spatial reasoning", much better than quick `mc nearby` for this case. It will identify air openings, cave extensions, and reachable surfaces in plain language.
3. **Inspect all 6 adjacents** for air at feet Y AND head Y (cheap, exact):
   ```
   mc inspect <x+1> <feet_y>   <z>
   mc inspect <x-1> <feet_y>   <z>
   mc inspect <x>   <feet_y>   <z+1>
   mc inspect <x>   <feet_y>   <z-1>
   mc inspect <x>   <feet_y+1> <z>     # ceiling
   mc inspect <x>   <feet_y-1> <z>     # floor
   ```
   Any cell that's `air` (with the cell at `feet_y+1` ALSO `air` for walkable headroom) is a step-out direction.
4. **`mc move <air_cell>`** — step into the opening. No tools needed.
5. From the new position, re-evaluate: `mc nearby 16` for cave geometry, `mc find_blocks` for upward routes (look for grass_block, oak_log, sky-adjacent stone).

### Read your own error envelopes — they're free scans

Every `mc dig` / `mc place` / `mc collect` failure returns a structured envelope with:
- The actual block name at the target coord (often surfaced as `observed_state.block` or in the error message)
- The reason: `NO_TOOL`, `NO_LINE_OF_SIGHT`, `TARGET_SELF_OCCUPIED`, `NAV_TARGET_UNSTANDABLE`, etc.

These ARE inspection results. If you've tried 4 `mc dig` calls at the 4 cardinal walls and all returned `NO_TOOL block=andesite`, you've just confirmed you're in a 4-walled andesite pocket — no need to also run 4 separate `mc inspect` calls. Aggregate the failure signal across calls.

If the SAME primitive against the SAME coord fails twice in a row with the SAME reason, retrying a third time CANNOT possibly succeed. Pivot to a different primitive or coord.

### Tool-tier check

If a `mc dig` error is `NO_TOOL` / `WRONG_TOOL`, you can't break that block class with what you're holding. Quick reference:

| Block class | Min tool |
|---|---|
| dirt, sand, gravel, grass_block | bare hands (any) — also breaks faster with shovel |
| wood (log, planks, leaves) | axe (any tier) |
| stone, cobblestone, andesite, granite, diorite, ores | **wooden_pickaxe minimum** |
| iron_ore | stone_pickaxe minimum |
| diamond_ore, gold_ore | iron_pickaxe minimum |
| obsidian | diamond_pickaxe |

**If you're underground and your pickaxe broke** (the `[NO_TOOL] mc dig` signature), check inventory for: cobble (≥3) + sticks (≥2) + crafting_table (1) → `mc craft stone_pickaxe` in place. If you lack any, **don't keep digging** — find a dirt/sand path out (`mc inspect` + `mc move`), surface via `mc stair_up`, or `kanban_block decision_needed: no pickaxe`.

### If escape and tool checks both fail

After running the escape protocol AND the tool check AND `mc stair_up` (if there's headroom), still no progress in another 3 turns:
- Post a `kanban_comment` with exact pos, inventory, and the 6-adjacent inspect results
- `kanban_block` with reason `stuck_pocket_no_escape:<pos>` so the steward can rcon-tp you out
- Do NOT burn the remaining iteration budget repeating the same failing primitive.

## Common ore Y bands (1.21)

| Ore | Best Y | Notes |
|---|---|---|
| coal_ore | 0 to 320 (peak 95) | abundant at surface mountain biomes |
| iron_ore | -64 to 320 (peak ~15) | also common at y=232 in mountains |
| copper_ore | -16 to 112 (peak ~48) | dripstone caves |
| gold_ore | -64 to 32 (peak ~-16) | badlands much higher |
| redstone_ore | -64 to 15 (peak ~-58) | |
| diamond_ore | -64 to 16 (peak ~-58) | needs iron+ pickaxe |
| ancient_debris | nether, y=8-22 | |

For an iron run at base spawn (~y=64), target descent to y=15 (~50 blocks down) via stair_down, or just try `mc collect iron_ore N` first — if iron is within ~64 blocks horizontal of a known cave, the body will find it without you committing to a descent.

## Returning to surface

The right primitive depends on what's around you and whether you already have a staircase.

| Situation | Primitive | Why |
|---|---|---|
| You dug a `mc stair_down` on the way in | **`mc stair_up <opposite_dir> <length>`** | Cleanest exit — auto floor-block placement over voids, walkable + reversible. Mirror the direction you came down with. |
| In open cave / no staircase, blocks in hand | **`mc pillar_step cobblestone 30`** | Vertical pillaring up to 30 blocks in one call. Far faster than manual `mc place + mc jump`. Stops at first ceiling. |
| Stuck on top of a 1×1 column (over-pillared) | **`mc pillar_down`** | Mines underfoot block, drops 1, repeats until you reach proper surface. |
| You marked `mc mark return_to_surface` at entry | **`mc go_mark return_to_surface`** | One-shot return — pathfinder routes via known-walkable path back. |
| In water | **`mc surface`** | Swims you up to air. No-op on dry land. |

**Anti-pattern: hand-rolling `mc place cobblestone X Y Z` + `mc jump`** one block at a time. That's slow (4× the rounds vs `pillar_step`), eats iteration budget, and is error-prone (your bounding box and the new block fight each tick). Use `mc pillar_step <block> <count>` instead — it handles the place-then-jump-then-rise cycle internally.

If `mc pillar_step` errors (no headroom, no blocks), check `mc inventory` for placeable blocks (cobblestone, dirt, anything full-cube). If you're truly out of blocks, `mc dig` the block above you to make a chimney first, then pillar up through it.

## Iteration budget reminder

Kanban worker has ~90 turns. A descent + ore retrieval + return cycle should fit in ~30 turns if you use `mc collect` / `mc stair_down`. If you're past 50 turns and still underground without the ore, that's a signal to `kanban_block` and ask the steward to split the work into a smaller supply card.
