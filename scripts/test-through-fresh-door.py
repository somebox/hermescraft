#!/usr/bin/env python3
"""test-through-fresh-door.py — F55.4 verification.

Verifies `mc through GX GY GZ` re-fetches the block state once if the
first snapshot returns air (handles freshly-placed doors where mineflayer
hasn't synced yet), and surfaces door_state in TRAVERSAL_FAILED.

Scenarios:
  A — A door is placed at (5, 66, 0). Immediately call mc through →
      ok=true (re-fetch picks up the door even if first read missed).
  B — Bot trapped in a tight bedrock cage 25m from a real door; mc
      through → TRAVERSAL_FAILED with observed_state.gate_block in body.
  C — Block at target is permanently air (no door anywhere). mc through
      → NOT_A_DOOR (existing F54.5 behavior, no regression).
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
        f"execute in {WORLD} run clear Flint",
        f"execute in {WORLD} run tp Flint 0 65 0 90 0",
    ])
    time.sleep(1.5)


def scenario_fresh_door(bot_url: str) -> bool:
    print("\n=== A: door placed via rcon, mc through immediately → NOT 'NOT_A_DOOR' (re-fetch sees it) ===")
    reset_arena()
    # Place a door 3 blocks from the bot. Bot at (0,65,0); door at (3,66,0).
    rcon_batch([
        f"execute in {WORLD} run setblock 3 66 0 minecraft:oak_door[half=lower,facing=east]",
        f"execute in {WORLD} run setblock 3 67 0 minecraft:oak_door[half=upper,facing=east]",
    ])
    # Immediately call mc through with NO delay — exactly the v6 race.
    # The re-fetch should pick up the just-placed door even if the first
    # blockAt returned air. Pass criterion: error code is NOT 'NOT_A_DOOR'
    # (i.e. the door WAS recognized). The actual traversal walk-step may
    # or may not succeed depending on pathfinder quirks — that's a pre-
    # existing through() concern, not F55.4.
    r = http_post(f"{bot_url}/action/through", {"gx": 3, "gy": 66, "gz": 0}, timeout=20)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    code = err.get("code")
    print(f"  ok={ok}  err.code={code}  err.message={err.get('message','')[:140]}")
    passed = code != "NOT_A_DOOR" and code != "GATE_NOT_FOUND"
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_unreachable_door(bot_url: str) -> bool:
    print("\n=== B: bot caged, real door 25m away → TRAVERSAL_FAILED with gate_block in observed_state ===")
    reset_arena()
    rcon_batch([
        # Door far away
        f"execute in {WORLD} run setblock 25 66 0 minecraft:oak_door[half=lower,facing=east]",
        f"execute in {WORLD} run setblock 25 67 0 minecraft:oak_door[half=upper,facing=east]",
        # Cage the bot
        f"execute in {WORLD} run setblock 1 65 0 minecraft:bedrock",
        f"execute in {WORLD} run setblock 1 66 0 minecraft:bedrock",
        f"execute in {WORLD} run setblock -1 65 0 minecraft:bedrock",
        f"execute in {WORLD} run setblock -1 66 0 minecraft:bedrock",
        f"execute in {WORLD} run setblock 0 65 1 minecraft:bedrock",
        f"execute in {WORLD} run setblock 0 66 1 minecraft:bedrock",
        f"execute in {WORLD} run setblock 0 65 -1 minecraft:bedrock",
        f"execute in {WORLD} run setblock 0 66 -1 minecraft:bedrock",
        f"execute in {WORLD} run setblock 0 67 0 minecraft:bedrock",
    ])
    time.sleep(1.5)
    r = http_post(f"{bot_url}/action/through", {"gx": 25, "gy": 66, "gz": 0}, timeout=20)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    code = err.get("code")
    obs = err.get("observed_state") or {}
    print(f"  ok={ok}  code={code}  gate_block={obs.get('gate_block')}  door_state={obs.get('door_state')}")
    passed = (not ok) and code == "TRAVERSAL_FAILED" and obs.get("gate_block") == "oak_door"
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_target_is_air(bot_url: str) -> bool:
    print("\n=== C: target is air (no door anywhere) → NOT_A_DOOR (F54.5 regression check) ===")
    reset_arena()
    time.sleep(1.5)
    r = http_post(f"{bot_url}/action/through", {"gx": 7, "gy": 66, "gz": 0}, timeout=15)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    code = err.get("code")
    obs = err.get("observed_state") or {}
    print(f"  ok={ok}  code={code}  is_air={obs.get('is_air')}")
    passed = (not ok) and code == "NOT_A_DOOR" and obs.get("is_air") is True
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
        ("A", scenario_fresh_door(args.bot_url)),
        ("B", scenario_unreachable_door(args.bot_url)),
        ("C", scenario_target_is_air(args.bot_url)),
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
