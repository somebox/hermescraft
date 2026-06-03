"""Phase 10 PR-R Bench L — card-body linter parser tests.

Pure-function tests over `scripts.lib.card_body_linter.lint_card_body`. No
subprocess, no DB, no LLM. ~10s wallclock for the whole suite.

The linter's job is to catch malformed CONSTRUCT/MINE/TILL/SUPPLY/SURVEY
cards before they enter `ready` (and reach a worker). Bench L pins the
rule shape so future SOUL/skill changes don't accidentally widen the
prose loophole.
"""
from __future__ import annotations

import unittest

from scripts.lib.card_body_linter import (
    VERB_REQUIRED_KINDS,
    count_coord_triples,
    count_verb_lines,
    lint_card_body,
    parse_kind_from_title,
)


# ── parse_kind_from_title ──────────────────────────────────────────────


class ParseKindTitleTest(unittest.TestCase):
    def test_construct(self):
        self.assertEqual(parse_kind_from_title("[CONSTRUCT] Pad 9x9"), "CONSTRUCT")

    def test_explore(self):
        self.assertEqual(parse_kind_from_title("[EXPLORE] NE quadrant"), "EXPLORE")

    def test_no_prefix(self):
        self.assertIsNone(parse_kind_from_title("free-form title"))

    def test_none(self):
        self.assertIsNone(parse_kind_from_title(None))

    def test_lowercase_prefix_normalized(self):
        # We require uppercase in the title regex, but the lint result
        # uppercases the kind for comparison. Lowercase prefix doesn't
        # match the regex pattern, so this returns None.
        self.assertIsNone(parse_kind_from_title("[construct] Pad"))


# ── count_verb_lines / count_coord_triples ─────────────────────────────


class HelperTest(unittest.TestCase):
    def test_count_verb_one(self):
        self.assertEqual(count_verb_lines("mc fill cobblestone 0 0 0 8 8 8"), 1)

    def test_count_verb_multi(self):
        body = "mc fill cobblestone 0 0 0 8 8 8\nmc mark base_foundation\nmc dig 4 4 4"
        self.assertEqual(count_verb_lines(body), 3)

    def test_done_when_not_counted(self):
        body = "Done_when: mc is_sheltered walls=0 0 0 8 8 8 reports walls_complete: true"
        self.assertEqual(count_verb_lines(body), 0)

    def test_done_when_capital_D(self):
        body = "Donewhen: mc is_sheltered reports true"
        # Match without underscore variant too.
        self.assertEqual(count_verb_lines(body), 0)

    def test_comment_line_not_counted(self):
        body = "# mc fill cobblestone 0 0 0 8 8 8"
        self.assertEqual(count_verb_lines(body), 0)

    def test_fenced_block_not_counted(self):
        body = "Example shape:\n```\nmc fill cobblestone 0 0 0 8 8 8\n```\nDescription only."
        self.assertEqual(count_verb_lines(body), 0)

    def test_indented_verb_counts(self):
        body = "    mc collect oak_log 16"
        self.assertEqual(count_verb_lines(body), 1)

    def test_coord_triples_basic(self):
        body = "Mine 32 cobble and deposit at (5,95,24)."
        self.assertEqual(count_coord_triples(body), 1)

    def test_coord_triples_multi(self):
        body = "Visit (10,64,10), (20,64,20), (30,64,30)."
        self.assertEqual(count_coord_triples(body), 3)

    def test_coord_triples_in_verb_lines_count(self):
        # mc verb lines DO contribute to coord_count — they're a coord,
        # just in executable form. Important: this means a 3-coord
        # CONSTRUCT body passes the verb check AND has coord triples.
        body = "mc move 10 64 10\nmc move 20 64 20\nmc move 30 64 30"
        self.assertEqual(count_coord_triples(body), 3)

    def test_coord_triples_fenced_skipped(self):
        body = "```\n(1,2,3) (4,5,6) (7,8,9)\n```\nReal: (10,11,12)"
        self.assertEqual(count_coord_triples(body), 1)


# ── lint_card_body — the headline behaviour ────────────────────────────


