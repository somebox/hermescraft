#!/usr/bin/env python3
"""test-region-predicates.py — F45.7 verification.

Verifies `mc is_empty` and `mc is_filled` region predicates against
known-state regions.

Scenarios:
  A — Cleared 4x4x4 region. Expect is_empty -> empty=true.
  B — Same region with one stray block. Expect is_empty -> empty=false,
      non_empty_blocks contains the stray.
  C — Region fully filled with cobblestone. Expect is_filled cobblestone
      -> filled=true.
  D — Same filled region missing one cell. Expect is_filled cobblestone
      -> filled=false, missing list contains the gap.
  E — Region > 1000 cells. Expect REGION_TOO_LARGE error.
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
        f"execute in {WORLD} run time set noon",
        f"execute in {WORLD} run kill @e[type=!player]",
        f"execute in {WORLD} run fill -10 65 -10 10 80 10 minecraft:air",
        f"execute in {WORLD} run fill -10 64 -10 10 64 10 minecraft:stone",
        f"execute in {WORLD} run tp Flint 0 65 0 90 0",
    ]
    rcon_batch(cmds)
    time.sleep(1.5)


def empty_region() -> None:
    rcon_batch([f"execute in {WORLD} run fill 0 65 0 3 68 3 minecraft:air"])
    time.sleep(0.5)


def add_stray() -> None:
    rcon_batch([f"execute in {WORLD} run setblock 2 66 2 minecraft:cobblestone"])
    time.sleep(0.5)


def fill_region() -> None:
    rcon_batch([f"execute in {WORLD} run fill 0 65 0 3 68 3 minecraft:cobblestone"])
    time.sleep(0.5)


def punch_hole() -> None:
    rcon_batch([f"execute in {WORLD} run setblock 1 66 1 minecraft:air"])
    time.sleep(0.5)


def scenario_empty_true(bot_url: str) -> bool:
    print("\n=== A: is_empty on cleared region — expect empty=true ===")
    empty_region()
    r = http_post(
        f"{bot_url}/action/is_empty",
        {"x1": 0, "y1": 65, "z1": 0, "x2": 3, "y2": 68, "z2": 3},
        timeout=10,
    )
    ok = bool(r.get("ok"))
    data = r.get("data") or {}
    print(f"  ok={ok}  empty={data.get('empty')}  non_empty={len(data.get('non_empty_blocks') or [])}")
    passed = ok and data.get("empty") is True
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_empty_false(bot_url: str) -> bool:
    print("\n=== B: is_empty with one stray — expect empty=false ===")
    empty_region()
    add_stray()
    r = http_post(
        f"{bot_url}/action/is_empty",
        {"x1": 0, "y1": 65, "z1": 0, "x2": 3, "y2": 68, "z2": 3},
        timeout=10,
    )
    ok = bool(r.get("ok"))
    data = r.get("data") or {}
    non_empty = data.get("non_empty_blocks") or []
    print(f"  ok={ok}  empty={data.get('empty')}  non_empty[0]={non_empty[0] if non_empty else None}")
    passed = (
        ok
        and data.get("empty") is False
        and len(non_empty) >= 1
        and non_empty[0].get("name") == "cobblestone"
        and non_empty[0].get("coord", {}).get("x") == 2
    )
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_filled_true(bot_url: str) -> bool:
    print("\n=== C: is_filled cobblestone on full region — expect filled=true ===")
    fill_region()
    r = http_post(
        f"{bot_url}/action/is_filled",
        {"x1": 0, "y1": 65, "z1": 0, "x2": 3, "y2": 68, "z2": 3, "material": "cobblestone"},
        timeout=10,
    )
    ok = bool(r.get("ok"))
    data = r.get("data") or {}
    print(f"  ok={ok}  filled={data.get('filled')}  missing={len(data.get('missing') or [])}")
    passed = ok and data.get("filled") is True
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_filled_false(bot_url: str) -> bool:
    print("\n=== D: is_filled with one missing cell — expect filled=false ===")
    fill_region()
    punch_hole()
    r = http_post(
        f"{bot_url}/action/is_filled",
        {"x1": 0, "y1": 65, "z1": 0, "x2": 3, "y2": 68, "z2": 3, "material": "cobblestone"},
        timeout=10,
    )
    ok = bool(r.get("ok"))
    data = r.get("data") or {}
    missing = data.get("missing") or []
    print(f"  ok={ok}  filled={data.get('filled')}  missing[0]={missing[0] if missing else None}")
    passed = (
        ok
        and data.get("filled") is False
        and len(missing) >= 1
        and missing[0].get("coord", {}).get("x") == 1
        and missing[0].get("coord", {}).get("y") == 66
        and missing[0].get("coord", {}).get("z") == 1
    )
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_too_large(bot_url: str) -> bool:
    print("\n=== E: is_empty on >1000-cell region — expect REGION_TOO_LARGE ===")
    r = http_post(
        f"{bot_url}/action/is_empty",
        {"x1": 0, "y1": 65, "z1": 0, "x2": 11, "y2": 75, "z2": 11},
        timeout=10,
    )
    ok = bool(r.get("ok"))
    err = r.get("error") or {}
    code = err.get("code") if isinstance(err, dict) else ""
    print(f"  ok={ok}  code={code}")
    passed = (not ok) and code == "REGION_TOO_LARGE"
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
        ("A", scenario_empty_true(args.bot_url)),
        ("B", scenario_empty_false(args.bot_url)),
        ("C", scenario_filled_true(args.bot_url)),
        ("D", scenario_filled_false(args.bot_url)),
        ("E", scenario_too_large(args.bot_url)),
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
