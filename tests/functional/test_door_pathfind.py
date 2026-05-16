"""Door pathfind matrix: open/closed × hinge × travel direction.

Migrated from scripts/test-door-pathfind.py with pytest.mark.xfail
conversion for the known flaky N/S closed-door scenarios.

Builds a sealed obsidian box (5×5, 2-tall walls) with a single
oak_door on the wall facing the bot's travel direction. Bot starts
outside, target is inside the box. The only route is through the door.

Per-scenario expectations:
  - F69 (open door, any hinge):  pathfinder walks straight through.
  - F66+F69 (closed door):       pathfinder opens via useOne + walks.

Known framework limitation (xfail'd): mineflayer-pathfinder's
"open the door and walk through" sequence is reliable for E/W-facing
doors but FLAKY for N/S closed cases. Across consecutive suite runs,
the 4 N/S closed scenarios fail at least once; one to three pass on
any given run, the rest stall ~5-6s with door_now=open but bot still
on the outer side. Race between the door-open action and the path
re-evaluation. Investigation deferred.
"""

from __future__ import annotations

import time

import pytest


WORLD_GEOMETRY = {
    "west": {
        "door": (3, 0),
        "bot_start": (-3, 0),
        "target": (5, 0),
        "walls": {
            "west":  (3, -2, 3,  2),
            "east":  (7, -2, 7,  2),
            "north": (3, -2, 7, -2),
            "south": (3,  2, 7,  2),
        },
    },
    "east": {
        "door": (7, 0),
        "bot_start": (13, 0),
        "target": (5, 0),
        "walls": {
            "west":  (3, -2, 3,  2),
            "east":  (7, -2, 7,  2),
            "north": (3, -2, 7, -2),
            "south": (3,  2, 7,  2),
        },
    },
    "north": {
        "door": (5, -2),
        "bot_start": (5, -8),
        "target": (5, 0),
        "walls": {
            "west":  (3, -2, 3,  2),
            "east":  (7, -2, 7,  2),
            "north": (3, -2, 7, -2),
            "south": (3,  2, 7,  2),
        },
    },
    "south": {
        "door": (5, 2),
        "bot_start": (5, 8),
        "target": (5, 0),
        "walls": {
            "west":  (3, -2, 3,  2),
            "east":  (7, -2, 7,  2),
            "north": (3, -2, 7, -2),
            "south": (3,  2, 7,  2),
        },
    },
}


def _build_box(rcon, world: str, direction: str, door_facing: str, hinge: str, door_open: bool) -> None:
    """Construct sealed obsidian box; the wall in `direction` has a 1-cell
    gap at the door coord, filled with the configured oak_door."""
    geo = WORLD_GEOMETRY[direction]
    dx, dz = geo["door"]
    cmds = []
    for _name, (x1, z1, x2, z2) in geo["walls"].items():
        cmds.append(f"execute in {world} run fill {x1} 65 {z1} {x2} 66 {z2} minecraft:obsidian")
    cmds.append(f"execute in {world} run setblock {dx} 65 {dz} minecraft:air")
    cmds.append(f"execute in {world} run setblock {dx} 66 {dz} minecraft:air")
    open_str = "true" if door_open else "false"
    cmds.append(
        f"execute in {world} run setblock {dx} 65 {dz} "
        f"minecraft:oak_door[half=lower,facing={door_facing},open={open_str},hinge={hinge}]"
    )
    cmds.append(
        f"execute in {world} run setblock {dx} 66 {dz} "
        f"minecraft:oak_door[half=upper,facing={door_facing},open={open_str},hinge={hinge}]"
    )
    bx, bz = geo["bot_start"]
    cmds.append(f"execute in {world} run tp Tester {bx} 65 {bz} 0 0")
    rcon.batch(cmds)
    time.sleep(1.5)


def _in_box(pos: dict) -> bool:
    return 3 < pos.get("x", -99) < 7.5 and -2 < pos.get("z", -99) < 2 and pos.get("y", 0) >= 65


# Parametrize: each row is (direction, door_facing, hinge, start_open).
# The four N/S closed-door scenarios get xfail markers because of the
# mineflayer-pathfinder race documented above.
_KNOWN_NS_CLOSED_FLAKY_REASON = (
    "mineflayer-pathfinder N/S closed-door race: door opens but path "
    "re-eval lags; bot stalls outside. Investigation deferred. See "
    "docs/test-inventory.md."
)


@pytest.fixture
def door_arena(rcon, arena, tester_bot, config):
    """Reset arena: forceload + packed sub-floor (y=60..63 stone) + grass
    cap at y=64 — actually we use stone floor + air above. The packed
    sub-floor is the load-bearing fix: without it, prior tests' lava /
    voids at y<64 chunk through and kill the bot mid-pathfind."""
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    rcon.run(f"execute in {world} run tp Tester 0 100 0 0 0")
    arena.clean()
    arena.forceload((-1, -1, 1, 1))
    rcon.batch([
        f"execute in {world} run fill -16 60 -16 16 80 16 minecraft:air",
        f"execute in {world} run fill -16 60 -16 16 63 16 minecraft:stone",
        f"execute in {world} run fill -16 64 -16 16 64 16 minecraft:stone",
        "effect give Tester minecraft:resistance 600 4",
        "effect give Tester minecraft:saturation 600 1",
    ])
    arena.settle(seconds=0.5)
    yield
    rcon.run(f"execute in {world} run tp Tester 0 100 0 0 0")
    rcon.run(f"execute in {world} run fill -16 60 -16 16 80 16 minecraft:air")
    arena.forceload_remove_all()


@pytest.mark.functional
@pytest.mark.parametrize(
    "direction,door_facing,hinge,start_open",
    [
        ("west",  "west",  "left",  False),
        ("west",  "west",  "right", False),
        ("west",  "west",  "left",  True),   # F69 regression: open door
        ("west",  "west",  "right", True),
        ("east",  "east",  "left",  False),
        ("east",  "east",  "right", False),
        pytest.param("north", "north", "left",  False,
                     marks=pytest.mark.xfail(strict=False, reason=_KNOWN_NS_CLOSED_FLAKY_REASON)),
        pytest.param("north", "north", "right", False,
                     marks=pytest.mark.xfail(strict=False, reason=_KNOWN_NS_CLOSED_FLAKY_REASON)),
        pytest.param("south", "south", "left",  False,
                     marks=pytest.mark.xfail(strict=False, reason=_KNOWN_NS_CLOSED_FLAKY_REASON)),
        pytest.param("south", "south", "right", False,
                     marks=pytest.mark.xfail(strict=False, reason=_KNOWN_NS_CLOSED_FLAKY_REASON)),
    ],
)
def test_bot_traverses_door(
    bot, rcon, config, door_arena,
    direction: str, door_facing: str, hinge: str, start_open: bool,
):
    """Bot starts outside the sealed box, target is inside. Only the door
    is traversable. PASS = bot inside the box in <12s."""
    world = config["mc"]["world"]
    _build_box(rcon, world, direction, door_facing, hinge, start_open)
    tx, tz = WORLD_GEOMETRY[direction]["target"]
    t0 = time.time()
    r = bot.post("/action/goto_near", {"x": tx, "y": 65, "z": tz, "range": 1}, timeout=15)
    elapsed = time.time() - t0
    assert r.get("ok"), r
    pos = bot.position()
    assert _in_box(pos), f"bot ended outside box at {pos}"
    assert elapsed < 12.0, f"goto_near took {elapsed:.1f}s — slow path"