class LintConstructTest(unittest.TestCase):
    """CONSTRUCT must have at least one verb line."""

    def test_verb_first_passes(self):
        body = "mc fill cobblestone 15 101 49 23 101 56\nThen mark as base_foundation."
        r = lint_card_body(kind=None, title="[CONSTRUCT] Pad", body=body)
        self.assertTrue(r["ok"], msg=r)
        self.assertEqual(r["kind"], "CONSTRUCT")
        self.assertEqual(r["verb_count"], 1)
        self.assertEqual(r["errors"], [])

    def test_prose_only_fails(self):
        body = "Construct a flat 9x9 cobblestone foundation pad centered at (19,101,52). Level the area first, then fill 9x9 with cobble."
        r = lint_card_body(kind=None, title="[CONSTRUCT] Pad", body=body)
        self.assertFalse(r["ok"])
        self.assertEqual(r["verb_count"], 0)
        self.assertIn("CONSTRUCT", r["errors"][0])

    def test_done_when_only_fails(self):
        # A body whose only mc reference is Done_when: doesn't count.
        body = "Build a 9x9 pad. Done_when: mc is_sheltered walls=15 101 49 23 101 56 reports walls_complete: true."
        r = lint_card_body(kind=None, title="[CONSTRUCT] Pad", body=body)
        self.assertFalse(r["ok"])

    def test_fenced_verb_doesnt_count(self):
        body = "Example:\n```\nmc fill cobblestone 0 0 0 8 8 8\n```\nReal work TBD."
        r = lint_card_body(kind=None, title="[CONSTRUCT] Pad", body=body)
        self.assertFalse(r["ok"])

    def test_explicit_kind_overrides_title(self):
        body = "mc fill cobblestone 0 0 0 8 8 8"
        r = lint_card_body(kind="SUPPLY", title="free-form", body=body)
        self.assertTrue(r["ok"])
        self.assertEqual(r["kind"], "SUPPLY")


class LintSupplyMineFamilyTest(unittest.TestCase):
    """SUPPLY/MINE/TILL follow the same rule as CONSTRUCT."""

    def test_supply_verb_first_passes(self):
        body = "mc collect cobblestone 32\nmc deposit cobblestone 32 at se_shelter"
        r = lint_card_body(kind=None, title="[SUPPLY] 32 cobble for pad", body=body)
        self.assertTrue(r["ok"])

    def test_supply_prose_only_fails(self):
        body = "Gather 32 cobble and bring to base."
        r = lint_card_body(kind=None, title="[SUPPLY] 32 cobble", body=body)
        self.assertFalse(r["ok"])

    def test_mine_prose_only_fails(self):
        body = "Mine iron ore from lt_iron_se."
        r = lint_card_body(kind=None, title="[MINE] Iron from lt_iron_se", body=body)
        self.assertFalse(r["ok"])

    def test_till_prose_only_fails(self):
        body = "Till a 9x9 wheat plot."
        r = lint_card_body(kind=None, title="[TILL] 9x9 wheat plot", body=body)
        self.assertFalse(r["ok"])


class LintSurveyTest(unittest.TestCase):
    """SURVEY MUST have a verb — run-6 evidence: Mason abandoned a prose
    SURVEY mid-way through because the body didn't tell her HOW to evaluate
    each candidate."""

    def test_survey_prose_only_fails(self):
        body = "Evaluate the top 5 pad candidates and recommend one as base_anchor."
        r = lint_card_body(kind=None, title="[SURVEY] Evaluate pad candidates", body=body)
        self.assertFalse(r["ok"])
        self.assertIn("SURVEY", r["errors"][0])

    def test_survey_with_verb_passes(self):
        body = "mc verify_plot 15 49 23 56 --worksite pad --expect-y 101\nThen comment recommendation."
        r = lint_card_body(kind=None, title="[SURVEY] Evaluate pad", body=body)
        self.assertTrue(r["ok"])


class LintScoutTest(unittest.TestCase):
    """SCOUT bodies are prose-led by default; only require verb lines
    when the body cites ≥3 coord targets (multi-waypoint)."""

    def test_single_coord_scout_passes(self):
        body = "Scout the NE quadrant from muster (4,96,24) and mark candidate pads."
        r = lint_card_body(kind=None, title="[SCOUT] NE quadrant", body=body)
        self.assertTrue(r["ok"])
        self.assertEqual(r["coord_count"], 1)

    def test_two_coord_scout_passes(self):
        body = "Verify resource availability near top candidates (10,64,10), (20,64,20)."
        r = lint_card_body(kind=None, title="[SCOUT] Verify resources", body=body)
        self.assertTrue(r["ok"])

    def test_three_coord_scout_fails_without_verb(self):
        body = "Verify resources at (10,64,10), (20,64,20), (30,64,30) and report."
        r = lint_card_body(kind=None, title="[SCOUT] Verify resources", body=body)
        self.assertFalse(r["ok"])
        self.assertEqual(r["coord_count"], 3)
        self.assertIn("3 coord triples", r["errors"][0])

    def test_three_coord_scout_with_verbs_passes(self):
        body = (
            "Verify resources at three sites.\n"
            "mc move 10 64 10\nmc nearby 20 64 20\nmc move 30 64 30"
        )
        r = lint_card_body(kind=None, title="[SCOUT] Verify resources", body=body)
        self.assertTrue(r["ok"])


