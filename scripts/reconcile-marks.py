#!/usr/bin/env python3
"""Reconcile fleet-prefix marks (chest_*/base_*/lt_*) into locations-base.json.

Design lives in docs/specs/kanban/plugin-landfolk.md → Glossary → "Fleet-prefix
mark" and the `mark-drift.py` detector entry. This script is the manual
one-shot reconciler; mark-drift.py will be the scheduled detector that files
[HEALTH] cards for ongoing drift.

How it works
------------
1. Scans data/locations-<bot>.json for every bot.
2. Groups fleet-prefix marks by name. A mark with matching coords across ≥2
   bots is treated as consensus; mismatching coords are surfaced as conflicts
   for interactive resolution (or skipped with --auto).
3. Writes the canonical entry per name to data/locations-base.json (atomic).
4. Optionally strips the now-shadowed private entries from each
   locations-<bot>.json with --strip-private. Workers' next read() picks up
   the shared file anyway, so the private entries are noise after this.

Usage
-----
    scripts/reconcile-marks.py                       # interactive (default)
    scripts/reconcile-marks.py --auto                # consensus-only, no prompts
    scripts/reconcile-marks.py --dry-run             # print plan, write nothing
    scripts/reconcile-marks.py --strip-private       # also clean per-bot files
    scripts/reconcile-marks.py --print               # show current shared file

Conventions match bot/lib/runtime/locations.js — prefix list and merge rules
are kept in sync.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = REPO_ROOT / "data"
SHARED_FILE = DATA_DIR / "locations-base.json"
FLEET_PREFIXES = ("chest_", "base_", "lt_")


def is_fleet_mark(name: str) -> bool:
    return any(name.startswith(p) for p in FLEET_PREFIXES)


def coord_of(entry: dict) -> tuple[int, int, int] | None:
    """Floored (x,y,z) tuple, or None if the entry is malformed."""
    try:
        x = int(entry["x"])
        y = int(entry["y"])
        z = int(entry["z"])
        return (x, y, z)
    except (KeyError, TypeError, ValueError):
        return None


def scan_private_marks() -> dict[str, dict[tuple[int, int, int], list[dict]]]:
    """
    Returns: { mark_name: { coord_tuple: [ {owner, entry, saved, updated}, ... ] } }
    """
    out: dict[str, dict[tuple[int, int, int], list[dict]]] = {}
    for path_str in sorted(glob.glob(str(DATA_DIR / "locations-*.json"))):
        path = Path(path_str)
        if path.name == "locations-base.json":
            continue
        owner = path.stem.replace("locations-", "")
        try:
            with open(path) as fh:
                locs = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(locs, dict):
            continue
        for name, entry in locs.items():
            if not is_fleet_mark(name) or not isinstance(entry, dict):
                continue
            coord = coord_of(entry)
            if coord is None:
                continue
            out.setdefault(name, {}).setdefault(coord, []).append({
                "owner": owner,
                "entry": entry,
                "saved": entry.get("saved"),
                "updated": entry.get("updated"),
            })
    return out


def load_shared() -> dict:
    try:
        with open(SHARED_FILE) as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_shared(data: dict, dry_run: bool) -> None:
    if dry_run:
        print(f"[dry-run] would write {len(data)} entries to {SHARED_FILE}")
        return
    SHARED_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = SHARED_FILE.with_suffix(SHARED_FILE.suffix + ".tmp")
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, SHARED_FILE)
    print(f"  ✓ wrote {len(data)} entries to {SHARED_FILE.name}")


def strip_private_marks(canonical_names: set[str], dry_run: bool) -> int:
    """Remove fleet-prefix entries from each per-bot file where shared now
    owns the name. Returns total entries removed across all files."""
    total = 0
    for path_str in sorted(glob.glob(str(DATA_DIR / "locations-*.json"))):
        path = Path(path_str)
        if path.name == "locations-base.json":
            continue
        try:
            with open(path) as fh:
                locs = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(locs, dict):
            continue
        removed = [n for n in locs if n in canonical_names]
        if not removed:
            continue
        if dry_run:
            print(f"  [dry-run] would strip {len(removed)} from {path.name}: {sorted(removed)}")
            total += len(removed)
            continue
        for n in removed:
            del locs[n]
        tmp = path.with_suffix(path.suffix + ".tmp")
        with open(tmp, "w") as fh:
            json.dump(locs, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
        print(f"  ✓ stripped {len(removed)} from {path.name}: {sorted(removed)}")
        total += len(removed)
    return total


def fmt_coord(c: tuple[int, int, int]) -> str:
    return f"({c[0]},{c[1]},{c[2]})"


def pick_canonical_interactive(name: str, proposals: dict[tuple[int, int, int], list[dict]]) -> tuple[int, int, int] | None:
    """Prompt the user to pick the canonical coord. Returns None to skip."""
    coords = list(proposals.keys())
    print(f"\n  ⚠ {name} — conflicting coords across bots:")
    for i, c in enumerate(coords, 1):
        owners = sorted(p["owner"] for p in proposals[c])
        latest = max((p["updated"] or p["saved"] or "") for p in proposals[c])
        print(f"    [{i}] {fmt_coord(c)}  proposed by: {', '.join(owners)}  latest write: {latest or '?'}")
    print(f"    [s] skip — leave {name} for manual review")
    while True:
        try:
            choice = input(f"    pick canonical for {name}: ").strip().lower()
        except EOFError:
            return None
        if choice == "s":
            return None
        try:
            idx = int(choice) - 1
            if 0 <= idx < len(coords):
                return coords[idx]
        except ValueError:
            pass
        print(f"    invalid — pick 1..{len(coords)} or s")


def pick_canonical_auto(name: str, proposals: dict[tuple[int, int, int], list[dict]]) -> tuple[int, int, int] | None:
    """Consensus = majority of bots agree on the same coord. None otherwise."""
    if len(proposals) == 1:
        return next(iter(proposals.keys()))
    # Coord agreed by the most bots wins, IF strictly more than next-best.
    ranked = sorted(proposals.items(), key=lambda kv: -len(kv[1]))
    top_coord, top_owners = ranked[0]
    runner_up_owners = ranked[1][1] if len(ranked) > 1 else []
    if len(top_owners) > len(runner_up_owners):
        return top_coord
    return None  # tie → no auto resolution


def reconcile(args: argparse.Namespace) -> int:
    private = scan_private_marks()
    shared = load_shared()
    canonical = dict(shared)  # start from existing shared file
    now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    additions = 0
    conflicts_skipped = 0

    names = sorted(private.keys())
    if not names:
        print("No fleet-prefix marks found in any locations-*.json. Nothing to reconcile.")
        return 0

    print(f"Scanning {len(names)} fleet-prefix mark name(s) across bot files...")

    for name in names:
        proposals = private[name]
        # Already in shared?
        if name in shared:
            shared_coord = coord_of(shared[name])
            # Surface drift between private and shared (already-handled cases
            # — shared wins on read, but let operator see what bots think).
            for coord, owners in proposals.items():
                if coord != shared_coord:
                    bots = ", ".join(sorted(p["owner"] for p in owners))
                    print(f"  · {name}: shared={fmt_coord(shared_coord)} ; {bots} say {fmt_coord(coord)} (shadowed)")
            continue

        # New name — try to resolve.
        if args.auto:
            picked = pick_canonical_auto(name, proposals)
        else:
            if len(proposals) == 1:
                picked = next(iter(proposals.keys()))
                bots = ", ".join(sorted(p["owner"] for p in proposals[picked]))
                print(f"  ✓ {name}: consensus {fmt_coord(picked)} (from {bots})")
            else:
                picked = pick_canonical_interactive(name, proposals)

        if picked is None:
            conflicts_skipped += 1
            continue

        # Take the freshest entry's note/category/etc. as the canonical body,
        # then overwrite coords from the picked tuple.
        candidates = proposals[picked]
        winner = max(candidates, key=lambda p: p["updated"] or p["saved"] or "")["entry"]
        canonical[name] = {
            **{k: v for k, v in winner.items() if not k.startswith("_")},
            "x": picked[0],
            "y": picked[1],
            "z": picked[2],
            "saved": winner.get("saved", now_iso),
            "updated": now_iso,
            "reconciled_at": now_iso,
            "reconciled_from": sorted({p["owner"] for p in candidates}),
        }
        additions += 1
        if args.auto:
            bots = ", ".join(canonical[name]["reconciled_from"])
            print(f"  ✓ {name}: auto-added {fmt_coord(picked)} (consensus across {bots})")

    print()
    print(f"Result: {additions} new canonical entries; {conflicts_skipped} skipped; {len(canonical)} total in shared file.")

    if additions > 0 or args.force_write:
        save_shared(canonical, args.dry_run)
    else:
        print("  (no shared-file changes)")

    if args.strip_private and canonical:
        stripped = strip_private_marks(set(canonical.keys()), args.dry_run)
        action = "would strip" if args.dry_run else "stripped"
        print(f"Private cleanup: {action} {stripped} now-shadowed entries.")

    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--auto", action="store_true",
                   help="non-interactive; resolve only consensus (≥2 bots agree, strict majority)")
    p.add_argument("--dry-run", action="store_true",
                   help="show what would change, write nothing")
    p.add_argument("--strip-private", action="store_true",
                   help="after writing shared, remove the now-shadowed fleet-prefix entries from each locations-<bot>.json")
    p.add_argument("--force-write", action="store_true",
                   help="rewrite locations-base.json even if no additions (sorts keys, normalizes formatting)")
    p.add_argument("--print", action="store_true",
                   help="print current locations-base.json and exit")
    args = p.parse_args()

    if args.print:
        if not SHARED_FILE.exists():
            print(f"{SHARED_FILE} does not exist yet.")
            return 0
        print(SHARED_FILE.read_text(), end="")
        return 0

    return reconcile(args)


if __name__ == "__main__":
    sys.exit(main())
