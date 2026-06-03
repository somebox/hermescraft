#!/usr/bin/env python3
"""RCON world prep for establishment explore runs (peaceful hub + starter chest)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _agent_test():
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "agent_test_mod", ROOT / "scripts" / "agent-test.py"
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(mod)
    return mod


def _triple(card: dict, key: str) -> tuple[int, int, int]:
    placements = card.get("placements") or {}
    raw = card.get(key) or placements.get(key)
    if not raw or len(raw) < 3:
        raise SystemExit(f"map JSON missing {key!r}")
    return int(raw[0]), int(raw[1]), int(raw[2])


def prep_commands(card: dict, *, world: str = "proc-lab") -> list[str]:
    sx, sy, sz = _triple(card, "spawn")
    cx, cy, cz = _triple(card, "starter_chest")
    items_nbt = (
        "{Items:["
        '{Slot:0b,id:"minecraft:iron_pickaxe",Count:1b},'
        '{Slot:1b,id:"minecraft:iron_axe",Count:1b},'
        '{Slot:2b,id:"minecraft:iron_shovel",Count:1b},'
        '{Slot:3b,id:"minecraft:bread",Count:4b}'
        "]}"
    )
    return [
        f"execute in {world} run difficulty peaceful",
        f"execute in {world} run gamerule doMobSpawning false",
        f"execute in {world} run gamerule doDaylightCycle false",
        f"execute in {world} run time set day",
        f"execute in {world} run kill @e[type=!player]",
        # Spawn-area cleanup (Phase 9 PR-H): clears residual pits in a
        # 25×25 surface around spawn and re-floors with grass. Run-5 evidence:
        # Mason hit run-4's residual pit at (4,84,29) — each replay degrades
        # the next world unless we reset the spawn neighborhood. The chest
        # setblock below runs AFTER this fill, so the chest overrides the
        # grass cell at (cx,cy,cz). Does NOT repair scars deeper than 1 block
        # below spawn Y; that's deferred (see plan PR-H known limitations).
        f"execute in {world} run fill {sx-12} {sy} {sz-12} {sx+12} {sy+3} {sz+12} air replace",
        f"execute in {world} run fill {sx-12} {sy-1} {sz-12} {sx+12} {sy-1} {sz+12} grass_block",
        f"execute in {world} run setblock {cx} {cy} {cz} minecraft:chest",
        f"execute in {world} run data merge block {cx} {cy} {cz} {items_nbt}",
        f"execute in {world} run setworldspawn {sx} {sy} {sz}",
    ]


def tp_worker_commands(card: dict, workers: list[str], *, world: str = "proc-lab") -> list[str]:
    """Move each worker into the proc-lab disc and seed starter inventory.

    Order matters: clear → tp → give. Each worker lands at muster with the
    same starter kit (iron pickaxe/axe/shovel + 16 bread + 8 logs + crafting
    table) so their landfolk role priors (maintain_food, maintain_wood) drop
    immediately and they execute the card body instead of role-shopping.

    Fan offsets stay in the SW quadrant from spawn (away from the upslope
    that buried previous fans). Player names capitalized for MC lookup.
    """
    mx, my, mz = _triple(card, "muster")
    # SW-quadrant fan: spawn, S, W, SW — relief at the spawn neighborhood
    # rises N+/E+, drops S-/W-, so stay in the downhill half.
    offsets = [(0, 0), (0, 1), (-1, 0), (-1, 1), (0, 2), (-2, 0)]
    starter_kit = [
        ("minecraft:iron_pickaxe", 1),
        ("minecraft:iron_axe", 1),
        ("minecraft:iron_shovel", 1),
        ("minecraft:bread", 16),
        ("minecraft:oak_log", 8),
        ("minecraft:crafting_table", 1),
    ]
    out: list[str] = []
    # One-shot clear so the give below produces a deterministic inventory.
    out.append(f"execute in {world} run clear @a")
    for i, raw in enumerate(workers):
        name = raw.strip().capitalize()
        if not name:
            continue
        dx, dz = offsets[i % len(offsets)]
        out.append(f"mvtp {name} {world}")
        out.append(f"execute in {world} run tp {name} {mx + dx} {my} {mz + dz}")
        for item, count in starter_kit:
            out.append(f"execute in {world} run give {name} {item} {count}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--map", type=Path, required=True)
    ap.add_argument("--world", default="proc-lab")
    ap.add_argument("--mode", choices=["world", "tp_workers"], default="world",
                    help="world: peaceful + chest + worldspawn. tp_workers: mvtp + tp to muster.")
    ap.add_argument("--workers", default="",
                    help="comma list of player names (required when --mode tp_workers)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    card = json.loads(args.map.read_text(encoding="utf-8"))
    if args.mode == "world":
        cmds = prep_commands(card, world=args.world)
        label = "rcon prep"
    else:
        names = [w.strip() for w in args.workers.split(",") if w.strip()]
        if not names:
            raise SystemExit("--mode tp_workers requires --workers comma-list")
        cmds = tp_worker_commands(card, names, world=args.world)
        label = f"rcon tp_workers ({','.join(names)})"
    if args.dry_run:
        for c in cmds:
            print(c)
        return 0
    _agent_test().run_rcon_batch(cmds)
    print(f"{label} ok ({len(cmds)} commands)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
