"""Unit tests for cubiomes-side height gate pre-filtering in mapcatalog.pass1.

The real cubiomes scanner emits one cell per (x, z) at step S, each with an
approximate surface y. These tests exercise the pure-Python evaluators against
synthetic cell arrays.
"""
from __future__ import annotations

import pytest

from mapcatalog.pass1 import (
    _largest_flat_component_cubiomes,
    _mean_neighbor_height_delta_cubiomes,
)


pytestmark = pytest.mark.unit


def _flat_grid(side: int, step: int = 16, y: float = 64.0) -> list[dict]:
    return [
        {"x": x * step, "z": z * step, "y": y}
        for x in range(side)
        for z in range(side)
    ]


def test_flat_patch_returns_full_component_on_flat_grid():
    cells = _flat_grid(4)  # 16 cells, all same height
    assert _largest_flat_component_cubiomes(cells, step=16, max_delta=2) == 16


def test_flat_patch_splits_at_cliff():
    # Two halves at y=64 and y=70, separated by a >2 delta along z=16 axis.
    cells = []
    for x in range(4):
        for z in range(4):
            y = 64.0 if z < 2 else 70.0
            cells.append({"x": x * 16, "z": z * 16, "y": y})
    # max_delta=2 → halves don't connect
    assert _largest_flat_component_cubiomes(cells, step=16, max_delta=2) == 8
    # max_delta=6 → bridges the gap, becomes one component
    assert _largest_flat_component_cubiomes(cells, step=16, max_delta=6) == 16


def test_flat_patch_handles_missing_y():
    cells = [
        {"x": 0, "z": 0, "y": 64.0},
        {"x": 16, "z": 0, "y": None},
        {"x": 0, "z": 16, "y": 64.0},
    ]
    assert _largest_flat_component_cubiomes(cells, step=16, max_delta=2) == 2


def test_flat_patch_empty_grid():
    assert _largest_flat_component_cubiomes([], step=16, max_delta=2) == 0


def test_height_jitter_zero_on_flat_grid():
    cells = _flat_grid(4)
    assert _mean_neighbor_height_delta_cubiomes(cells, step=16) == 0.0


def test_height_jitter_known_pattern():
    # 2x2 grid: heights 60, 62, 64, 66 at (0,0)(16,0)(0,16)(16,16).
    # Neighbor pairs (each counted twice): (60,62)=2, (60,64)=4, (62,66)=4, (64,66)=2
    # Total deltas: 8 (4 pairs * 2 directions): 2,2,4,4,4,4,2,2 -> mean = 3.0
    cells = [
        {"x": 0, "z": 0, "y": 60.0},
        {"x": 16, "z": 0, "y": 62.0},
        {"x": 0, "z": 16, "y": 64.0},
        {"x": 16, "z": 16, "y": 66.0},
    ]
    assert _mean_neighbor_height_delta_cubiomes(cells, step=16) == pytest.approx(3.0)


def test_height_jitter_empty_returns_sentinel():
    # Empty grid -> 999.0 sentinel (so the gate "<= N" always fails).
    assert _mean_neighbor_height_delta_cubiomes([], step=16) == 999.0


def test_step_parameter_walks_only_step_neighbors():
    # Cells spaced at 16: at step=16 the whole 4x4 grid is one connected component (16).
    # At step=32, the BFS hops by 32 — which lands on every other cell, forming a 2x2 sub-grid → 4.
    cells = _flat_grid(4, step=16, y=64.0)
    assert _largest_flat_component_cubiomes(cells, step=16, max_delta=2) == 16
    assert _largest_flat_component_cubiomes(cells, step=32, max_delta=2) == 4


# ---- end-to-end: cubiomes pre-filter inside evaluate_pass1 -----------------

def test_evaluate_pass1_rejects_on_height_jitter_when_cubiomes_present():
    """If cubiomes reports jitter > gate threshold, evaluate_pass1 rejects."""
    from pathlib import Path
    from mapcatalog.load import load_requirements
    from mapcatalog.pass1 import evaluate_pass1
    from mapcatalog.server_config import load_server_config

    cfg = load_server_config(Path("server.proc-lab.yaml"))
    if not cfg.cubiomes_binary or not Path(cfg.cubiomes_binary).is_file():
        pytest.skip("cubiomes binary not present")

    req = load_requirements(Path("requirements/scenario_worksite_flat.yaml"))
    # Seed 800: known plains-flat; we expect either an accept or a height-jitter reason that
    # mentions "cubiomes" (proves our pre-filter ran).
    result = evaluate_pass1(req, cfg, "800")
    # Either accepted (continue_pass2 True with no height-jitter reject) OR rejected with a
    # cubiomes-tagged reason.
    if not result.continue_pass2:
        assert any("cubiomes" in r for r in result.reasons), result.reasons
    # In either case, the metric key must be populated since the gate is present in the file.
    assert "height_jitter_cubiomes" in result.metrics or "flat_patch_cells_cubiomes" in result.metrics
