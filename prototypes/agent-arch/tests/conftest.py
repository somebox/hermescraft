"""Shared pytest options for agent-arch capstone tests."""

from __future__ import annotations

import os


def pytest_addoption(parser):
    parser.addoption(
        "--run-id",
        action="store",
        default=None,
        help="Capstone trial run_id (W1 wheat or two-bot)",
    )


def resolve_run_id_from_request(request, *, env_var: str, postmortems_glob) -> str:
    """CLI --run-id wins, then env var, then most recent manifest under glob."""
    cli = request.config.getoption("--run-id", default=None)
    if cli:
        return cli
    env = os.environ.get(env_var)
    if env:
        return env
    runs = sorted(postmortems_glob, key=lambda p: p.stat().st_mtime, reverse=True)
    if not runs:
        raise RuntimeError("no run id: pass --run-id or set env")
    return runs[0].parent.name
