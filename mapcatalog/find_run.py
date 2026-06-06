from __future__ import annotations

import hashlib
import json
import random
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TextIO

from mapcatalog.load import load_requirements
from mapcatalog.models import Requirements
from mapcatalog.server_config import ServerConfig, load_server_config
from mapcatalog.try_run import try_seed

FIND_STATE_NAME = ".find_state.json"


@dataclass
class FindStats:
    seeds_tried: int = 0
    pass1_rejects: int = 0
    pass2_rejects: int = 0
    accepts: int = 0
    verify_live_rejects: int = 0
    elapsed_s: float = 0.0


@dataclass
class FindReport:
    ok: bool
    requirements_id: str
    out_dir: str
    stats: FindStats
    target_solutions: int
    max_seeds_limit: int
    paths: list[str] = field(default_factory=list)
    lint_actual: dict[str, float] = field(default_factory=dict)


def _candidate_seed(requirements_id: str, index: int, rng: random.Random) -> str:
    """Deterministic-ish stream with per-run jitter from rng."""
    base = int(hashlib.sha256(f"{requirements_id}:find:{index}".encode()).hexdigest()[:15], 16)
    jitter = rng.randint(0, 2**20)
    return str((base ^ jitter) % (2**63 - 1))


def _iter_find_seeds(req: Requirements, rng: random.Random):
    """Try configured seed_candidates first, then pseudo-random stream."""
    seen: set[str] = set()
    for raw in req.find.seed_candidates:
        s = str(raw).strip()
        if s and s not in seen:
            seen.add(s)
            yield s
    index = 0
    while True:
        s = _candidate_seed(req.id, index, rng)
        index += 1
        if s not in seen:
            seen.add(s)
            yield s


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_find_state(
    out_dir: Path,
    *,
    req_id: str,
    target: int,
    limit: int,
    stats: FindStats,
    last_seed: str,
    last_payload: dict[str, Any],
    started_at: str,
) -> None:
    state = {
        "requirements_id": req_id,
        "target_solutions": target,
        "max_seeds": limit,
        "seeds_tried": stats.seeds_tried,
        "accepts": stats.accepts,
        "pass1_rejects": stats.pass1_rejects,
        "pass2_rejects": stats.pass2_rejects,
        "verify_live_rejects": stats.verify_live_rejects,
        "started_at": started_at,
        "updated_at": _iso_now(),
        "last_seed": last_seed,
        "last_ok": bool(last_payload.get("ok")),
        "last_stage": last_payload.get("stage"),
        "last_reasons": last_payload.get("reasons"),
    }
    (out_dir / FIND_STATE_NAME).write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def _progress_line(
    req_id: str,
    *,
    seed: str,
    stats: FindStats,
    target: int,
    limit: int,
    seed_elapsed_s: float,
    run_elapsed_s: float,
    payload: dict[str, Any],
) -> str:
    ok = payload.get("ok")
    stage = payload.get("stage", "?")
    return (
        f"find[{req_id}] try {stats.seeds_tried}/{limit} seed={seed} "
        f"accepts={stats.accepts}/{target} ok={ok} stage={stage} "
        f"seed_s={seed_elapsed_s:.1f} total_s={run_elapsed_s:.1f}"
    )


