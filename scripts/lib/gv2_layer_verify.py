"""verify_layer — read-only rcon acceptance gate for layered base building.

Pillar 2 of docs/architecture/base-build-layered.md. Probes a single build layer
(y = origin_y + offset) over a footprint and applies a per-layer gate:

  - "ground" (L0): every footprint+apron cell is solid AND drained (no air, no water).
  - "slab"   (L1): >= slab_min of footprint cells are built slab material.
  - "fixtures" (L2): each declared fixture is its expected block AND the cell directly
    below it is slab (no fixture-over-air/dirt — the gv2-2026-06-22-1 flood signature).

Pure read: uses `execute positioned X Y Z if block ~ ~ ~ <mat>` (returns to rcon, never
broadcasts to chat). `rcon_fn(world, cmds) -> str` is injected (genesis2_lib.rcon_in in
production; a fake in tests).
"""
from __future__ import annotations

from collections import Counter

# Priority-ordered; first match wins per cell. Air/water first so drainage gaps surface.
DEFAULT_MATERIALS = [
    "air", "water", "lava",
    "cobblestone", "cobblestone_slab", "stone", "stone_slab", "smooth_stone",
    "oak_planks", "oak_log", "dirt", "grass_block",
    "chest", "furnace", "crafting_table", "oak_door", "glass", "glass_pane", "torch",
]
# Built floor materials that count as a real slab (natural dirt/grass does NOT).
SLAB_MATERIALS = frozenset(
    {"cobblestone", "cobblestone_slab", "stone", "stone_slab", "smooth_stone", "oak_planks"}
)
EMPTY = frozenset({"air", "water", "lava"})


def _parse_passed_lines(out: str, n: int) -> list[bool]:
    """One result line per command; run_batch may prepend banner lines, so take the
    LAST n non-empty lines (robust to leading noise)."""
    lines = [ln for ln in (out or "").splitlines() if ln.strip()]
    tail = lines[-n:] if len(lines) >= n else lines
    return [("passed" in ln.lower()) for ln in tail]


def classify_cells(world, y, cells, rcon_fn, materials=DEFAULT_MATERIALS):
    """Return {(x,z): material|'unknown'} for each cell at height `y`. One rcon batch
    per material, in priority order; a cell keeps its first match."""
    known: dict[tuple[int, int], str] = {}
    for mat in materials:
        todo = [c for c in cells if c not in known]
        if not todo:
            break
        cmds = [f"execute positioned {x} {y} {z} if block ~ ~ ~ minecraft:{mat}" for (x, z) in todo]
        passed = _parse_passed_lines(rcon_fn(world, cmds), len(todo))
        for cell, ok in zip(todo, passed):
            if ok:
                known[cell] = mat
    for c in cells:
        known.setdefault(c, "unknown")
    return known


def rect_cells(origin, footprint, apron=0):
    """Footprint anchored with `origin` as the (min-x, min-z) corner, expanded by an
    `apron` ring. Returns absolute (x, z) cells."""
    ox, _oy, oz = origin
    w, d = footprint
    return [
        (ox + dx, oz + dz)
        for dz in range(-apron, d + apron)
        for dx in range(-apron, w + apron)
    ]


def verify_layer(
    *,
    origin,
    footprint,
    offset,
    gate,
    rcon_fn,
    world="genesis2",
    apron=0,
    fixtures=None,
    slab_materials=SLAB_MATERIALS,
    slab_min=0.95,
):
    """Probe one layer and apply `gate` ∈ {"ground","slab","fixtures"}.

    `fixtures` (for the "fixtures" gate): list of (x, z, expected_block).
    Returns {ok, gate, layer_y, total_cells, coverage, offenders, gate_failed}.
    """
    ox, oy, oz = origin
    layer_y = oy + offset

    if gate == "fixtures":
        if not fixtures:
            raise ValueError("fixtures gate requires a non-empty `fixtures` list")
        at_cells = [(x, z) for (x, z, _b) in fixtures]
        at = classify_cells(world, layer_y, at_cells, rcon_fn)
        below = classify_cells(world, layer_y - 1, at_cells, rcon_fn)
        coverage = Counter(at.values())
        offenders = []
        for (x, z, want) in fixtures:
            found = at[(x, z)]
            under = below[(x, z)]
            if found != want:
                offenders.append({"x": x, "y": layer_y, "z": z, "found": found, "expected": want})
            elif under not in slab_materials:
                offenders.append(
                    {"x": x, "y": layer_y - 1, "z": z, "found": under, "expected": "slab-under-fixture"}
                )
        ok = not offenders
        return {
            "ok": ok, "gate": gate, "layer_y": layer_y, "total_cells": len(fixtures),
            "coverage": dict(coverage), "offenders": offenders,
            "gate_failed": None if ok else f"{len(offenders)} fixture(s) wrong block or not on slab",
        }

    cells = rect_cells(origin, footprint, apron=apron if gate == "ground" else 0)
    cls = classify_cells(world, layer_y, cells, rcon_fn)
    coverage = Counter(cls.values())
    offenders = []
    ok = True
    gate_failed = None

    if gate == "ground":
        bad = [(x, z) for (x, z), m in cls.items() if m in EMPTY]
        if bad:
            ok = False
            gate_failed = f"L0 ground not solid+drained: {len(bad)}/{len(cells)} air/water/lava cells"
            offenders = [
                {"x": x, "y": layer_y, "z": z, "found": cls[(x, z)], "expected": "solid"}
                for (x, z) in bad
            ]
    elif gate == "slab":
        built = sum(1 for m in cls.values() if m in slab_materials)
        ratio = built / len(cells) if cells else 0.0
        if ratio < slab_min:
            ok = False
            gate_failed = f"L1 slab coverage {ratio:.2f} < {slab_min} ({built}/{len(cells)} built)"
            offenders = [
                {"x": x, "y": layer_y, "z": z, "found": m, "expected": "slab"}
                for (x, z), m in cls.items() if m not in slab_materials
            ]
    else:
        raise ValueError(f"unknown gate: {gate!r} (expected ground|slab|fixtures)")

    return {
        "ok": ok, "gate": gate, "layer_y": layer_y, "total_cells": len(cells),
        "coverage": dict(coverage), "offenders": offenders, "gate_failed": gate_failed,
    }
