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

## Site selection + structured-mining doctrine

**Random surface mining is forbidden.** Live-session evidence (2026-05-27): bots that mined opportunistically near base left a trail of orphan stair-down shafts, exposed bedrock, and 1×1 pillars across the surface. Subsequent workers tripped over the resulting terrain; later they had to be dispatched on `level_ground` cards just to clean it up. Every mining card MUST follow the doctrine below.

### Mine-site selection (Steward picks this; workers obey)

A "mine site" is a single (x, z) on the surface where a stair_down descends to a target depth band. Steward should designate this in the card body:

```yaml
mine_site:
  entry: [395, 65, -615]       # surface coord — the stair_down origin
  direction: north             # stair direction (north|south|east|west)
  target_y: 12                 # depth band for the resource (use Y-band table below)
  resource: iron_ore
  reuse_existing: true         # if a stair_down already lands at this entry, descend it instead of digging a new one
```

**Site selection rules:**

1. **Distance from base.** Mine entries should be ≥ 24 blocks horizontally from any `base`/`hut1`/`storage1` region anchor. Mining inside a base region's column risks chunked-load surprises and surface damage even with worksite grants.
2. **Not on a path.** Don't put a stair entrance on a road or in front of a chest. The bot will dig the supporting block of whatever the entrance opens onto.
3. **One entrance per resource band.** Iron @ Y=16 and diamond @ Y=-59 are different sites. Don't dig a single shaft 100 blocks deep and tunnel sideways for everything — that's a session-killer pillar collapse waiting to happen.
4. **Re-use entrances aggressively.** Before designating a new entry, check `scripts/board list --status done --assignee <bot>` for previously-mined sites at the same depth band and reassign workers to the existing entrance. Marks like `mine_iron`, `mine_coal`, `mine_diamond` should be saved at each entry with `mc mark` for future use.

### Size dig ops SMALL through solid stone (or they outrun the CLI)

Every stone block takes ~1 second to break. A big dig op through solid rock is
therefore **minutes** of grinding: `mc tunnel … 50 2 3` is ~300 blocks ≈ 5+
minutes; `mc stair_down … 30` is ~90 blocks ≈ 1.5 min. The bot finishes, but
your `mc` command **returns a timeout long before** — and if you re-issue it you
stack a second grind on top of the first. This is the #1 time-sink in stone.

Rules through solid stone:

- **Tunnel in ≤8-length bites.** `mc tunnel <x> <y> <z> <dir> 8 2 3`, then call
  again to extend. Eight small tunnels beat one that times out.
- **Stair_down/up ≤8 steps per call.** To reach a deep band, chain several
  `mc stair_down <dir> 8` calls — each returns; the next continues from where
  you stand.
- **level_ground ≤8 columns per call** (the hard cap is 16, but on stone even
  10 is slow). Split a 5×5 entry into 2–3 small calls.
- **A "timed-out" dig op probably WORKED.** Before retrying, run `mc inventory`
  / `mc status` — the bot likely finished (or is still finishing). Never blindly
  re-issue the same big dig; you'll double the work and burn your turn budget.

These small sizes are for digging through fresh stone. The long trunks/branches
in the room-and-pillar diagram below assume an already-opened bay or soft ground
— size DOWN when the rock is solid.

### Stair → tunnel → branch pattern

Once the entry is chosen, mining follows a fixed three-phase shape:

```
        [SURFACE Y=65]
              │
              │ mc stair_down north 8    ←  Phase 1: descend (chain ×N to reach the band)
              ▼
        [LANDING Y=15]
              │
              ├──→ mc tunnel north 32     ←  Phase 2: trunk tunnel
              │
        ┌─────┴──────┐
        ▼            ▼
   mc tunnel    mc tunnel               ←  Phase 3: branches every 6 blocks
   east 16      west 16                    (room-and-pillar pattern)
```

**Phase 1 — the single descent.** Use `mc stair_down DIR LEN` with LEN sized to reach the target band (Y=16 ≈ 50 stair steps from Y=65). Always pillar UP for cleanup at the end via the same stair — never dig your way up through fresh ceiling.

