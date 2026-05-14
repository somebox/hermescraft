#!/usr/bin/env python3
"""test-place-fresh-craft.py — F55.1 verification.

Verifies `mc place BLOCK X Y Z` auto-equips the block from inventory
(including freshly-crafted items where the Item reference may have
just rotated slots), and returns a clear EQUIP_FAILED error if equip
genuinely couldn't land.

Scenarios:
  A — Bot has crafting_table in inv, empty hand. mc place crafting_table
      X Y Z → ok=true (auto-equip succeeds).
  B — Bot has crafting_table in inv (4 planks given, no auto-craft).
      Empty hand. mc place crafting_table X Y Z → ok=true.
  C — Sanity: bot has no crafting_table at all. mc place crafting_table
      X Y Z → INVENTORY_MISSING (not EQUIP_FAILED).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BOT_URL = "http://localhost:3002"
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
        f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
        f"execute in {WORLD} run fill -10 64 -10 10 64 10 minecraft:stone",
        f"execute in {WORLD} run tp Flint 0 65 0 90 0",
        f"execute in {WORLD} run clear Flint",
    ])
    time.sleep(1.5)


def scenario_post_craft_place(bot_url: str) -> bool:
    print("\n=== A: craft crafting_table, then mc place → ok=true (auto-equip) ===")
    reset_arena()
    rcon_batch([
        f"execute in {WORLD} run give Flint minecraft:oak_planks 4",
    ])
    time.sleep(0.5)
    # Craft a crafting_table from the planks (mc craft accepts the recipe by name)
    cr = http_post(f"{bot_url}/action/craft", {"item": "crafting_table", "count": 1}, timeout=20)
    print(f"  craft ok={cr.get('ok')}  inv after craft={cr.get('state',{}).get('inventory')}")
    if not cr.get("ok"):
        print(f"  → FAIL (craft itself failed: {cr.get('error')})")
        return False
    # Unequip to force place's auto-equip path
    ueq = http_post(f"{bot_url}/action/unequip", {}, timeout=5)
    time.sleep(0.3)
    r = http_post(f"{bot_url}/action/place", {"block": "crafting_table", "x": 2, "y": 65, "z": 0}, timeout=15)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    print(f"  place ok={ok}  err.code={err.get('code')}  err.message={err.get('message','')[:140]}")
    passed = ok
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_inv_empty_hand_place(bot_url: str) -> bool:
    print("\n=== B: inv has crafting_table, hand empty → place auto-equips ===")
    reset_arena()
    rcon_batch([
        f"execute in {WORLD} run give Flint minecraft:crafting_table 1",
    ])
    time.sleep(0.8)
    # Unequip first
    ueq = http_post(f"{bot_url}/action/unequip", {}, timeout=5)
    time.sleep(0.3)
    r = http_post(f"{bot_url}/action/place", {"block": "crafting_table", "x": 2, "y": 65, "z": 0}, timeout=15)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    print(f"  ok={ok}  err.code={err.get('code')}  err.message={err.get('message','')[:140]}")
    passed = ok
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_missing_inventory(bot_url: str) -> bool:
    print("\n=== C: bot has no crafting_table at all → INVENTORY_MISSING ===")
    reset_arena()
    time.sleep(0.5)
    r = http_post(f"{bot_url}/action/place", {"block": "crafting_table", "x": 2, "y": 65, "z": 0}, timeout=10)
    ok = bool(r.get("ok"))
    err = (r.get("error") or {}) if not ok else {}
    code = err.get("code")
    print(f"  ok={ok}  code={code}")
    passed = (not ok) and code == "INVENTORY_MISSING"
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
        ("A", scenario_post_craft_place(args.bot_url)),
        ("B", scenario_inv_empty_hand_place(args.bot_url)),
        ("C", scenario_missing_inventory(args.bot_url)),
    ]

    print("\n=== Summary ===")
    for name, ok in results:
        print(f"  {name}: {'PASS' if ok else 'FAIL'}")
    rcon_batch([
        f"execute in {WORLD} run fill -10 60 -10 10 80 10 minecraft:air",
        f"execute in {WORLD} run tp Flint 52 65 52",
    ])
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(main())
