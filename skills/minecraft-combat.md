---
name: minecraft-combat
description: "Combat strategies for every Minecraft mob — weapon priority, mob-specific tactics (creeper, skeleton, enderman, etc.), when to fight vs flee, health thresholds. Load when hostiles are nearby, health is low, preparing for dangerous areas, or entering the Nether."
triggers:
  - minecraft combat
  - fight mobs
  - minecraft attack
  - kill mobs
  - skeleton
  - creeper
  - enderman
  - zombie
  - nether combat
  - low health
version: 4.0.0
---

# Minecraft Combat

## Commands

```
# Engage
mc attack [TARGET]          # single swing on nearest hostile or named target
mc fight TARGET             # loop attacks until dead or HP threshold (auto-equips weapon)
mc sprint_attack TARGET     # sprint-in for knockback hit
mc crit TARGET              # jump-attack for critical-hit damage
mc strafe TARGET            # sidestep while attacking (kiting)
mc combo TARGET             # pre-defined attack sequence

# Ranged
mc bow TARGET               # fire bow (alias of mc shoot) — need bow + arrows
mc shoot TARGET             # same

# Defense
mc shield SECONDS           # raise shield to block for N seconds
mc flee [X Y Z]             # dedicated retreat — picks safe direction if no coord

# Support
mc eat                      # eat best food in inventory
mc equip ITEM               # equip weapon/shield to hand
mc status                   # check health + nearby threats
mc find_entities TYPE [R]   # locate specific mob type
mc stop                     # abort current action
```

## Combat priority (check before any engage)

- Health ≤ 6: **RUN.** `mc eat` then `mc flee`. Do not fight.
- Health ≤ 10: Fight only with iron+ weapon AND iron+ armor.
- Health > 14: Fight freely.

## Weapon selection

Prefer best-in-inventory; `mc fight` auto-equips, but for `mc attack` /
`mc shoot` you equip first:

```
mc equip netherite_sword     # best
mc equip diamond_sword       # great
mc equip iron_sword          # good
mc equip stone_sword         # okay
mc equip wooden_sword        # emergency
mc equip bow                 # ranged engage
mc equip shield off-hand     # raise with mc shield
```

## Picking the right verb

| Situation | Use |
|---|---|
| Just need one hit (test, finishing blow) | `mc attack TARGET` |
| Single dangerous mob, want to commit | `mc fight TARGET` |
| Skeleton/witch at range (incoming projectiles) | `mc shield 3` THEN close → `mc fight` |
| Creeper at >8 blocks | `mc bow creeper` (kill before it closes) |
| Enderman / armored mob | `mc crit TARGET` (jump-attack 1.5× damage) |
| Mob hits hard, you have HP buffer | `mc strafe TARGET` (kite) |
| Knockback off a ledge / out of a cave | `mc sprint_attack TARGET` |
| Health crashed mid-fight | `mc stop` → `mc eat` → `mc flee` |

## Mob strategies

### Zombie
Slow, melee only. `mc fight zombie`. Watch for groups; baby zombies are fast — `mc strafe` works well.

### Skeleton
Ranged (bow). Dangerous in the open. Pattern:
1. `mc shield 4` — block incoming arrows.
2. Close distance: `mc move SKEL_X SKEL_Y SKEL_Z`.
3. `mc fight skeleton`.
Or kill at range with `mc bow skeleton` if you have a bow + arrows.

### Creeper
Explodes when within ~3 blocks. **NEVER let it close.**
- Preferred: `mc bow creeper` from ≥8 blocks.
- Melee: `mc sprint_attack creeper` (hits + knockback), then `mc flee`. Repeat.
- Charged creeper (blue glow, lightning-struck): 2× explosion — **`mc flee`, do not engage.**

### Spider
Neutral in daylight, hostile at night. Fast, climbs walls. `mc fight spider` — straightforward. Fight in a 2-high space if possible (spiders can't fit through 1×1 gaps).

### Enderman
Only aggros if you look at it directly. Teleports out of melee. Pattern:
- Fight in a 2-block-high tunnel (it can't fit, can't teleport in).
- `mc crit enderman` — jump-attacks land before it teleports.
- Need iron+ gear; expect to take 1-2 hits.

### Witch
Throws healing potions on self, harm potions on you.
- Close fast: `mc sprint_attack witch` then `mc fight witch`.
- `mc shield 2` if you see a splash incoming.

### Blaze (Nether)
Flies, shoots fireballs in bursts of 3. Need fire-resistance potion or quick melee in tight quarters.
- `mc bow blaze` if you have arrows.
- Otherwise close: `mc fight blaze` under cover.

### Ghast (Nether)
Flies high, explosive fireballs.
- `mc bow ghast` — only reliable option for a bot.
- Or hide behind a netherrack column and wait.

### Wither Skeleton (Nether)
Wither effect = HP drain. Treat like a stronger zombie but with reach.
- `mc strafe wither_skeleton` and `mc eat` between swings.

## After combat

1. `mc pickup` — drops + XP orbs.
2. `mc eat` — heal up.
3. `mc status` — scan for more threats; if cluster, `mc flee` to known shelter.
