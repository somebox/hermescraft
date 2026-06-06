from __future__ import annotations

import math
from typing import Iterable

from mapcatalog.models import Arena, Gate, OreHitsGate
from mapcatalog.models import BiomeCountGate, BiomeFractionGate
from mapcatalog.models import FlatPatchGate, HeightJitterGate, SurfaceBlockGate


def disc_grid_cells(
    arena: Arena,
    step: int,
    *,
    y_layers: int = 1,
) -> list[tuple[int, int, int]]:
    """Sample (x, y, z) cell centers on a square grid clipped to the arena disc."""
    cx, cz = arena.center
    r = arena.radius
    r2 = r * r
    cells: list[tuple[int, int, int]] = []
    y = 64
    for x in range(cx - r, cx + r + 1, step):
        for z in range(cz - r, cz + r + 1, step):
            if (x - cx) ** 2 + (z - cz) ** 2 > r2:
                continue
            for _ in range(y_layers):
                cells.append((x, y, z))
    return cells


def underground_sample_cells(gate: OreHitsGate, arena: Arena) -> list[tuple[int, int, int]]:
    cx, cz = arena.center
    r = arena.radius
    r2 = r * r
    step = gate.grid_step
    y0, y1 = gate.y_range
    cells: list[tuple[int, int, int]] = []
    for x in range(cx - r, cx + r + 1, step):
        for z in range(cz - r, cz + r + 1, step):
            if (x - cx) ** 2 + (z - cz) ** 2 > r2:
                continue
            for y in range(y0, y1 + 1, step):
                cells.append((x, y, z))
    return cells


def gate_sample_cell_count(gate: Gate, arena: Arena) -> int:
    if isinstance(gate, (BiomeFractionGate, BiomeCountGate)):
        return len(disc_grid_cells(arena, gate.grid_step))
    if isinstance(gate, (FlatPatchGate, HeightJitterGate, SurfaceBlockGate)):
        return len(disc_grid_cells(arena, gate.grid_step))
    if isinstance(gate, OreHitsGate):
        return len(underground_sample_cells(gate, arena))
    return 0


def estimate_pass2_materializations(find_max_seeds: int, pass1_yield: float = 0.05) -> int:
    """Rough upper bound on Pass 2 world creates for a find run."""
    return int(math.ceil(find_max_seeds * max(pass1_yield, 0.01)))


def summarize_sampling(gates: Iterable[Gate], arena: Arena) -> list[tuple[str, int, int]]:
    rows: list[tuple[str, int, int]] = []
    from mapcatalog.gates import gate_label

    for g in gates:
        rows.append((gate_label(g), g.pass_num, gate_sample_cell_count(g, arena)))
    return rows
