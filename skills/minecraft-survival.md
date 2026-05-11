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
version: 3.2.0
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
mc dig X Y Z           # dig specific block (raw — no hazard check)
mc safe_dig X Y Z      # dig with hazard pre-check (lava/fall/suffocate)
mc scout [X Y Z] [R]   # observe hazards in a radius before mining
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

1. Mine at Y=-59: `mc move X -59 Z` (use `mc tunnel` to dig down)
2. **Scout first**: `mc scout` before any dig at depth. Lava is common at Y < 16; sand pockets can suffocate; one bad swing kills the run. `mc scout` lists lava + falling-block columns + bedrock in a radius.
3. **Use `mc safe_dig`** instead of `mc dig` at depth. It refuses if breaking a block would expose lava, drop the bot, or release a falling-block column onto its head. Returns `ok:false` with a `HAZARD_*` code so you can re-plan.
4. `mc tunnel` and `mc dig_area` also auto-abort on hazards and tell you exactly where. Resume with adjusted bounds.
5. Need iron pickaxe minimum (diamond pickaxe preferred)
6. `mc craft diamond_pickaxe` — 3 diamonds + 2 sticks
7. `mc craft diamond_sword` — 2 diamonds + 1 stick

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

## Farming for food

Once you have an iron_hoe (or wooden_hoe for early-game) you can grow your own
food. Crop cycle: till → plant → bonemeal → harvest.

1. `mc till X Y Z` — convert dirt/grass to farmland. Y is the dirt block's Y
   (not the air above). Auto-equips any hoe in inventory.
2. `mc plant wheat_seeds X Y Z` — plant at Y = farmland_y + 1 (one above
   the farmland). Works for `wheat_seeds`, `beetroot_seeds`, `carrot`, `potato`,
   `melon_seeds`, `pumpkin_seeds` on farmland; `*_sapling` and `sugar_cane`
   on dirt/grass directly.
3. `mc bonemeal X Y Z` — apply bone meal to a planted crop to accelerate
   growth. **Vanilla advances 2-5 stages per call (random).** Check
   `data.is_mature` in the response — if false, call again.
4. `mc harvest X1 Z1 X2 Z2 [Y]` — harvest mature crops in an axis-aligned
   rectangle. Skips immature crops. Drops are picked up automatically.

**Growth requires** (without these crops stall and never mature):
- **Light level ≥9** at the crop block. Place torches every ~6 blocks around
  the field if growing indoors or at night.
- **Hydrated farmland** — a water source within 4 blocks horizontally
  (same Y or 1 above). Dry farmland still grows but half-speed and reverts
  to dirt if left empty.
- Loaded chunk — the bot needs to stay nearby for growth to tick.

**Watering**: use `mc bucket_fill X Y Z` from a water source, walk to the
field, then `mc bucket_empty X Y Z` to place water within 4 blocks of the
farmland. One water source can hydrate a 9x9 farmland patch around it.

**Trampling**: standing on bare farmland reverts it to dirt. Walking on
farmland with crops on it is fine. When laying out a 3x3 patch, till + plant
each cell before moving to the next so you never have to walk across bare
farmland.

**Crop drop rules** (matters for sustainability):
- Mature wheat: 1 wheat + 1-4 seeds (always net positive on seeds).
- Mature beetroot: 1 beetroot + 1-4 seeds.
- Mature carrot/potato: 1-4 of the crop, no seed (re-plant from the crop
  itself; save 1 from each harvest).
- Immature wheat/beetroot: 1 seed only (no crop, no food).

**Maturity stages**:
- Wheat / carrot / potato: 0-7 (mature = 7).
- Beetroot: 0-3 (mature = 3).

**Wheat seeds**: harvest grass with `mc dig` to collect wheat_seeds when
you don't have any yet.

**Sugar cane**: plant on dirt/grass/sand adjacent to water. Grows up to 4
blocks tall without bonemeal.

## Animal husbandry

The four farm animals you'll work with are chickens, cows, sheep, and pigs.
All share the same vanilla mechanics: breed two adults with their food → baby
spawns → 20 min to maturity → 5 min breed cooldown afterward.

| Animal | Breeds with | Live harvest | Kill drops |
|---|---|---|---|
| Chicken | wheat_seeds (or pumpkin/melon/beetroot seeds) | Eggs auto-spawn every 5-10 min | raw_chicken + feather |
| Cow | wheat | milk via empty bucket (renewable) | beef + leather |
| Sheep | wheat | wool via shears; regrows when sheep eats grass | mutton + wool |
| Pig | carrot / potato / beetroot | none | porkchop |

### Verbs

1. `mc breed SPECIES` — feed 2 adult animals of that species. Auto-picks the
   first valid breeding item from your inventory. Returns NO_FOOD if you
   don't have enough, NO_PAIR if fewer than 2 adults are visible within 12
   blocks, ANIMAL_ON_COOLDOWN if the server rejected the feed (5-min cooldown
   still ticking).
