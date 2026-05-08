---
name: minecraft-farming
description: "Food production in Minecraft — wheat/crop farming, animal breeding with mc feed_mob, chicken coops, cooking, food rankings. Load when building farms, breeding animals, growing crops, low on food, or planning food infrastructure."
triggers:
  - minecraft farm
  - grow food minecraft
  - minecraft food
  - breed animals
  - wheat farm
  - chicken coop
  - plant seeds
  - harvest crops
  - food supply
version: 3.1.0
---

# Minecraft Farming

## Commands

```
mc collect CROP N        # harvest crops
mc place SEEDS X Y Z     # plant seeds
mc craft ITEM             # craft farming tools
mc smelt RAW_FOOD         # cook food in furnace
mc attack ANIMAL          # kill for meat
mc find_blocks BLOCK      # find farmland, water, crops
mc interact X Y Z         # use hoe on dirt
mc use                    # use held item (bone meal, etc)
mc feed_mob MOB           # right-click mob with held food (breeding); optional --item ITEM
```

## Quick Food (Early Game)

Fastest way to not starve:

1. Kill animals: `mc attack cow`, `mc attack pig`, `mc attack chicken`
2. `mc pickup` — collect raw meat
3. `mc smelt raw_beef` (or raw_porkchop, raw_chicken)
4. Cooked steak = 8 food points (best common food)

## Crop Farming

### Setup
1. Craft hoe: `mc craft stone_hoe`
2. Find water or `mc place water_bucket X Y Z`
3. Till dirt near water: equip hoe, `mc interact X Y Z` on dirt blocks
4. Get seeds: break grass with hand → wheat seeds
5. Plant: `mc place wheat_seeds X Y Z` on farmland

### Harvest
- Wheat grows in ~20 minutes. Fully grown = golden color.
- `mc collect wheat N` — harvest mature wheat
- `mc craft bread` — 3 wheat → 1 bread (6 food points)

### Best Crops
- **Wheat**: bread (6 food) — easy, found everywhere
- **Carrots**: eat raw (3 food) or golden carrot (6 food + saturation)
- **Potatoes**: bake in furnace (5 food) — excellent
- **Beetroot**: beetroot soup (6 food) — decent

## Animal Farming

### Breeding
1. Build fenced enclosure: `mc craft oak_fence` — **Java recipe:** 4 matching planks + 2 sticks = **3 fences** (not 2+4). Gate: 2 planks + 4 sticks = 1 gate. Use `mc recipes oak_fence` to confirm. **`mc place`** fence blocks along the edge in order; in Java they auto-connect to adjacent fence blocks (and to solid blocks).
2. Lure or contain two adults of the same species.
3. **`mc feed_mob cow --item wheat`**, then the same on a second cow (or `mc equip wheat_seeds` then **`mc feed_mob chicken`** twice). Chickens: wheat_seeds; cows/sheep: wheat; pigs: carrot/potato/beetroot; rabbits: carrot/golden carrot/dandelion.

### Animal Products
- **Cow**: raw beef (cook it), leather
- **Pig**: raw porkchop (cook it)
- **Chicken**: raw chicken (cook it), feathers, eggs
- **Sheep**: wool (shear or kill), raw mutton

## Chicken eggs & coops (efficiency)

