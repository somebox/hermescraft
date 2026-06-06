from __future__ import annotations

import math
from dataclasses import dataclass, field

from mapcatalog.models import (
    Arena,
    BiomeCountGate,
    BiomeFractionGate,
    FlatPatchGate,
    Gate,
    HeightJitterGate,
    OreHitsGate,
    SurfaceBlockGate,
)
from mapcatalog.probe import (
    MAX_CMDS_PER_BATCH,
    blocks_match_batch,
    classify_air_probe_line,
    line_indicates_block_match,
)
from mapcatalog.rcon_client import SshDockerRcon
from mapcatalog.sampling import disc_grid_cells, underground_sample_cells


@dataclass
class ColumnSample:
    x: int
    z: int
    surface_y: int | None
    biome_tag: str | None = None


@dataclass
class ProbeMetrics:
    columns: list[ColumnSample] = field(default_factory=list)
    ore_hits: dict[str, list[tuple[int, int, int]]] = field(default_factory=dict)
    partial: bool = False
    probe_errors: list[str] = field(default_factory=list)

    def surface_heights(self) -> list[int]:
        return [c.surface_y for c in self.columns if c.surface_y is not None]


def _disc_xz(arena: Arena, step: int) -> list[tuple[int, int]]:
    cx, cz = arena.center
    r = arena.radius
    r2 = r * r
    out: list[tuple[int, int]] = []
    for x in range(cx - r, cx + r + 1, step):
        for z in range(cz - r, cz + r + 1, step):
            if (x - cx) ** 2 + (z - cz) ** 2 <= r2:
                out.append((x, z))
    return out


def _batch_chunks(cmds: list[str], size: int = MAX_CMDS_PER_BATCH) -> list[list[str]]:
    return [cmds[i : i + size] for i in range(0, len(cmds), size)]


def find_surface_heights(
    client: SshDockerRcon,
    world: str,
    columns: list[tuple[int, int]],
    *,
    y_lo: int = 48,
    y_hi: int = 319,
    y_step: int = 2,
) -> dict[tuple[int, int], int | None]:
    """Feet Y per column: scan downward for first non-air block, feet at y+1.

    ``y_hi`` defaults to 319 (max block Y on 1.21+). OOB probe lines are treated
    as "still air" so a scan starting too high does not pin every column to y+1.
    """
    heights: dict[tuple[int, int], int | None] = {c: None for c in columns}
    pending = list(columns)
    for y in range(y_hi, y_lo - 1, -y_step):
        if not pending:
            break
        cmds = [
            f"execute in {world} if block {x} {y} {z} #minecraft:air" for x, z in pending
        ]
        still: list[tuple[int, int]] = []
        for chunk_start in range(0, len(cmds), MAX_CMDS_PER_BATCH):
            chunk = cmds[chunk_start : chunk_start + MAX_CMDS_PER_BATCH]
            chunk_cols = pending[chunk_start : chunk_start + MAX_CMDS_PER_BATCH]
            out = client.run_batch(chunk)
            lines = (out or "").splitlines()
            for i, (x, z) in enumerate(chunk_cols):
                line = lines[i] if i < len(lines) else ""
                kind = classify_air_probe_line(line)
                if kind == "solid":
                    heights[(x, z)] = y + 1
                else:
                    still.append((x, z))
        pending = still
    return heights


def probe_biome_cell(
    client: SshDockerRcon,
    world: str,
    x: int,
    y: int,
    z: int,
    biome_id: str,
) -> bool:
    bid = biome_id if biome_id.startswith("minecraft:") else f"minecraft:{biome_id}"
    out = client.run(f"execute in {world} positioned {x} {y} {z} if biome {bid}")
    return line_indicates_block_match(out)


def probe_biome_fraction_at_surface(
    client: SshDockerRcon,
    world: str,
    columns: list[ColumnSample],
    allow: list[str],
) -> tuple[float, set[str], dict[str, str]]:
    """Biome checks at each column's heightmap Y (top solid block), not fixed sample_y.

    On 1.21+ mountainous terrain, Y=64 is often inside cave biomes (lush_caves); surface
    overworld biomes only match at the actual surface block.
    """
    valid = [c for c in columns if c.surface_y is not None]
    if not valid:
        return 0.0, set(), {}
    matched = 0
    seen: set[str] = set()
    per_cell: dict[str, str] = {}
    for c in valid:
        y_probe = c.surface_y - 1
        cell_biome: str | None = None
        for bid in allow:
            if probe_biome_cell(client, world, c.x, y_probe, c.z, bid):
                cell_biome = bid
                break
        key = f"{c.x},{c.z}"
        if cell_biome:
            matched += 1
            seen.add(cell_biome)
            per_cell[key] = cell_biome
        else:
            per_cell[key] = ""
    return matched / len(valid), seen, per_cell


