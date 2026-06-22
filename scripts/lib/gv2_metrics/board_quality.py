from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from scripts.lib.gv2_card_validator import validate_board_tasks  # noqa: E402


def extract_board_quality(board: list[dict]) -> dict:
    v = validate_board_tasks(board)
    return {
        "gv2_invalid": v["invalid_count"],
        "checked": v["checked"],
        "ok": v["ok"],
    }
