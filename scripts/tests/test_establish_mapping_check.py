"""Tests for scripts/establish-mapping-check.py — Phase E grader.

Phase E uses the POI graph (from scripts/poi-graph.py) instead of just
counting POIs and measuring max-distance-from-muster. The grader now
asks: how long is the longest torch-lit trail? How many quadrants does
the connected graph touch? How many landmarks are stranded?

Helper conventions:
- `_poi(name, x, z, sign=True, torch=True, kind=...)` builds a POI with
  the sign at (x, 64, z) and the torch at (x, 65, z) by default.
- `_chain(name_prefix, start, step, count, ..., sign_at_last=True)`
  builds a torch chain so we can construct longest-path test fixtures
  in one line.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def emc():
    spec = importlib.util.spec_from_file_location(
        "establish_mapping_check", REPO / "scripts" / "establish-mapping-check.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["establish_mapping_check"] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _poi(name: str, x: int, z: int, *, sign=False, torch=False,
         kind: str | None = None) -> dict:
    out = {"name": name, "x": x, "y": 64, "z": z,
           "added_at": "2026-06-04T10:00:00Z",
           "last_seen": "2026-06-04T10:00:00Z"}
    if sign:
        out["sign_at"] = {"x": x, "y": 64, "z": z}
    if torch:
        out["torch_at"] = {"x": x, "y": 65, "z": z}
    if kind:
        out["kind"] = kind
    return out


def _chain(prefix: str, start: tuple[int, int], step: tuple[int, int],
           count: int, *, sign_at_start=False, sign_at_end=False) -> dict:
    """Build a chain of `count` torch-POIs starting at `start` with `step`
    offset between consecutive POIs. Optionally turn the first/last into
    a landmark by adding sign_at."""
    out: dict = {}
    for i in range(count):
        x = start[0] + step[0] * i
        z = start[1] + step[1] * i
        name = f"{prefix}_{i}"
        is_first = i == 0
        is_last = i == count - 1
        out[name] = _poi(
            name, x, z,
            sign=(is_first and sign_at_start) or (is_last and sign_at_end),
            torch=True,
        )
    return out


# ── quadrant_of axis convention ──


def test_quadrant_of_north_is_negative_z(emc):
    assert emc.quadrant_of(10, -5, 0, 0) == "NE"
    assert emc.quadrant_of(-10, -5, 0, 0) == "NW"
    assert emc.quadrant_of(10, 5, 0, 0) == "SE"
    assert emc.quadrant_of(-10, 5, 0, 0) == "SW"


def test_quadrant_of_origin_falls_into_SE(emc):
    assert emc.quadrant_of(0, 0, 0, 0) == "SE"


# ── grade() happy path: connected graph spanning all 4 quadrants ──


def test_grade_passes_with_four_quadrant_arms(emc):
    """4 torch arms from muster, each ~25-block-spaced, ending in a named
    landmark. Spine = endpoint → wp → muster → wp → endpoint = 4×~28
    ≈ 113 blocks. Each endpoint is a degree-1 landmark = 4 frontier
    landmarks, so frontier_max needs to allow this shape."""
    pois = {"muster": _poi("muster", 0, 0, sign=True, kind="hub")}
    arm_layout = [
        ("ne", (20, -20), (40, -40)),
        ("nw", (-20, -20), (-40, -40)),
        ("se", (20, 20), (40, 40)),
        ("sw", (-20, 20), (-40, 40)),
    ]
    for d, wp, end in arm_layout:
        pois[f"wp_{d}"] = _poi(f"wp_{d}", wp[0], wp[1], torch=True)
        pois[f"end_{d}"] = _poi(f"end_{d}", end[0], end[1], sign=True, kind="landmark")
    # 5 named (muster + 4 endpoints); 4 of them are frontier (degree 1)
    r = emc.grade(pois, muster=(0, 64, 0),
                  poi_target=5, sign_target=5, coverage_min=80,
                  quadrant_min=4, epic_status="done",
                  frontier_max=4)
    assert r["ok"], r["failures"]
    assert r["named_count"] == 5
    assert r["longest_path_len"] >= 80
    assert set(r["quadrant_union"]) == {"NE", "NW", "SE", "SW"}


# ── grade() failure surfaces ──


def test_grade_fails_when_too_few_named_pois(emc):
    pois = {"a": _poi("a", 50, 0, sign=True)}
    r = emc.grade(pois, muster=(0, 64, 0),
                  poi_target=6, sign_target=6, coverage_min=80,
                  quadrant_min=4, epic_status="done")
    assert not r["ok"]
    assert any("poi_count" in f for f in r["failures"])


def test_grade_fails_when_too_few_signs(emc):
    # 6 POIs total but only 2 with sign_at
    pois = {f"p{i}": _poi(f"p{i}", 30 + i * 5, -10 - i * 4,
                          sign=(i < 2), torch=True)
            for i in range(6)}
    r = emc.grade(pois, muster=(0, 64, 0),
                  poi_target=6, sign_target=6, coverage_min=80,
                  quadrant_min=4, epic_status="done")
    assert not r["ok"]
    assert any("sign_count" in f and "2" in f for f in r["failures"])


def test_grade_fails_when_longest_path_too_short(emc):
    """All POIs are within a tiny cluster (~5 blocks) — longest_path_len
    can't reach the 80-block bar even after traversing every node."""
    # 6 POIs packed into a 4×4 footprint; max single-step is ~5 blocks
    layout = [(0, 0), (3, 0), (5, 1), (1, 4), (4, 3), (2, 2)]
    pois = {
        f"p{i}": _poi(f"p{i}", x, z, sign=True, torch=True)
        for i, (x, z) in enumerate(layout)
    }
    r = emc.grade(pois, muster=(0, 64, 0),
                  poi_target=6, sign_target=6, coverage_min=80,
                  quadrant_min=1, epic_status="done",
                  frontier_max=99)  # allow any frontier shape
    assert not r["ok"]
    assert any("longest_path_len" in f for f in r["failures"])


