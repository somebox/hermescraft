# genesis-v2-worker-card-schema

Mandatory worker-card shape for `colony-planner` on board `genesis-v2`. Load via
`skill_view genesis-v2-worker-card-schema` before filing body-using cards.

## Card kind taxonomy (reconcile with toolchain)

Canonical kinds in `scripts/lib/card_kinds.py` (verb-required + stash-worthy):

| Kind | Use for |
|------|---------|
| `CONSTRUCT` | Shelters, pads, walls, chest placement at a footprint |
| `MINE` | Underground extraction with a declared `mine_site` |
| `TILL` | Farm soil prep |
| `SUPPLY` | Haul, gather, deposit — **not** a substitute for mining doctrine |
| `SURVEY` | Structured scout/survey with marks and criteria |

Emergent runs also use `SCOUT`, `FEEDBACK`, `RETRO`, `COOK`, `FARM`, and
`[GENESIS2:*]` planner/poller titles. Prefer canonical kinds when filing new work:

- Ore/coal/stone from underground → `[MINE]` (or `[SUPPLY]` only when the card is
  purely surface haul **from an existing mark/chest**).
- Scouting waypoints → `[SURVEY]` or `[SCOUT]` (multi-waypoint `SCOUT` still needs
  literal `mc` lines per linter rules).
- Cooking/farming → title kind matches the specialist (`[FARM]`, etc.) but body-using
  cards still follow the v1 schema below.

**Mining intent (validator fallback):** Underground extraction needs a `mine_site`
block on `[MINE]` cards and on `[SUPPLY]` cards whose **title** says Mine/Mining
(e.g. `[SUPPLY] Mine coal`). Surface haul/gather (`[SUPPLY] Gather oak from lt_wood_ne`)
does **not** need `mine_site`. Farm/till/cook cards never need `mine_site` — the
English verb “mine dirt” in farm prose is not mining intent.

Control/bodiless cards (`[FEEDBACK]`, `[RETRO]`, `[MISSION]`, `[GENESIS2:MANAGE]`,
`[GENESIS2:SUPERVISE]`, `[GENESIS2:RESCOPE]`, `[GENESIS2:SITE-ADVISORY]`, other
`[GENESIS2:*]` assigned to `colony-planner` / `colony-overseer`) are exempt from
worker schema fields unless they explicitly assign a body-using worker.

## v1 required fields (every body-using worker card)

Keep the first lines structured so workers and offline validation can parse them.

```
anchor: base_anchor          # mark name OR explicit feet coords from current board/marks
source_truth: mark lt_wood_ne from card t_abc… HANDOFF   # no “old stockpile” fiction
checkout:
  mc bot checkout --near <X,Y,Z> --cap <role> [--mark <site>]
done_when: <measurable acceptance — counts, mark names, chest contents>
```

Then literal work verbs (one `mc` verb per line), then:

```
mc bot release
```

Rules:

- Route by **assignee** only (`colony-scout` … `colony-road`). **Never** set `skills:`.
- Coordinates for chests/stock must come from a **current** mark, stock brief, scout
  HANDOFF, or `source_truth` — not from memory of a prior run.
- Continuation cards: first line `Continues from <id>: run scripts/kanban card <id> …`

Validate before completing a mission turn:

```bash
HERMES_KANBAN_BOARD=genesis-v2 scripts/kanban validate-board --status ready,todo
# or single draft:
python3 scripts/gv2-validate-cards.py --title "..." --body-file /tmp/card.md
```

## Kind / intent extensions

### Mining intent → `mine_site` block

```yaml
mine_site:
  entry: [395, 65, -615]
  direction: north
  target_y: 12
  resource: coal_ore
  reuse_existing: true
```

Entry ≥ 24 blocks from `base_anchor` / shelter column; not on roads/chest fronts; one
entrance per depth band; prefer reusing marked `mine_*` entrances.

### `[CONSTRUCT]` → footprint + clearance

Include all of:

- `footprint:` corners / size
- a survey step before placement (`mc scene` or `mc observe`)
- either `protected_cells:` or explicit authorization to clear/overwrite
  (`overwrite=true`, or bounded `mc dig_area` / `mc level`)

Floors/roofs: `mc fill`. Walls: `mc wall` only for vertical walls. Prefer a flat pad
with natural egress; ramping/edge grading is fallback with stated bounds.

### `[SUPPLY]` → copy this template (fill `<…>` only)

Do **not** put source/destination/quantity only in the title or prose — keep the
labeled lines below. Run `validate-board` before completing your mission turn.

**Wood from a scout mark (colony-gatherer):**

```
anchor: <base_anchor or lt_wood_* mark>
source_truth: mark <lt_wood_ne> from card <scout_id> HANDOFF
source: mark <lt_wood_ne>
destination: chest_<material> at base_anchor
quantity: <N> oak_log
withdrawable: empty inventory + wooden_axe (craft at base if prep_required_unmet)
done_when: <N> oak_log in chest_<material> (verify mc inventory / deposit)
mc bot checkout --near <lt_wood_x>,<y>,<z> --cap gather --mark <lt_wood_ne>
mc fell_tree <x> <z>
mc bot release
```

**Haul from an existing chest/mark (no underground mining):**

```
anchor: base_anchor
source_truth: mark chest_<name> or stock brief <date/card id>
source: chest_<name> at base_anchor
destination: chest_<dest> at base_anchor
quantity: <N> <item>
withdrawable: worker can withdraw <item> at checkout (note gaps in comment if not)
done_when: <N> <item> in chest_<dest>
mc bot checkout --near base_anchor --cap gather --mark base_anchor
mc withdraw <item> <N>
mc deposit <item> <N> chest_<dest>
mc bot release
```

Underground ore/coal → file `[MINE]` with `mine_site:` (or `[SUPPLY] Mine …` only when
the title explicitly says Mine and you include `mine_site:`).

### Scout / survey intent

Required output marks (names) and suitability criteria (flat, water within N, etc.).
Literal `mc mark` / `mc scene` verbs per target.

## FEEDBACK → execution

When a specialist answers `[FEEDBACK]`, your follow-up worker cards must be
copy-pasteable skeletons that satisfy this schema. Link new work with `--depends-on`
the feedback card or a comment referencing it — do not leave advisory-only threads.

## Exception path (cheap review before bot time)

Workers may request planner edits without improvising:

- Ambiguous spec → `scripts/kanban comment <id> "CARD_REVIEW_NEEDED: …"` and **no**
  checkout until fixed.
- Unsafe / missing schema → structured `scripts/kanban block` reason (see
  `genesis-v2-card-exceptions` in worker SOUL / `kanban-worker` skill).

Do **not** default to `scripts/kanban reassign <id> colony-planner` for genesis-v2
body cards; use comments + planner-owned review/rescope cards instead.
