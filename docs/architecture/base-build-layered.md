# Layered base build — `verify_layer` + `build_layer`

Status: **design / spec** (pre-implementation). Origin: `gv2-2026-06-22-1` postmortem
(`docs/devlog/genesis-v2-devlog.md` §2026-06-22). Queue: `gv2-verify-layer-l0`,
`gv2-establishment-shell-site-variance`, `gv2-reserved-structure-override`.

## Problem

The colony builds the base by free-form LLM placement and gets the geometry wrong under
load. `gv2-2026-06-22-1` (rcon pad probe, origin `base_anchor` 53,63,49):

- Fixtures co-planar at y=63 (chests, furnace 52,63,48, craft); **no slab**. The layer
  directly under them (y=62) was 76/132 natural dirt-grass, **37 air**, **8 water**, only
  2 built blocks. `chest_wood` (56,63,49) and `chest_stone` (56,63,52) sat over **air**.
- Water was never drained → the base flooded and died.
- The establishment metric still scored it **3.5** (`shell=yes, site=yes, chest=yes`):
  milestone flags ≠ a dry, viable interior.

Root cause is **build order + y-discipline**, not motor capability: chests before any
leveling/slab, no drainage, no per-layer check. Written doctrine alone
(`feedback_base_build_standards`) is necessary but insufficient — agents still violate
order under load.

## Model: origin-relative layers ("3D printing")

The base marker (`base_anchor`) is the **origin**. The build is a stack of layers defined
by **relative offset**, materialized bottom-up. The agent never does absolute-y math.

| Layer | Offset | Content | Verify gate |
|-------|--------|---------|-------------|
| L0 ground | `origin_y` | level + drain the footprint (fill air/water→solid, cut high) | `air==0 AND water==0` over footprint + 1-ring apron |
| L1 slab | `+1` | solid floor across footprint | `slab_solid ≥ 95%` of footprint |
| L2 fixtures | `+2` | chests / furnace / doors at `(dx,dz)` ON the slab | each fixture present **AND block-below == slab** |
| L3 walls | `+3` | wall ring + windows (glass at eye level) | ring closed, ≥1 door, windows present |
| L4/5 roof | `+4/+5` | ceiling | ceiling fully covered, interior is **air** (not flooded) |

`stand_y` vs `place_y` is the tool's concern: a floor block fills `y`; you stand at `y+1`.
The schematic and tools speak in offsets; only the tool resolves absolutes.

## `verify_layer` (Pillar 2 — build first, read-only)

Read-only rcon probe used as a **per-layer acceptance gate** and a standalone audit. This
is the same mechanism that diagnosed `-22-1` (`execute positioned X Y Z if block ~ ~ ~
<mat>` — returns to rcon, does not broadcast to chat).

```
verify_layer(origin, footprint, offset, expected) -> {
  ok: bool,
  layer_y: int,                         # origin_y + offset
  coverage: { <material>: <cell_count> },
  total_cells: int,
  offenders: [ {x,y,z, found, expected} ],   # cells that fail the gate
  gate: "<which rule failed, if any>"
}
```

Gate predicates (per layer, from the table above):

- **L0**: `coverage.air == 0 AND coverage.water == 0` over footprint **+ 1-cell apron ring**
  (apron because edge water seeps in — the `-22-1` flood came from the SE apron near
  `lt_water_se`).
- **L1**: `built_slab_cells / footprint_cells ≥ 0.95` (built = cobblestone/stone/planks/
  slab; natural dirt/grass does NOT count — that was the `-22-1` illusion).
- **L2**: for each declared fixture cell: block == expected fixture **AND** `verify_layer`
  at `offset-1` for that cell is slab (no fixture-over-air/dirt).
- **L3/L4**: ring/ceiling coverage + interior-air check.

Implementation notes:

- Probe per material with `execute positioned X Y Z if block ~ ~ ~ minecraft:<mat>`; map
  results positionally (drop the one leading banner line `run_batch` prepends — see the
  `-22-1` probe scripts). Curated material list per layer keeps it bounded.
- Pure read; safe to run mid-build and post-build. No world mutation, no chat.

### Wiring (where the gate bites)

1. **`[VERIFY]` card kind** — planner files a `[VERIFY]` after each CONSTRUCT layer; the
   worker runs `verify_layer` and `kanban_block`s with `offenders` if the gate fails. Uses
   the existing observe/verify card pattern.
2. **Scorecard viability sub-metric** — a post-run `verify_layer(roof)` interior-air +
   `verify_layer(L0)` drained check, so a flooded pad **cannot** score `shell=yes`
   uncontested (closes the "establishment lied" gap). Fail-closed.

Either path is independent of `build_layer` and can ship first.

## `build_layer` (Pillar 1 — depends on verify)

```
build_layer(origin, footprint, offset, spec)   # spec: material(s) / fixture list / pattern
```

- Computes absolute coords from `origin + offset`; owns all y-math.
- **Refuses to run `build_layer(L_n)` until `verify_layer(L_{n-1}).ok`.** This makes
  "slab before chests" and "drain before build" structurally impossible to violate.
- The planner emits a compact relative schematic once (footprint + per-layer spec) instead
  of prose `mc place`/`fill` lines with hand-computed y. Aligns with the CONSTRUCT
  `footprint:` / `protected_cells:` fields now required by the schema.

## Supporting fixes (separate queue items)

- **Reserved-structure override** (`gv2-reserved-structure-override`): when
  `verify_layer(L2)` finds a fixture at the wrong layer (the `-22-1` chests-over-air), the
  build requests a relocate grant (overseer or card auth) and re-places on the finished
  slab — instead of dead-ending.
