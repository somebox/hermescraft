---
name: minecraft-farming
description: "Food production in Minecraft — quick reference for crop cycles, animal breeding, cooking, and food selection. Focused decision guide; full mechanics (worked example, gotchas, lure/gate procedures) live in minecraft-survival."
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
version: 4.0.0
---

# Minecraft Farming — focused quick reference

This skill is the **decision guide** for food work. For full mechanics
(9×9 worked example, animal containment + lure procedures, chicken-coop
scaling notes, fishing + boats), load
[minecraft-survival](minecraft-survival).

## Verbs

```
# Crops (full cycle: till → plant → bonemeal → harvest)
mc till X Y Z                    # auto-equips any hoe; dirt/grass → farmland
mc plant SEED X Y Z              # wheat_seeds, beetroot_seeds, carrot, potato,
                                 # melon_seeds, pumpkin_seeds on farmland (Y above);
                                 # *_sapling, sugar_cane on dirt/grass
mc bonemeal X Y Z                # advance 2-5 growth stages (data.is_mature flag)
mc harvest X1 Z1 X2 Z2 [Y]       # mature crops in rectangle; skips immature; pickup

# Water
mc bucket_fill X Y Z             # from a water source
mc bucket_empty X Y Z            # place water (hydrates 9×9 farmland around it)

# Animals
mc breed SPECIES                 # auto-picks feed from inventory (rules below)
mc lure SPECIES X Y Z            # walk holding feed; animals follow ~10 blocks
mc hunt SPECIES [COUNT]          # auto-equip best weapon, kill, pickup
mc shear                         # nearest unsheared sheep within 8 blocks
mc milk_cow                      # fill empty bucket from nearest cow
mc feed_mob TARGET [--item ITEM] # generic right-click-with-item (rarely needed)

# Misc
mc fish [TIMEOUT_S]              # 5-30s vanilla per cast; needs fishing_rod + water
mc smelt RAW_FOOD [FUEL] [N]     # cook in nearest reachable furnace
mc find_blocks BLOCK [R]         # locate farmland, water, crops, mature crops
mc find_entities SPECIES [R]     # count adults before breed/hunt decisions
mc inspect X Y Z                 # crop maturity (data.is_mature)
```

## Food source decision

Combined cooked + bread stockpile low? Scan once, pick the cheapest source:

```
mc nearby 16                     # what's already in sight?
mc find_entities cow 32          # adults of a species?
mc find_blocks wheat 32          # mature crops?
```

| If you see… | Do this | Why |
|---|---|---|
| 3+ adult cows/pigs nearby | `mc hunt cow 2` (leave ≥2 adults) | Fastest; raw_beef + leather in one pass |
| Mature crops | `mc harvest X1 Z1 X2 Z2` then `mc plant` seeds back | Sustainable; net-positive seeds for wheat/beetroot |
| 2+ adults + matching feed | `mc breed SPECIES` | Replenishes flock; baby in 20 min |
| Just water + rod, nothing else | `mc fish` | Last resort; slow but works anywhere |
| Nothing nearby | Skip food chore | Player will restock feed/seeds |

## Breeding feed (auto-picked by `mc breed`)

| Species | Feed | Notes |
|---|---|---|
| Cow / Sheep | `wheat` | Wheat ×2 = one breed cycle |
| Chicken | `wheat_seeds` (also pumpkin/melon/beetroot seeds) | Cheap |
| Pig | `carrot` / `potato` / `beetroot` | Use whichever you have surplus of |
| Rabbit | `carrot` / `golden_carrot` / `dandelion` | |

5-minute breed cooldown per animal (`ANIMAL_ON_COOLDOWN` if too soon). Babies mature in ~20 min of loaded-chunk time.

## Crop cycle

```
mc till X Y Z                    # Y = the dirt block (not the air above)
mc bucket_empty X Y Z            # water within 4 blocks of farmland (one source = 9×9 patch)
mc plant wheat_seeds X Y+1 Z     # seed goes one cell ABOVE the farmland
mc bonemeal X Y+1 Z              # optional; advances 2-5 stages
mc harvest X1 Z1 X2 Z2           # picks up drops; skips immature
```

**Growth requires** (else crops stall):
- Light level ≥ 9 (place torches every ~6 blocks if indoors/night)
- Hydrated farmland (water within 4 blocks horizontally)
- Loaded chunk (bot stays nearby for growth to tick)

**Crop drop economics**:
- Wheat / beetroot mature: 1 crop + 1–4 seeds (net-positive seeds)
- Carrot / potato mature: 1–4 crop drops, **no seed** — replant from the crop itself, save 1 each harvest
- Immature wheat/beetroot: 1 seed only (no food, no crop)

**Trampling**: standing on bare farmland reverts it to dirt. Walk on planted farmland only.

## Cooking (raw → food)

```
mc smelt raw_beef coal 8         # foreground; ~16s/item, returns when done
mc smelt_start raw_beef 8        # background; returns task_id (see minecraft-chores)
```

Smeltable: `raw_beef`, `raw_porkchop`, `raw_chicken`, `raw_mutton`, `raw_rabbit`, `raw_cod`, `raw_salmon`, `potato` (→ baked_potato).

## Food rankings (food points + saturation)

```
Golden carrot:   6 food, 14.4 sat   (best overall)
Cooked steak:    8 food, 12.8 sat   (best farmable)
Cooked porkchop: 8 food, 12.8 sat   (tied with steak)
Cooked chicken:  6 food,  7.2 sat
Baked potato:    5 food,  6.0 sat   (mass-produces easily)
Bread:           5 food,  6.0 sat   (easy early game)
Apple:           4 food,  2.4 sat   (oak tree drops)
```

## When to load minecraft-survival instead

- Building a new farm from scratch → 9×9 worked example with the full
  `mc level` / `mc till` / `mc plant` / `mc fence` sequence.
- Animal escaped the pen → lure-into-pen 8-step procedure +
  `ANIMAL_AT_GATE` handling.
- Chicken coop planning → scaling notes (egg timings, hatch rate,
  `maxEntityCramming` cap, what's out-of-scope for `mc`).
- Fishing/boats deep dive, block/item name reference.
