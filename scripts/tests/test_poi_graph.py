"""Tests for scripts/poi-graph.py — graph build over personal POIs.

Covers the chain-discovery, longest-path, frontier, and quadrant
classification logic that Steward + the grader depend on.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def pg():
    spec = importlib.util.spec_from_file_location(
        "poi_graph", REPO / "scripts" / "poi-graph.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["poi_graph"] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _poi(name: str, x: int, z: int, *, y: int = 64, sign: bool = False,
         torch: bool = False, kind: str | None = None,
         sign_offset: tuple[int, int, int] | None = None,
         torch_offset: tuple[int, int, int] | None = None) -> dict:
    """Default places sign/torch at the POI's own coord."""
    out: dict = {"name": name, "x": x, "y": y, "z": z}
    if sign:
        sx, sy, sz = sign_offset or (x, y, z)
        out["sign_at"] = {"x": sx, "y": sy, "z": sz}
    if torch:
        tx, ty, tz = torch_offset or (x, y + 1, z)
        out["torch_at"] = {"x": tx, "y": ty, "z": tz}
    if kind:
        out["kind"] = kind
    return out


def _write_shared(tmp_path: Path, pois: dict) -> Path:
    data_dir = tmp_path / "data"
    data_dir.mkdir(exist_ok=True)
    p = data_dir / "personal-pois-shared.json"
    p.write_text(json.dumps(pois, indent=2))
    return p


# ── quadrant + helpers ────────────────────────────────────────────────


def test_quadrant_classification_matches_grader(pg):
    assert pg._quadrant(10, -5) == "NE"
    assert pg._quadrant(-10, -5) == "NW"
    assert pg._quadrant(10, 5) == "SE"
    assert pg._quadrant(-10, 5) == "SW"
    assert pg._quadrant(0, 0) == "SE"  # origin tie-break


def test_quadrant_relative_to_muster(pg):
    # NE of (10, 10)
    assert pg._quadrant(20, 5, mx=10, mz=10) == "NE"
    # SW of (10, 10)
    assert pg._quadrant(5, 20, mx=10, mz=10) == "SW"


# ── build_graph: empty / single ───────────────────────────────────────


def test_empty_shared_file(pg, tmp_path):
    p = _write_shared(tmp_path, {})
    g = pg.build_graph(p, max_step=30.0)
    assert g["nodes"] == []
    assert g["edges"] == []
    assert g["summary"]["node_count"] == 0


def test_missing_file_returns_empty_graph(pg, tmp_path):
    g = pg.build_graph(tmp_path / "nonexistent.json", max_step=30.0)
    assert g["nodes"] == []
    assert g["summary"]["edge_count"] == 0


def test_single_signed_poi_no_edges(pg, tmp_path):
    p = _write_shared(tmp_path, {
        "muster": _poi("muster", 0, 0, sign=True),
    })
    g = pg.build_graph(p, max_step=30.0)
    assert len(g["nodes"]) == 1
    assert g["nodes"][0]["named"] is True
    assert g["edges"] == []
    assert g["frontier_nodes"] == ["muster"]
    assert g["named_frontier"] == ["muster"]
    assert g["longest_path"] == ["muster"]
    assert g["longest_path_len"] == 0.0


# ── edge discovery via waypoint chains ────────────────────────────────


def test_chain_of_4_nodes_connected_via_torch_chain(pg, tmp_path):
    """muster → wp1 → wp2 → spider_hill; chain at 25-block spacing.

    All 4 POIs are nodes (sign + waypoint); each consecutive pair is
    within max_step=30 so there are 3 direct edges. The longest simple
    path traverses all 4.
    """
    p = _write_shared(tmp_path, {
        "muster":      _poi("muster",      0,   0,  sign=True),
        "wp1":         _poi("wp1",        20, -15,  torch=True),
        "wp2":         _poi("wp2",        40, -30,  torch=True),
        "spider_hill": _poi("spider_hill", 60, -45, sign=True),
    })
    g = pg.build_graph(p, max_step=30.0)
    assert len(g["nodes"]) == 4
    assert g["summary"]["named_count"] == 2
    assert g["summary"]["waypoint_count"] == 2
    # 3 chain edges between consecutive POIs (muster↔wp1, wp1↔wp2, wp2↔spider_hill)
    chain_pairs = {("muster", "wp1"), ("wp1", "wp2"), ("wp2", "spider_hill")}
    actual_pairs = {tuple(sorted([e["from"], e["to"]])) for e in g["edges"]}
    expected_pairs = {tuple(sorted(p)) for p in chain_pairs}
    assert expected_pairs <= actual_pairs
    # Longest simple path traverses all 4
    assert len(g["longest_path"]) == 4
    assert g["longest_path_len"] >= 75.0  # 3 segments × ~25 blocks


