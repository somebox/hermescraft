---
name: minecraft-survival
description: "Minecraft survival progression — phase-by-phase from first day through Nether. Crafting recipes, smelting rules, home base setup, block/item name reference. Load when starting fresh, crafting, smelting, setting up base, or checking item/block names."
triggers:
  - play minecraft
  - minecraft survival
  - beat the ender dragon
  - survive in minecraft
  - minecraft agent
  - craft recipe
  - smelt furnace
  - block names
  - item names
  - home base
  - crafting table
version: 3.1.0
---

# Minecraft Survival — Master Skill

## Tools

You control your Minecraft bot via the `mc` CLI in the terminal:
```
mc status              # see everything — health, pos, inventory, nearby, chat
mc inventory           # detailed categorized inventory
mc nearby              # blocks + entities nearby
mc read_chat           # read player messages
mc collect BLOCK N     # find and mine N blocks (e.g. mc collect oak_log 5)
mc craft ITEM [N]      # craft item (need crafting table nearby for 3x3)
mc recipes ITEM        # look up crafting recipe ingredients
mc smelt INPUT         # smelt in nearby furnace
mc goto X Y Z          # pathfind to position
mc goto_near X Y Z     # pathfind near position
mc follow PLAYER       # follow a player
mc attack [target]     # attack nearest hostile (or specific mob)
mc eat                 # eat best food in inventory
mc equip ITEM          # equip tool/weapon to hand
mc place BLOCK X Y Z   # place block at position
mc dig X Y Z           # dig specific block
mc find_blocks BLOCK   # search for block locations
mc pickup              # collect nearby item drops
mc chat "message"      # say something in game chat
mc stop                # stop all movement
```

## Game Loop (NEVER break this)

```
OBSERVE → THINK → PLAN → ACT → OBSERVE → ...
```

1. **OBSERVE**: Run `mc status` (and often `mc inventory` before mining trips).
2. **THINK**: Phase, threats, what you need next?
3. **PLAN**: For any gather or fight — prerequisites in inventory? Correct tool? Use `mc craft_plan ITEM` when unsure.
4. **ACT**: Run `mc` commands (one focused action or a short batch; observation can be parallelized).
5. **REPEAT**: After substantive moves, observe again.

**Tools:** Before `mc collect` on **wood**, have an **axe** equipped or in inventory (server will prefer an axe if you have one). Stone/ore needs a **pickaxe**. Do not hold a pickaxe for logs.

**Anti-pattern:** Chaining many tiny steps (“collect 1, status, collect 1…”) without a stated batch target or tool check — instead set a **trip target** (e.g. 16 logs), verify axe + table if crafting after, then `mc collect oak_log 16` or `mc bg_collect`.

## Priority System (check in order)

1. **EMERGENCY** (health ≤ 6): `mc eat`. If no food, flee from threats.
2. **EAT** (food ≤ 14): `mc eat` before doing anything else.
3. **NIGHT DANGER** (not day + no weapons/shelter): Build shelter or craft weapons NOW.
4. **HOSTILE MOB** (within 5 blocks + have weapon): `mc attack` or flee.
5. **CHAT** — respond to player messages via `mc chat`.
6. **PROGRESS**: Follow current phase objectives.

## Phase Progression

### Phase 1: First Day (0 → stone tools)
Goal: stone tools + crafting table + furnace + shelter

1. `mc collect oak_log 4` — punch trees
2. `mc craft oak_planks 4` — logs → planks
3. `mc craft stick` — planks → sticks
4. `mc craft crafting_table` — 4 planks → table
5. Find flat ground, `mc place crafting_table X Y Z`
6. `mc craft wooden_pickaxe` — need table nearby
7. `mc craft wooden_axe` — same tier as pick; **use axe for all wood** (`*_log`, stems)
8. `mc equip wooden_axe` then `mc collect oak_log 12` — batch wood with the right tool
9. `mc collect cobblestone 20` — uses pickaxe (equip `wooden_pickaxe` if needed)
10. `mc craft stone_pickaxe` + `mc craft stone_sword` — upgrade after cobble run
11. `mc craft furnace` — 8 cobblestone
12. `mc collect coal_ore 5` (or smelt logs for charcoal)
13. `mc craft torch 4` — coal + stick
14. Kill animals for food: `mc attack cow` / `mc attack pig` / `mc attack sheep`
15. `mc pickup` to collect drops
16. Smelt raw meat: `mc smelt raw_beef`
17. Build shelter: dig into hillside or build 5x5 cobblestone walls

**Phase complete when**: stone pickaxe + stone sword + furnace + shelter + food

### Phase 2: Iron Age
Goal: iron tools + shield + bucket

1. `mc find_blocks iron_ore` — find iron (Y=0 to Y=64)
2. `mc collect iron_ore 11` — need 11+ ingots
3. `mc smelt raw_iron` — raw iron → iron ingots
4. `mc craft iron_pickaxe` — 3 iron + 2 sticks
5. `mc craft iron_sword` — 2 iron + 1 stick
6. `mc craft shield` — 1 iron + 6 planks
7. `mc craft bucket` — 3 iron ingots

**Phase complete when**: iron pickaxe + iron sword + shield + bucket

### Phase 3: Diamonds
Goal: diamond gear + enchanting table

