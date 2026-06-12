#!/usr/bin/env python3
"""Generate and optionally apply the W2 discovery arena in landfolk-test.

Seeded layout (grass envelope, uneven surface, two water pools, tall grass).
Writes ``discovery_layout.json`` for verify prep and acceptance replay.

Usage:
  WHEAT_DISCOVERY_SEED=1780879052 python3 scripts/prep-wheat-discovery.py --write-layout
  python3 scripts/prep-wheat-discovery.py --apply   # rcon via ssh (fixture prep)
"""
from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LAYOUT = REPO_ROOT / "data" / "tmp" / "wheat_discovery_layout.json"
GENERATOR_VERSION = 1

# Arena anchor (landfolk-test); spans ~48 blocks per axis.
ORIGIN_X = -50
ORIGIN_Y = 64
ORIGIN_Z = 50
SPAN = 24  # half-width → 48×48 envelope


def _seed_from_env(explicit: int | None) -> int:
    if explicit is not None:
        return explicit
    raw = os.environ.get("WHEAT_DISCOVERY_SEED") or os.environ.get("RUN_ID", "w2-default")
    return abs(hash(raw)) % (2**31)


def generate_layout(seed: int) -> dict:
    rng = random.Random(seed)
    x1, x2 = ORIGIN_X - SPAN, ORIGIN_X + SPAN
    z1, z2 = ORIGIN_Z - SPAN, ORIGIN_Z + SPAN

    def pick_pool(label: str) -> dict:
        for _ in range(200):
            px = rng.randint(x1 + 4, x2 - 4)
            pz = rng.randint(z1 + 4, z2 - 4)
            if abs(px - ORIGIN_X) + abs(pz - ORIGIN_Z) > 8:
                return {"id": label, "x": px, "y": ORIGIN_Y, "z": pz}
        return {"id": label, "x": ORIGIN_X - 12, "y": ORIGIN_Y, "z": ORIGIN_Z + 10}

    pool_a = pick_pool("A")
    pool_b = pick_pool("B")
    while abs(pool_a["x"] - pool_b["x"]) + abs(pool_a["z"] - pool_b["z"]) < 14:
        pool_b = pick_pool("B")

    grass_patches: list[dict] = []
    for _ in range(12):
        grass_patches.append({
            "x": rng.randint(x1 + 2, x2 - 2),
            "z": rng.randint(z1 + 2, z2 - 2),
            "tall": rng.random() < 0.6,
        })

    tester_x = ORIGIN_X
    tester_y = ORIGIN_Y + 1
    tester_z = ORIGIN_Z + 8
    mox_x = ORIGIN_X - 5
    mox_y = ORIGIN_Y + 1
    mox_z = ORIGIN_Z

    return {
        "generator_version": GENERATOR_VERSION,
        "fixture_seed": seed,
        "arena": {"x1": x1, "x2": x2, "z1": z1, "z2": z2, "floor_y": ORIGIN_Y},
        "pool_a": pool_a,
        "pool_b": pool_b,
        "grass_patches": grass_patches,
        "marks": {
            "wheat_start": {"x": mox_x, "y": mox_y, "z": mox_z},
            "arena_se": {"x": x2, "y": ORIGIN_Y, "z": z2},
        },
        "verify_observer": {
            "tester": {"x": tester_x, "y": tester_y, "z": tester_z},
            "mox": {"x": mox_x, "y": mox_y, "z": mox_z},
        },
    }