def test_disconnected_pois_form_two_components(pg, tmp_path):
    """Two named places too far apart (no torch chain) → 2 components."""
    p = _write_shared(tmp_path, {
        "spider_hill": _poi("spider_hill",   50,  -50, sign=True),
        "balders_ruin": _poi("balders_ruin", -50,   50, sign=True),
    })
    g = pg.build_graph(p, max_step=30.0)
    assert len(g["edges"]) == 0
    assert len(g["connected_components"]) == 2
    assert g["frontier_nodes"] == sorted(["spider_hill", "balders_ruin"])


def test_max_edge_step_clamps_long_jumps(pg, tmp_path):
    """A 31-block gap with max_step=30 should NOT create an edge."""
    p = _write_shared(tmp_path, {
        "a": _poi("a",   0,   0,  sign=True),
        "b": _poi("b",  31,   0,  sign=True),
    })
    g = pg.build_graph(p, max_step=30.0)
    assert len(g["edges"]) == 0


def test_max_edge_step_allows_close_pois(pg, tmp_path):
    p = _write_shared(tmp_path, {
        "a": _poi("a",   0,   0,  sign=True),
        "b": _poi("b",  29,   0,  sign=True),
    })
    g = pg.build_graph(p, max_step=30.0)
    assert len(g["edges"]) == 1
    assert g["edges"][0]["length"] == pytest.approx(29.0, abs=0.5)


# ── longest path ──────────────────────────────────────────────────────


def test_star_3_arm_longest_path_traverses_5_nodes(pg, tmp_path):
    """Star: muster + 3 arms (each = wp → endpoint).

    Arm waypoints are positioned so adjacent arms DO NOT cross-connect
    (wp_n↔wp_e distance > max_step). The full graph then has 7 nodes
    and exactly 6 chain edges. Longest simple path is
    endpoint → wp → muster → wp → endpoint = 5 nodes, ~80 blocks.
    """
    # Place waypoints 25 blocks from muster; with max_step=30, adjacent
    # arms are sqrt(2*25²) = 35.4 apart (> 30) so they do NOT connect.
    p = _write_shared(tmp_path, {
        "muster": _poi("muster", 0, 0, sign=True),
        "wp_n":   _poi("wp_n",   0, -25, torch=True),
        "end_n":  _poi("end_n",  0, -50, sign=True),
        "wp_e":   _poi("wp_e",  25,   0, torch=True),
        "end_e":  _poi("end_e", 50,   0, sign=True),
        "wp_s":   _poi("wp_s",   0,  25, torch=True),
        "end_s":  _poi("end_s",  0,  50, sign=True),
    })
    g = pg.build_graph(p, max_step=30.0)
    assert g["summary"]["node_count"] == 7
    # 6 chain edges (muster↔wp_*, wp_*↔end_*); no cross-arm edges
    assert g["summary"]["edge_count"] == 6
    # Longest path runs endpoint → wp → muster → wp → endpoint
    assert len(g["longest_path"]) == 5
    assert "muster" in g["longest_path"]
    assert g["longest_path_len"] == pytest.approx(100.0, abs=1.0)  # 4 × 25
    # Endpoints are named frontier nodes; waypoints are unnamed frontier
    assert set(g["named_frontier"]) == {"end_n", "end_e", "end_s"}


# ── frontier nodes ────────────────────────────────────────────────────


