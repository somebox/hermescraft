#!/usr/bin/env python3
"""test-goto-near-landing.py — F50.5 verification.

goto_near lands the bot at SOME cell within `range` of the target,
often a fractional position next to a wall (Mason in G21 v2 routinely
ended up in wedge/corner). F50.5 has goto_near scan for a cleaner
candidate cell within range and report it via
observed_state.suggested_correction so the brain can mc move there.

Scenarios:
  A — Target near a corner of a 3-wall pocket. Bot pathfinds → lands
      in three_walled (only one open dir). Expect data.landed_in to be
      a sticky classification and (when there's a cleaner spot inside
      range) suggested_correction to be a real cell.
  B — Target in a totally open arena. Bot lands in 'open' → no landing
      info attached (action result is the clean success path).
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


def scenario_three_walled_landing(bot_url: str) -> bool:
    print("\n=== A: goto_near lands bot in three_walled pocket → suggested_correction surfaced ===")
    reset_arena()
    # Place a 3-wall pocket around target (5,65,0). Bot starts 8 away.
    # Walls at (5,65,-1) N, (6,65,0) E, (5,65,1) S; open W at (4,65,0).
    rcon_batch([
        f"execute in {WORLD} run setblock 5 65 -1 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 5 66 -1 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 6 65 0 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 6 66 0 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 5 65 1 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 5 66 1 minecraft:cobblestone",
        f"execute in {WORLD} run tp Tester 0 65 0 0 0",
    ])
    time.sleep(2.0)
    # range=0 forces the bot to stand on the target cell itself, INSIDE the
    # pocket. With walls N/E/S that cell is three_walled and F50.5 should
    # surface that landing-info plus a suggested cleaner cell within range.
    r = http_post(f"{bot_url}/action/goto_near", {"x": 5, "y": 65, "z": 0, "range": 0}, timeout=20)
    ok = bool(r.get("ok"))
    # Action handler spreads {result, observed_state} into the HTTP top level,
    # so observed_state lives at r["observed_state"] (not under r["data"]).
    obs_state = r.get("observed_state") or {}
    landed_in = obs_state.get("landed_in")
    suggested = obs_state.get("suggested_correction")
    landing_pos = obs_state.get("landing_position")
    print(f"  ok={ok}  result={r.get('result','')[:100]}")
    print(f"  landed_in={landed_in}  landing_pos={landing_pos}")
    print(f"  suggested_correction={suggested}")
    # F50.5 fires when classification is corner/wedge/edge/three_walled.
    # We accept any of those as proof the landing inspector ran.
    sticky = {"corner", "wedge", "edge", "three_walled"}
    passed = ok and (landed_in in sticky)
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_open_landing_no_warning(bot_url: str) -> bool:
    print("\n=== B: goto_near lands bot in open ground → no landing_info attached ===")
    reset_arena()
    rcon_batch([
        f"execute in {WORLD} run tp Tester 0 65 0 0 0",
    ])
    time.sleep(2.0)
    # No walls anywhere. Bot should land cleanly.
    r = http_post(f"{bot_url}/action/goto_near", {"x": 5, "y": 65, "z": 0, "range": 2}, timeout=20)
    ok = bool(r.get("ok"))
    obs_state = r.get("observed_state") or {}
    landed_in = obs_state.get("landed_in")
    print(f"  ok={ok}  observed_state={obs_state}")
    # A clean landing yields NO landed_in field at all.
    passed = ok and (landed_in is None)
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
        ("A", scenario_three_walled_landing(args.bot_url)),
        ("B", scenario_open_landing_no_warning(args.bot_url)),
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