**Phase 2 — the trunk tunnel.** `mc tunnel north <len> width=2 height=3`. Width=2 lets the bot turn around without backtracking; height=3 prevents the head-clearance corner-case kicks.

**Phase 3 — branches.** Every 6 blocks along the trunk, side-tunnel `mc tunnel east 16` (or west). This is the classic room-and-pillar layout: 2-wide branches with 4-wide pillars between, max ore exposure per dig.

### Surface preservation rules

- **Never dig from the surface straight down past Y=60** unless you've capped a stair_down. A 1×1 vertical shaft is a hazard for every later bot, and the operator will lose patience.
- **Cap exposed shafts.** If a worker has to abandon mid-stair (deaths, reclaim), the next worker assigned to that mine site must `mc place dirt` over the exposed entrance pit before doing anything else.
- **No diagonal/spiral shafts.** Stick to cardinal directions. Diagonal stair_down has a 22% higher kick rate (NaN-cascade tracking, 2026-05-25 investigation).
- **Don't expose lava to the surface.** If `mc tunnel` returns `HAZARD_LAVA`, do NOT widen the breach by trying again with `--force`. Place dirt to seal it, comment the coords on your card, and `kanban_block reason=hazard:lava_at_X_Y_Z` for operator review.
- **Don't tunnel away your own staircase.** `mc tunnel`, `mc dig_area`, and single `mc dig` now automatically **preserve the treads of the `mc stair_down` staircase you came down** (your `mc retrace` route to the surface). If a dig would cut through them you'll see `Preserved N staircase tread(s)` (bulk) or a `STAIRCASE_EGRESS` refusal (single dig) — the staircase stays intact and the rest of the dig still runs. Only pass `--force` if you genuinely want to remove the stairs; that invalidates the retrace trail, so build a new way up (`mc stair_up` / `mc pillar_up`) first.

### When to clean up vs. abandon

A mine card completes when the resource quota is met. **Before completing**, run:

```
mc level_ground <entry_x-2> <entry_z-2> <entry_x+2> <entry_z+2> execute=true
```

This levels the 5×5 around your stair entry so the next worker (or a passing operator) doesn't trip. If the entry was a reused site, the cleanup is idempotent — `level_ground` just re-confirms the cap.

## Mine registry — durable state across sessions

A mine is more than a hole: it's a place you return to. The bot keeps a flat
**mine registry** (`data/mines-<world>.json`, shared across bots on the world)
so a mine's entrances, discoveries, resume points, and dangers survive across
cards and sessions. Use it; don't re-descend blind.

**Before digging a new mine, check for an existing one.**

```
mc mine_list                 # nearest entrance first: status, resource, point counts
mc mine_show <id>            # entrances (routes to surface) + every point + OPEN frontiers
```

If a mine already reaches your target resource/band, return to it and resume
from an **open frontier** instead of staking a fresh descent. That's the whole
point of keeping state — one orderly mine beats ten orphan shafts (the
2026-05-27 surface-scarring lesson).

**Register a mine and annotate as you discover.** A mine is a registry of
points you drop where you stand (or at `--at X Y Z`):

```
mc mine_open iron_north north 12 iron_ore     # entrance here, descending north to Y12 for iron
mc mine_note iron_north landing               # bottom of the stair
mc mine_note iron_north ore --resource iron_ore --qty 8   # a pocket, ~8 left
mc mine_note iron_north chamber --note "hollowed the lumpy bit by the iron vein"
mc mine_note iron_north station --tag furnace --tag chest
mc mine_note iron_north frontier --dir north --target-y 12 # open tunnel-end: resume here next time
```

Point kinds: `landing | chamber | junction | station | frontier | ore | danger`.
A **frontier** is the single most valuable annotation — it's where the next
miner picks up the tunnel instead of starting over. Drop one whenever you stop
mid-tunnel. An **ore** point with `status: open` is a pocket worth returning to;
mark it `extracted` (re-`mine_note` the same cell, or it auto-dedupes) once
pulled.

