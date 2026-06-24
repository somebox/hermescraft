"""HTTP API ports and MC usernames — landfolk fleet vs test-only Tester.

Tester is NOT in ``data/agent-models.json`` ``agents``; it lives in
``data/bots/tester.yaml`` and ``config/hermescraft.yaml`` ``bot.roles.tester``.
Landfolk scenario scripts must not mvtp Tester or bind the test port.
"""

from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENT_MODELS_PATH = REPO_ROOT / "data" / "agent-models.json"
TESTER_BOT_YAML = REPO_ROOT / "data" / "bots" / "tester.yaml"

# Reserved for pytest / run-tester-bot only — never assign to landfolk agents.
TESTER_API_PORT = 3004
TESTER_MC_USERNAME = "Tester"


def load_agent_models(path: Path | None = None) -> dict:
    p = path or AGENT_MODELS_PATH
    return json.loads(p.read_text(encoding="utf-8"))


def landfolk_agent_names(models: dict | None = None) -> list[str]:
    """Keys under ``agents`` in agent-models.json (JSON key order)."""
    d = models if models is not None else load_agent_models()
    agents = d.get("agents") or {}
    if not isinstance(agents, dict):
        return []
    return [str(k) for k in agents.keys()]


def landfolk_api_ports(models: dict | None = None) -> dict[str, int]:
    """Agent name → explicit ``api_port`` from agent-models.json."""
    d = models if models is not None else load_agent_models()
    agents = d.get("agents") or {}
    out: dict[str, int] = {}
    if not isinstance(agents, dict):
        return out
    for name, row in agents.items():
        if not isinstance(row, dict):
            continue
        ap = row.get("api_port")
        if ap is not None:
            out[str(name)] = int(ap)
    return out


def assert_no_tester_port_collision(models: dict | None = None) -> None:
    """Raise if any landfolk agent claims the reserved Tester port."""
    for name, port in landfolk_api_ports(models).items():
        if port == TESTER_API_PORT:
            raise ValueError(
                f"agent-models.json: {name!r} api_port={port} collides with "
                f"reserved Tester port {TESTER_API_PORT}",
            )


def is_test_mc_username(name: str) -> bool:
    return name.strip().casefold() == TESTER_MC_USERNAME.casefold()


def filter_scenario_evac_names(names: list[str]) -> list[str]:
    """Drop test-only accounts from proc-lab / world-reset mvtp lists."""
    return [n for n in names if not is_test_mc_username(n)]


def filter_online_for_scenario_evac(online: list[str], *, pool: list[str]) -> list[str]:
    """Build evac order: pool bots + online humans, never Tester."""
    order: list[str] = []
    for n in pool:
        if n not in order and not is_test_mc_username(n):
            order.append(n)
    for p in online:
        if p not in order and not is_test_mc_username(p):
            order.append(p)
    return order
