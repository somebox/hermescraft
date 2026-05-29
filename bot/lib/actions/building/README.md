# Building actions

Place blocks, bulk fills, pillars, and terrain shaping. Placement protection and recent-place tracking use [`../../runtime/dig-tools.js`](../../runtime/dig-tools.js) where noted.

## Verbs

| Module | Verbs | Role |
|--------|--------|------|
| [`place-single.js`](./place-single.js) | `place` | One cell: reach, LOS, entity blocking, equip verify; **`coord3`** + **`itemName`** |
| [`place-bulk.js`](./place-bulk.js) | `place_fill`, `wall`, `fence` | Clustered standpoints + fill; **`box6`** / **`itemName`** on `place_fill` |
| [`pillar.js`](./pillar.js) | `pillar_up` (alias `pillar_step`) | Jump-place vertical stack; sky-open surface stop, auto bare-hand escape, shaft-trap hints |
| [`terrain.js`](./terrain.js) | `path`, `dig_pit`, `level`, `build_stairs` | Paths, pits, leveling, stairs; uses **`cardinalDelta`** from [`../_directions.js`](../_directions.js) |

[`index.js`](./index.js) merges the four parts into **`createBuildingActions`**.

## Conventions

- **Replaceable cells:** **`REPLACEABLE`** from [`../_block-sets.js`](../_block-sets.js) in place-single (not duplicated inline).
- **LOS:** `place` uses **`canSeeBlockFaces`** + optional stand-ring hint ([`../_los.js`](../_los.js)).
- **Pathfind:** Approach cells via **`pathfindGotoNear`** / **`pathfindWithProgressWatchdog`** ([`../_helpers.js`](../_helpers.js)); bulk **`GoalBlock`** standpoints use watchdog + cap.
- **Volume limits:** `place_fill` refuses **`AREA_TOO_LARGE`** above 500 cells.
- **Contract:** **`ok()`** / **`fail()`** from [`../../shared/action-contract.js`](../../shared/action-contract.js).

## Tests

- `bot/test/actions/building*.test.js`, `world-split.test.js` building contract cases.
