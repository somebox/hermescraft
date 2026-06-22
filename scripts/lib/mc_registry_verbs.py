"""Load mc verb names from bot/cli/registry.mjs (lightweight parse)."""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
REGISTRY = REPO / "bot" / "cli" / "registry.mjs"

_NAME_RE = re.compile(r"\bname:\s*['\"]([a-z_][a-z0-9_]*)['\"]")
_TIER_RE = re.compile(r"\btier:\s*['\"](core|extended|debug)['\"]")


def load_verbs_by_tier() -> dict[str, list[str]]:
    text = REGISTRY.read_text(encoding="utf-8") if REGISTRY.is_file() else ""
    core: list[str] = []
    current_tier = ""
    for line in text.splitlines():
        tm = _TIER_RE.search(line)
        if tm:
            current_tier = tm.group(1)
        nm = _NAME_RE.search(line)
        if nm and current_tier == "core":
            core.append(nm.group(1))
    return {"core": sorted(set(core))}


def core_verbs() -> list[str]:
    return load_verbs_by_tier().get("core") or []
