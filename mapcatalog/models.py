from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Arena:
    center: tuple[int, int]
    radius: int


@dataclass
class BiomeFractionGate:
    """Pass 1 only (offline cubiomes). Pass 2 must not re-check; see ``pass_num``."""

    allow: list[str]
    min_fraction: float
    sample_y: int = 64
    grid_step: int = 16

    @property
    def pass_num(self) -> int:
        """1 = offline prediction; 2 = live confirmation (flat, ore, surface, …)."""
        return 1


@dataclass
class BiomeCountGate:
    """Pass 1 only — distinct biome count from cubiomes histogram."""
    max_distinct: int | None = None
    min_distinct: int | None = None
    sample_y: int = 64
    grid_step: int = 16

    @property
    def pass_num(self) -> int:
        return 1


@dataclass
class FlatPatchGate:
    """Pass 2 — live heightmap flat component size."""
    min_cells: int
    grid_step: int = 16

    @property
    def pass_num(self) -> int:
        return 2


@dataclass
class HeightJitterGate:
    max_blocks: float
    grid_step: int = 16

    @property
    def pass_num(self) -> int:
        return 2


@dataclass
class SurfaceBlockGate:
    block: str
    min_fraction: float | None = None
    max_fraction: float | None = None
    grid_step: int = 16

    @property
    def pass_num(self) -> int:
        return 2


@dataclass
class OreHitsGate:
    block: str
    min_hits: int | None = None
    max_hits: int | None = None
    y_range: tuple[int, int] = (-64, 320)
    grid_step: int = 8

    @property
    def pass_num(self) -> int:
        return 2


Gate = (
    BiomeFractionGate
    | BiomeCountGate
    | FlatPatchGate
    | HeightJitterGate
    | SurfaceBlockGate
    | OreHitsGate
)


@dataclass
class PlacementSpec:
    name: str
    method: str
    radius: int | None = None
    attempts: int | None = None
    offset_from: str | None = None
    offset: tuple[int, int, int] | None = None
    near_block: str | None = None
    near_gate: str | None = None
    within: float | None = None
    within_unit: str | None = None  # cells | blocks
    in_biome: str | None = None
    raw: str | dict[str, Any] = field(default_factory=dict)


@dataclass
class FindSpec:
    solutions: int = 5
    max_seeds: int = 200
    seed_candidates: list[str] = field(default_factory=list)


@dataclass
class Requirements:
    id: str
    path: str
    arena: Arena
    gates: list[Gate]
    placements: list[PlacementSpec]
    find: FindSpec
    extends: str | None = None
    server_path: str | None = None
    minecraft_version: str | None = None
    prep: list[str] = field(default_factory=list)
    source_lines: dict[str, Any] = field(default_factory=dict)
