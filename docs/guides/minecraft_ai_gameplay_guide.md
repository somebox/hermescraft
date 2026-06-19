# Minecraft Basic Gameplay Mechanics — A Concise Reference for AI Agents

A player-centric guide covering the intuitive rules humans learn by playing but an AI needs spelled out explicitly. Focused on survival, navigation, and terrain manipulation.

---

## 1. Player Dimensions & Hitbox

| State | Width | Height | Notes |
|-------|-------|--------|-------|
| Standing | 0.6 blocks | 1.8 blocks | Cannot walk through 1-high gaps |
| Sneaking | 0.6 blocks | 1.5 blocks | Can fit into 1.5-high spaces; prevents falling off edges |
| Swimming / Crawling / Gliding | 0.6 blocks | 0.6 blocks | Fits through 1-high openings |
| Sleeping | 0.2 blocks | 0.2 blocks | — |

- **Eye level** is at **1.62 blocks** from the ground when standing.
- The player occupies the block space at their foot level. To stand on a block, their feet must be on that block.

---

## 2. Movement & Speed

| Mode | Speed (blocks/sec) | Notes |
|------|-------------------|-------|
| Walking | ~4.32 | No hunger cost |
| Sprinting | ~5.61 | Costs hunger; max horizontal jump ~4.2 blocks |
| Sneaking | ~1.3 | Diagonal sneak is ~1.8 |
| Sprint-jumping | Faster | Costs 4× normal jump hunger; common for traversing terrain |

- **Cannot sprint** if hunger bar is at 3 shanks (6 points) or below.
- **Jump height**: ~1.25 blocks vertically. This means you can jump onto a 1-block ledge, but **not** a 2-block ledge without placing a step.
- **Auto-jump** exists (toggled in settings) but is unreliable for AI logic.

### Key Traversal Insight
A 2-block-high ridge is impassable by jumping alone. Place one block to make a step, and you can walk up. This is one of the most common maneuvers in survival.

---

## 3. Block Placement Reach & Rules

- **Reach distance**:
  - Java Edition survival: **4.5 blocks** for blocks, **3 blocks** for entities
  - Creative mode: **5 blocks**
  - Bedrock Edition: **5 blocks** for blocks
- Blocks **cannot be placed in mid-air** — they need an adjacent solid surface (face) to attach to.
- When you place a block, it occupies the space you targeted on the face of an existing block.
- **Placement cooldown**: ~4 ticks (0.2s) between block placements at normal speed. Pillaring speed is fundamentally limited by this cooldown.

---

## 4. Terrain Traversal Techniques

### Pillaring (Towering Up)
- Look straight down at the block you’re standing on, jump, and place a block under your feet as you rise.
- The player rises by ~1.25 blocks per jump; placing a block fills the gap.
- **Practical limit**: ~8–10 blocks/second for experienced players.
- You can pillar downward by breaking the block beneath you, but you take fall damage if the drop is >3 blocks. Use stair mining (below) or water buckets for safe descent.

### Bridging (Crossing Gaps)
- **Basic bridging**: Stand at the edge, aim at the side of the last block, and place blocks outward.
- **Sneak-bridging** (Ninja Bridge): Hold sneak at the edge. Place a block just in front of/under your feet. Sneak prevents falling off.
  - Mechanics: While sneaking, you will not fall off a block if the height difference is >0.6 blocks.
  - You can still dismount by jumping over the edge while sneaking.
- **Diagonal bridging**: Moving at a 45° angle while placing. Faster but harder.
- **You cannot place blocks while falling** — must have your feet on solid ground or be flying (Creative).

---

## 5. Stair Mining — Exact Patterns

Stair mining is the safest way to descend while maintaining mobility, visibility, and ore exposure. Below are the three most common patterns with exact block-breaking sequences.

### 5.1 Straight Staircase (1-wide, simplest)

This is the most basic stairs pattern: a 1-block-wide corridor that descends one block for every block forward.

**Top-down view (each layer is one Y-level lower):**

```
Layer 0 (start):  ████████████
                  ████████████
                  ████  ██████   ← air at mark

Layer 1:          ████████████
                  ████  ██████   ← you stand here
                  ████████████

Layer 2:          ████  ██████
                  ████████████
                  ████████████

Layer 3:          ████████████
                  ████  ██████
                  ████████████
```

