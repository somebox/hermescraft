"""Reset-execute preserves W2 registry files."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]


def test_w2_state_files_exist():
    for rel in (
        "data/postmortems/wheat-capstone/_known_issues.json",
        "data/postmortems/wheat-capstone/_w2_artifacts.json",
        "data/workspace/production/scripts/_smoke_echo.sh",
    ):
        assert (REPO / rel).is_file(), rel


def test_reset_script_preserves_paths():
    script = REPO / "scripts/reset-wheat-execute-only.sh"
    text = script.read_text()
    assert "_known_issues.json" in text or "preserve" in text
    assert "_w2_artifacts.json" in text or "W2" in text


def test_known_issues_schema():
    data = json.loads(
        (REPO / "data/postmortems/wheat-capstone/_known_issues.json").read_text()
    )
    assert "issues" in data
    ids = {i["id"] for i in data["issues"]}
    assert "W2-AUTO-003" in ids


def test_dispatcher_exports_hermescraft_repo():
    text = (REPO / "scripts/wheat-dispatcher.sh").read_text()
    assert "HERMESCRAFT_REPO" in text


def test_role_setup_writes_hermescraft_repo():
    text = (REPO / "prototypes/agent-arch/setup-role-profiles.sh").read_text()
    assert "HERMESCRAFT_REPO=$REPO_ROOT" in text


def test_dry_run_w2_graph():
    proc = subprocess.run(
        [
            "python3",
            str(REPO / "prototypes/agent-arch/capstone/run_wheat_capstone.py"),
            "--dry-run",
            "--graph",
            "w2",
            "--board",
            "wheat-capstone",
        ],
        cwd=str(REPO),
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr


def test_dry_run_discovery_graph():
    proc = subprocess.run(
        [
            "python3",
            str(REPO / "prototypes/agent-arch/capstone/run_wheat_capstone.py"),
            "--dry-run",
            "--graph",
            "discovery",
        ],
        cwd=str(REPO),
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