def probe_distinct_biomes_at_surface(
    client: SshDockerRcon,
    world: str,
    columns: list[ColumnSample],
    *,
    tags: tuple[str, ...] = (
        "plains",
        "forest",
        "meadow",
        "taiga",
        "desert",
        "ocean",
        "river",
        "swamp",
        "jungle",
        "savanna",
        "windswept_hills",
        "stony_peaks",
    ),
) -> set[str]:
    seen: set[str] = set()
    for c in columns:
        if c.surface_y is None:
            continue
        y_probe = c.surface_y - 1
        for tag in tags:
            if probe_biome_cell(client, world, c.x, y_probe, c.z, tag):
                seen.add(tag)
                break
    return seen


def probe_biome_fraction(
    client: SshDockerRcon,
    world: str,
    columns: list[tuple[int, int]],
    allow: list[str],
    sample_y: int,
) -> tuple[float, set[str]]:
    """Deprecated path — prefer probe_biome_fraction_at_surface with ColumnSamples."""
    del sample_y
    stub = [ColumnSample(x=x, z=z, surface_y=64) for x, z in columns]
    frac, seen, _ = probe_biome_fraction_at_surface(client, world, stub, allow)
    return frac, seen


def collect_probe_metrics(
    client: SshDockerRcon,
    world: str,
    arena: Arena,
    gates: list[Gate],
) -> ProbeMetrics:
    metrics = ProbeMetrics()
    surface_step = 16
    for g in gates:
        if isinstance(g, (BiomeFractionGate, BiomeCountGate, FlatPatchGate, HeightJitterGate, SurfaceBlockGate)):
            surface_step = min(surface_step, getattr(g, "grid_step", 16))

    columns_xz = _disc_xz(arena, surface_step)
    heights = find_surface_heights(client, world, columns_xz)
    for x, z in columns_xz:
        metrics.columns.append(ColumnSample(x=x, z=z, surface_y=heights.get((x, z))))

    for g in gates:
        if isinstance(g, OreHitsGate):
            cells = underground_sample_cells(g, arena)
            block = g.block.replace("minecraft:", "")
            hits = [
                c
                for c, ok in zip(
                    cells,
                    blocks_match_batch(client, world, cells, block),
                )
                if ok
            ]
            metrics.ore_hits[g.block] = hits

    return metrics


def _largest_flat_component(columns: list[ColumnSample], max_delta: int) -> int:
    """Connected components on grid where |ΔY| <= max_delta between neighbors."""
    by_key = {(c.x, c.z): c for c in columns if c.surface_y is not None}
    if not by_key:
        return 0
    visited: set[tuple[int, int]] = set()
    best = 0
    for start in by_key:
        if start in visited:
            continue
        stack = [start]
        comp = 0
        visited.add(start)
        while stack:
            x, z = stack.pop()
            comp += 1
            y0 = by_key[(x, z)].surface_y
            for dx, dz in ((16, 0), (-16, 0), (0, 16), (0, -16)):
                nb = (x + dx, z + dz)
                if nb not in by_key or nb in visited:
                    continue
                y1 = by_key[nb].surface_y
                if y0 is not None and y1 is not None and abs(y0 - y1) <= max_delta:
                    visited.add(nb)
                    stack.append(nb)
        best = max(best, comp)
    return best


def _mean_neighbor_height_delta(columns: list[ColumnSample]) -> float:
    by_key = {(c.x, c.z): c.surface_y for c in columns if c.surface_y is not None}
    deltas: list[float] = []
    for (x, z), y in by_key.items():
        for dx, dz in ((16, 0), (-16, 0), (0, 16), (0, -16)):
            nb = (x + dx, z + dz)
            if nb in by_key and by_key[nb] is not None:
                deltas.append(abs(y - by_key[nb]))
    return sum(deltas) / len(deltas) if deltas else 999.0


