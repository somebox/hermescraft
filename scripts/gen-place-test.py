#!/usr/bin/env python3
"""gen-place-test.py — M3 navigate-collect-place test.

The maze is fully built by world_setup (no bot building required):
  - Cobble walls at every # cell, 2 blocks tall
  - Oak doors at all 3 gates: entrance D0 (NEW, blocks the west opening
    until interacted with), D1 internal, D2 rear
  - Obsidian outer perimeter ring (single gap aligned with D0)

The bot's job: walk to each source, collect or mine the item, walk to
the target cell, place it, ack. Sources are mixed:
  - Some items in chests inside the maze
  - Some items in a chest just OUTSIDE the maze (forces re-entry through
    the entrance door)
  - Some items as mineable blocks placed at specific coords (diorite /
    andesite — distinct from arena floor so the bot can't accidentally
    mine the wrong one with `mc collect`)
The later missions place items in main corridors, creating obstacles
that subsequent missions must pathfind around.

Run: python3 scripts/gen-place-test.py
"""
from __future__ import annotations

import random
import sys
from pathlib import Path

# ─ Maze descriptor ────────────────────────────────────────────────────────
MAZE = [
    "#########################",
    "                 #      #",
    "########D####### #    # #",
    "#     #        # # ##   #",
    "#  1  #######  # # ##  ##",
    "#              #     # 2#",
    "##################D######",
]

ORIGIN_X = -12
ORIGIN_Z = -3

RNG_SEED = 1729
NUM_MISSIONS = 10

SPAWN_X = -16
SPAWN_Y = 65
SPAWN_Z = -2
SPAWN_YAW = 90

OUTPUT_PATH = Path("data/agent-tests/M3_collect_place.yaml")
ARENA_PAD_X = 5
ARENA_PAD_Z = 4

# ─ Item types ─────────────────────────────────────────────────────────────
# Each entry: (item_id, source_kind)
# source_kind in {"chest_inside", "chest_outside", "mine"}.
# After collect/mine, bot places via `mc place <item_id> X Y Z`. Verify
# accepts the block name(s) that placement produces.
ITEM_POOL = [
    ("white_wool",   ["white_wool"],   "chest_inside"),
    ("oak_planks",   ["oak_planks"],   "chest_inside"),
    ("blue_wool",    ["blue_wool"],    "chest_inside"),
    ("yellow_wool",  ["yellow_wool"],  "chest_inside"),
    ("red_wool",     ["red_wool"],     "chest_outside"),
    ("green_wool",   ["green_wool"],   "chest_outside"),
    ("diorite",      ["diorite"],      "mine"),
    ("andesite",     ["andesite"],     "mine"),
    ("cobblestone",  ["cobblestone"],  "chest_inside"),  # corridor obstacle target
    ("granite",      ["granite"],      "mine"),          # corridor obstacle target
]


# ─ Parsing helpers ────────────────────────────────────────────────────────
def col_x(c: int) -> int:
    return c + ORIGIN_X


def row_z(r: int) -> int:
    return r + ORIGIN_Z


def parse_maze(maze):
    walls = []     # (x, z) for '#'
    chests = {}    # "1"->(x,z) etc.
    doors = {}     # "D1"->(x,z) reading order
    open_cells = []  # (x, z) for '.' or ' '
    door_idx = 0
    for r, line in enumerate(maze):
        for c, ch in enumerate(line):
            x, z = col_x(c), row_z(r)
            if ch == "#":
                walls.append((x, z))
            elif ch == "D":
                door_idx += 1
                doors[f"D{door_idx}"] = (x, z)
                open_cells.append((x, z))  # door cells are open floor too
            elif ch.isdigit():
                chests[ch] = (x, z)
                open_cells.append((x, z))
            else:
                open_cells.append((x, z))
    return walls, chests, doors, open_cells


