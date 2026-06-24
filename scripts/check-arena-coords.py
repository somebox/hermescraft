#!/usr/bin/env python3
"""Static coord-bounds check for functional tests.

Scans Python under given paths (default tests/functional) for coordinate
triples inside common rcon / arena calls and asserts they fall within the
canonical arena bbox.

Legacy Tier-2 YAML under data/test-fixtures/ (non-combat L0/L5/… and
agent-driven L3) intentionally uses (52, 65, 52) safe-home — not scanned
by default. Migrated combat specs live in tests/functional/combat/scenarios.py.

Usage:
  python3 scripts/check-arena-coords.py             # report only, exit 0
  python3 scripts/check-arena-coords.py --strict    # exit 1 on any offender
  python3 scripts/check-arena-coords.py tests/functional tests/integration --strict
  python3 scripts/check-arena-coords.py --feet-strict
                                                    # also flag tp/place_player Y != 65
  python3 scripts/check-arena-coords.py --observation-bbox --strict
                                                    # lean observation zone ±16 (X/Z)
  python3 scripts/check-arena-coords.py --observation-bbox 8
                                                    # custom half-extent
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys

ARENA_X = (-32, 32)
ARENA_Z = (-32, 32)
ARENA_Y = (50, 80)
CANONICAL_FEET_Y = 65
OBSERVATION_HALF_DEFAULT = 16

COORD_PATTERNS = [
    (
        re.compile(
            r"tp\s+\w+\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)"
        ),
        "tp",
    ),
    (re.compile(r"setblock\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)"), "setblock"),
    (
        re.compile(
            r"fill\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)"
        ),
        "fill",
    ),
    (
        re.compile(
            r"place_player\([^,)]+,\s*(-?\d+(?:\.\d+)?)\s*,\s*"
            r"(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)"
        ),
        "place_player",
    ),
]

SKIP_RE = re.compile(r"#\s*arena-coords:\s*skip")


def check(
    path: pathlib.Path,
    feet_strict: bool,
    *,
    x_bounds: tuple[float, float],
    z_bounds: tuple[float, float],
    label: str,
) -> list[str]:
    text = path.read_text()
    offenders: list[str] = []
    for lineno, line in enumerate(text.splitlines(), 1):
        if SKIP_RE.search(line):
            continue
        for pat, kind in COORD_PATTERNS:
            for m in pat.finditer(line):
                groups = [float(g) for g in m.groups()]
                for i in range(0, len(groups), 3):
                    x, y, z = groups[i], groups[i + 1], groups[i + 2]
                    if not (x_bounds[0] <= x <= x_bounds[1]):
                        offenders.append(
                            f"{path}:{lineno} {kind} x={x} outside "
                            f"{label} x [{x_bounds[0]},{x_bounds[1]}]: {line.strip()}"
                        )
                    if not (ARENA_Y[0] <= y <= ARENA_Y[1]):
                        offenders.append(
                            f"{path}:{lineno} {kind} y={y} outside "
                            f"[{ARENA_Y[0]},{ARENA_Y[1]}]: {line.strip()}"
                        )
                    if not (z_bounds[0] <= z <= z_bounds[1]):
                        offenders.append(
                            f"{path}:{lineno} {kind} z={z} outside "
                            f"{label} z [{z_bounds[0]},{z_bounds[1]}]: {line.strip()}"
                        )
                    if feet_strict and kind in ("tp", "place_player"):
                        if int(y) != CANONICAL_FEET_Y:
                            offenders.append(
                                f"{path}:{lineno} {kind} feet y={y} != "
                                f"canonical {CANONICAL_FEET_Y} "
                                f"(add `# arena-coords: skip` to opt out): "
                                f"{line.strip()}"
                            )
    return offenders


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--strict", action="store_true", help="exit 1 on any offender")
    ap.add_argument(
        "--feet-strict",
        action="store_true",
        help="also flag tp/place_player Y != 65",
    )
    ap.add_argument(
        "--observation-bbox",
        nargs="?",
        type=int,
        const=OBSERVATION_HALF_DEFAULT,
        metavar="HALF",
        help=(
            f"use ±HALF observation zone for X/Z (default {OBSERVATION_HALF_DEFAULT} "
            "when flag is set without a value); full arena ±32 when omitted"
        ),
    )
    ap.add_argument("paths", nargs="*", default=["tests/functional"])
    args = ap.parse_args()

    if args.observation_bbox is not None:
        half = args.observation_bbox
        x_bounds = (-half, half)
        z_bounds = (-half, half)
        label = f"observation ±{half}"
    else:
        x_bounds = ARENA_X
        z_bounds = ARENA_Z
        label = "arena"

    found: list[str] = []
    for p in args.paths:
        for f in pathlib.Path(p).rglob("*.py"):
            found.extend(
                check(
                    f,
                    feet_strict=args.feet_strict,
                    x_bounds=x_bounds,
                    z_bounds=z_bounds,
                    label=label,
                )
            )
    if found:
        print("\n".join(found))
        print(f"\n{len(found)} offender(s) ({label}).")
        return 1 if args.strict else 0
    bound_msg = (
        f"observation ±{args.observation_bbox} (X/Z)"
        if args.observation_bbox is not None
        else "canonical arena bounds"
    )
    print(f"All coords within {bound_msg}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
