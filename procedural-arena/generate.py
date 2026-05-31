#!/usr/bin/env python3
"""Generate or regenerate a procedural Multiverse arena world."""

from __future__ import annotations

import argparse
import copy
import json
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

ARENA_ROOT = Path(__file__).resolve().parent
if str(ARENA_ROOT) not in sys.path:
    sys.path.insert(0, str(ARENA_ROOT))

from lib.config_params import (
    apply_map_size_preset,
    load_params,
    map_size_cli_epilog,
    resolve_map,
)
from lib.fingerprint import compute_fingerprint
from lib.world_inspect import run_inspect
from lib.lifecycle import (
    border_forceload_commands,
    create_world_sync,
    delete_world_sync,
    runtime_setup_commands,
    set_spawn_commands,
)
from lib.pregen import pregen_tp_commands
from lib.rcon import ProceduralRcon
from lib.safety import assert_safe_world_name
from lib.score import rank_reports
from lib.cli_output import print_phase, print_phase_done, print_run_start, print_run_summary

from lib.timing import TimingReport

REPORTS_DIR = ARENA_ROOT / "reports"
PINNED_DIR = ARENA_ROOT / "fixtures" / "pinned"


def _parse_param_overrides(pairs: list[str]) -> dict[str, str]:
    out = {}
    for kv in pairs:
        k, _, v = kv.partition("=")
        out[k.strip()] = v.strip()
    return out


def _resolve_seed(params: dict, args: argparse.Namespace) -> int:
    if args.seed is not None:
        return int(args.seed)
    if args.random_seed:
        return random.randint(-(2**63), 2**63 - 1)
    create = params.get("create") or {}
    s = create.get("seed")
    if s == "random" or s is None:
        return random.randint(-(2**63), 2**63 - 1)
    return int(s)


def _load_scenario_weights(scenario: str | None) -> dict[str, float]:
    if not scenario:
        return {
            "prep.largest_flat_area": 3.0,
            "prep.grass_pct": 1.0,
            "transit.water_pct": -1.0,
            "work.iron_ore_samples": 2.0,
        }
    path = ARENA_ROOT / "scenarios" / f"{scenario}.yaml"
    if not path.exists():
        return _load_scenario_weights(None)
    import yaml

    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    return data.get("score_weights") or _load_scenario_weights(None)


