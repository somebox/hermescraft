#!/usr/bin/env python3
"""Seed [ESTABLISH:BASE] epic and optional [EXPLORE] worker cards from a map JSON."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import genesis_lib as gl  # noqa: E402

TEMPLATES = ROOT / "data" / "establish" / "templates"
KANBAN = ROOT / "scripts" / "kanban"


def _triple(card: dict, key: str) -> tuple[int, int, int]:
    placements = card.get("placements") or {}
    raw = card.get(key) or placements.get(key)
    if not raw or len(raw) < 3:
        raise SystemExit(f"map JSON missing placement {key!r}")
    return int(raw[0]), int(raw[1]), int(raw[2])


def context_from_map(card: dict) -> dict[str, str]:
    sx, sy, sz = _triple(card, "spawn")
    mx, my, mz = _triple(card, "muster")
    cx, cy, cz = _triple(card, "starter_chest")
    return {
        "spawn_x": str(sx),
        "spawn_y": str(sy),
        "spawn_z": str(sz),
        "muster_x": str(mx),
        "muster_y": str(my),
        "muster_z": str(mz),
        "chest_x": str(cx),
        "chest_y": str(cy),
        "chest_z": str(cz),
    }


def _run_kanban(args: list[str]) -> dict:
    proc = subprocess.run(
        [str(KANBAN), *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode != 0:
        raise SystemExit(
            f"kanban {' '.join(args[:3])} failed: {proc.stderr.strip() or proc.stdout.strip()}"
        )
    if "--json" in args:
        return json.loads(proc.stdout)
    return {}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--map", type=Path, required=True, help="Catalog map JSON")
    ap.add_argument(
        "--explore-cards",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Pre-file four [EXPLORE] cards under the epic (default: on)",
    )
    args = ap.parse_args()

    card = json.loads(args.map.read_text(encoding="utf-8"))
    ctx = context_from_map(card)

    epic_tpl = gl.parse_yaml_simple(TEMPLATES / "establish-epic.yaml")
    title = epic_tpl["title"]
    body = gl.substitute(epic_tpl.get("body", ""), ctx)

    epic = _run_kanban(["add-epic", title, "--body", body, "--json"])
    epic_id = str(epic.get("id") or "")
    if not epic_id:
        raise SystemExit(f"could not parse epic id from {epic}")

    # 2026-06-02 (Phase 6): mark the epic as non-dispatchable by reassigning
    # to a placeholder identifier. The gateway-embedded dispatcher's claim
    # selector treats unresolvable assignees as "terminal lanes" and skips
    # them (kanban-worker-lanes.md "registered non-spawnable identifier").
    # Steward's continuous loop still finds the epic by tag — she doesn't
    # need to be its assignee to comment, create children, or mark it done.
    _run_kanban(["reassign", epic_id, "orchestrator-tracker"])

    explore_ids: list[str] = []
    if args.explore_cards:
        cards_doc = gl.parse_yaml_simple(TEMPLATES / "establish-explore-cards.yaml")
        for entry in cards_doc.get("cards") or []:
            ctitle = entry["title"]
            cbody = gl.substitute(entry.get("body", ""), ctx)
            # CLI requires --assignee; when template doesn't pin one use
            # orchestrator-tracker so the gateway dispatcher skips these cards
            # (non-spawnable lane). Steward's continuous loop assigns real workers.
            assignee = entry.get("assignee") or "orchestrator-tracker"
            cmd = [
                "add",
                ctitle,
                "--assignee",
                assignee,
                "--for",
                epic_id,
                "--body",
                cbody,
                "--json",
            ]
            for skill in entry.get("skills") or []:
                cmd.extend(["--skill", skill])
            created = _run_kanban(cmd)
            cid = str(created.get("id") or "")
            if not cid:
                raise SystemExit(f"could not parse card id for {ctitle!r}")
            explore_ids.append(cid)

    out = {"epic_id": epic_id, "explore_card_ids": explore_ids, "seed": card.get("seed")}
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