def runs_by_row(positions):
    by_z = {}
    for (x, z) in positions:
        by_z.setdefault(z, []).append(x)
    out = []
    for z in sorted(by_z):
        xs = sorted(by_z[z])
        i = 0
        while i < len(xs):
            j = i
            while j + 1 < len(xs) and xs[j + 1] == xs[j] + 1:
                j += 1
            out.append((xs[i], z, xs[j]))
            i = j + 1
    return out


def setblock_or_fill(positions, block_name):
    """Emit rcon strings for `positions` filled with `block_name`. Single
    cells → setblock; contiguous x-runs → fill."""
    cmds = []
    for (x1, z, x2) in runs_by_row(positions):
        if x1 == x2:
            cmds.append(f"setblock {x1} 64 {z} minecraft:{block_name}")
        else:
            cmds.append(f"fill {x1} 64 {z} {x2} 64 {z} minecraft:{block_name}")
    return cmds


# ─ Generation ─────────────────────────────────────────────────────────────
def pick_corridor_open_cells(open_cells, chests, doors):
    """Cells in the main z=-2 / z=2 corridors that are open AND not on a
    chest/door. Used as obstacle-target candidates for the last missions."""
    blocked = set(chests.values()) | set(doors.values())
    return [(x, z) for (x, z) in open_cells if z in (-2, 2) and (x, z) not in blocked]


# ─ Trap-detection helpers ─────────────────────────────────────────────────
# A target T is rejected if placing it would:
#   (a) leave any open neighbor of T with zero remaining open exits, OR
#   (b) leave any chest unreachable (no open neighbor cell that itself
#       has ≥1 open exit other than the chest).
# Doors are treated as walkable (open=true after first interaction).
# This catches the M3 v6 trap: bot stood at (10,2) to place at (10,1),
# but (10,2)'s only other neighbors were a chest and 2 walls — placing
# (10,1) gave (10,2) zero exits.

CARDINALS = [(1, 0), (-1, 0), (0, 1), (0, -1)]


def _cell_open(c, obstructed, open_cells_set):
    return c in open_cells_set and c not in obstructed


def _is_trap_for_target(target, obstructed, open_cells_set):
    tx, tz = target
    open_nbrs = [(tx + dx, tz + dz) for dx, dz in CARDINALS
                 if _cell_open((tx + dx, tz + dz), obstructed, open_cells_set)]
    new_obstr = obstructed | {target}
    for n in open_nbrs:
        nx, nz = n
        exits = [(nx + dx, nz + dz) for dx, dz in CARDINALS
                 if _cell_open((nx + dx, nz + dz), new_obstr, open_cells_set)]
        if not exits:
            return True
    return False


def _is_chest_trapped(chest, obstructed, open_cells_set):
    cx, cz = chest
    for dx, dz in CARDINALS:
        n = (cx + dx, cz + dz)
        if not _cell_open(n, obstructed, open_cells_set):
            continue
        nx, nz = n
        for ex_dx, ex_dz in CARDINALS:
            m = (nx + ex_dx, nz + ex_dz)
            if m == chest:
                continue
            if _cell_open(m, obstructed, open_cells_set):
                return False
    return True


def _reachable_set(start, blocked, open_cells_set, doors_set):
    """BFS over open_cells ∪ doors, treating `blocked` cells as walls."""
    if start in blocked or (start not in open_cells_set and start not in doors_set):
        return set()
    seen = {start}; stack = [start]
    while stack:
        c = stack.pop()
        for dx, dz in CARDINALS:
            n = (c[0] + dx, c[1] + dz)
            if n in seen or n in blocked:
                continue
            if n in open_cells_set or n in doors_set:
                seen.add(n); stack.append(n)
    return seen


