# task #66 — precalculated, collision-safe boat path for `sail_to`

- **Date:** 2026-05-23
- **Branch:** `experiment/hermes-agents`
- **Commits:** `8e90b52` → `037f5df` → `785cca9` → `d4bfbe5` (+ test additions)
- **Suite:** 577 → 585 tests, all green
- **Live result:** 3/5 waypoints in the W1→W2→W3→W4→base round trip (459s)

## What broke before this work

`mc sail_to` was failing in the field even on short crossings. Live
forensics traced it to two distinct mechanisms:

1. **`sail()`'s probe-2 packet steering had no collision check.** Each
   sail() call ran a 700ms "probe" that sent `vehicle_move` packets
   blindly toward the target — when the BFS-picked exit_water sat
   adjacent to a 1-block y=62 obstacle (e.g. a dirt spike at
   `(350, 62, -536)`), the probe shoved the boat into it at speed and
   the boat broke. Steve fell into water with no recovery path. This
   manifested as `OUT_OF_RANGE` / "Lost the boat mid-sail" after only
   ~1.5b of motion.

2. **`sail_to` issued one `sail()` per sparse waypoint (8b spacing).**
   Each `sail()` call ran `planBoatPath` in a straight line to the
   next waypoint. The BFS-found path bends around obstacles; the
   straight chord between sparse waypoints does not. `planBoatPath`
   returned `NARROW_CHANNEL` mid-trip → `sail()` returned
   `PATH_BLOCKED` → leg 5 of 17 stranded Steve mid-water with a
   broken boat.

## Architecture change

New module `bot/lib/runtime/boat-path.js`:

- `planBoatPath(b, from, to, opts)` — Bresenham-stepped collision-safe
  planner. For each candidate cell, checks the **boat hitbox footprint**
  (3×3 cells at y=water_y — the cell the boat-bottom dips into). Shifts
  ±1/±2 perpendicular when blocked. Returns `NARROW_CHANNEL` with the
  list of blockers if no corridor exists.
- `executeBoatPath(b, path, opts)` — drives the boat through
  precomputed waypoints via packet `vehicle_move` + rider
  `player_input` (vanilla physics, ~8 b/s). PaperMCP `tp` as fallback
  if `_client.write` is unavailable.
- `bestEffortSail(b, target, opts)` — fallback for `NARROW_CHANNEL`.
  Same packet mechanism but with per-tick collision probes that refuse
  to push the boat into solid blocks. Tries ±1 perpendicular nudges.
  Halts (no crash) if walled in.
- `isDisposableBlocker(blocker)` — pure helper for terrain-clearing
  policy (only dirt/sand/gravel/seagrass; never grass blocks or stone).

`sail()` becomes a thin dispatcher:

```
precomputed_path provided  → executeBoatPath with the cells
no precomputed_path        → planBoatPath, then:
   ok                        → executeBoatPath
   NARROW_CHANNEL            → bestEffortSail (fallback)
   NOT_ON_WATER / other      → PATH_BLOCKED + auto-disembark
```

`sail_to` now passes `route.cells_path` (dense BFS cell chain) to a
**single** `sail()` call. Each consecutive pair of cells is guaranteed
cardinal-adjacent navigable water, so there are no straight-line
shortcuts that can fail.

## Live-discovered failure modes & fixes

Live testing surfaced several additional issues that wouldn't have
appeared in pure unit tests:

| Issue | Symptom | Fix |
|---|---|---|
| `water_y` off-by-one | Server reports boat.y as 63.0 after mount (not 63.0625 from summon). `floor(63 - 1.0625) = 61` → planner looked for water at y=61, found dirt → NOT_ON_WATER | Scan column for actual water cell (try `baseY`, `baseY-1`, `baseY+1`) |
| Swimming on surface ≠ in-water | After boat broke mid-sail, rider fell to water surface — foot=AIR, below=water. `botInWater` check required foot=water → sail_to routed through walk_to_entry → pathfinder timeout → SAIL_TO_RETRY_LOOP | Detect swimming-on-surface (foot=air, below=water, !onGround) and route through `in_water_rescue` with `rescueWaterPos = botFootPos - 1y` |
| Disembark drops rider in water | Mid-sail failure killed boat via RCON; vanilla physics dropped Steve at boat's last position (over water). No recovery from `bg_goto` (refused BOAT_REQUIRED) | sail()'s failure handler scans for nearest standable dry cell within 12b via `findAdjustedTarget`, passes it as `target_shore` to `disembark` |
| `disembark target_shore` required b.vehicle | When boat was already gone, the shore-TP branch was unreachable (gated behind NOT_MOUNTED check) | Move shore-TP branch BEFORE NOT_MOUNTED check; works whether or not vehicle still exists |
| BFS picks exit_water adjacent to obstacles | A 1-block dirt spike beside the exit_water clipped the boat hitbox | `findExitShore` now penalises candidates by solid-neighbour count (4b per solid neighbour at y=water_y) |
| BFS can't reach natural beach shores | `classifyCell` required 2-deep water; 1-deep approach gaps broke connectivity | New `isSailable` predicate accepts `'navigable'` AND `'shallow'`; BFS uses it for expansion, but `findEntryShore` and entry-water lookup still require `'navigable'` |
| BFS early-exits at first within-radius cell | Stopped exploration before reaching the actual target shore (7-10 cells past the first within-radius water) | Remove early break; run to `maxExplored=50k` so `findExitShore` can pick the best shore |
| place_boat dry-stance only checked ring 1 | Natural shore 2b back from channel → NO_STANCE refusal | Expand to ring 2 (Chebyshev) with cardinal-priority sort |

