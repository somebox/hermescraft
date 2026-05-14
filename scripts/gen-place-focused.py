#!/usr/bin/env python3
"""gen-place-focused.py — 3-mission focused stress test.

Each mission targets a single framework area that has historically failed:
  F1: mine + place near walls   → exercises F67 (dig LOS) + F71 (LOS-aware
                                  goto_near) + place anchor-check
  F2: chest in east half        → exercises F66 (pathfinder canOpenDoors
                                  via D1) + east-half routing + connectivity
                                  guard (target (4,0) is the chokepoint the
                                  generator must not block prematurely)
  F3: chest outside + re-entry  → exercises D0 entrance fence_gate via
                                  pathfinder useOne + F68 LOS guard

Wallclock cap is short (900s) so a stall surfaces fast instead of burning
30 minutes proving the obvious.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

# Reuse maze parser + setblock helpers from the full M3 generator.
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("gpt", HERE / "gen-place-test.py")
gpt = importlib.util.module_from_spec(spec); spec.loader.exec_module(gpt)

OUTPUT_PATH = Path("data/agent-tests/M3_focused.yaml")


def main() -> int:
    walls, chests, doors, open_cells = gpt.parse_maze(gpt.MAZE)
    c1 = chests["1"]; c2 = chests["2"]
    d_internal = doors["D1"]; d_rear = doors["D2"]

    mmin_x = min(x for (x, _) in walls)
    open_west_zs = [z for z in range(min(z for (_, z) in walls), max(z for (_, z) in walls) + 1)
                    if (mmin_x, z) not in {(x, z) for (x, z) in walls}]
    ent_z = open_west_zs[0]
    d_entrance = (mmin_x, ent_z)

    all_xs = [x for (x, _) in walls] + [gpt.SPAWN_X]
    all_zs = [z for (_, z) in walls] + [gpt.SPAWN_Z]
    ax1, ax2 = min(all_xs) - gpt.ARENA_PAD_X, max(all_xs) + gpt.ARENA_PAD_X
    az1, az2 = min(all_zs) - gpt.ARENA_PAD_Z, max(all_zs) + gpt.ARENA_PAD_Z
    chest_outside_coord = (gpt.SPAWN_X - 1, gpt.SPAWN_Z)

    # Hardcoded missions — each picked to stress one historically-failing path.
    missions = [
        {"id": "F1", "item_id": "andesite", "kind": "mine",
         "source": (-2, 2), "target": (1, 1),
         "why": "F71 LOS-aware goto_near + F67 dig-LOS"},
        {"id": "F2", "item_id": "white_wool", "kind": "chest_inside",
         "source": c2, "target": (4, 0),
         "why": "pathfinder D1 traversal + east-half routing"},
        {"id": "F3", "item_id": "red_wool", "kind": "chest_outside",
         "source": chest_outside_coord, "target": (-10, 0),
         "why": "D0 entrance fence_gate exit + re-entry"},
    ]

    parts = []
    parts.append(f"""# M3 FOCUSED — 3-mission stress test for the new framework guards.
#
# GENERATED FROM scripts/gen-place-focused.py — DO NOT HAND-EDIT.
#
# Maze layout:
{chr(10).join(f"#   {ln}" for ln in gpt.MAZE)}
#
# Why this exists: the full 10-mission M3 runs ~25–40 minutes and most of
# that wallclock is wasted re-proving things F71 already fixes. This is a
# focused 3-mission variant — each mission stresses exactly one tricky
# path. Total wallclock budget: 900s.

agent_test_id: M3_focused
world: landfolk-test
description: |
  3-mission focused stress test. Each mission targets one framework guard:
  F1 mining (LOS), F2 east-half chest traversal, F3 outside-chest re-entry.

bots:
  - name: Builder
    port: 3002
    profile: builder

world_setup:
  - rcon: 'execute in landfolk-test run time set 5000'
  - rcon: 'execute in landfolk-test run gamerule doDaylightCycle true'
  - rcon: 'execute in landfolk-test run gamerule keepInventory true'
  - rcon: 'execute in landfolk-test run gamerule doMobSpawning false'
  - rcon: 'execute in landfolk-test run gamerule commandModificationBlockLimit 100000'
  - rcon: 'execute in landfolk-test run weather clear 9999'
  - rcon: 'execute in landfolk-test run kill @e[type=!player]'
  - rcon: 'execute in landfolk-test run forceload add {ax1} {az1} {ax2} {az2}'
  - rcon: 'execute in landfolk-test run fill {ax1} 62 {az1} {ax2} 71 {az2} air replace'
  - rcon: 'execute in landfolk-test run fill {ax1} 62 {az1} {ax2} 62 {az2} minecraft:stone'
  - rcon: 'execute in landfolk-test run fill {ax1} 63 {az1} {ax2} 63 {az2} minecraft:dirt'
  - rcon: 'execute in landfolk-test run fill {ax1} 64 {az1} {ax2} 64 {az2} minecraft:grass_block'
