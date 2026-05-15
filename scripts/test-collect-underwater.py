#!/usr/bin/env python3
"""test-collect-underwater.py — F54.4 verification.

Verifies that:
  - `mc collect <block>` refuses with TARGET_IN_WATER when every candidate
    is in/under water, rather than walking the bot into a pond to drown.
  - `mc dig X Y Z` refuses with SUBMERGED when the bot is in water, with
    --force overriding.

Scenarios:
  A — Sand only in a pond (3×3 sand at y=63 with water at y=64). Bot
      teleported onto a dry beach 8 blocks away. mc collect sand 4 →
      TARGET_IN_WATER with candidates_dry=0, candidates_flooded≥1.
  B — Sand on a dry beach AND in a pond. mc collect sand 1 → ok=true
      (mines the dry one).
  C — Bot teleported into a water column. mc dig <a stone next to bot> →
      SUBMERGED with bot_in_water=true.
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
        f"execute in {WORLD} run fill -10 60 -10 20 63 20 minecraft:stone",
        f"execute in {WORLD} run fill -10 64 -10 20 64 20 minecraft:grass_block",
    ])
    time.sleep(1.0)


def scenario_only_water(bot_url: str) -> bool:
    print("\n=== A: sand only in a pond → TARGET_IN_WATER ===")
    rcon_batch([
        # Carve a pond at z=5..7 and fill it with water + bury sand at the bottom
        f"execute in {WORLD} run fill 4 63 5 6 64 7 minecraft:air",
        f"execute in {WORLD} run fill 4 63 5 6 63 7 minecraft:sand",
        f"execute in {WORLD} run setblock 4 64 5 minecraft:water",
        f"execute in {WORLD} run setblock 4 64 6 minecraft:water",
        f"execute in {WORLD} run setblock 4 64 7 minecraft:water",
        f"execute in {WORLD} run setblock 5 64 5 minecraft:water",
        f"execute in {WORLD} run setblock 5 64 6 minecraft:water",
        f"execute in {WORLD} run setblock 5 64 7 minecraft:water",
        f"execute in {WORLD} run setblock 6 64 5 minecraft:water",
        f"execute in {WORLD} run setblock 6 64 6 minecraft:water",
        f"execute in {WORLD} run setblock 6 64 7 minecraft:water",
        # Position bot on dry grass, looking toward the pond
        f"execute in {WORLD} run tp Flint 5 65 1 0 0",
    ])
    time.sleep(2.0)
    r = http_post(f"{bot_url}/action/collect", {"block": "sand", "count": 4}, timeout=60)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    code = err.get("code")
    obs = err.get("observed_state") or {}
    print(f"  ok={ok}  code={code}  dry={obs.get('candidates_dry')}  flooded={obs.get('candidates_flooded')}")
    passed = (not ok) and code == "TARGET_IN_WATER" and obs.get("candidates_dry") == 0 and (obs.get("candidates_flooded") or 0) >= 1
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_mixed_dry_and_water(bot_url: str) -> bool:
    print("\n=== B: sand on dry beach AND in pond → mines the dry one ===")
    reset_arena()
    rcon_batch([
        # Dry sand on the beach at (5, 64, 1)
        f"execute in {WORLD} run setblock 5 64 1 minecraft:sand",
        f"execute in {WORLD} run setblock 5 64 2 minecraft:sand",
        # Pond sand
        f"execute in {WORLD} run fill 4 63 5 6 63 7 minecraft:sand",
        f"execute in {WORLD} run setblock 5 64 5 minecraft:water",
        # Bot on grass next to dry sand
        f"execute in {WORLD} run tp Flint 5 65 0 0 0",
        f"execute in {WORLD} run clear Flint",
        f"execute in {WORLD} run give Flint minecraft:wooden_pickaxe 1",
    ])
    time.sleep(2.0)
    r = http_post(f"{bot_url}/action/collect", {"block": "sand", "count": 1}, timeout=60)
    ok = bool(r.get("ok"))
    print(f"  ok={ok}  result={(r.get('data') or {}).get('mined_count') or r.get('result')}  err={r.get('error')}")
    passed = ok
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_submerged_dig(bot_url: str) -> bool:
    print("\n=== C: bot inside water column, mc dig adjacent stone → SUBMERGED ===")
    reset_arena()
    rcon_batch([
        # Build a 1x1x2 water column at (5, 64-65, 0)
        f"execute in {WORLD} run setblock 5 64 0 minecraft:water",
        f"execute in {WORLD} run setblock 5 65 0 minecraft:water",
        # Stone block right next to the bot at (4, 64, 0)
        f"execute in {WORLD} run setblock 4 64 0 minecraft:stone",
        # TP bot directly into the water column
        f"execute in {WORLD} run tp Flint 5.5 64 0.5 0 0",
    ])
    time.sleep(2.5)
    r = http_post(f"{bot_url}/action/dig", {"x": 4, "y": 64, "z": 0}, timeout=15)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    code = err.get("code")
    obs = err.get("observed_state") or {}
    print(f"  ok={ok}  code={code}  bot_in_water={obs.get('bot_in_water')}")
    passed = (not ok) and code == "SUBMERGED" and obs.get("bot_in_water") is True
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
        ("A", scenario_only_water(args.bot_url)),
        ("B", scenario_mixed_dry_and_water(args.bot_url)),
        ("C", scenario_submerged_dig(args.bot_url)),
    ]

    print("\n=== Summary ===")
    for name, ok in results:
        print(f"  {name}: {'PASS' if ok else 'FAIL'}")

    rcon_batch([
        f"execute in {WORLD} run fill -10 60 -10 20 80 20 minecraft:air",
        f"execute in {WORLD} run tp Flint 52 65 52",
    ])
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(main())
