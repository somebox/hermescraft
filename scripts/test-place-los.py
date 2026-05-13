#!/usr/bin/env python3
"""test-place-los.py — F45.3 verification.

Verifies that `mc place` raycasts line-of-sight before placing, preventing
the "place through wall" exploit (parallel to the G20 attack-through-wall
hole F42 closed for combat).

Scenarios:
  A — Wall: 3×3 cobblestone wall at x=2, bot at (0,65,0), target cell at
      (4,65,0) — behind the wall. Expect ok=false, code=NO_LINE_OF_SIGHT.

  B — Open: same setup but the wall removed. Expect ok=true (placement
      succeeds) or a different error (not NO_LINE_OF_SIGHT).
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


def setup_arena(with_wall: bool) -> None:
    cmds = [
        f"execute in {WORLD} run difficulty peaceful",
        f"execute in {WORLD} run gamerule doDaylightCycle false",
        f"execute in {WORLD} run time set noon",
        f"execute in {WORLD} run kill @e[type=!player]",
        f"execute in {WORLD} run fill -10 65 -10 10 80 10 minecraft:air",
        f"execute in {WORLD} run fill -10 64 -10 10 64 10 minecraft:stone",
        f"execute in {WORLD} run tp Flint 0 65 0 90 0",
        "clear Flint",
        "give Flint minecraft:cobblestone 64",
    ]
    if with_wall:
        # 3x3 wall at x=2, y=64..66, z=-1..1 — between bot at (0,65,0)
        # and target cell at (4,65,0). Note: y=64 is floor (already stone),
        # so wall blocks only y=65/66.
        cmds.append(f"execute in {WORLD} run fill 2 65 -1 2 66 1 minecraft:cobblestone")
    rcon_batch(cmds)
    time.sleep(1.5)


def scenario_wall(bot_url: str) -> bool:
    print("\n=== A: place behind 3x3 cobble wall — expect NO_LINE_OF_SIGHT ===")
    setup_arena(with_wall=True)
    r = http_post(
        f"{bot_url}/action/place",
        {"block": "cobblestone", "x": 4, "y": 65, "z": 0},
        timeout=12,
    )
    ok = bool(r.get("ok"))
    err = r.get("error") or {}
    code = err.get("code") if isinstance(err, dict) else ""
    msg = (err.get("message") or "")[:140] if isinstance(err, dict) else ""
    print(f"  ok={ok}  code={code}  msg={msg}")
    passed = (not ok) and code == "NO_LINE_OF_SIGHT"
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_open(bot_url: str) -> bool:
    print("\n=== B: place with clear LOS — expect success (or non-LOS error) ===")
    setup_arena(with_wall=False)
    r = http_post(
        f"{bot_url}/action/place",
        {"block": "cobblestone", "x": 4, "y": 65, "z": 0},
        timeout=12,
    )
    ok = bool(r.get("ok"))
    err = r.get("error") or {}
    code = err.get("code") if isinstance(err, dict) else ""
    print(f"  ok={ok}  code={code}")
    # Pass if placement succeeded OR failed for a non-LOS reason. The
    # invariant is: clear LOS must NOT yield NO_LINE_OF_SIGHT.
    passed = ok or code != "NO_LINE_OF_SIGHT"
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


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
        ("A", scenario_wall(args.bot_url)),
        ("B", scenario_open(args.bot_url)),
    ]

    print("\n=== Summary ===")
    for name, ok in results:
        print(f"  {name}: {'PASS' if ok else 'FAIL'}")

    rcon_batch([
        f"execute in {WORLD} run fill -10 65 -10 10 80 10 minecraft:air",
        f"execute in {WORLD} run tp Flint 52 65 52",
    ])
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(main())
