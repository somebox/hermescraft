"""Unit tests for gv2 starter_shelter schematic bootstrap helpers."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from scripts.lib.gv2_schematic_shelter import (  # noqa: E402
    footprint_min_from_base_anchor,
    patch_starter_shelter_plan,
)


class Gv2SchematicShelterTest(unittest.TestCase):
    def test_footprint_min_from_base_anchor(self) -> None:
        base = {"x": 53, "y": 65, "z": 49}
        self.assertEqual(footprint_min_from_base_anchor(base), (50, 64, 46))

    def test_patch_starter_shelter_plan_writes_anchor(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            base = {"x": 10, "y": 65, "z": 10}
            plan = patch_starter_shelter_plan(REPO, data, base)
            self.assertEqual(plan["anchor"]["coords"], [7, 64, 7])
            out = data / "ops" / "plans" / "starter_shelter-plan.json"
            self.assertTrue(out.is_file())
            loaded = json.loads(out.read_text())
            self.assertEqual(loaded["anchor"]["coords"], [7, 64, 7])


if __name__ == "__main__":
    unittest.main()
