"""Phase 10 PR-K Bench B — `wb context` side-effects the task-body-coord stash.

Run-6 (phase9) proved that `wb stash-coord` as a SOUL-bullet got 0/4 adoption
across workers. PR-K moves the stash from a separate command into a side
effect of `wb context`, which workers already call on every claim. These
tests cover:

  - title-kind filter (CONSTRUCT/MINE/TILL/SUPPLY/SURVEY stash; EXPLORE/SCOUT skip)
  - verb-line coord extraction priority (fill > place > goto > prose fallback)
  - close/block/escalate clear the stash so the next card doesn't inherit
  - HERMES_HOME unset → silent no-op (running outside a worker shell)
  - context call with no extractable coord clears prior stash

The tests load `scripts/wb` directly via SourceFileLoader since it has no
`.py` extension. They use a tmpdir as `$HERMES_HOME` and a stubbed
`_build_context` to avoid touching the live kanban DB.
"""
from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path
from unittest.mock import patch


def _load_wb():
    here = Path(__file__).resolve().parents[1] / "wb"
    loader = SourceFileLoader("wb_under_test", str(here))
    spec = importlib.util.spec_from_loader("wb_under_test", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


wb = _load_wb()


class CardShouldStashTest(unittest.TestCase):
    """Title-kind filter."""

    def test_construct_stashes(self):
        self.assertTrue(wb._card_should_stash("[CONSTRUCT] Pad 9x9 cobble at base_anchor"))

    def test_supply_stashes(self):
        self.assertTrue(wb._card_should_stash("[SUPPLY] 48 cobble for walls"))

    def test_survey_stashes(self):
        self.assertTrue(wb._card_should_stash("[SURVEY] Evaluate top pad candidates"))

    def test_mine_stashes(self):
        self.assertTrue(wb._card_should_stash("[MINE] Iron ore from lt_iron_se"))

    def test_till_stashes(self):
        self.assertTrue(wb._card_should_stash("[TILL] 9x9 wheat plot at base_anchor"))

    def test_explore_skips(self):
        # EXPLORE bodies are prose-led and don't have a single build target.
        self.assertFalse(wb._card_should_stash("[EXPLORE] NE quadrant from muster"))

    def test_scout_skips(self):
        self.assertFalse(wb._card_should_stash("[SCOUT] Scout candidate pad sites in NW"))

    def test_no_prefix_skips(self):
        self.assertFalse(wb._card_should_stash("free-form title"))

    def test_none_skips(self):
        self.assertFalse(wb._card_should_stash(None))


class StashSideEffectTest(unittest.TestCase):
    """End-to-end: side effect writes to $HERMES_HOME/task-body-coord.json
    when the card kind + body warrant it."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        self._env_patch = patch.dict(os.environ, {"HERMES_HOME": str(self.home)})
        self._env_patch.start()

    def tearDown(self):
        self._env_patch.stop()
        self._tmp.cleanup()

    def _ctx(self, title: str, body: str) -> dict:
        return {"card": {"title": title, "body": body}}

    def _stash_file(self) -> Path:
        return self.home / "task-body-coord.json"

    def test_construct_verb_first_body_stashes_box_center(self):
        ctx = self._ctx(
            "[CONSTRUCT] Pad",
            "mc fill cobblestone 15 101 49 23 101 56\nThen mark as base_foundation.",
        )
        coord = wb._stash_card_coord_side_effect("t_abc", ctx)
        self.assertEqual(coord, {"x": 19, "y": 101, "z": 52})
        payload = json.loads(self._stash_file().read_text())
        self.assertEqual(payload["task_id"], "t_abc")
        self.assertEqual(payload["coord"], {"x": 19, "y": 101, "z": 52})

    def test_supply_prose_body_falls_back_to_first_triple(self):
        ctx = self._ctx(
            "[SUPPLY] 32 cobble for pad",
            "Mine 32 cobble and deposit at (5,95,24).",
        )
        coord = wb._stash_card_coord_side_effect("t_def", ctx)
        # Prose fallback picks the first triple.
        self.assertEqual(coord, {"x": 5, "y": 95, "z": 24})
        self.assertTrue(self._stash_file().exists())

    def test_explore_card_no_stash_no_file(self):
        ctx = self._ctx(
            "[EXPLORE] NE quadrant",
            "Patrol the NE quadrant with max radius 30.",
        )
        coord = wb._stash_card_coord_side_effect("t_explore", ctx)
        self.assertIsNone(coord)
        self.assertFalse(self._stash_file().exists())

    def test_scout_card_no_stash_no_file(self):
        ctx = self._ctx(
            "[SCOUT] Scout candidate pad sites in NE",
            "Scout the NE quadrant for pad candidates and mark them lt_*.",
        )
        coord = wb._stash_card_coord_side_effect("t_scout", ctx)
        self.assertIsNone(coord)
        self.assertFalse(self._stash_file().exists())

    def test_construct_body_with_no_extractable_coord_clears_prior_stash(self):
        # Seed a prior stash from a different card.
        self._stash_file().write_text(json.dumps({"task_id": "t_prior", "coord": {"x": 0, "y": 0, "z": 0}}))
        self.assertTrue(self._stash_file().exists())
        ctx = self._ctx(
            "[CONSTRUCT] vague",
            "Build something somewhere — Steward will fill in details.",
        )
        coord = wb._stash_card_coord_side_effect("t_new", ctx)
        self.assertIsNone(coord)
        # Prior stash cleared so drift detection doesn't fire on the wrong card.
        self.assertFalse(self._stash_file().exists())

    def test_explore_does_NOT_clear_prior_stash(self):
        # If a CONSTRUCT card was active and now an EXPLORE check happens,
        # we should leave the existing stash alone — EXPLORE isn't a stash
        # kind, but the prior CONSTRUCT may still be relevant. Close/block/
        # escalate are the explicit clear paths.
        self._stash_file().write_text(json.dumps({"task_id": "t_construct", "coord": {"x": 19, "y": 101, "z": 52}}))
        ctx = self._ctx(
            "[EXPLORE] NE",
            "Patrol the NE quadrant.",
        )
        wb._stash_card_coord_side_effect("t_explore", ctx)
        # Stash unchanged.
        payload = json.loads(self._stash_file().read_text())
        self.assertEqual(payload["task_id"], "t_construct")

    def test_hermes_home_unset_silent_noop(self):
        with patch.dict(os.environ, {}, clear=False) as _:
            os.environ.pop("HERMES_HOME", None)
            ctx = self._ctx(
                "[CONSTRUCT] Pad",
                "mc fill cobblestone 0 64 0 8 64 8",
            )
            # Must not raise, must not write anywhere.
            coord = wb._stash_card_coord_side_effect("t_no_home", ctx)
            self.assertIsNone(coord)


class ClearStashTest(unittest.TestCase):
    """close/block/escalate clear the stash so the next card doesn't inherit."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        self._env_patch = patch.dict(os.environ, {"HERMES_HOME": str(self.home)})
        self._env_patch.start()

    def tearDown(self):
        self._env_patch.stop()
        self._tmp.cleanup()

    def _stash_file(self) -> Path:
        return self.home / "task-body-coord.json"

    def test_clear_when_present(self):
        self._stash_file().write_text(json.dumps({"task_id": "t_x", "coord": {"x": 1, "y": 2, "z": 3}}))
        self.assertTrue(self._stash_file().exists())
        wb._clear_card_coord_stash()
        self.assertFalse(self._stash_file().exists())

    def test_clear_when_absent_silent(self):
        # Must not raise even when there's no file to remove.
        self.assertFalse(self._stash_file().exists())
        wb._clear_card_coord_stash()  # silent no-op

    def test_clear_when_hermes_home_unset_silent(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("HERMES_HOME", None)
            wb._clear_card_coord_stash()  # silent no-op


class CmdContextSideEffectTest(unittest.TestCase):
    """`cmd_context` integrates the side effect — the high-level invariant
    that workers will actually exercise on every claim."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        self._env_patch = patch.dict(os.environ, {"HERMES_HOME": str(self.home)})
        self._env_patch.start()

    def tearDown(self):
        self._env_patch.stop()
        self._tmp.cleanup()

    def _stash_file(self) -> Path:
        return self.home / "task-body-coord.json"

    def test_cmd_context_writes_stash_on_construct_card(self):
        ctx = {
            "card": {
                "id": "t_abc",
                "title": "[CONSTRUCT] Pad 9x9 cobble",
                "status": "running",
                "assignee": "mason",
                "priority": 0,
                "size": None,
                "location": None,
                "body": "mc fill cobblestone 15 101 49 23 101 56",
            },
            "epic": None,
            "siblings": [],
            "comments": [],
            "bot_pose": None,
            "board": "landfolk-ops",
        }
        # Stub `_build_context` so we don't touch the live kanban DB.
        with patch.object(wb, "_build_context", return_value=ctx):
            with patch.object(wb, "_active_task_id", return_value="t_abc"):
                # Use a minimal argparse.Namespace.
                import argparse
                args = argparse.Namespace(task=None, json=True)
                # cmd_context prints to stdout; capture but don't assert on it here.
                from io import StringIO
                from contextlib import redirect_stdout
                with redirect_stdout(StringIO()):
                    rc = wb.cmd_context(args)
                self.assertEqual(rc, 0)
        # Side effect: stash file exists with the fill-box center.
        self.assertTrue(self._stash_file().exists())
        payload = json.loads(self._stash_file().read_text())
        self.assertEqual(payload["coord"], {"x": 19, "y": 101, "z": 52})


if __name__ == "__main__":
    unittest.main()
