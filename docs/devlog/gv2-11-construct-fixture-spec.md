# gv2-11 construct failure fixture spec (S0.3)

Acceptance target for **S6.1** deterministic fixture test(s). Encoded in `bot/test/runtime/construct-gv2-11-fixture.test.js` and `bot/test/runtime/construct-phase-binding-probe.test.js`.

Reference run: `data/genesis-v2-runs/gv2-2026-06-24-11/card-stories/t_97eeb40b.md` (L1 slab).

## Fixture F1 — L1 slice verify vs full-plan `construct end`

**World state**

- `starter_shelter` anchor bound; L1 (`--level 1`) all cobblestone placed and matching plan.
- L3/L4 layers still missing or wrong (typical mid-pipeline state).

**Session begin (gv2 card shape)**

```
plan: starter_shelter
phase: L1_slab
level: 1
```

**Expected today (bug baseline)**

- `mc blueprint verify starter_shelter --level 1` → `missing=0`.
- `mc construct end --skip-gates` may **fail** `GATE_FAIL` / phase not clean with counts spanning **full plan** (walls/roof missing), because stored `session.phase` is string `L1_slab` and `evaluatePhaseClean` treats non-object phase as `{}` (full scan).

**Expected after S2**

- End gate evaluates **only level 1** cells; succeeds when L1 clean regardless of upper layers.

## Fixture F2 — Chest on L1 slab before fill

**World state**

- One or more `chest` blocks placed on slab cells (y = anchor_y + 1) inside 7×7 footprint — e.g. generator default `shelter_chests_card_body` at `(ax-1, ay, az)` when `ay` equals slab Y.

**Construct session**

- L1_slab active; workset includes slab cells blocked by chest.

**Expected**

- `mc fill` / workset reports denied or extra cells; `construct end` fails until chest removed or moved **off footprint** (GATE-FIXTURES: off-footprint depot for gv2-12).

## Fixture F3 — VERIFY slice narrower than CONSTRUCT (historical)

**Scenario class**

- VERIFY card runs `mc blueprint verify … --range 3..4` while sibling CONSTRUCT uses `--range 2..4` for `L3_walls`.

**Current repo generator**

- `_construct_body_for_phase` and verify_cli both use plan phase `range` (`2..4` for L3) — **aligned in code today**; fixture guards **regression** if VERIFY diverges again.

**Expected**

- VERIFY passing must not imply CONSTRUCT slice complete when level-2 wall ring incomplete.

## Fixture F4 — Kanban complete after context clear (policy gap)

**Worker path**

1. Partial build; optional slice verify only.
2. `mc task_context clear` or `mc bot release` (drops construct session).
3. `kanban_complete` / `scripts/kanban complete` succeeds.

**Expected today**

- `construct_kanban_guard` only probes **active** session via assignee bot HTTP; after clear, **no block**.
- Card may show `done` without successful `mc construct end` on the phase slice.

**Expected after S4**

- Blocked or flagged (validator `done_when`, metadata, or poller hint); documented override `KANBAN_ALLOW_COMPLETE_WITH_CONSTRUCT=1` for operator rescue only.

## S6.1 acceptance checklist

- [ ] Automated test reproduces F1 phase-scope mismatch on pre-S2 main (or asserts fixed behavior post-S2).
- [ ] F2 documents extra/wrong on slab cell with chest (unit or mocked verify).
- [ ] F3 asserts VERIFY CLI string equals CONSTRUCT verify line per phase in `gv2_schematic_shelter.py`.
- [ ] F4 documents completion policy gap (Python or Node policy test when S4 lands).

## Links

- Gap register: [`schematic-construction-gap-register.md`](schematic-construction-gap-register.md)
- Phase probe: [`schematic-construction-probe-log.md`](schematic-construction-probe-log.md) (S0.2)
