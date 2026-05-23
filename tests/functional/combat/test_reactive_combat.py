"""Parametrized reactive combat scenarios (L3.60–72 fight/clear)."""

from __future__ import annotations

import os

import pytest

from tests._lib.combat_fixtures import run_reactive_measurement
from tests.functional.combat.scenarios import FIGHT_SCENARIOS, SCENARIO_BY_ID


@pytest.mark.functional
@pytest.mark.slow
@pytest.mark.parametrize(
    "scenario_id",
    [s.id for s in FIGHT_SCENARIOS],
    ids=[s.id for s in FIGHT_SCENARIOS],
)
def test_reactive_combat_scenario(bot, rcon, config, functional_world, scenario_id):
    world = config["mc"]["world"]
    scenario = SCENARIO_BY_ID[scenario_id]
    skill = float(os.environ.get("COMBAT_SKILL_DEFAULT", "0.5"))
    scenario.apply(rcon, world)
    run_reactive_measurement(
        bot,
        rcon,
        world,
        pass_mode=scenario.pass_mode,
        timeout_s=scenario.timeout_s,
        creeper_flee=False,
        skill=skill,
    )
