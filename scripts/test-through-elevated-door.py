#!/usr/bin/env python3
"""test-through-elevated-door.py — F56 verification.

Replicates the G22 scenario the prior F55.4 test missed: a walled
PLATFORM (cobble at y=65) with a door on the south wall (lower=y=66,
upper=y=67), bot outside at grass level (y=64 grass top = stand y=65).
The bot must step UP onto the platform AND walk through the door —
mineflayer's bare `setControlState('forward')` won't jump on its own,
so `mc through` needs to detect the stall and jump-nudge.

Scenarios:
  A — Door on south wall of a 4x4 platform, bot 2 blocks south on
      grass. mc through (door coord) → ok=true, bot ends inside the
      house (z < platform south edge).
  B — Sanity: door at the SAME level as the bot (no step-up needed).
      mc through → ok=true. Confirms we didn't break the simple case.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BOT_URL = "http://localhost:3004"
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
        # Big air clear, then grass floor at y=64 (replicates the G22 arena layout).
        f"execute in {WORLD} run fill -15 60 -15 15 80 15 minecraft:air",
        f"execute in {WORLD} run fill -15 64 -15 15 64 15 minecraft:grass_block",
        f"execute in {WORLD} run clear Tester",
    ])
    time.sleep(1.0)


def scenario_elevated_door(bot_url: str) -> bool:
    print("\n=== A: door on raised platform, bot on grass — must jump-step up + walk through ===")
    reset_arena()
    # 4x4 platform at y=65 (filling x=-2..1, z=9..12)
    rcon_batch([
        f"execute in {WORLD} run fill -2 65 9 1 65 12 minecraft:cobblestone",
        # Walls 3-high on the perimeter (south wall at z=12 leaving one slot for the door)
        f"execute in {WORLD} run fill -2 66 12 1 68 12 minecraft:cobblestone",
        # Carve out the door slot at (0, 66, 12) + (0, 67, 12)
        f"execute in {WORLD} run setblock 0 66 12 minecraft:air",
        f"execute in {WORLD} run setblock 0 67 12 minecraft:air",
        # Other 3 walls (so bot can't path around through them)
        f"execute in {WORLD} run fill -2 66 9 -2 68 12 minecraft:cobblestone",
        f"execute in {WORLD} run fill 1 66 9 1 68 12 minecraft:cobblestone",
        f"execute in {WORLD} run fill -2 66 9 1 68 9 minecraft:cobblestone",
        # Place the door at the slot
        f"execute in {WORLD} run setblock 0 66 12 minecraft:oak_door[half=lower,facing=south]",
        f"execute in {WORLD} run setblock 0 67 12 minecraft:oak_door[half=upper,facing=south]",
        # Bot 2 blocks south of the south wall, on grass (y=65 standing on y=64 grass)
        f"execute in {WORLD} run tp Tester 0 65 14 180 0",
    ])
    time.sleep(2.5)
    t0 = time.time()
    r = http_post(f"{bot_url}/action/through", {"gx": 0, "gy": 66, "gz": 12}, timeout=20)
    dt = time.time() - t0
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    data = r.get("data") or {}
    cur = (data.get("ended_at") or err.get("observed_state", {}).get("current") or {})
    state = (r.get("state") or {})
    bot_pos = state.get("position") or cur
    print(f"  dt={dt:.1f}s  ok={ok}  err.code={err.get('code')}  err.msg={err.get('message','')[:140]}")
    print(f"  bot_pos after: {bot_pos}")
    # PASS if either ok=true OR the bot crossed past the door (z < 12) even if
    # the through action didn't formally "reach" the dest.
    bot_z = (bot_pos or {}).get("z")
    crossed = bot_z is not None and bot_z < 12.0
    passed = ok or (err.get("observed_state", {}).get("crossed_gate") is True) or crossed
    print(f"  crossed_gate: {(err.get('observed_state') or {}).get('crossed_gate')}  bot.z < 12: {crossed}")
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_flat_door(bot_url: str) -> bool:
    print("\n=== B: flat door (no step-up), simple traversal still works ===")
    reset_arena()
    rcon_batch([
        # Solid floor at y=64 (already grass). Walls at y=65, y=66.
        f"execute in {WORLD} run setblock 0 65 5 minecraft:air",
        f"execute in {WORLD} run setblock 0 66 5 minecraft:air",
        f"execute in {WORLD} run setblock -1 65 5 minecraft:cobblestone",
        f"execute in {WORLD} run setblock -1 66 5 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 1 65 5 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 1 66 5 minecraft:cobblestone",
        # Door at the same level as the bot
        f"execute in {WORLD} run setblock 0 65 5 minecraft:oak_door[half=lower,facing=south]",
        f"execute in {WORLD} run setblock 0 66 5 minecraft:oak_door[half=upper,facing=south]",
        f"execute in {WORLD} run tp Tester 0 65 8 180 0",
    ])
    time.sleep(2.0)
    r = http_post(f"{bot_url}/action/through", {"gx": 0, "gy": 65, "gz": 5}, timeout=15)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    state = (r.get("state") or {})
    bot_pos = state.get("position") or {}
    print(f"  ok={ok}  err.code={err.get('code')}  bot_pos: {bot_pos}")
    bot_z = bot_pos.get("z")
    crossed = bot_z is not None and bot_z < 5.0
    passed = ok or crossed
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
        ("A", scenario_elevated_door(args.bot_url)),
        ("B", scenario_flat_door(args.bot_url)),
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
