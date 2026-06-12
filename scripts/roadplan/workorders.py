"""Compile surveyed construction legs into literal build commands (§6.5).

A leg that `confirm` refused (it needs construction) carries the survey's
`deficits` in `state.json`. This turns each deficit into a concrete `mc`
build verb — Y resolved from the route's deck elevation, ordered so the
ground is clear before it's graded and bridged. The planner hands these to
the build role; once the leg is rebuilt and re-surveyed to spec, `confirm`
lights it.

This is assembly, not a second classifier: the deficit *kinds* come from K1
(`walk-classify.js`), the *elevations* from the K2 route. The authoritative
leveling oracle is still `mc level_ground` dry-run (§6.5) — wiring its
dispositions in for fill_deep/deck spans is the next refinement; v1 emits a
single-grade `mc level` per dip and flags spans too wide for one call.

Pure: route + legs + spec in, command strings out. No IO, no bot.
"""
from __future__ import annotations

# mc level caps at 16 columns per call; a wider span splits into chunks.
LEVEL_COL_CAP = 16


def _interp_y(wp_a, wp_b, cell):
    """Deck elevation at `cell` (x,z), linearly between waypoints A and B by
    2D distance fraction. Falls back to A's Y when A==B."""
    ax, ay, az = wp_a
    bx, by, bz = wp_b
    span = abs(bx - ax) + abs(bz - az)
    if span == 0:
        return int(round(ay))
    t = (abs(cell[0] - ax) + abs(cell[1] - az)) / span
    t = max(0.0, min(1.0, t))
    return int(round(ay + t * (by - ay)))


def _split_span(fx, fz, tx, tz, cap=LEVEL_COL_CAP):
    """Split a from→to span into <=cap-column sub-rects along its long axis."""
    if abs(tx - fx) >= abs(tz - fz):
        lo, hi, fixed, horiz = min(fx, tx), max(fx, tx), (fz, tz), True
    else:
        lo, hi, fixed, horiz = min(fz, tz), max(fz, tz), (fx, tx), False
    out = []
    a = lo
    while a <= hi:
        b = min(a + cap - 1, hi)
        if horiz:
            out.append((a, fixed[0], b, fixed[1]))
        else:
            out.append((fixed[0], a, fixed[1], b))
        a = b + 1
    return out


def compile_leg(leg, wp_a, wp_b, spec):
    """Ordered build commands for one surveyed leg. Returns
    {from, to, orders[], deficits_n, split, est_minutes}. Empty orders =
    already to spec.

    Order: clear (trees, brush) → grade/fill dips → bridge gaps/water. Clearing
    first so leveling and bridging have open access; bridges last because they
    span the now-graded ground.
    """
    clears, grades, bridges, notes = [], [], [], []
    for d in leg.get("deficits", []):
        k = d.get("kind")
        if k == "tree":
            x, z = d["at"]
            clears.append(f"mc fell_tree {x} {d['base_y']} {z}")
        elif k == "clearance":
            (fx, fz), (tx, tz) = d["from"], d["to"]
            y = _interp_y(wp_a, wp_b, (fx, fz))
            for sx1, sz1, sx2, sz2 in _split_span(fx, fz, tx, tz):
                clears.append(f"mc clear_strip {sx1} {y} {sz1} {sx2} {y} {sz2}")
        elif k in ("gap", "water"):
            (fx, fz), (tx, tz) = d["from"], d["to"]
            if d.get("depth") is not None and k == "gap" \
                    and d["depth"] >= spec.get("no_floor_min_depth", 16):
                notes.append(
                    f"no-floor span ({fx},{fz})..({tx},{tz}) depth>="
                    f"{spec.get('no_floor_min_depth', 16)} — needs a bridge "
                    f"plan or reroute, not a fill")
                continue
            if d.get("width", 0) and d["width"] > spec.get("max_bridge", 8):
                notes.append(
                    f"span ({fx},{fz})..({tx},{tz}) width {d['width']} > "
                    f"max_bridge {spec.get('max_bridge', 8)} — reroute or "
                    f"multi-segment bridge")
                continue
            y = _interp_y(wp_a, wp_b, (fx, fz))
            for sx1, sz1, sx2, sz2 in _split_span(fx, fz, tx, tz):
                bridges.append(
                    f"mc level {sx1} {y} {sz1} {sx2} {y} {sz2} y={y}")
        elif k in ("step", "drop"):
            x, z = d["at"]
            y = _interp_y(wp_a, wp_b, (x, z))
            grades.append(f"mc level {x} {y} {z} {x} {y} {z} y={y}")
        elif k == "forbidden_floor":
            x, z = d["at"]
            y = _interp_y(wp_a, wp_b, (x, z))
            grades.append(f"mc dig {x} {y} {z}   # replace {d.get('block')}")
        elif k == "drop_hazard":
            x, z = d["at"]
            notes.append(f"drop hazard at ({x},{z}) — add a guard (deferred)")
    orders = clears + grades + bridges
    split = len(clears) > 0 and any("clear_strip" in c for c in clears)
    return {
        "from": leg.get("from"), "to": leg.get("to"),
        "orders": orders, "notes": notes,
        "deficits_n": len(leg.get("deficits", [])),
        "est_minutes": max(1, round(len(orders) * 0.7)),
    }


def _waypoints_for_leg(leg, waypoints):
    """The route waypoints flanking a leg, matched by from/to (x,z) within 2
    blocks; falls back to the nearest waypoints."""
    def nearest(xz):
        return min(waypoints,
                   key=lambda w: abs(w[0] - xz[0]) + abs(w[2] - xz[1]))
    a = nearest(leg["from"]) if leg.get("from") else waypoints[0]
    b = nearest(leg["to"]) if leg.get("to") else waypoints[-1]
    return a, b


def compile_workorders(state, spec, only_leg=None):
    """Per-leg work orders for every surveyed leg that still has deficits.
    Returns (leg_orders[], total_orders). `only_leg` = (from_xz, to_xz)
    restricts to one leg."""
    routes = state.get("routes") or []
    waypoints = [tuple(w) for w in routes[-1]["waypoints"]] if routes else []
    legs = state.get("legs") or []
    out = []
    for leg in legs:
        if only_leg and (tuple(leg.get("from") or ()) != tuple(only_leg[0])
                         or tuple(leg.get("to") or ()) != tuple(only_leg[1])):
            continue
        if not leg.get("deficits"):
            continue
        if not waypoints:
            continue
        a, b = _waypoints_for_leg(leg, waypoints)
        out.append(compile_leg(leg, a, b, spec))
    total = sum(len(lo["orders"]) for lo in out)
    return out, total
