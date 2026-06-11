"""Phase-1 exit-gate property (adaptive-road-planning §1 Phase 1):

  > Visibility-mask rehearsal (anti-overfit guard for §10.1): re-run the
  > same solve with samples masked to sliding view-distance windows
  > along the route — simulating what a walking bot can actually see.
  > The solver must still converge to the same route class. RCON's
  > unlimited visibility must not become a hidden dependency.

We approximate "what a bot at point P sees" with an L∞ disc of radius
`view_distance` around P. The solver only ever gets cells inside the
union of those discs along its proposed line; we then verify K3
refinement still converges every fixture to the expected route class.

A failure here means K2 silently leaned on samples a walking bot would
never have collected — exactly the overfitting the plan warns about.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from roadplan.fixtures import build_all, samples_from_fixture  # noqa: E402
from roadplan.refine import refine  # noqa: E402
from roadplan.solver import line_cells, solve  # noqa: E402
from roadplan.spec import load_spec  # noqa: E402

SPEC = load_spec()


def _visible_mask(line_points, view_distance):
    """L∞ disc around each step on the line — what a bot walking the
    line can reach with a column-scan or chunk-loaded look-around."""
    visible = set()
    for px, pz in line_points:
        for dx in range(-view_distance, view_distance + 1):
            for dz in range(-view_distance, view_distance + 1):
                visible.add((px + dx, pz + dz))
    return visible


@pytest.fixture(scope="module")
def fixtures():
    return build_all()


@pytest.mark.parametrize("view_distance", [3, 5])
def test_visibility_masked_solve_keeps_route_class(fixtures, view_distance):
    """For every fixture, restrict observations to what a bot walking
    the start→end line could see and confirm sample→solve→refine still
    lands on the documented route class in ≤3 rounds — Phase 1 exit
    gate."""
    failures = []
    for name, fx in fixtures.items():
        full = {(s["x"], s["z"]): s for s in samples_from_fixture(fx, SPEC)}
        start = tuple(fx["line"]["from"])
        end = tuple(fx["line"]["to"])

        visible = _visible_mask(line_cells(start, end), view_distance)
        observed = {k: v for k, v in full.items() if k in visible}

        route, rounds = None, 0
        while rounds < 6:
            reqs = refine(list(observed.values()), route, start, end, SPEC,
                          budget=64)
            # Only answer requests the visibility mask permits — that's
            # the whole point of the rehearsal.
            answerable = [r for r in reqs if (r["x"], r["z"]) in visible
                          and (r["x"], r["z"]) in full]
            if not answerable and route is not None:
                break
            if not answerable:
                # No new information available — solve once with what we have.
                rounds += 1
                route = solve(list(observed.values()), start, end, SPEC,
                              incumbent=route) or route
                break
            for r in answerable:
                observed[(r["x"], r["z"])] = full[(r["x"], r["z"])]
            rounds += 1
            route = solve(list(observed.values()), start, end, SPEC,
                          incumbent=route)

        expected = fx["annotations"]["expected_route_class"]
        if route is None:
            failures.append(f"{name} (vd={view_distance}): no route")
        elif route.route_class != expected:
            failures.append(
                f"{name} (vd={view_distance}): {route.route_class} != {expected}")
        elif rounds > 3:
            failures.append(
                f"{name} (vd={view_distance}): converged at round {rounds} (> 3)")
    assert not failures, "\n".join(failures)
