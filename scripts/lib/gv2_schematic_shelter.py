"""Genesis-v2 starter_shelter schematic bootstrap: plan anchor patch, site prep, kanban sequence."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any, Callable

from scripts.lib.plan_supply import (
    construct_card_title,
    phase_card_bundle,
    phase_record,
)

STARTER_SHELTER_PLAN_ID = "starter_shelter"
SHELTER_WORKSITE = ":shelter:"
DEFAULT_DESTINATION = "chest_stone"
PHASE_SEQUENCE = ("L0_ground", "L1_slab", "L3_walls", "L4_roof")
FOOTPRINT_HALF = 3  # 7×7 tight footprint centered on base_anchor


def footprint_min_from_base_anchor(base: dict[str, int]) -> tuple[int, int, int]:
    """Plan anchor.coords = footprint minimum; base_anchor is colony center (feet)."""
    ax, ay, az = int(base["x"]), int(base["y"]), int(base["z"])
    return ax - FOOTPRINT_HALF, ay - 1, az - FOOTPRINT_HALF


def patch_starter_shelter_plan(
    repo_root: Path,
    data_dir: Path,
    base_anchor: dict[str, int],
    *,
    run_rendered_dir: Path | None = None,
) -> dict[str, Any]:
    """Write ``starter_shelter-plan.json`` with anchor at the run's footprint minimum."""
    source = repo_root / "data" / "ops" / "plans" / f"{STARTER_SHELTER_PLAN_ID}-plan.json"
    tpl = repo_root / "data" / "genesis-v2" / "templates" / "starter_shelter-plan.template.json"
    if not tpl.is_file():
        tpl = repo_root / "data" / "genesis" / "templates" / "starter_shelter-plan.template.json"
    meta = json.loads(tpl.read_text()) if tpl.is_file() else {}
    plan = json.loads(source.read_text())
    ox, oy, oz = footprint_min_from_base_anchor(base_anchor)
    off = meta.get("marker_offset") or {"dx": 3, "dy": 0, "dz": -1}
    if plan.get("anchor"):
        plan["anchor"]["coords"] = [ox, oy, oz]
        if plan["anchor"].get("marker"):
            plan["anchor"]["marker"]["coords"] = [
                ox + int(off["dx"]),
                oy + int(off["dy"]),
                oz + int(off["dz"]),
            ]
    out_path = data_dir / "ops" / "plans" / f"{STARTER_SHELTER_PLAN_ID}-plan.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(plan, indent=2) + "\n"
    out_path.write_text(text)
    if run_rendered_dir:
        run_rendered_dir.mkdir(parents=True, exist_ok=True)
        (run_rendered_dir / f"{STARTER_SHELTER_PLAN_ID}-plan.json").write_text(text)
    return plan


def verify_card_title(plan_id: str, phase_key: str) -> str:
    return f"[VERIFY] [GENESIS2:P1] {plan_id} {phase_key.replace('_', ' ')} phase clean"


def verify_card_body(
    *,
    plan_id: str,
    phase_key: str,
    anchor_mark: str,
    checkout_near: str,
    verify_cli: str,
    depends_on: str | None = None,
) -> str:
    dep = f"depends_on: {depends_on}\n" if depends_on else ""
    return (
        f"anchor: {anchor_mark}\n"
        f"source_truth: plan file {plan_id}\n"
        f"plan: {plan_id}\n"
        f"phase: {phase_key}\n"
        f"{dep}"
        f"done_when: blueprint verify summary missing=0 wrong=0 for this phase slice\n"
        f"mc bot checkout --near {checkout_near} --cap builder --mark {anchor_mark}\n"
        f"preflight:\n"
        f"  mc scene\n"
        f"verify_cmd:\n"
        f"  {verify_cli}\n"
        f"mc bot release\n"
    )