def _generate_one(
    params: dict,
    args: argparse.Namespace,
    *,
    world: str,
    seed: int,
    candidate_index: int | None = None,
    candidate_total: int = 1,
) -> dict:
    timing = TimingReport()
    rcon = ProceduralRcon(dry_run=args.dry_run)
    map_cfg = resolve_map(params)
    fixture_id = args.fixture or params.get("fixture_id")
    profile = args.profile or params.get("profile", "vanilla_baseline")
    create = params.get("create") or {}
    generator = str(create.get("generator", "NORMAL"))

    v = args.verbose
    map_preset = args.map_size

    if candidate_index == 0:
        print_run_start(
            world=world,
            map_cfg=map_cfg,
            seed=seed if candidate_total == 1 else None,
            candidate_index=candidate_index or 0,
            candidate_total=candidate_total,
            regenerate=args.regenerate,
            dry_run=args.dry_run,
            skip_pregen=args.skip_pregen,
            skip_inspect=args.skip_inspect,
            profile=profile,
            fixture_id=fixture_id,
            generator=generator,
            map_size_preset=map_preset,
            verbose=v,
        )
    elif candidate_total > 1:
        print(
            f"--- candidate {(candidate_index or 0) + 1}/{candidate_total} seed={seed} ---",
            flush=True,
        )

    report: dict = {
        "world": world,
        "seed": seed,
        "fixture_id": fixture_id,
        "profile": profile,
        "map": map_cfg,
        "map_size_preset": map_preset,
        "params": copy.deepcopy(params),
        "cli_argv": sys.argv,
        "note": args.note,
        "candidate_index": candidate_index,
    }

    if args.regenerate or args.candidates == 1:
        print_phase("delete_world", verbose=v)
        with timing.phase("delete_world"):
            delete_world_sync(rcon, world)
        print_phase_done("delete_world", timing.phases.get("delete_world", 0), verbose=v)

    print_phase("create_world", detail=f"seed={seed}", verbose=v)
    with timing.phase("create_world"):
        create_world_sync(rcon, params, world, seed)
        timing.note_rcon_batch(1)
    print_phase_done("create_world", timing.phases.get("create_world", 0), verbose=v)

    with timing.phase("datapack_install"):
        pass

    print_phase("border_forceload", verbose=v)
    with timing.phase("border_forceload"):
        bcmds = border_forceload_commands(map_cfg, world, params)
        bcmds.extend(runtime_setup_commands(params, world))
        if not args.skip_pregen:
            bcmds.extend(pregen_tp_commands(map_cfg, world, params))
        rcon.run_batch(bcmds)
        timing.note_rcon_batch(len(bcmds))
    print_phase_done("border_forceload", timing.phases.get("border_forceload", 0), verbose=v)

    if not args.skip_pregen:
        print_phase("pregen", verbose=v)
        with timing.phase("pregen"):
            pass
        print_phase_done("pregen", timing.phases.get("pregen", 0), verbose=v)
    else:
        timing.phases["pregen"] = 0.0

    inspect_payload = {}
    if not args.skip_inspect:
        print_phase("inspect", verbose=v)
        with timing.phase("inspect"):
            inspect_payload = run_inspect(
                rcon,
                world,
                params,
                timing,
                seed=seed,
                fixture_id=fixture_id,
                profile=profile,
            )
            spawn = inspect_payload.get("spawn_feet") or {"x": 0, "y": 65, "z": 0}
            scmds = set_spawn_commands(
                world, int(spawn["x"]), int(spawn["y"]), int(spawn["z"])
            )
            rcon.run_batch(scmds)
            timing.note_rcon_batch(len(scmds))
        print_phase_done("inspect", timing.phases.get("inspect", 0), verbose=v)
    else:
        timing.phases["inspect"] = 0.0

    report.update(timing.to_dict())
    report.update(inspect_payload)
    if inspect_payload.get("fingerprint_inputs"):
        report["fingerprint"] = compute_fingerprint(inspect_payload["fingerprint_inputs"])
    return report


def _write_report(report: dict, report_dir: Path) -> Path:
    report_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    world = report.get("world", "proc-lab")
    path = report_dir / f"{world}-{ts}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, default=str)
    return path


def _promote_pinned(report: dict, fixture_id: str | None) -> Path | None:
    if not fixture_id:
        return None
    PINNED_DIR.mkdir(parents=True, exist_ok=True)
    path = PINNED_DIR / f"{fixture_id}.yaml"
    import yaml

    payload = {
        "fixture_id": fixture_id,
        "seed_mode": "pinned",
        "seed": report.get("seed"),
        "mc_version": report.get("params", {}).get("mc_version"),
        "world": report.get("world"),
        "report_snapshot": {
            "spawn_feet": report.get("spawn_feet"),
            "muster": report.get("muster"),
            "work_bbox": report.get("work_bbox"),
            "cleanup_bbox": report.get("cleanup_bbox"),
            "fingerprint": report.get("fingerprint"),
        },
    }
    with open(path, "w", encoding="utf-8") as f:
        yaml.dump(payload, f, default_flow_style=False)
    return path


