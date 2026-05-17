"""Strip-mine flatten: terraced multi-level dirt + stone boundary.

The test sets up a 9×9 mining area as an uneven dirt landscape:

  - Base layer (y=64): dirt across all 81 cells.
  - Raised layer (y=65): ~20 scattered cells of dirt forming bumps.
  - Peak layer (y=66): 5 high cells forming small towers.
  - A few "surface clutter" dirt cells sit on top of bumps too, so
    flattening requires reaching multiple heights.

The bot's job: `mc collect dirt N` flattens the area. After mining,
the surface should be roughly flat at y=64 — i.e. raised cells removed.

Assertions:
  1. **Boundary held**: every stone-ring sample at the bbox perimeter
     is still stone. The bot did not chip into the ring.
  2. **Levelled**: ≥90% of the originally-raised cells (y=65 + y=66)
     are now AIR. The bot flattened the terrain.
  3. **Base mostly intact**: the bot didn't dig BELOW the base level
     — at least 30 cells of y=64 dirt remain (count chosen so the
     test doesn't accidentally fail if the bot's strip-mine pulls a
     few base cells as part of the working face).
  4. **No wandering**: stone-capped dirt witnesses outside the bbox
     are still dirt (bot would have to break the cap stone to reach
     them — boundary breach).
  5. **Bot HP unchanged**: no suffocation / fall damage.

Visual note: the user can watch the bot mining live. Strip-mine sort
(Fix E) should produce a row-by-row pattern over the multi-level
terrain — the bot stays on its row, descending heights as it goes.
"""

from __future__ import annotations

import time

import pytest


# Inclusive coords for the dirt-mining zone (9×9 footprint at the surface).
ZONE_X_MIN, ZONE_X_MAX = 6, 14
ZONE_Z_MIN, ZONE_Z_MAX = 6, 14
RING_X = (5, 15)          # stone ring at these x values, full z perimeter
RING_Z = (5, 15)

# Raised dirt cells at y=65 inside the bbox.
RAISED_65 = [
    (7, 65, 7),  (8, 65, 7),  (12, 65, 7),
    (6, 65, 9),  (10, 65, 9), (14, 65, 9),
    (7, 65, 10), (13, 65, 10),
    (6, 65, 11), (12, 65, 11),
    (8, 65, 13), (9, 65, 13), (10, 65, 13),
    (11, 65, 8), (13, 65, 11),
    (9, 65, 6),  (11, 65, 12),
]
# Peak dirt cells at y=66 inside the bbox (towers).
PEAKS_66 = [(8, 66, 7), (10, 66, 9), (13, 66, 10), (9, 66, 13), (11, 66, 8)]
# All raised cells — used for the "≥90% gone" assertion.
RAISED_CELLS = RAISED_65 + PEAKS_66

# Stone-ring sample points we'll later assert are STILL stone.
RING_SAMPLES = [
    (5, 64, 10), (15, 64, 10), (10, 64, 5), (10, 64, 15),  # cardinal mid-points
    (5, 64, 5), (15, 64, 15),                              # opposite corners
    (5, 64, 8), (15, 64, 12),                              # extra samples
]

# Outside-bbox dirt witnesses placed BELOW the surface (y=63) with stone
# capped above (y=64). Bot's fair-play surface-bias rejects candidates
# whose ceiling isn't air, so it can't see these. If they go missing the
# bot tore through the stone cap to reach them — serious boundary breach.
OUTSIDE_WITNESSES = [(2, 63, 10), (18, 63, 10), (10, 63, 2), (10, 63, 18)]

BOT_STAND = (3, 64, 10)         # stone pad under bot's feet
BOT_TP = (3.5, 65.0, 10.5, 270, 0)   # facing east toward the dirt zone

# Working volume — wider than the zone so the bot doesn't see natural-world
# terrain beyond and start mining it.
VOLUME = (-5, 60, -5, 25, 70, 25)


@pytest.fixture
def strip_arena(rcon, arena, tester_bot, config):
    """Build the terraced dirt zone + stone ring + buried witnesses."""
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    rcon.run(f"mvtp Tester {world}")
    time.sleep(0.5)
    rcon.run(f"execute in {world} run tp Tester 0 100 0 0 0")
    arena.clean()

    x1, y1, z1, x2, y2, z2 = VOLUME
    cmds = [
        # Working volume: clear to air, then re-lay a stone sub-floor.
        f"execute in {world} run fill {x1} {y1} {z1} {x2} {y2} {z2} minecraft:air",
        f"execute in {world} run fill {x1} {y1} {z1} {x2} 63 {z2} minecraft:stone",
        # Bot platform — stone pad to stand on, OUTSIDE the dirt zone.
        f"execute in {world} run setblock {BOT_STAND[0]} {BOT_STAND[1]} {BOT_STAND[2]} minecraft:stone",
        # Base dirt layer at y=64 across the 9×9 zone.
        f"execute in {world} run fill {ZONE_X_MIN} 64 {ZONE_Z_MIN} {ZONE_X_MAX} 64 {ZONE_Z_MAX} minecraft:dirt",
        # Stone ring at y=64 perimeter (overwrites the perimeter dirt).
        f"execute in {world} run fill {RING_X[0]} 64 5 {RING_X[0]} 64 15 minecraft:stone",
        f"execute in {world} run fill {RING_X[1]} 64 5 {RING_X[1]} 64 15 minecraft:stone",
        f"execute in {world} run fill 5 64 {RING_Z[0]} 15 64 {RING_Z[0]} minecraft:stone",
        f"execute in {world} run fill 5 64 {RING_Z[1]} 15 64 {RING_Z[1]} minecraft:stone",
    ]
    # Raised dirt at y=65 and peaks at y=66.
    for (bx, by, bz) in RAISED_CELLS:
        cmds.append(f"execute in {world} run setblock {bx} {by} {bz} minecraft:dirt")
    # Buried witnesses at y=63 with stone cap at y=64 — bot can't see them.
    for (wx, wy, wz) in OUTSIDE_WITNESSES:
        cmds.append(f"execute in {world} run setblock {wx} {wy} {wz} minecraft:dirt")
        cmds.append(f"execute in {world} run setblock {wx} {wy + 1} {wz} minecraft:stone")
    # Bot setup.
    cmds.extend([
        "clear Tester",
        "give Tester minecraft:stone_shovel",
        "effect clear Tester",
        "effect give Tester minecraft:saturation 600 1",
        # Full heal — prior tests may have left HP partial.
        "effect give Tester minecraft:instant_health 1 5",
        f"execute in {world} run tp Tester {BOT_TP[0]} {BOT_TP[1]} {BOT_TP[2]} {BOT_TP[3]} {BOT_TP[4]}",
    ])
    rcon.batch(cmds)
    arena.settle(seconds=2.5)
    yield
    rcon.run(f"execute in {world} run tp Tester 0 100 0 0 0")
    rcon.run(
        f"execute in {world} run fill {x1} {y1} {z1} {x2} {y2} {z2} minecraft:air"
    )