**Exact step sequence:**
1. Stand on the starting block.
2. Face forward (the direction you want to descend).
3. Break the block at **head height** directly in front of you.
4. Break the block **at foot height** directly in front of you.
5. Step forward into the hole you just made.
6. You are now one block lower. Repeat from step 3.

**Result**: You always walk forward on flat ground — never falling more than 0 blocks. The ceiling is always 2 blocks high (your headroom), and the floor is always 1 block below your feet.

**Safety note**: If you hit a cave or lava, you see it before walking into it because you broke the blocks in front of you first.

---

### 5.2 Straight Staircase (2-wide, faster)

Same concept but 2 blocks wide. Slightly faster to descend because you break more blocks per step, and you can sprint down the stairs later.

**Top-down view:**

```
Layer 0:  ████████████████
          ████    ████████   ← 2-wide air gap

Layer 1:  ████    ████████   ← you stand here
          ████████████████

Layer 2:  ████████████████
          ████    ████████
```

**Exact step sequence:**
1. Stand at the top of the stairs.
2. Break the two blocks at **head height** in front of you (left and right).
3. Break the two blocks at **foot height** in front of you.
4. Step forward into the 2-wide hole.
5. Repeat.

**Result**: A comfortable 2-wide ramp you can sprint down. Place torches on the left wall only (see Navigation Best Practices).

---

### 5.3 2×2 Spiral Staircase (compact, best for tight spaces)

This is the classic spiral: you dig around a 2×2 central pillar, descending one layer per quarter-turn. It fits in a 4×4 footprint and is the most space-efficient way to go deep.

**Top-down view of one full rotation (4 layers):**

```
Layer 0:          Layer 1:          Layer 2:          Layer 3:

████████████      ████████████      ████████████      ████████████
██  ████  ██      ██  ████  ██      ██  ░░██  ██      ██  ██░░  ██
██  ████  ██  →   ██  ░░██  ██  →   ██  ████  ██  →   ██  ████  ██
████████████      ████████████      ████████████      ████████████
        ↑
   you start here, facing north

░░ = block you just dug (air)
```

**Exact step sequence (one full spiral loop = down 4 blocks):**

Assume you are standing on the north-west corner of the 2×2 center pillar, facing north.

- **Step 1 — North side (your current facing):**
  1. Break the block at head height in front of you (north side, outer ring).
  2. Break the block at foot height in front of you.
  3. Walk forward (north) into the hole. You are now on the north-east corner.
  4. Turn 90° right to face east.

- **Step 2 — East side:**
  1. Break head-height block in front of you (east side, outer ring).
  2. Break foot-height block in front of you.
  3. Walk forward (east) into the hole. You are now on the south-east corner.
  4. Turn 90° right to face south.

- **Step 3 — South side:**
  1. Break head-height block in front of you.
  2. Break foot-height block in front of you.
  3. Walk forward (south) into the hole. You are now on the south-west corner.
  4. Turn 90° right to face west.

- **Step 4 — West side:**
  1. Break head-height block in front of you.
  2. Break foot-height block in front of you.
  3. Walk forward (west) into the hole. You are now back on the north-west corner.
  4. Turn 90° right to face north.

- **You have completed one loop and descended 4 blocks.** Repeat from Step 1.

**Critical safety note**: The central 2×2 pillar must remain solid — do not break it, or you may fall through your own staircase. If you want an open center (for a ladder or water elevator), dig a 1×1 hole in the middle instead, but that requires a different pattern.

---

### 5.4 Branch Mining Layout (for ore collection)

Once you reach your target Y-level (e.g., Y=-58 for diamonds), stop descending and dig horizontal tunnels.

**Classic branch mine pattern:**

```
Top-down view:

████ Main shaft ████████████████████
   ↑
Branch 1 →   ░░░░░░░░░░░░
             ░░░░░░░░░░░░
             ░░░░░░░░░░░░   (2 high × 1 wide, 50+ blocks long)

(skip 2 blocks)

Branch 2 →   ░░░░░░░░░░░░
             ░░░░░░░░░░░░
             ░░░░░░░░░░░░

(skip 2 blocks)

Branch 3 →   ░░░░░░░░░░░░
```

