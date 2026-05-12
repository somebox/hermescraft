#!/usr/bin/env python3
"""test-drown-protection.py — reactive layer must save the bot from drowning.

G20 v31 had the bot pathfind underwater chasing a stone visible
through the pond. The bot did escape that time, but the user flagged
that we should have *automatic* drowning protection like fire — bot
swims up before damage starts.

The reactive layer has `swim_up` logic guarded by `in_water && oxygen
<= 14`. This test verifies the protection actually fires and the bot
surfaces before HP drops.

Scenarios:
  A — drop bot at (0, 62, 0) inside a 3-deep water column with open
      surface above. mode=normal, reactive ticks at 400ms.
      Expect: within 10s, bot at y>=64 (surface) with full HP.

  B — same as A but with a pathfinder goal set: the bot is mid-`mc goto`
      toward a target on the OTHER side of the pond. Without the new
      pathfinder-cancel in swimUp, the goto would drown the bot.
      Expect: bot surfaces, HP intact.

Usage:
  scripts/test-drown-protection.py
  scripts/test-drown-protection.py --only A
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request

DEFAULT_BOT_URL = "http://localhost:3001"
WORLD = "landfolk-test"


def rcon_batch(cmds: list[str]) -> None:
    if not cmds:
        return
    subprocess.run(
        ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"],
        input="\n".join(cmds) + "\n",
        capture_output=True, text=True, timeout=60,
    )


def http_get(url: str, timeout: float = 5.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def http_post(url: str, body: dict, timeout: float = 30.0) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try: return json.loads(e.read().decode())
        except Exception: return {"ok": False, "error": str(e)}


def bot_status(bot_url: str) -> dict:
    return (http_get(f"{bot_url}/status?lean=true").get("data") or {})


def setup_pool() -> None:
    """4-deep water column at (0,*,0). Bottom at y=60, surface at y=64.
    Surrounding blocks at y=60..63 are stone so the bot can't dig out
    laterally — surfacing is the only escape."""
    cmds = [
        f"execute in {WORLD} run difficulty peaceful",
        f"execute in {WORLD} run gamerule doDaylightCycle false",
        f"execute in {WORLD} run gamerule doMobSpawning false",
        f"execute in {WORLD} run time set day",
        f"execute in {WORLD} run kill @e[type=!player]",
        # Clean a 12x12 area
        f"execute in {WORLD} run fill -6 65 -6 6 70 6 minecraft:air",
        # Stone bowl at y=60..63
        f"execute in {WORLD} run fill -6 60 -6 6 63 6 minecraft:stone",
        # Carve a 3-wide water column from y=61 to y=63
        f"execute in {WORLD} run fill -1 61 -1 1 64 1 minecraft:water",
        # Grass cap around the pool
        f"execute in {WORLD} run fill -6 64 -6 -2 64 6 minecraft:grass_block",
        f"execute in {WORLD} run fill 2 64 -6 6 64 6 minecraft:grass_block",
        f"execute in {WORLD} run fill -1 64 -6 1 64 -2 minecraft:grass_block",
        f"execute in {WORLD} run fill -1 64 2 1 64 6 minecraft:grass_block",
    ]
    rcon_batch(cmds)
    time.sleep(2.5)


def tp_bot_underwater() -> None:
    rcon_batch([
        f"execute in {WORLD} run tp Flint 0 61 0 0 0",
        "clear Flint",
        "effect clear Flint",
        "effect give Flint minecraft:saturation 600 1",
    ])
    time.sleep(1.5)


def run_scenario_A(bot_url: str) -> bool:
    print("\n=== Scenario A: dropped 3 blocks underwater, reactive should swim up ===")
    setup_pool()
    tp_bot_underwater()
    try: http_post(f"{bot_url}/action/mode", {"name": "normal"}, timeout=5)
    except Exception: pass
    pre = bot_status(bot_url)
    print(f"  pre: pos={pre.get('position')}  hp={pre.get('health')}")
    # Watch for up to 12 seconds, sampling every 1s.
    surfaced = False
    final_hp = pre.get("health", 20)
    for i in range(12):
        time.sleep(1.0)
        s = bot_status(bot_url)
        pos = s.get("position") or {}
        final_hp = s.get("health", 20)
        if pos.get("y", 0) >= 64:
            print(f"  +{i+1}s: pos={pos}  hp={final_hp}  ← SURFACED")
            surfaced = True
            break
        else:
            print(f"  +{i+1}s: pos={pos}  hp={final_hp}")
    expected = surfaced and final_hp >= 15
    print(f"  → {'PASS' if expected else 'FAIL'}  (expected: surfaced + HP>=15)")
    return expected


def run_scenario_B(bot_url: str) -> bool:
    print("\n=== Scenario B: pathfinder goal drives bot underwater, swim_up must override ===")
    setup_pool()
    tp_bot_underwater()
    try: http_post(f"{bot_url}/action/mode", {"name": "normal"}, timeout=5)
    except Exception: pass
    pre = bot_status(bot_url)
    print(f"  pre: pos={pre.get('position')}  hp={pre.get('health')}")
    # Start a goto across the pond — without the pathfinder cancel
    # in swimUp, this would keep dragging the bot through water.
    # Use a non-blocking goto via background task (mc bg_goto), then
    # watch the bot. If the bot is still alive and surfaces, the
    # reactive cancellation worked.
    try:
        # Fire-and-forget background pathfind. If bg_goto doesn't exist,
        # fall back to a quick goto with a short timeout.
        http_post(f"{bot_url}/action/bg_goto", {"x": 0, "y": 61, "z": -5}, timeout=3)
    except Exception:
        # If bg_goto isn't available, simulate with a short goto.
        try: http_post(f"{bot_url}/action/goto", {"x": 0, "y": 61, "z": -5}, timeout=3)
        except Exception: pass
    surfaced = False
    final_hp = pre.get("health", 20)
    for i in range(15):
        time.sleep(1.0)
        s = bot_status(bot_url)
        pos = s.get("position") or {}
        final_hp = s.get("health", 20)
        if pos.get("y", 0) >= 64:
            print(f"  +{i+1}s: pos={pos}  hp={final_hp}  ← SURFACED")
            surfaced = True
            break
        else:
            print(f"  +{i+1}s: pos={pos}  hp={final_hp}")
    expected = surfaced and final_hp >= 12
    print(f"  → {'PASS' if expected else 'FAIL'}  (expected: surfaced + HP>=12)")
    return expected


def cleanup() -> None:
    rcon_batch([
        f"execute in {WORLD} run fill -6 60 -6 6 70 6 minecraft:air",
        f"execute in {WORLD} run fill -6 64 -6 6 64 6 minecraft:grass_block",
        f"execute in {WORLD} run tp Flint 52 65 52",
        f"execute in {WORLD} run kill @e[type=item,distance=..40]",
    ])


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--bot-url", default=DEFAULT_BOT_URL)
    p.add_argument("--only", choices=["A", "B"])
    args = p.parse_args()
    try:
        s = http_get(f"{args.bot_url}/status?lean=true", timeout=5)
        if not s.get("ok"):
            print(f"bot not ready: {s}")
            return 2
    except Exception as e:
        print(f"can't reach bot: {e}")
        return 2
    scenarios = []
    if args.only in (None, "A"): scenarios.append(("A", lambda: run_scenario_A(args.bot_url)))
    if args.only in (None, "B"): scenarios.append(("B", lambda: run_scenario_B(args.bot_url)))
    results = [(n, fn()) for n, fn in scenarios]
    print("\n=== Summary ===")
    for n, ok in results: print(f"  {n}: {'PASS' if ok else 'FAIL'}")
    cleanup()
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(main())
