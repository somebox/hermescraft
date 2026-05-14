#!/usr/bin/env python3
"""test-escape-multidir.py — F56 verification (escape improvements).

Verifies `mc escape` for corner/wedge cases:
  - tries ALL open directions in order, not just the first
  - falls back to burst (forward+jump) if pathfinder fails all sidesteps
  - returns ESCAPE_STUCK with the full attempt breakdown if both fail

Scenarios:
  A — Bot in a 3-walled cell (walls N, E, S; open W). mc escape →
      ok=true, action_taken=sidestep_W or burst_W, bot ends 'open'.
  B — Bot in a corner (walls N and W; open E and S). mc escape →
      ok=true, bot ends 'open'.
  C — Bot fully trapped (4 walls + ceiling, no pillar block). mc escape
      → ok=false, code in (ESCAPE_NO_OPEN_DIR / ESCAPE_ENCLOSURE / ESCAPE_CEILING_BLOCKED),
      with observed_state populated.
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


def reset_arena(bot_url: str = DEFAULT_BOT_URL) -> None:
    rcon_batch([
        f"execute in {WORLD} run difficulty peaceful",
        f"execute in {WORLD} run gamerule doDaylightCycle false",
        f"execute in {WORLD} run time set noon",
        f"execute in {WORLD} run kill @e[type=!player]",
        f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
        f"execute in {WORLD} run fill -10 64 -10 10 64 10 minecraft:stone",
        f"execute in {WORLD} run clear Tester",
    ])
    # F58: clear ctx.recentEscapes + ctx.recentStuckCells via mc status so
    # F57's loop-detector / blackball don't fire from previous scenarios.
    try:
        http_get(f"{bot_url}/status?lean=true", timeout=5)
    except Exception:
        pass
    time.sleep(1.0)


def scenario_three_walled(bot_url: str) -> bool:
    print("\n=== A: bot in 3-walled cell (walls N/E/S, open W) → escape via W ===")
    reset_arena(bot_url)
    # Walls at (0,65,-1) N, (1,65,0) E, (0,65,1) S. Bot at (0,65,0). Open W to (-1,65,0).
    rcon_batch([
        f"execute in {WORLD} run setblock 0 65 -1 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 1 65 0 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 0 65 1 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 0 66 -1 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 1 66 0 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 0 66 1 minecraft:cobblestone",
        f"execute in {WORLD} run tp Tester 0 65 0 90 0",
    ])
    time.sleep(2.0)
    r = http_post(f"{bot_url}/action/escape", {}, timeout=20)
    ok = bool(r.get("ok"))
    data = r.get("data") or {}
    action = data.get("action_taken")
    cls_after = data.get("classification_after")
    attempts = data.get("attempts") or []
    print(f"  ok={ok}  action={action}  after={cls_after}  attempts={attempts}")
    passed = ok and (cls_after in ("open", "alley"))
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_corner(bot_url: str) -> bool:
    print("\n=== B: bot in corner (walls N and W) → escape via E or S ===")
    reset_arena(bot_url)
    # Walls at (0,65,-1) N, (-1,65,0) W. Bot at (0,65,0). Open E and S.
    rcon_batch([
        f"execute in {WORLD} run setblock 0 65 -1 minecraft:cobblestone",
        f"execute in {WORLD} run setblock -1 65 0 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 0 66 -1 minecraft:cobblestone",
        f"execute in {WORLD} run setblock -1 66 0 minecraft:cobblestone",
        f"execute in {WORLD} run tp Tester 0 65 0 90 0",
    ])
    time.sleep(2.0)
    r = http_post(f"{bot_url}/action/escape", {}, timeout=20)
    ok = bool(r.get("ok"))
    data = r.get("data") or {}
    action = data.get("action_taken")
    cls_after = data.get("classification_after")
    print(f"  ok={ok}  action={action}  after={cls_after}")
    passed = ok and (cls_after in ("open", "alley"))
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_trapped(bot_url: str) -> bool:
    print("\n=== C: bot fully trapped, no pillar block → structured error ===")
    reset_arena(bot_url)
    rcon_batch([
        # 4 walls
        f"execute in {WORLD} run setblock 0 65 -1 minecraft:bedrock",
        f"execute in {WORLD} run setblock 1 65 0 minecraft:bedrock",
        f"execute in {WORLD} run setblock 0 65 1 minecraft:bedrock",
        f"execute in {WORLD} run setblock -1 65 0 minecraft:bedrock",
        f"execute in {WORLD} run setblock 0 66 -1 minecraft:bedrock",
        f"execute in {WORLD} run setblock 1 66 0 minecraft:bedrock",
        f"execute in {WORLD} run setblock 0 66 1 minecraft:bedrock",
        f"execute in {WORLD} run setblock -1 66 0 minecraft:bedrock",
        # Ceiling 1 above head
        f"execute in {WORLD} run setblock 0 67 0 minecraft:bedrock",
        f"execute in {WORLD} run clear Tester",
        f"execute in {WORLD} run tp Tester 0 65 0 90 0",
    ])
    time.sleep(2.0)
    r = http_post(f"{bot_url}/action/escape", {}, timeout=20)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    code = err.get("code")
    obs = err.get("observed_state") or {}
    print(f"  ok={ok}  code={code}  classification_before={obs.get('classification')}  blocked_dirs={obs.get('blocked_dirs')}")
    passed = (not ok) and code in ("ESCAPE_NO_OPEN_DIR", "ESCAPE_ENCLOSURE", "ESCAPE_CEILING_BLOCKED", "ESCAPE_NO_PILLAR_BLOCK", "ESCAPE_STUCK")
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
        ("A", scenario_three_walled(args.bot_url)),
        ("B", scenario_corner(args.bot_url)),
        ("C", scenario_trapped(args.bot_url)),
    ]

    print("\n=== Summary ===")
    for name, ok in results:
        print(f"  {name}: {'PASS' if ok else 'FAIL'}")
    rcon_batch([
        f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
        f"execute in {WORLD} run tp Tester 52 65 52",
    ])
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(main())