def _safe_target(target, obstructed, open_cells_set, chest_set, doors_set,
                 base_cell, pending_targets):
    """A target T is safe iff after blocking it (in addition to walls + chests
    + previously-placed targets), from `base_cell` we can still reach:
      • every chest's adjacent cell (so future withdraws stay possible), and
      • every cell in `pending_targets` (so future placements stay possible).
    Also keeps the local 1-cell dead-end check as a fast pre-filter."""
    if _is_trap_for_target(target, obstructed, open_cells_set):
        return False
    new_obstr = obstructed | {target}
    if _is_chest_trapped_any := any(
            _is_chest_trapped(ch, new_obstr, open_cells_set) for ch in chest_set):
        return False
    blocked = set(new_obstr) | chest_set  # chests are endpoints, not passthroughs
    reach = _reachable_set(base_cell, blocked, open_cells_set, doors_set)
    for ch in chest_set:
        if not any((ch[0] + dx, ch[1] + dz) in reach for dx, dz in CARDINALS):
            return False
    for pt in pending_targets:
        if pt == target:
            continue
        if pt not in reach:
            return False
    return True


def _pick_safe(pool, obstructed, open_cells_set, chest_set, doors_set,
               base_cell, other_pools):
    """Pop the first target from `pool` (in order) that passes _safe_target,
    with `pending_targets` = union of all remaining unconsumed candidates in
    `pool` + `other_pools` (excluding the candidate itself). Returns None if
    no pool entry passes."""
    for i, t in enumerate(pool):
        pending = (set(pool) - {t}) | set(*other_pools) if other_pools else (set(pool) - {t})
        # set(*other_pools) was wrong — flatten:
        pending = set(pool) - {t}
        for op in other_pools:
            pending |= set(op)
        if _safe_target(t, obstructed, open_cells_set, chest_set, doors_set,
                        base_cell, pending):
            return pool.pop(i)
    return None


