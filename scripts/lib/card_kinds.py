"""Single source of truth for kanban card kinds across the toolchain.

Before this module, `scripts/lib/card_body_linter.py` defined
`VERB_REQUIRED_KINDS = frozenset({...})` while `scripts/wb` independently
redefined `_STASH_KIND_RE = re.compile(...)` over the same five kinds.
Run-7 Step 3 (PR-K) consolidates them here so future kind additions
(e.g. a hypothetical `[ROOF]` card) only change one place.

Importers:
  - `scripts/lib/card_body_linter.py` — `VERB_REQUIRED_KINDS`
  - `scripts/wb` — `VERB_REQUIRED_KINDS` (for `_card_should_stash`)
"""
from __future__ import annotations

import re

# Card kinds that REQUIRE a literal `mc <verb>` line in the body AND
# that are stash-worthy for `wb context`'s side effect / `cmd_stash_coord`.
# Emergent genesis-v2 also uses FEEDBACK, RETRO, SCOUT, COOK, FARM, and
# `[GENESIS2:*]` titles — see `skills/genesis-v2-worker-card-schema.md` for
# planner-facing reconciliation with these five canonical kinds.
VERB_REQUIRED_KINDS = frozenset({"CONSTRUCT", "MINE", "TILL", "SUPPLY", "SURVEY"})

# SCOUT becomes verb-required when the body has ≥ this many coord triples
# (multi-waypoint variant). Used only by the linter; the stash path
# treats all SCOUT bodies as non-stash-worthy by default.
SCOUT_MULTI_COORD_THRESHOLD = 3

# Title prefix shape: `[KIND] description`. The regex returns the
# uppercased kind on match. Single source of truth for parsing.
_TITLE_KIND_RE = re.compile(r"^\s*\[([A-Z]+)\]")


def parse_kind_from_title(title: str | None) -> str | None:
    """Pull `[KIND]` out of a title; return the uppercased label or None."""
    if not title:
        return None
    m = _TITLE_KIND_RE.match(title)
    return m.group(1).upper() if m else None


def title_kind_in(title: str | None, kinds) -> bool:
    """Convenience: True iff the title's kind is in `kinds` (any iterable)."""
    k = parse_kind_from_title(title)
    return k is not None and k in kinds
