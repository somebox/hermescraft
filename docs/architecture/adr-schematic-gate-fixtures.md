# ADR: Fixtures and chest placement (GATE-FIXTURES)

**Status:** accepted (gv2-2026-06-25-3 operator policy)

**Context:** gv2-11 placed chests embedded in the L1 slab. gv2-2026-06-25-3 completed a
plank shell with depot chests **on the interior floor** (slab surface y = feet+1).
`verify.js` treats fixture blocks in interior air cells as intended content, not
construct-end `extra` blocks.

**Decision:** For `starter_shelter`, fixture policy is explicit:

| Fixture | When | Where (world, relative to `base_anchor` feet) |
|---------|------|-----------------------------------------------|
| `chest_wood`, `chest_food` | After L4_roof (or dedicated chest CONSTRUCT card) | `(ax-1, ay+1, az)` and `(ax-1, ay+1, az+1)` — interior column, **on** cobble slab |
| `crafting_table`, `furnace` | Post-shell follow-up cards (not L0/L1 schematic phases) | Interior air, not perimeter wall cells |
| Door | Plan air gap on min_z at wall heights | See `adr-schematic-gate-door.md` |

Off-footprint west depot (gv2-12 draft) is **withdrawn** for gv2 schematic runs.

**Offline audit:** `scripts/lib/gv2_fixture_policy.py` + scorecard `fixture_policy`
compare shared marks and optional `base-snapshot.json` to the depot coordinates above.

**Consequences:** `shelter_chests_card_body` and `test_chest_on_top_of_slab_not_embedded`
guard generator coords. `minecraft-building.md` and worker schema reference this ADR.
