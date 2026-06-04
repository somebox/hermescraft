"""Tests for scripts/establish-mapping-check.py — mapping mission grader.

Exercises the pure `grade()` function with synthetic POI sets and the
`quadrant_of` axis convention so future renames don't silently flip NE/SW.
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


# ── quadrant_of axis convention ──


def test_quadrant_of_north_is_negative_z(emc):
    # MC convention: -z = north, +x = east.
    assert emc.quadrant_of(10, -5, 0, 0) == "NE"
    assert emc.quadrant_of(-10, -5, 0, 0) == "NW"
    assert emc.quadrant_of(10, 5, 0, 0) == "SE"
    assert emc.quadrant_of(-10, 5, 0, 0) == "SW"


def test_quadrant_of_origin_falls_into_SE(emc):
    # x=0, z=0 → dx>=0, dz>=0 → SE. Documents the tie-breaker so a
    # POI placed exactly at muster has a deterministic quadrant.
    assert emc.quadrant_of(0, 0, 0, 0) == "SE"


# ── grade() happy path ──


def test_grade_passes_with_full_coverage(emc):
    pois = {
        "spider_hill":   _poi("spider_hill",   30, -30, sign=True, kind="peak"),
        "balder_ruins":  _poi("balder_ruins",  -25, -25, sign=True, kind="ruin"),
        "sw_cave":       _poi("sw_cave",       -35, 30, sign=True, kind="cave"),
        "se_river":      _poi("se_river",      40, 30, sign=True, kind="river"),
        "n_torch":       _poi("n_torch",       10, -45, torch=True),
        "ne_torch":      _poi("ne_torch",      25, -10, torch=True),
        "sw_torch":      _poi("sw_torch",      -15, 25, torch=True),
        "se_torch":      _poi("se_torch",      20, 20, torch=True),
    }
    r = emc.grade(pois, muster=(0, 64, 0),
                  poi_target=8, sign_target=4, coverage_min=40,
                  quadrant_min=3, epic_status="done")
    assert r["ok"], r["failures"]
    assert r["poi_count"] == 8
    assert r["sign_count"] == 4
    assert r["torch_count"] == 4
    assert r["coverage_radius"] >= 40
    assert all(r["quadrant_coverage"][q] >= 1 for q in ("NE", "NW", "SE", "SW"))
    assert r["distinct_kinds"] == 4


# ── grade() failure surfaces ──


def test_grade_fails_when_too_few_pois(emc):
    pois = {"a": _poi("a", 50, 0, sign=True)}
    r = emc.grade(pois, muster=(0, 64, 0),
                  poi_target=8, sign_target=4, coverage_min=40,
                  quadrant_min=3, epic_status="done")
    assert not r["ok"]
    assert any("poi_count" in f for f in r["failures"])


def test_grade_fails_when_too_few_signs(emc):
    # 8 POIs but only 2 have sign_at — sign_target=4 should fail.
    pois = {f"p{i}": _poi(f"p{i}", 30 + i * 5, -10 - i * 4,
                          sign=(i < 2), torch=True)
            for i in range(8)}
    r = emc.grade(pois, muster=(0, 64, 0),
                  poi_target=8, sign_target=4, coverage_min=40,
                  quadrant_min=3, epic_status="done")
    assert not r["ok"]
    assert any("sign_count 2" in f for f in r["failures"])


def test_grade_fails_when_coverage_too_small(emc):
    # 8 POIs but all clustered within 10 blocks → coverage_radius < 40.
    pois = {f"p{i}": _poi(f"p{i}", i, -i, sign=True) for i in range(8)}
    r = emc.grade(pois, muster=(0, 64, 0),
                  poi_target=8, sign_target=4, coverage_min=40,
                  quadrant_min=3, epic_status="done")
    assert not r["ok"]
    assert any("coverage_radius" in f for f in r["failures"])


def test_grade_fails_when_quadrants_concentrated(emc):
    # 8 POIs, all in NE quadrant → quadrant_min=3 should fail.
    pois = {f"p{i}": _poi(f"p{i}", 30 + i * 5, -30 - i * 4, sign=True)
            for i in range(8)}
    r = emc.grade(pois, muster=(0, 64, 0),
                  poi_target=8, sign_target=4, coverage_min=40,
                  quadrant_min=3, epic_status="done")
    assert not r["ok"]
    assert any("quadrant coverage" in f for f in r["failures"])
    assert r["quadrant_coverage"]["NE"] == 8
    assert r["quadrant_coverage"]["NW"] == 0


def test_grade_fails_when_epic_not_done(emc):
    pois = {f"p{i}": _poi(f"p{i}", 30 + i * 5, -30 - i * 4, sign=True)
            for i in range(8)}
    r = emc.grade(pois, muster=(0, 64, 0),
                  poi_target=8, sign_target=4, coverage_min=40,
                  quadrant_min=3, epic_status="running")
    assert not r["ok"]
    assert any("epic status" in f for f in r["failures"])


def test_grade_fails_when_epic_missing(emc):
    pois = {f"p{i}": _poi(f"p{i}", 30 + i * 5, -30 - i * 4, sign=True)
            for i in range(8)}
    r = emc.grade(pois, muster=(0, 64, 0),
                  poi_target=8, sign_target=4, coverage_min=40,
                  quadrant_min=3, epic_status=None)
    assert not r["ok"]
    assert any("[MAP:ARENA]" in f for f in r["failures"])


# ── grade() resilience ──


def test_grade_without_muster_still_returns_counts_but_flags(emc):
    pois = {f"p{i}": _poi(f"p{i}", i, i, sign=True) for i in range(8)}
    r = emc.grade(pois, muster=None,
                  poi_target=8, sign_target=4, coverage_min=40,
                  quadrant_min=3, epic_status="done")
    assert not r["ok"]
    assert r["coverage_radius"] is None
    assert any("coverage_radius unavailable" in f for f in r["failures"])
    # Still reports poi_count + sign_count so the operator sees progress.
    assert r["poi_count"] == 8
    assert r["sign_count"] == 8


def test_grade_skips_malformed_pois(emc):
    pois = {
        "good": _poi("good", 50, -30, sign=True),
        "bad_str": "not a dict",
        "bad_no_coords": {"name": "bad_no_coords"},
        "bad_x_str": {"name": "bad_x_str", "x": "oops", "y": 64, "z": 5},
    }
    r = emc.grade(pois, muster=(0, 64, 0),
                  poi_target=1, sign_target=1, coverage_min=10,
                  quadrant_min=1, epic_status="done")
    assert r["poi_count"] == 4  # raw count includes garbage…
    assert r["sign_count"] == 1
    # …but only valid POIs influence coverage_radius / quadrant_coverage.
    assert r["coverage_radius"] >= 50
    assert r["quadrant_coverage"]["NE"] == 1
