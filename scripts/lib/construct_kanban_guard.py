"""Block kanban complete while a worker bot still has an active construct session."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENT_MODELS = REPO_ROOT / "data" / "agent-models.json"


def api_base_for_profile(profile: str) -> str | None:
    """Resolve http://127.0.0.1:<port> for a landfolk profile name."""
    if not AGENT_MODELS.is_file():
        return None
    try:
        data = json.loads(AGENT_MODELS.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    agents = data.get("agents") or {}
    key = (profile or "").strip().lower()
    for name, spec in agents.items():
        if name.lower() == key:
            port = spec.get("api_port")
            if port is not None:
                return f"http://127.0.0.1:{int(port)}"
    return None


def _fetch_task_context_payload(profile: str, *, timeout: float = 2.0) -> dict[str, Any] | None:
    base = api_base_for_profile(profile)
    if not base:
        return None
    url = f"{base.rstrip('/')}/task-context"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            body = json.loads(resp.read().decode())
    except (urllib.error.URLError, OSError, TimeoutError, json.JSONDecodeError):
        return None
    if not body.get("ok"):
        return None
    data = body.get("data")
    return data if isinstance(data, dict) else None


def schematic_construct_card_requires_phase_end(title: str, body: str) -> bool:
    """True when a filed gv2-style schematic CONSTRUCT card must run mc construct end."""
    text = f"{title or ''}\n{body or ''}"
    if "CONSTRUCT" not in text.upper():
        return False
    if "--card-kind CONSTRUCT" not in body and "card_kind: CONSTRUCT" not in body:
        if "[CONSTRUCT]" not in (title or ""):
            return False
    if re.search(r"--plan\s+\S|plan:\s*\S|plan_id\s*[:=]", text):
        return True
    if "task_context set" in body and re.search(r"--plan\s+\S", body):
        return True
    return False


def construct_phase_closure_on_bot(
    profile: str,
    *,
    card_id: str | None = None,
    timeout: float = 2.0,
) -> dict[str, Any] | None:
    """Return bot-reported construct_phase_closed when it matches card_id (if given)."""
    data = _fetch_task_context_payload(profile, timeout=timeout)
    if not data:
        return None
    closure = data.get("construct_phase_closed")
    if not isinstance(closure, dict):
        tc = data.get("task_context")
        if isinstance(tc, dict):
            closure = tc.get("construct_phase_closed")
    if not isinstance(closure, dict):
        return None
    if card_id and closure.get("card_id") and str(closure.get("card_id")) != str(card_id):
        return None
    return closure


def construct_complete_blocked_on_bot(
    profile: str,
    *,
    card_id: str | None = None,
    require_schematic_construct_end: bool = False,
    timeout: float = 2.0,
) -> dict[str, Any] | None:
    """Return block payload if assignee bot cannot kanban-complete yet."""
    data = _fetch_task_context_payload(profile, timeout=timeout)
    if not data:
        if require_schematic_construct_end and card_id:
            return {
                "code": "CONSTRUCT_PHASE_NOT_CLOSED",
                "message": "Schematic CONSTRUCT card requires mc construct end before complete (bot unreachable)",
                "next_action_hint": "mc construct end on phase slice, then scripts/kanban complete",
            }
        return None
    block = data.get("construct_complete_blocked")
    if isinstance(block, dict):
        return block
    if require_schematic_construct_end and card_id:
        closure = construct_phase_closure_on_bot(profile, card_id=card_id, timeout=timeout)
        if not closure:
            return {
                "code": "CONSTRUCT_PHASE_NOT_CLOSED",
                "message": "Schematic CONSTRUCT card requires successful mc construct end on the phase slice",
                "next_action_hint": "mc construct show; fix slice; mc construct end (not slice verify alone); then complete",
            }
    return None
