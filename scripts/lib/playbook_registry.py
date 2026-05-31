"""Load data/playbooks/registry.yaml for kanban + nav-telemetry compliance."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
REGISTRY_PATH = REPO_ROOT / "data" / "playbooks" / "registry.yaml"

_PLAYBOOK_LINE = re.compile(r"^\s*playbook:\s*([a-zA-Z0-9_.-]+)\s*$", re.MULTILINE)


def load_registry(path: Path | None = None) -> dict[str, Any]:
    p = path or REGISTRY_PATH
    if not p.is_file():
        return {"playbooks": [], "worker_allowed_prefixes": []}
    try:
        import yaml
    except ImportError:
        text = p.read_text(encoding="utf-8")
        ids = re.findall(r"^\s*-\s*id:\s*([^\s#]+)", text, re.MULTILINE)
        return {"playbooks": [{"id": i} for i in ids], "worker_allowed_prefixes": []}
    with p.open(encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def registry_ids(path: Path | None = None) -> set[str]:
    reg = load_registry(path)
    out: set[str] = set()
    for entry in reg.get("playbooks") or []:
        if isinstance(entry, dict) and entry.get("id"):
            out.add(str(entry["id"]))
    return out


def parse_playbook_from_body(body: str) -> str | None:
    m = _PLAYBOOK_LINE.search(body or "")
    return m.group(1).strip() if m else None


def validate_card_body_playbook(body: str, path: Path | None = None) -> str | None:
    """Return error message if playbook id invalid; else None."""
    pid = parse_playbook_from_body(body)
    if not pid:
        return None
    allowed = registry_ids(path)
    if pid not in allowed:
        return f"unknown playbook id {pid!r} (not in {REGISTRY_PATH.name})"
    return None
