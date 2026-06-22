"""base_viability — turn verify_layer's L0 gate into an offline scorecard signal.

gv2-2026-06-22-1 scored establishment 3.5 (shell=yes) on a flooded base. Milestone
flags ≠ a solid, drained foundation. This reads the captured base block-snapshot
(artifacts/world/base-snapshot.json) and applies the verify_layer L0 gate: the layer
directly under the fixtures (origin_y-1) must have NO air and NO water. When it fails,
apply_viability_gate downgrades shell -> no so the scorecard stops rewarding a
non-viable base. Pure/offline; no live rcon at score time.
"""
from __future__ import annotations

import json
from pathlib import Path

EMPTY = ("air", "water", "lava")


def extract_base_viability(run_root: Path) -> dict:
    snap_path = Path(run_root) / "artifacts" / "world" / "base-snapshot.json"
    if not snap_path.is_file():
        return {"present": False, "viable": None}
    try:
        snap = json.loads(snap_path.read_text())
    except (json.JSONDecodeError, OSError):
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
    }


def apply_viability_gate(establishment: dict, base_viability: dict) -> dict:
    """If the base is captured and NOT L0-viable, downgrade shell -> no and re-sum the
    establishment score. No-op when there is no snapshot (backward compatible)."""
    if not base_viability.get("present") or base_viability.get("viable") is not False:
        return establishment
    est = json.loads(json.dumps(establishment))  # deep copy
    ms = est.get("milestones") or {}
    gated = []
    if ms.get("shell") in ("yes", "partial"):
        ms["shell"] = "no"
        gated.append("shell")
    weights = {"yes": 1.0, "partial": 0.5, "no": 0.0}
    keys = ("site", "ground", "shell", "chest", "food", "mine")
    est["score"] = round(sum(weights.get(ms.get(k, "no"), 0.0) for k in keys), 2)
    est["milestones"] = ms
    est["viability_gated"] = gated
    est["viability_note"] = (
        f"base not viable (L0 y={base_viability.get('l0_y')}: "
        f"{base_viability.get('l0_air')} air + {base_viability.get('l0_water')} water) "
        f"-> shell downgraded"
    )
    return est
