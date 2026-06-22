"""Tests for gv2-extract-template-deltas.py."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "gv2-extract-template-deltas.py"


def test_extract_tags_from_retro_body(tmp_path):
    run_dir = tmp_path / "gv2-test"
    art = run_dir / "artifacts"
    art.mkdir(parents=True)
    (run_dir / "feedback-bundle.json").write_text(
        json.dumps(
            {
                "run_id": "gv2-test",
                "retro_cards": [
                    {
                        "task_id": "t_r1",
                        "assignee": "colony-builder",
                        "body": "TEMPLATE_PATCH: base-layer-construct add apron drain step\n",
                    }
                ],
            }
        )
    )
    changelog = tmp_path / "changelog.jsonl"
    p = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--run-id",
            "gv2-test",
            "--run-dir",
            str(run_dir),
            "--changelog",
            str(changelog),
        ],
        cwd=REPO,
        capture_output=True,
        text=True,
        check=True,
    )
    payload = json.loads(p.stdout)
    assert payload["extracted"] == 1
    assert payload["appended"] == 1
    lines = changelog.read_text().strip().splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert rec["tag"] == "TEMPLATE_PATCH"
    assert "base-layer-construct" in rec["payload"]