def main() -> int:
    base_params = load_params()
    p = argparse.ArgumentParser(
        description="Create/regenerate proc-* MV worlds; inspect JSON → procedural-arena/reports/.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=map_size_cli_epilog(base_params),
    )
    p.add_argument("--world", default=None)
    p.add_argument("--profile", default=None)
    p.add_argument("--fixture", default=None)
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--random-seed", action="store_true")
    p.add_argument("--regenerate", action="store_true")
    p.add_argument("--map-radius", type=int, default=None)
    p.add_argument("--map-diameter", type=int, default=None)
    p.add_argument("--arena-half", type=int, default=None)
    p.add_argument(
        "--map-size",
        choices=["small", "medium", "large"],
        default=None,
        help="64 / 128 / 256 block worldborder radius (medium = defaults.yaml)",
    )
    p.add_argument("--center-x", type=int, default=None)
    p.add_argument("--center-z", type=int, default=None)
    p.add_argument("--pregen-step", type=int, default=None)
    p.add_argument("--grid-step", type=int, default=None)
    p.add_argument("--generator", choices=["NORMAL", "FLAT"], default=None)
    p.add_argument("--structures", action="store_true", default=None)
    p.add_argument("--no-structures", action="store_true")
    p.add_argument("--skip-pregen", action="store_true")
    p.add_argument("--skip-inspect", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--note", default=None)
    p.add_argument("--report-dir", type=Path, default=REPORTS_DIR)
    p.add_argument("--candidates", type=int, default=1)
    p.add_argument("--scenario", default=None, help="scenario weights for --candidates")
    p.add_argument("--promote-pinned", action="store_true")
    p.add_argument("--i-know-what-im-doing", action="store_true")
    p.add_argument("--verbose", "-v", action="store_true", help="per-phase progress and expanded summary")
    p.add_argument("--param", action="append", default=[])
    args = p.parse_args()

    params = load_params()
    apply_map_size_preset(params, args.map_size)
    if args.world:
        params["world"] = args.world
    world = params.get("world", "proc-lab")
    assert_safe_world_name(world, allow_unsafe=args.i_know_what_im_doing)

    if args.map_radius is not None:
        params.setdefault("map", {})["border_radius"] = args.map_radius
    if args.map_diameter is not None:
        params.setdefault("map", {})["border_radius"] = args.map_diameter // 2
    if args.arena_half is not None:
        params.setdefault("map", {})["arena_half"] = args.arena_half
    if args.center_x is not None:
        params.setdefault("map", {})["center_x"] = args.center_x
    if args.center_z is not None:
        params.setdefault("map", {})["center_z"] = args.center_z
    if args.pregen_step is not None:
        params.setdefault("pregen", {})["step"] = args.pregen_step
    if args.grid_step is not None:
        params.setdefault("inspect", {})["grid_step"] = args.grid_step
    if args.generator:
        params.setdefault("create", {})["generator"] = args.generator
    if args.no_structures:
        params.setdefault("create", {})["structures"] = False
    elif args.structures:
        params.setdefault("create", {})["structures"] = True
    if args.fixture:
        params["fixture_id"] = args.fixture

    weights = _load_scenario_weights(args.scenario)
    reports: list[dict] = []
    n = max(1, args.candidates)
    for i in range(n):
        seed = _resolve_seed(params, args)
        rep = _generate_one(
            params,
            args,
            world=world,
            seed=seed,
            candidate_index=i,
            candidate_total=n,
        )
        rep["composite_score"] = None
        if not args.skip_inspect and n > 1:
            from lib.score import score_report

            rep["composite_score"] = score_report(rep, weights)
        reports.append(rep)

    if n > 1 and not args.skip_inspect:
        ranked = rank_reports(reports, weights)
        winner = ranked[0][1]
        report = winner
        report["candidate_ranking"] = [
            {"score": s, "seed": r.get("seed"), "index": r.get("candidate_index")}
            for s, r in ranked
        ]
    else:
        report = reports[-1]

    path = _write_report(report, args.report_dir)
    print_run_summary(
        report,
        params,
        path,
        dry_run=args.dry_run,
        verbose=args.verbose,
        map_size_preset=args.map_size,
    )
    if args.promote_pinned:
        pp = _promote_pinned(report, args.fixture or params.get("fixture_id"))
        if pp:
            print(f"pinned manifest {pp}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
