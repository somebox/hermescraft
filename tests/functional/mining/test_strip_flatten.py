"""Strip-mine flatten: bbox-bounded dirt patch with stone boundary markers.

Drives `mc collect dirt N` against a 9×9 dirt patch ringed in stone
markers, with outside-the-bbox dirt witnesses placed beyond the ring.
The test asserts:

  1. Bot mined inside the bbox  — dirt inventory gain ≥ 16
  2. Bot did NOT mine the stone ring — every ring block still stone
  3. Bot did NOT mine outside the bbox — every outside-witness dirt
     cell still dirt
  4. Bot's HP unchanged — no suffocation/fall damage during mining

This exercises Fix E (strip-mine sort) live: the bot should
march along the densest axis and stay inside the dirt zone instead
of star-pattern-hopping into the ring.

Arena layout (top view at y=64):

        x= 2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18
   z= 2  -  -  -  -  -  -  -  -  D  -  -  -  -  -  -  -  -
   z= 3  -  S  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -    S = bot platform
   z= 4  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -    R = stone ring marker
   z= 5  -  -  -  R  R  R  R  R  R  R  R  R  R  R  -  -  -    D = outside-bbox dirt witness
   z= 6  -  -  -  R  d  d  d  d  d  d  d  d  d  R  -  -  -    d = dirt (mined target)
   z= 7  -  -  -  R  d  d  d  d  d  d  d  d  d  R  -  -  -
   z= 8  -  -  -  R  d  d  d  d  d  d  d  d  d  R  -  -  -
   z= 9  -  -  -  R  d  d  d  d  d  d  d  d  d  R  -  -  -
   z=10  -  -  D  R  d  d  d  d  d  d  d  d  d  R  D  -  -
   z=11  -  -  -  R  d  d  d  d  d  d  d  d  d  R  -  -  -
   z=12  -  -  -  R  d  d  d  d  d  d  d  d  d  R  -  -  -
   z=13  -  -  -  R  d  d  d  d  d  d  d  d  d  R  -  -  -
   z=14  -  -  -  R  d  d  d  d  d  d  d  d  d  R  -  -  -
   z=15  -  -  -  R  R  R  R  R  R  R  R  R  R  R  -  -  -
   z=16  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -
   z=17  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -  -
   z=18  -  -  -  -  -  -  -  -  D  -  -  -  -  -  -  -  -

  Plus dirt "bumps" at y=65 on 5 selected cells inside the dirt zone:
    (8,65,8), (12,65,12), (8,65,12), (12,65,8), (10,65,7).

  Sub-floor: stone at y=60..63 spans x∈[0,20], z∈[0,20] so the bot
  can't fall through if the floor gets thinned.
"""

from __future__ import annotations

import time

import pytest

ZONE_X_MIN, ZONE_X_MAX = 6, 14   # inclusive — 9×9 dirt patch
ZONE_Z_MIN, ZONE_Z_MAX = 6, 14
RING_X = (5, 15)                 # stone ring at these x values, full z perimeter
RING_Z = (5, 15)
BUMPS = [(8, 65, 8), (12, 65, 12), (8, 65, 12), (12, 65, 8), (10, 65, 7)]
OUTSIDE_DIRT_WITNESSES = [(2, 64, 10), (18, 64, 10), (10, 64, 2), (10, 64, 18)]
# Stone-ring sample points we'll later assert are STILL stone.
RING_SAMPLES = [
    (5, 64, 10), (15, 64, 10), (10, 64, 5), (10, 64, 15),  # cardinal mid-points
    (5, 64, 5), (15, 64, 15),                              # opposite corners
]
BOT_STAND = (3, 64, 10)          # stone block under bot's feet
BOT_TP = (3.5, 65.0, 10.5, 270, 0)   # facing east toward the dirt zone


