"""Two-leg stair-down with a 90° turn between legs.

The bot needs cobblestone deep underground but the deposit isn't
directly below — it's offset diagonally. So the test stair-downs south
for 5 steps, faces east, then stair-downs another 5 steps. The combined
path is an L-shaped descent that the bot must be able to walk back up.

This is the *manual* recipe for what a future `mc stair_to X Y Z` would
automate — see test_stair_to_endpoint.py for the XFAIL spec.

Arena: same 22×22×22 floating stone cube as test_stair_straight.py
(coords shared via the stair_cube fixture in stairs/__init__.py would
be DRY but the imports are simpler if we duplicate the constants).
"""

from __future__ import annotations

import time

import pytest


# Centered on ORIGIN to match the older mining-test convention. The
# floating cube is 17×17×17 around (0, 65, 0) — visible from the same
# vantage as the other mining tests.
CUBE_CENTER = (0, 65, 0)
CUBE_HALF = 8
CUBE_X_MIN, CUBE_X_MAX = CUBE_CENTER[0] - CUBE_HALF, CUBE_CENTER[0] + CUBE_HALF
CUBE_Y_MIN, CUBE_Y_MAX = CUBE_CENTER[1] - CUBE_HALF, CUBE_CENTER[1] + CUBE_HALF
CUBE_Z_MIN, CUBE_Z_MAX = CUBE_CENTER[2] - CUBE_HALF, CUBE_CENTER[2] + CUBE_HALF
PLATFORM_Y = CUBE_Y_MAX + 1


@pytest.fixture
def stair_cube(rcon, arena, tester_bot, config):
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    rcon.run(f"mvtp Tester {world}")
    time.sleep(0.5)
    arena.rescue_tester(safe_xyz=(CUBE_CENTER[0], PLATFORM_Y + 2, CUBE_CENTER[2]), bot=tester_bot)
    arena.clean()
    pad = 4
    rcon.batch([
        f"execute in {world} run forceload add {CUBE_X_MIN-pad} {CUBE_Z_MIN-pad} {CUBE_X_MAX+pad} {CUBE_Z_MAX+pad}",
        f"execute in {world} run fill {CUBE_X_MIN-pad} {CUBE_Y_MIN-pad} {CUBE_Z_MIN-pad} "
        f"{CUBE_X_MAX+pad} {CUBE_Y_MAX+pad} {CUBE_Z_MAX+pad} minecraft:air",
        f"execute in {world} run fill {CUBE_X_MIN} {CUBE_Y_MIN} {CUBE_Z_MIN} "
        f"{CUBE_X_MAX} {CUBE_Y_MAX} {CUBE_Z_MAX} minecraft:stone",
        "clear Tester",
        "give Tester minecraft:stone_pickaxe",
        "effect clear Tester",
        "effect give Tester minecraft:saturation 600 1",
    ])
    arena.settle(seconds=1.5)
    yield
    rcon.batch([
        "gamemode creative Tester",
        f"execute in {world} run tp Tester 0 100 0 0 0",
        f"execute in {world} run fill {CUBE_X_MIN-pad} {CUBE_Y_MIN-pad} {CUBE_Z_MIN-pad} "
        f"{CUBE_X_MAX+pad} {CUBE_Y_MAX+pad} {CUBE_Z_MAX+pad} minecraft:air",
        f"execute in {world} run forceload remove {CUBE_X_MIN-pad} {CUBE_Z_MIN-pad} {CUBE_X_MAX+pad} {CUBE_Z_MAX+pad}",
    ])


