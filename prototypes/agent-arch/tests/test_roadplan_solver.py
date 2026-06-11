"""K2 route solver kernel — fixture goldens + invariants (Track K2).

Invariants from adaptive-road-planning §8.0.2:
  - golden route-class per fixture
  - every cell under every simplified leg has finite cost
  - ravine -> bridge edge, never a free crossing
  - natural_path is None exactly when the fixture is not walkable
  - incumbent wins cost ties (no flip-flop across refine rounds)
  - RDP never cuts a corner through unknown cells
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from roadplan.fixtures import build_all, samples_from_fixture  # noqa: E402
from roadplan.solver import (  # noqa: E402
    index_samples, leg_traversable, render_ascii, solve,
)
from roadplan.spec import load_spec  # noqa: E402

SPEC = load_spec()


@pytest.fixture(scope="module")
def fixtures():
    return build_all()


def _solve_fixture(fx, **kw):
    samples = samples_from_fixture(fx, SPEC)
    return solve(samples, fx["line"]["from"], fx["line"]["to"], SPEC, **kw), samples


def test_route_class_golden_per_fixture(fixtures):
    for name, fx in fixtures.items():
        route, _ = _solve_fixture(fx)
        assert route is not None, f"{name}: no route found"
        assert route.route_class == fx["annotations"]["expected_route_class"], name
        if fx["annotations"]["walkable"]:
            assert route.natural_path is not None, f"{name}: walkable but no natural path"
            assert route.est_edits == 0, f"{name}: walkable terrain needs no edits"
        else:
            assert route.natural_path is None, f"{name}: deficit terrain has a free path"
            assert route.est_edits > 0, name


def test_simplified_legs_have_finite_cost(fixtures):
    half = (SPEC["path_width"] - 1) // 2
    for name, fx in fixtures.items():
        route, samples = _solve_fixture(fx)
        idx = index_samples(samples)
        wps = [(x, z) for x, _, z in route.waypoints]
        assert wps[0] == tuple(fx["line"]["from"]), name
        assert wps[-1] == tuple(fx["line"]["to"]), name
        for a, b in zip(wps, wps[1:]):
            assert leg_traversable(idx, a, b, half), (
                f"{name}: simplified leg {a}->{b} covers untraversable cells")


def test_ravine_is_bridged_never_free(fixtures):
    route, samples = _solve_fixture(fixtures["ravine"])
    gap_cells = {(s["x"], s["z"]) for s in samples if s["kind"] == "gap"}
    crossed = [tuple(c) for c in route.cells if tuple(c) in gap_cells]
    assert crossed, "route must cross the ravine somewhere"
    bridged = {tuple(c["at"]) for c in route.construction if c["kind"] == "bridge"}
    for cell in crossed:
        assert cell in bridged, f"gap cell {cell} crossed without a bridge edge"
    flat_route, _ = _solve_fixture(fixtures["flat"])
    assert route.cost > flat_route.cost, "bridging must cost more than flat ground"


def test_incumbent_wins_cost_ties(fixtures):
    fx = fixtures["flat"]
    samples = samples_from_fixture(fx, SPEC)
    start, end = (-2, 0), (2, 31)  # both axes differ -> many equal-cost paths
    # width 1 disables the swath rule so corridor-edge lanes are usable.
    base = solve(samples, start, end, SPEC, path_width=1)
    # An equal-cost alternative: a different monotone staircase to the goal.
    alt = [start]
    x, z = start
    while z < 28:
        z += 1
        alt.append((x, z))
    while x < 2:
        x += 1
        alt.append((x, z))
    while z < 31:
        z += 1
        alt.append((x, z))
    rerun = solve(samples, start, end, SPEC, path_width=1, incumbent=alt)
    assert [tuple(c) for c in rerun.cells] == alt, "tie must keep the incumbent"
    assert rerun.cost == base.cost

    # A strictly worse incumbent (detour beyond epsilon) must be replaced.
    detour = [start] + [(-2, z) for z in range(1, 32)] \
        + [(-1, 31), (-1, 30), (0, 30), (0, 31), (1, 31), (2, 31)]
    replaced = solve(samples, start, end, SPEC, path_width=1, incumbent=detour)
    assert [tuple(c) for c in replaced.cells] != detour
    assert replaced.cost == base.cost


def test_rdp_never_cuts_corners_through_unknown():
    # An L-shaped known corridor; the hypotenuse is unobserved. With a large
    # RDP tolerance the corner point would be dropped — revalidation must
    # keep the leg cells finite by reinserting interior points.
    samples = []
    for z in range(0, 9):
        for x in (-1, 0, 1):
            samples.append({"x": x, "z": z, "y": 65.0, "kind": "ground"})
    for x in range(2, 9):
        for z in (7, 8):
            samples.append({"x": x, "z": z, "y": 65.0, "kind": "ground"})
    for x in range(2, 9):
        samples.append({"x": x, "z": 6, "y": 65.0, "kind": "ground"})
    route = solve(samples, (0, 0), (8, 7), SPEC, path_width=1,
                  weights={"rdp_tolerance": 50.0})
    assert route is not None
    idx = index_samples(samples)
    wps = [(x, z) for x, _, z in route.waypoints]
    assert len(wps) > 2, "corner must survive simplification"
    for a, b in zip(wps, wps[1:]):
        assert leg_traversable(idx, a, b, 0), f"leg {a}->{b} cut through unknown cells"


def test_unknown_cells_are_untraversable():
    samples = [{"x": 0, "z": z, "y": 65.0, "kind": "ground"} for z in (0, 1, 3, 4)]
    assert solve(samples, (0, 0), (0, 4), SPEC, path_width=1) is None, \
        "a one-cell observation hole must break the route, not be guessed over"


def test_render_ascii_smoke(fixtures):
    route, samples = _solve_fixture(fixtures["river"])
    art = render_ascii(samples, route)
    assert "~" in art and "o" in art and "W" in art
    assert len(art.splitlines()) == 5  # strip is 5 columns wide