class LintExploreTest(unittest.TestCase):
    """EXPLORE bodies are intentionally prose-led."""

    def test_prose_explore_passes(self):
        body = "Patrol NE quadrant with max radius 30, mark candidate pads."
        r = lint_card_body(kind=None, title="[EXPLORE] NE", body=body)
        self.assertTrue(r["ok"])


class LintMisselaneousTest(unittest.TestCase):
    def test_no_kind_advisory(self):
        # No `[KIND]` prefix → linter passes but with an advisory warning.
        r = lint_card_body(kind=None, title="free-form title", body="some text")
        self.assertTrue(r["ok"])
        self.assertGreater(len(r["warnings"]), 0)

    def test_other_kinds_unaffected(self):
        # FIX, BUG, EPIC, SITE, RESCUE, CLEANUP are not verb-required.
        for kind in ("FIX", "BUG", "EPIC", "SITE", "RESCUE", "CLEANUP"):
            body = "prose body only"
            r = lint_card_body(kind=None, title=f"[{kind}] Some task", body=body)
            self.assertTrue(r["ok"], msg=f"{kind} should pass: {r}")

    def test_empty_body(self):
        # Empty body fails verb-required kinds.
        r = lint_card_body(kind=None, title="[CONSTRUCT] vague", body="")
        self.assertFalse(r["ok"])
        # Empty body passes EXPLORE.
        r = lint_card_body(kind=None, title="[EXPLORE] vague", body="")
        self.assertTrue(r["ok"])

    def test_verb_required_kinds_constant_locked(self):
        # Sanity check the constant matches the rule documented in the plan.
        self.assertEqual(
            VERB_REQUIRED_KINDS,
            frozenset({"CONSTRUCT", "MINE", "TILL", "SUPPLY", "SURVEY"}),
        )


# ── run-6 regression cases — actual cards that failed in phase9 ────────


class Run6RegressionTest(unittest.TestCase):
    """Lock in detection on the specific run-6 cards that the worker
    side couldn't escalate. These are the dispositive Phase 9 evidence
    for why PR-R must live at dispatch, not worker."""

    def test_run6_pad_card_t_174de3c0_would_fail(self):
        # Run-5 t_174de3c0 (prose pad — recurred shape in run-6 SURVEY).
        # Mason hit iteration_budget_exhausted with 0 mc fill calls.
        body = (
            "Construct a flat 9x9 cobblestone foundation pad centered at (19,101,52). "
            "Needs 81+ cobblestone. Level the area first, then fill 9x9 with cobble. "
            "Gatherer may have cobble stockpile at se_shelter chest. Mark finished "
            "pad as base_foundation."
        )
        r = lint_card_body(kind=None, title="[CONSTRUCT] Pad 9x9 cobble", body=body)
        self.assertFalse(r["ok"], msg="run-5/6 prose pad must fail the linter")

    def test_run6_survey_card_t_cefd4f35_would_fail(self):
        # Run-6 t_cefd4f35 SURVEY — Mason abandoned at 2/5 candidates.
        body = (
            "Evaluate top pad candidates for base_anchor selection. Visit each "
            "candidate, check 9x9 flatness and surface material, comment your "
            "recommendation. Decision criteria: flatness, proximity to resources, "
            "exposure to mobs (none in peaceful), water adjacency."
        )
        r = lint_card_body(kind=None, title="[SURVEY] Evaluate top pad candidates", body=body)
        self.assertFalse(r["ok"], msg="run-6 prose SURVEY must fail the linter")

    def test_run6_verify_resources_t_1d175784_would_fail(self):
        # Run-6 t_1d175784 — the crash-loop verify-resources card.
        body = (
            "Verify resource availability near top pad candidates at (10,101,40), "
            "(20,101,52), (15,103,55). Check for oak, stone, iron within radius 32 "
            "of each. Report findings via comment."
        )
        r = lint_card_body(kind=None, title="[SCOUT] Verify resource availability near top pad candidates", body=body)
        self.assertFalse(r["ok"], msg="run-6 multi-coord prose SCOUT must fail")


if __name__ == "__main__":
    unittest.main()
