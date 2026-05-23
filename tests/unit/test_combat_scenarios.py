"""Unit tests for combat scenario registry (no MC)."""

from tests.functional.combat.scenarios import ALL_PARITY_SCENARIOS, SCENARIO_BY_ID


def test_parity_scenario_count():
    assert len(ALL_PARITY_SCENARIOS) == 9


def test_expected_stems_present():
    stems = {
        "L3.60_fight_zombie",
        "L3.61_fight_skeleton",
        "L3.62_flee_creeper",
        "L3.64_fight_retreat_low_hp",
        "L3.66_dodge_skeleton",
        "L3.67_fight_two_zombies_obstacles",
        "L3.70_multi_zombie_stress",
        "L3.71_multi_zombie_four",
        "L3.72_mixed_skeletons_zombie",
    }
    assert set(SCENARIO_BY_ID) == stems
