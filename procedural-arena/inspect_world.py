#!/usr/bin/env python3
"""Inspect an existing proc-* world without regenerating."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ARENA_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ARENA_ROOT))

from lib.cli_output import print_phase, print_phase_done, print_run_summary
from lib.config_params import load_params, map_size_cli_epilog, resolve_map
from lib.fingerprint import compute_fingerprint
from lib.rcon import ProceduralRcon
from lib.safety import assert_safe_world_name
from lib.timing import TimingReport
from lib.world_inspect import run_inspect

REPORTS_DIR = ARENA_ROOT / "reports"


def main() -> int:
    params = load_params()
    p = argparse.ArgumentParser(
        description="Re-run inspect metrics on an existing proc-* world (no mv create/delete).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=map_size_cli_epilog(params),
    )
    p.add_argument("--world", default="proc-lab", help="proc-* world name (must be loaded in Multiverse)")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--verbose", "-v", action="store_true", help="per-phase progress and expanded summary")
    p.add_argument("--report-dir", type=Path, default=REPORTS_DIR)
    p.add_argument("--i-know-what-im-doing", action="store_true")
    args = p.parse_args()
    assert_safe_world_name(args.world, allow_unsafe=args.i_know_what_im_doing)
    params["world"] = args.world
    map_cfg = resolve_map(params)
    if not args.verbose:
        print(
            f"=== inspect {args.world}  {map_cfg['diameter']}⌀  "
            f"{'dry-run' if args.dry_run else 'live rcon'}",
            flush=True,
        )
    else:
        print("=== procedural-arena inspect ===", flush=True)
        print(f"  world: {args.world}  map diameter {map_cfg['diameter']}", flush=True)
        print(f"  mode:  {'dry-run' if args.dry_run else 'live rcon'}", flush=True)
        print("", flush=True)
    timing = TimingReport()
    rcon = ProceduralRcon(dry_run=args.dry_run)
    print_phase("inspect", verbose=args.verbose)
    with timing.phase("inspect"):
        report = run_inspect(rcon, args.world, params, timing)
    print_phase_done("inspect", timing.phases.get("inspect", 0), verbose=args.verbose)
    report.update(timing.to_dict())
    if report.get("fingerprint_inputs"):
        report["fingerprint"] = compute_fingerprint(report["fingerprint_inputs"])
    report["map"] = resolve_map(params)
    args.report_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = args.report_dir / f"{args.world}-inspect-{ts}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, default=str)
    print_run_summary(report, params, path, dry_run=args.dry_run, verbose=args.verbose)
    return 0


if __name__ == "__main__":
    sys.exit(main())