@pytest.mark.functional
@pytest.mark.xfail(
    reason="Stair-with-90-turn traversal fails on mineflayer 4.35.0/4.37.1 — "
    "bot doesn't reliably walk back up the L-shaped dug staircase. Task #32. "
    "Pre-existing, not an upgrade regression.",
    strict=False,
)
def test_stair_south_then_east_with_traversal(bot, rcon, arena, stair_cube, config):
    """Stair south 5, turn, stair east 5, then traverse the L back up."""
    world = config["mc"]["world"]
    # Start at the north-west corner of the cube top: south leg goes
    # -z…wait, "south" in MC is +z. Start at the NORTH edge so we can
    # go SOUTH (+z) across the cube top.
    start_x = CUBE_X_MIN + 2.5
    start_z = CUBE_Z_MIN + 0.5
    rcon.batch([
        "gamemode survival Tester",
        f"execute in {world} run tp Tester {start_x} {PLATFORM_Y} {start_z} 0 0",
        "effect give Tester minecraft:instant_health 1 5",
    ])
    time.sleep(1.5)

    # Pre-test conditions: survival, on the platform top, full HP.
    arena.verify_tester_ready(
        bot,
        expected_xz=(start_x, start_z),
        expected_y_at_least=PLATFORM_Y - 1.0,
        min_hp=19.5,
        xz_tol=1.5,
    )

    # Leg 1: south, length 5.
    r1 = bot.post("/action/stair_down", {"direction": "south", "length": 5}, timeout=60.0)
    assert r1.get("ok") is True, f"leg 1 (south 5) failed: {r1}"
    after_leg1 = bot.status_lean().get("position") or {}
    assert after_leg1.get("y", 0) <= PLATFORM_Y - 4, (
        f"leg 1 didn't descend enough: post.y={after_leg1.get('y')}"
    )
    turn_corner = (after_leg1.get("x"), after_leg1.get("y"), after_leg1.get("z"))

    # Leg 2: east, length 5. The primitive picks up from the bot's
    # current position by default.
    r2 = bot.post("/action/stair_down", {"direction": "east", "length": 5}, timeout=60.0)
    assert r2.get("ok") is True, f"leg 2 (east 5) failed: {r2}"
    after_leg2 = bot.status_lean().get("position") or {}
    assert after_leg2.get("y", 0) <= turn_corner[1] - 4, (
        f"leg 2 didn't descend enough: post.y={after_leg2.get('y')}"
    )
    bottom = dict(after_leg2)

    # Traversability: walk back up to the surface in two hops.
    # Hop 1: bottom → corner.
    bot.post(
        "/action/goto",
        {"x": turn_corner[0], "y": turn_corner[1], "z": turn_corner[2]},
        timeout=90.0,
    )
    mid = bot.status_lean().get("position") or {}
    corner_dist = (
        abs(mid.get("x", 0) - turn_corner[0])
        + abs(mid.get("z", 0) - turn_corner[2])
    )
    assert corner_dist < 3.0 and mid.get("y", 0) >= turn_corner[1] - 1, (
        f"bot could not return to turn corner: mid={mid}, target={turn_corner}"
    )

    # Hop 2: corner → start (top of staircase).
    bot.post(
        "/action/goto",
        {"x": start_x, "y": PLATFORM_Y, "z": start_z},
        timeout=90.0,
    )
    final = bot.status_lean().get("position") or {}
    top_dist = abs(final.get("x", 0) - start_x) + abs(final.get("z", 0) - start_z)
    assert top_dist < 3.0 and final.get("y", 0) >= PLATFORM_Y - 1, (
        f"bot could not reach top of L-staircase: final={final}, target=({start_x},{PLATFORM_Y},{start_z})"
    )

    # And back down to bottom — full round-trip works.
    bot.post(
        "/action/goto",
        {"x": bottom["x"], "y": bottom["y"], "z": bottom["z"]},
        timeout=90.0,
    )
    end = bot.status_lean()
    end_pos = end.get("position") or {}
    bottom_dist = abs(end_pos.get("x", 0) - bottom["x"]) + abs(end_pos.get("z", 0) - bottom["z"])
    assert bottom_dist < 3.0, f"bot could not return to bottom: end={end_pos}, target={bottom}"
    assert (end.get("health") or 0) >= 18, f"bot took damage on round-trip: HP={end.get('health')}"