def test_frontier_nodes_are_degree_le_1(pg, tmp_path):
    p = _write_shared(tmp_path, {
        "muster":     _poi("muster", 0, 0, sign=True),
        "wp1":        _poi("wp1",    20, -15, torch=True),
        "spider_hill": _poi("spider_hill", 40, -30, sign=True),
        # An orphan node, no connections
        "lonely_peak": _poi("lonely_peak", -100, 100, sign=True),
    })
    g = pg.build_graph(p, max_step=30.0)
    fr = g["frontier_nodes"]
    # muster (degree 1, connects to wp1), spider_hill (degree 1, connects
    # to wp1), and lonely_peak (degree 0). All <= 1. wp1 has degree 2 (its
    # neighbours are muster + spider_hill).
    assert set(fr) == {"muster", "spider_hill", "lonely_peak"}
    # named_frontier filters to landmarks only
    assert set(g["named_frontier"]) == {"muster", "spider_hill", "lonely_peak"}


# ── quadrant coverage per component ───────────────────────────────────


def test_quadrants_covered_per_component(pg, tmp_path):
    p = _write_shared(tmp_path, {
        # Component A: spans NE → SW via muster
        "muster":     _poi("muster",   0,   0, sign=True),
        "wp_ne":      _poi("wp_ne",   15, -15, torch=True),
        "spider_hill": _poi("spider_hill", 30, -30, sign=True),
        "wp_sw":      _poi("wp_sw",  -15,  15, torch=True),
        "cave":       _poi("cave",   -30,  30, sign=True),
        # Component B: standalone
        "lonely_peak": _poi("lonely_peak", 50, 50, sign=True),
    })
    g = pg.build_graph(p, max_step=30.0)
    comps = g["connected_components"]
    quads = g["quadrants_covered"]
    assert len(comps) == 2
    # Find which component holds muster
    main_idx = 0 if "muster" in comps[0] else 1
    assert set(quads[main_idx]) >= {"SE", "NE", "SW"}  # muster=SE, spider_hill=NE, cave=SW


def test_quadrants_relative_to_supplied_muster(pg, tmp_path):
    """Same POI coords, different muster = different quadrants."""
    p = _write_shared(tmp_path, {
        "x":  _poi("x",  10,  10, sign=True),
    })
    g_default = pg.build_graph(p, max_step=30.0)
    g_shifted = pg.build_graph(p, max_step=30.0, muster=(50, 64, 50))
    assert g_default["quadrants_covered"][0] == ["SE"]   # (10,10) NE of (0,0)? No: +x,+z=SE
    # (10,10) relative to (50,50) → dx=-40, dz=-40 → NW
    assert g_shifted["quadrants_covered"][0] == ["NW"]


# ── waypoints surface in output ───────────────────────────────────────


def test_torch_only_pois_are_unnamed_nodes(pg, tmp_path):
    """A torch-only POI is a node, but `named=False` and it doesn't count
    toward `named_frontier`."""
    p = _write_shared(tmp_path, {
        "drop1": _poi("drop1", 5, 5, torch=True),
        "drop2": _poi("drop2", 25, 5, torch=True),
    })
    g = pg.build_graph(p, max_step=30.0)
    assert g["summary"]["node_count"] == 2
    assert g["summary"]["named_count"] == 0
    assert g["summary"]["waypoint_count"] == 2
    assert g["named_frontier"] == []
    # Both are graph-frontier (degree 1 — they connect to each other)
    assert sorted(g["frontier_nodes"]) == ["drop1", "drop2"]


def test_malformed_pois_skipped(pg, tmp_path):
    p = _write_shared(tmp_path, {
        "good": _poi("good", 0, 0, sign=True),
        "bad_string": "not even a dict",
        "bad_no_coord": {"name": "bad_no_coord"},
        "bad_x_type": {"name": "bad", "x": "oops", "y": 64, "z": 0,
                       "sign_at": {"x": "oops", "y": 64, "z": 0}},
    })
    g = pg.build_graph(p, max_step=30.0)
    assert len(g["nodes"]) == 1
    assert g["nodes"][0]["name"] == "good"
