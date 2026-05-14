#!/usr/bin/env python3
"""Generate a maze test YAML from an ASCII maze descriptor.

The maze grid:
    #   wall  — obsidian floor marker at y=64; bot stacks cobble at y=65 & y=66
    D   door  — floor stays grass; bot places oak_door in the last mission
    C   chest — chest sits on grass at y=65 (pre-stocked by world_setup)
    .   open floor (grass)
    space — same as .

Edit MAZE + CONFIG below and run to regenerate the YAML.
The bot reaches each chest via narrowing corridors as it builds the walls,
which is the whole point of the test (pathfinding + tight-space building).

Build-group split: walls with x ≤ 0 go in W1 (M2), walls with x ≥ 1 go
in W2 (M4). The mission text contains the exact `mc fill` commands the
bot should run, derived from contiguous wall runs per row.

Run: python3 scripts/gen-maze-test.py
"""
from __future__ import annotations

import sys
from pathlib import Path

# --- Maze descriptor ---------------------------------------------------------

MAZE = [
    "#########################",
    "                 #      #",
    "########D####### #    # #",
    "#     #        # # ##   #",
    "#  1  #######  # # ##  ##",
    "#              #     # 2#",
    "##################D######",
]

# col c → x = c + ORIGIN_X;  row r → z = r + ORIGIN_Z
ORIGIN_X = -12
ORIGIN_Z = -3

# Chest contents (pre-stocked by world_setup). The keys MUST match the digit
# characters used in the MAZE grid.
CHEST_NBT = {
    "1": ('[{Slot:0b,id:"minecraft:cobblestone",count:64},'
          '{Slot:1b,id:"minecraft:cobblestone",count:32},'
          '{Slot:2b,id:"minecraft:oak_door",count:1},'
          '{Slot:3b,id:"minecraft:stone_pickaxe",count:1},'
          '{Slot:4b,id:"minecraft:bread",count:8}]'),
    "2": ('[{Slot:0b,id:"minecraft:cobblestone",count:64},'
          '{Slot:1b,id:"minecraft:cobblestone",count:32},'
          '{Slot:2b,id:"minecraft:oak_door",count:1},'
          '{Slot:3b,id:"minecraft:stone_pickaxe",count:1},'
          '{Slot:4b,id:"minecraft:bread",count:8}]'),
}

# Bot spawn — outside the maze, west of the open z-row.
SPAWN_X = -14
SPAWN_Y = 65
SPAWN_Z = -2
SPAWN_YAW = 90  # face east

OUTPUT_PATH = Path("data/agent-tests/M2_navigate_build.yaml")

# Arena padding around the maze (cleared each run).
ARENA_PAD_X = 4
ARENA_PAD_Z = 3

# --- Parsing -----------------------------------------------------------------


def col_x(c: int) -> int:
    return c + ORIGIN_X


def row_z(r: int) -> int:
    return r + ORIGIN_Z


def parse_maze(maze: list[str]) -> tuple[list[tuple[int, int]],
                                         dict[str, tuple[int, int]],
                                         dict[str, tuple[int, int]]]:
    """Return (walls, chests, doors). Walls is a list of (x, z).
    chests maps "1"→(x,z), "2"→(x,z), ... by digit label.
    doors maps "D1"→(x,z), "D2"→(x,z), ... in reading order."""
    walls: list[tuple[int, int]] = []
    chests: dict[str, tuple[int, int]] = {}
    doors: dict[str, tuple[int, int]] = {}
    door_idx = 0
    for r, line in enumerate(maze):
        for c, ch in enumerate(line):
            if ch == "#":
                walls.append((col_x(c), row_z(r)))
            elif ch == "D":
                door_idx += 1
                doors[f"D{door_idx}"] = (col_x(c), row_z(r))
            elif ch.isdigit():
                chests[ch] = (col_x(c), row_z(r))
            # else: '.', ' ' — open floor
    return walls, chests, doors


