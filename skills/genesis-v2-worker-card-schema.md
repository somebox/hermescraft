---
name: genesis-v2-worker-card-schema
description: Required fields and literal mc lines for genesis-v2 worker cards filed by colony-planner.
version: 1.0.0
platforms: [linux, macos]
metadata:
  hermes:
    tags: [genesis-v2, kanban, colony]
---

# Genesis v2 worker card schema

Load this before filing body-using worker cards on `genesis-v2`. Validation:
`HERMES_KANBAN_BOARD=genesis-v2 scripts/kanban validate-board --status ready,todo`
and post-run `scripts/gv2-validate-cards.py`.

## Every body-using worker card

```
anchor: <mark or X,Y,Z>
source_truth: board|marks|handoff
mc bot checkout --near <X,Y,Z> --cap <role> [--mark <site>]
… literal mc lines …
done_when: <measurable outcome>
mc bot release
```

- One `mc` verb per line at line start (not numbered lists).
- Never set a `skills:` field on worker cards.

## Kind-specific blocks

| Kind (title tag) | Required body fields |
|------------------|----------------------|
| SURVEY / SCOUT | `mc scene` or `mc observe`; output marks |
| CONSTRUCT / BUILD | `footprint:`; survey before bulk `place_fill` |
| MINE (mining intent) | `mine_site:` before underground verbs |
| SUPPLY | `source:`, `destination:`, `quantity:` (see template below) |
| FARM / TILL | till/plant verbs; no `mine_site` for farm prep |

## SUPPLY template (copy verbatim; fill placeholders)

```
anchor: base_anchor
source_truth: marks
mc bot checkout --near <X,Y,Z> --cap gatherer --mark <source_mark>
source: <lt_* or mine mark>
destination: <chest_* mark>
quantity: <item> <count>
withdrawable: <yes|no>
mc collect …
mc deposit …
done_when: <item> count in destination chest >= <count>
mc bot release
```

See `scripts/lib/gv2_card_validator.py` for the full rule set.
