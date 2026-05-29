# Movement actions

Pathfinding wrappers for coord targets, following, and look/stop/jump. Shared preflight, retry limits, and water-route refusal live here — not in individual verb files.

## Verbs

| File | Verb | Notes |
|------|------|--------|
| [`goto.js`](./goto.js) | `goto` | Goal block/near + progress watchdog; **`coord3`** entry |
| [`goto-near.js`](./goto-near.js) | `goto_near` | Stand within `range`; y-adjust + reachability hints |
| [`move.js`](./move.js) | `move` | Door-chained legs; detour precheck (`detour-check.js`); upward `dy>3` exempt |
| [`retrace.js`](./retrace.js) | `retrace` | Reverse `stair_down` `steps[]` / optional mark or nav trail |
| [`follow.js`](./follow.js) | `follow` | `GoalFollow` on player/entity |
| [`look.js`](./look.js) | `look` | **`coord3`** + lookAt |
| [`stop.js`](./stop.js) | `stop` | Clears pathfinder + dig + cancel flag |
| [`jump.js`](./jump.js) | `jump` | Control-state jump |

## Shared infrastructure

- **[`_preflight.js`](./_preflight.js)** — `preflightNav`, stand enrichment, **`NAV_RETRY_LOOP`** (4 failures per target/verb), stuck-cell registry, nav error envelopes.
- **[`water-refusal.js`](./water-refusal.js)** — **`refuseWaterRouteWithoutBoat`**: long trips over water without a boat → `BOAT_REQUIRED` / `WATER_ROUTE_NEEDS_BOAT` (exported for tests).
- **Pathfind:** `goto`, `goto_near`, and `move` use **`pathfindWithProgressWatchdog`** via [`../_helpers.js`](../_helpers.js) (`ACTION_CAPS_MS.goto` / `.goto_near` / `.move`).

High-level **`bg_goto`** / strategic routing may live outside this folder; these handlers are the body’s direct `mc goto*` / `mc move` implementations.

## Conventions

- Failures: structured codes (`NAV_NO_PROGRESS`, `MOVEMENT_PRECONDITION_FAILED`, …) via **`fail()`** / preflight helpers — no throws on user paths.
- After a failed leg, prefer **`mc escape`** or a different waypoint (hints often include `goto_near` hop suggestions from `_preflight`).

## Tests

- `bot/test/movement-water-refusal.test.js`, movement-related tests under `bot/test/actions/`.