**Exact rules:**
- Main shaft: 2 high × 2 wide, running straight.
- Branches: 2 high × 1 wide, dug perpendicular to the main shaft.
- **Spacing**: Leave exactly **2 solid blocks** between each branch.
- Why 2 blocks? Because ore blobs are rarely wider than 2 blocks. This spacing exposes the maximum surface area with the least digging.
- Branches should be at least 50 blocks long before starting a new one.
- Place torches on the **left wall** at every branch so you always know which direction leads back to the main shaft (see Section 8).

---

## 6. Escape & Recovery — Common Trap Situations

These are situations where players (and AI agents) frequently get stuck or die. Each entry describes the **trap**, the **warning signs**, and the **exact escape procedure**.

---

### 6.1 Trapped in a Pit / Hole with No Blocks

**Situation**: You fell into a hole deeper than 3 blocks and have no blocks to pillar up with.

**Escape procedure:**
1. Look at the walls. Identify the block types (stone, dirt, gravel, etc.).
2. If the walls are **dirt, gravel, sand, or clay**: Punch them by hand. These break without a tool.
3. Collect at least 3–4 blocks.
4. Jump, and place a block under your feet. Repeat until you reach the top.
5. If the walls are **stone, deepslate, or ore** and you have **no pickaxe**:
   - Option A: Look for a cave opening at the bottom of the pit. Follow it — it may lead to a surface exit or a mineshaft with wood.
   - Option B: If you are truly trapped with no exit, place all valuables in a chest (if you have wood) or accept death and respawn.

---

### 6.2 Surrounded by Hostile Mobs

**Situation**: You are in a cave or at night, and multiple hostile mobs are attacking from all sides.

**Escape procedure:**
1. **Immediately stop moving forward.** Do not sprint-jump into more mobs.
2. If you have blocks, **build a 1-block-thick wall around yourself** in a 1×1 or 2×2 box. This is called "boxing."
   - Stand still. Place a block to your north, south, east, west. Then place blocks above your head.
   - Leave one block open on the side facing the fewest mobs for visibility.
3. Wait for daylight (if above ground) or for mobs to wander away.
4. If underground, mine a new tunnel in a safe direction from inside your box.
5. If you have **no blocks**: Use your fist to punch the weakest mob to create an opening, then sprint toward the nearest light source or water.

---

### 6.3 Lost in a Cave with No Pickaxe and No Wood

**Situation**: Deep underground, broken pickaxe, no crafting table, no wood to make new tools.

**Escape procedure (in order of preference):**

1. **Follow your torch trail**: If you placed torches on the left wall while exploring, keep them on your **right** to go back. If torches are on both sides, pick one wall and follow it consistently.

2. **Find a mineshaft or dungeon**: Abandoned mineshafts contain wood planks and fences. Dungeons may have chests with tools. Listen for cave ambiance (spider sounds, water).

3. **Punch-stair up**:
   - Find a wall.
   - Break dirt/gravel/grass by hand if available.
   - If only stone is available, **do not punch stone** — it takes too long and drops nothing without a pickaxe.
   - Instead, look for a natural slope or waterfall to climb.

4. **Water pillar** (if you have a water bucket):
   - Place water at the bottom of a shaft. Swim up it. Pick the water back up with the bucket.
   - This is called a "water elevator" and can ascend any height instantly.

5. **Last resort — stair up by hand**:
   - If you find any breakable blocks (dirt, netherrack in the Nether, etc.), break enough to make a straight staircase upward.
   - Place a torch on the floor, dig the block above it, retrieve the torch, place it on the new floor, repeat. The torch prevents gravel/sand from suffocating you if it falls.

---

### 6.4 Above or Near Lava

**Situation**: You broke a block and exposed lava. You might fall in, or lava might flow toward you.

**Escape / safety procedure:**
1. **Stop moving immediately.** Do not backpedal blindly.
2. **Place a block** between you and the lava if it is flowing toward you. Any solid block stops lava flow.
3. If you have a **water bucket**:
   - Pour water on the block next to lava. The water turns the lava into obsidian (if source block) or cobblestone (if flowing).
   - Water also turns the area into obsidian/cobblestone you can stand on.
   - In the Nether, water **evaporates instantly** — do not rely on it.
4. If you **fell in lava**:
   - Immediately place water above yourself (if not in the Nether). This creates obsidian under you.
   - If no water, swim to the nearest edge and pillar out using blocks.
   - If you have no blocks, you will likely die. Throw your items onto the shore before dying if possible (they burn in lava after 5 seconds).

