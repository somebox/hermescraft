#!/usr/bin/env python3
"""Stamp a fixture id to manifest + ephemeral datapack directory."""

from __future__ import annotations

import argparse
import copy
import json
import shutil
import sys
from pathlib import Path

ARENA_ROOT = Path(__file__).resolve().parent


def _load_yaml(path: Path) -> dict:
    import yaml

    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def resolve_fixture(fixture_id: str) -> dict:
    reg = _load_yaml(ARENA_ROOT / "fixtures" / "registry.yaml")
    fixtures = reg.get("fixtures") or {}
    if fixture_id in fixtures:
        return copy.deepcopy(fixtures[fixture_id])
    aliases = reg.get("aliases") or {}
    if fixture_id in aliases:
        return resolve_fixture(aliases[fixture_id])
    raise KeyError(f"unknown fixture_id {fixture_id!r}")


def stamp_fixture(
    fixture_id: str,
    out_dir: Path,
    *,
    params: dict | None = None,
    profile: str = "vanilla_baseline",
) -> dict:
    spec = resolve_fixture(fixture_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    src_pack = ARENA_ROOT / "datapacks" / profile
    if not src_pack.is_dir():
        src_pack = ARENA_ROOT / "datapacks" / "vanilla_baseline"
    pack_dst = out_dir / "datapack"
    if pack_dst.exists():
        shutil.rmtree(pack_dst)
    shutil.copytree(src_pack, pack_dst)
    manifest = {
        "fixture_id": fixture_id,
        "spec": spec,
        "profile": profile,
        "params": params or {},
        "mc_version": "1.21.4",
        "seed_mode": "variety",
    }
    with open(out_dir / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    return manifest


def main() -> int:
    p = argparse.ArgumentParser(description="Stamp fixture datapack + manifest")
    p.add_argument("--id", required=True, help="fixture id from fixtures/registry.yaml")
    p.add_argument("--out", type=Path, default=ARENA_ROOT / ".stamp-out" / "latest")
    p.add_argument("--profile", default="vanilla_baseline")
    p.add_argument("--param", action="append", default=[], help="key=value override")
    args = p.parse_args()
    overrides = {}
    for kv in args.param:
        k, _, v = kv.partition("=")
        overrides[k] = v
    stamp_fixture(args.id, args.out, params=overrides, profile=args.profile)
    print(args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