def runs_by_row(walls: list[tuple[int, int]]) -> list[tuple[int, int, int]]:
    """Group wall cells by z, then collapse contiguous x runs.
    Returns list of (x1, z, x2) with x1 ≤ x2."""
    by_z: dict[int, list[int]] = {}
    for (x, z) in walls:
        by_z.setdefault(z, []).append(x)
    out: list[tuple[int, int, int]] = []
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


def split_by_x(walls: list[tuple[int, int]], cutoff: int) -> tuple[list, list]:
    """Return (left, right) where left has x ≤ cutoff, right has x > cutoff."""
    left = [(x, z) for (x, z) in walls if x <= cutoff]
    right = [(x, z) for (x, z) in walls if x > cutoff]
    return left, right


# --- YAML emission -----------------------------------------------------------


def fill_cmds_for_walls(walls: list[tuple[int, int]]) -> list[str]:
    """One `mc fill cobblestone X1 65 Z X2 66 Z` per contiguous run.
    Covers both y-layers in one Paper-side fill (each ≤ 200 cells; runs are
    small enough here that's never an issue)."""
    cmds: list[str] = []
    for (x1, z, x2) in runs_by_row(walls):
        cmds.append(f"`mc fill cobblestone {x1} 65 {z} {x2} 66 {z}`")
    return cmds


def setblock_or_fill_obsidian(walls: list[tuple[int, int]]) -> list[str]:
    """world_setup rcon lines for obsidian floor markers. Use fills for
    runs ≥ 2 cells, setblock for singletons."""
    lines: list[str] = []
    for (x1, z, x2) in runs_by_row(walls):
        if x1 == x2:
            lines.append(f"setblock {x1} 64 {z} minecraft:obsidian")
        else:
            lines.append(f"fill {x1} 64 {z} {x2} 64 {z} minecraft:obsidian")
    return lines


def cells_yaml(walls: list[tuple[int, int]], y: int, indent: str) -> str:
    """Emit `- [x, y, z]` lines for verify_after_keyword."""
    return "\n".join(f"{indent}- [{x}, {y}, {z}]" for (x, z) in walls)


