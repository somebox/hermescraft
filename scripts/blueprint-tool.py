#!/usr/bin/env python3
"""CLI for blueprint plan files (offline mirror of mc blueprint read-only + audit/adopt)."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from blueprint_lib import (
    MAX_CELLS,
    assert_plan_size,
    compare_blocks,
    metadata_footprint,
    normalize_block_id,
    tight_footprint_from_cells,
    VERIFY_MAX,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA = REPO_ROOT / "data"


def data_dir() -> Path:
    return Path(os.environ.get("HERMES_DATA_DIR", DEFAULT_DATA))


def plans_dir() -> Path:
    return data_dir() / "ops" / "plans"


def resolve_plan_file(plan_ref: str) -> Path:
    """Accept plan_id slug, *-plan.json filename, or path to a plan JSON file."""
    ref = plan_ref.strip()
    slug = ref
    for suffix in ("-plan.json", ".json"):
        if slug.endswith(suffix):
            slug = slug[: -len(suffix)]
            break
    if slug.endswith("-plan"):
        slug = slug[: -len("-plan")]
    candidates = [
        Path(ref),
        Path.cwd() / ref,
        plans_dir() / ref,
        plans_dir() / f"{ref}-plan.json" if not ref.endswith(".json") else plans_dir() / ref,
        plans_dir() / f"{slug}-plan.json",
    ]
    seen: set[Path] = set()
    for cand in candidates:
        try:
            resolved = cand.resolve()
        except OSError:
            continue
        if resolved in seen:
            continue
        seen.add(resolved)
        if resolved.is_file():
            return resolved
    expected = plans_dir() / f"{slug}-plan.json"
    raise SystemExit(f"PLAN_NOT_FOUND: {ref} (try plan_id `{slug}` or path `{expected}`)")


def load_plan(plan_ref: str) -> dict:
    fp = resolve_plan_file(plan_ref)
    with fp.open() as f:
        plan = json.load(f)
    cells = plan.get("cells") or []
    fp_local = resolve_footprint(plan)
    try:
        assert_plan_size(len(cells), fp_local.get("local"))
    except ValueError as e:
        raise SystemExit(str(e)) from e
    return plan


def resolve_footprint(plan: dict) -> dict:
    fp = plan.get("footprint")
    if fp and fp.get("local"):
        return fp
    meta = plan.get("metadata") or plan.get("stats") or {}
    if meta.get("width"):
        return metadata_footprint(meta)
    return tight_footprint_from_cells(plan.get("cells") or [])


def build_index(cells: list) -> dict[tuple[int, int, int], dict]:
    idx = {}
    for c in cells:
        lx, ly, lz = c["local"]
        idx[(lx, ly, lz)] = c
    return idx


def cmd_show(args: argparse.Namespace) -> None:
    plan = load_plan(args.plan_id)
    fp = resolve_footprint(plan)
    out = {
        "plan_id": plan.get("plan_id") or args.plan_id,
        "source": plan.get("source"),
        "anchor": plan.get("anchor"),
        "footprint": fp,
        "cells": len(plan.get("cells") or []),
        "stats": plan.get("stats"),
    }
    print(json.dumps(out, indent=2))


def cmd_cell(args: argparse.Namespace) -> None:
    plan = load_plan(args.plan_id)
    idx = build_index(plan.get("cells") or [])
    key = (args.x, args.y, args.z)
    cell = idx.get(key)
    expected = cell["block"] if cell else "air"
    print(json.dumps({"local": list(key), "expected": expected, "cell": cell}, indent=2))


def cmd_layer(args: argparse.Namespace) -> None:
    plan = load_plan(args.plan_id)
    y = args.y
    cells = [c for c in plan.get("cells") or [] if c["local"][1] == y]
    print(json.dumps({"layer_y": y, "cells": cells}, indent=2))


def cmd_materials(args: argparse.Namespace) -> None:
    plan = load_plan(args.plan_id)
    print(json.dumps({"materials_planned": plan.get("materials_planned") or []}, indent=2))


def verify_offline(plan: dict, snapshot_cells: dict[tuple[int, int, int], str], limit: int) -> dict:
    fp = resolve_footprint(plan)
    loc = fp["local"]
    idx = build_index(plan.get("cells") or [])
    mismatches = []
    ok = missing = wrong = extra = 0
    scanned = 0
    truncated = False
    for lx in range(loc["x"][0], loc["x"][1] + 1):
        for ly in range(loc["y"][0], loc["y"][1] + 1):
            for lz in range(loc["z"][0], loc["z"][1] + 1):
                if scanned >= limit:
                    truncated = True
                    break
                scanned += 1
                cell = idx.get((lx, ly, lz))
                expected = cell["block"] if cell else "air"
                observed = snapshot_cells.get((lx, ly, lz), "air")
                if not cell and observed.lower() in ("air", "cave_air", "void_air"):
                    ok += 1
                    continue
                if not cell and observed.lower() not in ("air", "cave_air", "void_air"):
                    extra += 1
                    mismatches.append(
                        {"local": [lx, ly, lz], "expected": "air", "observed": observed, "category": "extra"}
                    )
                    continue
                if cell and observed.lower() in ("air", "cave_air", "void_air"):
                    missing += 1
                    mismatches.append(
                        {
                            "local": [lx, ly, lz],
                            "expected": expected,
                            "observed": "air",
                            "category": "missing",
                        }
                    )
                    continue
                match, note = compare_blocks(expected, observed)
                if match:
                    ok += 1
                else:
                    wrong += 1
                    mismatches.append(
                        {
                            "local": [lx, ly, lz],
                            "expected": expected,
                            "observed": observed,
                            "category": "wrong",
                            "compare_note": note,
                        }
                    )
            if truncated:
                break
        if truncated:
            break
    return {
        "summary": {"ok": ok, "missing": missing, "wrong": wrong, "extra": extra, "scanned": scanned},
        "mismatches": mismatches[:20],
        "truncated": truncated,
    }


def cmd_verify_offline(args: argparse.Namespace) -> None:
    plan = load_plan(args.plan_id)
    with Path(args.snapshot).open() as f:
        snap = json.load(f)
    cells_map: dict[tuple[int, int, int], str] = {}
    anchor = plan.get("anchor", {}).get("coords") or [0, 0, 0]
    for c in snap.get("cells") or []:
        if "local" in c:
            cells_map[tuple(c["local"])] = c["block"]
        else:
            wx, wy, wz = c["x"], c["y"], c["z"]
            cells_map[(wx - anchor[0], wy - anchor[1], wz - anchor[2])] = c["block"]
    limit = min(args.limit or VERIFY_MAX, VERIFY_MAX)
    print(json.dumps(verify_offline(plan, cells_map, limit), indent=2))


def load_regions() -> list:
    fp = data_dir() / "regions-world.json"
    if not fp.is_file():
        return []
    with fp.open() as f:
        data = json.load(f)
    return data if isinstance(data, list) else data.get("regions") or []


def cmd_audit(_args: argparse.Namespace) -> None:
    regions = load_regions()
    by_plan = {r.get("plan"): r["id"] for r in regions if r.get("plan")}
    plan_files = sorted(plans_dir().glob("*-plan.json"))
    rows = []
    for pf in plan_files:
        pid = pf.name.replace("-plan.json", "")
        with pf.open() as f:
            plan = json.load(f)
        file_pid = plan.get("plan_id") or pid
        region_id = by_plan.get(file_pid) or by_plan.get(pid)
        rows.append(
            {
                "plan_id": file_pid,
                "path": str(pf.relative_to(REPO_ROOT)),
                "region": region_id,
                "bound": region_id is not None,
                "cells": len(plan.get("cells") or []),
            }
        )
    bound_plans = set(by_plan.keys())
    missing_files = sorted(bound_plans - {r["plan_id"] for r in rows})
    print(json.dumps({"plans": rows, "missing_plan_files_for_regions": missing_files}, indent=2))


def cmd_adopt_cell(args: argparse.Namespace) -> None:
    fp = resolve_plan_file(args.plan_id)
    with fp.open() as f:
        plan = json.load(f)
    cells = list(plan.get("cells") or [])
    key = (args.x, args.y, args.z)
    block = args.block.lower()
    if block in ("air", "cave_air", "void_air"):
        cells = [c for c in cells if tuple(c["local"]) != key]
    else:
        found = False
        for c in cells:
            if tuple(c["local"]) == key:
                c["block"] = block
                found = True
                break
        if not found:
            cells.append({"local": list(key), "block": block})
    plan["cells"] = cells
    plan.setdefault("history", []).append(
        {
            "at": args.at or "offline",
            "actor": args.actor or "blueprint-tool",
            "action": "adopted",
            "note": args.note,
        }
    )
    tmp = fp.with_suffix(".json.tmp")
    with tmp.open("w") as f:
        json.dump(plan, f, indent=2)
        f.write("\n")
    tmp.replace(fp)
    print(json.dumps({"ok": True, "local": list(key), "block": block}, indent=2))


def cmd_capture_from_snapshot(args: argparse.Namespace) -> None:
    with Path(args.snapshot).open() as f:
        snap = json.load(f)
    anchor = [int(x) for x in args.anchor.split(",")]
    corners = [tuple(int(v) for v in part.split(",")) for part in args.corners]
    (x1, y1, z1), (x2, y2, z2) = corners
    wx_min, wx_max = min(x1, x2), max(x1, x2)
    wy_min, wy_max = min(y1, y2), max(y1, y2)
    wz_min, wz_max = min(z1, z2), max(z1, z2)
    cells = []
    for c in snap.get("cells") or []:
        wx, wy, wz = c["x"], c["y"], c["z"]
        if wx_min <= wx <= wx_max and wy_min <= wy <= wy_max and wz_min <= wz <= wz_max:
            blk = c["block"]
            if blk.lower() in ("air", "cave_air", "void_air"):
                continue
            cells.append(
                {
                    "local": [wx - anchor[0], wy - anchor[1], wz - anchor[2]],
                    "block": blk,
                }
            )
    if not cells:
        raise SystemExit("No non-air cells in corners")
    footprint = tight_footprint_from_cells(cells)
    assert_plan_size(len(cells), footprint["local"])
    plan = {
        "kind": "construct",
        "plan_id": args.plan_id,
        "source": {"type": "captured", "captured_from": {"via": "snapshot", "snapshot": args.snapshot}},
        "footprint": footprint,
        "anchor": {"coords": anchor},
        "cells": cells,
        "history": [{"action": "captured", "count": len(cells)}],
    }
    out = plans_dir() / f"{args.plan_id}-plan.json"
    if out.exists() and not args.force:
        raise SystemExit(f"Plan exists: {out} (use --force)")
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as f:
        json.dump(plan, f, indent=2)
        f.write("\n")
    print(json.dumps({"plan_id": args.plan_id, "cells": len(cells), "path": str(out)}, indent=2))


def main() -> None:
    p = argparse.ArgumentParser(description="Blueprint plan library (offline)")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("show")
    s.add_argument("plan_id")
    s.set_defaults(func=cmd_show)

    s = sub.add_parser("cell")
    s.add_argument("plan_id")
    s.add_argument("--local", dest="local_xyz", metavar="X,Y,Z")
    s.add_argument("x", type=int, nargs="?", default=0)
    s.add_argument("y", type=int, nargs="?", default=0)
    s.add_argument("z", type=int, nargs="?", default=0)
    s.set_defaults(func=cmd_cell)

    s = sub.add_parser("layer")
    s.add_argument("plan_id")
    s.add_argument("--y", type=int, required=True)
    s.set_defaults(func=cmd_layer)

    s = sub.add_parser("materials")
    s.add_argument("plan_id")
    s.set_defaults(func=cmd_materials)

    s = sub.add_parser("verify-offline")
    s.add_argument("plan_id")
    s.add_argument("--snapshot", required=True)
    s.add_argument("--limit", type=int, default=VERIFY_MAX)
    s.set_defaults(func=cmd_verify_offline)

    s = sub.add_parser("audit")
    s.set_defaults(func=cmd_audit)

    s = sub.add_parser("adopt-cell")
    s.add_argument("plan_id")
    s.add_argument("--local", required=True, help="X,Y,Z local coords")
    s.add_argument("--block", required=True)
    s.add_argument("--note")
    s.add_argument("--actor")
    s.add_argument("--at")
    s.set_defaults(func=cmd_adopt_cell)

    s = sub.add_parser("capture-from-snapshot")
    s.add_argument("plan_id")
    s.add_argument("--snapshot", required=True)
    s.add_argument("--corners", nargs=2, required=True, metavar=("X1,Y1,Z1", "X2,Y2,Z2"))
    s.add_argument("--anchor", required=True, help="X,Y,Z world min corner")
    s.add_argument("--force", action="store_true")
    s.set_defaults(func=cmd_capture_from_snapshot)

    args = p.parse_args()
    if args.cmd == "adopt-cell":
        parts = [int(x) for x in args.local.split(",")]
        args.x, args.y, args.z = parts
    if args.cmd == "cell" and getattr(args, "local_xyz", None):
        parts = [int(x) for x in args.local_xyz.split(",")]
        args.x, args.y, args.z = parts
    args.func(args)


if __name__ == "__main__":
    main()
