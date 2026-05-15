#!/usr/bin/env python3
"""test-through-recovery.py — F54.5 verification.

Verifies that `mc through X Y Z` returns NOT_A_DOOR with an actionable
next-action hint when the target isn't actually a door, so the brain
knows to either place a door (if it has one in inventory) or pick a
different coord — instead of looping the same command.

Scenarios:
  A — Target is air AND bot has oak_door in inventory. Expect
      NOT_A_DOOR with next_action_hint suggesting 'mc place oak_door'
      and observed_state.inventory_door='oak_door'.
  B — Target is cobblestone (wall) — no door, no air. Expect
      NOT_A_DOOR with a hint about digging or picking a real door.
  C — Target is an actual oak_door. Expect ok=true (through traverses).
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
        f"execute in {WORLD} run fill -10 60 -10 20 80 20 minecraft:air",
        f"execute in {WORLD} run fill -10 64 -10 20 64 20 minecraft:stone",
    ])
    time.sleep(1.0)


def scenario_air_with_door(bot_url: str) -> bool:
    print("\n=== A: target is air + bot has oak_door → suggests mc place ===")
    rcon_batch([
        f"execute in {WORLD} run clear Flint",
        f"execute in {WORLD} run give Flint minecraft:oak_door 2",
        f"execute in {WORLD} run tp Flint 3 65 3 0 0",
    ])
    time.sleep(1.5)
    r = http_post(f"{bot_url}/action/through", {"gx": 4, "gy": 65, "gz": 3}, timeout=20)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    code = err.get("code")
    obs = err.get("observed_state") or {}
    hint = err.get("next_action_hint", "")
    print(f"  ok={ok}  code={code}  is_air={obs.get('is_air')}  inv_door={obs.get('inventory_door')}")
    print(f"  hint={hint!r}")
    passed = (
        (not ok)
        and code == "NOT_A_DOOR"
        and obs.get("is_air") is True
        and obs.get("inventory_door") == "oak_door"
        and "mc place" in hint.lower()
        and "oak_door" in hint
    )
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_wall_block(bot_url: str) -> bool:
    print("\n=== B: target is cobblestone wall → hint to dig or pick a real coord ===")
    rcon_batch([
        f"execute in {WORLD} run setblock 4 65 3 minecraft:cobblestone",
        f"execute in {WORLD} run clear Flint",
        f"execute in {WORLD} run tp Flint 3 65 3 0 0",
    ])
    time.sleep(1.5)
    r = http_post(f"{bot_url}/action/through", {"gx": 4, "gy": 65, "gz": 3}, timeout=20)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    code = err.get("code")
    obs = err.get("observed_state") or {}
    hint = err.get("next_action_hint", "")
    print(f"  ok={ok}  code={code}  block={obs.get('block_at_target')}  is_air={obs.get('is_air')}")
    print(f"  hint={hint!r}")
    passed = (
        (not ok)
        and code == "NOT_A_DOOR"
        and obs.get("block_at_target") == "cobblestone"
        and obs.get("is_air") is False
        and ("dig" in hint.lower() or "real door" in hint.lower())
    )
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_real_door(bot_url: str) -> bool:
    print("\n=== C: target is real oak_door → through succeeds ===")
    rcon_batch([
        f"execute in {WORLD} run fill 2 65 2 6 67 4 minecraft:air",
        f"execute in {WORLD} run setblock 4 65 3 minecraft:oak_door[half=lower,facing=south]",
        f"execute in {WORLD} run setblock 4 66 3 minecraft:oak_door[half=upper,facing=south]",
        f"execute in {WORLD} run clear Flint",
        f"execute in {WORLD} run tp Flint 4 65 1 180 0",
    ])
    time.sleep(2.0)
    r = http_post(f"{bot_url}/action/through", {"gx": 4, "gy": 65, "gz": 3}, timeout=30)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    print(f"  ok={ok}  err.code={err.get('code')}  err.message={err.get('message')}")
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
        ("A", scenario_air_with_door(args.bot_url)),
        ("B", scenario_wall_block(args.bot_url)),
        ("C", scenario_real_door(args.bot_url)),
    ]

    print("\n=== Summary ===")
    for name, ok in results:
        print(f"  {name}: {'PASS' if ok else 'FAIL'}")

    rcon_batch([
        f"execute in {WORLD} run fill -10 60 -10 20 80 20 minecraft:air",
        f"execute in {WORLD} run clear Flint",
        f"execute in {WORLD} run tp Flint 52 65 52",
    ])
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(main())
