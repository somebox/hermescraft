"""Parametrized reactive flee/dodge scenarios (L3.62, L3.66)."""

from __future__ import annotations

import os

import pytest

from tests._lib.combat_fixtures import run_reactive_measurement
from tests.functional.combat.scenarios import FLEE_SCENARIOS, SCENARIO_BY_ID


@pytest.mark.functional
@pytest.mark.slow
@pytest.mark.parametrize(
    "scenario_id",
    [s.id for s in FLEE_SCENARIOS],
    ids=[s.id for s in FLEE_SCENARIOS],
)
def test_reactive_flee_scenario(bot, rcon, config, functional_world, scenario_id):
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
        survive_after_s=scenario.survive_after_s,
        min_hp=scenario.min_hp,
        creeper_flee=scenario.creeper_flee,
        skill=skill,
    )
