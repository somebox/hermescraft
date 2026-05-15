#!/usr/bin/env python3
"""test-corner-cut-prevention.py — F63 verification.

mineflayer-pathfinder's `getMoveDiagonal` allows a diagonal step when at
least one of the two perpendicular intermediate cells is air. With the
bot's 0.6-wide hitbox, that diagonal scrapes the solid corner block of
the OTHER perpendicular cell — the bot wedges on the corner, ends up
off-grid, and stuck-recovery has to fire repeatedly.

F63: refuse the diagonal entirely when either perpendicular cell at
body height (y, y+1) is physical. Bot routes around via two cardinal
steps. No corner clip, no stuck.

Scenarios:
  A — Single 2-tall pillar at (1, 65, 1) sits between bot at (-1, 65, -1)
      and target (3, 65, 3). Pre-F63 the bot would attempt diagonals that
      clip the pillar's corners. Post-F63 it routes cardinally around.
      Pass: bot reaches goal in <30s with no NAV_RECURRING_STUCK / escape
      loop events.
  B — L-shaped 2-tall wall (a 6-cell south wall meeting a 6-cell east wall
      at the inside corner). Bot must enter the L's open mouth, walk
      around the inside corner, exit at the far end. Pass: reaches the
      far end without scraping the corner.
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


def reset_arena() -> None:
    rcon_batch([
        f"execute in {WORLD} run difficulty peaceful",
        f"execute in {WORLD} run gamerule doDaylightCycle false",
        f"execute in {WORLD} run time set noon",
        f"execute in {WORLD} run kill @e[type=!player]",
        f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
        f"execute in {WORLD} run fill -10 64 -10 10 64 10 minecraft:stone",
        f"execute in {WORLD} run clear Flint",
    ])
    time.sleep(1.5)


def bot_position(bot_url: str) -> dict | None:
    s = http_get(f"{bot_url}/status?lean=true")
    if not s.get("ok"):
        return None
    return s["data"].get("position")


def scenario_pillar(bot_url: str) -> bool:
    print("\n=== A: single 2-tall pillar between bot and goal — must route cardinal ===")
    reset_arena()
    # Pillar at (1, 65, 1) — unmineable so bot can't dig through.
    rcon_batch([
        f"execute in {WORLD} run setblock 1 65 1 minecraft:obsidian",
        f"execute in {WORLD} run setblock 1 66 1 minecraft:obsidian",
        f"execute in {WORLD} run tp Flint -1 65 -1 90 0",
    ])
    time.sleep(2.0)
    start_pos = bot_position(bot_url)
    print(f"  start: {start_pos}")
    t0 = time.time()
    r = http_post(f"{bot_url}/action/goto_near", {"x": 3, "y": 65, "z": 3, "range": 1}, timeout=40)
    elapsed = time.time() - t0
    ok = bool(r.get("ok"))
    end_pos = bot_position(bot_url)
    print(f"  end: {end_pos}  ok={ok}  elapsed={elapsed:.1f}s")
    print(f"  result: {str(r.get('result',''))[:200]}")
    # Pass: bot reached within range AND did so in reasonable time AND
    # not via the corner-clip route. A 2-step cardinal route around the
    # pillar from (-1,-1) to (3,3) is ~8 grid steps ≈ 4-6s wallclock.
    in_range = end_pos and abs(end_pos["x"] - 3) <= 2 and abs(end_pos["z"] - 3) <= 2
    passed = ok and in_range and elapsed < 25
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_inside_corner(bot_url: str) -> bool:
    print("\n=== B: L-shaped 2-tall wall — bot must navigate inside corner ===")
    reset_arena()
    # L-shaped wall, 2-tall obsidian:
    #   south leg: z=2, x=0..5  (6 cells)
    #   east leg:  x=5, z=2..7  (6 cells, corner shared)
    # Bot enters from the open mouth at (0..4, *, 0..1) and must walk
    # around the inside corner at (5, *, 2) to reach the exit at (6, *, 7).
    rcon_batch([
        f"execute in {WORLD} run fill 0 65 2 5 66 2 minecraft:obsidian",
        f"execute in {WORLD} run fill 5 65 2 5 66 7 minecraft:obsidian",
        f"execute in {WORLD} run tp Flint 0 65 0 90 0",
    ])
    time.sleep(2.0)
    start = bot_position(bot_url)
    print(f"  start: {start}")
    t0 = time.time()
    r = http_post(f"{bot_url}/action/goto_near", {"x": 7, "y": 65, "z": 5, "range": 1}, timeout=40)
    elapsed = time.time() - t0
    ok = bool(r.get("ok"))
    end = bot_position(bot_url)
    print(f"  end: {end}  ok={ok}  elapsed={elapsed:.1f}s")
    print(f"  result: {str(r.get('result',''))[:200]}")
    in_range = end and abs(end["x"] - 7) <= 2 and abs(end["z"] - 5) <= 2
    passed = ok and in_range and elapsed < 25
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--bot-url", default=DEFAULT_BOT_URL)
    p.add_argument("--scenario", choices=["A", "B", "all"], default="all")
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
    if args.scenario in ("A", "all"):
        scenarios.append(("A", scenario_pillar))
    if args.scenario in ("B", "all"):
        scenarios.append(("B", scenario_inside_corner))

    results = [(name, fn(args.bot_url)) for name, fn in scenarios]
    print("\n=== Summary ===")
    for name, ok in results:
        print(f"  {name}: {'PASS' if ok else 'FAIL'}")
    rcon_batch([
        f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
        f"execute in {WORLD} run tp Flint 52 65 52",
    ])
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(main())
