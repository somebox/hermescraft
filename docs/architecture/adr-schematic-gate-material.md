# ADR: L3 wall material (GATE-MATERIAL)

**Status:** accepted (gv2-12 pilot)

**Context:** `starter_shelter` plan cells for `L3_walls` use `oak_log`. gv2-11 tests and some SUPPLY text expected `oak_planks`, causing false validator drift and worker substitution confusion.

**Decision:** Keep **`oak_log`** as the canonical L3 wall block in `data/ops/plans/starter_shelter-plan.json`. Plan `substitutions` allow `oak_planks` when logs are short; SUPPLY cards and `test_gv2_schematic_shelter` assert `oak_log` for L3 CONSTRUCT fill lines.

**Consequences:** Generator `_phase_place_blocks` emits `mc fill oak_log` for L3; materials_by_phase key `L3_walls` lists logs. Workers may still deposit planks if substitution policy applies at place time.
