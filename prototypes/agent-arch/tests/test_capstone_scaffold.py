"""Contract tests for the wheat-farm capstone scaffold (Session 5a).

These tests exercise the scaffold's *data shapes* and *authoring
logic* without touching live infrastructure. The live trial
(Session 5b) needs Hermes, bots, a Minecraft world, and an LLM — all
out of scope here.

What we prove with these tests:
  - The default colony graph has the four execute cards in the
    expected topological order, each hand-bound to the same bot.
  - The author injects ``[bot:mox]`` title prefixes that match the
    encoding ``mutex_key.py`` parses (Session 4 symmetry).
  - The author emits parent flags before the title positional, and
    refuses unresolved slugs (catches dispatcher bugs early).
  - The wide baseline collapses the colony bodies into one prompt
    with the union skill set (the architecturally fair control).
  - The acceptance gate refuses to dispatch unsupported predicates
    instead of silently reporting failure — freeze rule made
    mechanical.

Plan: reports/agent-arch/2026-06-06-colony-validation-plan.md
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "prototypes" / "agent-arch"))

from capstone.acceptance import (  # noqa: E402
    SUPPORTED_KINDS,
    AcceptanceResult,
    UnsupportedPredicate,
    evaluate,
)
from capstone.author import (  # noqa: E402
    DEFAULT_TENANT,
    author_colony_lane,
    author_wide_baseline,
    resolve_parents,
    title_with_bot,
)
from capstone.wheat_graph import (  # noqa: E402
    EPIC_BOT,
    PLACES,
    Graph,
    build_default_graph,
    execute_bodies_concatenated,
)
from capstone.wide_baseline import build_wide_baseline  # noqa: E402


# ---------------------------------------------------------------------
# Graph shape
# ---------------------------------------------------------------------

class TestWheatGraph:
    def test_has_four_execute_cards(self) -> None:
        g = build_default_graph()
        assert len(g.cards) == 4
        assert [c.assignee for c in g.cards] == [
            "navigator", "builder", "farmer", "crafter",
        ]

    def test_cards_form_a_chain(self) -> None:
        # Each card after the first depends on its predecessor's slug.
        g = build_default_graph()
        for i in range(1, len(g.cards)):
            assert g.cards[i].depends_on == (g.cards[i - 1].slug,), (
                f"card {g.cards[i].slug} should depend on {g.cards[i - 1].slug}, "
                f"got {g.cards[i].depends_on}"
            )

    def test_all_cards_target_mox(self) -> None:
        # The Card dataclass doesn't carry bot directly; binding is
        # title-encoded by the author. The graph-level invariant is
        # that EPIC_BOT is the single binding for the whole lane.
        assert EPIC_BOT == "mox"

    def test_places_referenced_in_bodies(self) -> None:
        g = build_default_graph()
        farm = PLACES["farm"]
        deposit = PLACES["deposit"]
        farm_cards = [c for c in g.cards if f":{farm}:" in c.body]
        deposit_cards = [c for c in g.cards if f":{deposit}:" in c.body]
        assert len(farm_cards) >= 3  # nav, build, plant
        assert len(deposit_cards) >= 1  # deposit

    def test_acceptance_predicate_is_chest_contains(self) -> None:
        # We deliberately narrowed to what current `mc verify` supports.
        g = build_default_graph()
        assert g.acceptance_predicate is not None
        assert g.acceptance_predicate["kind"] == "chest_contains"
        assert g.acceptance_predicate["mark"] == PLACES["deposit"]
        assert g.acceptance_predicate["item"] == "wheat"


# ---------------------------------------------------------------------
# Authoring (colony lane)
# ---------------------------------------------------------------------

class TestColonyAuthor:
    def test_emits_one_invocation_per_card(self) -> None:
        g = build_default_graph()
        invs = author_colony_lane(g)
        assert len(invs) == len(g.cards)

    def test_title_carries_bot_prefix(self) -> None:
        g = build_default_graph()
        invs = author_colony_lane(g)
        for inv in invs:
            assert inv.title.lower().startswith("[bot:mox]"), inv.title
            # And the title positional in cmd matches.
            assert inv.cmd[-1] == inv.title

    def test_default_tenant_in_cmd(self) -> None:
        g = build_default_graph()
        invs = author_colony_lane(g)
        for inv in invs:
            assert "--tenant" in inv.cmd
            tenant = inv.cmd[inv.cmd.index("--tenant") + 1]
            assert tenant == DEFAULT_TENANT

    def test_each_skill_passed_with_its_own_flag(self) -> None:
        g = build_default_graph()
        invs = author_colony_lane(g)
        first = invs[0]  # navigator card
        skill_count = sum(1 for a in first.cmd if a == "--skill")
        assert skill_count == len(g.cards[0].skills)

    def test_assignee_matches_card(self) -> None:
        g = build_default_graph()
        invs = author_colony_lane(g)
        for inv, card in zip(invs, g.cards):
            assignee_idx = inv.cmd.index("--assignee") + 1
            assert inv.cmd[assignee_idx] == card.assignee

    def test_no_parent_flag_yet(self) -> None:
        # Author records depends_on_slugs but does not inject --parent.
        # That happens at execution time via resolve_parents().
        g = build_default_graph()
        invs = author_colony_lane(g)
        for inv in invs:
            assert "--parent" not in inv.cmd


class TestTitleWithBot:
    def test_adds_prefix(self) -> None:
        assert title_with_bot("mox", "build pad") == "[bot:mox] build pad"

    def test_lowercases_bot(self) -> None:
        assert title_with_bot("MOX", "build pad") == "[bot:mox] build pad"

    def test_idempotent_on_already_tagged(self) -> None:
        # If a title already has a tag, don't double-tag.
        already = "[bot:mox] build pad"
        assert title_with_bot("mox", already) == already


class TestResolveParents:
    def test_no_deps_returns_cmd_unchanged(self) -> None:
        g = build_default_graph()
        invs = author_colony_lane(g)
        assert resolve_parents(invs[0], {}) == invs[0].cmd

    def test_inserts_parent_before_title(self) -> None:
        g = build_default_graph()
        invs = author_colony_lane(g)
        # Second card depends on first's slug x001.
        resolved = resolve_parents(invs[1], {"x001": "real-id-x001"})
        assert "--parent" in resolved
        idx = resolved.index("--parent")
        assert resolved[idx + 1] == "real-id-x001"
        # Title still last.
        assert resolved[-1] == invs[1].title

    def test_unresolved_slug_raises(self) -> None:
        g = build_default_graph()
        invs = author_colony_lane(g)
        with pytest.raises(KeyError):
            resolve_parents(invs[1], {})  # x001 missing


# ---------------------------------------------------------------------
# Wide baseline
# ---------------------------------------------------------------------

class TestWideBaseline:
    def test_body_includes_every_card(self) -> None:
        g = build_default_graph()
        wb = build_wide_baseline(g)
        for card in g.cards:
            # Each card's body must be substring-present in the
            # baseline prompt — same work, same words.
            assert card.body in wb.body

    def test_skill_union_dedupes(self) -> None:
        g = build_default_graph()
        wb = build_wide_baseline(g)
        # Every card's skills are in the union.
        union = set()
        for card in g.cards:
            union.update(card.skills)
        assert set(wb.skills) == union
        # And no dupes in the list itself.
        assert len(wb.skills) == len(set(wb.skills))

    def test_skill_order_preserves_first_seen(self) -> None:
        g = build_default_graph()
        wb = build_wide_baseline(g)
        # The first card's first skill (agent-navigator) must be at
        # the head of the union.
        assert wb.skills[0] == g.cards[0].skills[0]

    def test_acceptance_predicate_identical(self) -> None:
        # Same predicate as the colony lane — fair comparison.
        g = build_default_graph()
        wb = build_wide_baseline(g)
        assert wb.acceptance_predicate == g.acceptance_predicate

    def test_invocation_is_one_card_no_parents(self) -> None:
        g = build_default_graph()
        wb = build_wide_baseline(g)
        inv = author_wide_baseline(wb)
        assert inv.depends_on_slugs == ()
        assert "--parent" not in inv.cmd
        assert inv.cmd[-1] == wb.title


class TestExecuteBodiesConcatenated:
    def test_concatenation_is_stable_order(self) -> None:
        g = build_default_graph()
        concat = execute_bodies_concatenated(g)
        # All four bodies appear, in card order.
        last_idx = -1
        for card in g.cards:
            idx = concat.find(card.body)
            assert idx != -1
            assert idx > last_idx
            last_idx = idx


# ---------------------------------------------------------------------
# Acceptance gate — freeze-rule enforcement
# ---------------------------------------------------------------------

class TestAcceptanceFreezeRule:
    def test_supported_kinds_match_landed_verify_verbs(self) -> None:
        # If this fails, either verify.js grew a new verb (good —
        # extend SUPPORTED_KINDS) or a verb went away (bad — find out
        # why before merging). After Session 5b prep gap 2, the set
        # is {inventory_contains, chest_contains, at_mark, region_blocks}.
        assert SUPPORTED_KINDS == {
            "inventory_contains",
            "chest_contains",
            "at_mark",
            "region_blocks",
        }

    def test_unsupported_kind_raises(self) -> None:
        with pytest.raises(UnsupportedPredicate) as exc:
            evaluate({"kind": "chest_delta", "mark": "storage"})
        assert "chest_delta" in str(exc.value)
        # Helpful error names the supported set.
        assert "inventory_contains" in str(exc.value)


class TestAcceptanceEvaluate:
    """Drive evaluate() against a stubbed `mc` binary on PATH."""

    def _make_mc_stub(self, tmp_path: Path, *, stdout: str, rc: int = 0) -> Path:
        # Write a tiny shell script that prints the canned response.
        stub = tmp_path / "mc"
        stub.write_text(
            "#!/usr/bin/env bash\n"
            f"cat <<'EOF'\n{stdout}\nEOF\n"
            f"exit {rc}\n"
        )
        stub.chmod(0o755)
        return stub

    def test_satisfied_true_when_verify_returns_satisfied(
        self, tmp_path: Path,
    ) -> None:
        stub = self._make_mc_stub(
            tmp_path,
            stdout=json.dumps({"ok": True, "satisfied": True, "count": 16}),
        )
        result = evaluate(
            {"kind": "chest_contains", "mark": "chest_food",
             "item": "wheat", "min_count": 12},
            mc_bin=str(stub),
        )
        assert result.satisfied is True
        assert result.evaluable is True

    def test_satisfied_false_when_predicate_holds_negative(
        self, tmp_path: Path,
    ) -> None:
        stub = self._make_mc_stub(
            tmp_path,
            stdout=json.dumps({"ok": True, "satisfied": False, "count": 3}),
        )
        result = evaluate(
            {"kind": "chest_contains", "mark": "chest_food",
             "item": "wheat", "min_count": 12},
            mc_bin=str(stub),
        )
        assert result.satisfied is False
        assert result.evaluable is True  # we DID evaluate

    def test_not_evaluable_when_ok_false(self, tmp_path: Path) -> None:
        # Bot couldn't reach the chest — distinct from "predicate is
        # false". Plan's confound table cares about this distinction.
        stub = self._make_mc_stub(
            tmp_path,
            stdout=json.dumps({"ok": False, "code": "NOT_ADJACENT"}),
        )
        result = evaluate(
            {"kind": "chest_contains", "mark": "chest_food",
             "item": "wheat", "min_count": 12},
            mc_bin=str(stub),
        )
        assert result.satisfied is False
        assert result.evaluable is False

    def test_non_json_stdout_marked_not_evaluable(
        self, tmp_path: Path,
    ) -> None:
        stub = self._make_mc_stub(tmp_path, stdout="oops not json", rc=1)
        result = evaluate(
            {"kind": "inventory_contains", "item": "wheat"},
            mc_bin=str(stub),
        )
        assert result.satisfied is False
        assert result.evaluable is False


# ---------------------------------------------------------------------
# Multi-predicate acceptance — wheat capstone's all-of evaluation
# ---------------------------------------------------------------------

class TestEvaluateAll:
    """`evaluate_all` runs every predicate, no short-circuit. The
    wheat capstone needs this because the acceptance set is
    (plot, crop, water, sign) — operator wants to know WHICH
    predicate missed when the set fails."""

    def _make_mc_stub(self, tmp_path, *, stdout: str, rc: int = 0):
        stub = tmp_path / "mc"
        stub.write_text(
            "#!/usr/bin/env bash\n"
            f"cat <<'EOF'\n{stdout}\nEOF\n"
            f"exit {rc}\n"
        )
        stub.chmod(0o755)
        return stub

    def test_all_satisfied(self, tmp_path):
        from capstone.acceptance import evaluate_all
        stub = self._make_mc_stub(
            tmp_path,
            stdout=json.dumps({"ok": True, "satisfied": True}),
        )
        out = evaluate_all([
            {"kind": "inventory_contains", "item": "wheat", "min_count": 5},
            {"kind": "chest_contains", "mark": "storage", "item": "wheat", "min_count": 12},
        ], mc_bin=str(stub))
        assert out.satisfied is True
        assert out.evaluable is True
        assert len(out.per_predicate) == 2
        assert all(r.satisfied for r in out.per_predicate)

    def test_one_failure_blocks_set(self, tmp_path):
        # The first call says satisfied; the second predicate also
        # uses the same stub (returns satisfied:true), so we manually
        # check the AcceptanceSet logic by passing a per-predicate
        # mismatch isn't trivial with a single stub. Instead, use a
        # stub that always returns satisfied:false to exercise the
        # all-satisfied gate.
        from capstone.acceptance import evaluate_all
        stub = self._make_mc_stub(
            tmp_path,
            stdout=json.dumps({"ok": True, "satisfied": False}),
        )
        out = evaluate_all([
            {"kind": "inventory_contains", "item": "wheat", "min_count": 5},
        ], mc_bin=str(stub))
        assert out.satisfied is False
        assert out.evaluable is True   # we DID evaluate
        assert len(out.per_predicate) == 1

    def test_unsupported_predicate_records_not_evaluable(self, tmp_path):
        # If a list contains an unsupported predicate kind, the set
        # surfaces it as not-evaluable rather than raising. This lets
        # the operator see the full attribution rather than dying on
        # the first odd entry.
        from capstone.acceptance import evaluate_all
        stub = self._make_mc_stub(
            tmp_path,
            stdout=json.dumps({"ok": True, "satisfied": True}),
        )
        out = evaluate_all([
            {"kind": "inventory_contains", "item": "wheat", "min_count": 5},
            {"kind": "chest_delta", "mark": "storage"},  # not in SUPPORTED_KINDS yet
        ], mc_bin=str(stub))
        assert out.satisfied is False       # second predicate not satisfied
        assert out.evaluable is False       # because second predicate wasn't evaluable
        assert len(out.per_predicate) == 2
        assert out.per_predicate[0].satisfied is True
        assert out.per_predicate[1].evaluable is False
        assert "UnsupportedPredicate" in out.per_predicate[1].detail.get("error", "")

    def test_empty_list_returns_unsatisfied(self, tmp_path):
        from capstone.acceptance import evaluate_all
        out = evaluate_all([])
        assert out.satisfied is False
        assert out.evaluable is False
        assert len(out.per_predicate) == 0


# ---------------------------------------------------------------------
# Wheat graph multi-predicate field
# ---------------------------------------------------------------------

class TestWheatAcceptancePredicates:
    """The wheat graph now exposes BOTH a single
    `acceptance_predicate` (for backward-compat) AND a list
    `acceptance_predicates` (for the all-of wheat capstone gate)."""

    def test_singular_field_still_present(self):
        g = build_default_graph()
        assert g.acceptance_predicate is not None
        assert g.acceptance_predicate["kind"] == "chest_contains"

    def test_plural_field_has_three_predicates(self):
        g = build_default_graph()
        assert g.acceptance_predicates is not None
        assert len(g.acceptance_predicates) == 3

    def test_plural_predicates_cover_plot_crop_water(self):
        g = build_default_graph()
        kinds = [p["kind"] for p in g.acceptance_predicates]
        # region_blocks ×2 (farmland + wheat), at_mark ×1 (water).
        assert kinds.count("region_blocks") == 2
        assert kinds.count("at_mark") == 1

    def test_plural_predicates_all_in_supported_kinds(self):
        g = build_default_graph()
        for p in g.acceptance_predicates:
            assert p["kind"] in SUPPORTED_KINDS, (
                f"predicate kind {p['kind']!r} not in current mc verify build; "
                f"capstone runner would fail at evaluate_all time"
            )

    def test_farmland_predicate_min_count_under_81(self):
        # 9×9 plot is 81 cells; reserve some headroom for water + miss
        g = build_default_graph()
        farmland_preds = [p for p in g.acceptance_predicates
                          if p["kind"] == "region_blocks" and p["block"] == "farmland"]
        assert len(farmland_preds) == 1
        assert farmland_preds[0]["min_count"] < 81

    def test_water_predicate_uses_block_mode(self):
        g = build_default_graph()
        water_preds = [p for p in g.acceptance_predicates
                       if p["kind"] == "at_mark" and p.get("block") == "water"]
        assert len(water_preds) == 1
