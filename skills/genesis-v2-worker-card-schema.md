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

Load this before filing body-using worker cards on `genesis-v2`.
Validation (from repo root):
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
| CONSTRUCT / BUILD | `footprint:`, `protected_cells:` (or explicit clear/overwrite auth); survey before bulk `place_fill`; for base L0/L1 also include `layer:`, `preflight:`, `materials_required:`, `verify_on_site:`, `work:` (see templates) |
| VERIFY | `layer:` or `gate:`, `verify_cmd:` with `gv2-verify-layer.py`, `depends_on:` + kanban `set-after`; see Layer gate VERIFY templates |

**VERIFY dialect (pick one per card):**

| Build style | `verify_cmd:` / body probe |
|-------------|----------------------------|
| Schematic (`plan:` on VERIFY body) | `mc blueprint verify <plan_id> --range …` or `--level N` (phase slice) |
| Manual pad (no `plan:`) | `python3 scripts/gv2-verify-layer.py --origin … --gate ground\|slab …` |

Schematic CONSTRUCT cards run inline `mc blueprint verify` before `construct end`; the sibling VERIFY card repeats the same probe for the acceptance gate.
| MINE (mining intent) | `mine_site:` before underground verbs |
| SUPPLY | `source:`, `destination:`, `quantity:`, `withdrawable:`; **+ `mine_site:` if the source is a mine** (see template) |
| FARM / TILL | till/plant verbs; `mc farm_status` or `mc verify_plot` before bulk till/plant; block `no_water` when dry (see `agent-farmer`) |

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

**Stone / cobblestone SUPPLY (mark-if-found, else mine down).** Stone is almost
always *buried*, not exposed — a scout cannot drop a surface `lt_stone_*` mark on a
grass/dirt base (it will report `stone: not_enough`, "0 exposed"). So **never** author
a cobblestone/stone SUPPLY whose only source is a surface stone mark, and never cite a
mark you have not confirmed exists (a `go_mark <missing>` strands the worker). Author it
as **both paths**:

- **If** a real surface stone/coal mark exists (confirm via `mc marks`): `source:` it and
  `mc go_mark` there.
- **Else** (the normal case): make it a mining-intent card — add a `mine_site:` block at a
  **base-adjacent** quarry and dig **straight down to the stone layer** (`target_y`
  ≤ ~60). Do **not** surface-mine near water (holes flood; `mc dig` loses line-of-sight to
  buried stone). Deposit to a chest that exists; if `chest_stone` is unregistered, deposit
  to the nearest base `chest_*` and register `chest_stone` there.

This is the doctrine baked into the schematic plan's cobblestone SUPPLY body
(`scripts/lib/plan_supply.py`); planner-authored stone supply must match it.

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

## Base-layer CONSTRUCT (L0/L1 pilot template)

Use this shape for the base epic's layered floor work (`L0` then `L1`) in emergent
mode. It is intentionally build-layer-lite and aligns to
`docs/architecture/base-build-layered.md`:

- L0 gate: no air/water under footprint + 1-ring apron.
- L1 gate: slab/floor coverage at or above the layer threshold.
- Do not place chests/furnaces in L0/L1 **schematic phase** cards (depot chests follow
  `adr-schematic-gate-fixtures.md` after L4_roof or the dedicated chest card).

### L0 template (copy verbatim; fill placeholders)

```
anchor: base_anchor
source_truth: marks
footprint: 7x7 at base_anchor
protected_cells: none
layer: L0
materials_required:
  cobblestone: <count>
preflight:
  mc marks
  mc scene
  mc inventory
work:
  mc bot checkout --near <X,Y,Z> --cap builder --mark base_anchor
  mc scene
  mc fill cobblestone <x1 y z1> <x2 y z2>
  mc fill air <x1 y z1> <x2 y z2> replace water
verify_on_site: L0 gate pass (footprint + apron has no air/water)
done_when: L0 footprint + apron has no air/water at origin_y
mc bot release
```

### L1 template (copy verbatim; fill placeholders)

```
anchor: base_anchor
source_truth: marks
footprint: 7x7 at base_anchor
protected_cells: none
layer: L1
materials_required:
  cobblestone: <count>
preflight:
  mc marks
  mc scene
  mc inventory
work:
  mc bot checkout --near <X,Y,Z> --cap builder --mark base_anchor
  mc scene
  mc fill cobblestone <x1 y+1 z1> <x2 y+1 z2>
verify_on_site: L1 gate pass (slab/floor coverage threshold reached)
done_when: L1 slab/floor coverage >= 95% of footprint
mc bot release
```

## Layer gate VERIFY (after L0 / L1 CONSTRUCT)

Read-only acceptance using `scripts/gv2-verify-layer.py`. Assign to **colony-builder**
(or **colony-scout** for observe-only runs). Wire **`depends_on:`** to the CONSTRUCT card
id and **`scripts/kanban set-after`** so the next layer stays blocked until VERIFY is `done`.

On FAIL: comment offenders + `kanban_block` the dependent layer card with
`layer_gate_failed:<gate>`.

### L0 ground VERIFY template

```
[VERIFY] [GENESIS2:P1] Base layer L0 ground gate at base_anchor
assignee: colony-builder
---
anchor: base_anchor
source_truth: mark base_anchor from CONSTRUCT card <t_l0_id>
depends_on: <t_l0_id>
layer: L0
gate: ground
footprint: 7x7 at base_anchor
done_when: gv2-verify-layer ground gate PASS (or block with offenders listed)
mc bot checkout --near <X,Y,Z> --cap builder --mark base_anchor
preflight:
  mc scene
  mc marks
verify_cmd:
  python3 scripts/gv2-verify-layer.py --origin <X,Y,Z> --footprint 7,7 --offset -1 --gate ground --apron 1 --json
mc bot release
```

### L1 slab VERIFY template

```
[VERIFY] [GENESIS2:P1] Base layer L1 slab gate at base_anchor
assignee: colony-builder
---
anchor: base_anchor
source_truth: mark base_anchor from CONSTRUCT card <t_l1_id>
depends_on: <t_l1_id>
layer: L1
gate: slab
footprint: 7x7 at base_anchor
done_when: gv2-verify-layer slab gate PASS
mc bot checkout --near <X,Y,Z> --cap builder --mark base_anchor
verify_cmd:
  python3 scripts/gv2-verify-layer.py --origin <X,Y,Z> --footprint 7,7 --offset 0 --gate slab --json
mc bot release
```
