"""Natural torch placement for route chains (RCON dev/test wire).

Doctrine: a route torch must stand on EXISTING ground — placement never
fabricates a base block. A node where no natural anchor exists near the
planned elevation is reported, not patched: that mismatch is the signal
(wrong Y, or a span that needs construction before it can be lit). The
production wire (`mc waypoint` → pickTorchAnchor) already behaves this
way; this module gives the RCON demo path the same contract.

Per waypoint (x, y, z):
  1. Find standable feet in the SAME column, nearest the planned y
     (|dy| <= span): cell passable + non-fluid, support block solid
     (matches no passable predicate — so never leaves/logs/canopy).
  2. Else try the lateral ring (r <= lateral_radius) at the same
     elevation tolerance — a torch one block beside a 1-wide pit lights
     the same route.
  3. Else report {status: "needs_construction"} and place nothing.

The only world edit is `setblock … minecraft:torch` (which may replace a
grass tuft in the torch cell — never a support block). Already-lit cells
report {status: "already_lit"} and are left untouched.
"""
from __future__ import annotations

from .rcon_adapter import (
    _PASSABLE_PREDICATES, _run_predicates,
)

_FLUID_PREDS = ("minecraft:water", "minecraft:lava")


def _candidate_ys(y, span):
    ys = [y]
    for d in range(1, span + 1):
        ys.extend((y + d, y - d))
    return ys


def standable_feet(client, world, x, z, y, *, span=4):
    """Feet Y nearest `y` where (x, feet, z) is passable non-fluid and
    (x, feet-1, z) is solid. None when no such Y within +/- span."""
    cand = _candidate_ys(int(y), span)
    probes = []
    for cy in cand:
        for pred in _PASSABLE_PREDICATES:
            probes.append(((x, z), cy, pred))
            probes.append(((x, z), cy - 1, pred))
    hits = _run_predicates(client, world, probes)
    passable = {}
    fluid = {}
    for ((px, pz), py, pred), hit in hits.items():
        if hit:
            passable[py] = True
            if pred in _FLUID_PREDS:
                fluid[py] = True
    for cy in cand:
        if passable.get(cy) and not fluid.get(cy) and not passable.get(cy - 1):
            return cy
    return None


def _ring(x, z, r):
    cells = []
    for dx in range(-r, r + 1):
        for dz in range(-r, r + 1):
            if max(abs(dx), abs(dz)) == r:
                cells.append((x + dx, z + dz))
    return cells


def place_chain(client, world, waypoints, *, span=2, lateral_radius=1):
    """Place torches for route waypoints on natural ground only.

    Returns one report per waypoint:
      {node, at, status: placed | already_lit | needs_construction}
    """
    reports = []
    for wx, wy, wz in waypoints:
        wy = int(wy)
        target = None
        feet = standable_feet(client, world, wx, wz, wy, span=span)
        if feet is not None:
            target = (wx, feet, wz)
        else:
            for r in range(1, lateral_radius + 1):
                best = None
                for cx, cz in _ring(wx, wz, r):
                    f = standable_feet(client, world, cx, cz, wy, span=span)
                    if f is not None and (best is None
                                          or abs(f - wy) < abs(best[1] - wy)):
                        best = (cx, f, cz)
                if best is not None:
                    target = best
                    break
        if target is None:
            reports.append({"node": [wx, wy, wz], "at": None,
                            "status": "needs_construction"})
            continue
        tx, ty, tz = target
        lit = _run_predicates(
            client, world, [((tx, tz), ty, "minecraft:torch")])
        if next(iter(lit.values())):
            reports.append({"node": [wx, wy, wz], "at": [tx, ty, tz],
                            "status": "already_lit"})
            continue
        client.run_batch(
            [f"execute in {world} run setblock {tx} {ty} {tz} minecraft:torch"])
        reports.append({"node": [wx, wy, wz], "at": [tx, ty, tz],
                        "status": "placed"})
    return reports
