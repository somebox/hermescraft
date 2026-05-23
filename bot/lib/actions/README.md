# Layer 1 action handlers (`mc <verb>`)

Each module under this directory implements body primitives the agent calls via HTTP/CLI. Handlers are grouped by domain; top-level files like `water.js` re-export factories from subfolders.

## Layout

See [`docs/design/actions-layout.md`](../../docs/design/actions-layout.md) for the directory map (`water/`, `mining/`, `movement/`, shared `_`-helpers, etc.).

## Standards (new or changed handlers)

1. **Contract** — Return `ok()` / `fail()` from [`../shared/action-contract.js`](../shared/action-contract.js). Do not throw for expected user-facing failures.
2. **Arguments** — Parse coords, boxes, and item names at the handler entry with [`_args.js`](./_args.js) (`coord3`, `box6`, `itemName`, …). Semantic errors stay domain-specific (`UNKNOWN_BLOCK`, `INVALID_COORD`, …).
3. **Reach / navigation**
   - **`pathfindGotoNear`** ([`_helpers.js`](./_helpers.js)) — GoalNear with progress watchdog + wall-clock cap (goto, place approach, farming, combat chase, …).
   - **`ensureWithinReach`** — Same pattern for “must stand within N blocks” prechecks (chest, interact).
   - **`pathfindGoalCapped`** — Short single-goal attempts (~1–2s) with goal cleared afterward; used by **`mc escape`** sidesteps.
   - **`gotoWithTimeout`** ([`mining/goto-with-timeout.js`](./mining/goto-with-timeout.js)) — Pickup sweeps with explicit timeout cleanup.
4. **Line of sight** — For block-target verbs (place, dig, interact, chest), use **`canSeeBlockFaces`** from [`_los.js`](./_los.js) with fair-play `hasLineOfSight` / `eyePosition` deps. Default samples **`standardBlockFacePoints(x,y,z)`** (seven faces + center).
5. **Constants** — Import `AIR_NAMES`, `REPLACEABLE`, `DIR_VEC_*` from [`_block-sets.js`](./_block-sets.js) / [`_directions.js`](./_directions.js); do not copy inline sets.
6. **Command spec** — Canonical verb names and args: [`docs/mc-commands.md`](../../docs/mc-commands.md).

Domain READMEs: [`water/README.md`](./water/README.md), [`mining/README.md`](./mining/README.md), [`movement/README.md`](./movement/README.md), [`building/README.md`](./building/README.md), [`queries/escape/README.md`](./queries/escape/README.md).

## Tests

- Unit: `bot/test/actions/*.test.js`
- Contract / dispatch: `actions-manifest.test.js`, `cli-action-sync.test.js`
- Run with validation: `cd bot && HERMES_VALIDATE=1 npm test`
