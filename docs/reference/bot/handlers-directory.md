# Actions module layout

`bot/lib/actions/` holds Layer 1 `mc <verb>` handlers. After the 2026 refactor:

## Top-level barrels

Legacy filenames remain as **named re-exports** so tests and imports stay stable:

```
water.js      → export { createWaterActions } from './water/index.js'
mining.js     → export { createMiningActions } from './mining/index.js'
building.js   → export { createBuildingActions } from './building/index.js'
movement.js   → export function createMovementActions … from './movement/index.js'
queries.js    → export { createQueriesActions } from './queries/index.js'
```

`test/actions-manifest.test.js` accepts `export { createXxxActions } from '…'` shims.

## Domain subdirectories

| Directory | Contents |
|-----------|----------|
| `water/` | Ferry orchestration (`sail-to/`), fish, place-boat, board, sail, disembark, buckets — see [`water/README.md`](../../../bot/lib/actions/water/README.md) |

### `water/sail-to/`

| File | Role |
|------|------|
| `wrapper.js` | Heartbeat + per-target retry counter around the impl |
| `orchestrate.js` | Thin wiring: preflight → plan → execution |
| `sail-diagnostics.js` | `sailLog`, `fmtPos`, block context helpers |
| `preflight.js` | Coords, retry loop, at-target, boat ticket |
| `plan.js` | `planWaterRoute`, refusals, `sailLegs` / waypoint legs |
| `mount-safety.js` | Walk to entry, mount safety, sail, disembark, land leg |
| `mining/` | `collect/`, dig, pickup, scout, social — see [`mining/README.md`](../../../bot/lib/actions/mining/README.md) |
| `building/` | place-single, place-bulk, pillar, terrain — see [`building/README.md`](../../../bot/lib/actions/building/README.md) |
| `movement/` | goto, move, goto-near, follow, look, jump, stop, `_preflight`, water-refusal — see [`movement/README.md`](../../../bot/lib/actions/movement/README.md) |
| `queries/` | scout, find, inspect, standing, region, `escape/` (see [`escape/README.md`](../../../bot/lib/actions/queries/escape/README.md)) |

Boat **routing math** stays in `bot/lib/runtime/water-route.js` and `bot/lib/runtime/boat-path.js`, not under `actions/`.

## Shared helpers (`_`-prefix)

| Module | Role |
|--------|------|
| `_helpers.js` | Pathfind watchdogs, timeouts, `pathfindGotoNear`, `pathfindGoalCapped`, `ensureWithinReach` |
| `_nav-helpers.js` | Standability, standing state, reachability (`@size-exempt`) |
| `_block-sets.js` | `AIR_NAMES`, `REPLACEABLE`, boat/fish constants |
| `_directions.js` | `DIR_VEC_4` / `DIR_VEC_8`, `cardinalDelta` |
| `_los.js` | `standardBlockFacePoints`, `canSeeBlockFaces` |
| `_args.js` | `coord3`, `box6`, `boxXZ`, `itemName`, `count` → `INVALID_ARGS` |

New cross-cutting constants belong in these helpers, not copied into handlers.

## Adding a verb

1. Pick the domain subdirectory (or flat module if small).
2. Export handler from domain `index.js` factory.
3. Wire factory in `bot/lib/actions/index.js`.
4. Register CLI in `bot/cli/registry.mjs`.
5. Document canonical args in [`mc-command-reference.md`](../mc-command-reference.md).
