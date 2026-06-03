"""Phase 10 PR-R — dispatch-time card-body linter.

Phase 9 run-6 evidence: Steward created prose-only SURVEY and verify-resources
cards that workers grinded on or crash-looped in. Worker-side prose-escalate
(PR-B) got 0 invocations because workers can't reliably distinguish "I should
escalate" from "I should try harder". Move the check upstream: reject malformed
cards before they enter `ready` and reach a worker.

Rule
----
A card with kind in {CONSTRUCT, MINE, TILL, SUPPLY, SURVEY} MUST contain at
least one executable `mc <verb>` line in its body. An executable line:

  - matches ``^\\s*mc\\s+[a-z_]`` outside fenced code blocks (``` ... ```)
  - is NOT a `Done_when: mc ...` clause (that's a completion check, not work)
  - is NOT a comment line (`# mc ...`)

EXPLORE and SCOUT bodies are intentionally prose-led — they're exempt from
the rule UNLESS the SCOUT body cites ≥3 coord triples, in which case the
worker has discrete waypoints to visit and verb lines should drive them.

Output
------
``lint_card_body(kind, title, body)`` returns a dict:

  {
    "ok":   bool,        # True if the card passes the rule (or is exempt)
    "kind": str,         # the parsed kind (uppercased, no brackets)
    "errors":   [str],   # human-readable error messages (empty if ok)
    "warnings": [str],   # advisory messages that don't fail the lint
  }

Callers (``scripts/kanban`` ``cmd_create`` / ``cmd_add``) can:
  - Hard-fail on ``not result["ok"]`` (default for ``CONSTRUCT``+ kinds).
  - Allow opt-out via a ``--allow-prose`` flag for the rare Steward-curated
    prose card that intentionally has no verb (e.g. a SCOUT with single
    free-form objective).
"""
from __future__ import annotations

import re
from typing import Optional

# Run-7 Step 3 (pr-k-kinds-unify): VERB_REQUIRED_KINDS, the SCOUT multi-
# coord threshold, and `parse_kind_from_title` all live in card_kinds.py.
# Re-exported here for backwards-compat with existing callers.
from scripts.lib.card_kinds import (
    VERB_REQUIRED_KINDS,
    SCOUT_MULTI_COORD_THRESHOLD,
    parse_kind_from_title,
)

# Executable verb line: `mc <verb>` at line start (allowing leading whitespace).
# Verbs are [a-z_][a-z_0-9]*. We don't enumerate the verb registry — any
# `mc <something>` invocation counts as "the card body contains an action".
_VERB_LINE_RE = re.compile(r"^\s*mc\s+[a-z_][a-z_0-9]*")

# Done_when: prefix that doesn't count as work.
_DONE_WHEN_RE = re.compile(r"^\s*[Dd]one_?when\s*:\s*mc\b")

# Coord triple in a non-fenced line: three integers separated by commas or
# whitespace, optionally parenthesized. Mirrors marks.js MARK_NOTE_COORD_REGEX.
_COORD_TRIPLE_RE = re.compile(r"\(?\s*(-?\d+)\s*[,\s]\s*(-?\d+)\s*[,\s]\s*(-?\d+)\s*\)?")

# Fenced code block delimiter.
_FENCE_RE = re.compile(r"^\s*```")


def _iter_non_fenced_lines(body: str):
    """Yield lines outside fenced code blocks."""
    in_fence = False
    for line in body.splitlines():
        if _FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        yield line


def count_verb_lines(body: str) -> int:
    """Number of executable `mc <verb>` lines outside fenced blocks,
    excluding `Done_when:` clauses and comment lines."""
    count = 0
    for line in _iter_non_fenced_lines(body):
        stripped = line.lstrip()
        if stripped.startswith("#"):
            continue
        if _DONE_WHEN_RE.match(line):
            continue
        if _VERB_LINE_RE.match(line):
            count += 1
    return count


def count_coord_triples(body: str) -> int:
    """Number of distinct coord triples in non-fenced body lines.

    Used to decide whether a SCOUT body is multi-target (verb-required) or
    a single-objective free-form (exempt).
    """
    triples: set[tuple[int, int, int]] = set()
    for line in _iter_non_fenced_lines(body):
        for m in _COORD_TRIPLE_RE.finditer(line):
            triples.add(tuple(int(g) for g in m.groups()))
    return len(triples)


def lint_card_body(kind: Optional[str], title: Optional[str], body: Optional[str]) -> dict:
    """Run the linter. Returns a structured result dict (see module docstring).

    ``kind`` may be passed explicitly or parsed from ``title``. Explicit kind
    wins so callers can lint cards that don't yet have a title prefix.
    """
    body = body or ""
    inferred_kind = parse_kind_from_title(title)
    resolved_kind = (kind or inferred_kind or "").upper()
    errors: list[str] = []
    warnings: list[str] = []

    verb_count = count_verb_lines(body)
    coord_count = count_coord_triples(body)

    if resolved_kind in VERB_REQUIRED_KINDS:
        if verb_count == 0:
            errors.append(
                f"[{resolved_kind}] card body has no executable `mc <verb>` line. "
                f"Every {resolved_kind} card body must begin with at least one "
                f"literal `mc <verb> <args>` line; prose annotations follow. "
                f"See Phase 9 PR-A in prompts/landfolk/steward.md or run-6 evidence "
                f"in data/postmortems/establish-2026-06-03-phase9/THOROUGH-POSTMORTEM.md."
            )
    elif resolved_kind == "SCOUT":
        if coord_count >= SCOUT_MULTI_COORD_THRESHOLD and verb_count == 0:
            errors.append(
                f"[SCOUT] card body cites {coord_count} coord triples but has no "
                f"executable `mc <verb>` line. Multi-target SCOUT cards must include "
                f"`mc move/goto <x> <y> <z>` or `mc mark ... --at <x> <y> <z>` per "
                f"target waypoint so workers don't have to confabulate verbs from prose."
            )
    elif resolved_kind == "EXPLORE":
        # EXPLORE is intentionally prose-led; no rule fires here.
        pass
    elif resolved_kind == "":
        warnings.append(
            "card title has no `[KIND]` prefix — linter ran in advisory mode "
            "(no verb-required rule applied). Add a `[KIND]` prefix to enable "
            "dispatch-time validation."
        )
    # Other kinds (FIX, BUG, EPIC, SITE, RESCUE, CLEANUP, etc.) are not subject
    # to the verb-required rule.

    return {
        "ok": len(errors) == 0,
        "kind": resolved_kind or None,
        "verb_count": verb_count,
        "coord_count": coord_count,
        "errors": errors,
        "warnings": warnings,
    }
