"""Shared action-log friction metrics."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _summarize_action_log(entries: list[dict]) -> dict:
    spec = importlib.util.spec_from_file_location(
        "agent_test", REPO / "scripts" / "agent-test.py"
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(mod)
    return mod.summarize_action_log(entries)


def load_jsonl_entries(artifact_dir: Path) -> list[dict]:
    entries: list[dict] = []
    for jl in sorted(artifact_dir.glob("actions-*.jsonl")):
        for line in jl.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def summarize_scoped_run(artifact_dir: Path) -> dict:
    return _summarize_action_log(load_jsonl_entries(artifact_dir))
