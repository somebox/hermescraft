"""base_viability: L0 gate from the captured base snapshot downgrades shell on a
flooded base (gv2-2026-06-22-1), and is a no-op without a snapshot."""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from scripts.lib.gv2_metrics.base_viability import (  # noqa: E402
    apply_viability_gate,
    extract_base_viability,
)

EST_FLOODED = {  # gv2-2026-06-22-1 establishment (shell=yes on a flooded base)
    "score": 3.5, "max": 6,
    "milestones": {"site": "yes", "ground": "no", "shell": "yes",
                   "chest": "yes", "food": "no", "mine": "partial"},
}


def _write_snap(tmp_path, l0_counts, oy=63):
    d = tmp_path / "artifacts" / "world"
    d.mkdir(parents=True)
    (d / "base-snapshot.json").write_text(json.dumps({
        "origin": [53, oy, 49], "footprint": [7, 7],
        "layers": {str(oy - 1): {"counts": l0_counts}, str(oy): {"counts": {"air": 80}}},
    }))


def test_flooded_l0_is_not_viable(tmp_path):
    _write_snap(tmp_path, {"air": 42, "water": 3, "cobblestone": 2, "grass_block": 31})
    bv = extract_base_viability(tmp_path)
    assert bv["present"] and bv["viable"] is False
    assert bv["l0_air"] == 42 and bv["l0_water"] == 3


def test_dry_l0_is_viable(tmp_path):
    _write_snap(tmp_path, {"cobblestone": 49})
    bv = extract_base_viability(tmp_path)
    assert bv["viable"] is True


def test_no_snapshot_is_noop(tmp_path):
    bv = extract_base_viability(tmp_path)
    assert bv["present"] is False and bv["viable"] is None
    assert apply_viability_gate(EST_FLOODED, bv) == EST_FLOODED


def test_gate_downgrades_shell_and_rescores_on_flood():
    bv = {"present": True, "viable": False, "l0_y": 62, "l0_air": 42, "l0_water": 3}
    gated = apply_viability_gate(EST_FLOODED, bv)
    assert gated["milestones"]["shell"] == "no"
    assert gated["score"] == 2.5  # 3.5 - 1.0 (shell yes->no)
    assert gated["viability_gated"] == ["shell"]
    # original untouched
    assert EST_FLOODED["milestones"]["shell"] == "yes"


def test_gate_noop_when_viable():
    bv = {"present": True, "viable": True}
    assert apply_viability_gate(EST_FLOODED, bv) == EST_FLOODED
