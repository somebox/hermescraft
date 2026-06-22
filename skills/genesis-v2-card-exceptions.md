---
name: genesis-v2-card-exceptions
description: When to comment CARD_REVIEW_NEEDED vs block vs rescope on genesis-v2 cards.
version: 1.0.0
platforms: [linux, macos]
metadata:
  hermes:
    tags: [genesis-v2, kanban, colony]
---

# Genesis v2 card exceptions

Prefer structured board comments over duplicating stuck work.

## CARD_REVIEW_NEEDED

Comment on the worker card when validation fails but the intent is sound:

```
CARD_REVIEW_NEEDED: <one line> — missing mine_site / footprint / done_when …
```

The poller avoids duplicate SUPERVISE when the card is already blocked with
`card-review-needed:` or `schema-missing:`.

## Block prefixes (workers)

Use structured `kanban_block` reasons: `no_water`, `out_of_materials`, `unreachable`,
`prep_required_unmet`, `site_occupied`, `no_free_body`, `help_needed`.

## Planner

- Do not re-file duplicate FEEDBACK or SUPPLY cards — comment on the existing one.
- Rescope CONSTRUCT when `site_occupied` — new anchor or explicit `overwrite=true` auth.
- Mining-intent titles require `mine_site:` in the body.