def main() -> int:
    walls, chests, doors, open_cells = parse_maze(MAZE)
    if "1" not in chests or "2" not in chests:
        print("ERROR: need chests 1 and 2 in maze", file=sys.stderr); return 2
    if "D1" not in doors or "D2" not in doors:
        print("ERROR: need 2 doors in maze", file=sys.stderr); return 2

    c1 = chests["1"]   # in-maze chest #1 (left chamber)
    c2 = chests["2"]   # in-maze chest #2 (right chamber)
    d_internal = doors["D1"]  # internal door (top)
    d_rear     = doors["D2"]  # rear door (bottom)
    # Entrance door — placed in the gap on the west wall at (mmin_x, ent_z).
    mmin_x = min(x for (x, _) in walls)
    open_west_zs = [z for z in range(min(z for (_, z) in walls), max(z for (_, z) in walls) + 1)
                    if (mmin_x, z) not in {(x, z) for (x, z) in walls}]
    ent_z = open_west_zs[0]
    d_entrance = (mmin_x, ent_z)  # NEW: D0 at the maze entrance

    # Arena bounds
    all_xs = [x for (x, _) in walls] + [SPAWN_X]
    all_zs = [z for (_, z) in walls] + [SPAWN_Z]
    ax1, ax2 = min(all_xs) - ARENA_PAD_X, max(all_xs) + ARENA_PAD_X
    az1, az2 = min(all_zs) - ARENA_PAD_Z, max(all_zs) + ARENA_PAD_Z

    # ── Random plan ─────────────────────────────────────────────────────
    rng = random.Random(RNG_SEED)

    # Target cells: random open cells inside the maze, distinct from chests
    # and doors. Reserve the last 2 mission targets for corridor cells so
    # they create navigation obstacles.
    eligible_targets = [
        (x, z) for (x, z) in open_cells
        if (x, z) != c1 and (x, z) != c2
        and (x, z) != d_internal and (x, z) != d_rear and (x, z) != d_entrance
    ]
    corridor_targets = pick_corridor_open_cells(open_cells, chests, doors)
    room_targets = [c for c in eligible_targets if c not in corridor_targets]

    rng.shuffle(room_targets)
    rng.shuffle(corridor_targets)

    # Incremental safe-pick: each chosen target gets added to the
    # obstruction set before validating the next, so we catch traps
    # that only emerge once earlier placements accumulate. The
    # connectivity guard in _safe_target also rejects targets that would
    # disconnect any chest or any remaining pending target from the base
    # cell — catches the M3 v7 bug where placing white_wool at (4, 0)
    # split the maze in two.
    open_set = set(open_cells)
    chest_set = set(chests.values())
    doors_set = set(doors.values()) | {d_entrance}
    obstructed = set(walls) | chest_set  # doors stay walkable (open=true after interact)
    base_cell = d_entrance               # bot enters here; everything must remain reachable from it

    targets = []
    for _ in range(NUM_MISSIONS - 2):
        t = _pick_safe(room_targets, obstructed, open_set, chest_set, doors_set,
                       base_cell, other_pools=[corridor_targets])
        if t is None:
            break
        targets.append(t)
        obstructed.add(t)
    for _ in range(2):
        t = _pick_safe(corridor_targets, obstructed, open_set, chest_set, doors_set,
                       base_cell, other_pools=[])
        if t is None:
            break
        targets.append(t)
        obstructed.add(t)

    # Fallback fill from any remaining eligible cells if pools ran dry.
    if len(targets) < NUM_MISSIONS:
        leftover = [c for c in eligible_targets if c not in targets]
        rng.shuffle(leftover)
        while len(targets) < NUM_MISSIONS and leftover:
            t = _pick_safe(leftover, obstructed, open_set, chest_set, doors_set,
                           base_cell, other_pools=[])
            if t is None:
                break
            targets.append(t)
            obstructed.add(t)
    assert len(targets) == NUM_MISSIONS, (
        f"need {NUM_MISSIONS} safe target cells, found {len(targets)} — "
        f"loosen MAZE layout or shrink NUM_MISSIONS")

    # Items: take first NUM_MISSIONS from ITEM_POOL, shuffle within
    items = ITEM_POOL[:NUM_MISSIONS]
    rng.shuffle(items)

    # Mine-source coords — placed somewhere accessible. Inside maze
    # rooms (left chamber for diorite, right chamber for andesite,
    # corridor for granite). Find an open room cell for each.
    mine_sources = {}
    mine_targets_pool = [c for c in room_targets[: NUM_MISSIONS - 2] if c not in targets]
    # Just pick 3 specific cells deterministically
    sample_for_mines = rng.sample([c for c in eligible_targets if c not in targets], k=3)
    mine_cell_iter = iter(sample_for_mines)

    # Outside-chest coord
    chest_outside_coord = (SPAWN_X - 1, SPAWN_Z)   # 1 cell west of spawn — outside the perimeter ring

    # Build mission list
    missions = []
    for i, ((item_id, allow_blocks, kind), target) in enumerate(zip(items, targets), start=1):
        m = {"id": f"M{i}", "item_id": item_id, "allow_blocks": allow_blocks,
             "kind": kind, "target": target}
        if kind == "chest_inside":
            # Alternate between C1 and C2
            m["source"] = c1 if (i % 2 == 1) else c2
        elif kind == "chest_outside":
            m["source"] = chest_outside_coord
        elif kind == "mine":
            try:
                m["source"] = next(mine_cell_iter)
            except StopIteration:
                # Fall back to chest_inside if we run out of mine cells
                m["kind"] = "chest_inside"
                m["source"] = c1 if (i % 2 == 1) else c2
        else:
            m["source"] = c1
        if m["kind"] == "mine":
            mine_sources[m["source"]] = item_id
        missions.append(m)

    # ── Emit YAML ──────────────────────────────────────────────────────
    maze_indented = "\n".join(f"#   {ln}" for ln in MAZE)
    parts = []
    parts.append(f"""# M3 — navigate + collect + place.
#
# GENERATED FROM scripts/gen-place-test.py — DO NOT HAND-EDIT cell lists.
# Edit MAZE / CONFIG at the top of that script and re-run.
#
# Maze layout (col c → x = c + {ORIGIN_X}, row r → z = r + {ORIGIN_Z};
# # = wall, D = door slot, digit = chest, . = open floor):
{maze_indented}
#
# Pre-built: ALL maze walls (cobble), 3 doors (entrance D0 + internal D1
# + rear D2), outer perimeter ring (obsidian). Bot does no building of
# the maze itself — it only collects items and places them at target
# cells. {NUM_MISSIONS} missions; later ones place into main corridors,
# creating obstacles the remaining missions must route around.

agent_test_id: M3_collect_place
world: landfolk-test
description: |
  Solo navigation + retrieve + place test on a pre-built maze. {NUM_MISSIONS}
  missions: walk to a source (chest inside/outside the maze, or a
  mineable block), collect/mine 1 item, walk to a target cell, place it.
  Last 2 placements drop items in main corridors as navigation obstacles
  for the remaining missions. Tests pathfinder + LOS + door interact +
  navigation around bot-placed obstacles.

bots:
  - name: Builder
    port: 3002
    profile: builder
""")

    # ── world_setup ───────────────────────────────────────────────────
    parts.append("world_setup:")
    parts.append("  - rcon: 'execute in landfolk-test run time set 5000'")
    parts.append("  - rcon: 'execute in landfolk-test run gamerule doDaylightCycle true'")
    parts.append("  - rcon: 'execute in landfolk-test run gamerule keepInventory true'")
    parts.append("  - rcon: 'execute in landfolk-test run gamerule doMobSpawning false'")
    parts.append("  - rcon: 'execute in landfolk-test run gamerule commandModificationBlockLimit 100000'")
    parts.append("  - rcon: 'execute in landfolk-test run weather clear 9999'")
    parts.append("  - rcon: 'execute in landfolk-test run kill @e[type=!player]'")
    parts.append("  - rcon: 'execute in landfolk-test run kill @e[type=!player]'")
    parts.append("")
    parts.append(f"  # Force-load the chunks (forceload runs in the EXECUTOR's dimension")
    parts.append(f"  # which is the overworld for rcon-cli — so 'execute in <world> run' on")
    parts.append(f"  # forceload doesn't actually target landfolk-test. Acceptable here")
    parts.append(f"  # because the bot's presence loads the chunks once it connects.")
    parts.append(f"  - rcon: 'execute in landfolk-test run forceload add {ax1} {az1} {ax2} {az2}'")
    parts.append("")
    parts.append(f"  # Arena floor: stone → dirt → obsidian (no grass — keeps the bot from digging through).")
    parts.append(f"  - rcon: 'execute in landfolk-test run fill {ax1} 62 {az1} {ax2} 71 {az2} air replace'")
    parts.append(f"  - rcon: 'execute in landfolk-test run fill {ax1} 62 {az1} {ax2} 62 {az2} minecraft:stone'")
    parts.append(f"  - rcon: 'execute in landfolk-test run fill {ax1} 63 {az1} {ax2} 63 {az2} minecraft:dirt'")
    parts.append(f"  - rcon: 'execute in landfolk-test run fill {ax1} 64 {az1} {ax2} 64 {az2} minecraft:grass_block'")
    parts.append("")
    parts.append(f"  # Maze cobble walls (pre-built, 3 high — y=65..67). 2-tall walls let")
    parts.append(f"  # the bot climb on top via chests/gates and walk the perimeter; 3 tall")
    parts.append(f"  # blocks all known wall-climbing exploits.")
    for ln in setblock_or_fill(walls, "cobblestone"):
        ln65 = ln.replace(" 64 ", " 65 ")
        ln66 = ln.replace(" 64 ", " 66 ")
        ln67 = ln.replace(" 64 ", " 67 ")
        parts.append(f"  - rcon: 'execute in landfolk-test run {ln65}'")
        parts.append(f"  - rcon: 'execute in landfolk-test run {ln66}'")
        parts.append(f"  - rcon: 'execute in landfolk-test run {ln67}'")
    parts.append("")

    # Outer perimeter ring (obsidian)
    mmax_x = max(x for (x, _) in walls)
    mmin_z = min(z for (_, z) in walls)
    mmax_z = max(z for (_, z) in walls)
    ring_min_x = mmin_x - 1
    ring_max_x = mmax_x + 1
    ring_min_z = mmin_z - 1
    ring_max_z = mmax_z + 1
    parts.append(f"  # Outer perimeter obsidian ring (y=65..67, 3-tall) — single gap at west entrance.")
    if ent_z > ring_min_z:
        parts.append(f"  - rcon: 'execute in landfolk-test run fill {ring_min_x} 65 {ring_min_z} {ring_min_x} 67 {ent_z - 1} minecraft:obsidian'")
    if ent_z < ring_max_z:
        parts.append(f"  - rcon: 'execute in landfolk-test run fill {ring_min_x} 65 {ent_z + 1} {ring_min_x} 67 {ring_max_z} minecraft:obsidian'")
    parts.append(f"  - rcon: 'execute in landfolk-test run fill {ring_max_x} 65 {ring_min_z} {ring_max_x} 67 {ring_max_z} minecraft:obsidian'")
    parts.append(f"  - rcon: 'execute in landfolk-test run fill {ring_min_x} 65 {ring_min_z} {ring_max_x} 67 {ring_min_z} minecraft:obsidian'")
    parts.append(f"  - rcon: 'execute in landfolk-test run fill {ring_min_x} 65 {ring_max_z} {ring_max_x} 67 {ring_max_z} minecraft:obsidian'")
    parts.append("")

    # Gates (entrance + internal + rear). mineflayer-pathfinder has native
    # support for oak_fence_gate (canOpenDoors handles them via useOne
    # actions), so we use gates instead of full oak_doors. Functionally
    # the same (interact to open) but pathfinder can route through them.
    # Each gate is 1 block tall (y=65 only), no upper half.
    parts.append(f"  # 3 oak_fence_gates with explicit facing — pathfinder traverses these.")
    for (dx, dz, facing) in [
        (d_entrance[0], d_entrance[1], "east"),
        (d_internal[0], d_internal[1], "north"),
        (d_rear[0], d_rear[1], "south"),
    ]:
        parts.append(f"  - rcon: 'execute in landfolk-test run setblock {dx} 65 {dz} minecraft:air'")
        parts.append(f"  - rcon: 'execute in landfolk-test run setblock {dx} 66 {dz} minecraft:air'")
        parts.append(f"  - rcon: 'execute in landfolk-test run setblock {dx} 65 {dz} minecraft:oak_fence_gate[facing={facing},open=false,in_wall=false]'")
    parts.append("")

    # In-maze chests C1 + C2 — stocked at world_setup with what the
    # FIRST chest-inside missions for each chest will need. Subsequent
    # chest_inside missions will pre_rcon-restock on demand.
    parts.append(f"  # Initial chest stocking for C1 and C2 (in-maze chests).")
    for (cx, cz, items_summary) in [(c1[0], c1[1], "cobble + tools + bread"),
                                     (c2[0], c2[1], "cobble + tools + bread")]:
        parts.append(f"  - rcon: 'execute in landfolk-test run setblock {cx} 65 {cz} minecraft:air'")
        parts.append(
            f'  - rcon: \'execute in landfolk-test run setblock {cx} 65 {cz} '
            f'minecraft:chest{{Items:[{{Slot:0b,id:"minecraft:cobblestone",count:8}},'
            f'{{Slot:1b,id:"minecraft:stone_pickaxe",count:1}},'
            f'{{Slot:2b,id:"minecraft:bread",count:6}}]}}\''
        )
    parts.append("")

    # Outside chest stub (one chest west of the spawn, outside the ring).
    out_chest = chest_outside_coord
    parts.append(f"  # Outside-the-maze chest at ({out_chest[0]}, 65, {out_chest[1]}) — west of spawn.")
    parts.append(f"  - rcon: 'execute in landfolk-test run setblock {out_chest[0]} 65 {out_chest[1]} minecraft:air'")
    parts.append(
        f'  - rcon: \'execute in landfolk-test run setblock {out_chest[0]} 65 {out_chest[1]} '
        f'minecraft:chest{{Items:[{{Slot:0b,id:"minecraft:bread",count:4}}]}}\''
    )
    parts.append("")

    # Spawn
    parts.append(f"  # Spawn — outside the perimeter ring, facing east.")
    parts.append(f"  - rcon: 'execute in landfolk-test run setworldspawn {SPAWN_X} {SPAWN_Y} {SPAWN_Z}'")
    parts.append(f"  - rcon: 'execute in landfolk-test run spawnpoint Builder {SPAWN_X} {SPAWN_Y} {SPAWN_Z}'")
    parts.append("")

    # ── post_connect ──────────────────────────────────────────────────
    parts.append("post_connect_setup:")
    parts.append("  - rcon: 'execute in landfolk-test run effect clear Builder'")
    parts.append("  - rcon: 'execute in landfolk-test run effect give Builder minecraft:saturation 5 10'")
    parts.append("  - rcon: 'execute in landfolk-test run effect give Builder minecraft:instant_health 1 4'")
    parts.append("  - rcon: 'execute in landfolk-test run clear Builder'")
    parts.append("  - rcon: 'execute in landfolk-test run clear Builder'")
    parts.append("  - rcon: 'execute in landfolk-test run xp set Builder 0 levels'")
    parts.append("  - rcon: 'execute in landfolk-test run give Builder minecraft:stone_pickaxe 1'")
    parts.append(f"  - rcon: 'execute in landfolk-test run tp Builder {SPAWN_X} {SPAWN_Y} {SPAWN_Z} {SPAWN_YAW} 0'")
    parts.append("")

    # ── marks ─────────────────────────────────────────────────────────
    parts.append("marks:")
    parts.append(f"  C1: {{ x: {c1[0]}, y: 65, z: {c1[1]}, note: \"In-maze chest 1 (left)\" }}")
    parts.append(f"  C2: {{ x: {c2[0]}, y: 65, z: {c2[1]}, note: \"In-maze chest 2 (right)\" }}")
    parts.append(f"  C_OUT: {{ x: {out_chest[0]}, y: 65, z: {out_chest[1]}, note: \"Outside-the-maze chest (west of spawn)\" }}")
    parts.append(f"  D0: {{ x: {d_entrance[0]}, y: 65, z: {d_entrance[1]}, note: \"Maze entrance door\" }}")
    parts.append(f"  D1: {{ x: {d_internal[0]}, y: 65, z: {d_internal[1]}, note: \"Internal door (top)\" }}")
    parts.append(f"  D2: {{ x: {d_rear[0]}, y: 65, z: {d_rear[1]}, note: \"Rear door (bottom)\" }}")
    parts.append(f"  ENTRY: {{ x: {SPAWN_X}, y: {SPAWN_Y}, z: {SPAWN_Z}, note: \"Bot spawn\" }}")
    parts.append("")

    # ── phases ────────────────────────────────────────────────────────
    parts.append("phases:")
    for m in missions:
        mid = m["id"]
        item_id = m["item_id"]
        allow = m["allow_blocks"]
        tx, tz = m["target"]
        sx, sz = m["source"]
        kind = m["kind"]

        # pre_rcon: stock the source for this mission
        pre = []
        if kind in ("chest_inside", "chest_outside"):
            # Air + chest with the specific item
            nbt = f'[{{Slot:0b,id:"minecraft:{item_id}",count:1}}]'
            pre.append(f"execute in landfolk-test run setblock {sx} 65 {sz} minecraft:air")
            pre.append(f'execute in landfolk-test run setblock {sx} 65 {sz} minecraft:chest{{Items:{nbt}}}')
        elif kind == "mine":
            # Place the mineable block at the source coord (y=65, on top of floor)
            pre.append(f"execute in landfolk-test run setblock {sx} 65 {sz} minecraft:{item_id}")

        pre_yaml = "\n".join(f"          - '{p}'" for p in pre)

        # Mission text — short. Gates open automatically when the bot
        # pathfinds into them (pathfinder's canOpenDoors handles fence_gates).
        # Bot does NOT need explicit `mc through` calls.
        if kind == "chest_inside":
            chest_label = "C1" if (sx, sz) == c1 else "C2"
            line1 = (f"@builder {mid}: walk to {chest_label} ({sx},65,{sz}) — gates open "
                     f"automatically as you pathfind through them; `mc withdraw {item_id} 1 {sx} 65 {sz}`.")
        elif kind == "chest_outside":
            line1 = (f"@builder {mid}: walk to outside chest C_OUT ({sx},65,{sz}) "
                     f"(west of spawn, no gate needed); `mc withdraw {item_id} 1 {sx} 65 {sz}`.")
        elif kind == "mine":
            line1 = (f"@builder {mid}: walk to the {item_id} block at ({sx},65,{sz}), "
                     f"`mc dig {sx} 65 {sz}` then `mc collect {item_id} 1`.")
        else:
            line1 = f"@builder {mid}: unknown source."

        line2 = (f"Then walk to target ({tx},65,{tz}) and "
                 f"`mc place {item_id} {tx} 65 {tz}`.")
        line3 = f"Verify with `mc inspect {tx} 65 {tz}`, then emit `{mid} DONE`."

        allow_yaml = ", ".join(allow)
        # chest_outside missions inherently need ~50% more wallclock — bot
        # must exit through D0, walk to C_OUT, re-enter, then place. M3 v7
        # M6 timed out by 3s on the default 3600-tick (180s) budget.
        deadline = 5400 if kind == "chest_outside" else 3600
        parts.append(f"""  - id: {mid}
    parallel: false
    missions:
      - id: {mid}
        to: Builder
        pre_rcon:
{pre_yaml}
        text:
          - '{line1}'
          - '{line2}'
          - '{line3}'
        deadline_tick: {deadline}
        done_keyword: "{mid} DONE"
        keyword_from: Builder
        verify_after_keyword:
          world: landfolk-test
          checks:
            - label: {mid}_placed
              cells:
                - [{tx}, 65, {tz}]
              allow: [{allow_yaml}]
              min_match: 1
""")

    # ── tail ──────────────────────────────────────────────────────────
    parts.append("""warning_lead_ticks: 1000
hard_overtime_ticks: 1500
global_wallclock_max_seconds: 2400
poll_interval_seconds: 3
chat_history_count: 30
hermes_session_max_turns: 3500
launch_settle_seconds: 2
ready_handshake_timeout_s: 45

cleanup:
  - rcon: 'execute in landfolk-test run kill @e[type=item]'
  - rcon: 'execute in landfolk-test run forceload remove all'

expect:
  all_phases_done: true
  global_timeout_not_hit: true
""")

    out_path = OUTPUT_PATH if OUTPUT_PATH.is_absolute() else (Path(__file__).resolve().parent.parent / OUTPUT_PATH)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(parts))
    print(f"Wrote {out_path}")
    print(f"  missions: {NUM_MISSIONS}")
    print(f"  doors: entrance={d_entrance}  internal={d_internal}  rear={d_rear}")
    print(f"  chests: in1={c1}  in2={c2}  outside={chest_outside_coord}")
    print(f"  spawn: ({SPAWN_X}, {SPAWN_Y}, {SPAWN_Z})")
    for m in missions:
        print(f"    {m['id']}: {m['kind']:14} {m['item_id']:14} src={m['source']} → target={m['target']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
