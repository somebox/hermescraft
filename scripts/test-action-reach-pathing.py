#!/usr/bin/env python3
"""test-action-reach-pathing.py — F55.3 verification.

Verifies that coord-targeting actions (deposit/withdraw/list_container/
interact) auto-pathfind to within reach before acting, with a wallclock
cap (8s), and return a structured OUT_OF_RANGE if pathfind fails.

(Note: `mc chest_search` is a memory query, NOT a coord-targeting
action — it doesn't visit the chest, so it doesn't need reach precheck.)

Scenarios:
  A — Bot 10m from a chest; mc list_container → ok=true (auto-pathfind).
  B — Bot already adjacent to chest; mc list_container → ok=true, fast.
  C — Bot 25m from chest with intervening wall; mc deposit → OUT_OF_RANGE.
  D — Bot 10m from a lever; mc interact → ok=true after pathfind.
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
        f"execute in {WORLD} run fill -30 60 -30 30 80 30 minecraft:air",
        f"execute in {WORLD} run fill -30 64 -30 30 64 30 minecraft:stone",
    ])
    time.sleep(1.0)


def scenario_chest_reach_ok(bot_url: str) -> bool:
    print("\n=== A: bot 10m from chest, mc list_container → auto-pathfind, ok=true ===")
    reset_arena()
    rcon_batch([
        f"execute in {WORLD} run setblock 10 65 0 minecraft:chest",
        f"execute in {WORLD} run tp Flint 0 65 0 90 0",
    ])
    time.sleep(1.5)
    r = http_post(f"{bot_url}/action/list_container", {"x": 10, "y": 65, "z": 0}, timeout=20)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    print(f"  ok={ok}  err.code={err.get('code')}  err.message={err.get('message','')[:120]}")
    passed = ok
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_chest_adjacent(bot_url: str) -> bool:
    print("\n=== B: bot adjacent to chest, mc list_container → ok, no movement ===")
    reset_arena()
    rcon_batch([
        f"execute in {WORLD} run setblock 0 65 0 minecraft:chest",
        f"execute in {WORLD} run tp Flint 1 65 0 90 0",
    ])
    time.sleep(1.5)
    t0 = time.time()
    r = http_post(f"{bot_url}/action/list_container", {"x": 0, "y": 65, "z": 0}, timeout=15)
    dt = time.time() - t0
    ok = bool(r.get("ok"))
    print(f"  dt={dt:.1f}s  ok={ok}")
    passed = ok and dt < 3.0
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_chest_unreachable(bot_url: str) -> bool:
    print("\n=== C: bot trapped in 1x2 bedrock cell, mc deposit far chest → OUT_OF_RANGE ===")
    reset_arena()
    rcon_batch([
        # Put a chest far away (definitely > 4.5m even from cell)
        f"execute in {WORLD} run setblock 25 65 0 minecraft:chest",
        # TP bot to known spot first
        f"execute in {WORLD} run tp Flint 0 65 0 90 0",
        f"execute in {WORLD} run clear Flint",
        f"execute in {WORLD} run give Flint minecraft:cobblestone 8",
        # Trap bot inside a bedrock cage so pathfinder can't reach the chest
        f"execute in {WORLD} run setblock 1 65 0 minecraft:bedrock",
        f"execute in {WORLD} run setblock 1 66 0 minecraft:bedrock",
        f"execute in {WORLD} run setblock -1 65 0 minecraft:bedrock",
        f"execute in {WORLD} run setblock -1 66 0 minecraft:bedrock",
        f"execute in {WORLD} run setblock 0 65 1 minecraft:bedrock",
        f"execute in {WORLD} run setblock 0 66 1 minecraft:bedrock",
        f"execute in {WORLD} run setblock 0 65 -1 minecraft:bedrock",
        f"execute in {WORLD} run setblock 0 66 -1 minecraft:bedrock",
        f"execute in {WORLD} run setblock 0 67 0 minecraft:bedrock",  # ceiling
    ])
    time.sleep(1.5)
    t0 = time.time()
    r = http_post(f"{bot_url}/action/deposit", {"x": 25, "y": 65, "z": 0, "item": "cobblestone", "count": 4}, timeout=20)
    dt = time.time() - t0
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    code = err.get("code")
    obs = err.get("observed_state") or {}
    print(f"  dt={dt:.1f}s  ok={ok}  code={code}  distance_after={obs.get('distance_after')}  timed_out={obs.get('timed_out')}")
    passed = (not ok) and code == "OUT_OF_RANGE" and dt < 12.0
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_interact_reach(bot_url: str) -> bool:
    print("\n=== D: bot 10m from a lever, mc interact → auto-pathfind, ok=true ===")
    reset_arena()
    rcon_batch([
        f"execute in {WORLD} run setblock 10 65 0 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 10 66 0 minecraft:lever[face=floor,facing=north]",
        f"execute in {WORLD} run tp Flint 0 65 0 90 0",
    ])
    time.sleep(1.5)
    r = http_post(f"{bot_url}/action/interact", {"x": 10, "y": 66, "z": 0}, timeout=20)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    print(f"  ok={ok}  err.code={err.get('code')}  err.message={err.get('message','')[:100]}")
    passed = ok
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

    reset_arena()
    results = [
        ("A", scenario_chest_reach_ok(args.bot_url)),
        ("B", scenario_chest_adjacent(args.bot_url)),
        ("C", scenario_chest_unreachable(args.bot_url)),
        ("D", scenario_interact_reach(args.bot_url)),
    ]

    print("\n=== Summary ===")
    for name, ok in results:
        print(f"  {name}: {'PASS' if ok else 'FAIL'}")
    rcon_batch([
        f"execute in {WORLD} run fill -30 60 -30 30 80 30 minecraft:air",
        f"execute in {WORLD} run tp Flint 52 65 52",
    ])
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(main())