2. `mc shear` — shear the nearest unsheared sheep within 8 blocks. Wool
   drops are picked up automatically. Returns NO_SHEARS, NO_SHEEP, or
   SHEEP_ALREADY_SHEARED.
3. `mc milk_cow` — fill an empty bucket with milk from the nearest cow.
   Returns NO_BUCKET, NO_COW.
4. `mc hunt SPECIES [COUNT]` — kill COUNT animals (default 1), auto-equip
   best weapon, run pickup pass after. Use this when an animal escapes the
   pen and luring back is impractical, or when you specifically need meat
   or feathers.
5. `mc lure SPECIES X Y Z` — walk to (X,Y,Z) holding the breeding item;
   vanilla AI makes nearby animals follow within ~10 blocks. Use this to
   return an escaped animal to the pen before resorting to `mc hunt`.

### Containment

Animals need to stay in a pen for breeding to be reliable. Build a
1-block-high fence with `mc place oak_fence` (or any fence variant); animals
cannot path-jump fences. A pen of about 5x5 holds a small flock comfortably.

**Add a gate.** Pens should have a fence_gate (`mc place oak_fence_gate X Y Z`)
on one side so the bot can enter and exit without breaching the fence. The
`mc through GX GY GZ` verb does the full sequence — opens the gate, walks to
the far side, closes the gate behind — in one call. Use it whenever you need
to enter the pen to shear, milk, or breed from inside.

**`mc through` aborts if an animal is at the gate.** Before opening, it
checks for passive mobs (chicken/cow/sheep/pig/etc.) within 1.5 blocks of
the gate and returns `ANIMAL_AT_GATE` if any are present — opening would let
them escape. On this error: wait 2-3 seconds for the animal to wander, then
retry. Repeated failures suggest the animal is "parked" near the gate; try
to lure it elsewhere with food, or just hunt it.

If a chicken escapes (chickens are flighty and follow held seeds), you have
two options:
- **Lure-into-pen** (preferred for keeping the flock alive): step-by-step
  procedure below. Works but requires care — vanilla AI is slow.
- **Hunt**: `mc hunt chicken 1` — kill it for feather + raw_chicken. Always
  reliable; use this if the chicken is too far to lure or the gate-side
  geometry is awkward.

### The lure-into-pen procedure

To return an escaped chicken to a pen without losing it, follow this
sequence (each `mc lure` call lasts ~5 seconds because chickens walk slowly
at ~0.25 b/s and need time to catch up):

1. `mc lure chicken <gate_x> <gate_y> <gate_outside_z>` — walk to a spot
   right outside the gate (e.g. one block north of the gate); the chicken
   follows you within ~2 blocks.
2. `mc interact <gate_x> <gate_y> <gate_z>` — open the gate.
3. `mc lure chicken <inside_x> <inside_y> <inside_z>` — walk INTO the pen,
   stopping somewhere mid-depth; the chicken follows through the open gate.
4. `mc lure chicken <far_x> <far_y> <far_z>` — walk DEEPER toward the far
   wall so the chicken comes all the way in, away from the gate. (Without
   this step the chicken stays in the gate aperture.)
5. `mc interact <gate_x> <gate_y> <gate_z>` — toggle the gate CLOSED.
6. `mc equip iron_sword` (or any non-seed item) — chicken stops following.
7. Wait 3-5 seconds for the chicken to drift away from the gate area.
8. `mc through <gate_x> <gate_y> <gate_z> <outside_x> <outside_y> <outside_z>`
   — exit through the gate. If you get `ANIMAL_AT_GATE`, the chicken is
   still too close — wait longer and retry.

Steps 1-7 keep the chicken inside; step 8 returns the bot to outside the pen
with the gate closed behind. The chicken is contained and alive.

### Harvest cycle through a gate

The realistic maintenance loop for a fenced pen with a gate at (gx, gy, gz):

1. `mc through gx gy gz` — enter pen (gate opens, you walk in, gate closes).
2. `mc shear` (sheep) / `mc milk_cow` (cows) / `mc breed SPECIES` / `mc pickup`
   (for eggs and dropped wool) — work from inside the pen.
3. `mc through gx gy gz <outside_x> <outside_y> <outside_z>` — exit pen
   targeting an explicit destination block OUTSIDE the pen (otherwise the bot
   may walk back to where it just came from).

The animals stay contained because the gate closes behind you twice. This is
the safest pattern — outside-the-fence-reach work (using shear/milk_cow on
animals through the fence) only succeeds when an animal happens to be within
~4 blocks of the bot's side of the fence, which gets unreliable as animals
wander.

### Farming cycle

The sustainable maintenance pattern:
1. Breed pairs every 5+ minutes (cooldown).
2. Harvest eggs (auto-spawn on ground near chickens) every visit — just `mc
   pickup` or wait for the reactive layer to handle drops.
3. Shear sheep on visit — wool regrows after they graze.
4. Milk cows on visit — bucket is reusable.
5. Hunt extra adults for meat/leather when the flock outgrows the pen.

### Gotchas

