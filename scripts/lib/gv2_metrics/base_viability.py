"""base_viability — turn captured base blocks into offline scorecard truth.

gv2-2026-06-22-1 scored establishment 3.5 (shell=yes) on a flooded base. Milestone
flags ≠ a solid, drained foundation. This reads the captured base block-snapshot
(artifacts/world/base-snapshot.json) and applies the verify_layer L0 gate: the layer
directly under the fixtures (origin_y-1) must have NO air and NO water. When it fails,
apply_viability_gate downgrades shell -> no so the scorecard stops rewarding a
non-viable base.

gv2-2026-06-24-9 then exposed the second half of the same measurement problem:
cards said shell=yes while the physical wall layer was gone. When the snapshot
contains starter_shelter wall/roof layers, this module also checks plan cells so
shell=yes requires physical walls + roof, not just completed card titles.
Pure/offline; no live rcon at score time.
"""
from __future__ import annotations

import json
from pathlib import Path

EMPTY = ("air", "water", "lava")


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
    """Whether this run should be judged against starter_shelter shell cells."""
    rendered = Path(run_root) / "rendered" / "starter_shelter-plan.json"
    if rendered.is_file():
        return True
    cfg = _load_json(Path(run_root) / "config.json") or {}
    if cfg.get("schematic_shelter_bootstrapped"):
        return True
    return bool(cfg.get("schematic_shelter_cards"))


def _phase_shell_integrity(run_root: Path, snap: dict) -> dict:
    """Compare captured block layers to starter_shelter wall/roof plan cells.

    Returns present=False when the old snapshot is too shallow (pre-oy+4 capture)
    or the plan is unavailable. Otherwise reports expected/matched/missing/wrong
    counts for walls (dy 3..4) and roof (dy 5).
    """
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
        # base_anchor origin is center feet; plan footprint minimum is center-3,
        # origin_y-1, center-3.
        anchor = [int(origin[0]) - 3, int(origin[1]) - 1, int(origin[2]) - 3]
    ax, ay, az = (int(anchor[0]), int(anchor[1]), int(anchor[2]))
    by_phase = {
        "walls": {"dy": {3, 4}, "expected": 0, "matched": 0, "missing": 0, "wrong": 0},
        "roof": {"dy": {5}, "expected": 0, "matched": 0, "missing": 0, "wrong": 0},
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
    oy = origin[1]
    layers = snap.get("layers") or {}
    # L0 = the layer the base stands on, directly under the fixture/anchor level.
    l0_y = (oy - 1) if isinstance(oy, int) else None
    counts = ((layers.get(str(l0_y)) or {}).get("counts") or {}) if l0_y is not None else {}
    l0_air = int(counts.get("air") or 0)
    l0_water = int(counts.get("water") or 0) + int(counts.get("lava") or 0)
    l0_present = bool(counts)
    l0_ok = l0_present and l0_air == 0 and l0_water == 0
    return {
        "present": l0_present,
        "origin": origin,
        "l0_y": l0_y,
        "l0_air": l0_air,
        "l0_water": l0_water,
        "l0_ok": l0_ok,
        "viable": l0_ok if l0_present else None,
        "shell": _phase_shell_integrity(Path(run_root), snap),
    }


def apply_viability_gate(establishment: dict, base_viability: dict) -> dict:
    """Downgrade card-derived shell credit when physical base truth disproves it."""
    shell = base_viability.get("shell") or {}
    incomplete_shell = shell.get("present") and shell.get("complete") is False
    bad_l0 = base_viability.get("present") and base_viability.get("viable") is False
    if not (bad_l0 or incomplete_shell):
        return establishment
    est = json.loads(json.dumps(establishment))  # deep copy
    ms = est.get("milestones") or {}
    gated = []
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
            f"L0 y={base_viability.get('l0_y')}: "
            f"{base_viability.get('l0_air')} air + {base_viability.get('l0_water')} water"
        )
    if incomplete_shell:
        w = shell.get("walls") or {}
        r = shell.get("roof") or {}
        notes.append(
            f"shell incomplete: walls {w.get('matched', 0)}/{w.get('expected', 0)}, "
            f"roof {r.get('matched', 0)}/{r.get('expected', 0)}"
        )
    est["viability_note"] = "; ".join(notes) + " -> downgraded physical milestones"
    return est
