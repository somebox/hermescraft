"""K2 route solver kernel (adaptive-road-planning §8.0.2).

Pure: samples in, Route out. No IO, no RCON, no bot.

    solve(samples, start, end, spec, weights=..., incumbent=..., path_width=...)

Samples are observed cells: {x, z, y (stand height), kind} with kind in
ground | water | gap | tree | clearance. Unobserved cells are UNTRAVERSABLE
— the solver never routes through terrain nobody has looked at; that is what
makes refinement (K3) demand-driven rather than optional.

Owned hard parts:
  - Construction edges: water/gap cells cost a bridge, big steps cost stairs,
    obstructed swaths cost clearing — so "build a bridge here" competes with
    "walk around" in one cost model. A ravine is NEVER a free crossing.
  - natural_path: cost of the best zero-construction route, None when no
    such route exists. Roads earn their cost via natural_path - route cost.
  - Swath rule: a cell is traversable only if the whole path-width swath
    around it is observed; obstructions anywhere in the swath gate the cell.
  - RDP + leg revalidation: simplified legs are re-walked cell by cell; a
    leg that would cut a corner through untraversable/unknown cells is split
    until every covered cell is finite.
  - Incumbent hysteresis: a re-solve keeps the incumbent route unless the
    challenger is better by more than `epsilon` — no flip-flop across
    refine rounds on cost ties.
"""
from __future__ import annotations

import heapq
from dataclasses import dataclass

DEFAULT_WEIGHTS = {
    "step": 0.25,      # per block of natural rise/fall on a walkable edge
    "stairs": 6.0,     # per block of rise/fall needing built steps
    "bridge": 8.0,     # per cell of water/gap decked over
    "clearing": 5.0,   # per cell whose swath needs felling/clearing
    "epsilon": 0.05,   # incumbent keeps the route unless challenger wins by this
    "rdp_tolerance": 1.5,
}

NEIGHBORS = ((1, 0), (-1, 0), (0, 1), (0, -1))


@dataclass
class Route:
    waypoints: list          # [(x, y, z), ...] simplified, revalidated
    cells: list              # [(x, z), ...] full path
    cost: float
    est_edits: int
    construction: list       # [{kind, at|from/to, ...}] per construction edge
    natural_path: float | None
    route_class: str         # natural | stairs | bridge | clearing


def index_samples(samples):
    return {(s["x"], s["z"]): s for s in samples}


def swath_state(idx, cell, direction, half):
    """Swath check PERPENDICULAR to travel: a road is path_width wide across
    its heading, not a square stamp (a square would demand samples beyond the
    line's own endpoints). None = some swath cell unobserved; otherwise
    'clear' | 'obstructed'."""
    dx, dz = direction
    px, pz = (0, 1) if abs(dx) >= abs(dz) else (1, 0)
    worst = "clear"
    for o in range(-half, half + 1):
        n = idx.get((cell[0] + px * o, cell[1] + pz * o))
        if n is None:
            return None
        if n["kind"] in ("tree", "clearance"):
            worst = "obstructed"
    return worst


