"""Canonical 13-card DAG for the two-bot cooperative-base demo.

Pip and Zee converge on a small wood + cobblestone base at :seed:. The
graph proves two falsifiable claims in vivo:

  1. Mutex parallelism: cards tagged [bot:pip] and [bot:zee] hold different
     mutex_key domains, so the two lanes run concurrently.
  2. Handoff + converge: each lane's gather + return cards finish before
     the converging builders + sign card.

Card.bot is set per card (pip or zee) — the author writes [bot:<name>]
title prefixes for each, so the mutex parses them into separate domains.
Assignees are the actual Hermes profile slugs (pilot-pip / pilot-zee),
since real Hermes needs a profile to spawn against; per-role behaviour
is driven by the --skill flags + the SOUL's "read title to pick role"
discipline, not by an abstract assignee.

The acceptance predicate is a single ``at_mark seed --block oak_sign``
on Tester :3004 — the cheapest binary check that the sign card succeeded.

This module is data only; ``author.py`` consumes it.

Plan: ~/.claude/plans/create-a-plan-that-magical-lovelace.md
"""

from __future__ import annotations

from .wheat_graph import Card, Graph


# Bot bindings.
BOT_PIP = "pip"
BOT_ZEE = "zee"

# Hermes profile slugs (created by scripts/setup-pilot-pip-zee.sh).
ASSIGNEE_PIP = "pilot-pip"
ASSIGNEE_ZEE = "pilot-zee"


# Mark names placed by data/test-fixtures/open/two_bot_base.yaml.
PLACES = {
    "seed": "seed",
    "wood_supply": "wood_supply",
    "chest_stash": "chest_stash",
    "stone_source": "stone_source",
    "pip_start": "pip_start",
    "zee_start": "zee_start",
}


# Skill bundles per role. Each list is the --skill set for cards of that
# role. Pilots have all bundles installed (see setup-pilot-pip-zee.sh);
# the bundle subset on the card is what scopes the worker's verb surface.
SKILL_BUNDLES: dict[str, tuple[str, ...]] = {
    "navigator": (
        "agent-navigator",
        "minecraft-navigation",
        "minecraft-survival",
        "kanban-worker",
    ),
    "builder": (
        "agent-builder",
        "minecraft-building",
        "minecraft-survival",
        "kanban-worker",
    ),
    "crafter": (
        "agent-crafter",
        "minecraft-chores",
        "minecraft-survival",
        "kanban-worker",
    ),
    "miner": (
        "agent-miner",
        "minecraft-mining",
        "minecraft-survival",
        "kanban-worker",
    ),
}


