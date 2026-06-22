from __future__ import annotations

import json
from pathlib import Path

from scripts.lib.gv2_establishment_ladder import evaluate_run_dir


def extract_establishment(run_root: Path) -> dict:
    return evaluate_run_dir(run_root)
