#!/usr/bin/env python3
"""Distill a Hermes decision turn into a draft context-test scenario YAML."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO = _SCRIPT_DIR.parent.parent
if str(_SCRIPT_DIR.parent) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR.parent))

from hermes_session_lib import expand_message_records, load_messages, session_files_for_profile

DATA_DIR = _REPO / "data" / "context-tests"
CAPTURES_DIR = DATA_DIR / "captures"
RAW_DIR = CAPTURES_DIR / "_raw"
PROFILE_SKILLS = DATA_DIR / "profile-skills.yaml"


def _load_yaml(path: Path):
    try:
        import yaml
    except ImportError:
        raise SystemExit("capture.py requires PyYAML or bot/node_modules yaml")
    return yaml.safe_load(path.read_text())


def _dump_yaml(obj, path: Path):
    try:
        import yaml
    except ImportError:
        raise SystemExit("capture.py requires PyYAML")
    path.write_text(yaml.safe_dump(obj, sort_keys=False, allow_unicode=True))


def cognition_dir() -> Path:
    log = Path(os.environ.get("LOG_DIR", "/tmp/hermescraft"))
    return Path(os.environ.get("COGNITION_DIR", str(log / "cognition")))


def slice_jsonl(path: Path, start_ts: str | None, end_ts: str | None) -> list[dict]:
    if not path.is_file():
        return []
    rows = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def mc_from_assistant(text: str) -> str | None:
    for ln in text.splitlines():
        ln = ln.strip()
        if ln.startswith("mc "):
            return ln
    return None


def build_draft(
    profile: str,
    turn_index: int,
    records: list[dict],
    source_ref: str,
) -> dict:
    prior = []
    for rec in records[:turn_index]:
        if rec.get("kind") == "assistant":
            cmd = mc_from_assistant(rec.get("content") or "")
            if cmd:
                prior.append({"assistant": cmd, "tool_result": {"ok": True, "note": "placeholder"}})
        if rec.get("kind") == "tool_result" and prior:
            prior[-1]["tool_result"] = rec.get("content") or rec.get("result") or {}

    return {
        "schema_version": 1,
        "id": f"capture_{profile}_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}",
        "category": "recovery",
        "description": f"Captured from {profile} cognition turn {turn_index}",
        "contract_level": "exploratory",
        "source": {
            "kind": "hermes_session",
            "ref": source_ref,
            "captured_at": datetime.now(timezone.utc).isoformat(),
        },
        "capture_fidelity": {
            "has_profile": True,
            "has_skills": False,
            "has_observe": False,
            "has_prior_tool_results": bool(prior),
            "has_memory": False,
            "known_missing": ["observe", "skills"],
        },
        "profile": f"prompts/landfolk/{profile}.md",
        "skills": [],
        "observe": "data/context-tests/_shared/observe-nav-blocked.json",
        "memory": {"mode": "none"},
        "prior_format": "text",
        "prior": prior[-3:] if prior else [],
        "user_prompt": "Decide your next action.",
        "expect": {
            "tool_calls": {
                "require_parse_ok": True,
                "max_lines": 6,
            }
        },
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Capture draft context-test scenario")
    ap.add_argument("--profile", required=True)
    ap.add_argument("--turn", type=int, default=-1, help="Record index in cognition JSONL")
    ap.add_argument("--capture-id", default=None)
    ap.add_argument("--g-series", type=Path, help="Seed from data/agent-tests/G*.yaml")
    args = ap.parse_args()

    capture_id = args.capture_id or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = RAW_DIR / capture_id
    out_dir.mkdir(parents=True, exist_ok=True)

    cog_dir = cognition_dir()
    cog_path = cog_dir / f"{args.profile}.jsonl"
    bot_events = cog_dir / "bot-events.jsonl"

    if args.g_series:
        spec = _load_yaml(args.g_series)
        draft = {
            "schema_version": 1,
            "id": spec.get("id", args.g_series.stem),
            "category": "recovery",
            "description": spec.get("description", ""),
            "contract_level": "exploratory",
            "source": {"kind": "g_series_trace", "ref": str(args.g_series.relative_to(_REPO))},
            "profile": "prompts/landfolk/flint.md",
            "skills": [],
            "observe": "data/context-tests/_shared/observe-nav-blocked.json",
            "memory": {"mode": "none"},
            "user_prompt": spec.get("prompt", "Decide your next action."),
            "expect": {"tool_calls": {"require_parse_ok": True, "max_lines": 8}},
        }
    else:
        records = slice_jsonl(cog_path, None, None)
        if not records:
            print(f"No cognition at {cog_path}", file=sys.stderr)
            sys.exit(1)
        idx = args.turn if args.turn >= 0 else len(records) - 1
        draft = build_draft(args.profile, idx, records, str(cog_path))
        if cog_path.is_file():
            shutil.copy2(cog_path, out_dir / "cognition.jsonl")
        if bot_events.is_file():
            shutil.copy2(bot_events, out_dir / "bot-events.jsonl")

    draft_path = out_dir / "scenario.draft.yaml"
    promoted = DATA_DIR / f"{draft['id']}.yaml"
    _dump_yaml(draft, draft_path)
    print(f"Wrote {draft_path}")
    print(f"Review and promote to {promoted} when ready.")


if __name__ == "__main__":
    main()