def _construct_body_for_phase(
    plan: dict[str, Any],
    phase_key: str,
    *,
    worksite: str,
    anchor_mark: str,
    checkout_near: str,
    card_id: str,
    final_phase: bool,
) -> str:
    ph = phase_record(plan, phase_key) or {}
    level = ph.get("level")
    phase_range = ph.get("range")
    revision = plan.get("revision") if isinstance(plan.get("revision"), str) else None
    verify_parts: list[str] = []
    if phase_range:
        verify_parts.append(f"mc blueprint verify {STARTER_SHELTER_PLAN_ID} --range {phase_range}")
    elif level is not None:
        verify_parts.append(f"mc blueprint verify {STARTER_SHELTER_PLAN_ID} --level {int(level)}")
    else:
        verify_parts.append(f"mc blueprint verify {STARTER_SHELTER_PLAN_ID} --range 0..0")
    verify_line = verify_parts[0]
    end_line = "mc construct end" if final_phase else "mc construct end --skip-gates"
    from scripts.lib.plan_supply import footprint_label

    level_line = f"level: {int(level)}\n" if level is not None else ""
    range_line = f"range: {phase_range}\n" if phase_range else ""
    rev_line = f"plan_revision: {revision}\n" if revision else ""
    return (
        f"anchor: {anchor_mark}\n"
        f"source_truth: region sign plan={STARTER_SHELTER_PLAN_ID}\n"
        f"worksite: {worksite}\n"
        f"plan: {STARTER_SHELTER_PLAN_ID}\n"
        f"phase: {phase_key}\n"
        f"{level_line}"
        f"{range_line}"
        f"{rev_line}"
        f"done_when: phase {phase_key} clean ({verify_line} then construct end)\n"
        f"mc bot checkout --near {checkout_near} --cap builder --mark {anchor_mark}\n"
        f"mc task_context set {worksite} --card {card_id} --plan {STARTER_SHELTER_PLAN_ID} "
        f"--phase {phase_key}"
        + (f" --level {int(level)}" if level is not None else "")
        + (f" --range {phase_range}" if phase_range else "")
        + " --card-kind CONSTRUCT\n"
        f"mc scene\n"
        f"mc observe\n"
        f"footprint: {footprint_label(plan, at_mark=anchor_mark)}\n"
        f"protected_cells: none after survey — use construct workset\n"
        f"mc construct show\n"
        f"mc fill cobblestone (workset slices only; match plan expected_block)\n"
        f"{verify_line}\n"
        f"{end_line}\n"
        f"mc bot release\n"
    )


def shelter_chests_card_body(base_anchor: dict[str, int]) -> str:
    ax, ay, az = int(base_anchor["x"]), int(base_anchor["y"]), int(base_anchor["z"])
    wx, wy, wz = ax - 1, ay, az
    fx, fy, fz = ax - 1, ay, az + 1
    return (
        "anchor: base_anchor\n"
        "source_truth: marks\n"
        "footprint: 7x7 at base_anchor\n"
        "protected_cells: none\n"
        f"mc bot checkout --near {ax},{ay},{az} --cap builder --mark base_anchor\n"
        f"mc place chest {wx} {wy} {wz}\n"
        f"mc place chest {fx} {fy} {fz}\n"
        f"mc mark chest_wood --at {wx} {wy} {wz}\n"
        f"mc mark chest_food --at {fx} {fy} {fz}\n"
        "done_when: chest_wood and chest_food marks resolve on shared map\n"
        "mc bot release\n"
    )


