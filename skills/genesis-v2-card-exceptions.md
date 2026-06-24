---
name: genesis-v2-card-exceptions
description: When to comment CARD_REVIEW_NEEDED vs block vs escalate on genesis-v2 cards.
version: 1.1.0
platforms: [linux, macos]
metadata:
  hermes:
    tags: [genesis-v2, kanban, colony]
---

# Genesis v2 card exceptions

Prefer structured board actions over duplicating stuck work.

## NEEDS REVIEW lane (Steward / operator)

`scripts/kanban board` lists **NEEDS REVIEW** only for cards blocked with a reason
starting `[!ESCALATED]` — that prefix is added by **`wb escalate "<reason>"`**, not by
plain `wb block` or poller `schema-missing:` gates.

When the card needs a human/planner decision (mis-spec, world mismatch, reassign):

```
wb escalate "<one line why>"
```

Do **not** rely on a comment-only `CARD_REVIEW_NEEDED:` if you want the card in NEEDS
REVIEW — comments do not move lanes.

## CARD_REVIEW_NEEDED (cheap pass-back)

Comment on the worker card when validation fails but the intent is sound and you are
not asking for immediate Steward attention:

```
CARD_REVIEW_NEEDED: <one line> — missing mine_site / footprint / done_when …
```

Optional follow-up: `wb block` with `card-review-needed: …` if you must park the card.

The poller avoids duplicate SUPERVISE when the card is already blocked with
`card-review-needed:` or `schema-missing:`.

## Poller structural gates (plain BLOCKED)

`block_invalid_ready_cards` and similar poller paths block with `schema-missing: …` or
`supervise_cap_exhausted: …`. Those appear under **BLOCKED** on the board (readable
reason), not NEEDS REVIEW.

## Block prefixes (workers)

Use structured `kanban_block` / `wb block` reasons: `no_water`, `out_of_materials`,
`unreachable`, `prep_required_unmet`, `site_occupied`, `no_free_body`, `help_needed`.

**Construct / schematic (block, do not blind-retry):**

| Situation | Block reason prefix | Next step |
|-----------|---------------------|-----------|
| Wet/sloped L0, begin refused | `prep_required:` or `prep_required_unmet:` | L0 ground_prep card or planner prep follow-up |
| `construct end` gate failed | `GATE_FAIL:` + verify summary | Re-run `construct show`; fix workset; VERIFY sibling |
| Stale `plan_revision` on card | `PLAN_REVISION_MISMATCH:` | Planner updates plan/card revision |
| NAV blocked en route | `unreachable:` + re-observe snapshot | Re-`mc scene`; planner rescopes mark/site |

After any motor failure: **re-observe** (`mc scene` / `mc observe`) before repeating the
same `fill` box. Use `mc level_ground` / `mc deck` **dry-run** (no `execute=true`) before
bulk execute on apron work.

## Planner

- Do not re-file duplicate FEEDBACK or SUPPLY cards — comment on the existing one.
- Rescope CONSTRUCT when `site_occupied` — new anchor or explicit `overwrite=true` auth.
- Mining-intent titles require `mine_site:` in the body.
