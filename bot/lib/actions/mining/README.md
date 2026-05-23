# Mining actions

Block breaking, inventory gathering, and lightweight scouting helpers. Dig protection and hazard logic live in [`../../runtime/dig-tools.js`](../../runtime/dig-tools.js).

## Verbs

| Module | Verbs | Role |
|--------|--------|------|
| [`dig.js`](./dig.js) | `dig`, `safe_dig` | Single-block dig with LOS, hazards, door-above checks; `safe_dig` wraps `dig` with extra guards |
| [`collect/`](./collect/) | `collect` | Find source blocks → path → dig loop (discovery, ordering, execute) |
| [`pickup.js`](./pickup.js) | `pickup` | Magnet nearby item entities via [`goto-with-timeout.js`](./goto-with-timeout.js) |
| [`scout.js`](./scout.js) | `find_blocks`, `find_entities` | World search + reachability annotations |
| [`social.js`](./social.js) | `complete_command`, `acknowledge_command`, `cancel_command` | Social command queue (not world mining) |

[`index.js`](./index.js) wraps **`collect`** and **`dig`** with [`raceWithTimeout`](../_helpers.js) (`ACTION_CAPS_MS.collect` / `.dig`) and returns structured `OPERATION_TIMEOUT` on cap.

## Conventions

- **Args:** `dig` uses **`coord3`** at entry ([`../_args.js`](../_args.js)).
- **LOS:** `dig` uses **`canSeeBlockFaces`** ([`../_los.js`](../_los.js)).
- **Pathfind:** Per-cell approach in `dig` / collect uses **`pathfindGotoNear`** or **`gotoWithTimeout`** — not unbounded `pathfinder.goto`.
- **Constants:** Surface-bias in collect discovery imports **`AIR_NAMES`** from [`../_block-sets.js`](../_block-sets.js).
- **Contract:** Return **`ok()`** / **`fail()`** from [`../../shared/action-contract.js`](../../shared/action-contract.js).

## Tests

- `bot/test/actions/mining*.test.js`, excavation/dig contract tests as applicable.
