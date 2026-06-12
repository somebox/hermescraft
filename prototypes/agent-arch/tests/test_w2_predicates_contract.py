"""farm_plan → acceptance predicates (offline)."""

from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "prototypes" / "agent-arch"))

from capstone.predicates import from_farm_plan, outcome_only_chest  # noqa: E402


def test_outcome_only():
    p = outcome_only_chest()
    assert p[0]["kind"] == "chest_contains"
    assert p[0]["min_count"] == 24


def test_from_farm_plan_corners():
    plan = {
        "deposit_mark": "wheat_chest",
        "min_wheat": 28,
        "water_mark": "farm_water",
        "plot_corner1": {"x": 1, "y": 64, "z": 2},
        "plot_corner2": {"x": 9, "y": 64, "z": 10},
        "target_farmland_cells": 64,
    }
    preds = from_farm_plan(plan)
    kinds = [p["kind"] for p in preds]
    assert "chest_contains" in kinds
    assert "at_mark" in kinds
    assert "region_blocks" in kinds
