#!/usr/bin/env python3
"""test-dig-door-support.py — F54.1 verification.

Verifies that `mc dig` refuses to dig a block that supports a door or
fence_gate directly above, and that --force overrides the guard.

Geometry note: the support cobble blocks sit at y=65 (one block above
the y=64 floor) and the doors/gates above them at y=66+y=67. Earlier
the cobble was placed AT y=64 (embedded in the floor), but the F66
dig LOS guard added after the test was written rejects digs whose
raycast from bot eye passes through surrounding floor cells. Lifting
the targets clear of the floor restores the original test intent
without weakening the LOS contract.

Scenarios:
  A — Cobblestone at (5,65,0) with oak_door at (5,66,0). Expect
      mc dig 5 65 0 → SUPPORT_BLOCK with supported_block.name='oak_door'.
  B — Same setup, but mc dig 5 65 0 with force=true. Expect ok=true
      (digging proceeds; door drops as item entity).
  C — Plain cobblestone at (7,65,0) with no door above. Expect
      mc dig 7 65 0 → ok=true (normal dig works).
  D — Cobblestone at (3,65,0) with oak_fence_gate at (3,66,0). Expect
      mc dig 3 65 0 → SUPPORT_BLOCK with supported_block.name='oak_fence_gate'.
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


def block_is(x: int, y: int, z: int, kind: str) -> bool:
    """Test-mode helper: ask the server whether the block at (x,y,z) is the
    given kind. Uses rcon `execute if block ...` which prints `Test passed`
    on match and nothing (with non-zero exit) otherwise."""
    out = rcon(f"execute in {WORLD} if block {x} {y} {z} minecraft:{kind}")
    return "Test passed" in out


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


def setup_arena() -> None:
    # Geometry: floor stone at y=64 (top face y=65). Cobble support blocks
    # placed at y=65 (one block ABOVE the floor), not at y=64. With y=64
    # cobble, the F66 dig LOS guard's raycast from the bot's eye (~y=66.62)
    # down to the cobble face would pass through neighboring floor stones
    # at y=64 and be refused for NO_LINE_OF_SIGHT before SUPPORT_BLOCK or
    # --force could fire. Lifting the cobble out of the floor gives the
    # raycast a clean line at the bot's own y-level. The doors above each
    # support shift up one block to match (y=66 lower, y=67 upper).
    cmds = [
        f"execute in {WORLD} run difficulty peaceful",
        f"execute in {WORLD} run gamerule doDaylightCycle false",
        f"execute in {WORLD} run time set noon",
        f"execute in {WORLD} run kill @e[type=!player]",
        f"execute in {WORLD} run fill -10 65 -10 10 80 10 minecraft:air",
        f"execute in {WORLD} run fill -10 64 -10 10 64 10 minecraft:stone",
        # Door-on-support setup (used by A and B)
        f"execute in {WORLD} run setblock 5 65 0 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 5 66 0 minecraft:oak_door[half=lower]",
        f"execute in {WORLD} run setblock 5 67 0 minecraft:oak_door[half=upper]",
        # Plain cobblestone (C)
        f"execute in {WORLD} run setblock 7 65 0 minecraft:cobblestone",
        # Fence-gate-on-support setup (D)
        f"execute in {WORLD} run setblock 3 65 0 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 3 66 0 minecraft:oak_fence_gate",
        # Position bot within reach of all targets
        f"execute in {WORLD} run tp Flint 0 65 0 90 0",
        # Ensure the bot has a pickaxe for digging cobblestone (tests B and C)
        f"execute in {WORLD} run clear Flint",
        f"execute in {WORLD} run give Flint minecraft:wooden_pickaxe 1",
    ]
    rcon_batch(cmds)
    time.sleep(1.5)


def tp_adjacent(x: int, z: int) -> None:
    """TP Flint to (x-1, 65, z) facing east — one block west of (x, 65, z)
    on the y=64 floor. Each scenario calls this so the LOS raycast from bot
    eye to the target doesn't pass through other scenario blocks placed
    along x∈{3,5,7} (e.g. without this, scenario B's raycast to (5,65,0)
    transits the cobble at (3,65,0) placed for scenario D)."""
    rcon(f"execute in {WORLD} run tp Flint {x - 1} 65 {z} 270 0")
    time.sleep(0.4)


def scenario_door_support(bot_url: str) -> bool:
    print("\n=== A: dig support block under oak_door → SUPPORT_BLOCK ===")
    tp_adjacent(5, 0)
    r = http_post(f"{bot_url}/action/dig", {"x": 5, "y": 65, "z": 0}, timeout=15)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    code = err.get("code")
    supp = (err.get("observed_state") or {}).get("supported_block") or {}
    print(f"  ok={ok}  code={code}  supported={supp.get('name')} at ({supp.get('x')},{supp.get('y')},{supp.get('z')})")
    passed = (not ok) and code == "SUPPORT_BLOCK" and supp.get("name") == "oak_door"
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_door_support_force(bot_url: str) -> bool:
    print("\n=== B: dig support block with --force → ok=true AND block actually broken ===")
    tp_adjacent(5, 0)
    r = http_post(f"{bot_url}/action/dig", {"x": 5, "y": 65, "z": 0, "force": True}, timeout=20)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    # Verify side-effect: the block should now be air. A regression where
    # the action returns ok=true without actually breaking the block would
    # have slipped through if we only checked the HTTP response.
    is_air = block_is(5, 65, 0, "air")
    print(f"  ok={ok}  err.code={err.get('code')}  err.message={err.get('message')}  block_after=air? {is_air}")
    passed = ok and is_air
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_plain_cobble(bot_url: str) -> bool:
    print("\n=== C: dig plain cobblestone (no door above) → ok=true AND block actually broken ===")
    tp_adjacent(7, 0)
    r = http_post(f"{bot_url}/action/dig", {"x": 7, "y": 65, "z": 0}, timeout=20)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    is_air = block_is(7, 65, 0, "air")
    print(f"  ok={ok}  err.code={err.get('code')}  err.message={err.get('message')}  block_after=air? {is_air}")
    passed = ok and is_air
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_fence_gate_support(bot_url: str) -> bool:
    print("\n=== D: dig support block under oak_fence_gate → SUPPORT_BLOCK ===")
    tp_adjacent(3, 0)
    r = http_post(f"{bot_url}/action/dig", {"x": 3, "y": 65, "z": 0}, timeout=15)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    code = err.get("code")
    supp = (err.get("observed_state") or {}).get("supported_block") or {}
    print(f"  ok={ok}  code={code}  supported={supp.get('name')} at ({supp.get('x')},{supp.get('y')},{supp.get('z')})")
    passed = (not ok) and code == "SUPPORT_BLOCK" and supp.get("name") == "oak_fence_gate"
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

    setup_arena()
    results = [
        ("A", scenario_door_support(args.bot_url)),
        ("B", scenario_door_support_force(args.bot_url)),
        ("C", scenario_plain_cobble(args.bot_url)),
        ("D", scenario_fence_gate_support(args.bot_url)),
    ]

    print("\n=== Summary ===")
    for name, ok in results:
        print(f"  {name}: {'PASS' if ok else 'FAIL'}")

    rcon_batch([
        f"execute in {WORLD} run fill -10 65 -10 10 80 10 minecraft:air",
        f"execute in {WORLD} run tp Flint 52 65 52",
    ])
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(main())
