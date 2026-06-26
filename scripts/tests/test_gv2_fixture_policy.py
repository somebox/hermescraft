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

    def test_cosmetic_interior_drift_is_warn_not_blocked(self) -> None:
        """gv2-2026-06-25-3: chest_wood 1 block off but still on the interior slab is a
        cosmetic warn, ok stays True — must not read like a chest embedded in a wall."""
        base = {"x": 53, "y": 65, "z": 49}
        exp = expected_chest_depot_coords(base)  # chest_wood (52,66,49)
        loc = {"base_anchor": base,
               "chest_wood": {"x": 53, "y": 66, "z": 49},   # 1 block east, same slab plane
               "chest_food": {"x": exp["chest_food"][0], "y": exp["chest_food"][1], "z": exp["chest_food"][2]}}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "config.json").write_text(json.dumps({"schematic_shelter_bootstrapped": True}) + "\n")
            r = audit_starter_shelter_fixtures(root, loc)
            self.assertTrue(r["ok"], r)                       # cosmetic -> still ok
            self.assertTrue(any("cosmetic" in w for w in r["warnings"]))

    def test_furnace_in_wall_cell_is_blocked(self) -> None:
        """A fixture in a perimeter/wall cell is structural breakage -> blocked."""
        base = {"x": 53, "y": 65, "z": 49}
        exp = expected_chest_depot_coords(base)
        loc = {"base_anchor": base}
        for mark, (x, y, z) in exp.items():
            loc[mark] = {"x": x, "y": y, "z": z}
        # origin = base_anchor; footprint 50..56 x, 46..52 z; wall edge x=50
        snap = {"origin": [53, 65, 49], "layers": {"66": {"cells": {"50,49": "furnace"}}}}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "config.json").write_text(
                json.dumps({"schematic_shelter_bootstrapped": True,
                            "construct_phase_closed": {"L4_roof": True}}) + "\n"
            )
            r = audit_starter_shelter_fixtures(root, loc, base_snapshot=snap)
            self.assertFalse(r["ok"])
            self.assertTrue(any("wall/perimeter" in v for v in r["violations"]))

    def _depot_loc(self, base):
        loc = {"base_anchor": base}
        for mark, (x, y, z) in expected_chest_depot_coords(base).items():
            loc[mark] = {"x": x, "y": y, "z": z}
        return loc

    def test_staging_depot_outside_footprint_ok(self) -> None:
        """A staging depot at a far spawn clears the footprint → no overlap finding."""
        base = {"x": 53, "y": 65, "z": 49}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "config.json").write_text(
                json.dumps({"schematic_shelter_bootstrapped": True,
                            "spawn": {"x": 100, "y": 65, "z": 100},
                            "construct_phase_closed": {"L4_roof": True}}) + "\n"
            )
            r = audit_starter_shelter_fixtures(root, self._depot_loc(base))
            self.assertTrue(r["ok"], r)
            self.assertFalse(any("staging" in v for v in r["violations"]))

    def test_staging_depot_inside_footprint_blocked(self) -> None:
        """A spawn whose depot candidate lands in the footprint is the overlap the depot
        lifecycle forbids — blocked, not silently skipped (must not mask a chest in the pad)."""
        base = {"x": 53, "y": 65, "z": 49}  # footprint x 50..56, z 46..52
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "config.json").write_text(
                json.dumps({"schematic_shelter_bootstrapped": True,
                            "spawn": {"x": 52, "y": 65, "z": 49},  # candidate (53,49) ∈ footprint
                            "construct_phase_closed": {"L4_roof": True}}) + "\n"
            )
            r = audit_starter_shelter_fixtures(root, self._depot_loc(base))
            self.assertFalse(r["ok"])
            self.assertTrue(any("staging depot" in v and "overlaps" in v for v in r["violations"]))


if __name__ == "__main__":
    unittest.main()
