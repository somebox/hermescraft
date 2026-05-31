---
name: minecraft-chores
description: "Routine base-maintenance chores — cook food, smelt ore, stock crafting staples, organize chests, plant saplings. Load when idle, between missions, or when the player asks for general 'keep the base productive' work."
triggers:
  - minecraft chores
  - routine maintenance
  - keep the base productive
  - smelt ore
  - cook food
  - organize chest
  - plant sapling
  - stock supplies
version: 1.1.0
---

# Minecraft — Routine chores

Canonical `mc` syntax and chore-related recovery hints: [`docs/mc-commands.md`](../docs/mc-commands.md) (Section D–E).

When no one is directing you and you're at the base, run through this
list in priority order. Each chore has a simple "is it needed?" check
so you don't waste turns on chores that are already done.

## Priority order

1. **Source food** — if cooked-meat stockpile is low, GET more meat
   first (hunt, breed, fish, harvest crops) before cooking
2. **Cook food** — raw meat in inventory/chests → cooked
3. **Smelt ore** — raw ore + fuel → ingots
4. **Stock crafting staples** — planks, sticks, torches
5. **Plant saplings** — if you've harvested logs recently
6. **Organize chests** — only if a chest is clearly chaotic

Stop when nothing needs doing. Don't invent work.

## Important: "goal" vs "what's in my pockets"

The `mc goals` scoreboard tracks **base stockpile** — what's in your
inventory AND in your base chests combined. A goal like `maintain_wood
(gap=64)` means "the base could use 64 more wood", NOT "I personally
need 64 wood right now".

So **don't take items out of base chests just to satisfy a goal** —
that's circular (the wood just moves from chest to your pockets, total
base stock unchanged). Instead, satisfy goals by **producing new
supply**:

- `maintain_wood` gap → chop a tree, don't `mc withdraw` from chest
- `maintain_food` gap → hunt/fish/cook, don't withdraw cooked_beef
- `maintain_stone` gap → mine cobblestone outside base

Use `mc withdraw` only when you need an item TO USE (e.g. tools to
mine, fuel to smelt), not to "satisfy a stockpile goal".

## Crafting stations: reuse, don't litter

The bot's `mc craft` action already searches for a crafting_table:
within 4 blocks → within 32 blocks (pathfinds) → saved marks. **Before
placing a new one, exhaust those options:**

```
mc find crafting_table         # scans inventory + chests + visible blocks (default scan 32)
mc find crafting_table scan_range=64
mc marks                        # any saved table marks?
```

If a known table is within ~64 blocks, `mc goto_near` to it and craft
there. Don't litter the landscape with one-off tables.

**If you must place a new station for a remote craft, mine it back
when done:**
```
mc place crafting_table X Y Z
mc craft <item> <count>
# After crafting:
mc dig X Y Z                    # recovers the crafting_table to inventory
mc pickup
```
Same applies to furnaces. At the base / known stations, leave them.
Far from base, recover them — they're 4 planks each and clutter adds up.

**Mark useful permanent stations** with descriptive names:
```
mc mark forge_table             # at the crafting_table you'll keep using
mc mark forge_furnace
```
Future `mc find crafting_table` will surface them.

## 1. Source food

**When:** combined cooked-meat + bread in inventory + food-chest < 8,
AND no raw meat already waiting to be cooked (otherwise jump to chore 2).

**Pick the cheapest source first** — don't go on a hunting safari when
crops are ready to harvest. Scan in order:

```
mc nearby 16                  # animals/crops within sight?
mc find_entities cow 32       # OR scan wider for a species
mc find_blocks wheat 32       # mature crops nearby?
```

Then pick one source and act. Verb details (breeding feed rules,
`mc lure`/`mc through` for pens, gate hazards) live in
[minecraft-survival](minecraft-survival) — this is the priority logic:

| Source | Verb | When |
|---|---|---|
| Hunt | `mc hunt cow 2` | Cows/pigs/chickens in sight; leave ≥2 adults per species to repopulate |
| Crop harvest | `mc harvest X1 Z1 X2 Z2` | Mature crops already farmed (`mc find_blocks wheat`); replant seeds with `mc plant` after |
| Breed | `mc breed cow` | 2+ adults AND right feed in inventory; auto-picks feed |
| Plant | `mc plant wheat_seeds X Y Z` | Have seeds + nearby farmland (`mc find_blocks farmland`); `mc bonemeal X Y Z` to accelerate |
| Fish | `mc fish` | Last resort — works anywhere with water + fishing_rod (5–30s per cast) |

If none of those apply (no animals, no crops, no rod), skip food chore
this round — the player will notice and restock feed/seeds.

## 2. Cook food

**When:** raw_beef / raw_porkchop / raw_chicken / raw_mutton /
raw_rabbit anywhere in inventory or food-chest. OR cooked_beef stash
< 8.

**How:** `mc smelt` / `mc smelt_start` auto-pick the closest reachable
furnace (no coords needed). `mc furnace_check` / `mc furnace_take`
target a specific furnace and DO need coords (use the X Y Z from
`mc furnaces`).