- **Fair-play view cone**: bots only see animals in their facing direction.
  If `mc breed` returns NO_PAIR but you know 2 chickens are nearby, the bot
  needs to face them — try `mc look` toward the pen first.
- **Babies don't count**: `mc breed` filters out baby animals automatically.
- **5-minute breed cooldown** is per-animal; if you re-call breed too quickly
  you'll get ANIMAL_ON_COOLDOWN.
- **Eggs**: chickens lay eggs on the ground automatically — no verb needed.
  Use `mc pickup 4` to collect them.
- **Trampling crops with animals**: animals walking on bare farmland trample
  it back to dirt, just like the bot. Keep the pen on grass, not farmland.

## Fishing and boats

### Fishing

`mc fish [TIMEOUT_SECONDS]` casts a fishing rod into nearby water, waits
for a bite (vanilla 5-30s, less in rain or with sky exposure), reels in,
and returns the catch. Default timeout 60s.

Loot table:
- ~85% fish: cod (60%), salmon (25%), pufferfish (13%), tropical_fish (2%)
- ~10% junk: bone, leather, stick, string, ink_sac, etc.
- ~5% treasure: enchanted_book, name_tag, nautilus_shell, saddle, etc.

Requirements: fishing_rod in inventory; water source block within 6 blocks
of the bot. The verb auto-positions the bot ~5-7 blocks back from water
so the bobber arc lands inside the pond.

Errors: `NO_ROD`, `NO_WATER`, `FISH_TIMEOUT` (no bite in TIMEOUT_SECONDS —
retry; sometimes the bobber lands wrong).

Rain in the test world speeds up bites significantly. Day vs night does
not matter mechanically. Each successful catch consumes 1 durability from
the rod (max 64).

### Boats

Boats let you cross water without swimming risk and carry mobs as
passengers. Crafted from 5 planks (any overworld wood).

| Verb | Effect |
|---|---|
| `mc place_boat X Y Z` | Spawn a boat on the water at (X,Y,Z). Requires `*_boat` item in inventory. PaperMCP fallback handles 1.21+ silent-no-op. |
| `mc board` | Mount the nearest boat within 6 blocks. Returns NO_BOAT if none found. Verifies via the boat's passenger list and uses a PaperMCP `ride mount` fallback if native doesn't stick. |
| `mc sail X Y Z` | Propel a mounted boat to (X,Y,Z). Tries native rider input first; if the boat doesn't move within 1.5s (Paper 1.21+ doesn't always give the rider control), falls back to server-side tp-stepping the boat 1.5 blocks per tick toward the target. Auto-stops within 2 blocks. Returns OUT_OF_RANGE if stuck. |
| `mc disembark` | Exit the current vehicle. PaperMCP fallback uses server-side `ride dismount`. |

Typical crossing pattern:
1. `mc place_boat <waterX> <waterY> <waterZ>` next to your shore.
2. `mc board` to enter the boat.
3. `mc sail <farX> <farY> <farZ>` to drive the boat across. The verb
   handles steering AND the propulsion fallback when the rider isn't
   recognized as the boat's controller.
4. `mc disembark` to step out.
5. `mc goto <shoreX> <shoreY> <shoreZ>` if the boat stopped short of
   solid ground (e.g., last 1-2 blocks of swimming or walking).

Don't substitute `mc goto` for `mc sail` while mounted — `mc goto`
runs the pathfinder which doesn't understand boats, so the bot just
swims while the boat sits unused.

Boats float on water and survive land contact (modern MC). They take
damage from explosions, fire, lava, cactus, and mob attacks. A destroyed
boat drops as an item to be picked up.

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

### Pick the smallest verb for the question

Every `mc` call adds tokens to your context. Use the narrowest verb that
answers what you actually need:

| Question | Verb | Typical size |
|---|---|---|
| Where am I? Am I alive? | `mc health` | ~0.2 KB |
| What do I have? | `mc inventory` | ~0.4 KB |
| What block am I looking at? | `mc look` | ~0.3 KB |
| What's in front of me? | `mc map 16` | ~1.7 KB |
| Counts of nearby blocks? | `mc nearby 16` | ~0.4 KB |
| Quick game state + goals? | `mc status` (lean default) | ~1-2 KB |
| Same + recent_actions? | `mc observe` (lean default) | ~2 KB |
| Full goal objects + plan hints? | `mc observe --full` | ~7-10 KB |
| Every visible block's coords? | `mc scene` | ~10 KB (heavy!) |

`mc status` and `mc observe` default to **lean** mode — they cap nearby
entities/blocks, trim goals to {id, urgency, satisfied, gap}, and drop
plan_hints/dashboard_signals/action_stats. Add `--full` if you genuinely
need the verbose view. The lean default is 60-80% smaller and almost
always sufficient.

## When stuck

- Same action fails 3× → try something different
- `collect` fails → `mc nearby 32` for coords, then `mc goto_near`
- Navigation fails → `mc stop`, try `mc goto_near` with higher Y
- Falling in hole → `mc goto X Y+10 Z` or pillar up with dirt
- Craft fails → `mc recipes ITEM`
- Screen stuck → `mc close`
