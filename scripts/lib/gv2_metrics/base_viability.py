"""base_viability — turn captured base blocks into offline scorecard truth.

gv2-2026-06-22-1 scored establishment 3.5 (shell=yes) on a flooded base. Milestone
flags ≠ a solid, drained foundation. This reads the captured base block-snapshot
(artifacts/world/base-snapshot.json) and applies the verify_layer L0 gate on the
**plan footprint** at L0 (origin_y-1), not whole capture-region counts.

When L0 fails on accurate footprint measurement, apply_viability_gate downgrades
physical milestones (shell when foundation is bad or shell incomplete; ground when
L0 bad).

gv2-2026-06-25-3: broad layer counts (grass/air outside 7×7) falsely tripped bad_l0
and stripped shell despite walls/roof 46/46.
Pure/offline; no live rcon at score time.
"""
from __future__ import annotations

import json
from pathlib import Path

EMPTY = ("air", "water", "lava")
FLUID = ("water", "lava")


def _load_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text()) if path.is_file() else None
    except (json.JSONDecodeError, OSError):
        return None


def _load_shelter_plan(run_root: Path) -> dict | None:
    for path in (
        Path(run_root) / "rendered" / "starter_shelter-plan.json",
        Path(run_root) / "artifacts" / "world" / "starter_shelter-plan.json",
        Path(__file__).resolve().parents[3] / "data" / "ops" / "plans" / "starter_shelter-plan.json",
    ):
        doc = _load_json(path)
        if isinstance(doc, dict):
            return doc
    return None


def _has_schematic_shell_context(run_root: Path) -> bool:
    rendered = Path(run_root) / "rendered" / "starter_shelter-plan.json"
    if rendered.is_file():
        return True
    cfg = _load_json(Path(run_root) / "config.json") or {}
    if cfg.get("schematic_shelter_bootstrapped"):
        return True
    return bool(cfg.get("schematic_shelter_cards"))


def _footprint_xz(origin: list) -> tuple[int, int, int, int, int, int]:
    ox, oy, oz = (int(origin[0]), int(origin[1]), int(origin[2]))
    return ox - 3, ox + 3, oz - 3, oz + 3, ox, oz


def _phase_dy_set(plan: dict, phase_id: str, default: set) -> set:
    for ph in plan.get("phases") or []:
        if ph.get("id") != phase_id:
            continue
        if ph.get("level") is not None:
            try:
                return {int(ph["level"])}
            except (TypeError, ValueError):
                return set(default)
        rng = ph.get("range")
        if rng:
            try:
                a, b = (int(x) for x in str(rng).split(".."))
                return set(range(a, b + 1))
            except (TypeError, ValueError):
                return set(default)
    return set(default)


def _l0_viable(l0_air: int, l0_water: int, coverage_complete: bool) -> bool | None:
    """Single source of truth for L0 `viable` on both capture paths.

    - confirmed water/lava in read cells  -> False (always; flooding is flooding even
      if some cells are unread — partial capture must NOT hide it)
    - confirmed air in read cells          -> False only when coverage is complete
      (an isolated air hole on partial capture is "unknown", not proven bad)
    - all read cells clean + some unread   -> None (unknown / untrusted)
    - full clean footprint                 -> True
    """
    if l0_water > 0 or (coverage_complete and l0_air > 0):
        return False
    return True if coverage_complete else None


