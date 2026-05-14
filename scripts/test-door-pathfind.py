#!/usr/bin/env python3
"""test-door-pathfind.py — verify the bot can navigate through doors.

Setup: A 5-cell-wide stone corridor at z=0 with a 2-tall wall blocking
the middle, except for a single closed oak_door at (0, 65, 0). Bot
teleported to (-3, 65, 0) on the west side, asked to goto_near (+3, 65, 0)
on the east side. Only path is through the door.

Pre F66+canOpenDoors: pathfinder treats the closed door as impassable
and the goto times out / fails.
Post F66+canOpenDoors=true: pathfinder auto-interacts with the door
and walks through.

Run only AFTER bot has been restarted with the F66 patch applied.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BOT_URL = "http://localhost:3002"
WORLD = "landfolk-test"


def rcon_batch(cmds: list[str]) -> str:
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


def http_get(url: str, timeout: float = 10.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def http_post(url: str, body: dict, timeout: float = 60.0) -> dict:
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


def setup_door_corridor(facing: str = "east") -> None:
    """Build a sealed 5x3x5 box at (3..7, 65..67, -2..2) with a single
    closed oak_door at (3, 65, 0) on its west wall. Outside is open
    arena. Bot at (-3, 65, 0) must reach (5, 65, 0) inside — only path
    is through the door."""
    rcon_batch([
        f"execute in {WORLD} run forceload add -16 -16 16 16",
        f"execute in {WORLD} run difficulty peaceful",
        f"execute in {WORLD} run gamerule doDaylightCycle false",
        f"execute in {WORLD} run time set noon",
        f"execute in {WORLD} run kill @e[type=!player]",
        f"execute in {WORLD} run fill -15 60 -15 15 80 15 minecraft:air",
        f"execute in {WORLD} run fill -15 64 -15 15 64 15 minecraft:stone",
        # Build sealed box: 5-wide, 5-deep, 2-tall walls.
        # West  wall: x=3, z=-2..2, y=65..66
        # East  wall: x=7
        # North wall: z=-2, x=3..7
        # South wall: z=2,  x=3..7
        # Roof:        y=67, x=3..7, z=-2..2 (so bot can't jump in)
        f"execute in {WORLD} run fill 3 65 -2 3 66 2 minecraft:obsidian",  # west
        f"execute in {WORLD} run fill 7 65 -2 7 66 2 minecraft:obsidian",  # east
        f"execute in {WORLD} run fill 3 65 -2 7 66 -2 minecraft:obsidian", # north
        f"execute in {WORLD} run fill 3 65 2 7 66 2 minecraft:obsidian",   # south
        # (no roof — open box, bot just needs to walk in)
        # Carve the door slot in west wall at (3, *, 0)
        f"execute in {WORLD} run setblock 3 65 0 minecraft:air",
        f"execute in {WORLD} run setblock 3 66 0 minecraft:air",
        # Place a PRE-OPEN door at the gap to test pure traversal first
        f"execute in {WORLD} run setblock 3 65 0 minecraft:oak_door[half=lower,facing={facing},open=true,hinge=left]",
        f"execute in {WORLD} run setblock 3 66 0 minecraft:oak_door[half=upper,facing={facing},open=true,hinge=left]",
        # Place bot outside the box on the west side
        f"execute in {WORLD} run tp Flint -3 65 0 90 0",
    ])
    time.sleep(2.0)


def door_open(bot_url: str) -> str:
    """Returns 'open', 'closed', or 'unknown'."""
    r = subprocess.run(
        ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"],
        input=f"execute in {WORLD} if block 3 65 0 oak_door[open=true]\n",
        capture_output=True, text=True, timeout=20,
    )
    if "Test passed" in r.stdout:
        return "open"
    if "Test failed" in r.stdout:
        return "closed"
    return "unknown"


def scenario(bot_url: str, facing: str) -> bool:
    print(f"\n=== Door facing={facing}: bot must enter sealed box via door ===")
    setup_door_corridor(facing)
    print(f"  initial door state: {door_open(bot_url)}")
    t0 = time.time()
    # Target is INSIDE the sealed box at (5, 65, 0). Door at (3, 65, 0) is
    # the only entry. range=1 means bot stops within 1 block of target.
    r = http_post(f"{bot_url}/action/goto_near", {"x": 5, "y": 65, "z": 0, "range": 1}, timeout=30)
    elapsed = time.time() - t0
    ok = bool(r.get("ok"))
    s = http_get(f"{bot_url}/status?lean=true")
    pos = s["data"]["position"]
    inside_box = 3 < pos["x"] < 7.5 and -2 < pos["z"] < 2 and pos["y"] >= 65
    print(f"  elapsed={elapsed:.1f}s  ok={ok}  final_pos={pos}  inside_box={inside_box}  door_now={door_open(bot_url)}")
    print(f"  result: {str(r.get('result', r.get('error')))[:200]}")
    passed = ok and inside_box and elapsed < 20
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--bot-url", default=DEFAULT_BOT_URL)
    p.add_argument("--facing", default="east", choices=["east", "west", "north", "south"])
    args = p.parse_args()
    try:
        s = http_get(f"{args.bot_url}/status?lean=true", timeout=5)
        if not s.get("ok"):
            print(f"bot not ready: {s}")
            return 2
    except Exception as e:
        print(f"can't reach bot: {e}")
        return 2

    # Test both facings to see if door orientation matters
    results = [
        ("east",  scenario(args.bot_url, "east")),
        ("west",  scenario(args.bot_url, "west")),
        ("north", scenario(args.bot_url, "north")),
    ]
    print("\n=== Summary ===")
    for name, ok in results:
        print(f"  facing={name}: {'PASS' if ok else 'FAIL'}")
    rcon_batch([
        f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
        f"execute in {WORLD} run forceload remove all",
    ])
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(main())
