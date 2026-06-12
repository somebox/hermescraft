---
name: minecraft-mapping
description: "Mapping mission protocol — build torch-lit paths between named places. Workers receive [MAP-PATH] cards from <start> to a target coord. Drop torches every 25 blocks of travel; name the endpoint. Steward reviews sign proposals before placement. Load when working a [MAP-PATH] or [MAP] card under a [MAP:ARENA] epic."
triggers:
  - mapping mission
  - map the world
  - "[MAP-PATH]"
  - "[MAP:ARENA]"
  - "[MAP]"
  - build a path
  - torch trail
  - name landmark
  - sign proposal
  - place torches
  - personal POI
  - poi_add
version: 2.0.0
---

# Minecraft Mapping — build paths, name places, light the way

You are part of a fleet building a **shared, visible map** of this disc. Not a checklist of placements — a small ongoing project. Future agents read your signs. Human players see your torches in the dusk. Your placements are *contributions*, not chores.

The mission delivers in three layers, in this order:

1. **The path.** You build a torch-lit trail from a known starting place to a target coord. Each torch is a promise: "this path is safe — cleared, walkable, walkable back". The trail is what makes the map *navigable* by the next worker.
2. **The endpoint name.** When you arrive at the target, you propose a name and Steward approves it. The named sign is a *chapter heading* — evocative, not generic.
3. **The metadata.** Each torch and each sign gets a personal POI so the dashboard map shows it, the next agent can `mc go_poi` to it, the Steward can grade coverage, and the human operator can see your progress at a glance.

Commands you'll use most: [`mc place_named_sign`](../docs/reference/mc-cheatsheet.md), [`mc place_torch`](../docs/reference/mc-cheatsheet.md), [`mc poi_add`](../docs/reference/mc-cheatsheet.md), [`mc go_poi`](../docs/reference/mc-cheatsheet.md), [`mc nearby_signs`](../docs/reference/mc-cheatsheet.md), [`mc reachable`](../docs/reference/mc-cheatsheet.md), [`mc build_stairs`](../docs/reference/mc-cheatsheet.md), [`mc dig`](../docs/reference/mc-cheatsheet.md).

## Card shape: `[MAP-PATH] <startName> → <target>`

Card body example:

```
World: proc-lab. Mission: build a torch-lit path.
Start: muster at (0, 65, 0)
Target: (50, ?, -50)  — name it on arrival

Protocol:
1. mc go_poi muster (or mc move 0 65 0)
2. Set bearing toward target (~NE 315°)
3. LOOP every 25 blocks of travel:
     mc reachable <next_step>          # 5-block lookahead
     clear obstacles (mc dig lip, mc build_stairs jump)
     mc place_torch X Y Z
     mc poi_add wp_<n> --torch X Y Z --kind waypoint
4. At target: propose a name via kanban_comment
5. Wait for Steward approval (≤90s; otherwise proceed with proposal)
6. mc place_named_sign X Y Z "<approved-name>"
7. mc poi_add <approved-name> --sign X Y Z --kind landmark
8. Return via torch trail (mc go_poi wp_<n-1>, etc.)
9. Completion body MUST include literal output of:
     mc marks
     mc pois
     mc nearby_signs 32
```

## The torch trail protocol — every 25 blocks of travel

**A torch is a promise: this path is safe and the next agent can walk it.** That means *before* you drop a torch:

1. **Look 5 blocks ahead.** `mc reachable X+forward Y Z`. If unreachable, fix the path:
   - **Lip (1-block step-up):** `mc dig` the blocking block above
   - **Jump (2+ block step-up):** `mc build_stairs cobblestone <dir> 4` to make a ramp
   - **Drop (2+ block step-down):** place blocks back up to the previous level OR accept it as a one-way (note in chat)
   - **Lava / open pit:** detour; don't torch a death trap
2. **Place the torch.** `mc place_torch X Y Z` (auto floor vs wall).
3. **Add the POI immediately.** `mc poi_add wp_<n> --torch X Y Z --kind waypoint`. Without the POI, the torch is just a lit cell; with it, the next worker can `mc go_poi wp_<n>` directly.
4. **Move on.** Next 25 blocks.

Name your waypoints sequentially with the path direction baked in: `wp_ne_1`, `wp_ne_2`, `wp_ne_3` … makes the return trip easy (`mc go_poi wp_ne_2` to backtrack one step).

If a placement fails twice at the same coord:
- `LINE_TOO_LONG` or `TARGET_OCCUPIED` on a torch: skip this cell, walk 3-5 blocks further, retry
- `INVENTORY_MISSING`: return to chest at muster, `mc withdraw torch 16` then resume
- Any other error twice: chat the issue and try a different cell — don't loop

## Sign proposals — Steward is the editor

Signs are chapter headings. The fleet doesn't need three signs all called "snowy hill". Before you place an endpoint sign, propose the name to Steward:

```
mc nearby_signs 32                 # local check first — is there already a name?
kanban_comment <my-card-id> "SIGN_PROPOSAL: name='spider hill', coord=(50,65,-50), kind=landmark, note='peaked overlook NE'"
mc wait 60                         # give Steward a cycle to review
mc read_chat                       # was there a public reply?
kanban_show <my-card-id>           # check for Steward's comment on this card
```

