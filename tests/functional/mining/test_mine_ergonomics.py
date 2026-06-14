"""Mine-registry ergonomics, validated in-world:

  - `stair_down` bound to a mine registers the entrance ONCE (proximity-deduped)
    and does NOT auto-record a landing per bite — a multi-bite descent must not
    flood the registry with duplicate entrances/landings.
  - `chamber` hollows a box, lights it, and records a chamber point in the
    bound mine.
  - `mine_remove --confirm` deletes the mine (teardown).

These exercise bot/lib/actions/excavation.js (maybeRegisterStairMine /
chamber / maybeRegisterChamber) + the mines runtime store end to end.
"""

from __future__ import annotations

import pytest

MINE_ID = "test_em"


@pytest.fixture
def em_arena(functional_world, rcon, arena, tester_bot, config, bot):
    """Solid stone pad (diggable) with the bot on top at (0,65,0), bound to a
    fresh mine via task_context. Removes the mine on teardown."""
    world = config["mc"]["world"]
    rcon.run(f"execute in {world} run tp Tester 0 72 0 0 0")
    rcon.batch([
        f"execute in {world} run fill -8 55 -8 8 80 8 minecraft:air",
        f"execute in {world} run fill -8 55 -8 8 64 8 minecraft:stone",
        "clear Tester",
        f"execute in {world} run give Tester minecraft:stone_pickaxe 1",
        f"execute in {world} run give Tester minecraft:cobblestone 64",
        f"execute in {world} run give Tester minecraft:torch 16",
        f"execute in {world} run tp Tester 0 65 0 0 0",
    ])
    arena.settle_water()
    # Open the mine at the bot, then bind the card to it.
    assert bot.post("/action/mine_open", {"id": MINE_ID, "resource": "iron_ore"}, timeout=15).get("ok")
    assert bot.post("/task-context", {"card_id": "t_em_test", "worksite_region": MINE_ID}, timeout=15).get("ok")
    yield world
    bot.post("/action/mine_remove", {"id": MINE_ID, "confirm": True}, timeout=15)
    bot.post("/task-context", {}, timeout=10)  # clear-ish; harmless if it no-ops
    rcon.run(f"execute in {world} run tp Tester 0 72 0 0 0")
    rcon.run(f"execute in {world} run fill -8 55 -8 8 80 8 minecraft:air")


def _points(bot, kind):
    r = bot.post("/action/mine_show", {"id": MINE_ID}, timeout=15)
    assert r.get("ok"), r
    pts = ((r.get("data") or {}).get("mine") or {}).get("points") or []
    return [p for p in pts if p.get("kind") == kind]


@pytest.mark.functional
def test_stair_down_does_not_pollute_registry(bot, em_arena):
    """A bound stair_down near the existing entrance must NOT add a duplicate
    entrance or an auto-landing. (A deep descent is many small bites; the old
    code registered a fresh entrance+landing per bite, flooding the registry —
    one real run produced 13 entrances + 11 landings for a single mine.)"""
    # em_arena already did mine_open at (0,65,0): exactly one entrance.
    mine0 = bot.post("/action/mine_show", {"id": MINE_ID}, timeout=15).get("data")["mine"]
    assert len(mine0["entrances"]) == 1, mine0["entrances"]

    r = bot.post("/action/stair_down", {"direction": "south", "length": 4}, timeout=40)
    assert r.get("ok"), r
    # The stair starts within 16 blocks of the entrance → a continuation, not a
    # new surface route → no re-registration.
    assert (r.get("data") or {}).get("mine_updated") is None, \
        f"nearby stair_down must not re-register the entrance: {r.get('data')}"

    mine1 = bot.post("/action/mine_show", {"id": MINE_ID}, timeout=15).get("data")["mine"]
    assert len(mine1["entrances"]) == 1, f"still exactly one entrance: {mine1['entrances']}"
    assert _points(bot, "landing") == [], "stair_down must not auto-record a landing per bite"


@pytest.mark.functional
def test_chamber_hollows_lights_and_records(bot, rcon, em_arena):
    """chamber hollows a box, places torches, and records a chamber point."""
    r = bot.post(
        "/action/chamber",
        {"x1": -1, "y1": 62, "z1": 3, "x2": 1, "y2": 64, "z2": 5},
        timeout=60,
    )
    assert r.get("ok"), r
    data = r.get("data") or {}
    assert data.get("dug", 0) > 0, data
    # Floor of the box (y=61) is solid stone, so no holes to patch.
    assert data.get("floor_holes") == [], data
    update = data.get("mine_updated")
    assert update and update.get("mine") == MINE_ID and update.get("chamber"), data
    chambers = _points(bot, "chamber")
    assert len(chambers) >= 1, chambers
    # Torches are best-effort underground; assert at least one went down.
    assert data.get("torches", 0) >= 1, data
    assert rcon.block_is(0, 63, 4, "air") or rcon.block_is(0, 64, 4, "air"), (
        "chamber should hollow at least one interior cell"
    )