def build_default_graph() -> Graph:
    """Return the canonical 10-card DAG.

    Pip's lane (5 cards):
      p_nav_stash → p_withdraw_axe → p_nav_wood → p_withdraw_wood → p_return

    Zee's lane (5 cards):
      z_nav_stash → z_withdraw_pickaxe → z_nav_stone → z_mine → z_return

    Convergence (3 cards):
      p_build  depends on (p_return, z_return)
      z_build  depends on (p_return, z_return)   ← parallel with p_build
      p_sign   depends on (p_build, z_build)     ← acceptance
    """

    cards = (
        # ── Pip's wood-gather lane ─────────────────────────────────
        Card(
            slug="p_nav_stash",
            title="@navigator → :chest_stash:",
            assignee=ASSIGNEE_PIP,
            body=(
                "Navigate to :chest_stash:. Hand off your exit_pos and "
                "stopped_at_mark on completion."
            ),
            depends_on=(),
            skills=SKILL_BUNDLES["navigator"],
            work_at_mark=PLACES["chest_stash"],
            bot=BOT_PIP,
        ),
        Card(
            slug="p_withdraw_axe",
            title="@crafter withdraw wooden_axe at :chest_stash:",
            assignee=ASSIGNEE_PIP,
            body=(
                "From :chest_stash: withdraw one wooden_axe and one "
                "oak_sign (for the final placement card). Hand off "
                "inv_delta on completion."
            ),
            depends_on=("p_nav_stash",),
            skills=SKILL_BUNDLES["crafter"],
            work_at_mark=PLACES["chest_stash"],
            bot=BOT_PIP,
        ),
        Card(
            slug="p_nav_wood",
            title="@navigator → :wood_supply:",
            assignee=ASSIGNEE_PIP,
            body=(
                "Navigate to :wood_supply:. Hand off your exit_pos so the "
                "next card knows you are adjacent to the chest."
            ),
            depends_on=("p_withdraw_axe",),
            skills=SKILL_BUNDLES["navigator"],
            work_at_mark=PLACES["wood_supply"],
            bot=BOT_PIP,
        ),
        Card(
            slug="p_withdraw_wood",
            title="@crafter withdraw 16 oak_log at :wood_supply:",
            assignee=ASSIGNEE_PIP,
            body=(
                "From :wood_supply: withdraw 16 oak_log. Hand off "
                "inv_delta on completion."
            ),
            depends_on=("p_nav_wood",),
            skills=SKILL_BUNDLES["crafter"],
            work_at_mark=PLACES["wood_supply"],
            bot=BOT_PIP,
        ),
        Card(
            slug="p_return",
            title="@navigator return to :seed:",
            assignee=ASSIGNEE_PIP,
            body=(
                "Return to :seed:. Hand off exit_pos so the builder knows "
                "you are at the build site."
            ),
            depends_on=("p_withdraw_wood",),
            skills=SKILL_BUNDLES["navigator"],
            work_at_mark=PLACES["seed"],
            bot=BOT_PIP,
        ),
        # ── Zee's cobble-gather lane ───────────────────────────────
        Card(
            slug="z_nav_stash",
            title="@navigator → :chest_stash:",
            assignee=ASSIGNEE_ZEE,
            body=(
                "Navigate to :chest_stash: so the next card can withdraw "
                "the iron_pickaxe. Hand off exit_pos on completion."
            ),
            depends_on=(),
            skills=SKILL_BUNDLES["navigator"],
            work_at_mark=PLACES["chest_stash"],
            bot=BOT_ZEE,
        ),
        Card(
            slug="z_withdraw_pickaxe",
            title="@crafter withdraw iron_pickaxe at :chest_stash:",
            assignee=ASSIGNEE_ZEE,
            body=(
                "From :chest_stash: withdraw one iron_pickaxe. Hand off "
                "inv_delta on completion."
            ),
            depends_on=("z_nav_stash",),
            skills=SKILL_BUNDLES["crafter"],
            work_at_mark=PLACES["chest_stash"],
            bot=BOT_ZEE,
        ),
        Card(
            slug="z_nav_stone",
            title="@navigator → :stone_source:",
            assignee=ASSIGNEE_ZEE,
            body=(
                "Navigate to :stone_source:. Your exit_pos should put you "
                "adjacent to the cobble outcrop."
            ),
            depends_on=("z_withdraw_pickaxe",),
            skills=SKILL_BUNDLES["navigator"],
            work_at_mark=PLACES["stone_source"],
            bot=BOT_ZEE,
        ),
        Card(
            slug="z_mine",
            title="@miner extract 32 cobblestone at :stone_source:",
            assignee=ASSIGNEE_ZEE,
            body=(
                "Mine 32 cobblestone from the outcrop at :stone_source:. "
                "Pickaxe must already be in inventory. Hand off "
                "inv_delta on completion."
            ),
            depends_on=("z_nav_stone",),
            skills=SKILL_BUNDLES["miner"],
            work_at_mark=PLACES["stone_source"],
            bot=BOT_ZEE,
        ),
        Card(
            slug="z_return",
            title="@navigator return to :seed:",
            assignee=ASSIGNEE_ZEE,
            body=(
                "Return to :seed: carrying the cobblestone. Hand off "
                "exit_pos so the builder knows you are at the build site."
            ),
            depends_on=("z_mine",),
            skills=SKILL_BUNDLES["navigator"],
            work_at_mark=PLACES["seed"],
            bot=BOT_ZEE,
        ),
        # ── Convergence: both builders depend on both return cards ─
        Card(
            slug="p_build",
            title="@builder wood frame at :seed:",
            assignee=ASSIGNEE_PIP,
            body=(
                "At :seed:, place oak_log blocks forming a small wood "
                "frame (e.g. 4 corner posts at y=65). Use 4 oak_log "
                "minimum. Hand off pad_verified and exit_pos."
            ),
            depends_on=("p_return", "z_return"),
            skills=SKILL_BUNDLES["builder"],
            work_at_mark=PLACES["seed"],
            bot=BOT_PIP,
        ),
        Card(
            slug="z_build",
            title="@builder stone foundation at :seed:",
            assignee=ASSIGNEE_ZEE,
            body=(
                "At :seed:, place cobblestone blocks forming a small "
                "stone foundation around the wood frame. Use 8 "
                "cobblestone minimum. Hand off pad_verified and "
                "exit_pos."
            ),
            depends_on=("p_return", "z_return"),
            skills=SKILL_BUNDLES["builder"],
            work_at_mark=PLACES["seed"],
            bot=BOT_ZEE,
        ),
        # ── Acceptance: sign card ──────────────────────────────────
        Card(
            slug="p_sign",
            title="@crafter place oak_sign at :seed:",
            assignee=ASSIGNEE_PIP,
            body=(
                "Place an oak_sign at :seed:. Use the oak_sign already "
                "in inventory from the stash withdraw card. Acceptance "
                "is `mc verify at_mark seed --block oak_sign` on Tester."
            ),
            depends_on=("p_build", "z_build"),
            skills=SKILL_BUNDLES["crafter"],
            work_at_mark=PLACES["seed"],
            bot=BOT_PIP,
        ),
    )

    # Single chest_contains-like predicate is misaligned for this demo —
    # the sign at seed IS the acceptance. The runner queries Tester for it
    # via `mc verify at_mark seed --block oak_sign`.
    acceptance_predicate = {
        "kind": "at_mark",
        "mark": PLACES["seed"],
        "block": "oak_sign",
    }

    return Graph(
        epic_slug="two_bot_base",
        epic_title="[DEMO] Two-bot cooperative base at :seed:",
        epic_body=(
            "Pip + Zee build a small wood + cobblestone base at the "
            ":seed: mark.\n"
            "Pip handles wood: stash → withdraw axe + sign → wood_supply → "
            "withdraw 16 oak_log → return.\n"
            "Zee handles stone: stash → withdraw pickaxe → stone_source → "
            "mine 32 cobblestone → return.\n"
            "Both build their material at :seed: (parallel after "
            "convergence); pip places the acceptance sign last.\n"
            "Acceptance: mc verify at_mark seed --block oak_sign."
        ),
        cards=cards,
        acceptance_predicate=acceptance_predicate,
    )


# Slugs of cards on each lane — used by the runner for lane-by-lane
# scorecard reporting (#2 in the acceptance table).
PIP_LANE_SLUGS = (
    "p_nav_stash", "p_withdraw_axe", "p_nav_wood", "p_withdraw_wood",
    "p_return", "p_build", "p_sign",
)
ZEE_LANE_SLUGS = (
    "z_nav_stash", "z_withdraw_pickaxe", "z_nav_stone", "z_mine",
    "z_return", "z_build",
)
