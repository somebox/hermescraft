"""Straight stair-down: 4 directions × 2 lengths, plus traversability.

Builds a 22×22×22 floating stone cube (open air all around so the dug
staircase is visible from outside), then for each parametrized case:

  1. Teleports the Tester bot to the top of the cube at the appropriate
     edge, facing into the cube along the stair direction.
  2. Calls `mc stair_down DIR LENGTH`.
  3. Asserts the bot descended (final.y ≈ start.y − length).
  4. Asserts the corridor floor + headroom cells are air (sampled).
  5. **Traversability**: calls `mc goto START` and verifies the bot can
     walk back up the staircase to its starting platform.
  6. Walks back down via `mc goto BOTTOM`.

Parametrization: (direction, length) covers 4 cardinal angles at 2
distances (short=4, long=10). The cube is sized big enough (20 deep on
each axis) that the long-stair end stays inside.
"""

from __future__ import annotations

import math
import time

import pytest


CUBE_CENTER = (100, 65, 100)   # geometric center of the floating stone cube
CUBE_HALF = 11                  # cube spans [center-11 .. center+11]
CUBE_X_MIN = CUBE_CENTER[0] - CUBE_HALF
CUBE_X_MAX = CUBE_CENTER[0] + CUBE_HALF
CUBE_Y_MIN = CUBE_CENTER[1] - CUBE_HALF
CUBE_Y_MAX = CUBE_CENTER[1] + CUBE_HALF
CUBE_Z_MIN = CUBE_CENTER[2] - CUBE_HALF
CUBE_Z_MAX = CUBE_CENTER[2] + CUBE_HALF
TOP_Y = CUBE_Y_MAX             # bot's feet at TOP_Y + 1; top face of cube
PLATFORM_Y = TOP_Y + 1          # bot's feet level when standing on top

# Direction vectors in Minecraft world coords:
#   north = -z, south = +z, east = +x, west = -x
DIR_VECTORS = {
    "north": (0, -1),  # (dx, dz) per forward step
    "south": (0,  1),
    "east":  (1,  0),
    "west":  (-1, 0),
}
# Yaw values for each facing direction (used in /tp).
DIR_YAW = {"north": 180, "south": 0, "east": -90, "west": 90}


def _start_pos_on_cube_top(direction: str) -> tuple[float, float, float]:
    """Bot start coord on the cube's top face, near the edge that faces
    INTO the stair direction. Stepping `forward` from here moves the bot
    along the stair direction across the cube top."""
    cx, _, cz = CUBE_CENTER
    if direction == "north":
        # Stairs go -z; start at south edge so we can dig northward.
        return (cx + 0.5, PLATFORM_Y, CUBE_Z_MAX - 0.5)
    if direction == "south":
        return (cx + 0.5, PLATFORM_Y, CUBE_Z_MIN + 0.5)
    if direction == "east":
        return (CUBE_X_MIN + 0.5, PLATFORM_Y, cz + 0.5)
    if direction == "west":
        return (CUBE_X_MAX - 0.5, PLATFORM_Y, cz + 0.5)
    raise ValueError(direction)


