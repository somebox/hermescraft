"""Fixture policy audits — intended slab/interior depot vs wrong coords / early placement."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from scripts.lib.gv2_fixture_policy import (  # noqa: E402
    audit_starter_shelter_fixtures,
    expected_chest_depot_coords,
    is_policy_fixture_block,
)


class Gv2FixturePolicyTest(unittest.TestCase):
    def test_fixture_block_names_match_verify_gate(self) -> None:
        self.assertTrue(is_policy_fixture_block("chest"))
        self.assertTrue(is_policy_fixture_block("minecraft:furnace"))
        self.assertFalse(is_policy_fixture_block("oak_planks"))

    def test_expected_depot_on_slab_surface(self) -> None:
        base = {"x": 53, "y": 65, "z": 49}
        exp = expected_chest_depot_coords(base)
        self.assertEqual(exp["chest_wood"], (52, 66, 49))
        self.assertEqual(exp["chest_food"], (52, 66, 50))

    def test_intended_depot_marks_ok(self) -> None:
        base = {"x": 53, "y": 65, "z": 49}
        exp = expected_chest_depot_coords(base)
        loc = {"base_anchor": base}
        for mark, (x, y, z) in exp.items():
            loc[mark] = {"x": x, "y": y, "z": z}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "config.json").write_text(
                json.dumps({"schematic_shelter_bootstrapped": True}) + "\n"
            )
            r = audit_starter_shelter_fixtures(root, loc)
            self.assertTrue(r["ok"], r["violations"])

    def test_wrong_coordinate_reported(self) -> None:
        base = {"x": 10, "y": 65, "z": 10}
        loc = {
            "base_anchor": base,
            "chest_wood": {"x": 0, "y": 65, "z": 10},
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "config.json").write_text(json.dumps({"schematic_shelter_bootstrapped": True}) + "\n")
            r = audit_starter_shelter_fixtures(root, loc)
            self.assertFalse(r["ok"])
            self.assertTrue(any("drift" in v or "missing" in v for v in r["violations"]))

    def test_scaffolding_still_not_a_fixture(self) -> None:
        self.assertFalse(is_policy_fixture_block("dirt"))


if __name__ == "__main__":
    unittest.main()