---

### 6.5 Falling Sand / Gravel Trap

**Situation**: You mined a block and sand or gravel above it started falling. If it buries you, you suffocate.

**Escape procedure:**
1. **Do not stand still.** Move forward immediately.
2. If already buried:
   - Start breaking the falling blocks before they fully compress.
   - Place a torch on the floor **under the falling sand/gravel**. The torch breaks all falling sand/gravel above it instantly (they drop as items).
   - This is a critical game mechanic: **torches break falling sand and gravel on contact.**
3. To prevent this: Never mine straight up, and always carry torches when mining under sand/gravel.

---

### 6.6 Stuck in a 1-Block-Tall Space

**Situation**: You fell into a 1-block gap (e.g., between a furnace and a wall) and cannot jump out because there is no headroom.

**Escape procedure:**
1. Break one of the blocks next to you or above you to create headroom.
2. If the block is unbreakable (obsidian, bedrock), you are in a world-generation bug. Use `/kill` or creative mode (if allowed).
3. Swimming into a 1-block gap underwater causes the player to enter "crawling" mode. To exit: break a block above or beside you.

---

### 6.7 Trapped by Water Current

**Situation**: You fell into a water stream (natural or player-made) and cannot swim against the current.

**Escape procedure:**
1. Swim **diagonally** against the current — this is faster than swimming straight against it.
2. Place a **solid block** in the water source to stop the flow, then mine it.
3. Place a **ladder** on a wall — you can climb ladders even in flowing water.
4. If there is a waterfall, swim to the edge and hold sneak to stand on the block behind the waterfall.

---

### 6.8 High Place — Need to Descend Safely

**Situation**: You are on a cliff or tall pillar and need to get down without dying.

**Escape procedure:**
1. **Water bucket MLG**: Place water just before hitting the ground. You take zero fall damage if you land in the water. This requires practice — place the water ~2 blocks above the ground while falling.
2. **Place blocks under you while falling**: Only works if you have blocks and are falling next to a wall. Look down and place blocks to slow/stop your descent.
3. **Pillar down**: Look straight down and mine the block beneath you while crouching (sneak). You will fall 1 block at a time. Slow but completely safe.
4. **Stair down**: Mine a staircase into the cliff face as you descend (same pattern as Section 5.1).

---

## 7. Complex Terrain Navigation — Best Practices

### 7.1 Ravine Crossing

A ravine is a long, deep crack in the world. Crossing it safely is a core skill.

**Option A — Bridge across (recommended if you have blocks):**
1. Walk to the edge. Sneak.
2. Place blocks extending from the edge until you reach the other side.
3. Hold sneak the entire time. One misclick = death.

**Option B — Descend and climb the other side:**
1. If the ravine walls are stepped (not sheer cliffs), you can sprint-jump down the ledges.
2. Each ledge must be ≤3 blocks lower than the last (or you take fall damage).
3. Mine a staircase up the far wall.

**Option C — Waterfall descent (if a waterfall is present):**
1. Swim into the waterfall and hold sneak against the wall.
2. You slide down slowly and take no fall damage.
3. To climb back up: hold space (swim up) inside the waterfall.

### 7.2 Crossing Lava Lakes

**Safe methods:**
1. **Cobblestone bridge**: Place blocks to make a path. Sneak while placing.
2. **Obsidian bridge**: Pour water onto lava source blocks. They turn to obsidian. Risky — do not fall in.
3. **Netherrack bridge** (Nether): Place netherrack or other solid blocks. Same as cobblestone bridging.

**Never**: Sprint-jump across lava. Even a 1-block gap over lava is deadly if you miss.

### 7.3 Navigating Dense Forests / Jungles

- Trees block movement. The fastest way through is to **go around** rather than chop through.
- If you must go through: chop the bottom log of each tree. The entire tree does **not** fall automatically (unless using a mod). You must break all logs yourself.
- Vines let you climb up and down. Hold W into a vine to ascend; hold sneak to descend slowly.
- Water in jungles (rivers) is faster than walking — use a boat if available.

### 7.4 Night Travel Without a Bed

