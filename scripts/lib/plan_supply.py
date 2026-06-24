"""SUPPLY + schematic CONSTRUCT card helpers from plan `materials_by_phase` (E4)."""

from __future__ import annotations

from typing import Any

CARD_ID_PLACEHOLDER = "__CARD_ID__"


def load_plan(repo_root: Any, plan_id: str) -> dict[str, Any]:
    """Load ``data/ops/plans/{plan_id}-plan.json``."""
    path = repo_root / "data" / "ops" / "plans" / f"{plan_id}-plan.json"
    if not path.is_file():
        raise FileNotFoundError(path)
    import json

    return json.loads(path.read_text(encoding="utf-8"))


def phase_record(plan: dict[str, Any], phase_key: str) -> dict[str, Any] | None:
    for ph in plan.get("phases") or []:
        if str(ph.get("id") or "") == phase_key:
            return ph
    return None


def resolve_phase_key(
    plan: dict[str, Any],
    *,
    phase: str | None = None,
    level: int | None = None,
) -> str:
    """Resolve a phase id from explicit ``phase`` or ``level`` (1 → L1_slab, etc.)."""
    if phase:
        key = str(phase).strip()
        if materials_for_phase(plan, key) or phase_record(plan, key):
            return key
        raise ValueError(f"unknown phase {phase!r} for plan {plan.get('plan_id')}")
    if level is not None:
        for ph in plan.get("phases") or []:
            if ph.get("level") == level:
                return str(ph["id"])
        # Fallback: first phase whose id contains L{level}
        needle = f"L{level}_"
        for ph in plan.get("phases") or []:
            pid = str(ph.get("id") or "")
            if needle in pid or pid.endswith(f"_{level}"):
                return pid
        raise ValueError(f"no phase for level {level} in plan {plan.get('plan_id')}")
    raise ValueError("pass phase= or level=")


def footprint_label(plan: dict[str, Any], *, at_mark: str) -> str:
    fp = plan.get("footprint") or {}
    local = fp.get("local") or {}
    try:
        w = int(local["x"][1]) - int(local["x"][0]) + 1
        d = int(local["z"][1]) - int(local["z"][0]) + 1
    except (KeyError, IndexError, TypeError, ValueError):
        w, d = 7, 7
    return f"{w}x{d} at {at_mark}"


def materials_for_phase(plan: dict[str, Any], phase_key: str) -> list[dict[str, Any]]:
    """Return manifest entries for a phase id (e.g. L1_slab) or level string."""
    by_phase = plan.get("materials_by_phase") or {}
    if phase_key in by_phase:
        return list(by_phase[phase_key] or [])
    level_key = str(phase_key)
    for key, entries in by_phase.items():
        if key == level_key or key.endswith(f"_{level_key}"):
            return list(entries or [])
    return []


def supply_card_title(
    item: str,
    count: int,
    *,
    plan_id: str,
    phase_key: str,
) -> str:
    return f"[SUPPLY] {item} x{count} for {plan_id} ({phase_key})"


def supply_card_body(
    *,
    plan_id: str,
    phase_key: str,
    item: str,
    count: int,
    destination: str,
    source: str = "lt_* marks + base chests",
    anchor: str = "base_anchor",
    checkout_near: str = "base_anchor",
    checkout_cap: str = "gatherer",
    source_mark: str = "base_anchor",
) -> str:
    """gv2-valid SUPPLY body tied to a construct phase manifest (includes mc verbs)."""
    return (
        f"plan: {plan_id}\n"
        f"phase: {phase_key}\n"
        f"anchor: {anchor}\n"
        f"source_truth: marks\n"
        f"mc bot checkout --near {checkout_near} --cap {checkout_cap} --mark {source_mark}\n"
        f"source: {source}\n"
        f"destination: {destination}\n"
        f"quantity: {count} {item}\n"
        f"withdrawable: yes\n"
        f"mc collect {item}\n"
        f"mc deposit {item}\n"
        f"done_when: {item} count in {destination} >= {count}\n"
        f"mc bot release\n"
    )


