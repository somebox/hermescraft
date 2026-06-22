"""Run smoke status for scorecard operational block (subprocess wrapper)."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SMOKE = REPO / "scripts" / "genesis-v2-verify-smoke.sh"


def smoke_status_for_run(run_root: Path, *, timeout_s: int = 120) -> str | None:
    if not SMOKE.is_file():
        return None
    try:
        proc = subprocess.run(
            ["bash", str(SMOKE), "--run-dir", str(run_root.resolve())],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            cwd=REPO,
        )
        text = (proc.stdout or "") + (proc.stderr or "")
        m = re.search(r"result:\s*(PASS|WARN|FAIL)", text)
        if m:
            return m.group(1)
        if proc.returncode == 0:
            return "PASS"
        if proc.returncode == 10:
            return "WARN"
        if proc.returncode == 20:
            return "FAIL"
    except (OSError, subprocess.TimeoutExpired):
        return None
    return None
