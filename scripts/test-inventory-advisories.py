#!/usr/bin/env python3
"""test-inventory-advisories.py — F54.3 verification.

Verifies `mc inventory` surfaces tool advisories — state-describing hints
about missing or near-broken tools — so the brain doesn't have to infer
them from the absence of a category.

Scenarios:
  A — Bot with cleared inventory. Expect advisories includes
      'no pickaxe' AND 'no axe' hints.
  B — Bot with full-durability wooden_pickaxe + wooden_axe. Expect no
      missing-tool advisories AND no near-breaking advisories.
  C — Bot with a near-broken wooden_pickaxe (damage 56, max 59 → ~5%).
      Expect a near-breaking advisory mentioning wooden_pickaxe.
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


def fetch_inventory(bot_url: str) -> dict:
    r = http_get(f"{bot_url}/inventory", timeout=10)
    return (r.get("data") or {}) if r.get("ok") else {}


def scenario_no_tools(bot_url: str) -> bool:
    print("\n=== A: cleared inventory → advisories list no pickaxe + no axe ===")
    rcon_batch([
        f"execute in {WORLD} run clear Flint",
        f"execute in {WORLD} run give Flint minecraft:bread 4",
    ])
    time.sleep(1.0)
    data = fetch_inventory(bot_url)
    advisories = data.get("advisories", []) or []
    print(f"  advisories={advisories}")
    has_pick_hint = any("no pickaxe" in a.lower() for a in advisories)
    has_axe_hint = any("no axe" in a.lower() for a in advisories)
    passed = has_pick_hint and has_axe_hint
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_full_tools(bot_url: str) -> bool:
    print("\n=== B: full-durability pickaxe + axe → no missing/near-break advisories ===")
    rcon_batch([
        f"execute in {WORLD} run clear Flint",
        f"execute in {WORLD} run give Flint minecraft:wooden_pickaxe 1",
        f"execute in {WORLD} run give Flint minecraft:wooden_axe 1",
    ])
    time.sleep(1.0)
    data = fetch_inventory(bot_url)
    advisories = data.get("advisories", []) or []
    print(f"  advisories={advisories}")
    has_pick_hint = any("no pickaxe" in a.lower() for a in advisories)
    has_axe_hint = any("no axe" in a.lower() for a in advisories)
    has_break_hint = any("near breaking" in a.lower() for a in advisories)
    passed = (not has_pick_hint) and (not has_axe_hint) and (not has_break_hint)
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_near_broken(bot_url: str) -> bool:
    print("\n=== C: damaged pickaxe (Damage 56/59) → near breaking advisory ===")
    rcon_batch([
        f"execute in {WORLD} run clear Flint",
        # 1.21 component format: [minecraft:damage=N]
        f"execute in {WORLD} run give Flint minecraft:wooden_pickaxe[minecraft:damage=56] 1",
        f"execute in {WORLD} run give Flint minecraft:wooden_axe 1",
    ])
    time.sleep(1.0)
    data = fetch_inventory(bot_url)
    advisories = data.get("advisories", []) or []
    print(f"  advisories={advisories}")
    break_hint = next((a for a in advisories if "near breaking" in a.lower() and "wooden_pickaxe" in a.lower()), None)
    passed = break_hint is not None
    print(f"  → {'PASS' if passed else 'FAIL'}  matched={break_hint!r}")
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
        ("A", scenario_no_tools(args.bot_url)),
        ("B", scenario_full_tools(args.bot_url)),
        ("C", scenario_near_broken(args.bot_url)),
    ]

    print("\n=== Summary ===")
    for name, ok in results:
        print(f"  {name}: {'PASS' if ok else 'FAIL'}")

    rcon_batch([
        f"execute in {WORLD} run clear Flint",
    ])
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(main())
