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


def _write_snap(tmp_path, l0_counts, oy=63, l0_cells=None):
    d = tmp_path / "artifacts" / "world"
    d.mkdir(parents=True)
    ox, oz = 53, 49
    layer = {"counts": l0_counts}
    if l0_cells is not None:
        layer["cells"] = l0_cells
    (d / "base-snapshot.json").write_text(json.dumps({
        "origin": [ox, oy, oz], "footprint": [7, 7],
        "layers": {str(oy - 1): layer, str(oy): {"counts": {"air": 80}}},
    }))


def _write_shell_snap(tmp_path, *, missing_wall: bool = False):
    rendered = tmp_path / "rendered"
    rendered.mkdir(parents=True)
    (rendered / "starter_shelter-plan.json").write_text(json.dumps({
        "anchor": {"coords": [50, 62, 46]},
        "cells": [
            {"local": [0, 3, 0], "block": "oak_log"},
            {"local": [1, 3, 0], "block": "oak_log"},
            {"local": [0, 5, 0], "block": "oak_planks"},
        ],
    }))
    d = tmp_path / "artifacts" / "world"
    d.mkdir(parents=True)
    wall_cells = {"50,46": "oak_log"}
    if not missing_wall:
        wall_cells["51,46"] = "oak_log"
    (d / "base-snapshot.json").write_text(json.dumps({
        "origin": [53, 63, 49],
        "footprint": [7, 7],
        "layers": {
            "62": {"counts": {"cobblestone": 49}},
            "65": {"counts": {"oak_log": len(wall_cells)}, "cells": wall_cells},
            "67": {"counts": {"oak_planks": 1}, "cells": {"50,46": "oak_planks"}},
        },
    }))


def test_flooded_l0_is_not_viable(tmp_path):
    oy = 63
    ox, oz = 53, 49
    cells = {}
    for x in range(ox - 3, ox + 4):
        for z in range(oz - 3, oz + 4):
            cells[f"{x},{z}"] = "water" if z == oz else "air"
    _write_snap(tmp_path, {"air": 42, "water": 3}, oy=oy, l0_cells=cells)
    bv = extract_base_viability(tmp_path)
    assert bv["present"] and bv["viable"] is False
    assert bv["l0_water"] >= 1 and bv["l0_air"] >= 1


def test_dry_l0_is_viable(tmp_path):
    oy = 63
    ox, oz = 53, 49
    cells = {f"{x},{z}": "cobblestone" for x in range(ox - 3, ox + 4) for z in range(oz - 3, oz + 4)}
    _write_snap(tmp_path, {"cobblestone": 49}, oy=oy, l0_cells=cells)
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


def test_shell_gate_skips_non_schematic_runs(tmp_path):
    """Starter-shelter shell truth must not apply to unrelated runs."""
    _write_snap(tmp_path, {"cobblestone": 49})
    # Even if shell-like layers exist, without rendered plan/config context this run
    # is not judged against starter_shelter cells.
    snap = json.loads((tmp_path / "artifacts" / "world" / "base-snapshot.json").read_text())
    snap["layers"].update({
        "65": {"counts": {"air": 49}, "cells": {}},
        "67": {"counts": {"air": 49}, "cells": {}},
    })
    (tmp_path / "artifacts" / "world" / "base-snapshot.json").write_text(json.dumps(snap))
    bv = extract_base_viability(tmp_path)
    assert bv["viable"] is True
    assert bv["shell"]["present"] is False
    assert apply_viability_gate(EST_FLOODED, bv) == EST_FLOODED


def test_shell_integrity_reports_complete_when_wall_and_roof_match(tmp_path):
    _write_shell_snap(tmp_path)
    bv = extract_base_viability(tmp_path)
    assert bv["viable"] is True
    assert bv["shell"]["present"] is True
    assert bv["shell"]["complete"] is True
    assert bv["shell"]["walls"]["matched"] == 2
    assert bv["shell"]["roof"]["matched"] == 1


