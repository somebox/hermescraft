"""Offline tests for the genesis-v2 audit metric + compare_safe gate.

Regression cover for gv2-2026-06-21-7: scope_coverage_ratio used to be
kept/(kept+dropped_out_of_window), which trended toward 0 as the append-only
actions-<body>.jsonl accumulated prior-run history (measured 0.008), wrongly
failing the G0 gate and forcing compare_safe=false on a healthy run.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from scripts.lib.gv2_metrics.audit import extract_audit  # noqa: E402
from scripts.lib.gv2_metrics.summary import compare_safe  # noqa: E402


def _scope(tmp_path: Path, files: dict, windowed: bool = True) -> Path:
    p = tmp_path / "action-log-scope.json"
    p.write_text(json.dumps({"windowed": windowed, "files": files}))
    return p


def test_ratio_is_invariant_to_accumulated_prior_run_history(tmp_path):
    # A healthy run whose durable logs carry tons of out-of-window history from
    # earlier runs must still score ~1.0 — those rows parsed fine, they just
    # belong to other runs. (The 0.008 bug lived here.)
    sp = _scope(
        tmp_path,
        {
            "actions-Mox.jsonl": {"kept": 197, "dropped_out_of_window": 11858, "dropped_bad_ts": 0, "total": 12055},
            "actions-Zee.jsonl": {"kept": 0, "dropped_out_of_window": 7232, "dropped_bad_ts": 0, "total": 7232},
        },
    )
    audit = extract_audit(tmp_path, sp)
    assert audit["scope_coverage_ratio"] == 1.0
    assert audit["scope_windowed"] is True
    assert audit["scope_kept"] == 197


def test_ratio_drops_only_on_unparseable_timestamps(tmp_path):
    # Coverage should fall when rows can't be attributed to a window via a usable
    # timestamp — that's the real auditability failure worth gating on.
    sp = _scope(
        tmp_path,
        {"actions-Mox.jsonl": {"kept": 1, "dropped_out_of_window": 1, "dropped_bad_ts": 8, "total": 10}},
    )
    audit = extract_audit(tmp_path, sp)
    assert audit["scope_coverage_ratio"] == 0.2  # (1+1)/10


def test_missing_scope_file_yields_none_ratio_and_not_windowed(tmp_path):
    audit = extract_audit(tmp_path, tmp_path / "absent.json")
    assert audit["scope_coverage_ratio"] is None
    assert audit["scope_windowed"] is False
    assert audit["scope_kept"] == 0


def test_compare_safe_true_for_windowed_clean_run():
    audit = {"scope_coverage_ratio": 1.0, "scope_windowed": True}
    assert compare_safe({"server_down": 0}, 0, audit) is True


def test_compare_safe_false_when_not_windowed_even_if_ratio_high():
    # Verbatim capture (windowing disabled) poisons cross-run counts — the old
    # ratio masked this because dropped_out_of_window was then 0.
    audit = {"scope_coverage_ratio": 1.0, "scope_windowed": False}
    assert compare_safe({"server_down": 0}, 0, audit) is False


def test_compare_safe_false_on_bad_timestamp_ratio():
    audit = {"scope_coverage_ratio": 0.2, "scope_windowed": True}
    assert compare_safe({"server_down": 0}, 0, audit) is False


def test_compare_safe_unaffected_when_no_scope_data():
    # No scope file => ratio None => the audit clause must not gate.
    assert compare_safe({"server_down": 0}, 0, {"scope_coverage_ratio": None, "scope_windowed": False}) is True


def test_compare_safe_still_fails_on_retro_pending_and_server_down():
    good = {"scope_coverage_ratio": 1.0, "scope_windowed": True}
    assert compare_safe({"server_down": 0}, 1, good) is False
    assert compare_safe({"server_down": 2}, 0, good) is False
