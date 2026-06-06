"""Unit tests for dsl_parse.

Runs without Hermes or an LLM. This is the Phase 1 parser-validation track
called out in the prototype plan.

From the repo root:

    python -m pytest prototypes/agent-arch/tests/test_dsl_parse.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))

from dsl_parse import KNOWN_BOTS, Intent, parse  # noqa: E402


def test_single_line_bot_bound_navigation():
    intents = parse("@navigator pip to :mine_nw:")
    assert intents == [
        Intent(agent="navigator", bot="pip", body="to :mine_nw:", marks=["mine_nw"]),
    ]


def test_single_line_bot_bound_freetext():
    intents = parse("@miner pip extract 32 iron at :mine_nw:")
    assert len(intents) == 1
    assert intents[0].agent == "miner"
    assert intents[0].bot == "pip"
    assert intents[0].body == "extract 32 iron at :mine_nw:"
    assert intents[0].marks == ["mine_nw"]


def test_canonical_four_line_chain():
    """The canonical example from docs/architecture/hermes-agents.md."""
    body = """
@crafter pip equip for journey (pickaxe, food, torches)
@navigator pip to :mine_nw:
@miner pip extract 32 iron at :mine_nw:
@navigator pip return to :base_anchor:
""".strip()
    intents = parse(body)
    assert [i.agent for i in intents] == ["crafter", "navigator", "miner", "navigator"]
    assert all(i.bot == "pip" for i in intents)
    assert intents[1].marks == ["mine_nw"]
    assert intents[3].marks == ["base_anchor"]


def test_botless_agent():
    """`@planner` is bot-less — second token must NOT be eaten as a bot."""
    intents = parse("@planner read base-goals.yaml and write triage cards")
    assert len(intents) == 1
    assert intents[0].agent == "planner"
    assert intents[0].bot is None
    assert intents[0].body == "read base-goals.yaml and write triage cards"
    assert intents[0].marks == []


def test_unknown_second_token_treated_as_body_not_bot():
    """If the second token isn't a registered bot, it stays in the body."""
    intents = parse("@navigator dragons are not bots, treat the line as bot-less")
    assert intents[0].agent == "navigator"
    assert intents[0].bot is None


def test_multiple_marks_in_one_line():
    intents = parse("@navigator pip go via :base_anchor: then :mine_nw:")
    assert intents[0].marks == ["base_anchor", "mine_nw"]


def test_comments_and_blanks_skipped():
    body = """
# this is a comment

@navigator pip to :base_anchor:
# another comment

@miner pip dig 1 stone
""".strip()
    intents = parse(body)
    assert [i.agent for i in intents] == ["navigator", "miner"]


def test_non_at_lines_silently_ignored():
    """Lines that don't start with @ fall through (planner playbook lives here
    in production; the prototype just ignores them)."""
    body = """
Some prose without an at-mention.
@navigator pip to :base_anchor:
[parents: 0,1]
"""
    intents = parse(body)
    assert len(intents) == 1
    assert intents[0].agent == "navigator"


def test_kanban_create_args_basic():
    intent = Intent(agent="navigator", bot="pip", body="to :mine_nw:", marks=["mine_nw"])
    args = intent.to_kanban_create_args(
        skills=["agent-navigator", "minecraft-navigation"],
    )
    assert "--assignee" in args
    assert "pilot-navigator" in args
    assert args.count("--skill") == 2
    assert "--parent" not in args


def test_kanban_create_args_with_parent():
    intent = Intent(agent="miner", bot="pip", body="dig 4 stone", marks=[])
    args = intent.to_kanban_create_args(
        skills=["agent-miner"], parent="task-123",
    )
    assert "--parent" in args
    assert "task-123" in args


def test_title_truncated_for_long_body():
    long_body = "extract a really really really really really really long thing"
    intent = Intent(agent="miner", bot="pip", body=long_body, marks=[])
    args = intent.to_kanban_create_args(skills=["agent-miner"])
    title_idx = args.index("--title") + 1
    assert len(args[title_idx]) <= 60


def test_known_bots_includes_target_roster():
    """Per docs/architecture/bots-and-mc.md target fleet roster."""
    for bot in ("pip", "mox", "zee", "bix", "glim"):
        assert bot in KNOWN_BOTS


def test_legacy_bot_names_not_in_known_set():
    """Old roster (flint, mason, ...) should NOT be parsed as bots.
    The architecture is moving off those names."""
    for legacy in ("flint", "mason", "gatherer", "barley", "steward"):
        assert legacy not in KNOWN_BOTS
