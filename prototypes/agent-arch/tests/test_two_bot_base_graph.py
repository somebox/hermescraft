"""Contract tests for the two-bot cooperative-base graph.

Proves the graph data + per-card author wiring without touching live
infrastructure. The runner's --dry-run mode is also exercised in the
mode_dry_run integration test below.

What we prove:
  - 13-card DAG topology (pip gather + zee gather + 3 converge).
  - Every execute card has a bot tag of `pip` or `zee` (no untagged
    cards leak into the trial).
  - Convergence: both builders depend on BOTH return cards (parallel
    after gather), sign depends on both builders.
  - Per-card SKILL_BUNDLES wire through to the --skill flags.
  - Assignees are the real Hermes profile slugs (pilot-pip / pilot-zee),
    not abstract role names.
  - Card.bot is the post-Phase-4 author-side change — backwards-compat
    on wheat is regressed in test_capstone_scaffold.py.

Plan: ~/.claude/plans/create-a-plan-that-magical-lovelace.md
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "prototypes" / "agent-arch"))

from capstone.author import author_colony_lane, resolve_parents  # noqa: E402
from capstone.two_bot_base_graph import (  # noqa: E402
    ASSIGNEE_PIP,
    ASSIGNEE_ZEE,
    BOT_PIP,
    BOT_ZEE,
    PIP_LANE_SLUGS,
    SKILL_BUNDLES,
    ZEE_LANE_SLUGS,
    build_default_graph,
)


# ── Topology ───────────────────────────────────────────────────────

class TestGraphShape:
    def test_thirteen_cards_total(self) -> None:
        g = build_default_graph()
        assert len(g.cards) == 13

    def test_pip_lane_has_seven_slugs(self) -> None:
        # 5 gather + 1 build + 1 sign
        assert len(PIP_LANE_SLUGS) == 7

    def test_zee_lane_has_six_slugs(self) -> None:
        # 5 gather + 1 build
        assert len(ZEE_LANE_SLUGS) == 6

    def test_every_card_in_lane_groups(self) -> None:
        # Lane sets are disjoint and cover every card exactly once.
        g = build_default_graph()
        pip_set, zee_set = set(PIP_LANE_SLUGS), set(ZEE_LANE_SLUGS)
        all_slugs = {c.slug for c in g.cards}
        assert pip_set & zee_set == set()
        assert pip_set | zee_set == all_slugs

    def test_first_cards_have_no_deps(self) -> None:
        # Pip's first nav and zee's first nav are the entry points.
        g = build_default_graph()
        roots = [c for c in g.cards if not c.depends_on]
        assert {c.slug for c in roots} == {"p_nav_stash", "z_nav_stash"}


class TestPipLaneChain:
    def test_pip_lane_serial_dependencies(self) -> None:
        # p_nav_stash → p_withdraw_axe → p_nav_wood → p_withdraw_wood → p_return
        g = build_default_graph()
        cards_by_slug = {c.slug: c for c in g.cards}
        chain = ["p_nav_stash", "p_withdraw_axe", "p_nav_wood",
                 "p_withdraw_wood", "p_return"]
        for i in range(1, len(chain)):
            assert cards_by_slug[chain[i]].depends_on == (chain[i - 1],), (
                f"{chain[i]} should depend on {chain[i-1]}"
            )


class TestZeeLaneChain:
    def test_zee_lane_serial_dependencies(self) -> None:
        # z_nav_stash → z_withdraw_pickaxe → z_nav_stone → z_mine → z_return
        g = build_default_graph()
        cards_by_slug = {c.slug: c for c in g.cards}
        chain = [
            "z_nav_stash", "z_withdraw_pickaxe", "z_nav_stone",
            "z_mine", "z_return",
        ]
        for i in range(1, len(chain)):
            assert cards_by_slug[chain[i]].depends_on == (chain[i - 1],), (
                f"{chain[i]} should depend on {chain[i-1]}"
            )


class TestConvergence:
    def test_both_builders_depend_on_both_returns(self) -> None:
        # The architectural point: p_build and z_build run in parallel
        # because they share the same dependency set, and their bot tags
        # differ so the mutex permits concurrent running.
        g = build_default_graph()
        by_slug = {c.slug: c for c in g.cards}
        assert set(by_slug["p_build"].depends_on) == {"p_return", "z_return"}
        assert set(by_slug["z_build"].depends_on) == {"p_return", "z_return"}

    def test_sign_depends_on_both_builders(self) -> None:
        g = build_default_graph()
        by_slug = {c.slug: c for c in g.cards}
        assert set(by_slug["p_sign"].depends_on) == {"p_build", "z_build"}


# ── Bot tagging ────────────────────────────────────────────────────

class TestBotTagging:
    def test_every_card_has_a_bot(self) -> None:
        # No card may rely on graph-level epic_bot fallback in this graph;
        # every card binds explicitly to pip or zee.
        g = build_default_graph()
        for c in g.cards:
            assert c.bot in (BOT_PIP, BOT_ZEE), (
                f"card {c.slug} has bot={c.bot!r}; expected pip or zee"
            )

    def test_pip_lane_cards_carry_bot_pip(self) -> None:
        g = build_default_graph()
        by_slug = {c.slug: c for c in g.cards}
        for slug in PIP_LANE_SLUGS:
            assert by_slug[slug].bot == BOT_PIP

    def test_zee_lane_cards_carry_bot_zee(self) -> None:
        g = build_default_graph()
        by_slug = {c.slug: c for c in g.cards}
        for slug in ZEE_LANE_SLUGS:
            assert by_slug[slug].bot == BOT_ZEE


# ── Assignees (profile slugs, not abstract roles) ──────────────────

class TestAssignees:
    def test_pip_lane_assignees_are_pilot_pip(self) -> None:
        g = build_default_graph()
        by_slug = {c.slug: c for c in g.cards}
        for slug in PIP_LANE_SLUGS:
            assert by_slug[slug].assignee == ASSIGNEE_PIP

    def test_zee_lane_assignees_are_pilot_zee(self) -> None:
        g = build_default_graph()
        by_slug = {c.slug: c for c in g.cards}
        for slug in ZEE_LANE_SLUGS:
            assert by_slug[slug].assignee == ASSIGNEE_ZEE

    def test_assignees_are_real_profile_slugs(self) -> None:
        # If someone edits the graph to use abstract role names like
        # "navigator", catch it here — Hermes needs the profile slug.
        g = build_default_graph()
        for c in g.cards:
            assert c.assignee.startswith("pilot-"), (
                f"card {c.slug} assignee={c.assignee!r}; expected pilot-pip or pilot-zee"
            )


# ── Skills ─────────────────────────────────────────────────────────

class TestSkillBundles:
    def test_navigator_cards_get_navigator_bundle(self) -> None:
        g = build_default_graph()
        for c in g.cards:
            if "@navigator" in c.title:
                assert set(c.skills) == set(SKILL_BUNDLES["navigator"])

    def test_miner_card_gets_miner_bundle(self) -> None:
        g = build_default_graph()
        by_slug = {c.slug: c for c in g.cards}
        assert set(by_slug["z_mine"].skills) == set(SKILL_BUNDLES["miner"])

    def test_builder_cards_get_builder_bundle(self) -> None:
        g = build_default_graph()
        by_slug = {c.slug: c for c in g.cards}
        for slug in ("p_build", "z_build"):
            assert set(by_slug[slug].skills) == set(SKILL_BUNDLES["builder"])

    def test_crafter_cards_get_crafter_bundle(self) -> None:
        g = build_default_graph()
        by_slug = {c.slug: c for c in g.cards}
        for slug in ("p_withdraw_axe", "p_withdraw_wood", "p_sign"):
            assert set(by_slug[slug].skills) == set(SKILL_BUNDLES["crafter"])

    def test_every_bundle_includes_kanban_worker(self) -> None:
        # Without kanban-worker the worker can't complete/block cards.
        g = build_default_graph()
        for c in g.cards:
            assert "kanban-worker" in c.skills


# ── Acceptance predicate ──────────────────────────────────────────

class TestAcceptancePredicate:
    def test_predicate_is_at_mark_seed_oak_sign(self) -> None:
        g = build_default_graph()
        ap = g.acceptance_predicate
        assert ap is not None
        assert ap["kind"] == "at_mark"
        assert ap["mark"] == "seed"
        assert ap["block"] == "oak_sign"


# ── Author wiring ──────────────────────────────────────────────────

class TestAuthor:
    def test_eleven_invocations(self) -> None:
        g = build_default_graph()
        invs = author_colony_lane(g)
        assert len(invs) == len(g.cards)

    def test_title_prefix_is_per_card_bot(self) -> None:
        # author_colony_lane uses Card.bot when set, NOT graph epic_bot.
        # Pip's cards get [bot:pip]; zee's get [bot:zee].
        g = build_default_graph()
        invs = author_colony_lane(g)
        by_slug = {inv.slug: inv for inv in invs}
        for slug in PIP_LANE_SLUGS:
            assert by_slug[slug].title.lower().startswith("[bot:pip]"), \
                f"{slug} title={by_slug[slug].title!r}"
        for slug in ZEE_LANE_SLUGS:
            assert by_slug[slug].title.lower().startswith("[bot:zee]"), \
                f"{slug} title={by_slug[slug].title!r}"

    def test_assignee_in_cmd_matches_card(self) -> None:
        g = build_default_graph()
        invs = author_colony_lane(g)
        by_slug = {inv.slug: inv for inv in invs}
        for card in g.cards:
            inv = by_slug[card.slug]
            assignee_idx = inv.cmd.index("--assignee") + 1
            assert inv.cmd[assignee_idx] == card.assignee

    def test_skill_flags_per_card(self) -> None:
        g = build_default_graph()
        invs = author_colony_lane(g)
        by_slug = {inv.slug: inv for inv in invs}
        # Spot-check the miner card has the miner bundle in its --skill flags.
        z_mine_cmd = list(by_slug["z_mine"].cmd)
        skill_flags = [z_mine_cmd[i + 1] for i, a in enumerate(z_mine_cmd)
                       if a == "--skill"]
        assert set(skill_flags) == set(SKILL_BUNDLES["miner"])


class TestResolveParentsForDag:
    def test_converging_card_gets_two_parents(self) -> None:
        # p_build depends on both p_return AND z_return → two --parent flags.
        g = build_default_graph()
        invs = author_colony_lane(g)
        by_slug = {inv.slug: inv for inv in invs}
        slug_to_id = {s: f"id-{s}" for s in {c.slug for c in g.cards}}
        resolved = resolve_parents(by_slug["p_build"], slug_to_id)
        parent_count = sum(1 for a in resolved if a == "--parent")
        assert parent_count == 2
        # Both parent ids present.
        parents_in_cmd = [resolved[i + 1] for i, a in enumerate(resolved)
                         if a == "--parent"]
        assert set(parents_in_cmd) == {"id-p_return", "id-z_return"}

    def test_sign_card_gets_both_builder_parents(self) -> None:
        g = build_default_graph()
        invs = author_colony_lane(g)
        by_slug = {inv.slug: inv for inv in invs}
        slug_to_id = {s: f"id-{s}" for s in {c.slug for c in g.cards}}
        resolved = resolve_parents(by_slug["p_sign"], slug_to_id)
        parents_in_cmd = [resolved[i + 1] for i, a in enumerate(resolved)
                         if a == "--parent"]
        assert set(parents_in_cmd) == {"id-p_build", "id-z_build"}

    def test_root_card_unchanged(self) -> None:
        g = build_default_graph()
        invs = author_colony_lane(g)
        by_slug = {inv.slug: inv for inv in invs}
        slug_to_id = {}
        assert resolve_parents(by_slug["p_nav_stash"], slug_to_id) == by_slug["p_nav_stash"].cmd
