#!/usr/bin/env python3
"""test-pickup-blocked.py — pickup pass shouldn't stall on a blocked drop.

The G20 v28 / v23 observation: after mining a cobblestone deposit, one
drop lands in a spot directly behind a cobblestone BLOCK on the
ground. The bot wedges trying to walk straight through the block — the
sync-stuck watchdog wiggles, the per-drop timeout fires, and ~3+ seconds
are lost per blocked drop. After enough drops, the bot is past sunset.

The fix: bump GoalNear radius from 1.0 → 1.5 (Minecraft's auto-pickup
magnet radius), reduce per-drop timeout to 1500ms, and do a centroid
"broom sweep" at the top of each pickup attempt so the magnet grabs
multiple drops at once while pathfinder routes around obstacles.

Scenarios:
  A — drop at (1,65,1), bot at (3,65,1), nothing in the way.
      Expect: cobble in inventory within ~1.5s.

  B — drop at (1,65,1), bot at (3,65,1), cobblestone BLOCK at (2,65,1)
      directly in the path. Expect: cobble in inventory within ~3s
      (bot must route around or jump over).

  C — three drops scattered around the bot at radius ~2. Expect: all
      three picked up via the centroid broom sweep.

Usage:
  scripts/test-pickup-blocked.py
  scripts/test-pickup-blocked.py --only B
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request

from _test_lib import default_bot_url
DEFAULT_BOT_URL = default_bot_url("flint")
WORLD = "landfolk-test"


def rcon_batch(cmds: list[str]) -> None:
    if not cmds:
        return
    subprocess.run(
        ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"],
        input="\n".join(cmds) + "\n",
        capture_output=True, text=True, timeout=60,
    )


def rcon(cmd: str) -> str:
    r = subprocess.run(
        ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"],
        input=cmd + "\n", capture_output=True, text=True, timeout=20,
    )
    return r.stdout.strip()


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


def cobble_count(bot_url: str) -> int:
    s = http_get(f"{bot_url}/status?lean=true")
    for it in (s.get("data") or {}).get("inventory", []) or []:
        if it.get("name") == "cobblestone":
            return int(it.get("count") or 0)
    return 0


def hold_mode(bot_url: str) -> None:
    try: http_post(f"{bot_url}/action/mode", {"name": "hold"}, timeout=5)
    except Exception: pass


def base_setup(extra_cmds: list[str]) -> None:
    cmds = [
        f"execute in {WORLD} run difficulty peaceful",
        f"execute in {WORLD} run gamerule doDaylightCycle false",
        f"execute in {WORLD} run gamerule doMobSpawning false",
        f"execute in {WORLD} run time set day",
        f"execute in {WORLD} run kill @e[type=!player]",
        f"execute in {WORLD} run fill -8 65 -8 8 70 8 minecraft:air",
        f"execute in {WORLD} run fill -8 64 -8 8 64 8 minecraft:grass_block",
    ]
    cmds += extra_cmds
    cmds += [
        f"execute in {WORLD} run tp Flint 3 65 1 270 0",   # face -x (west)
        "clear Flint",
        "effect clear Flint",
        "effect give Flint minecraft:saturation 600 1",
    ]
    rcon_batch(cmds)
    time.sleep(3.5)


def spawn_cobble_drop(x: float, y: float, z: float) -> None:
    """rcon-summon a cobblestone item entity at (x,y,z) — equivalent to a
    natural mining drop. Use NoGravity:0 + Motion:[0,0,0] so it falls and
    settles immediately on the ground beneath."""
    rcon(
        f"execute in {WORLD} run summon item {x} {y} {z} "
        f"{{Item:{{id:\"minecraft:cobblestone\",count:1}},"
        f"PickupDelay:0,Age:0,Motion:[0d,0d,0d]}}"
    )


def setup_A() -> None:
    base_setup([])
    spawn_cobble_drop(1.5, 65.5, 1.5)


def setup_B() -> None:
    base_setup([
        # Cobble block at (2,65,1) — directly between bot (3,65,1) and drop (1,65,1)
        f"execute in {WORLD} run setblock 2 65 1 minecraft:cobblestone",
    ])
    spawn_cobble_drop(1.5, 65.5, 1.5)


def setup_C() -> None:
    base_setup([])
    spawn_cobble_drop(1.5, 65.5, 1.5)
    spawn_cobble_drop(4.5, 65.5, 3.5)
    spawn_cobble_drop(2.5, 65.5, -1.5)


def run_scenario(name: str, setup_fn, expected_count: int, time_limit_s: float, bot_url: str) -> bool:
    print(f"\n=== Scenario {name}: expect {expected_count} cobble picked up within {time_limit_s}s ===")
    setup_fn()
    hold_mode(bot_url)
    pre = cobble_count(bot_url)
    print(f"  pre cobble: {pre}")
    start = time.time()
    r = http_post(f"{bot_url}/action/pickup", {}, timeout=30)
    elapsed = time.time() - start
    print(f"  pickup: ok={r.get('ok')}  elapsed={elapsed:.2f}s  result={(r.get('data') or {}).get('result') or r.get('result') or ''}")
    time.sleep(0.4)
    post = cobble_count(bot_url)
    gained = post - pre
    print(f"  post cobble: {post}  (gained {gained})")
    expected = gained >= expected_count and elapsed <= time_limit_s
    print(f"  → {'PASS' if expected else 'FAIL'}")
    return expected


def cleanup() -> None:
    rcon_batch([
        f"execute in {WORLD} run fill -8 65 -8 8 70 8 minecraft:air",
        f"execute in {WORLD} run fill -8 64 -8 8 64 8 minecraft:grass_block",
        f"execute in {WORLD} run tp Flint 52 65 52",
        f"execute in {WORLD} run kill @e[type=item,distance=..40]",
    ])


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--bot-url", default=DEFAULT_BOT_URL)
    p.add_argument("--only", choices=["A", "B", "C"])
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
    if args.only in (None, "A"): scenarios.append(("A", lambda: run_scenario("A", setup_A, 1, 3.0, args.bot_url)))
    if args.only in (None, "B"): scenarios.append(("B", lambda: run_scenario("B", setup_B, 1, 4.0, args.bot_url)))
    if args.only in (None, "C"): scenarios.append(("C", lambda: run_scenario("C", setup_C, 3, 8.0, args.bot_url)))

    results = [(n, fn()) for n, fn in scenarios]
    print("\n=== Summary ===")
    for n, ok in results: print(f"  {n}: {'PASS' if ok else 'FAIL'}")
    cleanup()
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(main())