def emit_yaml(maze_str: str, walls, chests, doors) -> str:
    """Assemble the full YAML test spec."""
    c1 = chests["1"]
    c2 = chests["2"]
    d1 = doors["D1"]
    d2 = doors["D2"]

    # Build groups: x ≤ 0 = W1 (near C1), x ≥ 1 = W2 (near C2).
    w1, w2 = split_by_x(walls, cutoff=0)

    # Arena bounds for the air-wipe and ground stack.
    all_xs = [x for (x, _) in walls] + [SPAWN_X]
    all_zs = [z for (_, z) in walls] + [SPAWN_Z]
    ax1, ax2 = min(all_xs) - ARENA_PAD_X, max(all_xs) + ARENA_PAD_X
    az1, az2 = min(all_zs) - ARENA_PAD_Z, max(all_zs) + ARENA_PAD_Z

    parts: list[str] = []

    # -- Header --------------------------------------------------------------
    maze_indented = "\n".join(f"#   {ln}" for ln in maze_str.splitlines())
    parts.append(f"""# M2 — navigate + multi-mission solo build.
#
# GENERATED FROM scripts/gen-maze-test.py — DO NOT HAND-EDIT cell lists.
# Edit the MAZE / CONFIG at the top of that script and re-run.
#
# Maze layout (col c → x = c + {ORIGIN_X}, row r → z = r + {ORIGIN_Z};
# # = wall, D = door slot, digit = chest, . = open floor):
{maze_indented}
#
# Wall count: {len(walls)} cells × 2 y-layers = {2*len(walls)} cobble blocks.
# Build groups: W1 (x ≤ 0) = {len(w1)} cells, W2 (x ≥ 1) = {len(w2)} cells.

agent_test_id: M2_navigate_build
world: landfolk-test
description: |
  Solo navigate + build chain on a pre-designed maze. One mission per
  contiguous wall run (≤14 cells each). The orchestrator restocks the
  relevant chest just before broadcasting each mission text, forcing
  the bot to return to the chest, withdraw, and build that short fill.
  This stresses navigation between every build step and keeps each
  steward order short. Pass = every phase acks AND build verifies.

bots:
  - name: Builder
    port: 3002
    profile: builder
""")

    # -- world_setup ---------------------------------------------------------
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
    parts.append("  # Force-load the chunks covering the maze + spawn — without this,")
    parts.append("  # setblock commands silently fail (\"Could not set the block\") in")
    parts.append("  # chunks that aren't currently loaded, and chests come back empty.")
    parts.append(f"  - rcon: 'execute in landfolk-test run forceload add {ax1} {az1} {ax2} {az2}'")
    parts.append("")
    parts.append(f"  # Arena: clear, then stone/dirt/grass stack.")
    parts.append(f"  - rcon: 'execute in landfolk-test run fill {ax1} 62 {az1} {ax2} 71 {az2} air replace'")
    parts.append(f"  - rcon: 'execute in landfolk-test run fill {ax1} 62 {az1} {ax2} 62 {az2} minecraft:stone'")
    parts.append(f"  - rcon: 'execute in landfolk-test run fill {ax1} 63 {az1} {ax2} 63 {az2} minecraft:dirt'")
    parts.append(f"  - rcon: 'execute in landfolk-test run fill {ax1} 64 {az1} {ax2} 64 {az2} minecraft:grass_block'")
    parts.append("")
    parts.append(f"  # Obsidian floor markers — every # cell. Bot stacks cobble at y=65,66.")
    for ln in setblock_or_fill_obsidian(walls):
        parts.append(f"  - rcon: 'execute in landfolk-test run {ln}'")
    parts.append("")

    # F61: outer perimeter ring (obsidian, 2 blocks tall) so the bot can't
    # shortcut around the maze on the outside. Single gap aligned with the
    # maze's west entrance at z=ent_z. The ring sits 1 cell outside the
    # maze on every side and shares its corners with the maze's own future
    # corners (effectively a double-thickness boundary on three sides).
    maze_xs = sorted({x for (x, _) in walls})
    maze_zs = sorted({z for (_, z) in walls})
    mmin_x, mmax_x = maze_xs[0], maze_xs[-1]
    mmin_z, mmax_z = maze_zs[0], maze_zs[-1]
    ring_min_x = mmin_x - 1
    ring_max_x = mmax_x + 1
    ring_min_z = mmin_z - 1
    ring_max_z = mmax_z + 1
    # Entrance: the only OPEN cell along the maze's west boundary at x=mmin_x.
    open_west_zs = [
        z for z in range(mmin_z, mmax_z + 1)
        if (mmin_x, z) not in {(x, z) for (x, z) in walls}
    ]
    ent_z = open_west_zs[0] if open_west_zs else mmin_z
    parts.append(f"  # F61: outer perimeter obsidian ring (y=65..66) — no walking around the maze.")
    parts.append(f"  # Single gap at (x={ring_min_x}, z={ent_z}) aligned with the maze's west entrance.")
    # West wall — two segments split by the gap at ent_z.
    if ent_z > ring_min_z:
        parts.append(f"  - rcon: 'execute in landfolk-test run fill {ring_min_x} 65 {ring_min_z} {ring_min_x} 66 {ent_z - 1} minecraft:obsidian'")
    if ent_z < ring_max_z:
        parts.append(f"  - rcon: 'execute in landfolk-test run fill {ring_min_x} 65 {ent_z + 1} {ring_min_x} 66 {ring_max_z} minecraft:obsidian'")
    # East / north / south walls — solid.
    parts.append(f"  - rcon: 'execute in landfolk-test run fill {ring_max_x} 65 {ring_min_z} {ring_max_x} 66 {ring_max_z} minecraft:obsidian'")
    parts.append(f"  - rcon: 'execute in landfolk-test run fill {ring_min_x} 65 {ring_min_z} {ring_max_x} 66 {ring_min_z} minecraft:obsidian'")
    parts.append(f"  - rcon: 'execute in landfolk-test run fill {ring_min_x} 65 {ring_max_z} {ring_max_x} 66 {ring_max_z} minecraft:obsidian'")
    parts.append("")
    parts.append(f"  # Chests (C1 at ({c1[0]}, 65, {c1[1]}), C2 at ({c2[0]}, 65, {c2[1]})).")
    parts.append(f"  # Pre-clear to air — `setblock <chest>` is a no-op (\"Could not set the block\")")
    parts.append(f"  # when there's already a chest at the coord (e.g., leftover from a prior run),")
    parts.append(f"  # which leaves the NBT items empty. Explicit air clear avoids this footgun.")
    c1_nbt = CHEST_NBT["1"]
    c2_nbt = CHEST_NBT["2"]
    parts.append(f"  - rcon: 'execute in landfolk-test run setblock {c1[0]} 65 {c1[1]} minecraft:air'")
    parts.append(f"  - rcon: 'execute in landfolk-test run setblock {c1[0]} 65 {c1[1]} minecraft:chest{{Items:{c1_nbt}}}'")
    parts.append(f"  - rcon: 'execute in landfolk-test run setblock {c2[0]} 65 {c2[1]} minecraft:air'")
    parts.append(f"  - rcon: 'execute in landfolk-test run setblock {c2[0]} 65 {c2[1]} minecraft:chest{{Items:{c2_nbt}}}'")
    parts.append("")
    parts.append(f"  # Spawn — west of the entry, facing east.")
    parts.append(f"  - rcon: 'execute in landfolk-test run setworldspawn {SPAWN_X} {SPAWN_Y} {SPAWN_Z}'")
    parts.append(f"  - rcon: 'execute in landfolk-test run spawnpoint Builder {SPAWN_X} {SPAWN_Y} {SPAWN_Z}'")
    parts.append("")

    # -- post_connect --------------------------------------------------------
    parts.append("post_connect_setup:")
    parts.append("  - rcon: 'execute in landfolk-test run effect clear Builder'")
    parts.append("  - rcon: 'execute in landfolk-test run effect give Builder minecraft:saturation 5 10'")
    parts.append("  - rcon: 'execute in landfolk-test run effect give Builder minecraft:instant_health 1 4'")
    parts.append("  - rcon: 'execute in landfolk-test run clear Builder'")
    parts.append("  - rcon: 'execute in landfolk-test run clear Builder'")
    parts.append("  - rcon: 'execute in landfolk-test run xp set Builder 0 levels'")
    parts.append(f"  - rcon: 'execute in landfolk-test run tp Builder {SPAWN_X} {SPAWN_Y} {SPAWN_Z} {SPAWN_YAW} 0'")
    parts.append("")

    # -- marks ---------------------------------------------------------------
    parts.append("marks:")
    parts.append(f"  C1: {{ x: {c1[0]}, y: 65, z: {c1[1]}, note: \"Left chamber chest — cobble + oak_door\" }}")
    parts.append(f"  C2: {{ x: {c2[0]}, y: 65, z: {c2[1]}, note: \"Right chamber chest — cobble + oak_door\" }}")
    parts.append(f"  D1: {{ x: {d1[0]}, y: 65, z: {d1[1]}, note: \"North door slot — place oak_door HERE in M5\" }}")
    parts.append(f"  D2: {{ x: {d2[0]}, y: 65, z: {d2[1]}, note: \"South door slot — place oak_door HERE in M5\" }}")
    parts.append(f"  ENTRY: {{ x: {SPAWN_X}, y: {SPAWN_Y}, z: {SPAWN_Z}, note: \"Bot spawn, west of maze\" }}")
    parts.append("")

    # -- phases --------------------------------------------------------------
    # Strategy: one mission per contiguous wall run. Each mission stocks the
    # relevant chest just before the order goes out, so the bot has to walk
    # back to the chest, withdraw, then build that short fill. Smaller chat
    # batches; more navigation between every step.

    parts.append("phases:")

    def cobble_nbt(count: int) -> str:
        c = max(1, min(64, count))
        return f'[{{Slot:0b,id:"minecraft:cobblestone",count:{c}}},{{Slot:1b,id:"minecraft:stone_pickaxe",count:1}},{{Slot:2b,id:"minecraft:bread",count:4}}]'

    def door_nbt() -> str:
        return '[{Slot:0b,id:"minecraft:oak_door",count:1},{Slot:1b,id:"minecraft:stone_pickaxe",count:1},{Slot:2b,id:"minecraft:bread",count:4}]'

    def stock_chest_rcon(cx: int, cy: int, cz: int, nbt: str) -> list[str]:
        # Air-then-chest to avoid the "same block" no-op silent-fail.
        return [
            f"execute in landfolk-test run setblock {cx} {cy} {cz} minecraft:air",
            f"execute in landfolk-test run setblock {cx} {cy} {cz} minecraft:chest{{Items:{nbt}}}",
        ]

    mission_num = 0

    def mission_id() -> str:
        nonlocal mission_num
        mission_num += 1
        return f"M{mission_num}"

    # -- W1 build missions (one per run; each restocks C1) -------------------
    w1_runs = runs_by_row(w1)
    for (x1, z, x2) in w1_runs:
        mid = mission_id()
        n_cells = x2 - x1 + 1
        n_blocks = n_cells * 2
        stock_count = min(64, n_blocks + 8)
        cells_run = [(x, z) for x in range(x1, x2 + 1)]
        cells65 = cells_yaml(cells_run, 65, "                ")
        cells66 = cells_yaml(cells_run, 66, "                ")
        pre = stock_chest_rcon(c1[0], 65, c1[1], cobble_nbt(stock_count))
        pre_yaml = "\n".join(f"          - '{p}'" for p in pre)
        parts.append(f"""  - id: {mid}
    parallel: false
    missions:
      - id: {mid}
        to: Builder
        pre_rcon:
{pre_yaml}
        text:
          - '@builder {mid}: walk to C1 ({c1[0]} 65 {c1[1]}), `mc list_container {c1[0]} 65 {c1[1]}`, then `mc withdraw cobblestone {stock_count} {c1[0]} 65 {c1[1]}`.'
          - 'Then build this wall run: `mc fill cobblestone {x1} 65 {z} {x2} 66 {z}` ({n_cells} cells, {n_blocks} blocks).'
          - 'DO NOT seal D1 slot at ({d1[0]} 65 {d1[1]}). Emit `{mid} DONE` when the run is up.'
        deadline_tick: 2400
        done_keyword: "{mid} DONE"
        keyword_from: Builder
        verify_after_keyword:
          world: landfolk-test
          checks:
            - label: {mid}_y65
              cells:
{cells65}
              allow: [cobblestone, mossy_cobblestone]
              min_match: {max(1, int(0.8 * n_cells))}
            - label: {mid}_y66
              cells:
{cells66}
              allow: [cobblestone, mossy_cobblestone]
              min_match: {max(1, int(0.8 * n_cells))}
""")

    # -- W2 build missions (one per run; each restocks C2) -------------------
    w2_runs = runs_by_row(w2)
    for (x1, z, x2) in w2_runs:
        mid = mission_id()
        n_cells = x2 - x1 + 1
        n_blocks = n_cells * 2
        stock_count = min(64, n_blocks + 8)
        cells_run = [(x, z) for x in range(x1, x2 + 1)]
        cells65 = cells_yaml(cells_run, 65, "                ")
        cells66 = cells_yaml(cells_run, 66, "                ")
        pre = stock_chest_rcon(c2[0], 65, c2[1], cobble_nbt(stock_count))
        pre_yaml = "\n".join(f"          - '{p}'" for p in pre)
        parts.append(f"""  - id: {mid}
    parallel: false
    missions:
      - id: {mid}
        to: Builder
        pre_rcon:
{pre_yaml}
        text:
          - '@builder {mid}: walk to C2 ({c2[0]} 65 {c2[1]}), `mc list_container {c2[0]} 65 {c2[1]}`, then `mc withdraw cobblestone {stock_count} {c2[0]} 65 {c2[1]}`.'
          - 'Then build this wall run: `mc fill cobblestone {x1} 65 {z} {x2} 66 {z}` ({n_cells} cells, {n_blocks} blocks).'
          - 'DO NOT seal D2 slot at ({d2[0]} 65 {d2[1]}). Emit `{mid} DONE` when the run is up.'
        deadline_tick: 2400
        done_keyword: "{mid} DONE"
        keyword_from: Builder
        verify_after_keyword:
          world: landfolk-test
          checks:
            - label: {mid}_y65
              cells:
{cells65}
              allow: [cobblestone, mossy_cobblestone]
              min_match: {max(1, int(0.8 * n_cells))}
            - label: {mid}_y66
              cells:
{cells66}
              allow: [cobblestone, mossy_cobblestone]
              min_match: {max(1, int(0.8 * n_cells))}
""")

    # -- Door missions (one per door; restock nearest chest with the door) ----
    for slot_name, (sx, sz), chest in [("D1", d1, c1), ("D2", d2, c2)]:
        mid = mission_id()
        pre = stock_chest_rcon(chest[0], 65, chest[1], door_nbt())
        pre_yaml = "\n".join(f"          - '{p}'" for p in pre)
        parts.append(f"""  - id: {mid}
    parallel: false
    missions:
      - id: {mid}
        to: Builder
        pre_rcon:
{pre_yaml}
        text:
          - '@builder {mid}: walk to chest at ({chest[0]} 65 {chest[1]}), withdraw the oak_door: `mc withdraw oak_door 1 {chest[0]} 65 {chest[1]}`.'
          - 'Then place it at slot {slot_name}: `mc place oak_door {sx} 65 {sz}`. A door occupies y=65 and y=66 automatically.'
          - 'Confirm with `mc inspect {sx} 65 {sz}`, then emit `{mid} DONE`.'
        deadline_tick: 2400
        done_keyword: "{mid} DONE"
        keyword_from: Builder
        verify_after_keyword:
          world: landfolk-test
          checks:
            - label: {slot_name}_door
              cells:
                - [{sx}, 65, {sz}]
              allow: [oak_door]
              min_match: 1
""")

    # -- tail ----------------------------------------------------------------
    parts.append("""warning_lead_ticks: 800
hard_overtime_ticks: 1200
global_wallclock_max_seconds: 3600
poll_interval_seconds: 3
chat_history_count: 30
hermes_session_max_turns: 4000
launch_settle_seconds: 2
ready_handshake_timeout_s: 45

cleanup:
  - rcon: 'execute in landfolk-test run kill @e[type=item]'
  - rcon: 'execute in landfolk-test run forceload remove all'

expect:
  all_phases_done: true
  global_timeout_not_hit: true
""")

    return "\n".join(parts)


# --- Main --------------------------------------------------------------------


def main() -> int:
    walls, chests, doors = parse_maze(MAZE)
    if "1" not in chests or "2" not in chests:
        print(f"ERROR: maze must contain '1' and '2' chest labels (found {list(chests)})", file=sys.stderr)
        return 2
    if "D1" not in doors or "D2" not in doors:
        print(f"ERROR: maze must contain exactly 2 'D' door slots (found {list(doors)})", file=sys.stderr)
        return 2

    maze_str = "\n".join(MAZE)
    yaml_text = emit_yaml(maze_str, walls, chests, doors)

    out_path = OUTPUT_PATH if OUTPUT_PATH.is_absolute() else (Path(__file__).resolve().parent.parent / OUTPUT_PATH)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(yaml_text)
    print(f"Wrote {out_path}")
    print(f"  walls: {len(walls)}  (W1 x≤0: {sum(1 for (x,_) in walls if x <= 0)},  W2 x≥1: {sum(1 for (x,_) in walls if x >= 1)})")
    print(f"  chests: {chests}")
    print(f"  doors: {doors}")
    print(f"  spawn: ({SPAWN_X}, {SPAWN_Y}, {SPAWN_Z})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
