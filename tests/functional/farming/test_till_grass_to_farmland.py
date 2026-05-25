"""
Till grass → farmland on Tester bot (L8.1-style). Requires live MC + bot on :3004.
"""
import pytest

pytestmark = [pytest.mark.functional, pytest.mark.integration]


@pytest.mark.skip(reason="Requires live Paper server + Tester bot; run manually after farming changes")
def test_till_grass_to_farmland(bot, rcon):
    """POST /action/till converts prepared grass_block to farmland."""
    rcon.run("execute in landfolk-test run setblock 1 64 0 minecraft:grass_block")
    r = bot.post("/action/till", {"x": 1, "y": 64, "z": 0})
    assert r.get("ok") is True, r
    assert rcon.block_is(1, 64, 0, "farmland")
