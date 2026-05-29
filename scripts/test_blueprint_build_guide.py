#!/usr/bin/env python3
"""Tests for blueprint_build_guide.py"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

from blueprint_build_guide import (  # noqa: E402
    cluster_fill_boxes,
    local_to_world,
    materials_from_plan,
    render_markdown,
    resolve_footprint,
    site_prep_section,
    write_guide,
)


class TestBuildGuide(unittest.TestCase):
    def test_local_to_world_matches_footprint_mins(self):
        footprint = {"mode": "tight", "local": {"x": [1, 4], "y": [1, 10], "z": [1, 6]}}
        anchor = [370, 65, -608]
        wx, wy, wz = local_to_world(anchor, footprint, 1, 1, 1)
        self.assertEqual((wx, wy, wz), (370, 65, -608))
        wx2, wy2, wz2 = local_to_world(anchor, footprint, 4, 5, 6)
        self.assertEqual((wx2, wy2, wz2), (373, 69, -603))

    def test_minimal_plan_renders_fill(self):
        plan = {
            "plan_id": "tiny",
            "footprint": {"mode": "tight", "local": {"x": [0, 1], "y": [0, 0], "z": [0, 1]}},
            "anchor": {"coords": [10, 64, 20]},
            "cells": [
                {"local": [0, 0, 0], "block": "stone"},
                {"local": [1, 0, 0], "block": "stone"},
                {"local": [0, 0, 1], "block": "stone"},
                {"local": [1, 0, 1], "block": "stone"},
            ],
        }
        md = render_markdown(plan, plan_id="tiny", anchor=[10, 64, 20])
        self.assertIn("mc fill stone 10 64 20 11 64 21", md)
        self.assertIn("mc blueprint verify tiny --level 0", md)

    def test_capture_shaped_no_materials_planned(self):
        plan = {
            "plan_id": "cap",
            "source": {"type": "captured"},
            "cells": [
                {"local": [0, 0, 0], "block": "cobblestone"},
                {"local": [0, 1, 0], "block": "cobblestone"},
            ],
        }
        mats = materials_from_plan(plan)
        self.assertEqual(mats, [("cobblestone", 2)])
        md = render_markdown(plan, plan_id="cap", anchor=[0, 64, 0])
        self.assertIn("cobblestone", md)

    def test_fill_boxes_max_volume(self):
        cells = [{"local": [x, 0, 0], "block": "dirt"} for x in range(30)]
        boxes = cluster_fill_boxes(cells, "dirt", max_volume=500)
        for lx, lz, max_x, max_z, _ in boxes:
            vol = (max_x - lx + 1) * (max_z - lz + 1)
            self.assertLessEqual(vol, 500)

    def test_site_prep_levels_at_foundation_y(self):
        footprint = {"mode": "tight", "local": {"x": [1, 21], "y": [1, 29], "z": [1, 21]}}
        anchor = [310, 65, -600]
        prep_text, meta = site_prep_section(anchor, footprint)
        self.assertEqual(meta["prep_y"], 65)
        self.assertIn("mc level", prep_text)
        self.assertIn("65", prep_text)
        self.assertNotIn("mc level 309 -601 331 -579 64", prep_text)

    def test_dystopian_plan_slice(self):
        fp = Path(__file__).resolve().parents[1] / "data/ops/plans/dystopian-hut-3-plan.json"
        if not fp.is_file():
            self.skipTest("dystopian plan not in tree")
        with fp.open() as f:
            plan = json.load(f)
        footprint = resolve_footprint(plan)
        layer1 = [c for c in plan["cells"] if c["local"][1] == 1]
        boxes = []
        for block in {c["block"] for c in layer1}:
            boxes.extend(cluster_fill_boxes(layer1, block))
        self.assertGreater(len(boxes), 0)
        anchor = [370, 65, -608]
        md = render_markdown(
            plan,
            plan_id="dystopian-hut-3",
            anchor=anchor,
            worksite="hut3",
            region="hut3",
        )
        self.assertIn("Layer Y = 1", md)
        self.assertIn("mc task_context set hut3", md)


if __name__ == "__main__":
    unittest.main()
