"""K3 refine-targeting kernel (adaptive-road-planning §8.0.2).

Pure: samples + route in, sample requests out. No IO, no RCON, no bot.

    refine(samples, route, start, end, spec, budget=..., path_width=...)
        -> [{"x", "z", "reason"}, ...]      ([] with a route == converged)

Sampling economics owned here:
  - Unknown cells are untraversable to the solver (K2), so refinement is
    demand-driven: every request is a currently-unobserved cell whose
    observation either lets a route exist at all (reason "corridor") or
    lets the standing route be validated and improved (reasons "swath",
    "shoulder" — shoulders carry drop hazards and the one-lane-over
    alternatives the solver may prefer to construction).
  - No route yet -> fill the straight-line corridor start->end at swath
    width: the cheapest hypothesis is a straight path, and the solver can
    only argue otherwise about terrain somebody has looked at.
  - Requests stay inside the bounding box of existing observations plus the
    line endpoints. Expanding the survey frontier is the coarse sampler's
    job (§6.1) — an out-of-survey request may be unanswerable and would
    stall convergence forever.
  - Ring-major priority: spine cells (r=0) across the whole line first,
    then each wider ring — a budget-truncated round still buys the most
    route-critical cells.

Every request being unknown-by-construction is what makes convergence
monotone: ingesting any answered request strictly shrinks the corridor's
unknown count, and refine returns [] once the corridor is fully observed.
"""
from __future__ import annotations

from .solver import Route, index_samples, line_cells


def corridor_cells(route, start, end, half):
    """(base_cells, radius) the current round cares about. No route: the
    straight line at swath radius. Route: its cells at swath+shoulder."""
    if route is None:
        return line_cells(tuple(start), tuple(end)), half
    cells = route.cells if isinstance(route, Route) else route
    return [tuple(c) for c in cells], half + 1


def refine(samples, route, start, end, spec, budget=32, path_width=None):
    width = path_width if path_width is not None else spec["path_width"]
    half = (int(width) - 1) // 2
    idx = index_samples(samples)
    if not idx:
        return []  # nothing observed yet — coarse sampling (§6.1) goes first

    xs = [s["x"] for s in samples] + [start[0], end[0]]
    zs = [s["z"] for s in samples] + [start[1], end[1]]
    x_lo, x_hi, z_lo, z_hi = min(xs), max(xs), min(zs), max(zs)

    base, radius = corridor_cells(route, start, end, half)

    seen, requests = set(), []
    for r in range(radius + 1):
        if route is None:
            reason = "corridor"
        else:
            reason = "swath" if r <= half else "shoulder"
        ring = [(ox, oz) for ox in range(-r, r + 1) for oz in range(-r, r + 1)
                if max(abs(ox), abs(oz)) == r]
        for bx, bz in base:
            for ox, oz in ring:
                cell = (bx + ox, bz + oz)
                if cell in seen:
                    continue
                seen.add(cell)
                if not (x_lo <= cell[0] <= x_hi and z_lo <= cell[1] <= z_hi):
                    continue
                if cell in idx:
                    continue
                requests.append({"x": cell[0], "z": cell[1], "reason": reason})
                if len(requests) >= budget:
                    return requests
    return requests
