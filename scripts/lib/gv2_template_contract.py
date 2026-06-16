"""Genesis-v2 template contract checks (offline, no kanban)."""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
EPICS = REPO / "data" / "genesis-v2" / "templates" / "phase-epics.yaml"


def p1_build_epic_body() -> str:
    import genesis_lib as gl  # noqa: E402 — scripts on path in tests

    data = gl.parse_yaml_simple(EPICS)
    for e in data.get("epics", []):
        if e.get("phase") == "P1" or "[GENESIS2:P1]" in (e.get("title") or ""):
            return e.get("body") or ""
    return ""


def lint_p1_build_policy(body: str) -> list[str]:
    """BUILD policy: no ad-hoc protect region_create; require task_context + no free-build-only."""
    errs: list[str] = []
    low = body.lower()
    for line in body.splitlines():
        ll = line.lower()
        if any(x in ll for x in ("do not", "never", "forbid", "must not")):
            continue
        if "region_create" in ll and "protect" in ll:
            errs.append("P1 epic must not instruct region_create with protect intent")
            break
    if "task_context set" not in low:
        errs.append("P1 BUILD must reference mc task_context set for worksite grant")
    if "mc mark base_anchor <" in body or "base_anchor <x>" in low:
        errs.append("BASE-SELECT must use mc mark with --at, not positional XYZ after name")
    if "5x5 walls + roof" in low and "render" not in low and "blueprint" not in low:
        errs.append("P1 BUILD must not rely on prose free-build only (need render/blueprint path)")
    return errs


def lint_base_clear_policy(body: str) -> list[str]:
    """P1 must have a BASE-CLEAR step that uses tree-aware clear_strip
    (road_mode=true) and an EXECUTING level_ground (execute=true — dry-run
    otherwise), and notes the <=16-column tiling cap."""
    errs: list[str] = []
    low = body.lower()
    if "base-clear" not in low and "clear_strip" not in low:
        errs.append("P1 epic missing a BASE-CLEAR step (clear + flatten the base footprint)")
        return errs
    if "clear_strip" in low and "road_mode=true" not in low:
        errs.append("BASE-CLEAR clear_strip must set road_mode=true (else trees/canopy aren't taken)")
    if "level_ground" in low and "execute=true" not in low:
        errs.append("BASE-CLEAR level_ground must set execute=true (it is dry-run otherwise)")
    if "16" not in low:
        errs.append("BASE-CLEAR must note the <=16-column tiling cap for level_ground")
    return errs


_LEVEL_RE = re.compile(r"\blevel(?:_ground)?\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)")


def lint_level_columns(text: str, cap: int = 16) -> list[str]:
    """Flag concrete `level`/`level_ground X1 Z1 X2 Z2` calls whose rectangle
    exceeds `cap` columns (the server-side per-call limit). For validating EMITTED
    cards (numeric coords); the template uses placeholders and is exempt."""
    errs: list[str] = []
    for m in _LEVEL_RE.finditer(text):
        x1, z1, x2, z2 = (int(g) for g in m.groups())
        cols = (abs(x2 - x1) + 1) * (abs(z2 - z1) + 1)
        if cols > cap:
            errs.append(f"level call covers {cols} columns (> {cap}): {m.group(0).strip()}")
    return errs