def find_results(
    req: Requirements,
    cfg: ServerConfig,
    out_dir: Path,
    *,
    max_seeds: int | None = None,
    solutions: int | None = None,
    write_rejects: bool = True,
    server_raw: dict | None = None,
    progress_stream: TextIO | None = None,
    json_lines_stream: TextIO | None = None,
    quiet: bool = False,
) -> FindReport:
    t0 = time.monotonic()
    started_at = _iso_now()
    target = solutions if solutions is not None else req.find.solutions
    limit = max_seeds if max_seeds is not None else req.find.max_seeds
    out_dir = out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    rejects_dir = out_dir.parent / "rejects" / req.id
    if write_rejects:
        rejects_dir.mkdir(parents=True, exist_ok=True)

    prog = None if quiet else (progress_stream if progress_stream is not None else sys.stderr)

    rng = random.Random(int(hashlib.sha256(req.id.encode()).hexdigest()[:16], 16))
    stats = FindStats()
    paths: list[str] = []
    seed_iter = _iter_find_seeds(req, rng)

    if prog:
        cand = req.find.seed_candidates
        if cand:
            prog.write(f"find[{req.id}] seed_candidates={cand}\n")
        prog.write(
            f"find[{req.id}] start target_solutions={target} max_seeds={limit} out={out_dir}\n"
        )
        prog.flush()

    while stats.accepts < target and stats.seeds_tried < limit:
        seed = next(seed_iter)
        seed_t0 = time.monotonic()

        outcome = try_seed(
            req,
            cfg,
            seed,
            pass1_only=False,
            detail="full",
            server_raw=server_raw,
        )
        payload = outcome.payload
        stats.seeds_tried += 1
        seed_elapsed = time.monotonic() - seed_t0
        run_elapsed = time.monotonic() - t0

        if payload.get("ok"):
            fname = f"{req.id}__{seed}.json"
            fpath = out_dir / fname
            fpath.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
            paths.append(str(fpath))
            stats.accepts += 1
        else:
            stage = payload.get("stage", "pass2")
            if stage == "pass1":
                stats.pass1_rejects += 1
            else:
                stats.pass2_rejects += 1
                reasons = payload.get("reasons") or []
                if any("verify_live" in r for r in reasons):
                    stats.verify_live_rejects += 1

            if write_rejects:
                rname = f"{req.id}__{seed}__{stage}.json"
                (rejects_dir / rname).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

        _write_find_state(
            out_dir,
            req_id=req.id,
            target=target,
            limit=limit,
            stats=stats,
            last_seed=seed,
            last_payload=payload,
            started_at=started_at,
        )

        if json_lines_stream is not None:
            line = {
                "type": "seed",
                "requirements_id": req.id,
                "seed": seed,
                "ok": bool(payload.get("ok")),
                "stage": payload.get("stage"),
                "reasons": payload.get("reasons"),
                "accepts": stats.accepts,
                "seeds_tried": stats.seeds_tried,
                "seed_elapsed_s": round(seed_elapsed, 2),
                "elapsed_s": round(run_elapsed, 2),
            }
            json_lines_stream.write(json.dumps(line) + "\n")
            json_lines_stream.flush()

        if prog:
            prog.write(
                _progress_line(
                    req.id,
                    seed=seed,
                    stats=stats,
                    target=target,
                    limit=limit,
                    seed_elapsed_s=seed_elapsed,
                    run_elapsed_s=run_elapsed,
                    payload=payload,
                )
                + "\n"
            )
            prog.flush()

    stats.elapsed_s = round(time.monotonic() - t0, 2)
    pass2_materialized = stats.seeds_tried - stats.pass1_rejects
    pass1_yield = (pass2_materialized / stats.seeds_tried) if stats.seeds_tried else 0.0
    pass2_yield = (stats.accepts / pass2_materialized) if pass2_materialized else 0.0

    report = FindReport(
        ok=stats.accepts >= target,
        requirements_id=req.id,
        out_dir=str(out_dir),
        stats=stats,
        target_solutions=target,
        max_seeds_limit=limit,
        paths=paths,
        lint_actual={
            "seeds_tried": float(stats.seeds_tried),
            "pass1_yield": round(pass1_yield, 4),
            "pass2_yield": round(pass2_yield, 4),
            "pass2_materializations": float(pass2_materialized),
        },
    )

    if prog:
        prog.write(
            f"find[{req.id}] done ok={report.ok} accepts={stats.accepts}/{target} "
            f"tried={stats.seeds_tried}/{limit} elapsed_s={stats.elapsed_s}\n"
        )
        prog.flush()

    return report


def find_from_paths(
    requirements_path: Path,
    server_path: Path,
    out_dir: Path,
    *,
    max_seeds: int | None = None,
    solutions: int | None = None,
    quiet: bool = False,
    json_lines: bool = False,
) -> FindReport:
    req = load_requirements(requirements_path)
    with server_path.open(encoding="utf-8") as f:
        import yaml

        server_raw = yaml.safe_load(f) or {}
    cfg = load_server_config(server_path)
    jl_stream = sys.stdout if json_lines else None
    return find_results(
        req,
        cfg,
        out_dir,
        max_seeds=max_seeds,
        solutions=solutions,
        server_raw=server_raw,
        quiet=quiet,
        json_lines_stream=jl_stream,
    )