```
mc furnaces                            # GET — lists known furnaces with X Y Z
mc smelt raw_beef coal 8               # FOREGROUND: blocks ~16s/item, returns when done
# OR background:
mc smelt_start raw_beef 8              # returns a task_id instantly
# ... do other chores ...
mc furnace_check FX FY FZ              # status of a specific furnace
mc furnace_take FX FY FZ               # withdraw smelted output
```

If the furnace is busy, leave it and try a different furnace, or pick
another chore.

**Smelting table (raw → product, 1 coal = 8 items):**
| Input | Output | Notes |
|---|---|---|
| raw_beef | cooked_beef | best food, restores 8 hunger |
| raw_porkchop | cooked_porkchop | same as beef |
| raw_chicken | cooked_chicken | small drop, useful |
| raw_mutton | cooked_mutton | |
| raw_rabbit | cooked_rabbit | rare |
| potato | baked_potato | |
| raw_cod / raw_salmon | cooked_cod / cooked_salmon | |

## 3. Smelt ore

**When:** raw_iron, raw_copper, raw_gold, cobblestone (→ stone for
build) in inventory or ore-chest. AND fuel (coal / charcoal) available.

**How:** same workflow as cooking. Output goes into the bottom slot;
take with `mc furnace_take`.

**Smelting table:**
| Input | Output | Use |
|---|---|---|
| raw_iron | iron_ingot | iron tools/armor |
| raw_copper | copper_ingot | decorative; lower priority |
| raw_gold | gold_ingot | clocks, rails |
| cobblestone | stone | smooth blocks, build material |
| sand | glass | windows |
| clay_ball | brick | building |

**Fuel guide (smelts per unit):**
- coal / charcoal: 8 items
- coal_block: 80 items
- 4 oak_planks: 6 items (last resort — burn planks only if no coal)

## 4. Stock crafting staples

**When:** any of these are below threshold in the materials chest:
- oak_planks < 32 (½ stack)
- stick < 16
- torch < 16

**How (every `withdraw`/`deposit` needs a chest target — coords or @mark;
there is no implicit "currently open" chest):**
```
mc find oak_log                       # locate logs across inventory + chests + nearby blocks
mc chest_search oak_planks            # OR: search cached chest snapshots by item
mc chest @materials_chest             # open the chest (peek inventory)
mc withdraw oak_log 4 @materials_chest
mc craft oak_planks 16                # 4 logs → 16 planks
mc craft stick 32                     # 4 planks → 16 sticks (so 8 planks = 32 sticks)
mc craft torch 16                     # 1 coal + 1 stick → 4 torches
mc deposit oak_planks 16 @materials_chest   # put surplus back
mc deposit stick 16 @materials_chest
mc deposit torch 16 @materials_chest
```

If you don't yet have a `@materials_chest` mark, walk to the chest and
`mc mark materials_chest`. Coords (`X Y Z`) work in place of `@mark`
everywhere here.

Aim for a small surplus (1–2 stacks each), not warehouse quantities.

## 5. Plant saplings

**When:** you have oak_sapling / birch_sapling / spruce_sapling /
jungle_sapling / acacia_sapling / dark_oak_sapling in inventory AND
you've chopped trees recently (replant rule: leave the area more
forested than you found it).

**Where to plant:**
- On grass_block, dirt, podzol, or coarse_dirt
- Open sky overhead (no roof — saplings need light to grow)
- ≥ 4 blocks of air above for the tree to grow into
- ≥ 1 block lateral spacing from other saplings / trees / walls

**How:**
```
mc find_blocks grass_block 16   # find open ground nearby
mc move @home                 # don't plant too far from base
# pick a coord with clear sky:
mc plant oak_sapling X Y Z      # Y = grass_block_y + 1 (one cell above ground)
```

Plant 3-6 saplings per chore round. Don't try to forest the whole area.

## 6. Tree-cutting rules (when you DO need wood)

**Never chop:**
- A sapling (the 1-tall placeholder item — you'd destroy it for nothing)
- A "small tree" — fewer than 4 stacked log blocks. It hasn't grown yet
  and chopping it gives you 1-2 logs vs. waiting for full size

**Do chop:**
- Full-grown trees: 5+ stacked log blocks
- Replant the harvested area: after chopping, place a sapling on the
  dirt/grass where the trunk was

To check a tree before chopping:
```
mc inspect X Y Z       # is it oak_log? walk up the trunk to count
```

## 7. Chest organize (light touch)

This is mostly covered by your soul prompt's autonomous-mode rules.
Only intervene if a chest is clearly chaotic (>5 different item types
mixed). Move items into themed chests:
- **food** — cooked meat, bread, raw food, seeds
- **wood** — logs, planks, saplings, sticks
- **stone** — cobblestone, stone, smooth stone
- **ore** — raw and smelted ores
- **tools** — pickaxes, axes, shovels, torches, flint+steel
- **misc** — everything else

Don't reshuffle a chest the player has clearly organized themselves
(e.g. armor sorted by tier).

## When NOT to do chores

- A player is whispering you — STOP, respond to them first.
- You're below half HP or food < 6 — eat / heal / retreat first.
- Night with hostiles nearby — go inside the house and wait.
- You have an unresolved player command in `mc cmds` — finish that first.

Chores are filler for genuine idle time, not a way to look busy.
