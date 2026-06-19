---
name: minecraft-fundamentals
description: "Universal Minecraft decision-level mechanics every colony role needs — traversal, safe descent, ore Y-levels, hazards & escape, health/hunger, marks, reach, what makes a safe structure, and sustaining a colony. Load alongside your specialty skill. You DRIVE mc verbs; the bot executes the mechanics — this is the knowledge for deciding WHICH verb, WHERE, and WHEN."
triggers:
  - minecraft
  - colony
  - move
  - dig
  - build
  - mine
  - explore
---

# Minecraft fundamentals (decision layer)

You don't hand-place blocks or hand-pillar. You issue `mc <verb>` and the bot
executes the mechanics. This skill is the knowledge for **deciding** — which verb,
where, when, and how to read what the world tells you back. Your specialty skill
covers your job; this covers what every role on the colony shares.

## Reading the world
- Coordinates are X (east+/west−), Y (height), Z (south+/north−). Y is the one
  that decides ore, lava, and fall safety — always know your Y.
- `mc scene` / `mc map` / `mc terrain_top X Z` to look around before acting.
- Action results carry a `next_action_hint` and an `observed_state` — read them.
  A repeated failure to the SAME coord means change approach, never re-issue it.

## Traversal — what's passable
- A **1-block step up** is auto-walkable (`mc move` / `mc goto`). A **2+ block
  wall** is NOT — the pathfinder needs a step; use `mc stair_up`, or place a block.
- A **drop > 3 blocks** causes fall damage — don't path off it. Descend with
  `mc stair_down` (safe ramp) or pillar/ladder down. The pathfinder won't break
  blocks; if terrain blocks the route, that's a dig/clear decision, not a retry.
- **Gaps / water** in the way: bridge a walkable surface with `mc deck …` (it
  decks the air row), or cross open water with `mc sail_to`. Never leave open
  water in a path — bots drown in it.
- **Stuck** (`no horizontal movement`, "wiggling", `STUCK_IN_WATER`): stop
  retrying. `mc escape`, or reassess with `mc scene` and pick a different route.

## Going down + ore Y-levels
- **Never dig straight DOWN** (lava / cave / void below you) or straight UP
  (falling gravel/sand, or lava above). The `mc stair_down` / `mc tunnel` verbs
  dig the safe staircase/branch patterns for you — prefer them.
- Mine at the right depth for the target:

  | Resource | Best Y | Resource | Best Y |
  |---|---|---|---|
  | Coal | 95–136 (& surface) | Gold | −16 |
  | Iron | 16 (also high) | Diamond / Redstone | −58 to −59 (deepslate) |
  | Copper | 48 | Lapis | 0 |

- Stone is everywhere; **deepslate** replaces it below Y=0 (slower to mine, same
  drops). **Lava pools** generate below Y=−55 — descend cautiously down there.

## Hazards & escape (decision triggers)
- **Water around you / drowning** → get to solid DRY ground; `mc escape`. Don't
  build or stand-work in water.
- **Exposed lava** → place a block between you and it / back off; don't path near it.
- **Falling sand/gravel** → move out; a torch placed under a falling column breaks it.
- **Trapped in a pit** → pillar up with blocks, or stair out; don't sit still.
- If a hazard is novel or you're genuinely stuck and out of options, escalate
  (`kanban_block` with a precise reason) rather than looping.

## Health & hunger
- 20 HP. Health regenerates only while hunger is high (≥ ~18/20); at 0 hunger you
  starve (no death on **peaceful**, but you stop regenerating and can't sprint).
- Eat when food is low; keep some food on you for long jobs. Sprinting/jumping/
  mining drain hunger fastest.

## Don't get lost — use the shared map
- `mc mark <name> [--at X Y Z]` every site that matters — base center, resource
  patches, water, mine entrances, hazards — then `mc go_mark <name>` to return.
  Marks are SHARED across the colony (reconciled), so a mark you set helps the
  whole team find what you found. Name them meaningfully.
- Place torches as you explore mines/tunnels so you (and others) can walk back.

## Reach & placement
- Reach is ~4.5 blocks; you can't place a block in mid-air — it needs an adjacent
  solid face. A place that fails with "no adjacent face" means you're over a gap →
  bridge it (`mc deck`) or stand somewhere with a face to build against.

## What a safe structure is
Even on peaceful, a colony wants a real home: **enclosed** (walls + a roof),
**a door** for access (face it somewhere walkable), **lit** (torches → light ≥ 9
so it stays mob-safe), and on **solid, dry, level ground** (never over water or a
void — fill/deck first). Put crafting tables, furnaces, and chests **inside** it,
not scattered.

## Sustaining a colony
- **Food must be renewable**, not one-off: a wheat farm beside water (harvest →
  craft bread) or animals (breed → cook). Raw wheat is not "food" until baked.
- **Store the surplus**: labeled chests inside the base (`chest_wood`, `chest_food`,
  `chest_stone`…) so the team can find and deposit things. Deposit what you gather.
- **Keep tools stocked**: an axe for wood, a pickaxe for stone/ore, a shovel for
  dirt — craft replacements before they break. Coal/charcoal feeds torches + smelting.
