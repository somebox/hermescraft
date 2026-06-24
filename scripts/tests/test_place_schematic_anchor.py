"""Anchor / local_to_world parity for place-schematic-rcon.py."""

from __future__ import annotations

import sys
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))

from blueprint_lib import local_to_world, metadata_footprint  # noqa: E402

_place = SourceFileLoader(
    "place_schematic_rcon",
    str(REPO / "scripts" / "place-schematic-rcon.py"),
).load_module()


class PlaceSchematicAnchorTest(unittest.TestCase):
    def test_world_coords_metadata_footprint(self) -> None:
        footprint = metadata_footprint({"width": 5, "height": 3, "depth": 4})
        anchor = [100, 64, 200]
        cell = {"local": [2, 2, 3], "block": "cobblestone"}
        wx, wy, wz = _place.world_coords(anchor, footprint, cell)
        self.assertEqual((wx, wy, wz), local_to_world(anchor, footprint, 2, 2, 3))
        self.assertEqual((wx, wy, wz), (101, 65, 202))

    def test_world_coords_tight_mins_zero(self) -> None:
        footprint = {"mode": "tight", "local": {"x": [0, 4], "y": [0, 2], "z": [0, 4]}}
        anchor = [0, 64, 0]
        cell = {"local": [3, 1, 2], "block": "oak_planks"}
        self.assertEqual(
            _place.world_coords(anchor, footprint, cell),
            (3, 65, 2),
        )


if __name__ == "__main__":
    unittest.main()
