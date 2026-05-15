#!/usr/bin/env python3
"""test-fill-self-displace.py — F60 verification.

F55.2 (the predecessor) detects post-hoc that the bot was standing
inside a fill region. F60 PREVENTS the problem: place_fill moves the
bot to a safe cell outside the region BEFORE iterating, so all cells
place cleanly the first time.

Scenarios:
  A — Bot is teleported INSIDE a 3×1×3 fill region at Y=66 (foot cell
      at center, region includes that cell). Expected: place_fill
      auto-displaces the bot out, places ALL 9 cells, and the result
      has no `bot_was_inside_region` flag and no `partial`.
  B — Bot is OUTSIDE the region from the start, on the same plane as
      the fill. Per-cell pathfind may drag the bot into the region as
      it walks to reach each cell — F60 must still produce a clean fill.
  C — Bot is teleported INTO a larger 5×1×3 fill region at Y=65 (foot
      cell in the middle of the wall run, the kind of fill the M2 maze
      uses). Same auto-displace path as A, exercised with the wider
      region geometry. Verifies the bot's final standing cell is air
      (not stuck inside placed cobble).
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


def rcon(cmd: str) -> str:
    r = subprocess.run(
        ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"],
        input=cmd + "\n",
        capture_output=True,
        text=True,
        timeout=20,
    )
    return r.stdout.strip()


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
        f"execute in {WORLD} run give Flint minecraft:cobblestone 64",
    ])
    time.sleep(1.5)


def scenario_inside(bot_url: str) -> bool:
    print("\n=== A: bot inside region — must auto-displace before fill ===")
    reset_arena()
    # Floor at y=65 under region so bot stands on it. Region: 0..2 / 65..66 / 0..2.
    rcon_batch([
        f"execute in {WORLD} run fill 0 65 0 2 65 2 minecraft:stone",
        f"execute in {WORLD} run tp Flint 1 66 1 90 0",  # center of region top
    ])
    time.sleep(2.0)
    r = http_post(f"{bot_url}/action/place_fill", {
        "block": "cobblestone",
        "x1": 0, "y1": 66, "z1": 0,
        "x2": 2, "y2": 66, "z2": 2,
    }, timeout=30)
    ok = bool(r.get("ok"))
    data = r.get("data") or {}
    placed = data.get("placed", 0)
    total = data.get("total", 0)
    partial = data.get("partial")
    bot_inside = data.get("bot_was_inside_region")
    displaced = data.get("auto_displaced")
    print(f"  ok={ok} placed={placed}/{total} partial={partial} bot_was_inside={bot_inside} auto_displaced={displaced}")
    print(f"  result={r.get('result','')[:200]}")
    passed = ok and placed == total and partial in (False, None) and not bot_inside and displaced
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_outside(bot_url: str) -> bool:
    print("\n=== B: bot far outside region — per-cell pathfind may drag bot in, but displace recovers ===")
    reset_arena()
    # Floor stone at y=64. Bot stands at (5, 65, 5). Fill region directly on
    # top of the floor at y=65, x=0..2, z=0..2. Bot starts outside, but
    # `mc fill`'s per-cell `GoalNear(pos, 3)` pathfind can land the bot
    # inside the 3×3 region. F60's lazy mid-loop displace must recover.
    rcon_batch([
        f"execute in {WORLD} run tp Flint 5 65 5 90 0",
    ])
    time.sleep(2.0)
    r = http_post(f"{bot_url}/action/place_fill", {
        "block": "cobblestone",
        "x1": 0, "y1": 65, "z1": 0,
        "x2": 2, "y2": 65, "z2": 2,
    }, timeout=30)
    ok = bool(r.get("ok"))
    data = r.get("data") or {}
    placed = data.get("placed", 0)
    total = data.get("total", 0)
    bot_inside = data.get("bot_was_inside_region")
    print(f"  ok={ok} placed={placed}/{total} bot_was_inside={bot_inside}")
    # Pass condition: full fill AND no self-blocking. Whether displacement
    # fires or not is an implementation detail — what matters is the outcome.
    passed = ok and placed == total and not bot_inside
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_on_wall(bot_url: str) -> bool:
    print("\n=== C: bot inside large 5×3 region — must displace and complete ===")
    reset_arena()
    # Larger region (5×1×3 = 15 cells) with bot inside — the kind of fill
    # the M2 maze uses (long wall runs). Floor at y=64 provides reference;
    # bot tp'd to (2, 65, 1) lands on top of the floor (feet at y=65), and
    # its foot cell (2, 65, 1) is in the middle of the fill region. F60
    # must auto-displace the bot before placing the cell it stands in.
    rcon_batch([
        f"execute in {WORLD} run tp Flint 2 65 1 90 0",  # middle of region
    ])
    time.sleep(2.0)
    r = http_post(f"{bot_url}/action/place_fill", {
        "block": "cobblestone",
        "x1": 0, "y1": 65, "z1": 0,
        "x2": 4, "y2": 65, "z2": 2,
    }, timeout=30)
    ok = bool(r.get("ok"))
    data = r.get("data") or {}
    placed = data.get("placed", 0)
    total = data.get("total", 0)
    bot_inside = data.get("bot_was_inside_region")
    displaced = data.get("auto_displaced")
    # Verify the bot ended up in a SAFE position — feet in air, not stuck
    # inside a freshly-placed cobble block. A regression where the bot is
    # left clipped into a wall would have slipped through if we only
    # checked the placement count and bot_was_inside flag.
    pos = (http_get(f"{bot_url}/status?lean=true").get("data") or {}).get("position") or {}
    px, py, pz = int(pos.get("x", 0)), int(pos.get("y", 0)), int(pos.get("z", 0))
    foot_check = rcon(f"execute in {WORLD} if block {px} {py} {pz} minecraft:air")
    foot_is_air = "Test passed" in foot_check
    print(f"  ok={ok} placed={placed}/{total} bot_was_inside={bot_inside} auto_displaced={displaced}")
    print(f"  final bot pos=({px},{py},{pz})  foot_cell=air? {foot_is_air}")
    passed = ok and placed == total and not bot_inside and foot_is_air
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--bot-url", default=DEFAULT_BOT_URL)
    p.add_argument("--scenario", choices=["A", "B", "C", "all"], default="all")
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
        scenarios.append(("A", scenario_inside))
    if args.scenario in ("B", "all"):
        scenarios.append(("B", scenario_outside))
    if args.scenario in ("C", "all"):
        scenarios.append(("C", scenario_on_wall))

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
