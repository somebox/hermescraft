"""Reactive hazard recording: a `mc dig` that breaches water/lava auto-reacts
and records a `danger` point in the mine registry.

Wiring under test (bot/lib/actions/mining/dig.js + runtime/mines/reactive.js):
  - Base `mc dig` (NOT safe_dig) does no lava/water pre-refusal, so digging a
    wall block with a fluid source behind it lets the fluid flow into the dug
    cell — `detectPostDigBreach` fires, and the reaction runs.
  - WATER (warn): auto-plug the dug cell from inventory → danger sealed=true.
  - LAVA (critical): honor retreat-first — do NOT plug in place → danger
    sealed=false (the bot steps back; the agent finishes the seal).
  - The danger binds to the nearest mine entrance within ~48 blocks (horizontal)
    and persists, readable via `mc mine_show`.

Geometry (per test): bot on dry grass at (0,65,0); a stone wall at (2,65,0)
with a fluid SOURCE behind it at (3,65,0). Open a mine at the bot, dig the
wall, assert the reaction + the recorded danger.
"""

from __future__ import annotations

import pytest

MINE_ID = "test_breach_mine"
WALL = (2, 65, 0)       # dig target (fluid flows in behind it)
WALL_TOP = (2, 66, 0)   # cap so goto_near can't perch the bot ON the dig target
SRC = (3, 65, 0)        # fluid source, face-adjacent to WALL
# Box the source so its ONLY opening is WALL. Needed for WATER: an open source
# floods the bot's dry approach cells and the dig pre-check refuses (SUBMERGED).
# LAVA is the opposite: it flows ~30 ticks/cell, far slower than the post-dig
# breach window, so a boxed source never reaches the freshly-dug cell in time.
# Lava must pre-spread (un-boxed) so flowing lava is already face-adjacent to
# the dug cell — and lava never trips the water-only SUBMERGED check.
ENCLOSE = [(4, 65, 0), (3, 65, 1), (3, 65, -1), (3, 66, 0)]


def _setup_breach(rcon, world, fluid):
    cmds = [
        "clear Tester",
        f"execute in {world} run give Tester minecraft:stone_pickaxe 1",
        f"execute in {world} run give Tester minecraft:cobblestone 64",
    ]
    walls = [WALL, WALL_TOP]
    if fluid == "water":
        walls += ENCLOSE
    else:  # lava
        cmds.append(f"execute in {world} run effect give Tester minecraft:fire_resistance 120 5")
    for (x, y, z) in walls:
        cmds.append(f"execute in {world} run setblock {x} {y} {z} minecraft:stone")
    cmds.append(f"execute in {world} run setblock {SRC[0]} {SRC[1]} {SRC[2]} minecraft:{fluid}")
    rcon.batch(cmds)


@pytest.fixture
def breach_arena(rcon, arena, tester_bot, config):
    """Flat stone+grass pad; bot dry at (0,65,0) with a mine opened there so
    breaches have somewhere to bind."""
    world = config["mc"]["world"]
    rcon.run(f"execute in {world} run tp Tester 0 70 0 0 0")
    rcon.batch([
        f"execute in {world} run fill -6 60 -6 10 80 10 minecraft:air",
        f"execute in {world} run fill -6 60 -6 10 63 10 minecraft:stone",
        f"execute in {world} run fill -6 64 -6 10 64 10 minecraft:grass_block",
        f"execute in {world} run tp Tester 0 65 0 0 0",
    ])
    arena.settle_water()
    yield world
    rcon.run(f"execute in {world} run tp Tester 0 70 0 0 0")
    rcon.run(f"execute in {world} run fill -6 60 -6 10 80 10 minecraft:air")


def _open_mine(bot):
    r = bot.post("/action/mine_open", {"id": MINE_ID, "resource": "iron_ore"}, timeout=15)
    assert r.get("ok"), r


def _danger_points(bot):
    r = bot.post("/action/mine_show", {"id": MINE_ID}, timeout=15)
    assert r.get("ok"), r
    pts = ((r.get("data") or {}).get("mine") or {}).get("points") or []
    return [p for p in pts if p.get("kind") == "danger"]


@pytest.mark.functional
def test_water_breach_auto_plugs_and_records_danger(bot, rcon, arena, config, breach_arena):
    """Dig a wall with a water source behind it → reaction auto-plugs the dug
    cell and records a sealed water danger."""
    world = breach_arena
    _open_mine(bot)
    _setup_breach(rcon, world, "water")
    arena.settle_water()
    bot.post("/action/goto_near", {"x": WALL[0], "y": WALL[1], "z": WALL[2], "range": 1}, timeout=20)

    r = bot.post("/action/dig", {"x": WALL[0], "y": WALL[1], "z": WALL[2]}, timeout=20)
    assert r.get("ok"), r
    data = r.get("data") or {}
    reaction = data.get("breach_reaction")
    assert reaction, f"expected a breach_reaction in the dig envelope: {data}"
    assert reaction.get("family") == "water", reaction
    assert reaction.get("sealed") is True, f"water breach should auto-plug: {reaction}"

    danger = reaction.get("danger") or {}
    assert danger.get("mineId") == MINE_ID, danger

    recorded = _danger_points(bot)
    assert any(p.get("hazard") == "water" and p.get("sealed") is True for p in recorded), recorded


@pytest.mark.functional
def test_lava_breach_retreats_and_records_unsealed_danger(bot, rcon, arena, config, breach_arena):
    """Dig a wall with a lava source behind it → reaction does NOT plug in
    place (retreat-first) and records an unsealed lava danger."""
    world = breach_arena
    _open_mine(bot)
    _setup_breach(rcon, world, "lava")
    arena.settle_water()
    bot.post("/action/goto_near", {"x": WALL[0], "y": WALL[1], "z": WALL[2], "range": 1}, timeout=20)

    r = bot.post("/action/dig", {"x": WALL[0], "y": WALL[1], "z": WALL[2]}, timeout=20)
    assert r.get("ok"), r
    data = r.get("data") or {}
    reaction = data.get("breach_reaction")
    assert reaction, f"expected a breach_reaction in the dig envelope: {data}"
    assert reaction.get("family") == "lava", reaction
    assert reaction.get("sealed") is False, f"lava must NOT auto-plug in place: {reaction}"

    danger = reaction.get("danger") or {}
    assert danger.get("mineId") == MINE_ID, danger

    recorded = _danger_points(bot)
    assert any(p.get("hazard") == "lava" and p.get("sealed") is False for p in recorded), recorded
