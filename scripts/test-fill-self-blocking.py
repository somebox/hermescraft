#!/usr/bin/env python3
"""test-fill-self-blocking.py — F55.2 verification.

Verifies `mc fill` (place_fill) surfaces the case where the bot is
standing inside the fill region — those cells fail to place because the
bot's foot/head block them. v6 Mason's mistake: ignored FILL_PARTIAL
and reported "complete" when his own body had blocked a cell.

Scenarios:
  A — Bot stands inside a 3×3 fill region at Y=66 (region wants
      cobble at 0..2, 66, 0..2). Expect FILL_PARTIAL with
      bot_was_inside_region=true and the bot's foot cell listed in
      bot_blocked_cells.
  B — Bot stands outside the same region. Expect full success (no
      partial, no bot_was_inside_region flag).
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
        f"execute in {WORLD} run clear Flint",
        f"execute in {WORLD} run give Flint minecraft:cobblestone 64",
    ])
    time.sleep(1.5)


def scenario_bot_inside(bot_url: str) -> bool:
    print("\n=== A: bot inside fill region at Y=66 → bot_was_inside_region=true ===")
    reset_arena()
    # Build the floor for the region at Y=65 so the bot has something to stand on
    rcon_batch([
        f"execute in {WORLD} run fill 0 65 0 2 65 2 minecraft:stone",
        f"execute in {WORLD} run tp Flint 1 66 1 90 0",
    ])
    time.sleep(2.0)
    r = http_post(f"{bot_url}/action/place_fill", {
        "block": "cobblestone",
        "x1": 0, "y1": 66, "z1": 0,
        "x2": 2, "y2": 66, "z2": 2,
    }, timeout=30)
    ok = bool(r.get("ok"))
    data = r.get("data") or {}
    bot_inside = data.get("bot_was_inside_region")
    blocked = data.get("bot_blocked_cells") or []
    partial = data.get("partial")
    print(f"  ok={ok}  partial={partial}  bot_was_inside_region={bot_inside}  blocked_cells={blocked}")
    print(f"  result={r.get('result','')[:200]}")
    passed = ok and partial is True and bot_inside is True and len(blocked) >= 1
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_bot_outside(bot_url: str) -> bool:
    print("\n=== B: bot stays outside, fill region in mid-air → no bot_was_inside flag ===")
    reset_arena()
    # No platform inside the region. Bot pathfinds to within 3 blocks but
    # can't climb into mid-air cells, so it stays on the ground outside.
    rcon_batch([
        f"execute in {WORLD} run tp Flint 5 65 5 90 0",
    ])
    time.sleep(2.0)
    # Place fill region at Y=68 (well above bot's head) so the bot can't
    # walk into it. The fill places into floating air space; bot pillars or
    # places-from-below but doesn't end up inside.
    r = http_post(f"{bot_url}/action/place_fill", {
        "block": "cobblestone",
        "x1": 0, "y1": 68, "z1": 0,
        "x2": 2, "y2": 68, "z2": 2,
    }, timeout=30)
    ok = bool(r.get("ok"))
    data = r.get("data") or {}
    bot_inside = data.get("bot_was_inside_region")
    partial = data.get("partial")
    placed = data.get("placed")
    total = data.get("total")
    print(f"  ok={ok}  placed={placed}/{total}  partial={partial}  bot_was_inside={bot_inside}")
    # Pass if the bot was NOT marked as inside the region. The fill may be
    # partial for legit reasons (no adjacent face in mid-air), but the
    # self-blocking flag should be off.
    passed = ok and bot_inside is None
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
        ("A", scenario_bot_inside(args.bot_url)),
        ("B", scenario_bot_outside(args.bot_url)),
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
