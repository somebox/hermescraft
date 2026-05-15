#!/usr/bin/env python3
"""test-chest-los.py — F64 verification.

`openContainer` (mc list_container, mc withdraw, mc deposit) previously
accepted any chest within reach (4.5 blocks) regardless of whether the
bot could actually SEE it. Bots opened chests through walls.

F64: raycast from bot eye to the chest cell; refuse with NO_LINE_OF_SIGHT
if every face is occluded by intervening blocks.

Scenarios:
  A — Wall between bot and chest, within reach distance.
      Expect NO_LINE_OF_SIGHT error.
  B — Bot has clear LOS to chest (open air).
      Expect success.
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


def http_post(url: str, body: dict, timeout: float = 30.0) -> dict:
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


def scenario_through_wall(bot_url: str) -> bool:
    print("\n=== A: chest behind a wall — must fail with NO_LINE_OF_SIGHT ===")
    reset_arena()
    # Setup: chest at (2, 65, 0). Wall at (1, 65..66, 0) blocks LOS.
    # Bot teleports to (0, 65, 0) — within 4.5 of chest, but the wall is
    # directly between them.
    rcon_batch([
        f"execute in {WORLD} run setblock 2 65 0 minecraft:chest",
        f"execute in {WORLD} run setblock 1 65 0 minecraft:obsidian",
        f"execute in {WORLD} run setblock 1 66 0 minecraft:obsidian",
        f"execute in {WORLD} run tp Flint 0 65 0 90 0",
    ])
    time.sleep(2.0)
    r = http_post(f"{bot_url}/action/list_container", {"x": 2, "y": 65, "z": 0}, timeout=15)
    ok = bool(r.get("ok"))
    code = r.get("error", {}).get("code") if not ok else None
    print(f"  ok={ok}  code={code}")
    print(f"  result: {str(r.get('result', r.get('error')))[:200]}")
    passed = (not ok) and code == "NO_LINE_OF_SIGHT"
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_clear_view(bot_url: str) -> bool:
    print("\n=== B: chest in open air, clear LOS — must succeed ===")
    reset_arena()
    rcon_batch([
        f"execute in {WORLD} run setblock 2 65 0 minecraft:chest",
        f"execute in {WORLD} run tp Flint 0 65 0 90 0",
    ])
    time.sleep(2.0)
    r = http_post(f"{bot_url}/action/list_container", {"x": 2, "y": 65, "z": 0}, timeout=15)
    ok = bool(r.get("ok"))
    print(f"  ok={ok}")
    print(f"  result: {str(r.get('result', r.get('error')))[:200]}")
    print(f"  → {'PASS' if ok else 'FAIL'}")
    return ok


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--bot-url", default=DEFAULT_BOT_URL)
    args = p.parse_args()
    try:
        s = http_get(f"{args.bot_url}/status?lean=true", timeout=5)
        if not s.get("ok"):
            print(f"bot not ready: {s}")
            return 2
    except Exception as e:
        print(f"can't reach bot: {e}")
        return 2

    results = [
        ("A", scenario_through_wall(args.bot_url)),
        ("B", scenario_clear_view(args.bot_url)),
    ]
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