**Several routes to the surface.** Re-run `mc mine_open <id> --at X Y Z` at a
second exit to add another entrance to the same mine — the registry holds a
list, and `mine_list` reports the nearest one.

**Retire a mine** when it's played out or unsafe:

```
mc mine_status iron_north exhausted      # active | exhausted | abandoned | hazard_locked
```

**Bind your card to the mine.** Run `mc task_context set <mine_id>` at session
start (the same grant you need for `protect`-region dig — see top of this
skill). Beyond authorization, it tells the **reactive danger recorder** which
mine to attach a hazard to when you breach one.

### Reactive dangers — the bot marks hazards for you

When a `mc dig` breaks into **water or lava**, the bot reacts automatically and
records the spot so nobody walks into it again:

- **Water**: auto-plugs the dug cell (cobble/stone/dirt/planks from your
  inventory) and records a `danger` point marked `sealed`. Carry plug blocks or
  it can only record, not seal.
- **Lava**: honors retreat-first — it does **not** plug in place (standing next
  to lava to place a block is how bots die). It steps one safe cell back if it
  can, records the `danger` unsealed, and surfaces the plug hint. You finish the
  seal from a safe stance: `mc place <cobble> <x> <y> <z>`.

The danger attaches to your `task_context` mine, or the nearest mine entrance
within ~48 blocks (horizontal). No active mine and none nearby? It still warns
in the dig result, but the record has nowhere to live — `mc mine_open` first if
you're working a spot you'll return to.

**Read dangers before you tunnel.** `mc mine_show <id>` lists every recorded
hazard. Route branches away from `danger` cells; an unsealed lava danger near
your planned tunnel is a `kanban_block hazard:lava` decision, not a dig-through.

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
| Ore is in your line-of-sight (visible via `mc nearby` or `mc scene`) | **`mc collect <ore_name> <count>`** | Pathfinder mines reachable blocks in one call. **Always confirm with `mc inventory`** — blocks broken can exceed items picked up when drops land off your feet. |
| Ore is at a known coord but **behind a wall** (LOS blocked) | **`mc tunnel X Y Z <dir> <length> [width] [height]`** | Industrial corridor digger — repeated `dig_area` slices in a direction. Use the ore's coord as origin and dig **toward** it. Default width=2, height=3 = walkable corridor you can return through. |
| You need to **descend** to ore depth from the surface | **`mc stair_down <dir> <N>`** | 3-wide walkable staircase, auto head clearance, climbable back up with `mc stair_up`. |
| You need to **clear out a 3D volume** (room, branch mine bay) | **`mc dig_area X1 Y1 Z1 X2 Y2 Z2`** | Axis-aligned box clearance, high-Y first. **Per-call cap is 32 blocks** — split larger volumes into multiple ≤32-block boxes (the CLI error names the limit). |
| Single specific block, in LOS, you really do want just one | **`mc dig X Y Z`** | Last-resort primitive. No planning. Easy to dig into a 1-wide trap. |

**Anti-pattern: looping `mc dig` against blocks NOT in your line-of-sight.** That's the most common mining failure mode. Symptom: repeated `mc dig X Y Z` calls returning `[error]` in 0.3s because the block is behind a wall. If you hit that twice in a row, **switch to `mc tunnel`** with the target coord as the destination and a direction toward it. The tunnel verb takes a starting coord + direction — point it at the ore and let it carve through.

NEVER `mc dig` straight down (lava) and NEVER make a 1-wide vertical shaft (no escape route).

### Worked example: ore at (381, 38, -599), you're at (380, 64, -596) on surface

```bash
# 1. Descend safely
mc stair_down south 8           # 3-wide staircase south; chain ×N to reach a deeper band

# 2. Once at ore depth, get the cluster
mc nearby 16                     # confirm visible iron
mc collect iron_ore 16           # let the pathfinder mine reachable ore

# 3. If more iron is needed but it's behind a cave wall at (375, 38, -603):
mc tunnel 380 38 -599 west 8     # dig a 2x3 corridor toward it
mc collect iron_ore 16           # now in LOS, collect again

# 4. Return
mc stair_up                      # uses your staircase
```

