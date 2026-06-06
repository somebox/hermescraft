from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from mapcatalog.gates import gate_label
from mapcatalog.models import (
    Arena,
    BiomeCountGate,
    BiomeFractionGate,
    Gate,
    Requirements,
)
from mapcatalog.server_config import ServerConfig


@dataclass
class BiomeScan:
    mc: str
    seed: str
    cell_count: int
    cells: list[dict]
    ran: bool = True
    binary: str = ""

    def biome_name(self, cell: dict) -> str:
        raw = str(cell.get("biome", ""))
        if raw.startswith("minecraft:"):
            return raw
        return f"minecraft:{raw}"

    def histogram(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for c in self.cells:
            name = self.biome_name(c)
            counts[name] = counts.get(name, 0) + 1
        return counts

    def fraction_in_allow(self, allow: list[str]) -> float:
        if not self.cells:
            return 0.0
        allow_set = {a if a.startswith("minecraft:") else f"minecraft:{a}" for a in allow}
        hit = sum(1 for c in self.cells if self.biome_name(c) in allow_set)
        return hit / len(self.cells)

    def distinct_biomes(self) -> set[str]:
        return {self.biome_name(c) for c in self.cells}


@dataclass
class Pass1Result:
    continue_pass2: bool
    reasons: list[str] = field(default_factory=list)
    metrics: dict[str, object] = field(default_factory=dict)
    audit: dict[str, object] = field(default_factory=dict)


def _normalize_mc_arg(mc_enum: str) -> str:
    return mc_enum.strip()


def run_biome_scan(
    cfg: ServerConfig,
    arena: Arena,
    seed: str,
    *,
    step: int = 16,
) -> BiomeScan | None:
    binary = cfg.cubiomes_binary
    if not binary:
        return None
    path = Path(binary)
    if not path.is_file():
        return None
    mc = _normalize_mc_arg(cfg.cubiomes_mc_enum or "MC_1_21")
    cx, cz = arena.center
    cmd = [
        str(path.resolve()),
        "--seed",
        seed,
        "--center",
        f"{cx},{cz}",
        "--radius",
        str(arena.radius),
        "--step",
        str(step),
        "--mc",
        mc,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(
            f"cubiomes scan failed ({proc.returncode}): {proc.stderr.strip() or proc.stdout[:200]}"
        )
    data = json.loads(proc.stdout)
    return BiomeScan(
        mc=str(data.get("mc", mc)),
        seed=str(data.get("seed", seed)),
        cell_count=int(data.get("cell_count", 0)),
        cells=list(data.get("cells") or []),
        binary=str(path),
    )


def _pass1_step_for_gates(gates: list[Gate]) -> int:
    step = 16
    for g in gates:
        if isinstance(g, (BiomeFractionGate, BiomeCountGate)):
            step = min(step, g.grid_step)
    return step


def evaluate_pass1(req: Requirements, cfg: ServerConfig, seed: str) -> Pass1Result:
    pass1_gates = [g for g in req.gates if g.pass_num == 1]
    if not pass1_gates:
        return Pass1Result(
            continue_pass2=True,
            audit={"skipped": True, "reason": "no pass1 gates"},
        )

    try:
        scan = run_biome_scan(cfg, req.arena, seed, step=_pass1_step_for_gates(req.gates))
    except RuntimeError as e:
        return Pass1Result(
            continue_pass2=False,
            reasons=[f"pass1 cubiomes: {e}"],
            audit={"error": str(e)},
        )

    if scan is None:
        return Pass1Result(
            continue_pass2=True,
            audit={
                "skipped": True,
                "reason": "cubiomes binary missing",
                "cubiomes_version": None,
            },
        )

    reasons: list[str] = []
    metrics: dict[str, object] = {}
    hist = scan.histogram()

    for g in pass1_gates:
        if isinstance(g, BiomeFractionGate):
            frac = scan.fraction_in_allow(g.allow)
            metrics["biome_fraction"] = frac
            metrics["biomes_seen"] = sorted(scan.distinct_biomes())
            if frac < g.min_fraction:
                reasons.append(
                    f"pass1: {gate_label(g)} (got {frac:.2%})"
                )
        elif isinstance(g, BiomeCountGate):
            distinct = len(scan.distinct_biomes())
            metrics["biome_distinct"] = distinct
            if g.max_distinct is not None and distinct > g.max_distinct:
                reasons.append(f"pass1: biomes distinct {distinct} > {g.max_distinct}")
            if g.min_distinct is not None and distinct < g.min_distinct:
                reasons.append(f"pass1: biomes distinct {distinct} < {g.min_distinct}")

    audit = {
        "cubiomes_version": scan.mc,
        "cubiomes_binary": scan.binary,
        "cell_count": scan.cell_count,
        "histogram": {k.split(":")[-1]: v for k, v in hist.items()},
        "rejected": bool(reasons),
    }

    return Pass1Result(
        continue_pass2=not reasons,
        reasons=reasons,
        metrics=metrics,
        audit=audit,
    )
