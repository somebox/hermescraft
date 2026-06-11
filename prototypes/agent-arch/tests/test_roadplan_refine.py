"""K3 refine-targeting kernel — sampling economics (Track K3).

Properties from adaptive-road-planning §8.0.2:
  - every request is a currently-unknown cell inside the survey bounds
  - ingesting answered requests strictly shrinks corridor unknowns
    (monotone convergence; refine -> [] once fully observed)
  - sample -> solve(incumbent) -> refine reaches the expected route class
    on every fixture in <=3 rounds with no tie flip-flop afterwards
  - budget is respected; truncation buys spine cells first
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from roadplan.fixtures import build_all, samples_from_fixture  # noqa: E402
from roadplan.refine import refine  # noqa: E402
from roadplan.solver import solve  # noqa: E402
from roadplan.spec import load_spec  # noqa: E402

SPEC = load_spec()


@pytest.fixture(scope="module")
def fixtures():
    return build_all()


def _full(fx):
    return {(s["x"], s["z"]): s for s in samples_from_fixture(fx, SPEC)}


def _sparse(full):
    """Coarse pass: every other z row observed (odd rows are holes)."""
    return {k: v for k, v in full.items() if k[1] % 2 == 0}


def _line(fx):
    return tuple(fx["line"]["from"]), tuple(fx["line"]["to"])


def _ingest(observed, full, requests):
    answered = 0
    for r in requests:
        key = (r["x"], r["z"])
        if key in full and key not in observed:
            observed[key] = full[key]
            answered += 1
    return answered


def test_requests_are_unknown_in_bounds_and_budgeted(fixtures):
    for name, fx in fixtures.items():
        full = _full(fx)
        observed = _sparse(full)
        start, end = _line(fx)
        for budget in (5, 64):
            reqs = refine(list(observed.values()), None, start, end, SPEC,
                          budget=budget)
            assert len(reqs) <= budget, name
            assert reqs, f"{name}: sparse corridor must demand samples"
            for r in reqs:
                key = (r["x"], r["z"])
                assert key not in observed, f"{name}: re-requested known cell {key}"
                assert key in full, f"{name}: request {key} outside the survey"


def test_truncated_round_buys_spine_first(fixtures):
    full = _full(fixtures["flat"])
    observed = _sparse(full)
    start, end = _line(fixtures["flat"])
    reqs = refine(list(observed.values()), None, start, end, SPEC, budget=5)
    assert all(r["x"] == start[0] for r in reqs), \
        "with a tight budget every request must sit on the line itself"


def test_ingesting_requests_strictly_shrinks_unknowns(fixtures):
    for name, fx in fixtures.items():
        full = _full(fx)
        observed = _sparse(full)
        start, end = _line(fx)
        route = None
        for _ in range(30):
            reqs = refine(list(observed.values()), route, start, end, SPEC,
                          budget=8)
            if not reqs:
                break
            unknown_before = len(full) - len(observed)
            answered = _ingest(observed, full, reqs)
            assert answered == len(reqs), f"{name}: unanswerable request emitted"
            assert len(full) - len(observed) < unknown_before, name
            route = solve(list(observed.values()), start, end, SPEC,
                          incumbent=route) or route
        else:
            pytest.fail(f"{name}: refinement demand never reached zero")


def test_converges_to_expected_class_within_three_rounds(fixtures):
    for name, fx in fixtures.items():
        full = _full(fx)
        observed = _sparse(full)
        start, end = _line(fx)
        expected = fx["annotations"]["expected_route_class"]
        route, rounds, converged_at = None, 0, None
        prev_cells = None
        while rounds < 6:
            reqs = refine(list(observed.values()), route, start, end, SPEC,
                          budget=64)
            if not reqs and route is not None:
                break
            rounds += 1
            _ingest(observed, full, reqs)
            route = solve(list(observed.values()), start, end, SPEC,
                          incumbent=route)
            cells = [tuple(c) for c in route.cells] if route else None
            if (route is not None and route.route_class == expected
                    and cells == prev_cells and converged_at is None):
                converged_at = rounds
            prev_cells = cells
        assert route is not None, f"{name}: never found a route"
        assert route.route_class == expected, (
            f"{name}: class {route.route_class} != {expected} after {rounds} rounds")
        stable_by = converged_at or rounds
        assert stable_by <= 3, f"{name}: converged at round {stable_by} (> 3)"

        # No flip-flop: fully observed, incumbent standing — re-solve must
        # keep the route verbatim and demand nothing further.
        rerun = solve(list(observed.values()), start, end, SPEC, incumbent=route)
        assert [tuple(c) for c in rerun.cells] == [tuple(c) for c in route.cells], \
            f"{name}: route flip-flopped on a no-new-information re-solve"
        assert refine(list(observed.values()), rerun, start, end, SPEC) == [], \
            f"{name}: refinement demand nonzero after full corridor observation"


def test_refine_empty_on_fully_observed_route(fixtures):
    fx = fixtures["flat"]
    full = _full(fx)
    start, end = _line(fx)
    route = solve(list(full.values()), start, end, SPEC)
    assert refine(list(full.values()), route, start, end, SPEC) == []


def test_no_observations_yields_no_requests():
    assert refine([], None, (0, 0), (0, 31), SPEC) == []
