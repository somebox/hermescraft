#!/usr/bin/env python3
"""Reconcile per-bot personal POIs into data/personal-pois-shared.json.

Companion to scripts/reconcile-marks.py. Personal POIs are the *mapping
mission's* private-by-default waypoints — see docs/plans for the mapping
experiment. Each agent's `mc poi_add` writes to `data/personal-pois-<bot>.json`;
this script merges across bots so a Steward-judged map run can see the union.

How it differs from reconcile-marks
-----------------------------------
* **No prefix filter.** POI names are free-form ("spider hill", "balders ruins").
  Every entry is in scope.
* **Conflict tie-breaker is most-recent `last_seen`** (not the per-bot
  majority used for marks). Rationale: POIs are landmarks an agent saw with
  its own eyes; the latest observation is the freshest truth.
* **Preserves sign_at / torch_at / kind / note** on the canonical entry.

Usage
-----
    scripts/reconcile-pois.py                       # interactive (default)
    scripts/reconcile-pois.py --auto                # most-recent-wins, no prompts
    scripts/reconcile-pois.py --dry-run             # print plan, write nothing
    scripts/reconcile-pois.py --strip-private       # also clean per-bot files
    scripts/reconcile-pois.py --print               # show current shared file

Conventions match bot/lib/runtime/personal-pois.js.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = REPO_ROOT / "data"
SHARED_FILE = DATA_DIR / "personal-pois-shared.json"


def coord_of(entry: dict) -> tuple[int, int, int] | None:
    """Floored (x,y,z) tuple, or None if the entry is malformed."""
    try:
        x = int(entry["x"])
        y = int(entry["y"])
        z = int(entry["z"])
        return (x, y, z)
    except (KeyError, TypeError, ValueError):
        return None


def scan_private_pois() -> dict[str, dict[tuple[int, int, int], list[dict]]]:
    """
    Returns: { poi_name: { coord_tuple: [ {owner, entry, last_seen, added_at}, ... ] } }

    Skips the shared file (we re-merge into it) and any malformed entries.
    """
    out: dict[str, dict[tuple[int, int, int], list[dict]]] = {}
    for path_str in sorted(glob.glob(str(DATA_DIR / "personal-pois-*.json"))):
        path = Path(path_str)
        if path.name == "personal-pois-shared.json":
            continue
        owner = path.stem.replace("personal-pois-", "")
        try:
            with open(path) as fh:
                pois = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(pois, dict):
            continue
        for name, entry in pois.items():
            if not isinstance(entry, dict):
                continue
            coord = coord_of(entry)
            if coord is None:
                continue
            out.setdefault(name, {}).setdefault(coord, []).append({
                "owner": owner,
                "entry": entry,
                "last_seen": entry.get("last_seen"),
                "added_at": entry.get("added_at"),
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


def strip_private_pois(canonical_names: set[str], dry_run: bool) -> int:
    """Remove entries from each per-bot file where shared now owns the name.
    Returns total entries removed across all files. Workers' next read picks up
    the shared overlay (see personal-pois.js mergePois) so the private copies
    are noise after reconciliation.
    """
    total = 0
    for path_str in sorted(glob.glob(str(DATA_DIR / "personal-pois-*.json"))):
        path = Path(path_str)
        if path.name == "personal-pois-shared.json":
            continue
        try:
            with open(path) as fh:
                pois = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(pois, dict):
            continue
        removed = [n for n in pois if n in canonical_names]
        if not removed:
            continue
        if dry_run:
            print(f"  [dry-run] would strip {len(removed)} from {path.name}: {sorted(removed)}")
            total += len(removed)
            continue
        for n in removed:
            del pois[n]
        tmp = path.with_suffix(path.suffix + ".tmp")
        with open(tmp, "w") as fh:
            json.dump(pois, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
        print(f"  ✓ stripped {len(removed)} from {path.name}: {sorted(removed)}")
        total += len(removed)
    return total


def fmt_coord(c: tuple[int, int, int]) -> str:
    return f"({c[0]},{c[1]},{c[2]})"


def pick_canonical_interactive(name: str, proposals: dict[tuple[int, int, int], list[dict]]) -> tuple[int, int, int] | None:
    coords = list(proposals.keys())
    print(f"\n  ⚠ {name} — conflicting coords across bots:")
    for i, c in enumerate(coords, 1):
        owners = sorted(p["owner"] for p in proposals[c])
        latest = max((p["last_seen"] or p["added_at"] or "") for p in proposals[c])
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


def pick_canonical_auto(proposals: dict[tuple[int, int, int], list[dict]]) -> tuple[int, int, int]:
    """Pick the coord whose freshest entry has the most-recent last_seen.

    Unlike marks (which pick by per-bot majority), POIs trust the latest
    direct observation — the freshest stamp wins regardless of how many bots
    propose the alternative.
    """
    def freshness(coord: tuple[int, int, int]) -> str:
        return max(
            (p["last_seen"] or p["added_at"] or "")
            for p in proposals[coord]
        )
    return max(proposals.keys(), key=freshness)


def _strip_internal_fields(entry: dict) -> dict:
    """Drop `_source` overlay tag + any reconcile-bookkeeping keys before
    writing back. The runtime store re-adds _source on load."""
    return {k: v for k, v in entry.items() if not k.startswith("_")}


def reconcile(args: argparse.Namespace) -> int:
    private = scan_private_pois()
    shared = load_shared()
    # Start from existing shared file so we don't lose prior reconciliations
    # that nobody re-asserted this cycle.
    canonical = {n: _strip_internal_fields(e) for n, e in shared.items() if isinstance(e, dict)}
    now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    additions = 0
    updates = 0
    conflicts_skipped = 0

    names = sorted(private.keys())
    if not names:
        print("No personal POIs found in any personal-pois-*.json. Nothing to reconcile.")
        return 0

    print(f"Scanning {len(names)} POI name(s) across bot files...")

    for name in names:
        proposals = private[name]

        if len(proposals) == 1:
            picked = next(iter(proposals.keys()))
            if not args.auto:
                bots = ", ".join(sorted(p["owner"] for p in proposals[picked]))
                already_in_shared = name in canonical and coord_of(canonical[name]) == picked
                marker = "(already shared)" if already_in_shared else f"(from {bots})"
                print(f"  ✓ {name}: {fmt_coord(picked)} {marker}")
        elif args.auto:
            picked = pick_canonical_auto(proposals)
        else:
            picked = pick_canonical_interactive(name, proposals)

        if picked is None:
            conflicts_skipped += 1
            continue

        # Pick the freshest entry across the proposals AT the winning coord as
        # the canonical body, then overwrite coords from the picked tuple.
        candidates = proposals[picked]
        winner = max(candidates, key=lambda p: p["last_seen"] or p["added_at"] or "")["entry"]
        body = _strip_internal_fields(winner)
        body.update({
            "x": picked[0],
            "y": picked[1],
            "z": picked[2],
            "added_at": winner.get("added_at", now_iso),
            "last_seen": winner.get("last_seen", now_iso),
            "reconciled_at": now_iso,
            "reconciled_from": sorted({p["owner"] for p in candidates}),
        })
        # Preserve optional anchor fields if present on the winner.
        for opt in ("sign_at", "torch_at", "kind", "note", "agent_owner",
                    "last_torch_check", "torch_missing_since"):
            if opt in winner:
                body[opt] = winner[opt]

        if name in canonical:
            if canonical[name] != body:
                updates += 1
        else:
            additions += 1
        canonical[name] = body
        if args.auto and (name not in shared or coord_of(shared.get(name, {})) != picked):
            bots = ", ".join(body["reconciled_from"])
            print(f"  ✓ {name}: auto-picked {fmt_coord(picked)} (latest from {bots})")

    print()
    print(f"Result: +{additions} new, ~{updates} updated, {conflicts_skipped} skipped; "
          f"{len(canonical)} total in shared file.")

    if additions > 0 or updates > 0 or args.force_write:
        save_shared(canonical, args.dry_run)
    else:
        print("  (no shared-file changes)")

    if args.strip_private and canonical:
        stripped = strip_private_pois(set(canonical.keys()), args.dry_run)
        action = "would strip" if args.dry_run else "stripped"
        print(f"Private cleanup: {action} {stripped} now-shadowed entries.")

    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--auto", action="store_true",
                   help="non-interactive; pick the most-recent last_seen on conflict")
    p.add_argument("--dry-run", action="store_true",
                   help="show what would change, write nothing")
    p.add_argument("--strip-private", action="store_true",
                   help="after writing shared, remove the now-shadowed entries from each personal-pois-<bot>.json")
    p.add_argument("--force-write", action="store_true",
                   help="rewrite personal-pois-shared.json even if nothing changed (sorts keys, normalizes formatting)")
    p.add_argument("--print", action="store_true",
                   help="print current personal-pois-shared.json and exit")
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
