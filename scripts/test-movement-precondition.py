#!/usr/bin/env python3
"""test-movement-precondition.py — F51.2 verification.

After a failed mc goto/move/goto_near, the bot is NOT where it
intended to be. Running a position-dependent verb (interact, place,
deposit, …) targeting the same area would silently misbehave because
the bot is in a different cell than the brain thinks. F51.2 marks
`ctx.lastMoveFailed`, and the dispatcher intercepts the NEXT
position-dependent verb whose target is within 5 blocks of the failed
move's intended target, returning MOVEMENT_PRECONDITION_FAILED.

The flag clears on: `mc status` (explicit acknowledgement), a
successful move, or a 30s age-out.

Scenarios:
  A — Failed goto into a solid block, then interact at the same coord
      → MOVEMENT_PRECONDITION_FAILED with last_failed_move populated.
  B — After A, run mc status → flag clears. Same interact still fails
      on its own merit (no longer with PRECONDITION_FAILED).
  C — Failed goto, then a verb targeting a coord >5 blocks away → not
      intercepted (the guard is target-proximal).
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


def trigger_failed_move(bot_url: str) -> tuple[bool, dict]:
    """Run a goto guaranteed to fail INSIDE the pathfinder (so
    lastMoveFailed is recorded). NAV_TARGET_OCCUPIED is a pre-check
    that doesn't attempt motion and so won't trigger the F51.2 guard."""
    # Target is air at (5,65,5) — sealed by 3-tall walls on all 4 sides.
    # Pathfinder returns "no path" → recordMoveFailure('pathfinder_error').
    r = http_post(f"{bot_url}/action/goto", {"x": 5, "y": 65, "z": 5}, timeout=15)
    return (r.get("ok") is False), (r.get("error") or {})


def seal_target_5_65_5() -> None:
    """Build a 3-tall stone box around (5,65,5) so pathfinder can't reach it."""
    walls = []
    for y in (65, 66, 67):
        # 4 sides: N (z-=1), S (z+=1), W (x-=1), E (x+=1)
        for (x, z) in [(5, 4), (5, 6), (4, 5), (6, 5)]:
            walls.append(f"execute in {WORLD} run setblock {x} {y} {z} minecraft:cobblestone")
    # Cap the top so pathfinder cannot try to jump in.
    walls.append(f"execute in {WORLD} run setblock 5 68 5 minecraft:cobblestone")
    rcon_batch(walls)


def scenario_precondition_blocks_interact(bot_url: str) -> bool:
    print("\n=== A: failed goto → MOVEMENT_PRECONDITION_FAILED on subsequent interact at same coord ===")
    reset_arena()
    seal_target_5_65_5()
    rcon_batch([
        # Door OUTSIDE the sealed box, at (8,65,5) — 3 blocks east of the
        # east wall, within 5 of the failed goto target.
        f"execute in {WORLD} run setblock 8 65 5 minecraft:oak_door[half=lower,facing=south]",
        f"execute in {WORLD} run setblock 8 66 5 minecraft:oak_door[half=upper,facing=south]",
        f"execute in {WORLD} run tp Tester 0 65 0 0 0",
    ])
    time.sleep(2.0)
    failed, err = trigger_failed_move(bot_url)
    print(f"  goto failed as expected: ok=False  code={err.get('code')}")
    if not failed:
        print(f"  → FAIL (goto unexpectedly succeeded)")
        return False
    # Now try interact at (8,65,5) — within 5 of (5,65,5).
    r = http_post(f"{bot_url}/action/interact", {"x": 8, "y": 65, "z": 5}, timeout=10)
    code = (r.get("error") or {}).get("code")
    obs = (r.get("error") or {}).get("observed_state") or {}
    print(f"  interact ok={r.get('ok')}  code={code}  attempted={obs.get('attempted_verb')}  last={obs.get('last_failed_move',{}).get('verb')}")
    passed = (r.get("ok") is False) and (code == "MOVEMENT_PRECONDITION_FAILED")
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_status_clears_flag(bot_url: str) -> bool:
    print("\n=== B: mc status after failed move clears the precondition flag ===")
    reset_arena()
    seal_target_5_65_5()
    rcon_batch([
        f"execute in {WORLD} run setblock 8 65 5 minecraft:oak_door[half=lower,facing=south]",
        f"execute in {WORLD} run setblock 8 66 5 minecraft:oak_door[half=upper,facing=south]",
        f"execute in {WORLD} run tp Tester 0 65 0 0 0",
    ])
    time.sleep(2.0)
    failed, _ = trigger_failed_move(bot_url)
    if not failed:
        print("  → FAIL (goto unexpectedly succeeded)")
        return False
    # mc status clears the flag.
    s = http_get(f"{bot_url}/status?lean=true", timeout=5)
    print(f"  mc status ok={s.get('ok')}")
    # Now interact — should NOT get MOVEMENT_PRECONDITION_FAILED.
    r = http_post(f"{bot_url}/action/interact", {"x": 8, "y": 65, "z": 5}, timeout=15)
    code = (r.get("error") or {}).get("code")
    print(f"  interact post-status ok={r.get('ok')}  code={code}")
    # Pass if the precondition guard did NOT fire.
    passed = code != "MOVEMENT_PRECONDITION_FAILED"
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_far_target_not_intercepted(bot_url: str) -> bool:
    print("\n=== C: failed move, then verb at >5 blocks → guard does NOT fire ===")
    reset_arena()
    seal_target_5_65_5()
    rcon_batch([
        # Far interact target — door at (-12,65,-12), dist ~24 from (5,65,5).
        f"execute in {WORLD} run setblock -12 65 -12 minecraft:oak_door[half=lower,facing=south]",
        f"execute in {WORLD} run setblock -12 66 -12 minecraft:oak_door[half=upper,facing=south]",
        f"execute in {WORLD} run tp Tester 0 65 0 0 0",
    ])
    time.sleep(2.0)
    failed, _ = trigger_failed_move(bot_url)
    if not failed:
        print("  → FAIL (goto unexpectedly succeeded)")
        return False
    # Far target — dist from intended (5,65,5) is ~24 blocks, well past 5.
    r = http_post(f"{bot_url}/action/interact", {"x": -12, "y": 65, "z": -12}, timeout=15)
    code = (r.get("error") or {}).get("code")
    ok = r.get("ok")
    print(f"  far interact ok={ok}  code={code}")
    # Pass means the precondition guard did NOT fire. The verb itself may
    # still fail (OUT_OF_RANGE because of pathfind to far coord), but not
    # with MOVEMENT_PRECONDITION_FAILED.
    passed = code != "MOVEMENT_PRECONDITION_FAILED"
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
        ("A", scenario_precondition_blocks_interact(args.bot_url)),
        ("B", scenario_status_clears_flag(args.bot_url)),
        ("C", scenario_far_target_not_intercepted(args.bot_url)),
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
