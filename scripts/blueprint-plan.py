#!/usr/bin/env python3
"""Turn a GrabCraft URL into a build plan JSON for steward / kanban workers.

Uses docs/features/grabcraft_downloader.py to fetch the blueprint, then:
  - normalizes block names to Minecraft ids (snake_case)
  - applies optional material substitutions (easier-to-source blocks)
  - optionally drops decorative blocks

Usage:
  scripts/blueprint-plan.py <grabcraft_url> [--out plan.json]
  scripts/blueprint-plan.py <url> --no-substitute --no-simplify

Steward workflow: run this via terminal, attach plan to kanban_create body
(kind: construct) or kanban_comment on an [EPIC] card.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from collections import Counter
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOWNLOADER_PATH = ROOT / "docs" / "features" / "grabcraft_downloader.py"

# GrabCraft display name → default Minecraft block id (1.20-ish paper world)
NAME_TO_BLOCK: dict[str, str] = {
    "air": "air",
    "cobblestone": "cobblestone",
    "stone": "stone",
    "stone brick": "stone_bricks",
    "stone bricks": "stone_bricks",
    "mossy stone brick": "mossy_stone_bricks",
    "mossy stone bricks": "mossy_stone_bricks",
    "clay": "clay",
    "dirt": "dirt",
    "grass": "grass_block",
    "grass block": "grass_block",
    "oak wood plank": "oak_planks",
    "oak wood planks": "oak_planks",
    "oak planks": "oak_planks",
    "spruce wood plank": "spruce_planks",
    "birch wood plank": "birch_planks",
    "glass": "glass",
    "glass pane": "glass_pane",
    "torch": "torch",
    "chest": "chest",
    "oak door": "oak_door",
    "oak fence": "oak_fence",
    "oak fence gate": "oak_fence_gate",
    "oak stairs": "oak_stairs",
    "oak slab": "oak_slab",
    "cobblestone stairs": "cobblestone_stairs",
    "cobblestone slab": "cobblestone_slab",
    "bricks": "bricks",
    "sand": "sand",
    "gravel": "gravel",
    "wool": "white_wool",
    "white wool": "white_wool",
    "iron block": "iron_block",
    "water": "water",
    "lava": "lava",
}

# When --substitute: replace planned block id with something easier at base
EASY_SUBSTITUTIONS: dict[str, str] = {
    "clay": "dirt",
    "terracotta": "dirt",
    "stone_bricks": "cobblestone",
    "mossy_stone_bricks": "cobblestone",
    "bricks": "cobblestone",
    "spruce_planks": "oak_planks",
    "birch_planks": "oak_planks",
    "jungle_planks": "oak_planks",
    "dark_oak_planks": "oak_planks",
    "acacia_planks": "oak_planks",
    "stone": "cobblestone",
    "andesite": "cobblestone",
    "diorite": "cobblestone",
    "granite": "cobblestone",
    "deepslate": "cobbled_deepslate",
    "deepslate_bricks": "cobbled_deepslate",
}

DECORATIVE_SKIP = frozenset(
    {
        "flower_pot",
        "potted_oak_sapling",
        "carpet",
        "white_carpet",
        "painting",
        "item_frame",
        "lantern",
        "soul_lantern",
        "campfire",
        "bell",
        "flower",
        "dandelion",
        "poppy",
        "blue_orchid",
        "allium",
    }
)


def load_downloader():
    spec = importlib.util.spec_from_file_location("grabcraft_downloader", DOWNLOADER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {DOWNLOADER_PATH}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.GrabCraftDownloader


def normalize_grabcraft_name(raw: str) -> str:
    s = (raw or "").strip().lower()
    s = re.sub(r"\s+", " ", s)
    if s in NAME_TO_BLOCK:
        return NAME_TO_BLOCK[s]
    key = s.replace(" ", "_").replace("-", "_")
    key = re.sub(r"[^a-z0-9_]", "", key)
    return key or "unknown"


def build_plan(
    blueprint: dict,
    *,
    substitute: bool,
    simplify: bool,
    anchor: list[int] | None,
    site: str | None,
) -> dict:
    meta = blueprint.get("metadata") or {}
    blocks_3d = blueprint.get("blocks_3d") or {}
    materials_orig = blueprint.get("materials") or []

    planned_cells: list[dict] = []
    skipped = Counter()
    sub_log: Counter = Counter()

    for key, block in blocks_3d.items():
        raw_name = block.get("name") or ""
        block_id = normalize_grabcraft_name(raw_name)
        if block_id in ("air", "unknown", ""):
            continue
        if simplify and block_id in DECORATIVE_SKIP:
            skipped[block_id] += 1
            continue
        original_id = block_id
        if substitute and block_id in EASY_SUBSTITUTIONS:
            block_id = EASY_SUBSTITUTIONS[block_id]
            sub_log[f"{original_id}→{block_id}"] += 1
        parts = key.split(",")
        lx, ly, lz = int(parts[0]), int(parts[1]), int(parts[2])
        planned_cells.append(
            {
                "local": [lx, ly, lz],
                "block": block_id,
                "source_name": raw_name,
                "original_block": original_id if original_id != block_id else None,
            }
        )

    mat_counts = Counter(c["block"] for c in planned_cells)
    by_layer: dict[int, int] = Counter()
    for c in planned_cells:
        by_layer[c["local"][1]] += 1

    phases = []
    for level in sorted(by_layer.keys()):
        phases.append(
            {
                "layer_y": level,
                "block_count": by_layer[level],
                "hint": "place this Y layer before higher layers",
            }
        )

    plan = {
        "kind": "construct",
        "source": {
            "type": "grabcraft",
            "url": meta.get("url"),
            "name": meta.get("name"),
            "dimensions": {
                "width": meta.get("width"),
                "height": meta.get("height"),
                "depth": meta.get("depth"),
            },
        },
        "options": {"substitute_easy_materials": substitute, "simplify_decorative": simplify},
        "anchor": {"coords": anchor, "site": site},
        "materials_original": materials_orig,
        "materials_planned": [{"item": k, "count": v} for k, v in mat_counts.most_common()],
        "stats": {
            "cells_planned": len(planned_cells),
            "cells_skipped_decorative": sum(skipped.values()),
            "substitution_events": sum(sub_log.values()),
        },
        "substitutions_applied": dict(sub_log),
        "skipped_decorative": dict(skipped),
        "phases": phases,
        "cells": planned_cells,
        "worker_hints": [
            "Anchor in world coords: set anchor.coords or site (e.g. :base1:/tower) before mc construct.",
            "Use materials_planned for [SUPPLY] cards; cells[] is the placement diff input for future mc construct.",
            "Re-run with --no-substitute for faithful block types.",
        ],
    }
    return plan


def main() -> int:
    ap = argparse.ArgumentParser(description="GrabCraft URL → steward build plan JSON")
    ap.add_argument("url", help="GrabCraft blueprint page URL")
    ap.add_argument("--out", "-o", help="Write plan JSON here (default: stdout)")
    ap.add_argument("--save-blueprint", help="Also write raw GrabCraft JSON here")
    ap.add_argument("--no-substitute", action="store_true", help="Disable easy material swaps")
    ap.add_argument("--no-simplify", action="store_true", help="Keep decorative blocks")
    ap.add_argument("--anchor", help="World anchor x,y,z (metadata only until worker places)")
    ap.add_argument("--site", help="Region site ref e.g. :base1:/tower")
    ap.add_argument("--compact", action="store_true", help="Compact JSON")
    args = ap.parse_args()

    anchor = None
    if args.anchor:
        parts = [int(x.strip()) for x in args.anchor.split(",")]
        if len(parts) != 3:
            print("error: --anchor must be x,y,z", file=sys.stderr)
            return 2
        anchor = parts

    GrabCraftDownloader = load_downloader()
    dl = GrabCraftDownloader(args.url)
    with redirect_stdout(sys.stderr):
        blueprint = dl.download()

    if args.save_blueprint:
        Path(args.save_blueprint).write_text(
            json.dumps(blueprint, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    plan = build_plan(
        blueprint,
        substitute=not args.no_substitute,
        simplify=not args.no_simplify,
        anchor=anchor,
        site=args.site,
    )

    indent = None if args.compact else 2
    text = json.dumps(plan, indent=indent, ensure_ascii=False) + "\n"
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"Wrote plan: {args.out} ({plan['stats']['cells_planned']} cells)", file=sys.stderr)
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