def rcon_commands(layout: dict) -> list[str]:
    a = layout["arena"]
    x1, x2, z1, z2, fy = a["x1"], a["x2"], a["z1"], a["z2"], a["floor_y"]
    cmds: list[str] = []
    cmds.append(f"execute in landfolk-test run gamerule randomTickSpeed 500")
    cmds.append(f"execute in landfolk-test run forceload add {x1 - 16} {z1 - 16} {x2 + 16} {z2 + 16}")
    cmds.append(f"execute in landfolk-test run fill {x1} {fy + 1} {z1} {x2} {fy + 14} {z2} minecraft:air")
    cmds.append(f"execute in landfolk-test run fill {x1} {fy - 5} {z1} {x2} {fy - 5} {z2} minecraft:bedrock")
    cmds.append(f"execute in landfolk-test run fill {x1} {fy - 4} {z1} {x2} {fy - 2} {z2} minecraft:stone")

    rng = random.Random(layout["fixture_seed"] + 99)
    for x in range(x1, x2 + 1):
        for z in range(z1, z2 + 1):
            h = rng.choice([0, 0, 0, 1, -1])
            top = fy + h
            cmds.append(
                f"execute in landfolk-test run setblock {x} {top} {z} "
                f"minecraft:{'dirt' if rng.random() < 0.12 else 'grass_block'}"
            )
            if h > 0:
                cmds.append(f"execute in landfolk-test run fill {x} {fy} {z} {x} {top - 1} {z} minecraft:dirt")

    for pool in (layout["pool_a"], layout["pool_b"]):
        cmds.append(
            f"execute in landfolk-test run setblock {pool['x']} {pool['y']} {pool['z']} minecraft:water"
        )

    for patch in layout["grass_patches"]:
        block = "tall_grass" if patch["tall"] else "grass"
        cmds.append(
            f"execute in landfolk-test run setblock {patch['x']} {fy + 1} {patch['z']} minecraft:{block}"
        )

    ms = layout["marks"]["wheat_start"]
    cmds.append("mvtp Mox landfolk-test")
    cmds.append(f"execute in landfolk-test run tp Mox {ms['x']} {ms['y']} {ms['z']}")
    cmds.append("clear Mox")
    cmds.append("give Mox minecraft:iron_hoe 1")
    cmds.append("give Mox minecraft:wheat_seeds 16")
    cmds.append("effect give Mox minecraft:saturation 1 10")
    cmds.append("effect give Tester minecraft:saturation 1 10")
    cmds.append("gamemode creative Tester")
    vo = layout["verify_observer"]["tester"]
    cmds.append(
        f"execute in landfolk-test run tp Tester {vo['x']} {vo['y']} {vo['z']}"
    )
    return cmds


def run_rcon(cmd: str) -> None:
    host = os.environ.get("MC_HOST_SSH", "ubuntu-host")
    docker = os.environ.get("MC_DOCKER_NAME", "minecraft")
    inner = cmd.replace("'", "'\"'\"'")
    full = f"sudo docker exec {docker} rcon-cli '{inner}'"
    subprocess.run(["ssh", "-n", host, full], check=False)


def post_marks(layout: dict) -> None:
    import urllib.request

    marks = layout["marks"]
    for name, at in marks.items():
        body = json.dumps({"name": name, "at": at, "note": f"discovery anchor {name}"}).encode()
        for port in (3007, 3004):
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/action/mark",
                data=body,
                headers={"content-type": "application/json"},
                method="POST",
            )
            try:
                urllib.request.urlopen(req, timeout=5)
            except Exception as exc:  # noqa: BLE001
                print(f"[discovery] mark {name} port={port}: {exc}", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--write-layout", action="store_true")
    parser.add_argument("--layout-out", type=Path, default=DEFAULT_LAYOUT)
    parser.add_argument("--apply", action="store_true", help="Run rcon prep (fixture)")
    args = parser.parse_args()

    seed = _seed_from_env(args.seed)
    layout = generate_layout(seed)

    if args.write_layout or args.apply:
        args.layout_out.parent.mkdir(parents=True, exist_ok=True)
        args.layout_out.write_text(json.dumps(layout, indent=2))
        print(f"[discovery] wrote {args.layout_out} seed={seed}")

    if args.apply:
        for cmd in rcon_commands(layout):
            if cmd.startswith("mvtp") or cmd.startswith("clear") or cmd.startswith("give") or cmd.startswith("gamemode") or cmd.startswith("effect"):
                run_rcon(cmd)
            else:
                run_rcon(cmd)
        post_marks(layout)
        print("[discovery] apply complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