- **Shared lease DB** (`gv2-bot-lease-shared-db`, to file): one authoritative body drives a
  coherent layer; per-profile lease DBs let profiles sharing a body collide/starve.
- **Y-standard doctrine** (`feedback_base_build_standards`): backs the tools for cases the
  schematic doesn't cover.

## Order of work (operator-directed)

1. `verify_layer` (read-only) + L0/L1/L2 gate predicates + tests against the `-22-1` coord
   pattern (replay: must fail L0 on air/water, fail L2 on chest-over-air).
2. Wire `verify_layer` as a `[VERIFY]` card and/or scorecard viability sub-metric.
3. `build_layer` (refuse-until-verified) + relocate override.
4. Validate on same arm (`standard/mimo-v2.5/emergent`), ≥2 runs (mission IDs differ);
   success = `compare_safe=true`, `gv2_invalid=0`, and L0-dry-before-fixtures held (or a
   viability sub-metric fails closed on water-under-fixtures).

## Requirements from gv2-2026-06-22-5 (execution failures `build_layer` must prevent)

E1 produced an unusable shelter even though the card *blueprint* was reasonable (cobble
floor → `mc wall` ring → plank roof → door + torches). The failures were all in
**execution**, and each maps to a `build_layer` invariant:

1. **Door rejected because the wall filled the doorway.** Order was walls-first, then
   `mc place oak_door` into the now-solid wall → server rejected it 6+ times
   (`Event blockUpdate:(-183,72,-241) did not apply`; cell below already cobblestone),
   so there was **no usable entrance**. → `build_layer` must build the wall ring **with
   the door gap left open** (skip the door cells in the wall fill) and place the door
   **into the pre-cleared gap, last**. Add a **`verify(door-traversable)`** gate: the
   door's two cells + the cell in front and behind are passable (air at foot+head).
2. **Builder coordinate disorientation.** The log shows blocks placed at wrong y-levels
   and scattered coords (crafting tables at y48/y56/y61 — far below the y71 base; cobble
   at y56; repeated "foot cell" / "view blocked" / "already stone" errors). → `build_layer`
   owns all coord/y math from `origin + offset`; the agent never passes absolute coords.
3. **Solid interior, not a hollow room.** Floor fill + wall fill + scattered placement
   left the interior filled rather than enclosing air. → walls are a **ring** (perimeter
   only); add a **`verify(interior-air)`** gate (interior cells at stand+head height are
   air) before the shelter counts done.
4. **Five overlapping retry cards** for one shelter ("Shelter 7x7", "finish roof+door",
   "door", "L1 slab shell", "L0 ground patch") — the planner re-filed as it failed. The
   "L1 slab shell" card even fills the whole 7×7 at y72 solid (floor/shell conflation). →
   one `build_layer` build, **refuse-until-`verify_layer`**; no per-failure re-file.
5. **No L0 slab + partial at cap.** Built on raw dirt/grass (the 24/14 air-hole L0 gap),
   cards still running/`todo` at the 2h cap. → L0 level+slab must pass before walls; a
   smaller/parameterized footprint if material/time-bound.

Net: the blueprint intent was fine; `build_layer` must own **order, coordinates,
door-gap, and hollowness**, gated by `verify_layer` (now including door-traversable +
interior-air), as a single coherent build.

## Relation to schematic-first construct MVP

Layered **`verify_layer` / `build_layer`** (this doc) targets genesis pad discipline. The parallel **construct mode** track uses **`construct_context`** so workers run familiar **`mc fill` / `place` / `dig`** against a committed blueprint plan workset (door gap = absent/air cells in `cells[]`). Vocabulary and JSON fields: [`docs/specs/world/blueprints-grabcraft.md`](../specs/world/blueprints-grabcraft.md). Reference fixture: [`data/ops/plans/starter_shelter-plan.json`](../../data/ops/plans/starter_shelter-plan.json). Bulk motor scope uses [`docs/architecture/execution-kernel.md`](execution-kernel.md) **`allowUnit`** via [`bot/lib/runtime/construct-context.js`](../../bot/lib/runtime/construct-context.js). Converge gates (`l0_ground`, `door_traversable`, `interior_air`) can appear in both plan JSON metadata and layer verify scripts.

### Planner / kanban card pattern (construct MVP)

| Card kind | Body carries | Worker entry |
|-----------|----------------|--------------|
| **CONSTRUCT** | `worksite`, `plan`, `phase` (or `level` / `range`); optional `plan_revision` | `mc task_context set :worksite: --card <id>` → auto-begin; loop `construct show` + fill/place/dig; `construct end` |
| **SUPPLY** | Materials id from plan `materials_by_phase` (gather/deposit targets) | Normal gather verbs; no construct context |
| **VERIFY** | Layer or gate id | Read-only `verify_layer` / `blueprint verify`; may run without construct |

Card validation (genesis v2): [`scripts/lib/gv2_card_validator.py`](../../scripts/lib/gv2_card_validator.py) — CONSTRUCT rows must include plan + phase + worksite. **Emit SUPPLY + schematic CONSTRUCT siblings** from plan JSON: `./scripts/construct-plan-cards.py --plan <id> --phase <phase> --worksite … --destination … --dry-run` (see [`scripts/lib/plan_supply.py`](../../scripts/lib/plan_supply.py)). Workers: skill [`skills/minecraft-building.md`](../../skills/minecraft-building.md) § Schematic construct mode. Region policy during construct: [`buildRegionResolveArgs`](../../bot/lib/runtime/regions/policy-guard.js) sets **`guided: true`** so protect-intent worksites allow in-footprint edits without ad-hoc override. Pre-rollout canary: [`construct-canary.md`](construct-canary.md).
