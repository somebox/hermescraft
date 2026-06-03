"""Tests for scripts/analyze-worker-trace.py."""
from __future__ import annotations

import importlib.util
import sys
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
POSTMORTEM = REPO / "data" / "postmortems" / "establish-2026-06-02-phase6-run2"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "trace_pad_snippet.log"

HIGH_FRICTION = [
    "t_6f3ad052.log",
    "t_9375fb8d.log",
    "t_c7609d99.log",
    "t_e1d16918.log",
    "t_4c63c859.log",
]


def _load_analyzer():
    path = REPO / "scripts" / "analyze-worker-trace.py"
    loader = SourceFileLoader("analyze_worker_trace", str(path))
    spec = importlib.util.spec_from_loader("analyze_worker_trace", loader)
    assert spec
    mod = importlib.util.module_from_spec(spec)
    sys.modules["analyze_worker_trace"] = mod
    loader.exec_module(mod)
    return mod


class TestAnalyzeWorkerTrace(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.az = _load_analyzer()

    def test_fixture_snippet_counts(self):
        text = FIXTURE.read_text(encoding="utf-8")
        r = self.az.parse_trace_text(text, "fixture")
        self.assertEqual(r["invocations"], 6)
        self.assertEqual(r["error_invocations"], 3)
        self.assertEqual(r["errors_by_verb"]["fill"], 2)
        self.assertEqual(r["errors_by_verb"]["move"], 1)

    def test_high_friction_corpus_totals(self):
        paths = [POSTMORTEM / name for name in HIGH_FRICTION]
        missing = [p for p in paths if not p.is_file()]
        if missing:
            self.skipTest(f"postmortem logs missing: {missing}")
        summary = self.az.analyze_paths(paths)
        # Corpus: five high-friction cards in establish-2026-06-02-phase6-run2.
        # Counts every mc verb on terminal lines tagged [error], including `cd … && mc …`.
        # SUMMARY.md "154 / 80 move" undercounted chained workspace prefixes.
        self.assertEqual(summary["error_invocations"], 190)
        self.assertEqual(summary["errors_by_verb"].get("move", 0), 92)
        per = {c["card_id"]: c["errors_by_verb"].get("move", 0) for c in summary["per_card"]}
        self.assertEqual(
            per,
            {
                "t_6f3ad052": 17,
                "t_9375fb8d": 26,
                "t_c7609d99": 24,
                "t_e1d16918": 14,
                "t_4c63c859": 11,
            },
        )


if __name__ == "__main__":
    unittest.main()