## Regression tests added

`bot/test/runtime/boat-path.test.js` (new file, 12 tests):
- Clean corridor produces straight stepped path
- Obstacle at midpoint forces ±1 perpendicular shift
- Narrow channel returns NARROW_CHANNEL with blockers
- Start cell not water → NOT_ON_WATER
- `checkBoatFootprint` collision logic (solid block at y=water_y;
  seagrass at y=water_y is fine; centred boat doesn't probe neighbours)
- `isDisposableBlocker` policy
- `water_y` robust derivation when boat.y=63.0 (the live failure)
- `water_y` explicit `opts.water_y` override

`bot/test/runtime/water-route.test.js` (+3 tests):
- `cells_path` field is an array of cardinal-adjacent BFS cells
- B3 obstacle-aware `findExitShore` picks clean side over
  obstacle-adjacent side
- B4 BFS reaches shore through 1-deep approach

`bot/test/integration/boat-workflow.test.js` (revised):
- Removed 7 obsolete `sail()` steering-internals tests (probe phases,
  shore_reached omni-scan, BOAT_STUCK auto-disembark)
- `sail()` `PATH_BLOCKED` envelope test (NOT_ON_WATER + NARROW_CHANNEL)
- `sail()` `precomputed_path` arg routes through executeBoatPath
- `place_boat` ring-2 dry-stance (B5)
- `sail_to` swimming-on-surface routes through `in_water_rescue`
- `sail_to` full happy path: `sail()` called ONCE (not 6+) with dense
  BFS path

`bot/test/integration/high-level-primitives.test.js`:
- Removed obsolete BOAT_STUCK auto-disembark test

## Live round-trip result (~459s wallclock)

| Waypoint | Result | Time | Distance |
|---|---|---|---|
| W1 = (442, 68, -218) | ✓ reached at (444.6, 68, -217.5) | 127s | 338b NE |
| W2 = (93, 63, 177) | ✓ reached at (94.6, 63, 176.4) | 176s | 577b SW |
| W3 = (-106, 64, 398) | ✓ reached at (-105.5, 64, 398.5) | 109s | 299b SW |
| W4 = (-780, 66, -325) | ✗ blocked at W3's west coast | 47s | 989b W |
| back to base | not attempted | — | — |

The framework worked end-to-end across three island destinations.
Steve survived every leg (HP=20 at finish), boats consumed = ~14
across the trip (each failed mid-leg cost one boat).

## Remaining gap (out of scope for this report)

W4 fails because the BFS planner's westward route from W3 traverses
a terrain pattern where the boat hitbox clips a y=62 obstacle
immediately on launch (3-10 steps into the first sail leg). The
dense-path approach can't fix this because the BFS path itself goes
through that area — the obstacle is *adjacent* to a BFS-visited
cell, not on it.

The right fix is **boat-hitbox-aware classifyCell**: BFS should
reject water cells where the 3×3 footprint at y=water_y contains a
solid block. That's a deeper change touching the BFS expansion
predicate; deferred.

## Commits

- `8e90b52` — sail_to: precalculated collision-safe boat path + shore-tp disembark
- `037f5df` — sail: bestEffortSail fallback when precomputed path returns NARROW_CHANNEL
- `785cca9` — sail_to: follow BFS dense cell path instead of straight-line chord between sparse waypoints
- `d4bfbe5` — sail_to: swimming-on-surface in_water_rescue + shore-tp on mid-trip failure
