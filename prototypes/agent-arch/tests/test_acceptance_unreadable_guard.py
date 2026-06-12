"""Regression: READ_FAILED / chunk-unloaded guard in acceptance._parse_verify_response.

The W1 → W2 trial 1 hit a wheat_capstone failure where Tester verify returned
`observed.unreadable=39` of 81 cells. The guard's first version inspected
`data.unreadable` (flat) but the real path is `data.observed.unreadable`,
so the scorecard recorded `satisfied=False` instead of `evaluable=False`,
flipping the band from pass to partial on a successful trial.

These tests pin the three locations the guard must check.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "prototypes" / "agent-arch"))

from capstone.acceptance import _parse_verify_response  # noqa: E402


def _body(observed_unreadable=None, nested_unreadable=None, flat_unreadable=None,
          observed_satisfied=True, observed_count=80) -> str:
    """Build a verify response envelope mirroring real mc verify shape."""
    body = {
        "ok": True,
        "command": "verify",
        "data": {
            "kind": "region_blocks",
            "satisfied": observed_satisfied,
            "observed": {
                "block": "farmland",
                "count": observed_count,
                "scanned": 81,
            },
            "expected": {"block": "farmland", "min_count": 72},
        },
    }
    if observed_unreadable is not None:
        body["data"]["observed"]["unreadable"] = observed_unreadable
    if nested_unreadable is not None:
        body["data"]["unreadable"] = nested_unreadable
    if flat_unreadable is not None:
        body["unreadable"] = flat_unreadable
    return json.dumps(body)


def test_observed_unreadable_flips_to_evaluable_false():
    """The real-world shape: data.observed.unreadable > 0."""
    result = _parse_verify_response(_body(observed_unreadable=39), "", 0)
    assert result.evaluable is False
    assert result.satisfied is False


def test_nested_unreadable_flips_to_evaluable_false():
    """Legacy shape: data.unreadable > 0 (pre-observed refactor)."""
    result = _parse_verify_response(_body(nested_unreadable=10), "", 0)
    assert result.evaluable is False


def test_flat_unreadable_flips_to_evaluable_false():
    """Fallback shape: body.unreadable > 0 (older envelope)."""
    result = _parse_verify_response(_body(flat_unreadable=5), "", 0)
    assert result.evaluable is False


def test_zero_unreadable_passes_through():
    """All cells readable → predicate verdict honored."""
    result = _parse_verify_response(_body(observed_unreadable=0), "", 0)
    assert result.evaluable is True
    assert result.satisfied is True


def test_no_unreadable_field_passes_through():
    """Verify response without unreadable key → no guard, honor satisfied."""
    result = _parse_verify_response(_body(), "", 0)
    assert result.evaluable is True
    assert result.satisfied is True


def test_raw_marker_read_failed_flips_to_evaluable_false():
    """Tester error-envelope path: raw_stdout contains READ_FAILED."""
    body = {"ok": True, "data": {"satisfied": False}, "raw_stdout": "ERROR [verify] : READ_FAILED"}
    result = _parse_verify_response(json.dumps(body), "", 0)
    assert result.evaluable is False
