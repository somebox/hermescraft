from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from mapcatalog.lifecycle import WorldProbeError, materialize_seed
from mapcatalog.load import load_requirements
from mapcatalog.metrics import collect_probe_metrics, evaluate_gates
from mapcatalog.models import Requirements
from mapcatalog.pass1 import evaluate_pass1
from mapcatalog.pass1_options import parse_pass1_options
from mapcatalog.placement_resolve import placement_reject_reasons, resolve_placements
from mapcatalog.rcon_client import make_rcon
from mapcatalog.result import (
    audit_block,
    fingerprint_payload,
    result_summary,
    sha256_fingerprint,
)
from mapcatalog.server_config import ServerConfig, load_server_config
from mapcatalog.verify_live import verify_live_after_materialize


@dataclass
class TryOutcome:
    payload: dict[str, Any]
    exit_code: int


def try_seed(
    req: Requirements,
    cfg: ServerConfig,
    seed: str,
    *,
    pass1_only: bool = False,
    detail: str = "summary",
    server_raw: dict | None = None,
    reuse_world: bool | None = None,
) -> TryOutcome:
    client = make_rcon(cfg)

    p1_opts = parse_pass1_options(req.source_lines, server_raw, cfg)

    p1 = evaluate_pass1(req, cfg, seed)
    if not p1.continue_pass2:
        return TryOutcome(
            {
                "ok": False,
                "seed": seed,
                "stage": "pass1",
                "reasons": p1.reasons,
                "requirements_id": req.id,
                "metrics": p1.metrics,
            },
            1,
        )

    if pass1_only:
        return TryOutcome(
            {
                "ok": True,
                "seed": seed,
                "stage": "pass1",
                "requirements_id": req.id,
                "metrics": p1.metrics,
                "audit": {"pass1": p1.audit},
            },
            0,
        )

    t0 = time.monotonic()
    try:
        world_raw = (server_raw or {}).get("world") or {}
        reuse = reuse_world if reuse_world is not None else bool(world_raw.get("reuse_seed", False))
        mat = materialize_seed(
            client,
            cfg,
            seed,
            req.arena,
            reuse_if_seed=reuse,
            requirements_id=req.id,
        )
    except WorldProbeError as e:
        return TryOutcome(
            {
                "ok": False,
                "seed": seed,
                "stage": "pass2",
                "reasons": [str(e)],
                "requirements_id": req.id,
            },
            1,
        )

    vl_ok, vl_reasons, vl_audit = verify_live_after_materialize(
        client, cfg.world_name, req, seed, p1, p1_opts
    )
    if not vl_ok:
        return TryOutcome(
            {
                "ok": False,
                "seed": seed,
                "stage": "pass2",
                "reasons": vl_reasons,
                "requirements_id": req.id,
                "audit": {"pass1": p1.audit, "verify_live": vl_audit},
            },
            1,
        )

    metrics = collect_probe_metrics(client, cfg.world_name, req.arena, req.gates)
    gate = evaluate_gates(client, cfg.world_name, req.arena, req.gates, metrics)
    probe_s = time.monotonic() - t0

    if not gate.passed:
        return TryOutcome(
            {
                "ok": False,
                "seed": seed,
                "stage": "pass2",
                "reasons": gate.reasons,
                "requirements_id": req.id,
                "metrics": gate.metrics,
            },
            1,
        )

    placements_map, placement_errors = resolve_placements(
        client=client,
        world=cfg.world_name,
        arena=req.arena,
        seed=seed,
        requirements_id=req.id,
        specs=req.placements,
        metrics=metrics,
    )
    if placement_errors:
        reasons = placement_reject_reasons(placement_errors)
        return TryOutcome(
            {
                "ok": False,
                "seed": seed,
                "stage": "pass2",
                "reasons": reasons,
                "requirements_id": req.id,
            },
            1,
        )

    arena_json = {"center": list(req.arena.center), "radius": req.arena.radius}
    mc_ver = req.minecraft_version or cfg.minecraft_version
    prep_commands: list[str] = []

    fp_payload = fingerprint_payload(
        req.id,
        seed,
        mc_ver,
        arena_json,
        {k: v for k, v in placements_map.items()},
        prep_commands,
    )
    fp = sha256_fingerprint(fp_payload)

    summary = result_summary(
        requirements_id=req.id,
        seed=seed,
        minecraft_version=mc_ver,
        arena=arena_json,
        placements={k: list(v) for k, v in placements_map.items()},
        score=gate.score,
        metrics_summary=gate.metrics_summary,
    )

    if detail == "full":
        pass1_audit = {**p1.audit, "rejected": False}
        if vl_audit:
            pass1_audit["verify_live"] = vl_audit
        audit = audit_block(
            pass1=pass1_audit,
            pass2={
                "materialized_world": cfg.world_name,
                "probe_duration_s": round(probe_s, 2),
                "materialize_duration_s": round(mat.duration_s, 2),
            },
        )
        audit["fingerprint"] = {"sha256": fp}
        summary["id"] = f"{req.id}__{seed}"
        summary["world_name"] = cfg.world_name
        summary["metrics"] = gate.metrics
        summary["prep_commands"] = prep_commands
        summary["cleanup_commands"] = []
        summary["audit"] = audit

    return TryOutcome(summary, 0)


def try_from_paths(
    requirements_path: Path,
    server_path: Path,
    seed: str | None,
    *,
    pass1_only: bool = False,
    detail: str = "summary",
    reuse_world: bool | None = None,
) -> TryOutcome:
    import yaml

    req = load_requirements(requirements_path)
    server_raw = None
    if server_path.is_file():
        with server_path.open(encoding="utf-8") as f:
            server_raw = yaml.safe_load(f) or {}
    cfg = load_server_config(server_path)
    use_seed = seed or str(__import__("random").randint(0, 2**63 - 1))
    return try_seed(
        req,
        cfg,
        use_seed,
        pass1_only=pass1_only,
        detail=detail,
        server_raw=server_raw,
        reuse_world=reuse_world,
    )
