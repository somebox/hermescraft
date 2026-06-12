"""workorders.py — compile surveyed construction legs into build commands.

Pure: route waypoints + legs[] (with K1 deficits) + spec -> ordered mc
build verbs with concrete Ys. Covers each deficit kind, ordering, span
splitting, and the bridge/reroute guards.
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from roadplan.workorders import (  # noqa: E402
    compile_leg, compile_workorders, _split_span, _interp_y,
)
from roadplan.spec import load_spec  # noqa: E402

SPEC = load_spec()


def test_interp_y_linear():
    a, b = (0, 64, 0), (10, 74, 0)
    assert _interp_y(a, b, (0, 0)) == 64
    assert _interp_y(a, b, (10, 0)) == 74
    assert _interp_y(a, b, (5, 0)) == 69


def test_split_span_caps_at_16():
    chunks = _split_span(0, 0, 40, 0, cap=16)
    assert len(chunks) == 3  # 0..15, 16..31, 32..40
    for x1, z1, x2, z2 in chunks:
        assert x2 - x1 + 1 <= 16


def test_tree_deficit_emits_fell_tree():
    leg = {"from": [0, 0], "to": [10, 0],
           "deficits": [{"kind": "tree", "at": [3, 0], "base_y": 64}]}
    lo = compile_leg(leg, (0, 64, 0), (10, 64, 0), SPEC)
    assert lo["orders"] == ["mc fell_tree 3 64 0"]


def test_step_and_drop_emit_level_at_deck_y():
    leg = {"from": [0, 0], "to": [10, 74],
           "deficits": [{"kind": "step", "at": [5, 37], "rise": 2},
                        {"kind": "drop", "at": [8, 60], "drop": 3}]}
    lo = compile_leg(leg, (0, 64, 0), (10, 74, 0), SPEC)
    # deck Y interpolates 64->74 along the leg.
    assert any(c.startswith("mc level 5 ") and "y=" in c for c in lo["orders"])
    assert any(c.startswith("mc level 8 ") for c in lo["orders"])


def test_gap_emits_bridge_fill_level():
    leg = {"from": [0, 0], "to": [10, 0],
           "deficits": [{"kind": "gap", "from": [3, 0], "to": [6, 0],
                         "width": 4, "depth": 3}]}
    lo = compile_leg(leg, (0, 65, 0), (10, 65, 0), SPEC)
    assert lo["orders"] == ["mc level 3 65 0 6 65 0 y=65"]


def test_clearing_before_grading_order():
    leg = {"from": [0, 0], "to": [10, 0], "deficits": [
        {"kind": "step", "at": [5, 0], "rise": 2},
        {"kind": "tree", "at": [3, 0], "base_y": 64},
    ]}
    lo = compile_leg(leg, (0, 64, 0), (10, 64, 0), SPEC)
    # fell_tree (clear) must come before mc level (grade).
    assert lo["orders"][0].startswith("mc fell_tree")
    assert lo["orders"][-1].startswith("mc level")


def test_no_floor_gap_is_flagged_not_filled():
    deep = SPEC["no_floor_min_depth"] + 2
    leg = {"from": [0, 0], "to": [10, 0],
           "deficits": [{"kind": "gap", "from": [3, 0], "to": [4, 0],
                         "width": 2, "depth": deep}]}
    lo = compile_leg(leg, (0, 65, 0), (10, 65, 0), SPEC)
    assert lo["orders"] == []
    assert any("no-floor" in n for n in lo["notes"])


def test_wide_gap_over_max_bridge_span_is_flagged():
    wide = SPEC["max_bridge_span"] + 5
    leg = {"from": [0, 0], "to": [wide + 10, 0],
           "deficits": [{"kind": "water", "from": [3, 0], "to": [3 + wide, 0],
                         "width": wide, "depth": 2}]}
    lo = compile_leg(leg, (0, 65, 0), (wide + 10, 65, 0), SPEC)
    assert lo["orders"] == []
    assert any("max_bridge_span" in n for n in lo["notes"])


def test_bridgeable_span_within_max_bridge_span_emits_fill():
    # A span wider than the old max_bridge (8) but within max_bridge_span (24)
    # now bridges instead of being flagged.
    width = 16
    leg = {"from": [0, 0], "to": [30, 0],
           "deficits": [{"kind": "water", "from": [3, 0], "to": [3 + width, 0],
                         "width": width, "depth": 5}]}
    lo = compile_leg(leg, (0, 65, 0), (30, 65, 0), SPEC)
    assert lo["orders"], "wide-but-bridgeable span should emit build commands"
    assert all(c.startswith("mc level") for c in lo["orders"])


def test_clearance_span_splits_and_clears():
    leg = {"from": [0, 0], "to": [40, 0],
           "deficits": [{"kind": "clearance", "from": [0, 0], "to": [40, 0],
                         "height": 2}]}
    lo = compile_leg(leg, (0, 64, 0), (40, 64, 0), SPEC)
    assert all(c.startswith("mc clear_strip") for c in lo["orders"])
    assert len(lo["orders"]) == 3  # 41 cells / 16 cap


def test_compile_workorders_skips_to_spec_legs():
    state = {
        "routes": [{"waypoints": [[0, 64, 0], [10, 64, 0], [20, 65, 0]]}],
        "legs": [
            {"from": [0, 0], "to": [10, 0], "status": "surveyed",
             "deficits": []},
            {"from": [10, 0], "to": [20, 0], "status": "surveyed",
             "deficits": [{"kind": "tree", "at": [15, 0], "base_y": 64}]},
        ],
    }
    leg_orders, total = compile_workorders(state, SPEC)
    assert len(leg_orders) == 1            # only the leg with deficits
    assert total == 1
    assert leg_orders[0]["orders"] == ["mc fell_tree 15 64 0"]


def test_compile_workorders_only_leg_filter():
    state = {
        "routes": [{"waypoints": [[0, 64, 0], [10, 64, 0], [20, 64, 0]]}],
        "legs": [
            {"from": [0, 0], "to": [10, 0],
             "deficits": [{"kind": "tree", "at": [3, 0], "base_y": 64}]},
            {"from": [10, 0], "to": [20, 0],
             "deficits": [{"kind": "tree", "at": [15, 0], "base_y": 64}]},
        ],
    }
    leg_orders, _ = compile_workorders(state, SPEC, only_leg=([10, 0], [20, 0]))
    assert len(leg_orders) == 1
    assert leg_orders[0]["from"] == [10, 0]