""")

    # Maze walls 3-tall.
    for ln in gpt.setblock_or_fill(walls, "cobblestone"):
        for yy in (65, 66, 67):
            parts.append(f"  - rcon: 'execute in landfolk-test run {ln.replace(' 64 ', f' {yy} ')}'")

    # Perimeter ring (obsidian, y=65..67, one gap at west entrance).
    mmax_x = max(x for (x, _) in walls)
    mmin_z = min(z for (_, z) in walls)
    mmax_z = max(z for (_, z) in walls)
    ring_min_x = mmin_x - 1; ring_max_x = mmax_x + 1
    ring_min_z = mmin_z - 1; ring_max_z = mmax_z + 1
    if ent_z > ring_min_z:
        parts.append(f"  - rcon: 'execute in landfolk-test run fill {ring_min_x} 65 {ring_min_z} {ring_min_x} 67 {ent_z - 1} minecraft:obsidian'")
    if ent_z < ring_max_z:
        parts.append(f"  - rcon: 'execute in landfolk-test run fill {ring_min_x} 65 {ent_z + 1} {ring_min_x} 67 {ring_max_z} minecraft:obsidian'")
    parts.append(f"  - rcon: 'execute in landfolk-test run fill {ring_max_x} 65 {ring_min_z} {ring_max_x} 67 {ring_max_z} minecraft:obsidian'")
    parts.append(f"  - rcon: 'execute in landfolk-test run fill {ring_min_x} 65 {ring_min_z} {ring_max_x} 67 {ring_min_z} minecraft:obsidian'")
    parts.append(f"  - rcon: 'execute in landfolk-test run fill {ring_min_x} 65 {ring_max_z} {ring_max_x} 67 {ring_max_z} minecraft:obsidian'")

    # Fence gates: entrance D0 (east), internal D1 (north), rear D2 (south).
    for (dx, dz, facing) in [
        (d_entrance[0], d_entrance[1], "east"),
        (d_internal[0], d_internal[1], "north"),
        (d_rear[0], d_rear[1], "south"),
    ]:
        parts.append(f"  - rcon: 'execute in landfolk-test run setblock {dx} 65 {dz} minecraft:air'")
        parts.append(f"  - rcon: 'execute in landfolk-test run setblock {dx} 66 {dz} minecraft:air'")
        parts.append(f"  - rcon: 'execute in landfolk-test run setblock {dx} 65 {dz} minecraft:oak_fence_gate[facing={facing},open=false,in_wall=false]'")

    # In-maze chests with simple cobble stock — first mission needing them
    # will overwrite via pre_rcon anyway.
    for cx, cz in (c1, c2):
        parts.append(f"  - rcon: 'execute in landfolk-test run setblock {cx} 65 {cz} minecraft:air'")
        parts.append(f"  - rcon: 'execute in landfolk-test run setblock {cx} 65 {cz} minecraft:chest'")
    parts.append(f"  - rcon: 'execute in landfolk-test run setblock {chest_outside_coord[0]} 65 {chest_outside_coord[1]} minecraft:air'")
    parts.append(f"  - rcon: 'execute in landfolk-test run setblock {chest_outside_coord[0]} 65 {chest_outside_coord[1]} minecraft:chest'")

    parts.append(f"  - rcon: 'execute in landfolk-test run setworldspawn {gpt.SPAWN_X} {gpt.SPAWN_Y} {gpt.SPAWN_Z}'")
    parts.append(f"  - rcon: 'execute in landfolk-test run spawnpoint Builder {gpt.SPAWN_X} {gpt.SPAWN_Y} {gpt.SPAWN_Z}'")
    parts.append("")

    # post_connect_setup
    parts.append("post_connect_setup:")
    parts.append("  - rcon: 'execute in landfolk-test run effect clear Builder'")
    parts.append("  - rcon: 'execute in landfolk-test run effect give Builder minecraft:saturation 5 10'")
    parts.append("  - rcon: 'execute in landfolk-test run effect give Builder minecraft:instant_health 1 4'")
    parts.append("  - rcon: 'execute in landfolk-test run clear Builder'")
    parts.append("  - rcon: 'execute in landfolk-test run xp set Builder 0 levels'")
    parts.append("  - rcon: 'execute in landfolk-test run give Builder minecraft:stone_pickaxe 1'")
    parts.append(f"  - rcon: 'execute in landfolk-test run tp Builder {gpt.SPAWN_X} {gpt.SPAWN_Y} {gpt.SPAWN_Z} {gpt.SPAWN_YAW} 0'")
    parts.append("")

    # marks
    parts.append("marks:")
    parts.append(f"  C1: {{ x: {c1[0]}, y: 65, z: {c1[1]}, note: \"In-maze chest 1 (left)\" }}")
    parts.append(f"  C2: {{ x: {c2[0]}, y: 65, z: {c2[1]}, note: \"In-maze chest 2 (right)\" }}")
    parts.append(f"  C_OUT: {{ x: {chest_outside_coord[0]}, y: 65, z: {chest_outside_coord[1]}, note: \"Outside-the-maze chest\" }}")
    parts.append(f"  D0: {{ x: {d_entrance[0]}, y: 65, z: {d_entrance[1]}, note: \"Maze entrance gate\" }}")
    parts.append(f"  D1: {{ x: {d_internal[0]}, y: 65, z: {d_internal[1]}, note: \"Internal gate (top)\" }}")
    parts.append(f"  D2: {{ x: {d_rear[0]}, y: 65, z: {d_rear[1]}, note: \"Rear gate (bottom)\" }}")
    parts.append(f"  ENTRY: {{ x: {gpt.SPAWN_X}, y: {gpt.SPAWN_Y}, z: {gpt.SPAWN_Z}, note: \"Bot spawn\" }}")
    parts.append("")

    # phases
    parts.append("phases:")
    for m in missions:
        mid = m["id"]; item_id = m["item_id"]; kind = m["kind"]
        tx, tz = m["target"]; sx, sz = m["source"]; why = m["why"]
        pre = []
        if kind in ("chest_inside", "chest_outside"):
            nbt = f'[{{Slot:0b,id:"minecraft:{item_id}",count:1}}]'
            pre.append(f"execute in landfolk-test run setblock {sx} 65 {sz} minecraft:air")
            pre.append(f'execute in landfolk-test run setblock {sx} 65 {sz} minecraft:chest{{Items:{nbt}}}')
        elif kind == "mine":
            pre.append(f"execute in landfolk-test run setblock {sx} 65 {sz} minecraft:{item_id}")
        pre_yaml = "\n".join(f"          - '{p}'" for p in pre)

        if kind == "chest_inside":
            label = "C1" if (sx, sz) == c1 else "C2"
            line1 = (f"@builder {mid}: walk to {label} ({sx},65,{sz}) — gates open "
                     f"automatically as you pathfind through them; `mc withdraw {item_id} 1 {sx} 65 {sz}`.")
        elif kind == "chest_outside":
            line1 = (f"@builder {mid}: walk to outside chest C_OUT ({sx},65,{sz}) "
                     f"(west of spawn, no gate needed); `mc withdraw {item_id} 1 {sx} 65 {sz}`.")
        elif kind == "mine":
            line1 = (f"@builder {mid}: walk to the {item_id} block at ({sx},65,{sz}), "
                     f"`mc dig {sx} 65 {sz}` then `mc collect {item_id} 1`.")
        else:
            line1 = f"@builder {mid}: unknown source."
        line2 = f"Then walk to target ({tx},65,{tz}) and `mc place {item_id} {tx} 65 {tz}`."
        line3 = f"Verify with `mc inspect {tx} 65 {tz}`, then emit `{mid} DONE`."

        parts.append(f"""  - id: {mid}
    parallel: false
    # Why this exists: {why}
    missions:
      - id: {mid}
        to: Builder
        pre_rcon:
{pre_yaml}
        text:
          - '{line1}'
          - '{line2}'
          - '{line3}'
        deadline_tick: 4800
        done_keyword: "{mid} DONE"
        keyword_from: Builder
        verify_after_keyword:
          world: landfolk-test
          checks:
            - label: {mid}_placed
              cells:
                - [{tx}, 65, {tz}]
              allow: [{item_id}]
              min_match: 1
""")

    parts.append("""warning_lead_ticks: 1000
hard_overtime_ticks: 2000
global_wallclock_max_seconds: 900
poll_interval_seconds: 3
chat_history_count: 30
hermes_session_max_turns: 1500
launch_settle_seconds: 2
ready_handshake_timeout_s: 45

cleanup:
  - rcon: 'execute in landfolk-test run kill @e[type=item]'
  - rcon: 'execute in landfolk-test run forceload remove all'

expect:
  all_phases_done: true
  global_timeout_not_hit: true
""")

    out = OUTPUT_PATH if OUTPUT_PATH.is_absolute() else (Path(__file__).resolve().parent.parent / OUTPUT_PATH)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(parts))
    print(f"Wrote {out}")
    print(f"  missions: {len(missions)}")
    print(f"  global wallclock cap: 900s (15 min)")
    for m in missions:
        print(f"    {m['id']}: {m['kind']:14} {m['item_id']:14} src={m['source']} → tgt={m['target']}  [{m['why']}]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
