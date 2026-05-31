"""Expand structure_manifest footprint for agent-test predicates."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("agent_test_mod", ROOT / "scripts" / "agent-test.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def test_structure_manifest_dual_deck_3x3():
    cells = mod._structure_manifest_cells({
        "platform_layers": [
            {"y": 65, "x": [110, 111, 112], "z": [80, 81, 82]},
            {"y": 71, "x": [110, 111, 112], "z": [80, 81, 82]},
        ],
        "corner_columns": {
            "x": [110, 112],
            "z": [80, 82],
            "y_ranges": [[66, 70], [72, 75]],
        },
    })
    assert len(cells) == 54
    assert (111, 66, 81) not in cells  # interior gap must not be in manifest
    assert (110, 68, 80) in cells


def test_structure_manifest_explicit_cells():
    cells = mod._structure_manifest_cells({"cells": [{"x": 1, "y": 2, "z": 3}]})
    assert cells == [(1, 2, 3)]