Sourced from the [Minecraft Wiki egg-farming tutorial](https://minecraft.fandom.com/wiki/Tutorials/Egg_farming) — patterns the bot can help *build block-by-block*; redstone clocks, comparator “full chest” displays, and lava cookers stay manual unless you add dedicated `mc` actions.

### Why chickens scale differently
- Adults **lay eggs on a timer** (~wiki: about one egg every 5–10 minutes per chicken; **~8 eggs/hour average** cited on the page). Throwing an egg has only a **1/8** chance to hatch a chick — stock **many eggs** before expecting a flock.
- **No food is required** for growth or for eggs to appear; **seeds are only for breeding** and luring. Use `mc feed_mob` with two adults when you want more breeders.
- **Baby chickens take ~20 minutes** to mature. Farm chunks should stay **loaded** (near a player or spawn chunks) or timers won’t advance. **Skipped nights do not count** toward grow-up time on the wiki’s explanation.
- **Dropped eggs despawn after 5 minutes** — collection matters.

### Pen design (wiki highlights)
- **Entry lock**: a small fenced antechamber with **two gates** (pen vs outside). Keep **one gate closed** so pathfinding does not show a straight escape path.
- **Luring**: hold **any seeds** — `mc equip wheat_seeds` then walk; or use **`mc feed_mob`** / leads if you add lead handling manually.
- **Java `maxEntityCramming`**: cramming many mobs in one block can cap at **24** and cause damage; the wiki notes a **vines** trick in the cramming cell in some designs — confirm server rules before relying on it.
- **Water containment**: many schematics use **water** so chickens don’t clip through fences; eggs wash toward **hoppers**. Signs or ladders can hold water above a collection gap.
- **Lighting**: lit floors/roofs reduce drowned chicks at edges and block hostile spawns inside the farm.
- **Scaling up**: compact **hopper + chest** pits, **11×11** fenced layouts with buried “egg rooms,” and **flowing water** variants funnel eggs to one tile — pick one tier that matches your iron/redstone budget.

### What stays manual vs API
- **Hermes can**: fence/gate placement, water bucket placement, luring with seeds, `mc feed_mob` breeding, killing selected chickens (`mc attack chicken`), pickup, smelting.
- **Hermes cannot (today)**: throw eggs, flick levers on egg clocks, refill droppers, or run lava blade cookers without you (or future automation commands).

## Project: Wheat Farm (9x9)

A 9x9 wheat farm is the standard efficient layout — every farmland block is within 4 blocks of water.

### Materials
- stone_hoe ×1 (`mc craft stone_hoe` — 2 cobblestone + 2 sticks, needs table)
- water_bucket ×1 (craft bucket: 3 iron_ingot; fill at water source)
- wheat_seeds ×18+ (break short_grass/tall_grass with hand until you have enough)
- oak_fence ×24 or more (4 planks + 2 sticks → 3 fences, needs table)
- oak_fence_gate ×1 (2 planks + 4 sticks, needs table)
- torch ×4+ for lighting

Use `mc craft_plan stone_hoe` and `mc craft_plan oak_fence` to check what you're missing.

### Build sequence
1. **Find flat 11×11 area** near base (fences go around the 9×9 interior). `mc nearby 32` for flat ground. Mark site: `mc mark wheat_farm "planned 9x9 farm"`
2. **Clear the area** — `mc dig` any obstructions, level ground
3. **Dig center hole** — one block deep at the center of the 9×9 for water
4. **Place water** — `mc equip water_bucket` → `mc place water_bucket X Y Z` in the hole. Water hydrates farmland within 4 blocks.
5. **Till farmland** — equip stone_hoe, `mc interact X Y Z` on each dirt/grass_block in the 9×9 area (skip the water block). Farmland must be within 4 blocks of water.
6. **Plant seeds** — `mc place wheat_seeds X Y Z` on each farmland block
7. **Fence perimeter** — place oak_fence around the edge, oak_fence_gate for entry
8. **Light it** — place torches on fence posts or nearby to prevent mob spawns and allow night growth
9. **Mark done** — update memory with location and completion status

### Harvest & maintain
- Wheat grows in ~20 real-time minutes (chunk must be loaded).
- Fully grown wheat is golden/brown. `mc collect wheat N` to harvest.
- Replant immediately: `mc place wheat_seeds X Y Z` on each cleared farmland.
- `mc craft bread` — 3 wheat → 1 bread (5 food, 6 sat).
- Save memory note: "periodically check wheat_farm: harvest mature wheat, replant, check fences."

## Food Rankings (food points + saturation)

```
Golden carrot:     6 food, 14.4 sat  (best overall)
Cooked steak:      8 food, 12.8 sat  (best farmable)
Cooked porkchop:   8 food, 12.8 sat  (tied with steak)
Baked potato:      5 food, 6.0 sat   (easy to mass produce)
Bread:             5 food, 6.0 sat   (easy early game)
Cooked chicken:    6 food, 7.2 sat   (decent)
Apple:             4 food, 2.4 sat   (oak tree drops)
```
