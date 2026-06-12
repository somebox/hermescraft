#!/usr/bin/env python3
"""Place a supply chest near muster with tools + materials for road work.

The road tier's clear/fill cards expect the builders to have basic tools.
Without this, Pip spawned with no tools and spent ~15min crafting a stone
pickaxe from raw wood before doing any road work (proc-nav-1780966603).

This script places ONE chest at a location adjacent to the muster anchor
and merges item slots so any builder card can walk over, `mc chest open`,
and withdraw what it needs:

  - Iron tools (pickaxe, axe, shovel × 4 each) for digging stone + clearing trees
  - Stacks of cobblestone, dirt, oak_planks, oak_log for building / repair
  - Water buckets (for fire safety / bridge supports)
  - Cooked beef + torches for survival edge cases

Also posts a `supply_chest` mark to both bots so the planner card can
reference it by name.

Usage:
  python3 scripts/prep-proc-nav-supply-chest.py [--server server.local.yaml]

Env:
  PROC_NAV_SUPPLY_OFFSET   "dx,dy,dz" relative to muster. Default "2,0,0" (east).
  PROC_NAV_BOT_PORTS       Comma-list, default "3007,3005,3004" (Mox, Pip, Tester)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))

from mapcatalog.rcon_client import make_rcon  # noqa: E402
from mapcatalog.server_config import load_server_config  # noqa: E402

REPO_ROOT = _HERE.parent
LAST_MAP = REPO_ROOT / "data" / "runtime" / "last-scenario-map.json"

# Item plan — slot 0..26 of a single chest. Stack sizes:
#   tools = 1 per slot (4 slots = 4 tools)
#   cobblestone/dirt/planks/log = 64 stacks
#   sticks = 64, torches = 64, beef = 64
#   water_bucket = 1 per slot
SUPPLY_ITEMS = [
    # row 1 — tools
    (0,  "minecraft:iron_pickaxe", 1),
    (1,  "minecraft:iron_pickaxe", 1),
    (2,  "minecraft:iron_pickaxe", 1),
    (3,  "minecraft:iron_pickaxe", 1),
    (4,  "minecraft:iron_axe", 1),
    (5,  "minecraft:iron_axe", 1),
    (6,  "minecraft:iron_shovel", 1),
    (7,  "minecraft:iron_shovel", 1),
    (8,  "minecraft:iron_sword", 1),
    # row 2 — stone materials
    (9,  "minecraft:cobblestone", 64),
    (10, "minecraft:cobblestone", 64),
    (11, "minecraft:cobblestone", 64),
    (12, "minecraft:stone", 64),
    (13, "minecraft:stone", 64),
    # row 2 cont — dirt + planks
    (14, "minecraft:dirt", 64),
    (15, "minecraft:dirt", 64),
    (16, "minecraft:dirt", 64),
    (17, "minecraft:oak_planks", 64),
    # row 3 — wood + sticks + buckets + survival
    (18, "minecraft:oak_log", 32),
    (19, "minecraft:oak_log", 32),
    (20, "minecraft:stick", 32),
    (21, "minecraft:water_bucket", 1),
    (22, "minecraft:water_bucket", 1),
    (23, "minecraft:torch", 32),
    (24, "minecraft:cooked_beef", 32),
    (25, "minecraft:crafting_table", 4),
    (26, "minecraft:furnace", 2),
]


def _load_muster_xyz() -> tuple[int, int, int]:
    if not LAST_MAP.is_file():
        raise SystemExit(f"missing {LAST_MAP} — run scenario-agent-test or restore catalog map first")
    data = json.loads(LAST_MAP.read_text())
    placements = data.get("placements") or {}
    raw = placements.get("muster") or data.get("muster")
    if not (isinstance(raw, (list, tuple)) and len(raw) >= 3):
        raise SystemExit("muster anchor not in last-scenario-map.json")
    return int(raw[0]), int(raw[1]), int(raw[2])


def _find_ground_y(x: int, z: int, port: int) -> int | None:
    """Return the chest Y (= first full-block air cell above true ground).

    The bot's ``/action/terrain_top`` endpoint already does the right thing:
    returns ``block_y`` (top SOLID/full block) and ``surface_y`` (the air
    cell above it). We use ``surface_y`` directly so the chest sits ON the
    surface — not embedded inside snow_layer / slab / tall_grass type
    partial-height blocks that a naive `is_air=false` walk would treat as
    "solid" and stop on too high.

    Falls back to a per-cell `mc inspect` walk that explicitly filters out
    non-collidable + partial-height shapes if the endpoint isn't available.
    """
    # Primary: bot's terrain_top knows about block shape vs solidity.
    url = f"http://127.0.0.1:{port}/action/terrain_top"
    try:
        body = json.dumps({"x": x, "z": z}).encode()
        req = urllib.request.Request(
            url, data=body, headers={"content-type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            payload = json.loads(resp.read().decode())
        surface_y = payload.get("surface_y") or (payload.get("data") or {}).get("surface_y")
        if isinstance(surface_y, int):
            return int(surface_y)
    except Exception:  # noqa: BLE001
        pass

    # Fallback: per-cell inspect, but skip partial-height shapes. A "full"
    # block has bounding_box == "block"; slabs/stairs/layers don't.
    inspect_url = f"http://127.0.0.1:{port}/action/inspect"
    for y in range(110, 49, -1):
        body = json.dumps({"x": x, "y": y, "z": z}).encode()
        req = urllib.request.Request(
            inspect_url, data=body, headers={"content-type": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=3) as resp:
                payload = json.loads(resp.read().decode())
        except Exception:  # noqa: BLE001
            return None
        block = (payload.get("data") or {}).get("block") or {}
        is_air = bool(block.get("is_air"))
        name = block.get("name", "")
        bbox = block.get("bounding_box", "")
        if is_air or name in ("water", "lava"):
            continue
        # Skip partial-height surface blocks (snow_layer, slabs, carpet,
        # tall_grass, flower, sapling, …). They don't support an entity
        # cleanly and don't make a stable chest base.
        if bbox != "block":
            continue
        return y + 1  # chest sits one cell above the top FULL solid block
    return None


def _offset() -> tuple[int, int, int]:
    raw = os.environ.get("PROC_NAV_SUPPLY_OFFSET", "2,0,0")
    parts = [int(x.strip()) for x in raw.split(",")]
    if len(parts) != 3:
        raise SystemExit(f"PROC_NAV_SUPPLY_OFFSET must be 'dx,dy,dz' (got {raw!r})")
    return parts[0], parts[1], parts[2]


def _items_nbt() -> str:
    parts = []
    for slot, item_id, count in SUPPLY_ITEMS:
        parts.append(f'{{Slot:{slot}b,id:"{item_id}",Count:{count}b}}')
    return "[" + ",".join(parts) + "]"


def _post_mark(port: int, name: str, x: int, y: int, z: int, note: str) -> None:
    url = f"http://127.0.0.1:{port}/action/mark"
    body = json.dumps({"name": name, "at": {"x": x, "y": y, "z": z}, "note": note}).encode()
    req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            resp.read()
        print(f"[supply-chest] mark posted to :{port}")
    except Exception as exc:  # noqa: BLE001
        print(f"[supply-chest] mark FAILED on :{port}: {exc}", file=sys.stderr)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default=str(REPO_ROOT / "server.local.yaml"))
    args = ap.parse_args()

    mx, my, mz = _load_muster_xyz()
    dx, dy, dz = _offset()
    cx_target, cz_target = mx + dx, mz + dz
    # Find live ground at the target XZ — catalog Y is often the placement
    # engine's "highest cell in disc" which sits in air over real terrain.
    probe_port = int(os.environ.get("PROC_NAV_BOT_PORTS", "3007").split(",")[0])
    live_cy = _find_ground_y(cx_target, cz_target, port=probe_port)
    if live_cy is None:
        cy = my + dy
        print(f"[supply-chest] WARN: ground probe failed at ({cx_target},{cz_target}); falling back to catalog Y={cy}", file=sys.stderr)
    else:
        cy = live_cy
        if cy != my + dy:
            print(f"[supply-chest] catalog Y={my + dy} adjusted to live ground Y={cy} (anchor was in air)")
    cx, cz = cx_target, cz_target
    cfg = load_server_config(Path(args.server))
    world = cfg.world_name
    print(f"[supply-chest] muster=({mx},{my},{mz}) → chest @ ({cx},{cy},{cz}) in {world}")

    client = make_rcon(cfg)
    try:
        # Place the chest block first (replace whatever is there). Also place
        # a solid block under it so it doesn't fall on bots / stays stable.
        client.run(f"execute in {world} run setblock {cx} {cy-1} {cz} minecraft:cobblestone")
        client.run(f"execute in {world} run setblock {cx} {cy} {cz} minecraft:chest")
        # Insert each item via `data modify ... append` — more reliable than
        # one giant `data merge` (which silently rejects on length/format
        # quirks). Each call sets ONE slot.
        ok = 0
        for slot, item_id, count in SUPPLY_ITEMS:
            cmd = (
                f"execute in {world} run data modify block {cx} {cy} {cz} "
                f"Items append value "
                f'{{Slot:{slot}b,id:"{item_id}",count:{count}}}'
            )
            out = client.run(cmd)
            if out and "modified" in out.lower():
                ok += 1
        # Confirmation read.
        out = client.run(
            f"execute in {world} run data get block {cx} {cy} {cz} Items"
        )
        if out:
            preview = out[:300].replace("\n", " ")
            print(f"[supply-chest] {ok}/{len(SUPPLY_ITEMS)} slots set; sample: {preview}")
    finally:
        close = getattr(client, "close", None)
        if callable(close):
            close()

    # Post supply_chest mark to all bots so any role can resolve it.
    ports = [int(p) for p in os.environ.get("PROC_NAV_BOT_PORTS", "3007,3005,3004").split(",")]
    for port in ports:
        _post_mark(port, "supply_chest", cx, cy, cz,
                   "Tools, stone, dirt, planks, logs, sticks, water buckets, food, torches")

    print(f"[supply-chest] done — {len(SUPPLY_ITEMS)} slots @ ({cx},{cy},{cz})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
