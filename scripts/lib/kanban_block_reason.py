"""Parse structured kanban_block reason strings from worker cards."""

from __future__ import annotations

from typing import Any

_PREFIXES = (
    "region_blocked",
    "prerequisite_missing",
    "stuck_pocket_no_escape",
    "decision_needed",
)

def parse(reason: str | None) -> dict[str, Any] | None:
    """Return parsed fields for known block reason prefixes, else None."""
    if not reason or not isinstance(reason, str):
        return None
    text = reason.strip()
    if not text:
        return None
    kind = text.split(":", 1)[0].strip().lower()
    if kind not in _PREFIXES:
        return None
    rest = text[len(kind) :].lstrip(":")
    parts = [p.strip() for p in rest.split(":") if p.strip() != ""] if rest else []
    out: dict[str, Any] = {"block_kind": kind, "raw": text}
    if kind == "region_blocked":
        out["region_id"] = parts[0] if parts else None
        out["short_reason"] = ":".join(parts[1:]) if len(parts) > 1 else None
    elif kind == "prerequisite_missing":
        out["missing"] = parts[0] if parts else None
        out["short_reason"] = ":".join(parts[1:]) if len(parts) > 1 else None
    elif kind == "stuck_pocket_no_escape":
        out["short_reason"] = ":".join(parts) if parts else None
    elif kind == "decision_needed":
        out["short_reason"] = ":".join(parts) if parts else None
    return out
