"""Unit tests for mutex_key resolution.

Pure parsing — no SQL, no fixtures. Confirms the convention
documented in mutex_key.py:

  [bot:<name>] title-prefix wins; absent → assignee (lowercased).

Plan: reports/agent-arch/2026-06-06-colony-validation-plan.md (Session 4).
"""

from __future__ import annotations

import pytest

from landfolk.orchestrator.mutex_key import (
    extract_bot_from_title,
    mutex_key,
    mutex_key_from_row,
)


class TestExtractBotFromTitle:
    def test_plain_tag(self):
        assert extract_bot_from_title("[bot:pip] navigate") == "pip"

    def test_with_leading_whitespace(self):
        assert extract_bot_from_title("   [bot:pip] navigate") == "pip"

    def test_no_tag_returns_none(self):
        assert extract_bot_from_title("navigate to mark") is None

    def test_only_recognised_at_start(self):
        # A bot tag in the middle of a title isn't a tag.
        assert extract_bot_from_title("navigate then [bot:pip]") is None

    def test_case_insensitive(self):
        # The prefix is case-insensitive; the bot name is lowercased.
        assert extract_bot_from_title("[BOT:Pip] go") == "pip"

    def test_underscored_names(self):
        # Roster ids can contain underscores per docs/architecture/bots-and-mc.md
        assert extract_bot_from_title("[bot:colony_pip] go") == "colony_pip"

    def test_numeric_suffix(self):
        assert extract_bot_from_title("[bot:bix2] go") == "bix2"

    def test_empty_title(self):
        assert extract_bot_from_title("") is None
        assert extract_bot_from_title(None) is None


class TestMutexKey:
    def test_bot_tag_wins_over_assignee(self):
        # Two cards with assignee=navigator and different bot tags must
        # land in distinct mutex domains.
        assert mutex_key("navigator", "[bot:pip] go") == "bot:pip"
        assert mutex_key("navigator", "[bot:zee] go") == "bot:zee"

    def test_falls_back_to_assignee_when_no_tag(self):
        assert mutex_key("flint", "navigate") == "flint"

    def test_returns_lowercased_assignee(self):
        assert mutex_key("FLINT", "navigate") == "flint"

    def test_empty_assignee_no_tag_returns_empty(self):
        # Caller should treat empty as "no mutex domain — skip".
        assert mutex_key(None, "navigate") == ""
        assert mutex_key("", "navigate") == ""

    def test_empty_assignee_with_tag_still_returns_bot_key(self):
        # A bot-tagged title gives the bot key even if assignee is missing
        # — useful in case the title is the canonical source.
        assert mutex_key(None, "[bot:pip] go") == "bot:pip"

    def test_bot_tag_independent_of_assignee_case(self):
        assert mutex_key("Navigator", "[bot:PIP] go") == "bot:pip"


class TestMutexKeyFromRow:
    def test_dict_row(self):
        assert mutex_key_from_row({"assignee": "navigator", "title": "[bot:pip] go"}) == "bot:pip"

    def test_dict_no_tag(self):
        assert mutex_key_from_row({"assignee": "flint", "title": "do thing"}) == "flint"

    def test_missing_fields_safe(self):
        assert mutex_key_from_row({}) == ""
        assert mutex_key_from_row(None) == ""

    def test_assignee_only(self):
        assert mutex_key_from_row({"assignee": "mason"}) == "mason"