def test_gate_downgrades_shell_when_captured_wall_missing(tmp_path):
    _write_shell_snap(tmp_path, missing_wall=True)
    bv = extract_base_viability(tmp_path)
    assert bv["viable"] is True
    assert bv["shell"]["complete"] is False
    gated = apply_viability_gate(EST_FLOODED, bv)
    assert gated["milestones"]["shell"] == "no"
    assert gated["score"] == 2.5
    assert gated["viability_gated"] == ["shell"]
    assert "walls 1/2" in gated["viability_note"]


def test_complete_shell_with_clean_footprint_l0_not_gated(tmp_path):
    """gv2-2026-06-25-3 class: shell complete + footprint L0 ok -> shell stays yes."""
    _write_shell_snap(tmp_path)
    snap_path = tmp_path / "artifacts" / "world" / "base-snapshot.json"
    snap = json.loads(snap_path.read_text())
    oy = snap["origin"][1]
    ox, oz = snap["origin"][0], snap["origin"][2]
    l0_cells = {f"{x},{z}": "dirt" for x in range(ox - 3, ox + 4) for z in range(oz - 3, oz + 4)}
    snap["layers"][str(oy - 1)] = {"counts": {"dirt": 49}, "cells": l0_cells}
  # L1 cobble for physical ground
    l1_cells = {f"{x},{z}": "cobblestone" for x in range(ox - 3, ox + 4) for z in range(oz - 3, oz + 4)}
    snap["layers"][str(oy)] = {"counts": {"cobblestone": 49}, "cells": l1_cells}
    snap_path.write_text(json.dumps(snap))
    bv = extract_base_viability(tmp_path)
    est = {"score": 2.5, "max": 6, "milestones": dict(EST_FLOODED["milestones"]), "evidence": {k: [] for k in EST_FLOODED["milestones"]}}
    est["milestones"]["shell"] = "yes"
    gated = apply_viability_gate(est, bv)
    assert gated["milestones"]["shell"] == "yes"
    assert gated.get("physical_ground_promoted")


def test_confirmed_water_with_unread_still_not_viable(tmp_path):
    """GS1b: confirmed water in a read cell flags bad even when most footprint cells are
    unread — partial capture must not hide flooding (viable=False, not None)."""
    oy = 63
    ox, oz = 53, 49
    cells = {f"{ox},{oz}": "water", f"{ox + 1},{oz}": "dirt"}  # 2 of 49 read; 1 is water
    _write_snap(tmp_path, {"water": 1, "dirt": 1}, oy=oy, l0_cells=cells)
    bv = extract_base_viability(tmp_path)
    assert bv["present"] is True
    assert bv["coverage_complete"] is False  # 47 cells unread
    assert bv["viable"] is False             # confirmed water, NOT None
    assert apply_viability_gate(EST_FLOODED, bv)["milestones"]["shell"] == "no"


def test_partial_clean_coverage_untrusted_with_warning(tmp_path):
    """GS1c: partial coverage with all read cells clean is unknown (viable=None),
    untrusted, and surfaces a coverage warning even though nothing is downgraded."""
    oy = 63
    ox, oz = 53, 49
    cells = {f"{ox},{oz}": "dirt", f"{ox + 1},{oz}": "grass_block"}  # 2 of 49 read, clean
    _write_snap(tmp_path, {"dirt": 1, "grass_block": 1}, oy=oy, l0_cells=cells)
    bv = extract_base_viability(tmp_path)
    assert bv["viable"] is None
    assert bv["coverage_complete"] is False
    assert bv["base_viability_trusted"] is False
    assert "incomplete" in (bv.get("coverage_warning") or "")
    # nothing proven bad -> milestones unchanged (the warning is the signal, not a downgrade)
    assert apply_viability_gate(EST_FLOODED, bv)["milestones"]["shell"] == "yes"