## Surface strip / wood SUPPLY (no random pit mines)

For **`[SUPPLY] oak_log` / tall-tree / mark `lt_wood_*`** cards at a **named tree or coord** (not underground ore):

1. **Preflight at base** — axe tier appropriate for the log (`wooden_axe` minimum for oak), optional dirt/cobble for bridging, food if leaving base.
2. **Go to the trunk base** — one `mc move` / `mc goto` to the body coord or mark; don't strip-mine the surface on the way.
3. **Fell + collect** — `mc collect oak_log N` from trunk upward, or trunk `mc dig` + `mc pickup` if collect path fails; confirm top log is air (`mc inspect` above trunk).
4. **Deposit** — `mc deposit` to the body chest/mark; chat `done <tid>: N oak_log deposited`.
5. **Replant** — if the card or steward doctrine requires it, plant saplings at the paired `lt_grove_*` mark (see kanban-worker felling section).

When the card body includes **`playbook: wood.chop_tall_tree`**, use `skill_view('playbook-wood-chop-tall-tree')` for phase routing + `[run_state]` checkpoints; this section is the prose-skilled procedure both A1 baselines should follow.

## Production workflow — how to actually mine a SUPPLY card

Most mining failures look like "the bot wandered" because the worker treated the card as open-ended exploration instead of a structured production run. **Follow this 5-phase template** for any `[SUPPLY] <ore>` or "gather N stone/iron/coal" card. Don't skip phases.

**Bias to action.** Mining primitives (`stair_down`, `tunnel`, `dig_area`, `collect`) have rich error envelopes that already tell you what's wrong AND where. Pre-inspecting cells before calling a primitive is almost always wasted iteration budget — you check 3+ blocks, the primitive could have told you in one call. Default: **call the primitive, read the error, react with ONE adjustment, retry.** If you've failed twice in different ways on the same target, then probe. Probing first is paralysis.

Bot session is bounded (max-turns + max-runtime). 30 inspect calls = no descent = card incomplete = next worker starts from scratch. 1 stair_down + 1 error read + 1 lateral move + 1 retry = descended, in flight, making progress.

### Phase 1 — Pre-flight (≤ 5 tool calls, before leaving base)

Verify in inventory, in this order — stop and recover if any check fails:

```
mc inventory
```

| Item | Minimum | If missing |
|---|---|---|
| Pickaxe of correct tier | stone for iron/coal/cobble, iron for gold/redstone, iron+ for diamond | Walk to base crafting table; `mc craft stone_pickaxe` (3 cobble + 2 sticks) |
| Cobblestone or dirt | 64 (for pillar/wall/escape) | `mc collect cobblestone 64` near surface stone first |
| Torches | 16 | **COAL is the blocking input.** No coal → get it FIRST: `mc collect coal_ore 8` (common y16–112) OR smelt logs→charcoal in a furnace. Then `mc craft torch 16` (1 coal/charcoal + 1 stick → 4 torches). |
| Food (cooked) | 8 | Visit `food_chest` mark; `mc withdraw cooked_beef 8` |

Light the descent with `mc place_torch <x> <y> <z>` at intervals (the `tunnel` primitive auto-spaces torches when you carry them). A dark shaft spawns mobs and loses the route back — torches are not optional.

If the card body lists `prep_required:` with thresholds, those win over this default. If you can't meet the prep, **`kanban_block prep_required_unmet`** — don't try to mine without gear. The orchestrator will queue a `[SUPPLY]` precursor for the missing items.

### Phase 2 — Locate the seam

The card body either has explicit coordinates OR it doesn't. Branch on this:

**Branch A — card specifies location** (`(376, 44, -599)` or `mine at coal vein near (376,-599) Y43-45`):
1. `mc move <x> 65 <z>` to land on the surface above the target (Y=65 is safe surface for our base area).
2. Skip to Phase 3.

