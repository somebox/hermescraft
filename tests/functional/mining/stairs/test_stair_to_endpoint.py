"""XFAIL: `mc stair_to X Y Z` doesn't exist yet — this test documents
the spec a future primitive should satisfy.

What we want: a single call that picks the direction(s), turns when
needed, and digs an L- or Z-shaped staircase from the bot's current
position to a specified endpoint coord. Today, the bot or its operator
has to chain `mc stair_down DIR LENGTH` calls manually (see
test_stair_with_turn.py for the manual recipe).

This file is intentionally a single XFAIL test against a stub endpoint
`/action/stair_to`. When that endpoint lands and the assertions pass,
flip the xfail to a regular pass.

Suggested signature (for the future implementation):

    POST /action/stair_to
    body: { "x": int, "y": int, "z": int }
    returns: ok envelope; on failure, MIXED reason with mc.dig-style causes.

Behavior contract:
  - Pathfind from bot to (x,y,z) using descending stairs only (one
    down per forward step).
  - Auto-turn at most TWICE — i.e. up to a Z-shape (three legs). More
    than that probably means the endpoint isn't reachable without a
    proper pathfinder, return MIXED with a "use mc goto for surface
    travel" hint.
  - Refuses if the endpoint is HIGHER than the bot (use stair_up).
  - Refuses near lava/water (HAZARD_LAVA / HAZARD_WATER hints from
    mc safe_dig).
  - Returns the corner coords in data.turn_points so callers can walk
    the path back up.
"""

from __future__ import annotations

import time

import pytest


CUBE_CENTER = (100, 65, 100)
CUBE_HALF = 11
PLATFORM_Y = CUBE_CENTER[1] + CUBE_HALF + 1


@pytest.fixture
def stair_cube(rcon, arena, tester_bot, config):
    world = config["mc"]["world"]
    cx, cy, cz = CUBE_CENTER
    x1, x2 = cx - CUBE_HALF, cx + CUBE_HALF
    y1, y2 = cy - CUBE_HALF, cy + CUBE_HALF
    z1, z2 = cz - CUBE_HALF, cz + CUBE_HALF
    tester_bot.wait_until_ready(timeout=10)
    rcon.run(f"mvtp Tester {world}")
    time.sleep(0.5)
    rcon.run(f"execute in {world} run tp Tester 0 100 0 0 0")
    arena.clean()
    pad = 4
    rcon.batch([
        f"execute in {world} run fill {x1-pad} {y1-pad} {z1-pad} {x2+pad} {y2+pad} {z2+pad} minecraft:air",
        f"execute in {world} run fill {x1} {y1} {z1} {x2} {y2} {z2} minecraft:stone",
        "clear Tester",
        "give Tester minecraft:stone_pickaxe",
        "effect clear Tester",
        "effect give Tester minecraft:saturation 600 1",
    ])
    arena.settle(seconds=1.5)
    yield
    rcon.run(f"execute in {world} run tp Tester 0 100 0 0 0")
    rcon.run(f"execute in {world} run fill {x1-pad} {y1-pad} {z1-pad} {x2+pad} {y2+pad} {z2+pad} minecraft:air")


@pytest.mark.functional
@pytest.mark.xfail(reason="mc stair_to <coords> primitive not yet implemented (spec only)", strict=False)
def test_stair_to_endpoint_with_auto_turn(bot, rcon, stair_cube, config):
    """Endpoint is 5 south + 5 east + 6 down from start; expect the bot
    to dig an L-shaped descent that lands within ~1 block of the endpoint."""
    world = config["mc"]["world"]
    start_x = CUBE_CENTER[0] - CUBE_HALF + 2.5
    start_z = CUBE_CENTER[2] - CUBE_HALF + 0.5
    rcon.run(f"execute in {world} run tp Tester {start_x} {PLATFORM_Y} {start_z} 0 0")
    time.sleep(1.5)

    end_x = int(start_x) + 5
    end_y = int(PLATFORM_Y) - 6
    end_z = int(start_z) + 5

    r = bot.post("/action/stair_to", {"x": end_x, "y": end_y, "z": end_z}, timeout=120.0)
    assert r.get("ok") is True, f"stair_to failed (or endpoint doesn't exist yet): {r}"

    pos = bot.status_lean().get("position") or {}
    dist = abs(pos.get("x", 0) - end_x) + abs(pos.get("y", 0) - end_y) + abs(pos.get("z", 0) - end_z)
    assert dist <= 2.0, f"bot ended too far from endpoint: pos={pos}, target=({end_x},{end_y},{end_z})"

    # If the spec lands, data.turn_points should list the corner cells.
    data = r.get("data") or {}
    assert isinstance(data.get("turn_points"), list), f"expected data.turn_points list: {data}"
