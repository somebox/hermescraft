#!/usr/bin/env python3
"""test-door-pathfind.py — door traversal matrix.

Builds a sealed obsidian box (5×5, 2-tall walls) and places a single
oak_door on the wall facing the bot's travel direction. Bot starts
outside, target is inside the box. The ONLY route is through the door.

Matrix axes:
  - travel direction: bot approaches from W/E/N/S (door is on that wall)
  - door starting state: open / closed
  - hinge: left / right

Per-scenario expectations:
  - F69 (open door, any hinge):  bot walks straight through. PASS.
  - F66+F69 (closed door):        bot opens via pathfinder useOne, then
                                  walks through. PASS for sensible hinges.

Closed-door failure modes worth surfacing:
  - bot never reaches the door  → pathfinder rejected the move
  - bot opens then door re-closes → state-flicker bug
  - bot opens but stalls inside the cell → physics collision with the
                                          swung-open slab on the wrong side
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

from _test_lib import default_bot_url
DEFAULT_BOT_URL = default_bot_url("flint")
WORLD = "landfolk-test"


def rcon_batch(cmds):
    if not cmds:
        return ""
    r = subprocess.run(
        ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"],
        input="\n".join(cmds) + "\n",
        capture_output=True,
        text=True,
        timeout=60,
    )
    return r.stdout


def http_get(url, timeout=10.0):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def http_post(url, body, timeout=30.0):
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {"ok": False, "error": {"message": str(e), "code": "HTTP_ERROR"}}


# ── Per-direction geometry ────────────────────────────────────────────────
# Box is 5×3×5, centered at (5, 65, 0). One wall has a door slot at
# the cell named below. Bot spawns on the OPPOSITE side of that wall.
#
# direction = which wall the door is on, i.e. the side the bot approaches from
GEOMETRY = {
    "west": {
        "door": (3, 0),       # door cell on west wall
        "bot_start": (-3, 0), # bot spawns west of box
        "target": (5, 0),     # target inside box (east of door)
        "walls": {
            # (axis, x1, z1, x2, z2)
            "west":  (3, -2, 3,  2),
            "east":  (7, -2, 7,  2),
            "north": (3, -2, 7, -2),
            "south": (3,  2, 7,  2),
        },
        "wall_with_gap": "west",
    },
    "east": {
        "door": (7, 0),
        "bot_start": (13, 0),
        "target": (5, 0),
        "walls": {
            "west":  (3, -2, 3,  2),
            "east":  (7, -2, 7,  2),
            "north": (3, -2, 7, -2),
            "south": (3,  2, 7,  2),
        },
        "wall_with_gap": "east",
    },
    "north": {
        "door": (5, -2),
        "bot_start": (5, -8),
        "target": (5, 0),
        "walls": {
            "west":  (3, -2, 3,  2),
            "east":  (7, -2, 7,  2),
            "north": (3, -2, 7, -2),
            "south": (3,  2, 7,  2),
        },
        "wall_with_gap": "north",
    },
    "south": {
        "door": (5, 2),
        "bot_start": (5, 8),
        "target": (5, 0),
        "walls": {
            "west":  (3, -2, 3,  2),
            "east":  (7, -2, 7,  2),
            "north": (3, -2, 7, -2),
            "south": (3,  2, 7,  2),
        },
        "wall_with_gap": "south",
    },
}


def reset_arena():
    rcon_batch([
        f"execute in {WORLD} run forceload add -16 -16 16 16",
        f"execute in {WORLD} run difficulty peaceful",
        f"execute in {WORLD} run gamerule doDaylightCycle false",
        f"execute in {WORLD} run time set noon",
        f"execute in {WORLD} run kill @e[type=!player]",
        f"execute in {WORLD} run fill -16 60 -16 16 80 16 minecraft:air",
        f"execute in {WORLD} run fill -16 64 -16 16 64 16 minecraft:stone",
    ])
    time.sleep(0.5)


def build_box(direction, door_facing, hinge, door_open):
    """Construct sealed obsidian box. The wall in `direction` has a 1-cell
    gap at the door coord, filled with the configured oak_door."""
    geo = GEOMETRY[direction]
    dx, dz = geo["door"]
    gap_wall = geo["wall_with_gap"]
    cmds = []
    for name, (x1, z1, x2, z2) in geo["walls"].items():
        cmds.append(f"execute in {WORLD} run fill {x1} 65 {z1} {x2} 66 {z2} minecraft:obsidian")
    # Carve the door gap (clear two-tall slot at door coord).
    cmds.append(f"execute in {WORLD} run setblock {dx} 65 {dz} minecraft:air")
    cmds.append(f"execute in {WORLD} run setblock {dx} 66 {dz} minecraft:air")
    open_str = "true" if door_open else "false"
    cmds.append(
        f"execute in {WORLD} run setblock {dx} 65 {dz} "
        f"minecraft:oak_door[half=lower,facing={door_facing},open={open_str},hinge={hinge}]"
    )
    cmds.append(
        f"execute in {WORLD} run setblock {dx} 66 {dz} "
        f"minecraft:oak_door[half=upper,facing={door_facing},open={open_str},hinge={hinge}]"
    )
    bx, bz = geo["bot_start"]
    cmds.append(f"execute in {WORLD} run tp Flint {bx} 65 {bz} 0 0")
    rcon_batch(cmds)
    time.sleep(1.5)


def door_state(direction):
    geo = GEOMETRY[direction]
    dx, dz = geo["door"]
    r = subprocess.run(
        ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"],
        input=f"execute in {WORLD} if block {dx} 65 {dz} oak_door[open=true]\n",
        capture_output=True, text=True, timeout=20,
    )
    return "open" if "Test passed" in r.stdout else "closed"


def in_box(pos):
    return 3 < pos["x"] < 7.5 and -2 < pos["z"] < 2 and pos["y"] >= 65


def run_scenario(bot_url, direction, door_facing, hinge, door_open):
    label = f"dir={direction} face={door_facing} hinge={hinge} start={'open' if door_open else 'closed'}"
    print(f"\n--- {label} ---")
    reset_arena()
    build_box(direction, door_facing, hinge, door_open)
    print(f"  initial door state: {door_state(direction)}")
    tx, tz = GEOMETRY[direction]["target"]
    t0 = time.time()
    r = http_post(f"{bot_url}/action/goto_near", {"x": tx, "y": 65, "z": tz, "range": 1}, timeout=15)
    elapsed = time.time() - t0
    ok = bool(r.get("ok"))
    s = http_get(f"{bot_url}/status?lean=true")
    pos = s["data"]["position"]
    inside = in_box(pos)
    passed = ok and inside and elapsed < 12
    print(f"  elapsed={elapsed:.1f}s ok={ok} pos=({pos['x']:.1f},{pos['y']:.0f},{pos['z']:.1f}) inside_box={inside} door_now={door_state(direction)}")
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--bot-url", default=DEFAULT_BOT_URL)
    p.add_argument("--only", default=None, help="filter to a single scenario index")
    args = p.parse_args()

    try:
        s = http_get(f"{args.bot_url}/status?lean=true", timeout=5)
        if not s.get("ok"):
            print(f"bot not ready: {s}"); return 2
    except Exception as e:
        print(f"can't reach bot: {e}"); return 2

    # Scenario list. Doors are placed so the "outside" face (which the
    # bot approaches) points toward the bot. With this orientation the
    # open-door slab swings INTO the cell on a side perpendicular to the
    # bot's travel axis — leaving the travel path clear. Reversing the
    # facing (door's back to the bot) puts the slab across the travel
    # axis and physically blocks traversal regardless of hinge — that's
    # a game-physics fact, not a pathfinder bug.
    base = [
        ("west",  "west",  "left",  False),   # bot west of box, walks east, door faces west
        ("west",  "west",  "right", False),
        ("west",  "west",  "left",  True),    # F69 regression: open door
        ("west",  "west",  "right", True),
        ("east",  "east",  "left",  False),   # bot east, walks west
        ("east",  "east",  "right", False),
        ("north", "north", "left",  False),   # bot north, walks south
        ("north", "north", "right", False),
        ("south", "south", "left",  False),   # bot south, walks north
        ("south", "south", "right", False),
    ]
    scenarios = base if not args.only else [base[int(args.only)]]

    results = []
    for sc in scenarios:
        results.append((sc, run_scenario(args.bot_url, *sc)))

    print("\n=== Summary ===")
    n_pass = 0
    for sc, ok in results:
        tag = f"dir={sc[0]:>5} face={sc[1]:>5} hinge={sc[2]:>5} start={'open' if sc[3] else 'closed'}"
        print(f"  {'PASS' if ok else 'FAIL'}  {tag}")
        if ok: n_pass += 1
    print(f"\n  {n_pass}/{len(results)} scenarios passed")

    rcon_batch([
        f"execute in {WORLD} run fill -16 60 -16 16 80 16 minecraft:air",
        f"execute in {WORLD} run forceload remove all",
    ])
    return 0 if n_pass == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