**Do NOT pick your own ore location when the card gave you one.** If you find a surface ore cluster on the way and it's at the WRONG coord, ignore it. The audit task that produced this card already weighed surface vs underground; trust the body. Drift here is the #1 cause of stuck mining sessions.

**Branch B — card has no location** (`gather 64 iron`, `mine cobblestone`, etc.):
1. **Run `mc advise --reason "<ore> location scan" --target <last_known_mine_or_base>` first.** The advise digest will identify nearby ore signatures from your perception bundle and recommend a direction — this is free intelligence, use it.
2. If advise returns a coord, treat it as Branch A.
3. If advise has no answer, scout in steps of 30 blocks:
   ```
   for step in 1..6:
       mc move <pos> + 30 blocks in chosen direction
       mc nearby 16                       # see anything?
       mc find_blocks <ore> 32             # explicit scan
       if found: break
   ```
   After 6 steps (180m walked) with nothing, **`kanban_block no_seam_found:<area_explored>`** — the steward will pick a better starting area. Don't wander further.

### Phase 3 — Descend (just try `mc stair_down`)

**Action first. Don't probe first.** The stair_down primitive has good error envelopes — call it, read the error if it fails, react. Pre-inspecting every cell is a paralysis trap; you burn 5-10 calls verifying terrain that the primitive itself can tell you about in one call.

Standard descent — first attempt (short bite; chain more calls to go deeper):

```
mc stair_down south 8
```

- Direction: pick a cardinal that points AWAY from base structures. If unsure, `mc regions --at` once.
- Each 8-step bite drops ~8 Y. To reach the iron/coal band (~Y34, above the Y10 lava layer) from the surface, chain ~4 `mc stair_down` calls — each returns quickly; the next continues from where you stand. One big `30` would grind for over a minute and read as a timeout.
- If it succeeds, `mc set_mark mine_entrance` at the top, continue to Phase 4.

**If stair_down errors, read the envelope and react with ONE move:**

| Error | Meaning | What to do (one action, then retry) |
|---|---|---|
| `no_progress_at_step_1 (3 already_air)` | You're at a cliff edge or existing tunnel | `mc move <X> <Y> <Z>` 5 blocks in any direction away from your current spot, then retry stair_down |
| `cave_below_step_N_floor_is_air_at_X_Y_Z` | Hit a cave after N steps down | You're already partway down — `mc place cobblestone X Y Z` to bridge the air floor, then retry stair_down in the **SAME direction** (it continues from where you stand) |
| `no_progress_at_step_N (M bedrock)` | Bedrock hit | You're as deep as you'll get on this shaft — switch to `mc tunnel` horizontally |
| `reconnect_during_step_N` | Watchdog forced a reconnect mid-flight | Just retry — bot is settled now |

**Commit to ONE descent direction — do NOT keep switching.** The #1 way a
deep descent fails: the bot hits a cave, the agent switches from `south` to
`north` to `east`…, and spirals in the same shallow band without ever reaching
the target Y. Pick a direction at the entrance and stay with it the whole way
down. When a cave interrupts you, **bridge it and continue the same way** — a
cave is a discovery to log (`mc mine_note <id> danger` or just push through),
not a reason to abandon the shaft and start over elsewhere. Each new direction
is a new staircase you have to dig from scratch.

**Do not inspect cells before calling stair_down.** The primitive's own error envelope already tells you what blocked it AND where, in fewer calls than a pre-check. Pre-checking is only useful if you've already failed twice in a row in different ways.

**Flag syntax** — positional only: `mc stair_down DIR [LENGTH] [X Y Z] [WIDTH] [HEIGHT]`. No `--width` / `--height` long-form flags. After it lands, `mc set_mark mine_entrance` and `mc set_mark <ore>_seam`.

NEVER pillar straight down. NEVER dig a 1-wide shaft. The escape primitives don't compensate for a missing staircase.

### Phase 4 — Tunnel (mandatory primitive: `mc tunnel`)

Pick a direction toward the densest ore signature (from Phase 2 advise/scan) and run it in **short bites through stone** (see the sizing rule above — a `50`-long tunnel through solid rock takes minutes and will look like a timeout):