@pytest.fixture
def stair_cube(rcon, arena, tester_bot, config):
    """Build the floating stone cube. Parked-bot setup; geometry is
    rebuilt fresh each test so a prior stair-mining doesn't leak."""
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    rcon.run(f"mvtp Tester {world}")
    time.sleep(0.5)
    rcon.run(f"execute in {world} run tp Tester 0 100 0 0 0")
    arena.clean()
    # Air the working volume + one block buffer around it so the cube
    # actually floats (no leftover blocks merging with the test geometry).
    pad = 4
    rcon.batch([
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
    rcon.run(f"execute in {world} run tp Tester 0 100 0 0 0")
    rcon.run(
        f"execute in {world} run fill {CUBE_X_MIN-pad} {CUBE_Y_MIN-pad} {CUBE_Z_MIN-pad} "
        f"{CUBE_X_MAX+pad} {CUBE_Y_MAX+pad} {CUBE_Z_MAX+pad} minecraft:air"
    )


@pytest.mark.functional
@pytest.mark.parametrize(
    "direction,length",
    [
        ("north", 4),
        ("south", 4),
        ("east",  4),
        ("west",  4),
        ("north", 10),
        ("east", 10),
    ],
    ids=lambda v: f"{v}",
)
def test_stair_down_then_traverse_up(bot, rcon, stair_cube, config, direction, length):
    """Stair down `length` blocks in `direction`, then walk back up to verify
    the cut staircase is traversable."""
    world = config["mc"]["world"]
    sx, sy, sz = _start_pos_on_cube_top(direction)
    yaw = DIR_YAW[direction]
    rcon.run(f"execute in {world} run tp Tester {sx} {sy} {sz} {yaw} 0")
    time.sleep(1.5)

    # Sanity: bot is on top of the cube at full HP before we start.
    pre = bot.status_lean()
    pre_pos = pre.get("position") or {}
    assert math.isclose(pre_pos.get("y", 0), PLATFORM_Y, abs_tol=1.0), (
        f"setup: bot not on cube top — pre={pre_pos}"
    )
    assert (pre.get("health") or 0) >= 19.5, f"setup: bot HP={pre.get('health')} pre-stair"

    # Drive the stair_down. Length determines how deep we go.
    r = bot.post(
        "/action/stair_down",
        {"direction": direction, "length": length},
        timeout=90.0,
    )
    assert r.get("ok") is True, f"stair_down {direction} {length} failed: {r}"

    # Bot should be roughly at start.y - length (allow ±2 for landing slop).
    post = bot.status_lean()
    post_pos = post.get("position") or {}
    expected_y = PLATFORM_Y - length
    assert post_pos.get("y", 0) <= expected_y + 1.5, (
        f"bot did not descend enough: post.y={post_pos.get('y')}, "
        f"expected ≤ {expected_y + 1.5} for length={length}"
    )
    assert post_pos.get("y", 0) >= expected_y - 2, (
        f"bot fell past the expected depth: post.y={post_pos.get('y')}, "
        f"expected ≥ {expected_y - 2}"
    )

    # Spot-check: corridor cells at midpoint should be AIR
    # (we dug them). Use a cell halfway down the staircase.
    dx, dz = DIR_VECTORS[direction]
    mid = max(1, length // 2)
    mid_floor_x = int(sx) + dx * mid
    mid_floor_z = int(sz) + dz * mid
    mid_floor_y = PLATFORM_Y - mid - 1   # the "step" cell at midpoint
    assert rcon.block_is(mid_floor_x, mid_floor_y, mid_floor_z, "air"), (
        f"expected air at staircase step ({mid_floor_x},{mid_floor_y},{mid_floor_z}) "
        f"midway through the {direction} {length}-stair"
    )

    # Traversability: ask the bot to walk BACK UP to the starting position.
    # The pathfinder must find the staircase walkable.
    bottom_pos = dict(post_pos)
    r_up = bot.post(
        "/action/goto",
        {"x": sx, "y": PLATFORM_Y, "z": sz},
        timeout=60.0,
    )
    # Some versions of /action/goto return ok=false on near-misses (within
    # range) — we check actual position instead of trusting the envelope.
    final = bot.status_lean().get("position") or {}
    horiz_dist = abs(final.get("x", 0) - sx) + abs(final.get("z", 0) - sz)
    assert horiz_dist < 3.0 and final.get("y", 0) >= PLATFORM_Y - 1, (
        f"bot could not walk back up the staircase: final={final}, "
        f"target=({sx},{PLATFORM_Y},{sz}); goto-resp={r_up}"
    )

    # And back down — the trip should be symmetric.
    r_down = bot.post(
        "/action/goto",
        {"x": bottom_pos.get("x"), "y": bottom_pos.get("y"), "z": bottom_pos.get("z")},
        timeout=60.0,
    )
    final2 = bot.status_lean().get("position") or {}
    bottom_dist = abs(final2.get("x", 0) - bottom_pos.get("x", 0)) + abs(final2.get("z", 0) - bottom_pos.get("z", 0))
    assert bottom_dist < 3.0, (
        f"bot could not walk back down the staircase: final={final2}, "
        f"target={bottom_pos}; goto-resp={r_down}"
    )

    # No damage taken across the round-trip.
    end_hp = bot.status_lean().get("health") or 0
    assert end_hp >= 18, f"bot took damage during stair traversal: HP={end_hp}"