def test_grade_fails_when_quadrants_concentrated(emc):
    pois = {f"p{i}": _poi(f"p{i}", 30 + i * 5, -30 - i * 4, sign=True)
            for i in range(6)}
    r = emc.grade(pois, muster=(0, 64, 0),
                  poi_target=6, sign_target=6, coverage_min=20,
                  quadrant_min=4, epic_status="done")
    assert not r["ok"]
    assert any("quadrant coverage" in f for f in r["failures"])
    assert r["quadrant_union"] == ["NE"]


def test_grade_fails_when_too_many_isolated_landmarks(emc):
    """6 named POIs, all far apart → all 6 are frontier. frontier_max=3."""
    pois = {
        f"p{i}": _poi(f"p{i}", 50 * (i + 1), 0, sign=True)
        for i in range(6)
    }
    r = emc.grade(pois, muster=(0, 64, 0),
                  poi_target=6, sign_target=6, coverage_min=20,
                  quadrant_min=1, epic_status="done", frontier_max=3)
    assert not r["ok"]
    assert any("named_frontier_count" in f for f in r["failures"])


def test_grade_fails_when_epic_not_done(emc):
    pois = {f"p{i}": _poi(f"p{i}", 30 + i * 5, -30 - i * 4, sign=True, torch=True)
            for i in range(6)}
    r = emc.grade(pois, muster=(0, 64, 0),
                  poi_target=6, sign_target=6, coverage_min=20,
                  quadrant_min=1, epic_status="running")
    assert not r["ok"]
    assert any("epic status" in f for f in r["failures"])


def test_grade_fails_when_epic_missing(emc):
    pois = {f"p{i}": _poi(f"p{i}", 30 + i * 5, -30 - i * 4, sign=True)
            for i in range(6)}
    r = emc.grade(pois, muster=(0, 64, 0),
                  poi_target=6, sign_target=6, coverage_min=20,
                  quadrant_min=1, epic_status=None)
    assert not r["ok"]
    assert any("[MAP:ARENA]" in f for f in r["failures"])


# ── grade() resilience ──


def test_grade_without_muster_flags_quadrant_failure(emc):
    pois = {f"p{i}": _poi(f"p{i}", i * 5, i * 5, sign=True, torch=True) for i in range(6)}
    r = emc.grade(pois, muster=None,
                  poi_target=6, sign_target=6, coverage_min=20,
                  quadrant_min=4, epic_status="done")
    assert not r["ok"]
    assert any("muster unavailable" in f for f in r["failures"])
    # Counts still surface
    assert r["poi_count"] == 6
    assert r["sign_count"] == 6


def test_grade_skips_malformed_pois(emc):
    pois = {
        "good": _poi("good", 50, -30, sign=True),
        "bad_str": "not a dict",
        "bad_no_coords": {"name": "bad_no_coords"},
        "bad_x_str": {"name": "bad_x_str", "x": "oops", "y": 64, "z": 5,
                      "sign_at": {"x": "oops", "y": 64, "z": 5}},
    }
    r = emc.grade(pois, muster=(0, 64, 0),
                  poi_target=1, sign_target=1, coverage_min=0,
                  quadrant_min=1, epic_status="done",
                  frontier_max=99)
    # poi_count includes the garbage (raw len). sign_count is the raw
    # "has a sign_at key" check, so it includes the malformed entry too —
    # the graph-aware named_count is what reflects validity.
    assert r["poi_count"] == 4
    assert r["sign_count"] == 2
    assert r["named_count"] == 1  # only `good` makes it into the graph


def test_grade_returns_longest_path_names(emc):
    """Chain of muster → wp1 → wp2 → endpoint. longest_path lists names."""
    pois = {
        "muster":   _poi("muster",   0,   0, sign=True),
        "wp1":      _poi("wp1",     20, -15, torch=True),
        "wp2":      _poi("wp2",     40, -30, torch=True),
        "endpoint": _poi("endpoint", 60, -45, sign=True),
    }
    r = emc.grade(pois, muster=(0, 64, 0),
                  poi_target=2, sign_target=2, coverage_min=70,
                  quadrant_min=1, epic_status="done")
    assert r["ok"], r["failures"]
    assert r["longest_path"] == ["muster", "wp1", "wp2", "endpoint"] or \
           r["longest_path"] == ["endpoint", "wp2", "wp1", "muster"]
    assert r["longest_path_len"] >= 70
