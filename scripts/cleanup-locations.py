#!/usr/bin/env python3
"""Prune death_* and optional stale entries from data/locations-*.json.

Usage:
  python3 scripts/cleanup-locations.py              # all death_* removed
  python3 scripts/cleanup-locations.py --dry-run
  python3 scripts/cleanup-locations.py --keep-recent-deaths 3
  python3 scripts/cleanup-locations.py --remove-stale
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR / "lib"))
from locations_prune import prune_locations_file  # noqa: E402

REPO = SCRIPT_DIR.parent
DEFAULT_GLOB = REPO / "data" / "locations-*.json"


def main() -> int:
    p = argparse.ArgumentParser(description="Prune bot location mark files")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument(
        "--keep-recent-deaths",
        type=int,
        default=None,
        metavar="N",
        help="Keep newest N death_* marks instead of deleting all",
    )
    p.add_argument("--remove-stale", action="store_true", help="Drop marks flagged stale")
    p.add_argument("paths", nargs="*", type=Path, help="Files (default: data/locations-*.json)")
    args = p.parse_args()

    files = args.paths or sorted(DEFAULT_GLOB.parent.glob(DEFAULT_GLOB.name))
    if not files:
        print("No locations files found", file=sys.stderr)
        return 1

    remove_all = args.keep_recent_deaths is None
    max_deaths = 3 if args.keep_recent_deaths is None else args.keep_recent_deaths
    totals = {"removed_deaths": 0, "removed_stale": 0, "files": 0}

    for f in files:
        stats = prune_locations_file(
            f,
            dry_run=args.dry_run,
            remove_all_deaths=remove_all,
            max_deaths=max_deaths,
            remove_stale=args.remove_stale,
        )
        if stats.get("skipped"):
            continue
        totals["files"] += 1
        totals["removed_deaths"] += stats.get("removed_deaths", 0)
        totals["removed_stale"] += stats.get("removed_stale", 0)
        if stats.get("removed_deaths") or stats.get("removed_stale"):
            tag = " (dry-run)" if args.dry_run else ""
            print(
                f"{f.name}{tag}: -{stats.get('removed_deaths', 0)} deaths"
                f", -{stats.get('removed_stale', 0)} stale",
            )

    print(
        f"Done: {totals['files']} files, "
        f"{totals['removed_deaths']} deaths removed, "
        f"{totals['removed_stale']} stale removed"
        + (" (dry-run)" if args.dry_run else ""),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
