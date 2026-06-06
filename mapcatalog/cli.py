from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from mapcatalog.lint import lint_requirements, print_lint_report
from mapcatalog.load import load_requirements


def _default_server() -> Path:
    return Path("./server.local.yaml")


def cmd_lint(args: argparse.Namespace) -> int:
    report = lint_requirements(Path(args.requirements))
    if args.json:
        payload = {
            "ok": report.ok,
            "requirements_id": report.requirements.id,
            "errors": report.errors,
            "warnings": report.warnings,
            "gates": len(report.requirements.gates),
        }
        print(json.dumps(payload, indent=2))
    else:
        print_lint_report(report)
    return 0 if report.ok else 1


def cmd_try(args: argparse.Namespace) -> int:
    from mapcatalog.try_run import try_from_paths

    detail = "full" if args.json_full else "summary"
    outcome = try_from_paths(
        Path(args.requirements),
        Path(args.server),
        args.seed,
        pass1_only=args.pass1_only,
        detail=detail,
        reuse_world=True if args.reuse_world else None,
    )
    if args.json or args.json_full:
        import json

        print(json.dumps(outcome.payload, indent=2))
    elif outcome.payload.get("ok"):
        print(f"ok seed={outcome.payload.get('seed')}")
    else:
        print(outcome.payload.get("reasons", outcome.payload), file=sys.stderr)
    return outcome.exit_code


def cmd_find(args: argparse.Namespace) -> int:
    if args.pick:
        out_dir = Path(args.out)
        files = sorted(out_dir.glob("*.json"))
        if not files:
            print(json.dumps({"ok": False, "reasons": ["empty catalog"]}))
            return 1
        import random

        pick = random.choice(files)
        print(pick.read_text(encoding="utf-8"))
        return 0

    from mapcatalog.find_run import find_from_paths

    report = find_from_paths(
        Path(args.requirements),
        Path(args.server),
        Path(args.out),
        max_seeds=args.max_seeds,
        solutions=args.solutions,
        quiet=args.quiet,
        json_lines=args.json_lines,
    )
    payload = {
        "type": "summary",
        "ok": report.ok,
        "requirements_id": report.requirements_id,
        "out_dir": report.out_dir,
        "target_solutions": report.target_solutions,
        "max_seeds": report.max_seeds_limit,
        "stats": report.stats.__dict__,
        "lint_actual": report.lint_actual,
        "catalog_files": report.paths,
        "state_file": str(Path(report.out_dir) / ".find_state.json"),
    }
    if args.json_lines:
        print(json.dumps(payload), flush=True)
    elif args.json:
        print(json.dumps(payload, indent=2))
    else:
        s = report.stats
        print(
            f"find: {s.accepts}/{report.target_solutions} accepts for {report.requirements_id} "
            f"({s.seeds_tried}/{report.max_seeds_limit} tried, pass1_reject={s.pass1_rejects}, "
            f"pass2_reject={s.pass2_rejects}, verify_live_reject={s.verify_live_rejects}, "
            f"{s.elapsed_s}s)"
        )
        print(f"  lint_actual: {report.lint_actual}")
        for p in report.paths:
            print(f"  wrote {p}")
    return 0 if report.ok else 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="mapcatalog", description="Procedural map catalog")
    sub = p.add_subparsers(dest="command", required=True)

    lint_p = sub.add_parser("lint", help="Parse requirements and estimate sampling cost")
    lint_p.add_argument("-r", "--requirements", required=True)
    lint_p.add_argument("--json", action="store_true")
    lint_p.set_defaults(func=cmd_lint)

    try_p = sub.add_parser("try", help="Try one seed (Pass 1 + Pass 2)")
    try_p.add_argument("-r", "--requirements", required=True)
    try_p.add_argument("-s", "--server", default=str(_default_server()))
    try_p.add_argument("--seed")
    try_p.add_argument("--pass1-only", action="store_true")
    try_p.add_argument("--json", action="store_true")
    try_p.add_argument("--json-full", action="store_true", help="Emit full result with audit/fingerprint")
    try_p.add_argument(
        "--reuse-world",
        action="store_true",
        help="Skip mv delete/create when proc-lab-state.json seed matches",
    )
    try_p.set_defaults(func=cmd_try)

    find_p = sub.add_parser("find", help="Search seeds and write catalog")
    find_p.add_argument("-r", "--requirements")
    find_p.add_argument("-s", "--server", default=str(_default_server()))
    find_p.add_argument("-o", "--out", required=True)
    find_p.add_argument(
        "--max-seeds",
        type=int,
        help="Stop after this many candidate seeds (default: job find.max_seeds)",
    )
    find_p.add_argument(
        "--solutions",
        type=int,
        help="Catalog size goal (default: job find.solutions); run ends when reached or max-seeds",
    )
    find_p.add_argument("--pick", choices=["random"])
    find_p.add_argument("--json", action="store_true", help="Print final summary JSON on stdout")
    find_p.add_argument(
        "--json-lines",
        action="store_true",
        help="Emit one JSON object per seed on stdout, then a summary line (progress on stderr)",
    )
    find_p.add_argument("--quiet", action="store_true", help="No stderr progress lines")
    find_p.set_defaults(func=cmd_find)

    cal_p = sub.add_parser("calibrate", help="Run cubiomes calibration seeds (offline)")
    cal_p.add_argument("-s", "--server", default=str(_default_server()))
    cal_p.add_argument(
        "-c",
        "--calibration",
        default="calibration/seeds.yaml",
    )
    cal_p.add_argument("--enum-sweep", action="store_true")
    cal_p.add_argument("--json", action="store_true")
    cal_p.set_defaults(func=cmd_calibrate)

    from mapcatalog.scenario_cli import build_scenario_parser

    build_scenario_parser(sub)

    return p


def cmd_calibrate(args: argparse.Namespace) -> int:
    from mapcatalog.calibrate import run_calibration, run_enum_sweep
    from mapcatalog.server_config import load_server_config

    cfg = load_server_config(Path(args.server))
    if args.enum_sweep:
        rows = run_enum_sweep(cfg, Path(args.calibration))
        if args.json:
            print(json.dumps({"enum_sweep": rows}, indent=2))
        else:
            for row in rows:
                print(row)
        return 0

    report = run_calibration(cfg, Path(args.calibration))
    if args.json:
        print(json.dumps({"ok": report.ok, "results": report.results}, indent=2))
    else:
        for row in report.results:
            status = "ok" if row.get("ok") else "FAIL"
            print(f"{status} seed={row.get('seed')} {row}")
    return 0 if report.ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "find" and args.pick and not args.requirements:
        return args.func(args)
    if args.command == "find" and not args.pick and not args.requirements:
        parser.error("find requires -r unless --pick is used")
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
