#!/usr/bin/env python3
"""Move proc-nav execute bots into the proc-nav dimension (post-evac / pre-dispatch).

Reads usernames from data/bots/<name>.yaml, world from server.local.yaml,
optional spawn TP from data/runtime/last-scenario-map.json (muster).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from mapcatalog.rcon_protocol import RconClient  # noqa: E402
from mapcatalog.rcon_client import make_rcon  # noqa: E402
from mapcatalog.server_config import load_server_config  # noqa: E402


def _username(bot_stem: str) -> str:
    import yaml

    path = ROOT / "data" / "bots" / f"{bot_stem}.yaml"
    if not path.is_file():
        raise SystemExit(f"missing bot registry: {path}")
    data = yaml.safe_load(path.read_text()) or {}
    return str(data["username"])


def _muster_xyz(map_path: Path) -> tuple[int, int, int] | None:
    if not map_path.is_file():
        return None
    card = json.loads(map_path.read_text())
    placements = card.get("placements") or {}
    for key in ("muster", "spawn"):
        raw = placements.get(key)
        if isinstance(raw, (list, tuple)) and len(raw) >= 3:
            return int(raw[0]), int(raw[1]), int(raw[2])
    return None


def build_commands(
    *,
    world: str,
    players: list[str],
    tp_xyz: tuple[int, int, int] | None,
) -> list[str]:
    cmds: list[str] = []
    for player in players:
        cmds.append(f"mvtp {player} {world}")
        if tp_xyz:
            x, y, z = tp_xyz
            cmds.append(f"execute in {world} run tp {player} {x} {y} {z}")
    return cmds


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--bots",
        default="mox,pip",
        help="Comma-separated bot registry stems (default mox,pip)",
    )
    ap.add_argument("--server", type=Path, default=ROOT / "server.local.yaml")
    ap.add_argument(
        "--map-json",
        type=Path,
        default=ROOT / "data/runtime/last-scenario-map.json",
    )
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-tp", action="store_true", help="mvtp only, skip tp to muster")
    args = ap.parse_args()

    if not args.server.is_file():
        print(f"[mvtp-bots] missing {args.server}", file=sys.stderr)
        return 1

    cfg = load_server_config(args.server)
    world = cfg.world_name
    if not world.startswith("proc-"):
        print(f"[mvtp-bots] refuse: world.name={world!r} (expected proc-*)", file=sys.stderr)
        return 1

    stems = [s.strip() for s in args.bots.split(",") if s.strip()]
    players = [_username(s) for s in stems]
    tp_xyz = None if args.no_tp else _muster_xyz(args.map_json)
    cmds = build_commands(world=world, players=players, tp_xyz=tp_xyz)

    if args.dry_run:
        for c in cmds:
            print(c)
        return 0

    client: RconClient = make_rcon(cfg)
    try:
        for c in cmds:
            out = client.run(c)
            if out and out.strip():
                print(f"[mvtp-bots] {c} → {out.strip()[:120]}")
            else:
                print(f"[mvtp-bots] OK {c}")
    finally:
        close = getattr(client, "close", None)
        if callable(close):
            close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
