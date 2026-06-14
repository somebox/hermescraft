"""farm_status: per-cell plot categorization (harvestable / planted /
tilled / empty_soil / etc) + next-action hint.
"""

from __future__ import annotations

import pytest


def _paint_mixed_plot(rcon, world: str) -> None:
    """Apply the mixed 5×5 layout in small batches (large single payloads drop cmds)."""
    batches: list[list[str]] = [[], [], [], []]
    for x in [-2, -1, 0]:
        batches[0].append(f"execute in {world} run setblock {x} 64 -2 minecraft:farmland[moisture=7]")
        batches[0].append(f"execute in {world} run setblock {x} 65 -2 minecraft:wheat[age=7]")
    for x in [1, 2]:
        batches[0].append(f"execute in {world} run setblock {x} 64 -2 minecraft:farmland[moisture=7]")
    for x in [-2, -1, 0]:
        batches[1].append(f"execute in {world} run setblock {x} 64 -1 minecraft:farmland[moisture=7]")
        batches[1].append(f"execute in {world} run setblock {x} 65 -1 minecraft:wheat[age=2]")
    batches[1].append(f"execute in {world} run setblock 1 64 -1 minecraft:farmland[moisture=7]")
    batches[1].append(f"execute in {world} run setblock 1 65 -1 minecraft:oak_log")
    batches[1].append(f"execute in {world} run setblock 2 64 -1 minecraft:farmland[moisture=7]")
    for x in range(-2, 3):
        batches[2].append(f"execute in {world} run setblock {x} 64 0 minecraft:farmland[moisture=7]")
    for x in range(-2, 3):
        batches[3].append(f"execute in {world} run setblock {x} 64 1 minecraft:grass_block")
    for x in [-2, -1, 0]:
        batches[3].append(f"execute in {world} run setblock {x} 64 2 minecraft:dirt")
    for x in [1, 2]:
        batches[3].append(f"execute in {world} run setblock {x} 64 2 minecraft:stone")
    for batch in batches:
        rcon.batch(batch)


@pytest.fixture
def status_arena(functional_world, rcon, arena, config):
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run difficulty peaceful",
        f"execute in {world} run gamerule doDaylightCycle false",
        f"execute in {world} run gamerule doMobSpawning false",
        f"execute in {world} run time set day",
        f"execute in {world} run kill @e[type=!player]",
        f"execute in {world} run fill -5 60 -5 5 80 5 minecraft:air",
        f"execute in {world} run fill -5 62 -5 5 63 5 minecraft:stone",
        f"execute in {world} run fill -2 64 -2 2 64 2 minecraft:grass_block",
        "clear Tester",
        f"effect clear Tester",
        "gamemode survival Tester",
        f"execute in {world} run tp Tester 4 65 4 0 0",
    ])
    arena.settle_default()
    yield
    rcon.batch([
        f"execute in {world} run kill @e[type=!player]",
        f"execute in {world} run fill -5 60 -5 5 80 5 minecraft:air",
        f"execute in {world} run fill -5 62 -5 5 63 5 minecraft:stone",
        f"execute in {world} run tp Tester 0 65 0 0 0",
    ])


@pytest.mark.functional
def test_farm_status_mixed_plot_counts_correct(bot, rcon, arena, config, status_arena):
    world = config["mc"]["world"]
    counts = {}
    r = None
    for _attempt in range(2):
        _paint_mixed_plot(rcon, world)
        bot.post("/action/goto_near", {"x": 0, "y": 65, "z": 0, "range": 2}, timeout=30)
        arena.settle_default()
        for x in range(-2, 3):
            for z in range(-2, 3):
                bot.post("/action/inspect", {"x": x, "y": 64, "z": z}, timeout=5)
                bot.post("/action/inspect", {"x": x, "y": 65, "z": z}, timeout=5)
        arena.settle_fast()
        r = bot.post("/action/farm_status", {
            "x1": -2, "z1": -2, "x2": 2, "z2": 2, "y": 64,
        }, timeout=15)
        assert r.get("ok"), r
        counts = r.get("data", {}).get("counts", {})
        if counts.get("tilled") == 8 and counts.get("harvestable") == 3:
            break

    assert counts.get("harvestable") == 3, f"want 3 harvestable, got {counts}"
    assert counts.get("planted_growing") == 3, f"want 3 planted_growing, got {counts}"
    assert counts.get("tilled") == 8, f"want 8 tilled, got {counts}"
    assert counts.get("empty_soil") == 8, f"want 8 empty_soil, got {counts}"
    assert counts.get("unplantable") == 2, f"want 2 unplantable, got {counts}"
    assert counts.get("soil_occupied") == 1, f"want 1 soil_occupied, got {counts}"
    assert counts.get("farmland_occupied") == 0, f"want 0 farmland_occupied, got {counts}"
    assert r["data"]["column_count"] == 25

    hv = r["data"]["harvestable_coords"]
    assert len(hv) == 3, hv
    assert all(c["crop"] == "wheat" for c in hv), hv
    assert "harvest" in (r.get("next_action_hint") or "").lower()


@pytest.mark.functional
def test_farm_status_empty_plot_hints_at_till(bot, rcon, config, status_arena):
    r = bot.post("/action/farm_status", {
        "x1": -2, "z1": -2, "x2": 2, "z2": 2, "y": 64,
    }, timeout=15)
    assert r.get("ok"), r
    counts = r["data"]["counts"]
    assert counts.get("empty_soil") == 25, f"want 25 empty_soil, got {counts}"
    assert counts.get("harvestable", 0) == 0
    assert "till" in (r.get("next_action_hint") or "").lower()
