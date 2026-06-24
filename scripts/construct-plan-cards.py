#!/usr/bin/env python3
"""File schematic CONSTRUCT + plan-derived SUPPLY cards for one plan phase (E4).

Deterministic alternative to hand-copying manifest lines from
``data/ops/plans/*-plan.json``. Example:

  HERMES_KANBAN_BOARD=genesis-v2 ./scripts/construct-plan-cards.py \\
    --plan starter_shelter --phase L1_slab \\
    --worksite :shelter: --destination chest_stone \\
    --anchor-mark shelter_pad --for <epic_id> --file --json
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.lib.plan_supply import (  # noqa: E402
    construct_card_body,
    footprint_label,
    load_plan,
    phase_card_bundle,
    phase_record,
    resolve_phase_key,
)
from scripts.lib.gv2_schematic_shelter import (  # noqa: E402
    PHASE_SEQUENCE,
    STARTER_SHELTER_PLAN_ID,
    _construct_body_for_phase,
    _with_epic_trailer,
)

KANBAN = ROOT / "scripts" / "kanban"


def _run_kanban(args: list[str]) -> dict[str, Any]:
    proc = subprocess.run(
        [str(KANBAN), *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=90,
    )
    if proc.returncode != 0:
        raise SystemExit(
            f"kanban {' '.join(args[:4])} failed: {proc.stderr.strip() or proc.stdout.strip()}"
        )
    if "--json" in args:
        return json.loads(proc.stdout)
    return {}


def file_bundle(
    plan: dict[str, Any],
    bundle: dict[str, Any],
    *,
    worksite: str,
    anchor_mark: str,
    checkout_near: str,
    epic_for: str | None,
) -> dict[str, Any]:
    supply_ids: list[str] = []
    plan_id = str(plan.get("plan_id") or "")

    for card in bundle["supply"]:
        body = _with_epic_trailer(card["body"], epic_for)
        args = [
            "add",
            card["title"],
            "--assignee",
            card["assignee"],
            "--body",
            body,
            "--json",
        ]
        if epic_for:
            args.extend(["--for", epic_for])
        created = _run_kanban(args)
        sid = str(created.get("id") or "")
        if not sid:
            raise SystemExit(f"could not parse supply card id from {created}")
        supply_ids.append(sid)

    construct = bundle["construct"]
    phase_key = bundle["phase_key"]
    if plan_id == STARTER_SHELTER_PLAN_ID:
        final_phase = phase_key == PHASE_SEQUENCE[-1]
        construct_body = _construct_body_for_phase(
            plan,
            phase_key,
            worksite=worksite,
            anchor_mark=anchor_mark,
            checkout_near=checkout_near,
            final_phase=final_phase,
        )
    else:
        ph = phase_record(plan, phase_key) or {}
        level = ph.get("level")
        phase_range = ph.get("range")
        revision = plan.get("revision") if isinstance(plan.get("revision"), str) else None
        construct_body = construct_card_body(
            plan_id=plan_id,
            phase_key=phase_key,
            worksite=worksite,
            anchor_mark=anchor_mark,
            checkout_near=checkout_near,
            card_id="",
            plan_revision=revision,
            level=int(level) if level is not None else None,
            phase_range=str(phase_range) if phase_range else None,
            footprint=footprint_label(plan, at_mark=anchor_mark),
        )

    args = [
        "add",
        construct["title"],
        "--assignee",
        construct["assignee"],
        "--body",
        _with_epic_trailer(construct_body, epic_for),
        "--json",
    ]
    if epic_for:
        args.extend(["--for", epic_for])
    for sid in supply_ids:
        args.extend(["--after", sid])
    created = _run_kanban(args)
    cid = str(created.get("id") or "")
    if not cid:
        raise SystemExit(f"could not parse construct card id from {created}")

    if plan_id != STARTER_SHELTER_PLAN_ID:
        ph = phase_record(plan, phase_key) or {}
        level = ph.get("level")
        phase_range = ph.get("range")
        revision = plan.get("revision") if isinstance(plan.get("revision"), str) else None
        patched = construct_card_body(
            plan_id=plan_id,
            phase_key=phase_key,
            worksite=worksite,
            anchor_mark=anchor_mark,
            checkout_near=checkout_near,
            card_id=cid,
            plan_revision=revision,
            level=int(level) if level is not None else None,
            phase_range=str(phase_range) if phase_range else None,
            footprint=footprint_label(plan, at_mark=anchor_mark),
        )
        _run_kanban(["edit", cid, "--body", patched])

    return {"supply_ids": supply_ids, "construct_id": cid}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--plan", required=True, help="plan_id (starter_shelter)")
    phase = ap.add_mutually_exclusive_group(required=True)
    phase.add_argument("--phase", help="Phase id (L1_slab)")
    phase.add_argument("--level", type=int, help="Plan level number (1 → L1_slab)")
    ap.add_argument("--worksite", required=True, help="Protect region / task_context worksite")
    ap.add_argument("--destination", required=True, help="SUPPLY destination mark (chest_stone)")
    ap.add_argument("--anchor-mark", default="shelter_pad")
    ap.add_argument("--checkout-near", default=None, help="Defaults to --anchor-mark")
    ap.add_argument("--assignee-supply", default="colony-gatherer")
    ap.add_argument("--assignee-construct", default="colony-builder")
    ap.add_argument("--for", dest="epic_for", default=None, metavar="EPIC_ID")
    ap.add_argument("--dry-run", action="store_true", help="Print card bundle JSON only")
    ap.add_argument("--file", action="store_true", help="Write cards via scripts/kanban")
    ap.add_argument("--json", action="store_true", help="JSON on stdout (default when --dry-run)")
    args = ap.parse_args()

    if not args.dry_run and not args.file:
        ap.error("pass --dry-run and/or --file")

    plan = load_plan(ROOT, args.plan)
    phase_key = resolve_phase_key(plan, phase=args.phase, level=args.level)
    near = args.checkout_near or args.anchor_mark
    bundle = phase_card_bundle(
        plan,
        phase_key,
        worksite=args.worksite,
        destination=args.destination,
        anchor_mark=args.anchor_mark,
        checkout_near=near,
        supply_assignee=args.assignee_supply,
        construct_assignee=args.assignee_construct,
    )

    if args.dry_run:
        payload = {
            "phase_key": phase_key,
            "supply": bundle["supply"],
            "construct": bundle["construct"],
            "file_order": "SUPPLY(s) then CONSTRUCT with --after each SUPPLY id",
        }
        print(json.dumps(payload, indent=2))
        if not args.file:
            return 0

    if args.file:
        result = file_bundle(
            plan,
            bundle,
            worksite=args.worksite,
            anchor_mark=args.anchor_mark,
            checkout_near=near,
            epic_for=args.epic_for,
        )
        if args.json or not args.dry_run:
            print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
