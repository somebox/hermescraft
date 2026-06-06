"""Build watchdog progress JSONL lines from lean /observe payloads (PR-S)."""

from __future__ import annotations

import json
import time
from typing import Any


def progress_snapshot_from_observe(
    observe: dict[str, Any],
    agent: str,
    *,
    ts: str | None = None,
) -> dict[str, Any] | None:
    """Mirror landfolk-control.sh watchdog emitter (recent + pos)."""
    try:
        ra = observe.get("recent_actions") or []
        recent = [
            f"{a.get('action', '?')}:{a.get('status', '?')}"
            for a in ra[-4:]
        ]
        state = observe.get("state") or {}
        pos_raw = (
            state.get("position")
            or observe.get("position")
            or observe.get("pos")
            or {}
        )
        pos = None
        if pos_raw:
            pos = {
                k: int(pos_raw[k])
                for k in ("x", "y", "z")
                if k in pos_raw and pos_raw[k] is not None
            }
            if not pos:
                pos = None
        return {
            "ts": ts or time.strftime("%Y-%m-%dT%H:%M:%S"),
            "agent": agent,
            "recent": recent,
            "pos": pos,
        }
    except Exception:
        return None


def emit_progress_line(observe: dict[str, Any], agent: str) -> str:
    snap = progress_snapshot_from_observe(observe, agent)
    if not snap:
        return ""
    return json.dumps(snap, separators=(",", ":"))
