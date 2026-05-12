#!/usr/bin/env python3
"""test-stuck-recenter.py — bot wedged at a wall corner should re-centre.

User-reported recurring failure (v32 at t=305s and earlier runs):
when the bot is partially inside a block (e.g., its xz is 2.9 / 0.5
with a solid block at x=3), it can't move along the axis that would
clip the geometry. Pathfinder keeps issuing `forward` but velocity
stays at zero. The stuck watchdog now detects this AND, when the bot
is significantly off-centre in its standing cell, looks toward the
cell centre and steps forward briefly to re-centre.

Scenario:
  Bot tp'd to (2.9, 65, 0.5) — almost touching the east face of a
  solid cobblestone block at (3, 65, 0). Then call `mc goto -1 65 0`
  (west). With the re-centre fix, the watchdog should:
    1. Detect 8s of no movement
    2. Detect off-centre (offX = 2.9 - 2.5 = 0.4)
    3. Look toward cell centre (-0.4 west)
    4. Step forward briefly → re-centres to (2.5, 65, 0.5)
    5. Pathfinder retries and finds a clean route west
  Without the fix, the bot stays wedged for the entire timeout.

  Pass: bot reaches x < 1 within 20 seconds.
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


def rcon_batch(cmds: list[str]) -> None:
    if not cmds:
        return
    subprocess.run(
        ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"],
        input="\n".join(cmds) + "\n",
        capture_output=True, text=True, timeout=60,
    )


def http_get(url: str, timeout: float = 5.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def http_post(url: str, body: dict, timeout: float = 30.0) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try: return json.loads(e.read().decode())
        except Exception: return {"ok": False, "error": str(e)}


def bot_pos(bot_url: str) -> dict:
    return (http_get(f"{bot_url}/status?lean=true").get("data") or {}).get("position") or {}


def setup_wedge() -> None:
    """Wall at x=3, bot tp'd to (2.9, 65, 0.5) — just east of the wall,
    pressed against its east face. The bot's hitbox (0.6 wide) crosses
    the x=3 boundary. Going west requires the bot to back off the wall."""
    cmds = [
        f"execute in {WORLD} run difficulty peaceful",
        f"execute in {WORLD} run gamerule doDaylightCycle false",
        f"execute in {WORLD} run gamerule doMobSpawning false",
        f"execute in {WORLD} run time set day",
        f"execute in {WORLD} run kill @e[type=!player]",
        # Wide clean area.
        f"execute in {WORLD} run fill -16 65 -16 16 70 16 minecraft:air",
        f"execute in {WORLD} run fill -16 64 -16 16 64 16 minecraft:grass_block",
        # The wall the bot is wedged against. 2 blocks tall, 1 block wide
        # at x=3, spanning z=-1..1 so the bot can't trivially go around.
        f"execute in {WORLD} run setblock 3 65 -1 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 3 65 0 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 3 65 1 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 3 66 -1 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 3 66 0 minecraft:cobblestone",
        f"execute in {WORLD} run setblock 3 66 1 minecraft:cobblestone",
        # Bot teleported pressed against the wall's east face — facing east
        # (yaw 270 in MC: 0=south, 90=west, 180=north, 270=east). Wait
        # actually MC yaw: 0=south, 90=W, 180=N, 270=E. We want facing
        # WEST (toward wall to feel the wedge) — yaw=90.
        f"execute in {WORLD} run tp Flint 3.9 65 0.5 90 0",
        "clear Flint",
        "effect clear Flint",
        "effect give Flint minecraft:saturation 600 1",
    ]
    rcon_batch(cmds)
    time.sleep(2.0)


def run_scenario(bot_url: str) -> bool:
    print("\n=== Wedge scenario: bot at (3.9,65,0.5) facing wall at x=3, goto -1,65,0 ===")
    setup_wedge()
    pre = bot_pos(bot_url)
    print(f"  pre pos: {pre}")
    # Fire a non-blocking goto — without bg variant, we'll use a short
    # timeout client-side and watch state.
    import threading
    result = {}
    def call():
        try:
            result['r'] = http_post(
                f"{bot_url}/action/goto",
                {"x": -1, "y": 65, "z": 0},
                timeout=25,
            )
        except Exception as e:
            result['r'] = {"ok": False, "error": str(e)}
    t = threading.Thread(target=call, daemon=True)
    t.start()
    # Watch position for up to 22s.
    progressed = False
    last_x = pre.get('x', 99)
    for i in range(22):
        time.sleep(1.0)
        p = bot_pos(bot_url)
        x = p.get('x', 99)
        if i % 2 == 0 or abs(x - last_x) > 0.3:
            print(f"  +{i+1}s: pos={p}")
        last_x = x
        if x < 1.0:
            progressed = True
            break
    t.join(timeout=5)
    r = result.get('r', {})
    print(f"  goto result: ok={r.get('ok')}  err={(r.get('error') or {}).get('message') if isinstance(r.get('error'), dict) else r.get('error', '')}")
    final = bot_pos(bot_url)
    print(f"  final pos: {final}")
    expected = progressed or (final.get('x', 99) < 1.0)
    print(f"  → {'PASS' if expected else 'FAIL'}  (expected: bot reaches x<1 within 22s)")
    return expected


def cleanup() -> None:
    rcon_batch([
        f"execute in {WORLD} run fill -16 65 -16 16 70 16 minecraft:air",
        f"execute in {WORLD} run fill -16 64 -16 16 64 16 minecraft:grass_block",
        f"execute in {WORLD} run tp Flint 52 65 52",
        f"execute in {WORLD} run kill @e[type=item,distance=..40]",
    ])


def main() -> int:
    p = argparse.ArgumentParser()
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
    ok = run_scenario(args.bot_url)
    print("\n=== Summary ===")
    print(f"  wedge: {'PASS' if ok else 'FAIL'}")
    cleanup()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
