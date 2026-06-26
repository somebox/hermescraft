# gv2-12 pilot protocol (S6.3)

## Before start

- Recovery branch green: `python3 -m unittest scripts.tests.test_gv2_schematic_shelter scripts.tests.test_gv2_card_validator`
- Node: `cd bot && HERMES_CONSTRUCT_CONTEXT=1 node --test test/runtime/construct-*.test.js`
- Optional: functional canary per [`construct-canary.md`](../architecture/construct-canary.md)

## Success metrics (establishment + schematic)

| Metric | Source | Target |
|--------|--------|--------|
| `ground` | `base_viability` physical snapshot | pass |
| `shell` | walls + roof coverage vs plan | pass |
| `construct end` per L1–L4 | card stories / action JSONL | ok or structured `GATE_FAIL` with `observed_state` |
| `gv2_invalid` | validator on filed SUPPLY bodies | 0 |
| RETRO epic | kanban | non-empty before stop |

## Stop protocol

1. Run retro card / steward summary — **not** `--force` genesis stop as first action.
2. Capture: `scripts/kanban board`, probe log snapshot, run dir `card-stories/`, physical snapshot if available.
3. File gaps against [`schematic-construction-gap-register.md`](schematic-construction-gap-register.md).

## Artifact capture

- `data/genesis-v2-runs/<run-id>/` (local; often gitignored)
- `docs/devlog/schematic-construction-probe-log.md` updated if test matrix changes