def supply_cards_for_phase(
    plan: dict[str, Any],
    phase_key: str,
    *,
    destination: str,
    anchor: str = "base_anchor",
    checkout_near: str | None = None,
    checkout_cap: str = "gatherer",
    source_mark: str | None = None,
) -> list[dict[str, str]]:
    """One card dict per manifest line: {kind, title, body}."""
    plan_id = str(plan.get("plan_id") or "unknown")
    near = checkout_near or anchor
    smark = source_mark or anchor
    out: list[dict[str, str]] = []
    for entry in materials_for_phase(plan, phase_key):
        item = str(entry.get("name") or entry.get("item") or "").strip()
        if not item:
            continue
        try:
            count = int(entry.get("count") or 0)
        except (TypeError, ValueError):
            count = 0
        if count <= 0:
            continue
        out.append({
            "kind": "SUPPLY",
            "title": supply_card_title(item, count, plan_id=plan_id, phase_key=phase_key),
            "body": supply_card_body(
                plan_id=plan_id,
                phase_key=phase_key,
                item=item,
                count=count,
                destination=destination,
                anchor=anchor,
                checkout_near=near,
                checkout_cap=checkout_cap,
                source_mark=smark,
            ),
        })
    return out


def construct_card_title(plan_id: str, phase_key: str) -> str:
    return f"[CONSTRUCT] {plan_id} {phase_key.replace('_', ' ')}"


def construct_card_body(
    *,
    plan_id: str,
    phase_key: str,
    worksite: str,
    anchor_mark: str,
    checkout_near: str,
    card_id: str = CARD_ID_PLACEHOLDER,
    plan_revision: str | None = None,
    level: int | None = None,
    phase_range: str | None = None,
    footprint: str | None = None,
) -> str:
    """Thin schematic CONSTRUCT body (plan + phase + construct motor loop)."""
    rev_line = f"plan_revision: {plan_revision}\n" if plan_revision else ""
    level_line = f"level: {level}\n" if level is not None else ""
    range_line = f"range: {phase_range}\n" if phase_range else ""
    fp = footprint or f"7x7 at {anchor_mark}"
    return (
        f"anchor: {anchor_mark}\n"
        f"source_truth: region sign plan={plan_id}\n"
        f"worksite: {worksite}\n"
        f"plan: {plan_id}\n"
        f"phase: {phase_key}\n"
        f"{level_line}"
        f"{range_line}"
        f"{rev_line}"
        f"done_when: construct phase {phase_key} clean + mc construct end gates pass\n"
        f"mc bot checkout --near {checkout_near} --cap builder --mark {anchor_mark}\n"
        f"mc task_context set {worksite} --card {card_id} --plan {plan_id} "
        f"--phase {phase_key}"
        + (f" --level {level}" if level is not None else "")
        + " --card-kind CONSTRUCT\n"
        f"mc scene\n"
        f"mc observe\n"
        f"footprint: {fp}\n"
        f"protected_cells: none after survey — use construct workset\n"
        f"mc construct show\n"
        f"mc fill cobblestone (workset slices only)\n"
        f"mc construct end\n"
        f"mc bot release\n"
    )


def phase_card_bundle(
    plan: dict[str, Any],
    phase_key: str,
    *,
    worksite: str,
    destination: str,
    anchor_mark: str = "shelter_pad",
    checkout_near: str | None = None,
    supply_assignee: str = "colony-gatherer",
    construct_assignee: str = "colony-builder",
) -> dict[str, Any]:
    """SUPPLY cards + one CONSTRUCT card for a plan phase (file order: supply first)."""
    plan_id = str(plan.get("plan_id") or "unknown")
    ph = phase_record(plan, phase_key) or {}
    level = ph.get("level")
    phase_range = ph.get("range")
    near = checkout_near or anchor_mark
    revision = plan.get("revision")
    if isinstance(revision, str):
        plan_revision: str | None = revision
    else:
        plan_revision = None

    supplies = supply_cards_for_phase(
        plan,
        phase_key,
        destination=destination,
        anchor=anchor_mark,
        checkout_near=near,
        source_mark=anchor_mark,
    )
    for s in supplies:
        s["assignee"] = supply_assignee

    construct = {
        "kind": "CONSTRUCT",
        "title": construct_card_title(plan_id, phase_key),
        "assignee": construct_assignee,
        "body": construct_card_body(
            plan_id=plan_id,
            phase_key=phase_key,
            worksite=worksite,
            anchor_mark=anchor_mark,
            checkout_near=near,
            plan_revision=plan_revision,
            level=int(level) if level is not None else None,
            phase_range=str(phase_range) if phase_range else None,
            footprint=footprint_label(plan, at_mark=anchor_mark),
        ),
    }
    return {"phase_key": phase_key, "supply": supplies, "construct": construct}
