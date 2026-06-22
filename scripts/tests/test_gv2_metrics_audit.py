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
from scripts.lib.gv2_metrics.summary import build_summary, compare_safe  # noqa: E402


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


def _summary(expected, *, ratio=1.0, windowed=True, est=2.5, retro_pending=0, server_down=0):
    return build_summary(
        config={"expected_metrics": expected},
        metrics={
            "audit": {"scope_coverage_ratio": ratio, "scope_windowed": windowed},
            "establishment": {"score": est},
            "motor": {"server_down": server_down},
        },
        retro={"pending": retro_pending, "done": [], "total": 0},
    )


def test_expected_metrics_resolve_dotted_keys_through_build_summary():
    # A selected WorkItem's expected_metrics (dotted keys into the metric tree)
    # must validate at score time — not silently land in `missed` for lack of a flat key.
    expected = {
        "audit.scope_coverage_ratio": {"min": 0.5},
        "audit.scope_windowed": True,
        "compare.compare_safe": True,
        "establishment.score": {"min": 2.0},
    }
    outcome = _summary(expected)["outcome_vs_expected"]
    assert outcome["missed"] == []
    assert len(outcome["met"]) == 4


def test_expected_metrics_dotted_keys_discriminate_failure():
    # Same keys, but a parse-failure run: ratio below floor + compare_safe flips false.
    expected = {
        "audit.scope_coverage_ratio": {"min": 0.5},
        "compare.compare_safe": True,
    }
    outcome = _summary(expected, ratio=0.2)["outcome_vs_expected"]
    assert any("scope_coverage_ratio" in m for m in outcome["missed"])
    assert any("compare.compare_safe" in m for m in outcome["missed"])