```
mc tunnel <x> <y> <z> <dir> 8 2 3          # 2-wide × 3-high × 8-long bite; call again to extend
```

The `tunnel` primitive uses the embedded pathfinder + dig_area slices — much more efficient than per-block `mc dig`. It also handles head clearance and torch-spacing automatically when the bot has torches in inventory. Extend by repeating the call from your new position; don't ask for a 50-long corridor in one shot through stone.

### Phase 5 — Scan-and-branch (every 10 blocks during Phase 4)

The pathfinder handles the corridor, but YOU need to surface the ore intelligence. Between tunnel calls (or after each ~10-block run), interleave:

```
mc nearby 8                                # quick visual catalog
mc find_blocks iron_ore 12                 # explicit scan (radius 12)
```

If ore is found within ~8 blocks but **off the corridor axis** (i.e. behind a wall):
```
mc tunnel <ore_x> <ore_y> <ore_z> <dir_toward> 6    # branch off
mc collect iron_ore 16                              # pathfinder + pickup
mc move @mine_entrance                         # or mc go_mark mine_entrance
```

If ore is found IN the corridor: `mc collect <ore> 16` and continue the main tunnel.

After the main tunnel reaches ~50 blocks total (built up from short bites), **stop**. Don't keep extending — file a follow-up `[EXTEND]` card if more length is needed. Long-running cards exceed iteration budget.

### Returning + completing

