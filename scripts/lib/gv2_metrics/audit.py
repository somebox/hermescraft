from __future__ import annotations

import json
from pathlib import Path


def extract_audit(run_root: Path, scope_path: Path | None) -> dict:
    scope = {}
    if scope_path and scope_path.is_file():
        scope = json.loads(scope_path.read_text())
    windowed = bool(scope.get("windowed"))
    files = scope.get("files") or {}
    kept = sum((f.get("kept") or 0) for f in files.values() if isinstance(f, dict))
    out_of_window = sum((f.get("dropped_out_of_window") or 0) for f in files.values() if isinstance(f, dict))
    bad_ts = sum((f.get("dropped_bad_ts") or 0) for f in files.values() if isinstance(f, dict))
    # scope_coverage_ratio = timestamp-parse health, NOT kept/all-history. The durable
    # actions-<body>.jsonl is append-only across EVERY run, so `dropped_out_of_window`
    # is dominated by prior runs and grows without bound — putting it in the denominator
    # made the ratio trend toward 0 regardless of THIS run's quality (gv2-2026-06-21-7
    # measured 0.008 with 233 kept vs 30731 historical rows). What the audit gate should
    # assert is that scoping was auditable: every row was attributable to a run window via
    # a parseable timestamp. Coverage = rows-with-usable-ts / all-rows-seen; out-of-window
    # rows still parsed cleanly, so they count as covered. Windowing correctness is a
    # separate signal (`scope_windowed`), gated independently.
    parseable = kept + out_of_window
    total_seen = parseable + bad_ts
    ratio = round(parseable / total_seen, 3) if total_seen else None
    return {
        "scope_coverage_ratio": ratio,
        "scope_windowed": windowed,
        "scope_kept": kept,
    }
