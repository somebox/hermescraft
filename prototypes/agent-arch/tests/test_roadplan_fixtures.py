"""Terrain fixture corpus — Python contract + drift guard (Track F)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from roadplan.fixtures import (  # noqa: E402
    ALL_BUILDERS, FIXTURE_DIR, SCHEMA, build_all,
)
from roadplan.spec import load_spec  # noqa: E402

ROUTE_CLASSES = {"natural", "stairs", "bridge", "clearing"}
RUN_KINDS = {"walk", "climb", "descend", "water", "gap", "trees", "clearance"}


@pytest.fixture(scope="module")
def fixtures():
    return build_all()


def test_all_builders_schema_valid(fixtures):
    assert len(fixtures) == len(ALL_BUILDERS) == 9
    for name, fx in fixtures.items():
        assert fx["schema"] == SCHEMA
        assert fx["name"] == name
        assert fx["columns"], name
        for col in fx["columns"]:
            ys = [y for y, _ in col["blocks"]]
            assert ys == sorted(ys), f"{name} ({col['x']},{col['z']}): blocks not y-ascending"
            assert all(isinstance(b, str) for _, b in col["blocks"])
        ann = fx["annotations"]
        assert ann["expected_route_class"] in ROUTE_CLASSES, name
        assert set(ann["expected_run_kinds"]) <= RUN_KINDS, name
        assert isinstance(ann["deficits"], list), name
        assert isinstance(ann["walkable"], bool), name
        assert ann["walkable"] == (not ann["deficits"]), name


def test_committed_json_matches_builders(fixtures):
    """Drift guard: committed corpus must equal regenerated output."""
    for name, fx in fixtures.items():
        p = FIXTURE_DIR / f"{name}.json"
        assert p.exists(), f"missing committed fixture: {p} (run python -m roadplan.fixtures)"
        assert json.loads(p.read_text()) == fx, (
            f"{name}.json drifted from builder (run python -m roadplan.fixtures)")


def test_goldens_load_and_cover_corpus(fixtures):
    """Goldens are captured by node bot/scripts/capture-terrain-goldens.js;
    drift vs the oracle is guarded JS-side (terrain-goldens.test.js)."""
    golden_dir = FIXTURE_DIR / "goldens"
    for name, fx in fixtures.items():
        g = json.loads((golden_dir / f"{name}.golden.json").read_text())
        assert g["schema"] == "terrain-golden/v1"
        assert g["fixture"] == name
        assert len(g["columns"]) == len(fx["columns"])
        assert {c["action"] for c in g["columns"]} <= {
            "fill", "dig", "level", "preserve", "unknown"}


def test_construction_facts(fixtures):
    spec = load_spec()

    river = fixtures["river"]
    water = [b for c in river["columns"] for _, b in c["blocks"] if b == "water"]
    assert water, "river fixture must contain water blocks"
    assert river["annotations"]["deficits"][0]["width"] <= spec["max_bridge"]

    ravine_depth = fixtures["ravine"]["annotations"]["deficits"][0]["depth"]
    assert ravine_depth >= spec["no_floor_min_depth"]

    def center_surface(fx):
        tops = {}
        for c in fx["columns"]:
            if c["x"] == 0:
                tops[c["z"]] = max(y for y, b in c["blocks"] if b != "water")
        return [tops[z] for z in sorted(tops)]

    steps = center_surface(fixtures["dither"])
    assert all(abs(a - b) <= spec["max_step_up"] for a, b in zip(steps, steps[1:])), \
        "dither must stay within max_step_up by construction"

    over = fixtures["overhang"]
    shelf_cols = [c for c in over["columns"] if c["x"] == 0 and 8 <= c["z"] <= 15]
    for c in shelf_cols:
        ys = [y for y, _ in c["blocks"]]
        assert 64 in ys and 68 in ys and 65 not in ys, "overhang needs an air gap above ground"

    slabs = [b for c in fixtures["slab_stairs"]["columns"] for _, b in c["blocks"]
             if b == "oak_slab"]
    assert slabs, "slab_stairs fixture must contain slabs"
