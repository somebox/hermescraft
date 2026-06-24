#!/usr/bin/env python3
"""Capture a small Minecraft structure into a blueprint plan via read-only RCON probes.

The script is intended for operator captures of hand-built structures. It writes
the same plan shape used by the blueprint tooling, while preserving the requested
capture bounds as the footprint so intentional air around doors/signs remains
part of the schematic.

Pair with scripts/place-schematic-rcon.py to paste plans back into the world
(--sign-front for sign labels). Documented in docs/specs/world/blueprints-grabcraft.md.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from blueprint_lib import assert_plan_size, materials_planned_from_cells  # noqa: E402
from mapcatalog.rcon_client import make_rcon  # noqa: E402
from mapcatalog.server_config import load_server_config  # noqa: E402

DEFAULT_SERVER_CFG = REPO_ROOT / "server.local.yaml"
DEFAULT_OUT_DIR = REPO_ROOT / "data" / "ops" / "plans"
AIR_BLOCKS = {"air", "cave_air", "void_air"}

BASE_PALETTE = [
    "air",
    "grass_block",
    "dirt",
    "coarse_dirt",
    "stone",
    "cobblestone",
    "mossy_cobblestone",
    "stone_bricks",
    "oak_planks",
    "spruce_planks",
    "birch_planks",
    "dark_oak_planks",
    "jungle_planks",
    "acacia_planks",
    "oak_slab",
    "spruce_slab",
    "birch_slab",
    "stone_slab",
    "cobblestone_slab",
    "smooth_stone_slab",
    "oak_stairs",
    "spruce_stairs",
    "birch_stairs",
    "cobblestone_stairs",
    "stone_brick_stairs",
    "oak_log",
    "spruce_log",
    "birch_log",
    "stripped_oak_log",
    "stripped_spruce_log",
    "oak_door",
    "spruce_door",
    "birch_door",
    "oak_sign",
    "oak_wall_sign",
    "spruce_sign",
    "spruce_wall_sign",
    "birch_sign",
    "birch_wall_sign",
    "dark_oak_sign",
    "dark_oak_wall_sign",
    "torch",
    "wall_torch",
    "lantern",
    "glass",
    "glass_pane",
    "oak_fence",
    "spruce_fence",
    "oak_trapdoor",
    "spruce_trapdoor",
    "crafting_table",
    "furnace",
    "chest",
    "barrel",
    "white_bed",
    "red_bed",
    "yellow_bed",
    "blue_bed",
]


def parse_xyz(raw: str, *, allow_float: bool = False) -> tuple[int, int, int]:
    parts = [p.strip() for p in raw.split(",")]
    if len(parts) != 3:
        raise argparse.ArgumentTypeError(f"expected X,Y,Z, got {raw!r}")
    try:
        if allow_float:
            return tuple(int(float(p)) for p in parts)  # type: ignore[return-value]
        return tuple(int(p) for p in parts)  # type: ignore[return-value]
    except ValueError as e:
        raise argparse.ArgumentTypeError(f"expected numeric X,Y,Z, got {raw!r}") from e


def parse_range(raw: str) -> tuple[int, int, int]:
    xyz = parse_xyz(raw)
    if any(v < 0 for v in xyz):
        raise argparse.ArgumentTypeError("--range values must be non-negative")
    return xyz


def clean_rcon_text(out: str) -> str:
    out = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", out or "")
    # rcon-cli prompt-only lines are just noise for marker parsing.
    lines = []
    for line in out.splitlines():
        s = line.strip()
        if not s or s == ">":
            continue
        lines.append(s[2:].strip() if s.startswith("> ") else s)
    return "\n".join(lines)


def marker_hits(out: str, prefix: str) -> set[int]:
    clean = clean_rcon_text(out)
    pat = re.compile(rf"No help for {re.escape(prefix)}_(\d+)\b")
    return {int(m.group(1)) for m in pat.finditer(clean)}


def run_marker_predicates(client, commands: list[str], prefix: str) -> set[int]:
    if not commands:
        return set()
    return marker_hits(client.run_batch(commands), prefix)


def iter_box(
    x_min: int,
    y_min: int,
    z_min: int,
    x_max: int,
    y_max: int,
    z_max: int,
) -> Iterable[tuple[int, int, int]]:
    for y in range(y_min, y_max + 1):
        for z in range(z_min, z_max + 1):
            for x in range(x_min, x_max + 1):
                yield x, y, z


def assert_bounds_loaded(client, world: str, bounds: tuple[int, int, int, int, int, int]) -> None:
    x_min, y_min, z_min, x_max, y_max, z_max = bounds
    probes = [
        (x_min, y_min, z_min),
        (x_min, y_min, z_max),
        (x_max, y_min, z_min),
        (x_max, y_min, z_max),
        ((x_min + x_max) // 2, (y_min + y_max) // 2, (z_min + z_max) // 2),
    ]
    cmds = [f"execute in {world} if loaded {x} {y} {z}" for x, y, z in probes]
    out = clean_rcon_text(client.run_batch(cmds))
    failures = sum(1 for line in out.splitlines() if "Test failed" in line)
    if failures:
        raise SystemExit(
            "CAPTURE_BOUNDS_UNLOADED: at least one probe point is in an unloaded chunk. "
            "Stand near the structure again or forceload the chunk before capture."
        )


def block_state_candidates(block: str) -> list[str]:
    if block.endswith("_door"):
        out = []
        for half in ("lower", "upper"):
            for facing in ("north", "east", "south", "west"):
                for hinge in ("left", "right"):
                    for open_ in ("false", "true"):
                        for powered in ("false", "true"):
                            out.append(
                                f"{block}[facing={facing},half={half},hinge={hinge},open={open_},powered={powered}]"
                            )
        return out
    if block.endswith("_sign") and not block.endswith("_wall_sign"):
        return [f"{block}[rotation={rot},waterlogged={waterlogged}]" for rot in range(16) for waterlogged in ("false", "true")]
    if block.endswith("_wall_sign") or block == "wall_torch":
        return [f"{block}[facing={facing},waterlogged={waterlogged}]" for facing in ("north", "east", "south", "west") for waterlogged in ("false", "true")]
    if block.endswith("_slab"):
        return [f"{block}[type={typ},waterlogged={waterlogged}]" for typ in ("bottom", "top", "double") for waterlogged in ("false", "true")]
    if block.endswith("_stairs"):
        out = []
        for facing in ("north", "east", "south", "west"):
            for half in ("bottom", "top"):
                for shape in ("straight", "inner_left", "inner_right", "outer_left", "outer_right"):
                    for waterlogged in ("false", "true"):
                        out.append(f"{block}[facing={facing},half={half},shape={shape},waterlogged={waterlogged}]")
        return out
    if block == "furnace":
        return [f"furnace[facing={facing},lit={lit}]" for facing in ("north", "east", "south", "west") for lit in ("false", "true")]
    if block == "chest":
        return [
            f"chest[facing={facing},type={typ},waterlogged={waterlogged}]"
            for facing in ("north", "east", "south", "west")
            for typ in ("single", "left", "right")
            for waterlogged in ("false", "true")
        ]
    if block.endswith("_trapdoor"):
        return [
            f"{block}[facing={facing},half={half},open={open_},powered={powered},waterlogged={waterlogged}]"
            for facing in ("north", "east", "south", "west")
            for half in ("bottom", "top")
            for open_ in ("false", "true")
            for powered in ("false", "true")
            for waterlogged in ("false", "true")
        ]
    return []


def find_block_states(client, world: str, world_blocks: list[dict]) -> None:
    candidates: list[tuple[int, str]] = []
    commands: list[str] = []
    for cell_index, cell in enumerate(world_blocks):
        for state in block_state_candidates(cell["block"]):
            marker_index = len(candidates)
            candidates.append((cell_index, state))
            x, y, z = cell["world"]
            commands.append(f"execute in {world} if block {x} {y} {z} minecraft:{state} run help hcstate_{marker_index}")
    hits = run_marker_predicates(client, commands, "hcstate")
    for marker_index in sorted(hits):
        cell_index, state = candidates[marker_index]
        cell = world_blocks[cell_index]
        # First hit wins. Predicate candidates for one block should be mutually exclusive.
        cell.setdefault("block_state", state)


def should_capture_block_entity_nbt(block: str, include_containers: bool) -> bool:
    if block.endswith("_sign") or block.endswith("_wall_sign"):
        return True
    if include_containers and block in {"chest", "barrel", "furnace"}:
        return True
    return False


def get_block_entity_data(client, world: str, x: int, y: int, z: int) -> str | None:
    out = clean_rcon_text(client.run_batch([f"execute in {world} run data get block {x} {y} {z}"]))
    if not out or "not a block entity" in out.lower():
        return None
    return out


def get_sign_text(client, world: str, x: int, y: int, z: int) -> dict[str, str]:
    cmds = [
        f"execute in {world} run data get block {x} {y} {z} front_text.messages",
        f"execute in {world} run data get block {x} {y} {z} back_text.messages",
    ]
    lines = clean_rcon_text(client.run_batch(cmds)).splitlines()
    out: dict[str, str] = {}
    for key, line in zip(("front_messages", "back_messages"), lines):
        marker = "has the following block data:"
        if marker in line:
            out[key] = line.split(marker, 1)[1].strip()
        elif line:
            out[key] = line.strip()
    return out


def build_bounds(args: argparse.Namespace) -> tuple[int, int, int, int, int, int]:
    if args.corners:
        (x1, y1, z1), (x2, y2, z2) = args.corners
        x_min, x_max = min(x1, x2), max(x1, x2)
        y_min, y_max = min(y1, y2), max(y1, y2)
        z_min, z_max = min(z1, z2), max(z1, z2)
    else:
        if args.center is None or args.range is None:
            raise SystemExit("Provide either --corners X1,Y1,Z1 X2,Y2,Z2 or --center X,Y,Z --range DX,DY,DZ")
        cx, cy, cz = args.center
        rx, ry, rz = args.range
        x_min, x_max = cx - rx, cx + rx
        y_min, y_max = cy - ry, cy + ry
        z_min, z_max = cz - rz, cz + rz
    if args.expand_xz:
        x_min -= args.expand_xz
        x_max += args.expand_xz
        z_min -= args.expand_xz
        z_max += args.expand_xz
    return x_min, y_min, z_min, x_max, y_max, z_max


def capture_blocks(client, world: str, bounds: tuple[int, int, int, int, int, int], palette: list[str]) -> tuple[list[dict], list[list[int]]]:
    coords = list(iter_box(*bounds))
    non_air_cmds = []
    for i, (x, y, z) in enumerate(coords):
        non_air_cmds.append(f"execute in {world} unless block {x} {y} {z} minecraft:air run help hcna_{i}")
    non_air_hits = run_marker_predicates(client, non_air_cmds, "hcna")
    non_air_indices = sorted(non_air_hits)

    candidates: list[tuple[int, str]] = []
    block_cmds: list[str] = []
    for coord_index in non_air_indices:
        x, y, z = coords[coord_index]
        for block in palette:
            if block in AIR_BLOCKS:
                continue
            marker_index = len(candidates)
            candidates.append((coord_index, block))
            block_cmds.append(f"execute in {world} if block {x} {y} {z} minecraft:{block} run help hcblk_{marker_index}")
    block_hits = run_marker_predicates(client, block_cmds, "hcblk")

    by_coord: dict[int, str] = {}
    for marker_index in sorted(block_hits):
        coord_index, block = candidates[marker_index]
        by_coord.setdefault(coord_index, block)

    unknown = []
    cells = []
    for coord_index in non_air_indices:
        x, y, z = coords[coord_index]
        block = by_coord.get(coord_index)
        if not block:
            unknown.append([x, y, z])
            continue
        cells.append({"world": [x, y, z], "block": block})
    return cells, unknown


def make_plan(args: argparse.Namespace, bounds: tuple[int, int, int, int, int, int], world_blocks: list[dict], unknown: list[list[int]]) -> dict:
    x_min, y_min, z_min, x_max, y_max, z_max = bounds
    cells = []
    for c in world_blocks:
        wx, wy, wz = c["world"]
        out = {"local": [wx - x_min, wy - y_min, wz - z_min], "block": c["block"]}
        if c.get("block_state") and c["block_state"] != c["block"]:
            out["block_state"] = c["block_state"]
        if c.get("sign_text"):
            out["sign_text"] = c["sign_text"]
        if c.get("block_entity_data"):
            out["block_entity_data"] = c["block_entity_data"]
        cells.append(out)
    cells.sort(key=lambda c: (c["local"][1], c["local"][2], c["local"][0], c["block"]))

    footprint = {
        "mode": "capture_bounds",
        "local": {"x": [0, x_max - x_min], "y": [0, y_max - y_min], "z": [0, z_max - z_min]},
    }
    assert_plan_size(len(cells), footprint["local"])

    materials = [{"item": item, "count": count} for item, count in materials_planned_from_cells(cells)]
    anchor = {"coords": [x_min, y_min, z_min]}
    marker = args.origin_marker
    if marker:
        anchor["marker"] = {
            "coords": list(marker),
            "local": [marker[0] - x_min, marker[1] - y_min, marker[2] - z_min],
            "note": args.origin_note,
        }

    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    volume = (x_max - x_min + 1) * (y_max - y_min + 1) * (z_max - z_min + 1)
    return {
        "kind": "construct",
        "plan_id": args.plan_id,
        "source": {
            "type": "captured",
            "name": args.name or args.plan_id,
            "captured_from": {
                "via": "rcon_bounds",
                "world": args.world,
                "bounds": {"min": [x_min, y_min, z_min], "max": [x_max, y_max, z_max]},
                "center": list(args.center) if args.center else None,
                "range": list(args.range) if args.range else None,
                "expand_xz": args.expand_xz,
                "at": now,
            },
        },
        "footprint": footprint,
        "anchor": anchor,
        "materials_planned": materials,
        "stats": {
            "cells_planned": len(cells),
            "footprint_volume": volume,
            "air_cells": volume - len(cells) - len(unknown),
            "unknown_non_air": len(unknown),
        },
        "unknown_non_air": unknown,
        "cells": cells,
        "history": [
            {
                "at": now,
                "actor": "capture-schematic-rcon",
                "action": "captured",
                "count": len(cells),
                "note": args.note,
            }
        ],
    }


def auto_origin_marker(world_blocks: list[dict]) -> tuple[int, int, int] | None:
    signs = [tuple(c["world"]) for c in world_blocks if c["block"].endswith("_sign") or c["block"].endswith("_wall_sign")]
    if len(signs) == 1:
        return signs[0]  # type: ignore[return-value]
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Capture a bounded RCON schematic into data/ops/plans.")
    parser.add_argument("plan_id", help="Plan id slug; output defaults to data/ops/plans/<plan_id>-plan.json")
    bounds = parser.add_mutually_exclusive_group()
    bounds.add_argument("--corners", nargs=2, type=parse_xyz, metavar=("X1,Y1,Z1", "X2,Y2,Z2"))
    bounds.add_argument("--center", type=parse_xyz, help="Center block X,Y,Z; requires --range")
    parser.add_argument("--range", type=parse_range, help="Inclusive range DX,DY,DZ around --center")
    parser.add_argument("--expand-xz", type=int, default=0, help="Expand computed bounds in X/Z by N blocks")
    parser.add_argument("--origin-marker", type=parse_xyz, help="World coordinate of origin marker sign/block")
    parser.add_argument("--auto-origin-sign", action="store_true", help="Use the only captured sign as anchor.marker.coords")
    parser.add_argument("--origin-note", default="origin marker captured with schematic")
    parser.add_argument("--world", default="minecraft:overworld")
    parser.add_argument("--server-config", type=Path, default=DEFAULT_SERVER_CFG)
    parser.add_argument("--out", type=Path, help="Output plan path")
    parser.add_argument("--name")
    parser.add_argument("--note")
    parser.add_argument("--palette-extra", action="append", default=[], help="Extra block id to probe; repeatable")
    parser.add_argument("--include-container-nbt", action="store_true", help="Also store chest/barrel/furnace block entity NBT")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    if args.center and args.range is None:
        raise SystemExit("--center requires --range DX,DY,DZ")
    if args.range and args.center is None:
        raise SystemExit("--range requires --center X,Y,Z")
    if args.expand_xz < 0:
        raise SystemExit("--expand-xz must be non-negative")

    bounds_tuple = build_bounds(args)
    palette = sorted(set(BASE_PALETTE + [p.strip().removeprefix("minecraft:") for p in args.palette_extra if p.strip()]))
    client = make_rcon(load_server_config(args.server_config))
    assert_bounds_loaded(client, args.world, bounds_tuple)
    world_blocks, unknown = capture_blocks(client, args.world, bounds_tuple, palette)
    find_block_states(client, args.world, world_blocks)

    if args.auto_origin_sign and not args.origin_marker:
        args.origin_marker = auto_origin_marker(world_blocks)
        if not args.origin_marker:
            raise SystemExit("AUTO_ORIGIN_SIGN_FAILED: expected exactly one captured sign")

    for cell in world_blocks:
        x, y, z = cell["world"]
        if cell["block"].endswith("_sign") or cell["block"].endswith("_wall_sign"):
            sign_text = get_sign_text(client, args.world, x, y, z)
            if sign_text:
                cell["sign_text"] = sign_text
        if should_capture_block_entity_nbt(cell["block"], args.include_container_nbt):
            data = get_block_entity_data(client, args.world, x, y, z)
            if data:
                cell["block_entity_data"] = data

    plan = make_plan(args, bounds_tuple, world_blocks, unknown)
    out_path = args.out or (DEFAULT_OUT_DIR / f"{args.plan_id}-plan.json")
    summary = {
        "plan_id": args.plan_id,
        "path": str(out_path),
        "bounds": {"min": list(bounds_tuple[:3]), "max": list(bounds_tuple[3:])},
        "cells": len(plan["cells"]),
        "unknown_non_air": len(unknown),
        "origin_marker": plan["anchor"].get("marker"),
        "materials_planned": plan["materials_planned"],
    }
    if args.dry_run:
        print(json.dumps(summary, indent=2))
        return
    if out_path.exists() and not args.force:
        raise SystemExit(f"Plan exists: {out_path} (use --force)")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(plan, f, indent=2)
        f.write("\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