@pytest.fixture
def strip_arena(rcon, arena, tester_bot, config):
    """Build the bbox-bounded dirt zone + stone ring + outside witnesses.

    Order matters: clean → air-fill working volume → solid sub-floor →
    bot platform → dirt zone → stone ring (overwrites zone cells on the
    perimeter) → bumps → outside witnesses → tp bot."""
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    rcon.run(f"mvtp Tester {world}")
    time.sleep(0.5)
    # Park bot high while we tear down + rebuild.
    rcon.run(f"execute in {world} run tp Tester 0 100 0 0 0")
    arena.clean()

    cmds = [
        # Working volume: air everywhere we'll touch.
        f"execute in {world} run fill 0 60 0 20 70 20 minecraft:air",
        # Solid sub-floor so the bot can't fall through any thinned cells.
        f"execute in {world} run fill 0 60 0 20 63 20 minecraft:stone",
        # Bot platform — a stone pad under the bot's feet so it doesn't
        # stand on dirt and end up "in" the area-of-interest.
        f"execute in {world} run setblock {BOT_STAND[0]} {BOT_STAND[1]} {BOT_STAND[2]} minecraft:stone",
        # Dirt zone: 9×9 dirt slab at y=64.
        f"execute in {world} run fill {ZONE_X_MIN} 64 {ZONE_Z_MIN} {ZONE_X_MAX} 64 {ZONE_Z_MAX} minecraft:dirt",
        # Stone ring: 4 sides of stone at y=64 (overwrites dirt on the
        # perimeter to make a clear boundary).
        f"execute in {world} run fill {RING_X[0]} 64 5 {RING_X[0]} 64 15 minecraft:stone",   # west wall
        f"execute in {world} run fill {RING_X[1]} 64 5 {RING_X[1]} 64 15 minecraft:stone",   # east wall
        f"execute in {world} run fill 5 64 {RING_Z[0]} 15 64 {RING_Z[0]} minecraft:stone",   # north wall
        f"execute in {world} run fill 5 64 {RING_Z[1]} 15 64 {RING_Z[1]} minecraft:stone",   # south wall
    ]
    # Dirt bumps (raised cells at y=65).
    for (bx, by, bz) in BUMPS:
        cmds.append(f"execute in {world} run setblock {bx} {by} {bz} minecraft:dirt")
    # Outside-bbox dirt witnesses.
    for (wx, wy, wz) in OUTSIDE_DIRT_WITNESSES:
        cmds.append(f"execute in {world} run setblock {wx} {wy} {wz} minecraft:dirt")
    # Bot setup: clear inventory, give shovel + saturation, tp into position.
    cmds.extend([
        "clear Tester",
        "give Tester minecraft:stone_shovel",
        "effect clear Tester",
        "effect give Tester minecraft:saturation 600 1",
        f"execute in {world} run tp Tester {BOT_TP[0]} {BOT_TP[1]} {BOT_TP[2]} {BOT_TP[3]} {BOT_TP[4]}",
    ])
    rcon.batch(cmds)
    arena.settle(seconds=2.0)
    yield
    # Cleanup: park bot, air-fill the working volume so the next test
    # starts on a clean slate.
    rcon.run(f"execute in {world} run tp Tester 0 100 0 0 0")
    rcon.run(f"execute in {world} run fill 0 60 0 20 70 20 minecraft:air")


@pytest.mark.functional
def test_collect_dirt_stays_inside_bbox(bot, rcon, strip_arena):
    """Mine 24 dirt with a stone shovel; verify bbox boundary held."""
    # Sanity: bot is alive + at full HP and the boundary is intact before
    # we start. A test bug in arena setup would otherwise look like a
    # bot regression.
    start = bot.status_lean()
    assert (start.get("health") or 0) >= 19.5, f"bot HP={start.get('health')} pre-test"
    for (sx, sy, sz) in RING_SAMPLES:
        assert rcon.block_is(sx, sy, sz, "stone"), f"setup: ring sample {sx},{sy},{sz} is not stone"
    for (wx, wy, wz) in OUTSIDE_DIRT_WITNESSES:
        assert rcon.block_is(wx, wy, wz, "dirt"), f"setup: outside witness {wx},{wy},{wz} is not dirt"

    # Drive the mine.
    r = bot.post("/action/collect", {"block": "dirt", "count": 24}, timeout=60.0)
    assert r.get("ok") is True, f"collect failed: {r}"

    # 1. Mined enough dirt to be useful (allow some slack for pickup race).
    inv = bot.inventory()
    dirt_gain = inv.get("dirt", 0)
    assert dirt_gain >= 16, f"dirt gain {dirt_gain} too low (target ≥16); inv={inv}"

    # 2. Stone ring intact — every sample point still stone.
    for (sx, sy, sz) in RING_SAMPLES:
        assert rcon.block_is(sx, sy, sz, "stone"), (
            f"BOUNDARY BREACH: ring marker at {sx},{sy},{sz} is no longer stone"
        )

    # 3. Outside witnesses untouched — every witness cell still dirt.
    for (wx, wy, wz) in OUTSIDE_DIRT_WITNESSES:
        assert rcon.block_is(wx, wy, wz, "dirt"), (
            f"BOUNDARY BREACH: outside-witness dirt at {wx},{wy},{wz} is gone"
        )

    # 4. Bot survived the mine (no suffocation, no fall damage).
    end = bot.status_lean()
    assert (end.get("health") or 0) >= 18, f"bot took damage during mine: HP={end.get('health')}"
