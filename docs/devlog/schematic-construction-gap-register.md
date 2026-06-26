# Schematic construction gap register (S1)

| ID | File / area | Symptom | Owner todo |
|----|-------------|---------|------------|
| G1 | `construct-lifecycle.js` | String `phase` stored; show/end scanned wrong scope | S2 normalize + verify args |
| G2 | `gv2_schematic_shelter.py` | VERIFY `3..4` vs plan `2..4` | S3.1 aligned (test_verify_card_matches_construct_slice) |
| G3 | kanban complete path | Clear context → complete without `construct end` | S4 `CONSTRUCT_PHASE_NOT_CLOSED` on GET task-context |
| G4 | chest card | Chest on slab | GATE-FIXTURES off-footprint depot |
| G5 | tests vs plan | L3 planks expected | GATE-MATERIAL oak_log |
| G6 | `construct/index.js` | Spread string phase into verify | S2 `phaseVerifyArgs` |
| G7 | skills | verify-as-done wording | S5 skills update |

GATE ADRs: [material](adr-schematic-gate-material.md), [fixtures](adr-schematic-gate-fixtures.md), [door](adr-schematic-gate-door.md).