- Hostile mobs spawn on any solid block with light level 0.
- **Torches** emit light level 14. Place one every 10 blocks to keep your path safe.
- **Shelter rule**: If caught outside at night with no bed, dig a 1×2 hole in a dirt wall, place a block behind you, and wait. Do not dig straight down.
- Spiders can climb walls. Creepers explode if close. Skeletons shoot from range. Zombies break doors on Hard difficulty.

---

## 8. Navigation & Path Marking

Getting lost is one of the most common causes of death in Minecraft. These are the standard human techniques:

### 8.1 The Torch Rule
- Place torches on the **left wall** as you explore.
- To return: keep torches on your **right** wall.
- This works in any branching cave or mine.

### 8.2 Landmark Blocks
- Place a double-torch stack, a unique block (e.g., cobblestone in a stone cave), or a sign at intersections to mark which path leads out.

### 8.3 Coordinates
- Java Edition: Press **F3** → look at "Block: X Y Z".
- Bedrock: Enable "Show Coordinates" in settings.
- Always write down your base / portal coordinates.
- The spawn point of the world is at a fixed coordinate. Memorize it.

### 8.4 Surface Signals
- If underground and trying to find the surface: dig a **straight staircase up** (Section 5.1). If you hit water or the ocean, block it and try a different angle.
- Listen for ambient sounds: rain, skeletons (surface), or birds (above ground).

---

## 9. Mining & Ore Locations

| Resource | Best Y-level(s) | Notes |
|----------|-----------------|-------|
| Coal | Y=95–136 | Also found near surface |
| Iron | Y=16, Y=232 | Common at multiple levels |
| Copper | Y=48 | More common in Dripstone Caves |
| Gold | Y=-16 (badlands: Y=32–256) | — |
| Lapis Lazuli | Y=0 | — |
| Diamond | Y=-58 to -59 | Best in deepslate layers |
| Redstone | Y=-58 to -59 | Same as diamond |
| Emerald | Y=236 | Mountains only |
| Ancient Debris | Y=15 (Nether) | Chunk-border edge strategy |

- **Lava pools** generate below Y=-55. Water buckets are essential for converting lava to obsidian.
- Deepslate replaces stone below Y=0. It takes longer to mine but is otherwise the same.

---

## 10. Survival Priorities

### 10.1 Health & Hunger
- **20 HP** (10 hearts)
- Health regenerates when hunger is **≥18 points** (9 shanks).
- At **0 hunger**, you starve and lose health:
  - Easy → stops at 10 HP
  - Normal → stops at 1 HP
  - Hard/Hardcore → **death**
- Sprinting, jumping, and mining deplete hunger faster.

### 10.2 Essential Safety Rules
- **Never dig straight down** — you can fall into lava, caves, or void.
- **Never dig straight up** — gravel, sand, or lava can fall on you.
- **Torches**: Place every ~10 blocks in mines to prevent mob spawning and mark your path.
- **Coordinates**: In Java, press F3. In Bedrock, enable in settings. Always note your portal/base coordinates.
- **Carry a water bucket**: Cuts falls, converts lava lakes, and stops fire.

---

## 11. Interaction & Entity Basics

- **Doors, chests, furnaces**: Right-click (use) to open. Sneak+right-click to place a block adjacent to them instead of opening them.
- **Mobs** spawn in light level 0 (Java) or ≤7 (Bedrock). Torches emit light level 14, fading by 1 per block.
- **Day/night cycle**: 20 real minutes. Hostile mobs spawn at night. Sleep in a bed to skip night (if no hostile mobs are nearby).

---

## 12. Key Wiki References

| Topic | URL |
|-------|-----|
| Player mechanics | https://minecraft.wiki/w/Player |
| Sneaking | https://minecraft.wiki/w/Sneaking |
| Jumping | https://minecraft.wiki/w/Jumping |
| Mining tutorial | https://minecraft.wiki/w/Tutorial:Mining |
| Transportation | https://minecraft.wiki/w/Tutorial:Transportation_methods |
| Block placement / reach | https://minecraft.wiki/w/Interaction_range |
| Speed bridging guide (official) | https://www.minecraft.net/en-us/article/how-speed-bridge- |

---

*This guide focuses on the "verbs" of Minecraft — what the player can do, how the world responds, and the spatial reasoning humans develop naturally. For an AI agent, every one of these rules must be explicit in the decision-making layer.*