def _footprint_l0_metrics(snap: dict) -> dict:
    """L0 viability on 7×7 footprint at l0_y using per-cell data when present."""
    origin = snap.get("origin") or [None, None, None]
    if not isinstance(origin[1], int):
        return {"present": False}
    oy = int(origin[1])
    l0_y = oy - 1
    layers = snap.get("layers") or {}
    layer = layers.get(str(l0_y)) if isinstance(layers, dict) else None
    if not isinstance(layer, dict):
        return {"present": False}

    coverage = snap.get("coverage") or {}
    if coverage.get("l0_footprint"):
        c_air = int(coverage.get("l0_air") or 0)
        c_water = int(coverage.get("l0_water") or 0)
        c_complete = bool(coverage.get("coverage_complete"))
        return {
            "present": True,
            "l0_y": l0_y,
            "l0_air": c_air,
            "l0_water": c_water,
            "l0_unread": int(coverage.get("l0_unread") or 0),
            "l0_footprint_cells": int(coverage.get("l0_footprint_cells") or 49),
            "l0_ok": bool(coverage.get("l0_ok")),
            "coverage_complete": c_complete,
            "viable": _l0_viable(c_air, c_water, c_complete),
        }

    xmin, xmax, zmin, zmax, ox, oz = _footprint_xz(origin)
    cells = layer.get("cells") or {}
    counts = layer.get("counts") or {}
    l0_air = 0
    l0_water = 0
    l0_unread = 0
    scanned = 0
    if isinstance(cells, dict) and cells:
        for x in range(xmin, xmax + 1):
            for z in range(zmin, zmax + 1):
                scanned += 1
                key = f"{x},{z}"
                if key not in cells:
                    l0_unread += 1
                    continue
                block = cells[key]
                if block in EMPTY and block == "air":
                    l0_air += 1
                elif block in FLUID:
                    l0_water += 1
        present = scanned > 0
        coverage_complete = l0_unread == 0
        l0_ok = present and coverage_complete and l0_air == 0 and l0_water == 0
        viable = _l0_viable(l0_air, l0_water, coverage_complete) if present else None
        return {
            "present": present,
            "l0_y": l0_y,
            "l0_air": l0_air,
            "l0_water": l0_water,
            "l0_unread": l0_unread,
            "l0_footprint_cells": scanned,
            "l0_ok": l0_ok,
            "coverage_complete": coverage_complete,
            "viable": viable,
        }

    # Legacy snapshots: whole-layer counts only — treat as incomplete coverage.
    l0_air = int(counts.get("air") or 0)
    l0_water = int(counts.get("water") or 0) + int(counts.get("lava") or 0)
    l0_present = bool(counts)
    strict_bad = l0_present and l0_air == 0 and l0_water == 0
    return {
        "present": l0_present,
        "l0_y": l0_y,
        "l0_air": l0_air,
        "l0_water": l0_water,
        "l0_unread": -1,
        "l0_footprint_cells": 0,
        "l0_ok": strict_bad,
        "coverage_complete": False,
        "viable": True if strict_bad else None,
        "legacy_counts_only": True,
    }


