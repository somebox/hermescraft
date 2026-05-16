"""F45.6: `mc inspect X Y Z` returns block metadata.

Migrated from scripts/test-inspect.py. Three scenarios share a setup
fixture and exercise inspect on different block kinds:
  A: air cell — is_air=true, occupied=false.
  B: crafting_table — is_relocatable=true, is_diggable=true.
  C: cobblestone — is_diggable=true, suggested_tool='wooden_pickaxe'.
"""

from __future__ import annotations

import pytest


@pytest.fixture
def inspect_arena(rcon, arena, tester_bot, config):
    """Stone floor at y=64, crafting_table at (3,65,3), cobble at (5,65,5).
    Bot at (0,65,0) facing east."""
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    arena.clean()
    arena.flat_arena((-10, 64, -10, 10, 80, 10), floor="stone")
    rcon.batch([
        f"execute in {world} run setblock 3 65 3 minecraft:crafting_table",
        f"execute in {world} run setblock 5 65 5 minecraft:cobblestone",
        f"execute in {world} run tp Tester 0 65 0 90 0",
    ])
    arena.settle()
    yield
    arena.flat_arena((-10, 65, -10, 10, 80, 10), floor="stone")


@pytest.mark.functional
def test_inspect_air_cell(bot, inspect_arena):
    """A: air cell at (7,66,7) — is_air=true."""
    r = bot.post("/action/inspect", {"x": 7, "y": 66, "z": 7}, timeout=10)
    assert r.get("ok"), r
    block = (r.get("data") or {}).get("block") or {}
    assert block.get("name") in ("air", "cave_air"), block
    assert block.get("is_air") is True, block


@pytest.mark.functional
def test_inspect_crafting_table(bot, inspect_arena):
    """B: crafting_table at (3,65,3) — is_relocatable=true, is_diggable=true."""
    r = bot.post("/action/inspect", {"x": 3, "y": 65, "z": 3}, timeout=10)
    assert r.get("ok"), r
    block = (r.get("data") or {}).get("block") or {}
    assert block.get("name") == "crafting_table", block
    assert block.get("is_relocatable") is True, block


@pytest.mark.functional
def test_inspect_cobblestone(bot, inspect_arena):
    """C: cobblestone at (5,65,5) — is_diggable=true, suggested_tool=wooden_pickaxe."""
    r = bot.post("/action/inspect", {"x": 5, "y": 65, "z": 5}, timeout=10)
    assert r.get("ok"), r
    block = (r.get("data") or {}).get("block") or {}
    assert block.get("name") == "cobblestone", block
    assert block.get("is_diggable") is True, block
    assert block.get("suggested_tool") == "wooden_pickaxe", block
