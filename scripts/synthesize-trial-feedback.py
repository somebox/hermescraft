#!/usr/bin/env python3
"""Merge trial feedback into _known_issues.json with explicit match rules."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_REGISTRY = REPO / "data/postmortems/wheat-capstone/_known_issues.json"

KEYWORD_MAP = [
    (re.compile(r"stuck|escape|unreachable|NAV_BLOCKED|BOT_TRAPPED", re.I), "W2-NAV-002"),
    (re.compile(r"anchor|go_mark|reachable|INVALID_COORD|flat_patch", re.I), "W2-NAV-001"),
    (re.compile(r"verify_results|observation_source", re.I), "W2-NAV-003"),
    (re.compile(r"tool_call_count|chat.mode|mc_cli_invocations", re.I), "W2-NAV-004"),
    (re.compile(r"minecraft-observe|observe skill|pn-observe", re.I), "W2-NAV-005"),
    (re.compile(r"last-scenario-map|playbook|data.source|pn-plan", re.I), "W2-NAV-006"),
    (re.compile(r"farm_status|inspect\s+--mark", re.I), "blocked:needs_repo_mc"),
    (re.compile(r"coord|marks|corner|bounds", re.I), "W2-AUTO-001"),
    (re.compile(r"chest|deposit", re.I), "W2-AUTO-002"),
    (re.compile(r"survey|same plot|re-survey|16.?x.?16", re.I), "W2-AUTO-003"),
    (re.compile(r"tester|verify.*fail|chunk", re.I), "W2-EVAL-TESTER"),
    (re.compile(r"threshold|min_count|chest_contains", re.I), "W2-EVAL-THRESHOLD"),
    (re.compile(r"MC_API_URL.*broken|mc.*unreachable", re.I), "MC_API_URL"),
]


def load_registry(path: Path) -> dict:
    return json.loads(path.read_text())


def save_registry(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2) + "\n")


def issue_by_id(data: dict, iid: str) -> dict | None:
    for item in data.get("issues", []):
        if item.get("id") == iid:
            return item
    return None


def match_issue_id(text: str) -> str | None:
    for pat, iid in KEYWORD_MAP:
        if pat.search(text):
            return iid
    return None


def confabulation_mc_api(text: str, scorecard: dict | None) -> bool:
    if not re.search(r"MC_API_URL", text, re.I):
        return False
    arch = (scorecard or {}).get("architectural") or {}
    return bool(arch.get("role_env_has_mc_vars"))


def synthesize(
    run_id: str,
    feedback_dir: Path,
    *,
    scorecard_path: Path | None,
    registry_path: Path,
) -> tuple[list[str], list[dict]]:
    data = load_registry(registry_path)
    scorecard = (
        json.loads(scorecard_path.read_text())
        if scorecard_path and scorecard_path.is_file()
        else None
    )
    delta_notes: list[str] = []

    for fb in sorted(feedback_dir.glob("feedback-*.md")):
        text = fb.read_text()
        if confabulation_mc_api(text, scorecard):
            delta_notes.append(f"{fb.name}: evidence_note=confabulation_suspected")
            continue
        iid = match_issue_id(text)
        if not iid or iid == "MC_API_URL":
            delta_notes.append(f"{fb.name}: no stable id match")
            continue
        issue = issue_by_id(data, iid)
        if not issue:
            delta_notes.append(f"{fb.name}: unknown id {iid}")
            continue
        issue["last_seen_run"] = run_id
        if issue.get("status") == "open":
            issue["status"] = "in_progress"
        # Resolve fb so we can build a repo-relative path regardless of whether
        # the caller passed an absolute or relative --out-dir.
        try:
            rel_file = str(fb.resolve().relative_to(REPO))
        except ValueError:
            rel_file = str(fb)
        issue.setdefault("evidence", []).append({
            "run_id": run_id,
            "file": rel_file,
            "excerpt": text[:400],
        })
        delta_notes.append(f"matched {iid} from {fb.name}")

    save_registry(registry_path, data)
    queue = [
        {"id": i["id"], "script_path": i.get("script_path")}
        for i in data.get("issues", [])
        if i.get("automation_eligible") and i.get("status") in ("open", "in_progress")
    ]
    return delta_notes, queue


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--scorecard", type=Path, default=None)
    ap.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    args = ap.parse_args()
    notes, queue = synthesize(
        args.run_id,
        args.out_dir,
        scorecard_path=args.scorecard,
        registry_path=args.registry,
    )
    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / "synthesized-delta.md").write_text(
        "# Synthesized delta\n\n" + "\n".join(f"- {n}" for n in notes) + "\n"
    )
    (args.out_dir / "improvement-queue.json").write_text(
        json.dumps({"run_id": args.run_id, "queue": queue}, indent=2) + "\n"
    )
    print(f"[synth] updated {args.registry}; queue={len(queue)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