1. Mine at Y=-59: `mc goto X -59 Z` then `mc collect deepslate_diamond_ore 5`
2. Need iron pickaxe minimum (diamond pickaxe preferred)
3. `mc craft diamond_pickaxe` — 3 diamonds + 2 sticks
4. `mc craft diamond_sword` — 2 diamonds + 1 stick

### Phase 4: Nether
Goal: nether access + blaze rods + ender pearls

1. Get 10 obsidian (water + lava source, mine with diamond pick)
2. `mc craft flint_and_steel` — 1 iron + 1 flint
3. Build 4x5 obsidian frame, light with flint and steel
4. Enter nether, find fortress
5. Kill blazes for blaze rods, endermen for pearls
6. Craft eyes of ender → find stronghold → beat the dragon

## Key Recipes (quick reference)

- Planks: 1 log → 4 planks
- Sticks: 2 planks → 4 sticks
- Crafting table: 4 planks
- Wooden pickaxe: 3 planks + 2 sticks (needs table)
- Wooden axe: 3 planks + 2 sticks (needs table) — use for `*_log` / stems
- Stone pickaxe: 3 cobblestone + 2 sticks (needs table)
- Furnace: 8 cobblestone (needs table)
- Torch: 1 coal + 1 stick → 4 torches
- Chest: 8 planks (needs table)

Use `mc recipes ITEM` to look up any recipe you're unsure about.

## Crafting & smelting rules

**Before crafting, always:**
1. `mc inventory` — do you have the materials?
2. `mc recipes ITEM` — check requirements (don't guess!)
3. `mc nearby 8` — crafting_table within reach? If not, craft + place one first.
4. `mc craft ITEM` then `mc inventory` to verify.

**Crafting table needed for**: all tools, weapons, armor, furnace, doors, chest, shield, bucket, bow — everything except planks, sticks, and the table itself.

**Smelting** requires a placed furnace. Only smelt: raw_iron, raw_gold, raw_copper, raw_beef, raw_porkchop, raw_chicken, raw_cod, raw_salmon, sand (→glass), cobblestone (→stone), oak_log (→charcoal). Do NOT smelt gravel, dirt, or random blocks.

**Before placing blocks**: `mc equip BLOCK` first, then `mc place BLOCK X Y Z`. Read coordinates from `mc status` output — don't guess.

Common recipes:
- 1 log → 4 planks (no table)
- 2 planks → 4 sticks (no table)
- 4 planks → crafting_table (no table)
- 3 material + 2 sticks → pickaxe (table)
- 2 material + 1 stick → sword (table)
- 3 planks + 2 sticks → axe (table)
- 8 cobblestone → furnace (table)
- 1 coal + 1 stick → 4 torches (table)
- 8 planks → chest (table)
- 6 planks → 3× oak_door (table)
- 4 planks + 2 sticks → 3× oak_fence (table)
- 2 planks + 4 sticks → oak_fence_gate (table)
- 3 wool + 3 planks → bed (table)

## Home base setup

When you first join or settle an area:
1. Find the player — `mc follow PLAYER`
2. Mark home — `mc mark home "base camp"`
3. Ensure crafting table — `mc nearby 16`, if none: `mc craft crafting_table` → equip → place
4. Ensure chest — `mc craft chest` (8 planks) → place near table
5. Ensure furnace — `mc craft furnace` (8 cobblestone) → place
6. Use `mc go_mark home` to return

Deposit extras in chests before dangerous trips. Return to base to deposit after gathering.

## Block & item names (use EXACT names with mc commands)

**Wood**: oak_log, birch_log, spruce_log, dark_oak_log, jungle_log, acacia_log → oak_planks, birch_planks, etc. → stick
**Stone**: stone, cobblestone, granite, diorite, andesite, deepslate, cobbled_deepslate
**Ores**: coal_ore, iron_ore, copper_ore, gold_ore, diamond_ore, lapis_ore, redstone_ore, emerald_ore (NOT "coal", "iron")
**Raw/Ingots**: raw_iron, raw_gold, raw_copper → iron_ingot, gold_ingot, copper_ingot (smelt raw_ to get ingots)
**Drops**: coal (from coal_ore), diamond (from diamond_ore), lapis_lazuli, redstone
**Dirt/Sand**: dirt, grass_block, sand, gravel, clay
**Tools**: wooden_pickaxe, stone_pickaxe, iron_pickaxe, wooden_sword, stone_sword, iron_sword, wooden_axe, stone_axe
**Food**: bread, cooked_beef, cooked_porkchop, apple, golden_apple
**Building**: glass, torch, ladder, chest, crafting_table, furnace, door (oak_door, iron_door)
**Plants**: oak_sapling, wheat_seeds, sugar_cane, bamboo

## Situational awareness

- **Y coordinate**: Y=62-70 is surface, Y<58 means underground, Y>100 is mountain
- **If underground**: `mc goto X 80 Z` to pathfind to surface
- **Can't see blocks**: stuck in terrain — `mc look`, then `mc goto` upward or dig out
- **Use mc map 16** when disoriented
- After EVERY movement, `mc status` to check position

## When stuck

- Same action fails 3× → try something different
- `collect` fails → `mc nearby 32` for coords, then `mc goto_near`
- Navigation fails → `mc stop`, try `mc goto_near` with higher Y
- Falling in hole → `mc goto X Y+10 Z` or pillar up with dirt
- Craft fails → `mc recipes ITEM`
- Screen stuck → `mc close`
