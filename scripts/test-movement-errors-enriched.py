#!/usr/bin/env python3
"""test-movement-errors-enriched.py — F50.6 verification.

Verifies that every movement error path now carries
`observed_state.your_standing_state` so the brain sees its own
corner/wedge/trapped classification on every failure without an
extra mc observe call.

Scenarios:
  A — Bot in a corner (N,W walled), mc goto into solid block →
      NAV_TARGET_OCCUPIED + your_standing_state.classification=corner
  B — Bot inside an enclosure with one open dir, mc move to a
      destination behind a closed wall (no door) → NAV_BLOCKED with
      your_standing_state and nearby_doors=[].
  C — Bot trapped (4 walls + head), mc goto to anywhere → BOT_TRAPPED
      (pre-flight) + your_standing_state.classification=trapped.
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
DEFAULT_BOT_URL = default_bot_url("tester")
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
        f"execute in {WORLD} run fill -15 60 -15 15 80 15 minecraft:air",
        f"execute in {WORLD} run fill -15 64 -15 15 64 15 minecraft:stone",
        f"execute in {WORLD} run clear Tester",
    ])
    time.sleep(1.0)


def scenario_target_occupied_in_alley(bot_url: str) -> bool:
    # F51.1 silently pre-nudges out of corner/wedge/edge/three_walled,
    # so we use ALLEY (N+S walls, E+W open) which is NOT sticky.
    print("\n=== A: bot in alley, mc goto into solid → NAV_TARGET_OCCUPIED + enriched your_standing_state ===")
    reset_arena()
    rcon_batch([
        # Walls at N (z=-1) and S (z=1). E and W open. Bot at (0,65,0).
        f"execute in {WORLD} run setblock 0 65 -1 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 0 66 -1 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 0 65 1 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 0 66 1 minecraft:cobblestone",
        # Solid target somewhere remote we'll point goto at.
        f"execute in {WORLD} run setblock 5 65 5 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 5 66 5 minecraft:cobblestone",
        f"execute in {WORLD} run tp Tester 0 65 0 0 0",
    ])
    time.sleep(2.0)
    r = http_post(f"{bot_url}/action/goto", {"x": 5, "y": 65, "z": 5}, timeout=15)
    err = (r.get("error") or {})
    obs = err.get("observed_state") or {}
    ss = obs.get("your_standing_state") or {}
    code = err.get("code")
    cls = ss.get("classification")
    blocked = ss.get("blocked_dirs") or []
    print(f"  ok={r.get('ok')}  code={code}  classification={cls}  blocked={blocked}")
    # The F50.6 contract: error carries your_standing_state with a non-empty
    # classification and the blocked-dir signal is consistent with the arena.
    passed = (code == "NAV_TARGET_OCCUPIED") and (cls == "alley") and (set(blocked) == {"N", "S"})
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_move_no_door(bot_url: str) -> bool:
    print("\n=== B: bot enclosed (no door), mc move out → NAV_BLOCKED + your_standing_state ===")
    reset_arena()
    rcon_batch([
        # Build a 3x3 walled box at y=65/66, bot in middle.
        f"execute in {WORLD} run fill -2 65 -2 2 66 -2 minecraft:cobblestone",
        f"execute in {WORLD} run fill -2 65 2 2 66 2 minecraft:cobblestone",
        f"execute in {WORLD} run fill -2 65 -2 -2 66 2 minecraft:cobblestone",
        f"execute in {WORLD} run fill 2 65 -2 2 66 2 minecraft:cobblestone",
        f"execute in {WORLD} run tp Tester 0 65 0 0 0",
    ])
    time.sleep(2.0)
    r = http_post(f"{bot_url}/action/move", {"x": 5, "y": 65, "z": 5}, timeout=20)
    err = (r.get("error") or {})
    obs = err.get("observed_state") or {}
    ss = obs.get("your_standing_state") or {}
    code = err.get("code")
    print(f"  ok={r.get('ok')}  code={code}  classification={ss.get('classification')}  nearby_doors={obs.get('nearby_doors')}")
    # We accept either NAV_BLOCKED (from move's no-door branch) OR
    # BOT_TRAPPED from preflight if classification went to trapped.
    passed = (code in ("NAV_BLOCKED", "BOT_TRAPPED")) and bool(ss.get("classification"))
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_bot_trapped(bot_url: str) -> bool:
    print("\n=== C: bot trapped on all 4 sides, mc goto → BOT_TRAPPED + your_standing_state.trapped ===")
    reset_arena()
    rcon_batch([
        # 4 cardinal walls at foot level around bot at (0,65,0).
        f"execute in {WORLD} run setblock 0 65 -1 minecraft:bedrock",
        f"execute in {WORLD} run setblock 1 65 0 minecraft:bedrock",
        f"execute in {WORLD} run setblock 0 65 1 minecraft:bedrock",
        f"execute in {WORLD} run setblock -1 65 0 minecraft:bedrock",
        f"execute in {WORLD} run setblock 0 66 -1 minecraft:bedrock",
        f"execute in {WORLD} run setblock 1 66 0 minecraft:bedrock",
        f"execute in {WORLD} run setblock 0 66 1 minecraft:bedrock",
        f"execute in {WORLD} run setblock -1 66 0 minecraft:bedrock",
        f"execute in {WORLD} run tp Tester 0 65 0 0 0",
    ])
    time.sleep(2.0)
    r = http_post(f"{bot_url}/action/goto", {"x": 5, "y": 65, "z": 5}, timeout=15)
    err = (r.get("error") or {})
    obs = err.get("observed_state") or {}
    ss = obs.get("your_standing_state") or {}
    code = err.get("code")
    cls = ss.get("classification")
    print(f"  ok={r.get('ok')}  code={code}  classification={cls}  blocked={ss.get('blocked_dirs')}")
    passed = (code == "BOT_TRAPPED") and (cls == "trapped")
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
        ("A", scenario_target_occupied_in_alley(args.bot_url)),
        ("B", scenario_move_no_door(args.bot_url)),
        ("C", scenario_bot_trapped(args.bot_url)),
    ]

    print("\n=== Summary ===")
    for name, ok in results:
        print(f"  {name}: {'PASS' if ok else 'FAIL'}")
    rcon_batch([
        f"execute in {WORLD} run fill -15 60 -15 15 80 15 minecraft:air",
        f"execute in {WORLD} run tp Tester 52 65 52",
    ])
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(main())