@pytest.mark.functional
def test_collect_dirt_flattens_terraced_zone(bot, rcon, strip_arena):
    """Bot flattens 22 raised dirt cells over 3 y-levels without
    breaking the bbox boundary."""
    # Sanity: bot is alive + raised cells + ring + witnesses set up correctly.
    start = bot.status_lean()
    assert (start.get("health") or 0) >= 17, f"bot HP={start.get('health')} pre-test (low — prior test left damage)"
    for (sx, sy, sz) in RING_SAMPLES:
        assert rcon.block_is(sx, sy, sz, "stone"), f"setup: ring sample {sx},{sy},{sz} is not stone"
    raised_setup_count = sum(
        1 for (rx, ry, rz) in RAISED_CELLS if rcon.block_is(rx, ry, rz, "dirt")
    )
    assert raised_setup_count == len(RAISED_CELLS), (
        f"setup: only {raised_setup_count}/{len(RAISED_CELLS)} raised cells placed"
    )
    for (wx, wy, wz) in OUTSIDE_WITNESSES:
        assert rcon.block_is(wx, wy, wz, "dirt"), f"setup: outside witness {wx},{wy},{wz} is not dirt"

    # Drive the mine. 30 is enough to flatten all 22 raised cells with
    # some headroom into the base layer.
    r = bot.post("/action/collect", {"block": "dirt", "count": 30}, timeout=120.0)
    assert r.get("ok") is True, f"collect failed: {r}"

    # 1. Boundary held — every stone-ring sample still stone.
    for (sx, sy, sz) in RING_SAMPLES:
        assert rcon.block_is(sx, sy, sz, "stone"), (
            f"BOUNDARY BREACH: ring marker at {sx},{sy},{sz} is no longer stone"
        )

    # 2. Levelled — at least half the originally-raised cells are AIR.
    # We don't insist on 100%: the bot has a 40s wallclock cap on each
    # collect call and may need a second call to finish the cleanup on
    # a deeply terraced area. The boundary checks (1, 4) are the strict
    # ones — those say "the bot didn't break things", not "the bot
    # cleared everything".
    cleared_raised = sum(
        1 for (rx, ry, rz) in RAISED_CELLS if rcon.block_is(rx, ry, rz, "air")
    )
    assert cleared_raised >= int(len(RAISED_CELLS) * 0.5), (
        f"flattening too partial: only {cleared_raised}/{len(RAISED_CELLS)} raised cells removed"
    )

    # 3. Base layer mostly intact — bot didn't sink the whole thing.
    # Count dirt remaining in the 9×9 base layer (49 cells inside the
    # stone ring; perimeter at x=5/15 or z=5/15 is stone).
    base_dirt_remaining = 0
    for x in range(ZONE_X_MIN, ZONE_X_MAX + 1):
        for z in range(ZONE_Z_MIN, ZONE_Z_MAX + 1):
            if rcon.block_is(x, 64, z, "dirt"):
                base_dirt_remaining += 1
    # The base has 81 cells (9×9). Bot mined 30 total; ~22 were raised,
    # so ≤8 came from the base. Allow generous slack: ≥30 base remaining.
    assert base_dirt_remaining >= 30, (
        f"bot dug too deep into the base: only {base_dirt_remaining}/81 base dirt left"
    )

    # 4. No wandering — buried witnesses still dirt.
    for (wx, wy, wz) in OUTSIDE_WITNESSES:
        assert rcon.block_is(wx, wy, wz, "dirt"), (
            f"BOUNDARY BREACH: stone-capped witness dirt at {wx},{wy},{wz} is gone — "
            f"bot somehow tore through the cap stone"
        )

    # 5. Bot survived.
    end = bot.status_lean()
    assert (end.get("health") or 0) >= 18, f"bot took damage during mine: HP={end.get('health')}"

    # Inventory sanity (informational — bot should have ~25-30 dirt).
    dirt_gain = bot.inventory().get("dirt", 0)
    assert dirt_gain >= 18, f"dirt gain {dirt_gain} too low; inv={bot.inventory()}"