Steward's reply format:

- **`APPROVED: spider hill at (50,65,-50)`** → proceed:
  ```
  mc place_named_sign 50 65 -50 "spider hill"
  mc poi_add spider_hill --sign 50 65 -50 --kind landmark
  ```
- **`REJECTED: too close to <existing-name>; try 30m east`** → move 30 blocks east, re-scan, re-propose.
- **`REJECTED: name '<x>' is taken; try '<y>' or your own variant`** → re-propose with a different name at the same coord.
- **`REJECTED: this is already <existing-name> — use it`** → don't place a new sign; just `mc poi_add <existing-name> --sign <existing-coord>` to attach yourself.

**If 90 seconds pass with no Steward response**, you have autonomy: place the sign with your proposed name. Steward gets the next cycle to override; she can rename via `mc edit_sign` if needed.

## Sign-text rules (avoid the common errors)

- **15 chars per line max.** "spider hill" fits; "spider hill north ridge" gets `LINE_TOO_LONG`. Use lines as separators:
  ```
  mc place_named_sign X Y Z "spider hill\nN ridge\noverlook"
  ```
- **Don't name your own foot cell.** Pick a coord 1-2 blocks in front of you. A sign can't be placed where the bot stands. Use `mc status` to see your position, then offset along your bearing.
- **Pick a cell with a solid neighbour.** Signs need a solid block to attach. If `mc reachable` says ok but place fails with `NO_SOLID_NEIGHBOR`, try an adjacent cell.

## On arrival: name the *area*, not just the spot

The endpoint sign names an *area*, not just the cell. Pick a name that means something to the next worker:

- **Terrain:** "frozen narrows", "spider hill", "ashen pit"
- **Discovery:** "balders ruin", "wolf den", "iron seam"
- **Bearing reference:** "NE knife edge", "S basin lookout"

Bad names: "stone formation 1", "tree 4", "place 17". Imagine the next worker reading `mc go_poi <name>` — does the name tell them *why*?

## Working from an existing path

If your `[MAP-PATH]` card's start node already has connecting paths, your card body will list them. Use `mc go_poi` to reach your start, then walk *outbound* — don't retrace existing trails. Steward picks frontier nodes (degree ≤ 1) as start points so your work extends the map rather than overlapping.

## Completion evidence (mandatory)

Before `kanban_complete`, paste the literal output of these three verbs in your completion body — not a summary, the literal output:

```
mc marks
mc pois
mc nearby_signs 32
```

Steward rejects empty-after-colon stubs. If you found zero of something, say so as a sentence: "no fleet marks placed this card; 1 landmark POI added (spider hill); 3 waypoint POIs along the trail (wp_ne_1, wp_ne_2, wp_ne_3)".

## Inventory expectations

Starter kit: 4 oak_sign + 16 torch. Chest: 16 oak_sign + 64 torch + 32 coal. A typical 50-block path needs ~2 torches + 1 sign — usually within starter-kit budget. For longer paths or return runs:

- **Signs:** `mc go_mark starter_chest` → `mc withdraw oak_sign 8` (or `mc craft oak_sign 4` if chest is dry).
- **Torches:** `mc craft torch 8` (1 coal + 1 stick → 4 torches). Coal is in the chest; sticks craft from any planks.
- **Batch:** don't return to base for one torch — finish your current path leg first.

## What not to do

- **Don't `mc poi_add` without an anchor.** A POI with neither `sign_at` nor `torch_at` is invisible to other agents.
- **Don't reuse a name.** `mc poi_add spider_hill` upserts; if there are two spider hills, name them differently. Steward will reject duplicates via the proposal protocol.
- **Don't place signs in protected regions.** `PROTECTED_BLOCK` means base / claim. Move 5+ blocks out and re-propose.
- **Don't torch a path you couldn't return on.** If you reached a torch via a 4-block drop, build steps back up first OR walk a longer way around.
- **Don't use fleet-mark verbs (`mc mark lt_*` etc.) for mapping POIs.** Fleet marks live in a separate store; mapping POIs go through `mc poi_add` only.
- **Don't pillar up to "see better".** Mapping is a surface activity. Use `mc map 16`, `mc scene`, and `mc nearby 32` to read terrain.

## Quick reference: per-card timeline

| Time | Action |
|------|--------|
| 0-30s | `mc go_poi <start>` + `mc status` + `mc inventory` |
| 30s-3min | LOOP: bearing → 25 blocks → reachable check → torch → poi_add waypoint |
| 3-4min | Arrive at target; `mc nearby_signs 32`; propose name |
| 4-5min | Wait/check for Steward approval |
| 5-6min | Place sign + poi_add landmark; chat result |
| 6-8min | Return via torch trail (`mc go_poi wp_<n-1>` etc.) |
| 8-9min | Completion body with `mc marks / mc pois / mc nearby_signs 32` literal output |

A clean `[MAP-PATH]` card lands in 6-10 minutes. If you're past 10 min without an endpoint sign, comment your blocker and ask Steward whether to abandon (drop the partial trail as a one-way exploration).
