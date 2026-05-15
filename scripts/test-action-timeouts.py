#!/usr/bin/env python3
"""test-action-timeouts.py — F45.2 verification.

Verifies that long-running actions return a structured OPERATION_TIMEOUT
within their wallclock cap instead of hanging indefinitely.

Scenarios:
  A — `mc place` against an unreachable coord (walled off behind a
      bedrock floor + cobblestone ceiling). Expect ok=false,
      error.code='OPERATION_TIMEOUT' within ~9s (cap is 8s).

  B — `mc goto` toward a sealed cell across a cobble wall the bot
      cannot path around. Expect ok=false, error.code in
      {'OPERATION_TIMEOUT','NAV_BLOCKED','NAV_FAILED'} within ~16s
      (goto cap is 15s).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
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


def setup_arena() -> None:
    cmds = [
        f"execute in {WORLD} run difficulty peaceful",
        f"execute in {WORLD} run gamerule doDaylightCycle false",
        f"execute in {WORLD} run gamerule doMobSpawning false",
        f"execute in {WORLD} run time set noon",
        f"execute in {WORLD} run kill @e[type=!player]",
        f"execute in {WORLD} run fill -20 65 -20 20 80 20 minecraft:air",
        f"execute in {WORLD} run fill -20 64 -20 20 64 20 minecraft:stone",
        # Sealed island at (15, 65, 15): bedrock floor + 4 walls + roof so
        # no path can reach 15,66,15.
        f"execute in {WORLD} run fill 14 64 14 16 64 16 minecraft:bedrock",
        f"execute in {WORLD} run fill 14 65 14 16 67 16 minecraft:air",
        f"execute in {WORLD} run fill 14 65 14 14 67 16 minecraft:bedrock",
        f"execute in {WORLD} run fill 16 65 14 16 67 16 minecraft:bedrock",
        f"execute in {WORLD} run fill 14 65 14 16 67 14 minecraft:bedrock",
        f"execute in {WORLD} run fill 14 65 16 16 67 16 minecraft:bedrock",
        f"execute in {WORLD} run fill 14 67 14 16 67 16 minecraft:bedrock",
        f"execute in {WORLD} run tp Flint 0 65 0 90 0",
        "clear Flint",
        "give Flint minecraft:cobblestone 64",
        "effect clear Flint",
    ]
    rcon_batch(cmds)
    time.sleep(1.5)


def _err_fields(r: dict) -> tuple[str, str]:
    err = r.get("error")
    if isinstance(err, dict):
        return (err.get("code") or "", err.get("message") or "")
    if isinstance(err, str):
        return ("", err)
    return ("", "")


def scenario_place_timeout(bot_url: str) -> bool:
    print("\n=== A: mc place at unreachable cell — expect OPERATION_TIMEOUT ===")
    setup_arena()
    # Try to place cobble in the middle of the sealed island.
    t0 = time.time()
    r = http_post(
        f"{bot_url}/action/place",
        {"block": "cobblestone", "x": 15, "y": 66, "z": 15},
        timeout=15,
    )
    elapsed = time.time() - t0
    ok = bool(r.get("ok"))
    code, msg = _err_fields(r)
    print(f"  elapsed={elapsed:.2f}s  ok={ok}  code={code}  msg={msg[:120]}")
    # Accept either OPERATION_TIMEOUT (path took >8s) or OUT_OF_RANGE
    # (pathfind failed fast). The contract requirement is: returns within
    # ~9s with a structured error, not a hang.
    passed = (not ok) and (elapsed < 12.0) and code in {"OPERATION_TIMEOUT", "OUT_OF_RANGE", "NO_LINE_OF_SIGHT"}
    print(f"  → {'PASS' if passed else 'FAIL'}  (need: ok=false, code in {{OPERATION_TIMEOUT, OUT_OF_RANGE, NO_LINE_OF_SIGHT}}, elapsed<12s)")
    return passed


def scenario_goto_timeout(bot_url: str) -> bool:
    print("\n=== B: mc goto across sealed wall — expect timeout or NAV_BLOCKED ===")
    setup_arena()
    t0 = time.time()
    r = http_post(
        f"{bot_url}/action/goto",
        {"x": 15, "y": 66, "z": 15},
        timeout=25,
    )
    elapsed = time.time() - t0
    ok = bool(r.get("ok"))
    code, _ = _err_fields(r)
    print(f"  elapsed={elapsed:.2f}s  ok={ok}  code={code}")
    passed = (not ok) and (elapsed < 20.0) and code in {"OPERATION_TIMEOUT", "NAV_BLOCKED", "NAV_FAILED", "NAV_TARGET_OCCUPIED", "NAV_TIMEOUT"}
    print(f"  → {'PASS' if passed else 'FAIL'}  (need: ok=false, elapsed<20s, expected error code)")
    return passed


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--bot-url", default=DEFAULT_BOT_URL)
    args = p.parse_args()
    try:
        s = http_get(f"{args.bot_url}/status?lean=true", timeout=5)
        if not s.get("ok"):
            print(f"bot at {args.bot_url} not ready: {s}")
            return 2
    except Exception as e:
        print(f"can't reach bot at {args.bot_url}: {e}")
        return 2

    results = [
        ("A", scenario_place_timeout(args.bot_url)),
        ("B", scenario_goto_timeout(args.bot_url)),
    ]

    print("\n=== Summary ===")
    for name, ok in results:
        print(f"  {name}: {'PASS' if ok else 'FAIL'}")

    # Tidy: remove the sealed island.
    rcon_batch([
        f"execute in {WORLD} run fill 14 64 14 16 67 16 minecraft:air",
        f"execute in {WORLD} run fill 14 64 14 16 64 16 minecraft:stone",
        f"execute in {WORLD} run tp Flint 52 65 52",
    ])
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(main())
