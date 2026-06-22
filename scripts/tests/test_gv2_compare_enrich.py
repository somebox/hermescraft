"""Tests for compare enrichment and run metadata helpers."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "scripts"))

import genesis2_lib as g2  # noqa: E402
from scripts.lib.gv2_fleet_index import update_fleet_artifacts  # noqa: E402
from scripts.lib.gv2_metrics.compare_enrich import (  # noqa: E402
    diff_scorecards,
    enrich_compare,
)


class TestCompareEnrich(unittest.TestCase):
    def test_diff_scorecards(self):
        prev = {
            "summary": {
                "overall": 40,
                "achievement": {"establishment_score": 3},
                "operational": {"wall_min": 10, "motor_errors_scoped": 2},
                "achievement_level": {"current": "G1"},
            }
        }
        cur = {
            "summary": {
                "overall": 55,
                "achievement": {"establishment_score": 5},
                "operational": {"wall_min": 12, "motor_errors_scoped": 1},
                "achievement_level": {"current": "G2"},
            }
        }
        d = diff_scorecards(prev, cur)
        self.assertEqual(d["overall_delta"], 15)
        self.assertEqual(d["establishment_delta"], 2)
        self.assertEqual(d["level_prev"], "G1")
        self.assertEqual(d["level_current"], "G2")

    def test_enrich_compare_with_prev_scorecard(self):
        with tempfile.TemporaryDirectory() as tmp:
            runs = Path(tmp)
            prev_id, cur_id = "gv2-2099-01-01-1", "gv2-2099-01-01-2"
            for rid, overall, est in ((prev_id, 42, 3), (cur_id, 55, 5)):
                rd = runs / rid
                rd.mkdir()
                (rd / "config.json").write_text(json.dumps({"run_id": rid}) + "\n")
                (rd / "scorecard.json").write_text(
                    json.dumps(
                        {
                            "run_id": rid,
                            "summary": {
                                "overall": overall,
                                "achievement": {"establishment_score": est},
                                "operational": {},
                                "achievement_level": {"current": "G2"},
                            },
                        }
                    )
                    + "\n"
                )
            summary = {
                "compare": {"compare_safe": True},
                "overall": 50,
                "achievement": {"establishment_score": 5},
                "operational": {},
            }
            config = {
                "run_id": cur_id,
                "prev_run_id": prev_id,
                "repo_rev_at_start": "aaa",
                "repo_rev_at_stop": "aaa",
            }
            enrich_compare(
                config=config,
                summary=summary,
                run_root=runs / cur_id,
                repo_root=REPO,
                achievement_level={"current": "G2", "gaps": []},
            )
            self.assertEqual(summary["compare"]["overall_delta_vs_prev"], 13)
            self.assertEqual(summary["overall"], 55)
            self.assertIn("G2", summary["headline"])

    def test_fleet_index_skips_global_index_outside_runs_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_root = Path(tmp) / "fixture-run"
            run_root.mkdir()
            sc = {
                "run_id": "fixture-run",
                "summary": {
                    "overall": 28,
                    "compare": {"compare_safe": True},
                    "achievement_level": {"current": "G0"},
                },
            }
            update_fleet_artifacts(run_root, sc)
            self.assertTrue((run_root / "run-nav.json").is_file())
            self.assertFalse((Path(tmp) / "_index.json").is_file())

    def test_previous_run_id_ordering(self):
        with tempfile.TemporaryDirectory() as tmp:
            orig = g2.RUNS_ROOT
            try:
                g2.RUNS_ROOT = Path(tmp)
                (Path(tmp) / "gv2-2099-06-01-1").mkdir()
                (Path(tmp) / "gv2-2099-06-01-2").mkdir()
                (Path(tmp) / "gv2-2099-06-01-3").mkdir()
                self.assertEqual(g2.previous_run_id("gv2-2099-06-01-3"), "gv2-2099-06-01-2")
                self.assertEqual(g2.previous_run_id("gv2-2099-06-01-1"), None)
            finally:
                g2.RUNS_ROOT = orig


    def test_dotted_expected_metrics(self):
        from scripts.lib.gv2_metrics.summary import evaluate_expected_metrics

        ctx = {"compare": {"compare_safe": True}, "audit": {"scope_windowed": True}}
        out = evaluate_expected_metrics(
            {"compare.compare_safe": True, "audit.scope_windowed": True},
            {},
            context=ctx,
        )
        self.assertEqual(out["missed"], [])

    def test_fleet_index_updates_runs_root_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            orig = g2.RUNS_ROOT
            try:
                g2.RUNS_ROOT = Path(tmp)
                run_id = "gv2-2099-12-01-1"
                run_root = g2.run_dir(run_id)
                (run_root / "config.json").write_text(json.dumps({"run_id": run_id, "spawn": {"x": 0}}) + "\n")
                sc = {
                    "run_id": run_id,
                    "summary": {
                        "overall": 55,
                        "compare": {"compare_safe": True, "prev_run_id": None},
                        "achievement_level": {"current": "G2"},
                    },
                }
                update_fleet_artifacts(run_root, sc)
                idx = json.loads((Path(tmp) / "_index.json").read_text())
                self.assertEqual(len(idx["runs"]), 1)
                self.assertEqual(idx["runs"][0]["run_id"], run_id)
                self.assertTrue((Path(tmp) / "_index" / "index.html").is_file())
            finally:
                g2.RUNS_ROOT = orig


if __name__ == "__main__":
    unittest.main()
