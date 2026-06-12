"""Promote path-prefix gate."""

from __future__ import annotations

import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]


def test_plot_verifier_rejects_hardcoded_coords(tmp_path):
    bad = tmp_path / "bad.sh"
    bad.write_text("echo -50,64,50\n")
    proc = subprocess.run(
        [str(REPO / "scripts/w2-verify-plot-script.sh"), str(bad)],
        capture_output=True,
        text=True,
    )
    assert proc.returncode != 0


def test_plot_verifier_accepts_marks_api(tmp_path):
    good = tmp_path / "good.sh"
    good.write_text("#!/bin/bash\nmc marks\n")
    proc = subprocess.run(
        [str(REPO / "scripts/w2-verify-plot-script.sh"), str(good)],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
