#!/usr/bin/env python3
"""Place a blueprint plan into the world via RCON setblock commands.

Plans use ``anchor.coords`` as the world position of the footprint **minimum** local
corner. World coords follow ``local_to_world`` in ``scripts/blueprint_lib.py`` (same as
``bot/lib/runtime/blueprints/footprint.js``). Use ``block_state`` when present.
Sign front line 1 is applied via ``data modify`` after setblock (``--sign-front`` or plan
``sign_text`` by default).

See docs/specs/world/blueprints-grabcraft.md (RCON capture/paste).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from blueprint_lib import anchor_from_marker, footprint_mins, local_to_world  # noqa: E402
from mapcatalog.rcon_client import make_rcon  # noqa: E402
from mapcatalog.server_config import load_server_config  # noqa: E402

DEFAULT_SERVER_CFG = REPO_ROOT / "server.local.yaml"
_blueprint_tool = SourceFileLoader(
    "blueprint_tool", str(REPO_ROOT / "scripts" / "blueprint-tool.py")
).load_module()


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


def clean_rcon_text(out: str) -> str:
    out = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", out or "")
    lines = []
    for line in out.splitlines():
        s = line.strip()
        if not s or s == ">":
            continue
        lines.append(s[2:].strip() if s.startswith("> ") else s)
    return "\n".join(lines)


def player_pos(client, name: str) -> tuple[list[float], str]:
    out = clean_rcon_text(
        client.run_batch(
            [
                f"data get entity @a[name={name},limit=1] Pos",
                f"data get entity @a[name={name},limit=1] Dimension",
            ]
        )
    )
    lines = [ln for ln in out.splitlines() if ln]
    if len(lines) < 2:
        raise SystemExit(f"PLAYER_NOT_FOUND: {name}")
    pos_m = re.search(r"\[(-?\d+\.?\d*)d,\s*(-?\d+\.?\d*)d,\s*(-?\d+\.?\d*)d\]", lines[0])
    if not pos_m:
        raise SystemExit(f"Could not parse Pos: {lines[0]!r}")
    pos = [float(pos_m.group(i)) for i in range(1, 4)]
    dim_m = re.search(r'"([^"]+)"', lines[1])
    if not dim_m:
        raise SystemExit(f"Could not parse Dimension: {lines[1]!r}")
    return pos, dim_m.group(1)


def footprint_center_local(plan: dict) -> tuple[int, int, int]:
    fp = plan.get("footprint", {}).get("local") or {"x": [0, 0], "y": [0, 0], "z": [0, 0]}
    cx = (fp["x"][0] + fp["x"][1]) // 2
    cy = fp["y"][0] + 1  # stand on top of lowest layer
    cz = (fp["z"][0] + fp["z"][1]) // 2
    return cx, cy, cz


def plan_footprint(plan: dict) -> dict:
    fp = plan.get("footprint")
    if fp and fp.get("local"):
        return fp
    return {"mode": "tight", "local": {"x": [0, 0], "y": [0, 0], "z": [0, 0]}}


def resolve_anchor(plan: dict, args: argparse.Namespace, client) -> list[int]:
    footprint = plan_footprint(plan)
    if args.at is not None:
        return list(args.at)
    if args.at_player:
        pos, _dim = player_pos(client, args.at_player)
        px, py, pz = int(pos[0]), int(pos[1]), int(pos[2])
        if args.anchor_mode == "min_corner":
            return [px, py - 1, pz]
        if args.anchor_mode == "marker":
            marker = (plan.get("anchor") or {}).get("marker") or {}
            mlocal = marker.get("local")
            if not mlocal or len(mlocal) != 3:
                raise SystemExit("PLAN_HAS_NO_MARKER_LOCAL: use --anchor-mode center or --at X,Y,Z")
            return anchor_from_marker([px, py, pz], footprint)
        # center: player block position ~= footprint center at stand height
        lx, ly, lz = footprint_center_local(plan)
        mx, my, mz = footprint_mins(footprint)
        return [px - (lx - mx), py - (ly - my), pz - (lz - mz)]
    raise SystemExit("Provide --at X,Y,Z or --at-player NAME")


def block_descriptor(cell: dict) -> str:
    state = cell.get("block_state")
    if state:
        return state if state.startswith("minecraft:") else f"minecraft:{state}"
    block = cell["block"]
    return block if block.startswith("minecraft:") else f"minecraft:{block}"


def is_sign_cell(cell: dict) -> bool:
    block = cell.get("block") or ""
    return block.endswith("_sign") or block.endswith("_wall_sign")


def parse_first_front_message(raw: str) -> str | None:
    """Extract first non-empty line from capture-schematic ``front_messages`` string."""
    if not raw:
        return None
    for m in re.finditer(r'"([^"]*)"', raw):
        text = m.group(1)
        if text:
            return text
    return None


def sign_front_snbt(front_lines: list[str]) -> str:
    """SNBT fragment for sign ``front_text.messages`` (four JSON text components).

    Prefer :func:`sign_text_modify_commands` after setblock — Paper often ignores
    front_text on setblock for signs.
    """
    padded = (list(front_lines) + ["", "", "", ""])[:4]
    parts = []
    for line in padded:
        comp = json.dumps({"text": line}, separators=(",", ":"))
        parts.append(f"'{comp}'")
    return "{" + f"front_text:{{messages:[{','.join(parts)}]}}" + "}"


def snbt_sign_message_token(text: str) -> str:
    """One ``messages[]`` entry as stored on block entities (e.g. ``'"Base"'``)."""
    if not text:
        return "'\"\"'"
    escaped = text.replace("\\", "\\\\").replace('"', '\\"')
    return f'\'"{escaped}"\''


def sign_text_modify_commands(world: str, wx: int, wy: int, wz: int, front_line: str) -> list[str]:
    slots = [front_line, "", "", ""]
    arr = "[" + ",".join(snbt_sign_message_token(s) for s in slots) + "]"
    return [
        f"execute in {world} run data modify block {wx} {wy} {wz} front_text.messages set value {arr}"
    ]


def sign_front_line_for_cell(
    cell: dict,
    *,
    sign_front_override: str | None,
    apply_plan_sign_text: bool,
) -> str | None:
    if sign_front_override is not None:
        return sign_front_override
    if not apply_plan_sign_text:
        return None
    st = cell.get("sign_text") or {}
    return parse_first_front_message(st.get("front_messages") or "")


def setblock_command(world: str, wx: int, wy: int, wz: int, cell: dict) -> str:
    bid = block_descriptor(cell)
    return f"execute in {world} run setblock {wx} {wy} {wz} {bid} replace"


def sort_cells(cells: list[dict]) -> list[dict]:
    return sorted(cells, key=lambda c: (c["local"][1], c["local"][2], c["local"][0], c.get("block", "")))


def world_coords(anchor: list[int], footprint: dict, cell: dict) -> tuple[int, int, int]:
    lx, ly, lz = cell["local"]
    return local_to_world(anchor, footprint, lx, ly, lz)


def assert_destination_loaded(client, world: str, anchor: list[int], plan: dict) -> None:
    fp = plan_footprint(plan)
    loc = fp["local"]
    probes = [
        local_to_world(anchor, fp, loc["x"][0], loc["y"][0], loc["z"][0]),
        local_to_world(anchor, fp, loc["x"][1], loc["y"][1], loc["z"][1]),
        local_to_world(
            anchor,
            fp,
            (loc["x"][0] + loc["x"][1]) // 2,
            (loc["y"][0] + loc["y"][1]) // 2,
            (loc["z"][0] + loc["z"][1]) // 2,
        ),
    ]
    cmds = [f"execute in {world} if loaded {x} {y} {z}" for x, y, z in probes]
    out = clean_rcon_text(client.run_batch(cmds))
    if "Test failed" in out or "not loaded" in out.lower():
        raise SystemExit(
            "PLACE_BOUNDS_UNLOADED: destination chunk not loaded — stand near the paste site."
        )


def run_setblocks(client, world: str, commands: list[str], *, dry_run: bool) -> None:
    if dry_run:
        for c in commands[:20]:
            print(c)
        if len(commands) > 20:
            print(f"... and {len(commands) - 20} more setblock commands")
        return
    batch_size = 40
    for i in range(0, len(commands), batch_size):
        chunk = commands[i : i + batch_size]
        client.run_batch(chunk)


def main() -> None:
    parser = argparse.ArgumentParser(description="Place a blueprint plan via RCON setblock.")
    parser.add_argument("plan_id", help="Plan id or path (e.g. re44-house)")
    dest = parser.add_mutually_exclusive_group(required=True)
    dest.add_argument("--at", type=parse_xyz, help="World coords for placement anchor (min corner)")
    dest.add_argument("--at-player", metavar="NAME", help="Place relative to this online player")
    parser.add_argument(
        "--anchor-mode",
        choices=("center", "min_corner", "marker"),
        default="center",
        help="With --at-player: center footprint on player (default), min corner at feet, or marker at feet",
    )
    parser.add_argument("--world", help="Override dimension id (default: player dimension or minecraft:overworld)")
    parser.add_argument("--server-config", type=Path, default=DEFAULT_SERVER_CFG)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--batch-size", type=int, default=40)
    parser.add_argument(
        "--sign-front",
        metavar="TEXT",
        help="Set sign front line 1 on every pasted sign (overrides plan sign_text)",
    )
    parser.add_argument(
        "--no-plan-sign-text",
        action="store_true",
        help="Skip applying sign_text from the plan when --sign-front is omitted",
    )
    args = parser.parse_args()

    plan = _blueprint_tool.load_plan(args.plan_id)
    cells = sort_cells(list(plan.get("cells") or []))
    if not cells:
        raise SystemExit("Plan has no cells")

    client = make_rcon(load_server_config(args.server_config))
    world = args.world
    if args.at_player and not world:
        _, world = player_pos(client, args.at_player)
    if not world:
        world = "minecraft:overworld"

    anchor = resolve_anchor(plan, args, client)
    footprint = plan_footprint(plan)
    assert_destination_loaded(client, world, anchor, plan)

    sign_cells = sum(1 for c in cells if is_sign_cell(c))
    apply_plan_sign_text = not args.no_plan_sign_text
    commands: list[str] = []
    sign_text_cmds = 0
    setblock_count = 0
    for cell in cells:
        wx, wy, wz = world_coords(anchor, footprint, cell)
        commands.append(setblock_command(world, wx, wy, wz, cell))
        setblock_count += 1
        if is_sign_cell(cell):
            front = sign_front_line_for_cell(
                cell,
                sign_front_override=args.sign_front,
                apply_plan_sign_text=apply_plan_sign_text,
            )
            if front is not None:
                sign_text_cmds += 1
                commands.extend(sign_text_modify_commands(world, wx, wy, wz, front))

    summary = {
        "plan_id": plan.get("plan_id"),
        "world": world,
        "anchor": anchor,
        "cells": setblock_count,
        "rcon_commands": len(commands),
        "sign_cells": sign_cells,
        "sign_text_applied": sign_text_cmds,
        "dry_run": args.dry_run,
        "sample_world": [world_coords(anchor, footprint, cells[0]), block_descriptor(cells[0])] if cells else None,
    }
    if args.dry_run:
        run_setblocks(client, world, commands, dry_run=True)
        print(json.dumps(summary, indent=2))
        return

    run_setblocks(client, world, commands, dry_run=False)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