def _surface_block_fraction(
    client: SshDockerRcon,
    world: str,
    columns: list[ColumnSample],
    block: str,
) -> float:
    cells: list[tuple[int, int, int]] = []
    for c in columns:
        if c.surface_y is None:
            continue
        cells.append((c.x, c.surface_y - 1, c.z))
    if not cells:
        return 0.0
    hits = sum(
        1
        for ok in blocks_match_batch(client, world, cells, block)
        if ok
    )
    return hits / len(cells)


@dataclass
class GateEvalResult:
    passed: bool
    reasons: list[str]
    metrics: dict[str, object]
    metrics_summary: dict[str, object]
    score: float


def evaluate_gates(
    client: SshDockerRcon,
    world: str,
    arena: Arena,
    gates: list[Gate],
    metrics: ProbeMetrics,
) -> GateEvalResult:
    """Apply live Pass 2 gates only (``pass_num == 2``).

    Pass 1 biome gates are evaluated offline in ``pass1.evaluate_pass1``;
    optional ``verify_live`` compares cubiomes to live sparse samples after
    materialize — not via this function.
    """
    reasons: list[str] = []
    full: dict[str, object] = {}
    summary: dict[str, object] = {}
    score_parts: list[float] = []

    columns_xz = [(c.x, c.z) for c in metrics.columns]

    for g in gates:
        if getattr(g, "pass_num", 2) != 2:
            continue
        if isinstance(g, BiomeFractionGate):
            frac, seen, _per = probe_biome_fraction_at_surface(
                client, world, metrics.columns, g.allow
            )
            full["biome_fraction"] = frac
            full["biomes_seen"] = sorted(seen)
            summary["biomes"] = {b.split(":")[-1]: frac for b in seen}
            if frac < g.min_fraction:
                reasons.append(
                    f"biome fraction {frac:.2%} < {g.min_fraction:.2%}"
                )
            else:
                score_parts.append(min(1.0, frac / g.min_fraction))

        elif isinstance(g, BiomeCountGate):
            seen_all = probe_distinct_biomes_at_surface(client, world, metrics.columns)
            distinct = len(seen_all)
            full["biome_distinct"] = distinct
            full["biomes_seen"] = sorted(seen_all)
            if g.max_distinct is not None and distinct > g.max_distinct:
                reasons.append(f"biomes distinct {distinct} > {g.max_distinct}")
            if g.min_distinct is not None and distinct < g.min_distinct:
                reasons.append(f"biomes distinct {distinct} < {g.min_distinct}")
            if not reasons:
                score_parts.append(0.5)

        elif isinstance(g, FlatPatchGate):
            n = _largest_flat_component(metrics.columns, max_delta=2)
            full["flat_patch_cells"] = n
            summary["flat_patch_cells"] = n
            if n < g.min_cells:
                reasons.append(f"flat patch {n} cells < {g.min_cells}")

        elif isinstance(g, HeightJitterGate):
            jitter = _mean_neighbor_height_delta(metrics.columns)
            full["height_jitter"] = jitter
            if jitter > g.max_blocks:
                reasons.append(f"neighbor height delta {jitter:.2f} > {g.max_blocks}")

        elif isinstance(g, SurfaceBlockGate):
            frac = _surface_block_fraction(client, world, metrics.columns, g.block)
            key = f"surface_{g.block}"
            full[key] = frac
            if g.max_fraction is not None and frac > g.max_fraction:
                reasons.append(f"surface {g.block} {frac:.2%} > {g.max_fraction:.2%}")
            if g.min_fraction is not None and frac < g.min_fraction:
                reasons.append(f"surface {g.block} {frac:.2%} < {g.min_fraction:.2%}")

        elif isinstance(g, OreHitsGate):
            hits = metrics.ore_hits.get(g.block, [])
            n = len(hits)
            key = g.block.replace("minecraft:", "") + "_hits"
            full[key] = n
            summary[key] = n
            if g.min_hits is not None and n < g.min_hits:
                reasons.append(f"{g.block} hits {n} < {g.min_hits}")
            if g.max_hits is not None and n > g.max_hits:
                reasons.append(f"{g.block} hits {n} > {g.max_hits}")

    if metrics.partial:
        reasons.append("partial probe failure")

    score = sum(score_parts) / len(score_parts) if score_parts else 0.0
    return GateEvalResult(
        passed=not reasons,
        reasons=reasons,
        metrics=full,
        metrics_summary=summary,
        score=round(score, 4),
    )
