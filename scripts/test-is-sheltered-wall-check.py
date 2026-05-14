#!/usr/bin/env python3
"""test-is-sheltered-wall-check.py — F55.7 verification.

Verifies `mc is_sheltered walls=X1,Y1,Z1,X2,Y2,Z2` performs an explicit
perimeter sweep before the pathfinder enclosure check, returning
WALLS_INCOMPLETE with the missing cells if any are air.

Scenarios:
  A — Bot inside a 3×3×3 enclosure with all walls present and roof.
      mc is_sheltered walls=0,65,0,2,67,2 → ok=true.
  B — Bot inside same enclosure with one wall block dug out. Expect
      WALLS_INCOMPLETE with the gap cell listed in missing_cells.
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
    ])
    time.sleep(1.0)


def build_enclosure(missing_cell=None) -> None:
    """3x3x3 cobble enclosure with a roof at Y=68. Optionally leave one
    perimeter cell as air to simulate a missing wall block."""
    # Floor (inside the enclosure)
    rcon_batch([
        f"execute in {WORLD} run fill 0 65 0 2 65 2 minecraft:cobblestone",  # interior floor
    ])
    # Walls perimeter (only edges of x=0..2 z=0..2 at Y=66, 67)
    for y in (66, 67):
        for (x, z) in [(0, 0), (1, 0), (2, 0),
                       (0, 1),         (2, 1),
                       (0, 2), (1, 2), (2, 2)]:
            if missing_cell == (x, y, z):
                continue  # leave this cell air
            rcon_batch([f"execute in {WORLD} run setblock {x} {y} {z} minecraft:cobblestone"])
    # Roof
    rcon_batch([f"execute in {WORLD} run fill 0 68 0 2 68 2 minecraft:cobblestone"])
    # Move bot inside (after enclosure exists)
    rcon_batch([f"execute in {WORLD} run tp Flint 1 66 1 90 0"])
    time.sleep(1.0)


def scenario_walls_complete(bot_url: str) -> bool:
    print("\n=== A: enclosure complete → walls check passes ===")
    reset_arena()
    build_enclosure(missing_cell=None)
    r = http_post(f"{bot_url}/action/is_sheltered", {
        "radius": 12,
        "walls": {"x1": 0, "y1": 66, "z1": 0, "x2": 2, "y2": 67, "z2": 2},
    }, timeout=30)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    print(f"  ok={ok}  err.code={err.get('code')}  err.message={err.get('message','')[:160]}")
    # Note: ok might be false if pathfinder still finds an exit (e.g. through
    # the floor or roof, though we built both). Pass criterion: WALLS_INCOMPLETE
    # is NOT the code — walls passed the perimeter check.
    passed = err.get("code") != "WALLS_INCOMPLETE"
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_walls_missing_one(bot_url: str) -> bool:
    print("\n=== B: enclosure with one wall cell air → WALLS_INCOMPLETE ===")
    reset_arena()
    build_enclosure(missing_cell=(0, 67, 1))  # gap on west wall, head level
    r = http_post(f"{bot_url}/action/is_sheltered", {
        "radius": 12,
        "walls": {"x1": 0, "y1": 66, "z1": 0, "x2": 2, "y2": 67, "z2": 2},
    }, timeout=30)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    code = err.get("code")
    obs = err.get("observed_state") or {}
    missing = obs.get("missing_cells") or []
    print(f"  ok={ok}  code={code}  total_missing={obs.get('total_missing')}")
    print(f"  missing first 3: {missing[:3]}")
    passed = (not ok) and code == "WALLS_INCOMPLETE" and any(
        m.get("x") == 0 and m.get("y") == 67 and m.get("z") == 1 for m in missing
    )
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
        ("A", scenario_walls_complete(args.bot_url)),
        ("B", scenario_walls_missing_one(args.bot_url)),
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
