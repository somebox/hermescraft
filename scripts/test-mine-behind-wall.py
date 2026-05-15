#!/usr/bin/env python3
"""test-mine-behind-wall.py — primitive-level fair-play mining repro.

`mc collect <block>` previously could mine a block that was visible
from above (its top face raycasts to the bot's eye) but had no
mineable face from the bot's current ground position — i.e. it would
"stab through" intervening blocks because mineflayer.dig sends a
packet that Paper accepts on reach distance alone. We now add a
post-pathfind LOS check that requires a clear ray from the bot's eye
to the target block's bot-facing face. Blocks behind a wall are
classified as `behind_wall` and skipped.

Scenarios:
  A — Clear LOS to one stone block at (-2,65,0), bot at (0,65,0).
      Expect: mc collect stone 1 mines that block, mined_count=1.

  B — 2-thick stone wall at x∈{-1,-2}, plus an "isolated" stone block
      at (-4,65,0) behind the wall (top face exposed). bot at
      (0,65,0). The visibility scan can see top of (-4,65,0) by
      looking up over the wall. Closest-first sort puts x=-1 and x=-2
      ahead of x=-4. Expect: mc collect stone 1 mines x=-1 (front),
      not x=-4. The back block stays intact.

  C — Bot fully sealed in a 1×1 cobble shelter. A stone block sits at
      (-2,65,0), 1m beyond the west wall (out of bot LOS).
      Expect: mc collect stone 1 returns NO_VISIBLE_BLOCKS (or 0
      mined), and the stone block stays intact. If a bug let the dig
      packet through, the stone would be gone.

Usage:
  scripts/test-mine-behind-wall.py
  scripts/test-mine-behind-wall.py --only B
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.request
from typing import Optional

from _test_lib import default_bot_url
DEFAULT_BOT_URL = default_bot_url("flint")
WORLD = "landfolk-test"


# ── rcon helpers ──────────────────────────────────────────────────────

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


# ── HTTP helpers ─────────────────────────────────────────────────────

def http_get(url: str, timeout: float = 10.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def http_post(url: str, body: dict, timeout: float = 60.0) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {"ok": False, "error": str(e)}


# ── World probes ─────────────────────────────────────────────────────

def block_at(x: int, y: int, z: int) -> str:
    """Return 'stone' / 'air' / 'cobblestone' / 'other' for the block at
    (x,y,z). Uses `execute if block` for each candidate kind because
    `data get block` only works on block entities (chests, etc.)."""
    for kind in ("air", "stone", "cobblestone", "grass_block"):
        out = rcon(f"execute in {WORLD} if block {x} {y} {z} minecraft:{kind}")
        if "Test passed" in out:
            return kind
    return "other"


def hold_mode(bot_url: str) -> None:
    try:
        http_post(f"{bot_url}/action/mode", {"name": "hold"}, timeout=5)
    except Exception:
        pass


# ── Setup ────────────────────────────────────────────────────────────

def base_setup(extra_cmds: list[str]) -> None:
    # Clean a wider area than the bot's scan range — 16m radius. The bot
    # uses range=12 in collect, plus the natural worldgen has surface
    # stones at x>8 and x<-8 that would otherwise pollute candidate
    # lists. Also stub out y=60..63 so underground stones can't be
    # surfaced by visibility-scan stride aliasing.
    cmds = [
        f"execute in {WORLD} run difficulty peaceful",
        f"execute in {WORLD} run gamerule doDaylightCycle false",
        f"execute in {WORLD} run gamerule doMobSpawning false",
        f"execute in {WORLD} run time set day",
        f"execute in {WORLD} run kill @e[type=!player]",
        f"execute in {WORLD} run fill -16 65 -16 16 70 16 minecraft:air",
        f"execute in {WORLD} run fill -16 64 -16 16 64 16 minecraft:grass_block",
        f"execute in {WORLD} run fill -16 60 -16 16 63 16 minecraft:stone",
    ]
    cmds += extra_cmds
    cmds += [
        # Bot at (3,65,0) facing west — gives 4-7m to the stones at
        # x=-1..-4. That puts every candidate within the visibility
        # scan's vertical FOV (~36°). Closer than ~2.5m and the stone
        # at y=65 falls BELOW the cone from eye y=66.4, so the bot can't
        # see it without pitching down — which the look sweep doesn't.
        f"execute in {WORLD} run tp Flint 3 65 0 90 0",
        "clear Flint",
        "give Flint minecraft:stone_pickaxe 1",
        "effect clear Flint",
        "effect give Flint minecraft:saturation 600 1",
    ]
    rcon_batch(cmds)
    # Give mineflayer time to receive the block updates and the bot's
    # tp. rcon setblock is server-side; client view propagates over the
    # network. 1s wasn't always enough for the post-fill scan to see
    # newly-placed blocks. Bumped to 3.5s.
    time.sleep(3.5)


def setup_A() -> None:
    base_setup([
        f"execute in {WORLD} run setblock -2 65 0 minecraft:stone",
    ])


def setup_B() -> None:
    base_setup([
        # 2-thick wall at x=-1,-2 (1 block tall, no ceiling — bot can
        # see over via raycast pan).
        f"execute in {WORLD} run setblock -1 65 0 minecraft:stone",
        f"execute in {WORLD} run setblock -2 65 0 minecraft:stone",
        # Back-row target block (visible from above through air).
        f"execute in {WORLD} run setblock -4 65 0 minecraft:stone",
    ])


def setup_D() -> None:
    """3×3×3 stone deposit — the G20 case. Used to be 1 candidate per
    collect call, now should be many."""
    walls = []
    for x in (-6, -5, -4):
        for y in (65, 66, 67):
            for z in (-1, 0, 1):
                walls.append(
                    f"execute in {WORLD} run setblock {x} {y} {z} minecraft:stone"
                )
    base_setup(walls)


def setup_E() -> None:
    """G20 v27 repro — small stone deposit + a pond with underwater stone
    nearby. After the deposit is exhausted, refreshPool() must NOT pick
    up the underwater stones (would walk the bot into the pond)."""
    cmds = []
    # 2x1x1 stone deposit (small — easy to exhaust quickly).
    for x in (-5, -4):
        cmds.append(f"execute in {WORLD} run setblock {x} 65 0 minecraft:stone")
    # Pond at z=6..10 — water on top of stone, exactly like the G20 arena.
    for z in range(6, 11):
        for x in range(-3, 4):
            cmds.append(f"execute in {WORLD} run setblock {x} 64 {z} minecraft:water")
    base_setup(cmds)


def setup_C() -> None:
    # Sealed bot in cobble shelter at (3,65,0); stone block hidden behind
    # west wall. base_setup tp's the bot to (3,65,0) — so build the
    # shelter ring around THAT center.
    walls = []
    for (dx, dy, dz) in [
        (1, 0, 0), (-1, 0, 0), (0, 0, 1), (0, 0, -1),    # foot ring
        (1, 1, 0), (-1, 1, 0), (0, 1, 1), (0, 1, -1),    # head ring
        (0, 2, 0),                                       # roof
    ]:
        walls.append(
            f"execute in {WORLD} run setblock {3 + dx} {65 + dy} {dz} minecraft:cobblestone"
        )
    # Hidden stone target sits beyond the west wall.
    walls.append(f"execute in {WORLD} run setblock 0 65 0 minecraft:stone")
    base_setup(walls)


# ── Scenarios ────────────────────────────────────────────────────────

def collect_stone(bot_url: str, count: int = 1) -> dict:
    return http_post(
        f"{bot_url}/action/collect",
        {"block": "stone", "count": count, "range": 10},
        timeout=60,
    )


def run_scenario_A(bot_url: str) -> bool:
    print("\n=== Scenario A: clear LOS to a stone block — collect should MINE it ===")
    setup_A()
    hold_mode(bot_url)
    print(f"  block at (-2,65,0) before: {block_at(-2, 65, 0)}")
    r = collect_stone(bot_url, 1)
    data = r.get("data") or {}
    mined = data.get("mined_count")
    causes = data.get("causes") or {}
    err = r.get("error")
    err_msg = err if isinstance(err, str) else ((err or {}).get("message") if isinstance(err, dict) else "")
    print(f"  collect: ok={r.get('ok')}  mined={mined}  causes={causes}  err={str(err_msg)[:140]}")
    after = block_at(-2, 65, 0)
    print(f"  block at (-2,65,0) after: {after}")
    expected = (mined == 1) and (after in ("missing", "air"))
    print(f"  → {'PASS' if expected else 'FAIL'}")
    return expected


def run_scenario_B(bot_url: str) -> bool:
    print("\n=== Scenario B: 2-thick wall + back block — front mined, back intact ===")
    setup_B()
    hold_mode(bot_url)
    print(f"  pre: -1={block_at(-1,65,0)} -2={block_at(-2,65,0)} -4={block_at(-4,65,0)}")
    r = collect_stone(bot_url, 1)
    data = r.get("data") or {}
    mined = data.get("mined_count")
    causes = data.get("causes") or {}
    err = r.get("error")
    err_msg = err if isinstance(err, str) else ((err or {}).get("message") if isinstance(err, dict) else "")
    print(f"  collect: ok={r.get('ok')}  mined={mined}  causes={causes}  err={str(err_msg)[:140]}")
    after_front = block_at(-1, 65, 0)
    after_back = block_at(-4, 65, 0)
    print(f"  post: -1={after_front} -2={block_at(-2,65,0)} -4={after_back}")
    # Closest-first mines -1 (the front block).
    front_mined = after_front in ("missing", "air")
    back_intact = after_back == "stone"
    expected = (mined == 1) and front_mined and back_intact
    print(f"  front_mined={front_mined}  back_intact={back_intact}")
    print(f"  → {'PASS' if expected else 'FAIL'}")
    return expected


def run_scenario_E(bot_url: str) -> bool:
    print("\n=== Scenario E: deposit + pond — collect must not target underwater stones ===")
    setup_E()
    hold_mode(bot_url)
    print(f"  pre: -5={block_at(-5,65,0)} -4={block_at(-4,65,0)}  pond at z=6..10")
    # Request 6 — we have 2 dry, so the loop will exhaust them and try to
    # rescan. If refreshPool() picks up underwater stones, the bot
    # pathfinds into the pond and stalls. Time budget caps the test.
    r = http_post(
        f"{bot_url}/action/collect",
        {"block": "cobblestone", "count": 6, "range": 12},
        timeout=90,
    )
    data = r.get("data") or {}
    mined = data.get("mined_count")
    causes = data.get("causes") or {}
    err = r.get("error")
    err_msg = err if isinstance(err, str) else ((err or {}).get("message") if isinstance(err, dict) else "")
    print(f"  collect: ok={r.get('ok')}  mined={mined}  causes={causes}  err={str(err_msg)[:120]}")
    # Where did the bot end up? Outside the pond means it didn't get stuck there.
    pos = http_get(f"{bot_url}/status?lean=true").get("data", {}).get("position", {})
    print(f"  final pos: {pos}")
    pos_z = pos.get("z", 0)
    pos_y = pos.get("y", 65)
    not_in_pond = pos_z < 5 or pos_y >= 65
    deposit_consumed = block_at(-5, 65, 0) != "stone" and block_at(-4, 65, 0) != "stone"
    expected = deposit_consumed and not_in_pond and (mined or 0) >= 2
    print(f"  deposit_consumed={deposit_consumed}  not_in_pond={not_in_pond}  mined>=2={(mined or 0)>=2}")
    print(f"  → {'PASS' if expected else 'FAIL'}")
    return expected


def run_scenario_D(bot_url: str) -> bool:
    print("\n=== Scenario D: 3×3×3 deposit — one collect call should mine many ===")
    setup_D()
    hold_mode(bot_url)
    # Pre-count: 27 stone blocks in the deposit.
    pre_stone = 0
    for x in (-6, -5, -4):
        for y in (65, 66, 67):
            for z in (-1, 0, 1):
                if block_at(x, y, z) == "stone":
                    pre_stone += 1
    print(f"  pre stone count in deposit: {pre_stone}")
    r = http_post(
        f"{bot_url}/action/collect",
        {"block": "cobblestone", "count": 8, "range": 12},
        timeout=120,
    )
    data = r.get("data") or {}
    mined = data.get("mined_count")
    causes = data.get("causes") or {}
    err = r.get("error")
    err_msg = err if isinstance(err, str) else ((err or {}).get("message") if isinstance(err, dict) else "")
    print(f"  collect: ok={r.get('ok')}  mined={mined}  causes={causes}  err={str(err_msg)[:120]}")
    post_stone = 0
    for x in (-6, -5, -4):
        for y in (65, 66, 67):
            for z in (-1, 0, 1):
                if block_at(x, y, z) == "stone":
                    post_stone += 1
    print(f"  post stone count: {post_stone}  (delta={pre_stone - post_stone})")
    # Expect at least 6 mined in one call (was 1-3 before the fix).
    expected = (mined or 0) >= 6 and (pre_stone - post_stone) >= 6
    print(f"  → {'PASS' if expected else 'FAIL'}")
    return expected


def run_scenario_C(bot_url: str) -> bool:
    print("\n=== Scenario C: sealed shelter — hidden stone must stay intact ===")
    setup_C()
    hold_mode(bot_url)
    print(f"  pre: 0,65,0={block_at(0,65,0)}")
    r = collect_stone(bot_url, 1)
    data = r.get("data") or {}
    mined = data.get("mined_count")
    causes = data.get("causes") or {}
    err = r.get("error")
    err_msg = err if isinstance(err, str) else ((err or {}).get("message") if isinstance(err, dict) else "")
    print(f"  collect: ok={r.get('ok')}  mined={mined}  causes={causes}  err={str(err_msg)[:120]}")
    after = block_at(0, 65, 0)
    print(f"  post: 0,65,0={after}")
    expected = (mined in (None, 0)) and (after == "stone")
    print(f"  → {'PASS' if expected else 'FAIL'}")
    return expected


# ── Cleanup + entrypoint ─────────────────────────────────────────────

def cleanup() -> None:
    rcon_batch([
        f"execute in {WORLD} run fill -8 65 -8 8 70 8 minecraft:air",
        f"execute in {WORLD} run fill -8 64 -8 8 64 8 minecraft:grass_block",
        f"execute in {WORLD} run tp Flint 52 65 52",
        f"execute in {WORLD} run kill @e[type=item,distance=..40]",
    ])


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--bot-url", default=DEFAULT_BOT_URL)
    p.add_argument("--only", choices=["A", "B", "C", "D", "E"])
    args = p.parse_args()

    try:
        s = http_get(f"{args.bot_url}/status?lean=true", timeout=5)
        if not s.get("ok"):
            print(f"bot at {args.bot_url} not ready: {s}")
            return 2
    except Exception as e:
        print(f"can't reach bot at {args.bot_url}: {e}")
        return 2

    scenarios = []
    if args.only is None or args.only == "A":
        scenarios.append(("A", run_scenario_A))
    if args.only is None or args.only == "B":
        scenarios.append(("B", run_scenario_B))
    if args.only is None or args.only == "C":
        scenarios.append(("C", run_scenario_C))
    if args.only is None or args.only == "D":
        scenarios.append(("D", run_scenario_D))
    if args.only is None or args.only == "E":
        scenarios.append(("E", run_scenario_E))

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

    cleanup()
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(main())
