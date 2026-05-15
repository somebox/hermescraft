"""F54.3: `mc inventory` surfaces tool advisories.

Migrated from scripts/test-inventory-advisories.py. Three scenarios:
  A: cleared inventory → 'no pickaxe' + 'no axe' advisories.
  B: full-durability pickaxe + axe → no missing-tool or near-break advisories.
  C: near-broken pickaxe (Damage 56/59 ≈ 5%) → 'near breaking' advisory
     naming wooden_pickaxe.
"""

from __future__ import annotations

import time

import pytest


def _advisories(bot) -> list[str]:
    r = bot.get("/inventory", timeout=10)
    return ((r.get("data") or {}).get("advisories") or []) if r.get("ok") else []


@pytest.fixture
def _ready(rcon, flint_bot, config):
    flint_bot.wait_until_ready(timeout=10)
    return flint_bot


@pytest.mark.functional
def test_cleared_inventory_warns_no_pickaxe_and_no_axe(rcon, bot, _ready):
    rcon.batch([
        "clear Flint",
        "give Flint minecraft:bread 4",
    ])
    time.sleep(1.0)
    advisories = _advisories(bot)
    assert any("no pickaxe" in a.lower() for a in advisories), advisories
    assert any("no axe" in a.lower() for a in advisories), advisories


@pytest.mark.functional
def test_full_durability_tools_emit_no_warnings(rcon, bot, _ready):
    rcon.batch([
        "clear Flint",
        "give Flint minecraft:wooden_pickaxe 1",
        "give Flint minecraft:wooden_axe 1",
    ])
    time.sleep(1.0)
    advisories = _advisories(bot)
    assert not any("no pickaxe" in a.lower() for a in advisories), advisories
    assert not any("no axe" in a.lower() for a in advisories), advisories
    assert not any("near breaking" in a.lower() for a in advisories), advisories


@pytest.mark.functional
def test_damaged_pickaxe_emits_near_breaking_advisory(rcon, bot, _ready):
    """1.21 component format: [minecraft:damage=N]. wooden_pickaxe max
    durability is 59; damage 56 ≈ 5% remaining → near-breaking trigger."""
    rcon.batch([
        "clear Flint",
        "give Flint minecraft:wooden_pickaxe[minecraft:damage=56] 1",
        "give Flint minecraft:wooden_axe 1",
    ])
    time.sleep(1.0)
    advisories = _advisories(bot)
    matched = next(
        (a for a in advisories if "near breaking" in a.lower() and "wooden_pickaxe" in a.lower()),
        None,
    )
    assert matched is not None, advisories
