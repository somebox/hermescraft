#!/usr/bin/env python3
"""test-nav-reachable.py — F48 verification.

Verifies the F48 navigation introspection contract:

 1. `mc reachable X Y Z` returns {target_standable, target_reason,
    best_stand} so the brain can pre-flight a goto.
 2. When `mc goto_near` fails (timeout or NAV_BLOCKED) on an unreachable
    cell, the error's observed_state contains `closest_standable` and
    `target_reason` so the brain can retry with a working coord.

Geometry: reproduces the G21 v2 trap that stuck Mason at (2.3, 65, 12.7)
trying to reach (0, 65, 12). A 1-block-thick cobble wall at y=66 along
z=12 means every cell along that row has head_blocked; the only valid
stand cell within range 1 is (0, 65, 13).

Scenarios:
  A — mc reachable 0 65 12 → target_standable=false,
      target_reason='head_blocked', best_stand.x/y/z=(0,65,13)
      (or another distance-1 cell with clearance).
  B — mc reachable 0 65 13 → target_standable=true.
  C — mc goto_near 0 65 12 range=1 → ok=false with
      observed_state.closest_standable populated.
  D — bot stands at (0, 65, 13), mc reachable 0 65 12 → still
      target_standable=false (the cell hasn't changed). Confirms the
      check is pose-independent.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request

DEFAULT_BOT_URL = "http://localhost:3001"
WORLD = "landfolk-test"


def rcon(cmd: str) -> str:
    r = subprocess.run(
        ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"],
        input=cmd + "\n",
        capture_output=True, text=True, timeout=20,
    )
    return r.stdout.strip()


def rcon_batch(cmds: list[str]) -> str:
    if not cmds:
        return ""
    r = subprocess.run(
        ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"],
        input="\n".join(cmds) + "\n",
        capture_output=True, text=True, timeout=60,
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


def setup_mason_trap() -> None:
    """Build Mason's exact post-G21-v2 geometry: cobble wall at y=66 along
    z=12 from x=-2 to x=1, plus a small floor area to stand on at y=64."""
    cmds = [
        f"execute in {WORLD} run difficulty peaceful",
        f"execute in {WORLD} run gamerule doDaylightCycle false",
        f"execute in {WORLD} run time set noon",
        f"execute in {WORLD} run kill @e[type=!player]",
        f"execute in {WORLD} run fill -5 65 5 5 70 18 minecraft:air",
        f"execute in {WORLD} run fill -5 64 5 5 64 18 minecraft:grass_block",
        # North wall at z=12, x=-2..1, y=66..68 (3 high)
        f"execute in {WORLD} run fill -2 66 12 1 68 12 minecraft:cobblestone",
        # TP bot to Mason's stuck position (2.5, 65, 12.7)
        f"execute in {WORLD} run tp Flint 2.5 65 12.7 0 0",
        "effect clear Flint",
        "effect give Flint minecraft:saturation 600 1",
    ]
    rcon_batch(cmds)
    time.sleep(1.5)


def err_fields(r: dict) -> tuple[str, str, dict]:
    err = r.get("error")
    if isinstance(err, dict):
        return (err.get("code") or "", err.get("message") or "", err.get("observed_state") or {})
    if isinstance(err, str):
        return ("", err, {})
    return ("", "", {})


def scenario_reachable_unreachable(bot_url: str) -> bool:
    print("\n=== A: mc reachable 0 65 12 — expect target_standable=false, head_blocked, best_stand set ===")
    setup_mason_trap()
    r = http_post(f"{bot_url}/action/reachable", {"x": 0, "y": 65, "z": 12}, timeout=10)
    ok = bool(r.get("ok"))
    data = r.get("data") or {}
    print(f"  ok={ok}")
    print(f"  target_standable={data.get('target_standable')}  target_reason={data.get('target_reason')}")
    print(f"  best_stand={data.get('best_stand')}")
    passed = (
        ok
        and data.get("target_standable") is False
        and data.get("target_reason") == "head_blocked"
        and (data.get("best_stand") or {}).get("distance", 99) <= 1.5
    )
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_reachable_ok(bot_url: str) -> bool:
    print("\n=== B: mc reachable 0 65 13 — expect target_standable=true ===")
    # arena already set up by scenario A
    r = http_post(f"{bot_url}/action/reachable", {"x": 0, "y": 65, "z": 13}, timeout=10)
    ok = bool(r.get("ok"))
    data = r.get("data") or {}
    print(f"  ok={ok}  target_standable={data.get('target_standable')}  reason={data.get('target_reason')}")
    passed = ok and data.get("target_standable") is True and data.get("target_reason") == "ok"
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_goto_near_enriched_error(bot_url: str) -> bool:
    print("\n=== C: mc goto_near 0 65 12 range=1 — expect error with closest_standable ===")
    # arena already set up
    t0 = time.time()
    r = http_post(
        f"{bot_url}/action/goto_near",
        {"x": 0, "y": 65, "z": 12, "range": 1},
        timeout=25,
    )
    elapsed = time.time() - t0
    ok = bool(r.get("ok"))
    code, _, obs = err_fields(r)
    cs = obs.get("closest_standable")
    tr = obs.get("target_reason")
    print(f"  elapsed={elapsed:.1f}s  ok={ok}  code={code}")
    print(f"  observed.target_reason={tr}  closest_standable={cs}")
    # Pass criteria: nav fails, AND error carries closest_standable.
    # Whether the bot succeeds or fails the nav depends on whether (0,65,13)
    # is within range=1 of (0,65,12) — distance exactly 1.0 is borderline.
    # The KEY test is the diagnostic enrichment, not the nav outcome.
    passed = (
        not ok
        and cs is not None
        and tr in ("head_blocked", "foot_blocked")
    )
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_pose_independent(bot_url: str) -> bool:
    print("\n=== D: bot at (0,65,13), mc reachable 0 65 12 still says not standable ===")
    rcon(f"execute in {WORLD} run tp Flint 0.5 65 13.5 180 0")
    time.sleep(0.5)
    r = http_post(f"{bot_url}/action/reachable", {"x": 0, "y": 65, "z": 12}, timeout=10)
    data = r.get("data") or {}
    print(f"  target_standable={data.get('target_standable')}  reason={data.get('target_reason')}")
    passed = data.get("target_standable") is False and data.get("target_reason") == "head_blocked"
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--bot-url", default=DEFAULT_BOT_URL)
    p.add_argument("--only", choices=["A", "B", "C", "D"])
    args = p.parse_args()
    try:
        s = http_get(f"{args.bot_url}/status?lean=true", timeout=5)
        if not s.get("ok"):
            print(f"bot not ready: {s}"); return 2
    except Exception as e:
        print(f"can't reach bot: {e}"); return 2

    rcon(f"mvtp Flint {WORLD}")
    time.sleep(0.5)

    scenarios = []
    if args.only is None or args.only == "A":
        scenarios.append(("A", scenario_reachable_unreachable))
    if args.only is None or args.only == "B":
        scenarios.append(("B", scenario_reachable_ok))
    if args.only is None or args.only == "C":
        scenarios.append(("C", scenario_goto_near_enriched_error))
    if args.only is None or args.only == "D":
        scenarios.append(("D", scenario_pose_independent))

    results = []
    for name, fn in scenarios:
        try:
            ok = fn(args.bot_url)
        except Exception as e:
            print(f"  scenario {name} crashed: {e}")
            ok = False
        results.append((name, ok))

    print("\n=== Summary ===")
    for name, ok in results:
        print(f"  {name}: {'PASS' if ok else 'FAIL'}")

    rcon_batch([
        f"execute in {WORLD} run fill -5 65 5 5 70 18 minecraft:air",
        f"execute in {WORLD} run tp Flint 52 65 52",
    ])
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(main())