def file_starter_shelter_sequence(
    kanban_run: Callable[..., dict[str, Any]],
    *,
    plan: dict[str, Any],
    epic_for: str | None,
    anchor_mark: str = "base_anchor",
    checkout_near: str | None = None,
    worksite: str = SHELTER_WORKSITE,
    destination: str = DEFAULT_DESTINATION,
    assignee_supply: str = "colony-gatherer",
    assignee_construct: str = "colony-builder",
    assignee_verify: str = "colony-builder",
    after_card_id: str | None = None,
    base_anchor: dict[str, int] | None = None,
) -> dict[str, Any]:
    """File SUPPLY → CONSTRUCT → VERIFY chain for each plan phase (+ chest marks card)."""
    near = checkout_near or anchor_mark
    plan_id = str(plan.get("plan_id") or STARTER_SHELTER_PLAN_ID)
    created: dict[str, Any] = {"phases": [], "chest_card": None}
    prev_id = after_card_id
    base_for_chest = base_anchor or {"x": 0, "y": 65, "z": 0}

    for i, phase_key in enumerate(PHASE_SEQUENCE):
        final = phase_key == PHASE_SEQUENCE[-1]
        bundle = phase_card_bundle(
            plan,
            phase_key,
            worksite=worksite,
            destination=destination,
            anchor_mark=anchor_mark,
            checkout_near=near,
            supply_assignee=assignee_supply,
            construct_assignee=assignee_construct,
        )
        phase_out: dict[str, Any] = {"phase_key": phase_key, "supply_ids": [], "construct_id": None, "verify_id": None}

        for sc in bundle["supply"]:
            args = ["add", sc["title"], "--assignee", sc["assignee"], "--body", sc["body"], "--json"]
            if epic_for:
                args.extend(["--for", epic_for])
            if prev_id:
                args.extend(["--after", prev_id])
            res = kanban_run(args)
            sid = str(res.get("id") or "")
            if not sid:
                raise RuntimeError(f"kanban add supply failed: {res}")
            phase_out["supply_ids"].append(sid)
            prev_id = sid

        ctitle = construct_card_title(plan_id, phase_key)
        ctitle = f"[GENESIS2:P1] {ctitle}"
        args = ["add", ctitle, "--assignee", assignee_construct, "--body", "pending", "--json"]
        if epic_for:
            args.extend(["--for", epic_for])
        if prev_id:
            args.extend(["--after", prev_id])
        res = kanban_run(args)
        cid = str(res.get("id") or "")
        if not cid:
            raise RuntimeError(f"kanban add construct failed: {res}")
        body = _construct_body_for_phase(
            plan,
            phase_key,
            worksite=worksite,
            anchor_mark=anchor_mark,
            checkout_near=near,
            card_id=cid,
            final_phase=final,
        )
        kanban_run(["edit", cid, "--body", body])
        phase_out["construct_id"] = cid
        prev_id = cid

        ph = phase_record(plan, phase_key) or {}
        level = ph.get("level")
        phase_range = ph.get("range")
        if phase_range:
            verify_cli = f"mc blueprint verify {plan_id} --range {phase_range}"
        elif level is not None:
            verify_cli = f"mc blueprint verify {plan_id} --level {int(level)}"
        else:
            verify_cli = f"mc blueprint verify {plan_id} --range 0..0"

        vtitle = verify_card_title(plan_id, phase_key)
        vtitle = f"[GENESIS2:P1] {vtitle}"
        vbody = verify_card_body(
            plan_id=plan_id,
            phase_key=phase_key,
            anchor_mark=anchor_mark,
            checkout_near=near,
            verify_cli=verify_cli,
            depends_on=cid,
        )
        args = ["add", vtitle, "--assignee", assignee_verify, "--body", vbody, "--json"]
        if epic_for:
            args.extend(["--for", epic_for])
        args.extend(["--after", cid])
        res = kanban_run(args)
        vid = str(res.get("id") or "")
        if not vid:
            raise RuntimeError(f"kanban add verify failed: {res}")
        phase_out["verify_id"] = vid
        prev_id = vid
        created["phases"].append(phase_out)

    chest_title = "[GENESIS2:P1] [CONSTRUCT] shelter storage chests + marks"
    chest_body = shelter_chests_card_body(base_for_chest)
    args = [
        "add",
        chest_title,
        "--assignee",
        assignee_construct,
        "--body",
        chest_body,
        "--json",
    ]
    if epic_for:
        args.extend(["--for", epic_for])
    if prev_id:
        args.extend(["--after", prev_id])
    res = kanban_run(args)
    chest_id = str(res.get("id") or "")
    created["chest_card"] = chest_id
    created["tail_id"] = chest_id
    return created


def run_place_schematic_rcon(
    repo_root: Path,
    *,
    plan_id: str,
    anchor: list[int],
    world: str,
    server_config: Path | None = None,
    dry_run: bool = False,
) -> None:
    """Optional full reference paste (ops/review); default gv2 path is construct cards."""
    cmd = [
        "python3",
        str(repo_root / "scripts" / "place-schematic-rcon.py"),
        plan_id,
        "--at",
        f"{anchor[0]},{anchor[1]},{anchor[2]}",
        "--world",
        world,
    ]
    if server_config:
        cmd.extend(["--server-config", str(server_config)])
    if dry_run:
        cmd.append("--dry-run")
    subprocess.run(cmd, cwd=repo_root, check=True, timeout=120)
