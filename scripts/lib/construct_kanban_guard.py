"""Block kanban complete while a worker bot still has an active construct session."""

from __future__ import annotations

import json
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


def construct_complete_blocked_on_bot(
    profile: str,
    *,
    timeout: float = 2.0,
) -> dict[str, Any] | None:
    """Return construct_complete_blocked payload if the assignee's bot session is active."""
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
    block = (body.get("data") or {}).get("construct_complete_blocked")
    return block if isinstance(block, dict) else None