def _physical_ground_ok(snap: dict, plan: dict | None) -> tuple[bool, list[str]]:
    """Physical ground: drained L0 footprint + L1 slab evidence (not card completion)."""
    l0 = _footprint_l0_metrics(snap)
    evidence: list[str] = []
    if not l0.get("present"):
        return False, evidence
    if not l0.get("l0_ok"):
        return False, evidence
    evidence.append(f"L0 y={l0.get('l0_y')}: footprint air=0 water=0")

    origin = snap.get("origin") or [0, 0, 0]
    oy = int(origin[1])
    l1_y = oy
    layers = snap.get("layers") or {}
    l1 = layers.get(str(l1_y)) if isinstance(layers, dict) else None
    if not isinstance(l1, dict):
        return False, evidence

    coverage = snap.get("coverage") or {}
    if coverage.get("l1_slab"):
        if coverage.get("l1_slab_ok"):
            evidence.append("snapshot:l1_slab_ok")
            return True, evidence
        return False, evidence

    xmin, xmax, zmin, zmax, _, _ = _footprint_xz(origin)
    cells = l1.get("cells") or {}
    cobble = 0
    expected_slab = 0
    if plan:
        l1_dys = _phase_dy_set(plan, "L1_slab", {1})
        for cell in plan.get("cells") or []:
            loc = cell.get("local")
            if not (isinstance(loc, list) and len(loc) == 3):
                continue
            if int(loc[1]) not in l1_dys:
                continue
            if (cell.get("block") or "").startswith("cobble"):
                expected_slab += 1
    if isinstance(cells, dict) and cells:
        for x in range(xmin, xmax + 1):
            for z in range(zmin, zmax + 1):
                b = cells.get(f"{x},{z}")
                if b and "cobble" in str(b):
                    cobble += 1
        threshold = max(20, expected_slab // 2) if expected_slab else 20
        if cobble >= threshold:
            evidence.append(f"L1 y={l1_y}: cobblestone={cobble}")
            return True, evidence
        return False, evidence

    counts = l1.get("counts") or {}
    cobble = int(counts.get("cobblestone") or 0)
    if cobble >= 20:
        evidence.append(f"L1 y={l1_y}: cobblestone_count={cobble}")
        return True, evidence
    return False, evidence


def _phase_shell_integrity(run_root: Path, snap: dict) -> dict:
    if not _has_schematic_shell_context(run_root):
        return {"present": False}
    exact = snap.get("shell")
    if isinstance(exact, dict) and exact.get("present"):
        return exact
    plan = _load_shelter_plan(run_root)
    origin = snap.get("origin") or [None, None, None]
    layers = snap.get("layers") or {}
    if not plan or not isinstance(origin[1], int) or not isinstance(layers, dict):
        return {"present": False}
    anchor = (plan.get("anchor") or {}).get("coords")
    if not (isinstance(anchor, list) and len(anchor) == 3):
        anchor = [int(origin[0]) - 3, int(origin[1]) - 1, int(origin[2]) - 3]
    ax, ay, az = (int(anchor[0]), int(anchor[1]), int(anchor[2]))
    by_phase = {
        "walls": {"dy": _phase_dy_set(plan, "L3_walls", {2, 3, 4}),
                  "expected": 0, "matched": 0, "missing": 0, "wrong": 0},
        "roof": {"dy": _phase_dy_set(plan, "L4_roof", {5}),
                 "expected": 0, "matched": 0, "missing": 0, "wrong": 0},
    }
    saw_relevant_layer = False
    for cell in plan.get("cells") or []:
        loc = cell.get("local")
        block = cell.get("block") or cell.get("expected_block")
        if not (isinstance(loc, list) and len(loc) == 3 and block):
            continue
        dx, dy, dz = (int(loc[0]), int(loc[1]), int(loc[2]))
        phase = "walls" if dy in by_phase["walls"]["dy"] else "roof" if dy in by_phase["roof"]["dy"] else None
        if not phase:
            continue
        wx, wy, wz = ax + dx, ay + dy, az + dz
        layer = layers.get(str(wy))
        if not isinstance(layer, dict):
            continue
        saw_relevant_layer = True
        cells = layer.get("cells") or {}
        actual = cells.get(f"{wx},{wz}", "air")
        rec = by_phase[phase]
        rec["expected"] += 1
        if actual == block:
            rec["matched"] += 1
        elif actual in EMPTY:
            rec["missing"] += 1
        else:
            rec["wrong"] += 1
    if not saw_relevant_layer:
        return {"present": False}
    walls = {k: v for k, v in by_phase["walls"].items() if k != "dy"}
    roof = {k: v for k, v in by_phase["roof"].items() if k != "dy"}
    complete = (
        walls["expected"] > 0
        and roof["expected"] > 0
        and walls["matched"] == walls["expected"]
        and roof["matched"] == roof["expected"]
    )
    return {"present": True, "complete": complete, "walls": walls, "roof": roof}


def extract_base_viability(run_root: Path) -> dict:
    snap_path = Path(run_root) / "artifacts" / "world" / "base-snapshot.json"
    if not snap_path.is_file():
        return {"present": False, "viable": None}
    snap = _load_json(snap_path)
    if not isinstance(snap, dict):
        return {"present": False, "viable": None}
    origin = snap.get("origin") or [None, None, None]
    l0m = _footprint_l0_metrics(snap)
    plan = _load_shelter_plan(Path(run_root))
    ground_ok, ground_evidence = _physical_ground_ok(snap, plan)
    viable = l0m.get("viable")
    if viable is None and l0m.get("legacy_counts_only") and l0m.get("l0_ok"):
        viable = True
    out = {
        "present": l0m.get("present", False),
        "origin": origin,
        "l0_y": l0m.get("l0_y"),
        "l0_air": l0m.get("l0_air", 0),
        "l0_water": l0m.get("l0_water", 0),
        "l0_unread": l0m.get("l0_unread", 0),
        "l0_footprint_cells": l0m.get("l0_footprint_cells", 0),
        "l0_ok": l0m.get("l0_ok", False),
        "coverage_complete": l0m.get("coverage_complete", False),
        "viable": viable if l0m.get("present") else None,
        # We only TRUST the L0 verdict when the footprint capture is complete; a partial
        # capture can hide hazards in unread cells (gv2-2026-06-25-3). Surfaced so a score
        # is never silently believed on incomplete data.
        "base_viability_trusted": bool(l0m.get("present") and l0m.get("coverage_complete")),
        "physical_ground_ok": ground_ok,
        "physical_ground_evidence": ground_evidence,
        "shell": _phase_shell_integrity(Path(run_root), snap),
    }
    # A partial L0 capture means the physical verdict is on incomplete data — never let a
    # score (even shell=yes) be silently believed (GS1). Surface a warning consumers roll
    # up; we still don't promote `ground` without full coverage.
    if l0m.get("present") and not l0m.get("coverage_complete"):
        out["coverage_warning"] = (
            f"L0 capture incomplete: unread={l0m.get('l0_unread')} of "
            f"{l0m.get('l0_footprint_cells')} footprint cells — base_viability untrusted "
            f"(ground not promotable until full coverage)"
        )
    if l0m.get("legacy_counts_only"):
        out["legacy_counts_only"] = True
    return out


def apply_viability_gate(establishment: dict, base_viability: dict) -> dict:
    """Downgrade card-derived milestones when physical base truth disproves them."""
    shell = base_viability.get("shell") or {}
    incomplete_shell = shell.get("present") and shell.get("complete") is False
    bad_l0 = (
        base_viability.get("present")
        and base_viability.get("viable") is False
    )
    if not (bad_l0 or incomplete_shell):
        est = json.loads(json.dumps(establishment))
        return _promote_physical_ground(est, base_viability)

    est = json.loads(json.dumps(establishment))
    ms = est.get("milestones") or {}
    gated = []
    if incomplete_shell or bad_l0:
        if ms.get("shell") in ("yes", "partial"):
            ms["shell"] = "no"
            gated.append("shell")
    if bad_l0 and ms.get("ground") in ("yes", "partial"):
        ms["ground"] = "no"
        gated.append("ground")
    weights = {"yes": 1.0, "partial": 0.5, "no": 0.0}
    keys = ("site", "ground", "shell", "chest", "food", "mine")
    est["score"] = round(sum(weights.get(ms.get(k, "no"), 0.0) for k in keys), 2)
    est["milestones"] = ms
    est["viability_gated"] = gated
    notes = []
    if bad_l0:
        notes.append(
            f"L0 y={base_viability.get('l0_y')}: footprint "
            f"air={base_viability.get('l0_air')} water={base_viability.get('l0_water')}"
        )
    if incomplete_shell:
        w = shell.get("walls") or {}
        r = shell.get("roof") or {}
        notes.append(
            f"shell incomplete: walls {w.get('matched', 0)}/{w.get('expected', 0)}, "
            f"roof {r.get('matched', 0)}/{r.get('expected', 0)}"
        )
    if not base_viability.get("coverage_complete") and base_viability.get("present"):
        notes.append(
            f"L0 capture incomplete: unread={base_viability.get('l0_unread')} "
            f"of {base_viability.get('l0_footprint_cells')} footprint cells"
        )
    est["viability_note"] = "; ".join(notes) + " -> downgraded physical milestones"
    return _promote_physical_ground(est, base_viability)


def _promote_physical_ground(establishment: dict, base_viability: dict) -> dict:
    if not base_viability.get("physical_ground_ok"):
        return establishment
    ms = establishment.get("milestones") or {}
    if ms.get("ground") == "no":
        ms["ground"] = "yes"
        evidence = establishment.get("evidence") or {}
        if not isinstance(evidence.get("ground"), list):
            evidence["ground"] = []
        for item in base_viability.get("physical_ground_evidence") or []:
            tag = f"physical:{item}"
            if tag not in evidence["ground"]:
                evidence["ground"].append(tag)
        weights = {"yes": 1.0, "partial": 0.5, "no": 0.0}
        keys = ("site", "ground", "shell", "chest", "food", "mine")
        establishment["score"] = round(sum(weights.get(ms.get(k, "no"), 0.0) for k in keys), 2)
        establishment["milestones"] = ms
        establishment["evidence"] = evidence
        establishment["physical_ground_promoted"] = True
    return establishment
