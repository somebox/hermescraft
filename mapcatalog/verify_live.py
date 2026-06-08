from __future__ import annotations

import hashlib
import random

from mapcatalog.metrics import ColumnSample, find_surface_heights, probe_biome_fraction_at_surface
from mapcatalog.models import Arena, BiomeFractionGate, Requirements
from mapcatalog.pass1_options import Pass1Options
from mapcatalog.pass1 import Pass1Result
from mapcatalog.rcon_protocol import RconClient


def _allow_from_requirements(req: Requirements) -> list[str]:
    allow: list[str] = []
    for g in req.gates:
        if isinstance(g, BiomeFractionGate):
            allow = list(g.allow)
            break
    return allow


def should_run_verify_live(
    p1: Pass1Result,
    req: Requirements,
    opts: Pass1Options,
) -> bool:
    if not opts.verify_live:
        return False
    if not _allow_from_requirements(req):
        return False
    if p1.audit.get("skipped"):
        return False
    if not p1.continue_pass2:
        return False
    if opts.verify_live_when == "always":
        return True
    frac = float(p1.metrics.get("biome_fraction", 0.0))
    for g in req.gates:
        if isinstance(g, BiomeFractionGate):
            return g.min_fraction <= frac <= g.min_fraction + opts.verify_live_margin
    return False


def sparse_live_biome_fraction(
    client: RconClient,
    world: str,
    arena: Arena,
    allow: list[str],
    *,
    sample_count: int,
    seed: str,
    requirements_id: str,
) -> tuple[float, list[ColumnSample]]:
    """Sample ``sample_count`` disc cells with heightmap + live ``if biome`` (Pass 2 style)."""
    rng = random.Random(int(hashlib.sha256(f"{seed}:verify:{requirements_id}".encode()).hexdigest()[:16], 16))
    cx, cz = arena.center
    r = arena.radius
    r2 = r * r
    xz: list[tuple[int, int]] = []
    for _ in range(sample_count * 8):
        x = rng.randint(cx - r, cx + r)
        z = rng.randint(cz - r, cz + r)
        if (x - cx) ** 2 + (z - cz) ** 2 <= r2:
            xz.append((x, z))
        if len(xz) >= sample_count:
            break
    xz = xz[:sample_count]
    if not xz:
        return 0.0, []

    heights = find_surface_heights(client, world, xz)
    columns = [
        ColumnSample(x=x, z=z, surface_y=heights.get((x, z)))
        for x, z in xz
        if heights.get((x, z)) is not None
    ]
    if not columns:
        return 0.0, []
    frac, _, _ = probe_biome_fraction_at_surface(client, world, columns, allow)
    return frac, columns


def verify_live_after_materialize(
    client: RconClient,
    world: str,
    req: Requirements,
    seed: str,
    p1: Pass1Result,
    opts: Pass1Options,
) -> tuple[bool, list[str], dict[str, object]]:
    """Returns (ok, reasons, audit_fragment)."""
    if not should_run_verify_live(p1, req, opts):
        return True, [], {}

    allow = _allow_from_requirements(req)
    frac, cols = sparse_live_biome_fraction(
        client,
        world,
        req.arena,
        allow,
        sample_count=opts.verify_live_samples,
        seed=seed,
        requirements_id=req.id,
    )
    min_frac = 0.0
    for g in req.gates:
        if isinstance(g, BiomeFractionGate):
            min_frac = g.min_fraction
            break

    audit = {
        "verify_live": True,
        "verify_live_samples": len(cols),
        "verify_live_fraction": round(frac, 4),
        "verify_live_min_required": min_frac,
    }
    if frac < min_frac:
        return (
            False,
            [f"pass1 verify_live: biome fraction {frac:.2%} < {min_frac:.2%} (live sparse)"],
            audit,
        )
    return True, [], audit