When you have the deficit met (check `mc inventory` against the card's `Deficit:` field):

1. `mc move @mine_entrance` (or `mc go_mark mine_entrance`) — back to staircase top.
2. `mc move @base` (or `mc go_mark base`) — surface base.
3. `mc deposit <ore_name>` at the matching chest (per card body — usually `materials_chest` for cobble, `ore_chest` for iron).
4. `kanban_complete summary:"deposited <N> <ore> at <chest>; tunnel left open at (<X>,<Y>,<Z>) <dir> for follow-up"`.

The "tunnel left open at ..." line in the summary is critical — the next miner can resume from where you stopped instead of starting a new descent.

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
| In open cave / no staircase, blocks in hand | **`mc pillar_up cobblestone 30`** | Vertical pillaring up to 30 blocks in one call. Far faster than manual `mc place + mc jump`. Iterates dig+place through ceilings, stops at a sky-open surface. |
| Buried under thick ceiling, no blocks in hand | **`mc pillar_up 20`** (no block arg) | Bare-hand digs the cell overhead, picks up the drop, and pillars with that. Self-sustains as long as the ceiling material drops (dirt/sand/gravel: yes; stone bare-hand: no — needs a pickaxe OR `--force`). When truly trapped (4 walls + ceiling) it auto bare-hand digs the ceiling without `--force`. |
| Stuck on top of a 1×1 column (over-pillared) | **`mc pillar_down`** | Mines underfoot block, drops 1, repeats until you reach proper surface. |
| You marked `mc mark return_to_surface` at entry | **`mc move @return_to_surface`** (or `mc go_mark …`) | One-shot return — pathfinder routes via known-walkable path back. |
| In water | **`mc surface`** | Swims you up to air. No-op on dry land. |

**Anti-pattern: hand-rolling `mc place cobblestone X Y Z` + `mc jump`** one block at a time. That's slow (4× the rounds vs `pillar_up`), eats iteration budget, and is error-prone (your bounding box and the new block fight each tick). Use `mc pillar_up <block> <count>` instead — it handles the place-then-jump-then-rise cycle internally.

### Outdoor slope / lip before pillar (surface cards)

When `mc scene` or NAV errors show `terrain_kind` **`slope_*`** or **`cliff_above`** (not `underground`), you are usually on a **walkable slope problem**, not a shaft:

1. Run **`mc read_chat 20`** and **`mc reachable`** on the card target (see `kanban-worker` mandatory probes).
2. Follow **`next_action_hint`**: lip **`mc dig`**, **`mc build_stairs`**, or **`mc goto_near`** to `best_stand`.
3. Use **`mc pillar_up`** only after those fail or for a deliberate vertical escape — not to scout horizontal work sites.

### Underground pillar escape (ceiling breakthrough)

When you're stuck underground with a ceiling overhead:

- **Default**: `mc pillar_up 20` (no block argument). The primitive itself will dig the cell directly above your head, wait for the drop to enter inventory, then pillar up using that captured block. When you're genuinely trapped (4 walls + ceiling) it auto bare-hand digs the ceiling — no `--force` needed for that.
- **Read the result, don't guess.** `pillar_up` reports `placed/requested` and *why* it stopped. If it stopped early on a stone ceiling with no pickaxe, the `next_action_hint` will say so and point at `--force` (or crafting a pickaxe). Don't assume "lateral exit" — the message tells you.
- **Drop-timing caveat** (current implementation): the dirt drop from the ceiling dig sometimes arrives in inventory *after* one pillar_up call returns (Paper item_spawn packet vs. magnet-collect race). If you call once and get `PILLAR_FAILED` with `capture-from-ceiling failed: cell above head at … is air`, your inventory likely has 1 captured block now — **call `mc pillar_up` a second time** and it'll use the captured block normally. Iterating this 2-call pattern is the reliable self-rescue today.
- **`ESCAPE_NO_DROP` returned**: the ceiling dug but dropped nothing — you bare-hand dug stone (no cobblestone unless you have a pickaxe), or the block was a non-collectible like a slab. Get a pickaxe (`mc craft wooden_pickaxe`) or extract pillar material from the walls/floor first (`mc dig <wall_coord>` → `mc pickup`), then retry `mc pillar_up 20 --force`.
- **`PILLAR_FAILED` with `--force` already used**: you're genuinely unrescuable from the bot's perspective — no tool, no diggable material that drops. File a `[RESCUE_REQUEST]` card with your coords; do NOT loop.
- **`POLICY_DENY` (region refusal)**: you're inside a protected region. Pass `--force` and the primitive will bypass region/global denylists for the escape dig **only when** you're verifiably stuck (4 cardinal walls + ceiling overhead). Otherwise file a rescue card; do not retry without `--force`.

The `--force` flag is two things at once:
1. Skips the slow-dig refusal so a bare-hand stone dig is allowed (slow — multiple seconds per cell — but legal).
2. Bypasses region/global denylists for that single dig, *only* when the stuck-predicate fires. Every bypass is logged on the action result for audit.

Never pass `--force` during normal navigation — it's an escape hatch for "trapped underground," nothing more.

### Returning from the pillar — use `mc pillar_down`

`mc pillar_up` is ONE-WAY without help. Once you've pillared up out of a shaft and re-anchored on a 1×1 column at the surface, **you cannot just walk off** — there's no ground around you, only the pillar you placed. The inverse primitive is:

```
mc pillar_down [N=12]      # descend by mining the block underfoot, drop one cell, repeat
```

**The pair `pillar_up` → `pillar_down` is the round trip.** Every time you pillar up to escape, plan on pillar-down (or `mc dig` the column laterally, or `mc move` to an adjacent solid block — but only if one exists) to return to ground-level pathfinding. Sitting on a pillar burns iteration budget without making progress.

**Anti-pattern: do NOT use `mc pillar_up` for scouting / "seeing farther".** Your training data may suggest this — it's a real Minecraft tactic for human players. For our bots it's a trap:

- `mc map [R]` gives a compact ASCII overhead view without moving (R ≤ 16)
- `mc nearby 32` lists blocks + entities within 32 blocks
- `mc scene --reason="<what you're looking for>"` gives an LLM-digested perception bundle
- `mc advise --reason="..." --target X,Y,Z` recommends a direction based on world state

All of these surface terrain intelligence without committing to a vertical excursion. Save `pillar_up` for escape situations only.

## Iteration budget reminder

Kanban worker has ~90 turns. A descent + ore retrieval + return cycle should fit in ~30 turns if you use `mc collect` / `mc stair_down`. If you're past 50 turns and still underground without the ore, that's a signal to `kanban_block` and ask the steward to split the work into a smaller supply card.
