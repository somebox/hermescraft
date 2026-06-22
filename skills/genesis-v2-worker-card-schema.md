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
| SURVEY / SCOUT / ROAD | `output_marks:`, `suitability_criteria:`; `mc scene`/`mc observe` (see template) |
| CONSTRUCT / BUILD | `footprint:`, `protected_cells:` (or explicit clear/overwrite auth); survey before bulk `place_fill` (see template) |
| MINE (mining intent) | `mine_site:` before underground verbs |
| SUPPLY | `source:`, `destination:`, `quantity:`, `withdrawable:`; **+ `mine_site:` if the source is a mine** (see template) |
| FARM / TILL | till/plant verbs; no `mine_site` for farm prep |

**Kind it right.** `[SUPPLY]` is only for hauling NEW material from a `source:` to a
`destination:` with a target `quantity:`. Placing chests, crafting, or depositing
stock you *already hold* is CONSTRUCT/bootstrap work — file it as `[CONSTRUCT]` (or
fold it into the producing card), **never** as a bare `[SUPPLY]`, or it will fail the
SUPPLY field checks.

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

**Mining SUPPLY** — if the source is a mine (title says *mine/mining*, or the body
uses `mine_open` / `mine_resume` / `stair_down` / underground verbs), the card is also
mining-intent: add a `mine_site:` block before the underground verbs (any title kind
needs it, SUPPLY included). Append this after the `withdrawable:` line:

```
mine_site:
  entry: [<X>, <Y>, <Z>]
  direction: <north|south|east|west>
  target_y: <Y>
  resource: <coal_ore|iron_ore|…>
  reuse_existing: <true|false>
```

## SCOUT / SURVEY / ROAD template (copy verbatim; fill placeholders)

```
anchor: <mark or X,Y,Z>
source_truth: marks
output_marks: <mark1>, <mark2>, …          # the marks this card must register
suitability_criteria: <what makes a result acceptable, e.g. flat 7x7, dry, stone+water within 20>
mc bot checkout --near <X,Y,Z> --cap scout
mc observe
done_when: <output_marks> registered
mc bot release
```

## CONSTRUCT template (copy verbatim; fill placeholders)

Survey BEFORE any place/fill. `protected_cells:` declares cells the card may NOT
overwrite (existing chests/doors); if it must build over reserved cells, state
explicit clear/overwrite authorization instead.

```
anchor: base_anchor
source_truth: marks
footprint: <WxH e.g. 7x7 at base_anchor>
protected_cells: <chest_*/door marks the build must not overwrite, or "none">
mc bot checkout --near <X,Y,Z> --cap builder --mark base_anchor
mc scene
mc fill <block> <x1 y1 z1> <x2 y2 z2>
done_when: <measurable: pad/shell complete, interior dry>
mc bot release
```

See `scripts/lib/gv2_card_validator.py` for the full rule set.
