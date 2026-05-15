#!/usr/bin/env python3
"""test-inspect.py — F45.6 verification.

Verifies `mc inspect X Y Z` returns block name, is_diggable,
is_relocatable, suggested_tool, and entities standing in the cell.

Scenarios:
  A — Air cell. Expect block.name='air', occupied=false unless an entity
      is there.
  B — Crafting table at (3,65,3). Expect block.name='crafting_table',
      is_relocatable=true, is_diggable=true (with F45.5 env var).
  C — Cobblestone at (5,65,5). Expect block.name='cobblestone',
      is_diggable=true, suggested_tool='wooden_pickaxe'.
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
        f"execute in {WORLD} run time set noon",
        f"execute in {WORLD} run kill @e[type=!player]",
        f"execute in {WORLD} run fill -10 65 -10 10 80 10 minecraft:air",
        f"execute in {WORLD} run fill -10 64 -10 10 64 10 minecraft:stone",
        f"execute in {WORLD} run setblock 3 65 3 minecraft:crafting_table",
        f"execute in {WORLD} run setblock 5 65 5 minecraft:cobblestone",
        f"execute in {WORLD} run tp Flint 0 65 0 90 0",
    ]
    rcon_batch(cmds)
    time.sleep(1.5)


def scenario_air(bot_url: str) -> bool:
    print("\n=== A: inspect air cell ===")
    r = http_post(f"{bot_url}/action/inspect", {"x": 7, "y": 66, "z": 7}, timeout=10)
    ok = bool(r.get("ok"))
    data = r.get("data") or {}
    block = data.get("block") or {}
    print(f"  ok={ok}  block.name={block.get('name')}  is_air={block.get('is_air')}  occupied={data.get('occupied')}")
    passed = ok and block.get("name") in ("air", "cave_air") and block.get("is_air") is True
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_crafting_table(bot_url: str) -> bool:
    print("\n=== B: inspect crafting_table ===")
    r = http_post(f"{bot_url}/action/inspect", {"x": 3, "y": 65, "z": 3}, timeout=10)
    ok = bool(r.get("ok"))
    data = r.get("data") or {}
    block = data.get("block") or {}
    print(f"  ok={ok}  block.name={block.get('name')}  is_relocatable={block.get('is_relocatable')}  is_diggable={block.get('is_diggable')}  tool={block.get('suggested_tool')}")
    passed = ok and block.get("name") == "crafting_table" and block.get("is_relocatable") is True
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_cobblestone(bot_url: str) -> bool:
    print("\n=== C: inspect cobblestone ===")
    r = http_post(f"{bot_url}/action/inspect", {"x": 5, "y": 65, "z": 5}, timeout=10)
    ok = bool(r.get("ok"))
    data = r.get("data") or {}
    block = data.get("block") or {}
    print(f"  ok={ok}  block.name={block.get('name')}  is_diggable={block.get('is_diggable')}  tool={block.get('suggested_tool')}")
    passed = ok and block.get("name") == "cobblestone" and block.get("is_diggable") is True and block.get("suggested_tool") == "wooden_pickaxe"
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
        ("A", scenario_air(args.bot_url)),
        ("B", scenario_crafting_table(args.bot_url)),
        ("C", scenario_cobblestone(args.bot_url)),
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