def edge_cost(idx, a, b, spec, w, half, natural_only=False):
    """(cost, construction|None) for stepping a -> b, or None = no edge."""
    sa, sb = idx.get(a), idx.get(b)
    if sa is None or sb is None:
        return None
    direction = (b[0] - a[0], b[1] - a[1])
    sw = swath_state(idx, b, direction, half)
    if sw is None:
        return None
    if sa["kind"] in ("water", "gap") or sb["kind"] in ("water", "gap"):
        if natural_only:
            return None
        return 1 + w["bridge"], {"kind": "bridge", "edits": 1}
    if sw == "obstructed":
        if natural_only:
            return None
        return 1 + w["clearing"], {"kind": "clearing", "edits": 1}
    dy = sb["y"] - sa["y"]
    if dy > spec["max_step_up"] or -dy > spec["max_unguarded_drop"]:
        if natural_only:
            return None
        rise = abs(dy)
        return 1 + w["stairs"] * rise, {"kind": "stairs", "edits": int(-(-rise // 1))}
    return 1 + w["step"] * abs(dy), None


def _astar(idx, start, end, spec, w, half, natural_only=False):
    """Returns (cells, cost) or (None, None)."""
    if idx.get(start) is None or idx.get(end) is None:
        return None, None

    def h(c):
        return abs(c[0] - end[0]) + abs(c[1] - end[1])

    g = {start: 0.0}
    parent = {}
    counter = 0
    heap = [(h(start), counter, start)]
    closed = set()
    while heap:
        _, _, cur = heapq.heappop(heap)
        if cur in closed:
            continue
        if cur == end:
            cells = [cur]
            while cur in parent:
                cur = parent[cur]
                cells.append(cur)
            cells.reverse()
            return cells, g[end]
        closed.add(cur)
        for dx, dz in NEIGHBORS:
            nxt = (cur[0] + dx, cur[1] + dz)
            if nxt in closed:
                continue
            edge = edge_cost(idx, cur, nxt, spec, w, half, natural_only)
            if edge is None:
                continue
            ng = g[cur] + edge[0]
            if ng < g.get(nxt, float("inf")):
                g[nxt] = ng
                parent[nxt] = cur
                counter += 1
                heapq.heappush(heap, (ng + h(nxt), counter, nxt))
    return None, None


def path_cost(cells, idx, spec, w, half):
    """Cost + construction list of an explicit path. (None, None) if invalid."""
    if not cells:
        return None, None
    cost = 0.0
    construction = []
    for i in range(1, len(cells)):
        edge = edge_cost(idx, cells[i - 1], cells[i], spec, w, half)
        if edge is None:
            return None, None
        cost += edge[0]
        if edge[1] is not None:
            construction.append({**edge[1], "at": list(cells[i])})
    return cost, construction


def leg_traversable(idx, a, b, half):
    """Every cell under the straight leg a->b observed, swath included."""
    dx, dz = b[0] - a[0], b[1] - a[1]
    direction = (dx, dz) if (dx or dz) else (1, 0)
    for cell in line_cells(a, b):
        if idx.get(cell) is None:
            return False
        if swath_state(idx, cell, direction, half) is None:
            return False
    return True


def line_cells(a, b):
    """2D Bresenham, endpoints inclusive."""
    (x, z), (x1, z1) = a, b
    dx, dz = abs(x1 - x), abs(z1 - z)
    sx, sz = (1 if x < x1 else -1), (1 if z < z1 else -1)
    err = dx - dz
    cells = [(x, z)]
    while (x, z) != (x1, z1):
        e2 = 2 * err
        if e2 > -dz:
            err -= dz
            x += sx
        if e2 < dx:
            err += dx
            z += sz
        cells.append((x, z))
    return cells


def _perp_dist(p, a, b):
    (px, pz), (ax, az), (bx, bz) = p, a, b
    vx, vz = bx - ax, bz - az
    if vx == 0 and vz == 0:
        return ((px - ax) ** 2 + (pz - az) ** 2) ** 0.5
    return abs(vx * (az - pz) - (ax - px) * vz) / (vx * vx + vz * vz) ** 0.5


def _rdp_indices(cells, tol, lo=0, hi=None, keep=None):
    if hi is None:
        hi = len(cells) - 1
    if keep is None:
        keep = {lo, hi}
    if hi <= lo + 1:
        return keep
    far_i, far_d = None, tol
    for i in range(lo + 1, hi):
        d = _perp_dist(cells[i], cells[lo], cells[hi])
        if d > far_d:
            far_i, far_d = i, d
    if far_i is not None:
        keep.add(far_i)
        _rdp_indices(cells, tol, lo, far_i, keep)
        _rdp_indices(cells, tol, far_i, hi, keep)
    return keep


def _walk_elevations(cells, idx):
    """Per-path-cell walking elevation. Walkable cells keep their sampled
    y; water/gap cells (and y=None) take the linear interpolation between
    the nearest flanking walkable cells — the deck elevation a bridge
    over that span would use. Waypoints emitted at a pit/valley floor put
    torches underground relative to the route; the route walks the deck.
    """
    ys = [None] * len(cells)
    for i, c in enumerate(cells):
        s = idx[c]
        if s["kind"] not in ("water", "gap") and s["y"] is not None:
            ys[i] = s["y"]
    known = [i for i, v in enumerate(ys) if v is not None]
    if not known:
        return [idx[c]["y"] for c in cells]
    for i in range(len(ys)):
        if ys[i] is not None:
            continue
        prev = max((k for k in known if k < i), default=None)
        nxt = min((k for k in known if k > i), default=None)
        if prev is None:
            ys[i] = ys[nxt]
        elif nxt is None:
            ys[i] = ys[prev]
        else:
            t = (i - prev) / (nxt - prev)
            ys[i] = float(round(ys[prev] + t * (ys[nxt] - ys[prev])))
    return ys


def _revalidated_waypoint_indices(cells, idx, half, tol):
    """RDP, then split any leg whose straight line crosses untraversable
    cells — the corner-cut guard."""
    keep = sorted(_rdp_indices(cells, tol))
    out = [keep[0]]
    stack = [(keep[i], keep[i + 1]) for i in range(len(keep) - 1)][::-1]
    while stack:
        lo, hi = stack.pop()
        if leg_traversable(idx, cells[lo], cells[hi], half) or hi - lo <= 1:
            out.append(hi)
        else:
            mid = (lo + hi) // 2
            stack.append((mid, hi))
            stack.append((lo, mid))
    return out


def solve(samples, start, end, spec, weights=None, incumbent=None, path_width=None):
    w = {**DEFAULT_WEIGHTS, **(weights or {})}
    width = path_width if path_width is not None else spec["path_width"]
    half = (int(width) - 1) // 2
    idx = index_samples(samples)
    start, end = tuple(start), tuple(end)

    cells, cost = _astar(idx, start, end, spec, w, half)
    if cells is None:
        return None

    # Incumbent hysteresis: keep the standing route unless the challenger
    # is better by more than epsilon (relative).
    if incumbent is not None:
        inc_cells = [tuple(c) for c in
                     (incumbent.cells if isinstance(incumbent, Route) else incumbent)]
        inc_cost, _ = path_cost(inc_cells, idx, spec, w, half)
        if inc_cost is not None and cost >= inc_cost * (1 - w["epsilon"]):
            cells, cost = inc_cells, inc_cost

    cost, construction = path_cost(cells, idx, spec, w, half)
    _, natural_cost = _astar(idx, start, end, spec, w, half, natural_only=True)

    wp_idx = _revalidated_waypoint_indices(cells, idx, half, w["rdp_tolerance"])
    elev = _walk_elevations(cells, idx)
    waypoints = []
    for i in wp_idx:
        x, z = cells[i]
        waypoints.append((x, elev[i], z))

    by_kind = {}
    for c in construction:
        by_kind[c["kind"]] = by_kind.get(c["kind"], 0) + c["edits"]
    route_class = max(by_kind, key=by_kind.get) if by_kind else "natural"

    return Route(
        waypoints=waypoints,
        cells=[list(c) for c in cells],
        cost=cost,
        est_edits=sum(by_kind.values()),
        construction=construction,
        natural_path=natural_cost,
        route_class=route_class,
    )


GLYPHS = {"ground": ".", "water": "~", "gap": " ", "tree": "T", "clearance": "^"}


def render_ascii(samples, route=None):
    """Debugging eye: terrain glyph map with the route overlaid as o/W."""
    idx = index_samples(samples)
    xs = [s["x"] for s in samples]
    zs = [s["z"] for s in samples]
    on_route = {tuple(c) for c in (route.cells if route else [])}
    wps = {(x, z) for x, _, z in (route.waypoints if route else [])}
    lines = []
    for x in range(min(xs), max(xs) + 1):
        row = []
        for z in range(min(zs), max(zs) + 1):
            if (x, z) in wps:
                row.append("W")
            elif (x, z) in on_route:
                row.append("o")
            else:
                s = idx.get((x, z))
                row.append(GLYPHS.get(s["kind"], "?") if s else " ")
        lines.append("".join(row))
    return "\n".join(lines)
