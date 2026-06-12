"""Synthesizer match rules (offline)."""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]


def test_synthesize_updates_registry(tmp_path):
    fb = tmp_path / "feedback-farmer.md"
    fb.write_text("- Had to re-survey the same 16x16 plot twice.\n")
    reg = REPO / "data/postmortems/wheat-capstone/_known_issues.json"
    before = json.loads(reg.read_text())
    proc = subprocess.run(
        [
            "python3",
            str(REPO / "scripts/synthesize-trial-feedback.py"),
            "--run-id",
            "w2-test-synth",
            "--out-dir",
            str(tmp_path),
        ],
        cwd=str(REPO),
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
    after = json.loads(reg.read_text())
    issue = next(i for i in after["issues"] if i["id"] == "W2-AUTO-003")
    assert issue["last_seen_run"] == "w2-test-synth"
    assert any(e["run_id"] == "w2-test-synth" for e in issue.get("evidence", []))
    # restore last_seen to avoid polluting live trials
    for i in after["issues"]:
        for j in before["issues"]:
            if i["id"] == j["id"]:
                i["last_seen_run"] = j.get("last_seen_run")
                if j.get("status") == "open":
                    i["status"] = "open"
                i["evidence"] = j.get("evidence", [])
    reg.write_text(json.dumps(after, indent=2) + "\n")
