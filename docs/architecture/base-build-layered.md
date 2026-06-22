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
