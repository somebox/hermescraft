"""Lean door + fence-gate traversal smokes (E/W production paths).

Production build spec mandates **E/W** door facing; combinatorics live in
`bot/test/actions/move-door-*.test.js` and `interaction-contract.test.js`.
This module keeps **8** live cases: closed oak door and fence gate on west and
east, each via `goto_near` and `through`.

Spatial need: door_sealed_box. Specialty pad: Origin. Observer: (0, 72, 0).
"""

from __future__ import annotations

import time

import pytest


WORLD_GEOMETRY = {
    "west": {
        "door": (3, 0), "bot_start": (-3, 0), "target": (5, 0),
        "walls": {"west": (3, -2, 3, 2), "east": (7, -2, 7, 2),
                  "north": (3, -2, 7, -2), "south": (3, 2, 7, 2)},
    },
    "east": {
        "door": (7, 0), "bot_start": (13, 0), "target": (5, 0),
        "walls": {"west": (3, -2, 3, 2), "east": (7, -2, 7, 2),
                  "north": (3, -2, 7, -2), "south": (3, 2, 7, 2)},
    },
    "north": {
        "door": (5, -2), "bot_start": (5, -8), "target": (5, 0),
        "walls": {"west": (3, -2, 3, 2), "east": (7, -2, 7, 2),
                  "north": (3, -2, 7, -2), "south": (3, 2, 7, 2)},
    },
    "south": {
        "door": (5, 2), "bot_start": (5, 8), "target": (5, 0),
        "walls": {"west": (3, -2, 3, 2), "east": (7, -2, 7, 2),
                  "north": (3, -2, 7, -2), "south": (3, 2, 7, 2)},
    },
}


def _build_box(rcon, world, direction, block_type, hinge, door_open):
    """Sealed obsidian box; the wall in `direction` has a 1-cell opening filled
    with the configured door (2 halves) or fence gate (1 block + air above).
    The door/gate faces `direction` (= the bot's travel direction)."""
    geo = WORLD_GEOMETRY[direction]
    dx, dz = geo["door"]
    facing = direction
    open_str = "true" if door_open else "false"
    cmds = [f"execute in {world} run fill {x1} 65 {z1} {x2} 66 {z2} minecraft:obsidian"
            for (x1, z1, x2, z2) in geo["walls"].values()]
    # Clear the 2-tall opening, then place the block.
    cmds.append(f"execute in {world} run setblock {dx} 65 {dz} minecraft:air")
    cmds.append(f"execute in {world} run setblock {dx} 66 {dz} minecraft:air")
    if block_type == "oak_fence_gate":
        cmds.append(f"execute in {world} run setblock {dx} 65 {dz} "
                    f"minecraft:oak_fence_gate[facing={facing},open={open_str}]")
        # y=66 stays air — a fence gate is a single block.
    else:  # oak_door (two halves)
        cmds.append(f"execute in {world} run setblock {dx} 65 {dz} "
                    f"minecraft:oak_door[half=lower,facing={facing},open={open_str},hinge={hinge}]")
        cmds.append(f"execute in {world} run setblock {dx} 66 {dz} "
                    f"minecraft:oak_door[half=upper,facing={facing},open={open_str},hinge={hinge}]")
    bx, bz = geo["bot_start"]
    cmds.append(f"execute in {world} run tp Tester {bx} 65 {bz} 0 0")
    rcon.batch(cmds)
    time.sleep(1.5)


def _in_box(pos: dict) -> bool:
    return 3 < pos.get("x", -99) < 7.5 and -2 < pos.get("z", -99) < 2 and pos.get("y", 0) >= 65


def _matrix_params():
    """E/W closed-door smokes only (was 48-case full matrix)."""
    params = []
    for direction in ("west", "east"):
        for method in ("goto_near", "through"):
            params.append(pytest.param(
                "oak_door", direction, "left", False, method,
                id=f"door-{direction}-closed-{method}",
                marks=(pytest.mark.functional_core,) if method == "through" and direction == "west" else (),
            ))
        for method in ("goto_near", "through"):
            params.append(pytest.param(
                "oak_fence_gate", direction, "left", False, method,
                id=f"gate-{direction}-closed-{method}",
            ))
    return params


@pytest.fixture
def door_arena(rcon, arena, tester_bot, config):
    """Reset arena: forceload + packed sub-floor (stone y60..64) so prior tests'
    voids don't chunk through and kill the bot mid-pathfind."""
    world = config["mc"]["world"]
    rcon.run(f"execute in {world} run tp Tester 0 65 0 0 0")
    arena.forceload((-1, -1, 1, 1))
    rcon.batch([
        f"execute in {world} run fill -16 60 -16 16 80 16 minecraft:air",
        f"execute in {world} run fill -16 60 -16 16 63 16 minecraft:stone",
        f"execute in {world} run fill -16 64 -16 16 64 16 minecraft:stone",
        "effect give Tester minecraft:resistance 600 4",
        "effect give Tester minecraft:saturation 600 1",
    ])
    arena.settle_fast()
    yield
    from tests._lib.functional_fixtures import ensure_arena_forceload

    rcon.run(f"execute in {world} run tp Tester 0 65 0 0 0")
    rcon.run(f"execute in {world} run fill -16 60 -16 16 80 16 minecraft:air")
    ensure_arena_forceload(rcon, world)


@pytest.mark.functional
@pytest.mark.parametrize("block_type,direction,hinge,door_open,method", _matrix_params())
def test_traverse(bot, rcon, config, door_arena,
                  block_type, direction, hinge, door_open, method):
    """Bot outside the sealed box, target inside, only the opening traversable.
    PASS = bot inside the box, via the given method, in <20s."""
    world = config["mc"]["world"]
    _build_box(rcon, world, direction, block_type, hinge, door_open)
    geo = WORLD_GEOMETRY[direction]
    tx, tz = geo["target"]
    dx, dz = geo["door"]
    t0 = time.time()
    if method == "goto_near":
        r = bot.post("/action/goto_near", {"x": tx, "y": 65, "z": tz, "range": 1}, timeout=20)
    else:  # through — gate/door coords + far-side destination (= target)
        r = bot.post("/action/through",
                     {"gx": dx, "gy": 65, "gz": dz, "dx": tx, "dy": 65, "dz": tz}, timeout=30)
    elapsed = time.time() - t0
    assert r.get("ok"), f"{method} not ok: {r}"
    pos = bot.position()
    assert _in_box(pos), f"bot ended outside box at {pos} ({method})"
    assert elapsed < 20.0, f"{method} took {elapsed:.1f}s — slow path"
