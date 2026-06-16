"""Shelter egress: a bot inside the genesis shelter exits through its E/W door.

The genesis shelter (`scripts/genesis2_lib.shelter_setblock_commands`) renders an
EAST-facing door on the east wall; the bot exits EAST from inside — i.e. the door
faces the exit direction and the bot approaches from BEHIND it. This is the real
"cannot exit shelter, door" case that stalled genesis-v2 P1. E/W is the reliable,
spec-mandated door facing (see test_door_pathfind.py for the N/S limitation).
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import genesis2_lib as g2  # noqa: E402

ANCHOR = (0, 65, 0)  # ax, ay, az — shelter center


@pytest.fixture
def shelter(rcon, arena, config):
    world = config["mc"]["world"]
    ax, ay, az = ANCHOR
    rcon.run(f"execute in {world} run tp Tester {ax} {ay} {az} -90 0")
    arena.forceload((-1, -1, 1, 1))
    rcon.batch([
        f"execute in {world} run fill -16 60 -16 16 80 16 minecraft:air",
        f"execute in {world} run fill -16 60 -16 16 63 16 minecraft:stone",
        f"execute in {world} run fill -16 64 -16 16 64 16 minecraft:stone",
        "effect give Tester minecraft:resistance 600 4",
        "effect give Tester minecraft:saturation 600 1",
    ])
    rcon.batch(g2.shelter_setblock_commands(world, ax, ay, az))
    arena.settle_fast()
    yield
    rcon.run(f"execute in {world} run fill -16 60 -16 16 80 16 minecraft:air")
    arena.forceload_remove_all()


@pytest.mark.functional
@pytest.mark.parametrize("method", ["move", "through", "goto_near"])
def test_shelter_egress(bot, rcon, config, shelter, method):
    """Bot inside the shelter exits EAST through the door. PASS = bot past x=ax+3.5."""
    world = config["mc"]["world"]
    ax, ay, az = ANCHOR
    rcon.run(f"execute in {world} run tp Tester {ax} {ay} {az} -90 0")  # inside, facing east
    time.sleep(1.2)
    out = (ax + 6, ay, az)        # outside, east of the door
    door = (ax + 3, ay, az)       # east-wall door (lower half)
    if method == "through":
        r = bot.post("/action/through",
                     {"gx": door[0], "gy": door[1], "gz": door[2],
                      "dx": out[0], "dy": out[1], "dz": out[2]}, timeout=30)
    elif method == "move":
        r = bot.post("/action/move", {"x": out[0], "y": out[1], "z": out[2]}, timeout=30)
    else:
        r = bot.post("/action/goto_near",
                     {"x": out[0], "y": out[1], "z": out[2], "range": 1}, timeout=20)
    assert r.get("ok"), f"{method} egress not ok: {r}"
    assert bot.position().get("x", -99) > ax + 3.5, \
        f"bot did not clear the door east via {method}: {bot.position()}"
