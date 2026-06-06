"""Mutex domain resolution: `metadata.bot` when present, else `assignee`.

Concern 5 of the colony validation plan extends the per-assignee mutex
to per-bot when a card identifies a specific bot body. The architecture's
``target.md`` calls this ``metadata.bot``, but Hermes' kanban schema has
no metadata column. As a pragmatic interim encoding, we read a title
prefix ``[bot:<name>]`` — matching the existing closed-set title-tag
convention in ``board-dynamics.md`` § "Card tags the tick parses".

Cards without the ``[bot:...]`` prefix retain today's per-assignee
behavior; cards with it gain per-bot serialization that doesn't conflict
across different assignees on the same body or across different bodies
on the same assignee.

Once Section F (per-card MC env injection) ships and a real
``metadata.bot`` storage exists, the parsing here can move to that
source without changing the call sites in gate.py / hooks.py — they
already call ``mutex_key(...)`` and don't care where the bot came from.

Examples:

    title="[bot:pip] navigate to :mine_nw:" assignee="navigator"  → "bot:pip"
    title="navigate to :mine_nw:"            assignee="navigator"  → "navigator"
    title="[bot:zee] [URGENT] flee"          assignee="navigator"  → "bot:zee"
"""

from __future__ import annotations

import re
from typing import Any


# Recognized at the start of the title (after any leading whitespace),
# case-insensitive. The bot name must be a short alphanumeric + underscore
# token — same shape as the target roster names (pip, mox, zee, bix, glim).
_BOT_TAG_RE = re.compile(r"^\s*\[bot:([a-z0-9_]+)\]", re.IGNORECASE)


def extract_bot_from_title(title: str | None) -> str | None:
    """Return the bot name from a ``[bot:<name>]`` title prefix, or None."""
    if not title:
        return None
    m = _BOT_TAG_RE.match(title)
    if not m:
        return None
    return m.group(1).lower()


def mutex_key(assignee: str | None, title: str | None) -> str:
    """Return the mutex domain key for a card.

    The bot tag wins when present so two cards with ``assignee=navigator``
    and bots ``pip`` and ``zee`` can run concurrently. When absent, the
    key is the assignee (lowercased) — exactly today's behavior.

    Empty/None assignee with no bot tag returns "" — the caller treats
    that as "no mutex domain" and typically skips.
    """
    bot = extract_bot_from_title(title)
    if bot:
        return f"bot:{bot}"
    if not assignee:
        return ""
    return assignee.lower()


def mutex_key_from_row(row: Any) -> str:
    """Convenience wrapper: extract from a sqlite3.Row or dict-like with
    `assignee` and `title` fields."""
    if row is None:
        return ""
    try:
        assignee = row["assignee"]
    except (KeyError, IndexError, TypeError):
        assignee = None
    try:
        title = row["title"]
    except (KeyError, IndexError, TypeError):
        title = None
    return mutex_key(assignee, title)
